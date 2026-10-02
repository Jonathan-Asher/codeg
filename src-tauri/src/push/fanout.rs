//! When codeg pushes: the same moments the desktop raises a system
//! notification (`src/contexts/acp-connections-context.tsx`), read here from
//! the event bus so they fire with no window open, plus every critical
//! session alert (the first and each repeat, from `acp::critical_watch`).
//!
//! | Event                                   | Push                        |
//! |-----------------------------------------|-----------------------------|
//! | `turn_complete`, stop reason `end_turn` | turn finished               |
//! | `permission_request`                    | needs you (Approve button)  |
//! | `question_request`                      | needs you                   |
//! | `plan_approval_request`                 | needs you                   |
//! | `error` that breaks the session         | error                       |
//! | critical alert                          | critical (Ack, Snooze)      |
//!
//! Like the desktop's cooldowns, a burst of one kind for one session within
//! [`COOLDOWN`] collapses into one push, and a turn that ends right after an
//! error pushed for it is not also reported as finished.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::{DatabaseConnection, EntityTrait};
use tokio::sync::broadcast;

use super::payload::{NeedsKind, PermissionAction, PushKind, PushMessage};
use super::{deliver, has_devices, load_push_settings, push_lang, wording};
use crate::acp::critical_watch::CriticalAlert;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope};
use crate::acp::InternalEventBus;
use crate::chat_channel::i18n::Lang;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder;
use crate::db::service::conversation_service;
use crate::presence::{self, Looking};

/// One kind of push for one session at most this often.
pub const COOLDOWN: Duration = Duration::from_secs(3);

/// A turn ending this soon after an error was pushed for its session is the
/// same failure: no "finished" on top.
pub const ERROR_SHADOW: Duration = Duration::from_secs(10);

/// Error codes the desktop does not raise a system notification for (see
/// `routeAcpError` in `src/lib/acp-error-presentation.ts`: everything but a
/// `session`-kind, `error`-level route). Keep the two lists in step.
const QUIET_ERROR_CODES: &[&str] = &[
    "session_load_fallback",
    "set_mode_failed",
    "set_config_option_failed",
    "grok_model_switch_incompatible_agent",
    "goal_control_failed",
    "image_dropped",
    "compaction_failed",
];

/// What an event asks to push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    TurnFinished,
    NeedsYou {
        needs: NeedsKind,
        /// Set for a permission request: what `APPROVE` answers.
        permission: Option<(String, Vec<(String, String)>)>,
    },
    Error {
        message: String,
    },
}

impl Trigger {
    pub fn kind(&self) -> PushKind {
        match self {
            Trigger::TurnFinished => PushKind::TurnFinished,
            Trigger::NeedsYou { .. } => PushKind::NeedsYou,
            Trigger::Error { .. } => PushKind::Error,
        }
    }
}

/// The push an event asks for, if any.
pub fn trigger_for(event: &AcpEvent) -> Option<Trigger> {
    match event {
        AcpEvent::TurnComplete { stop_reason, .. } if stop_reason == "end_turn" => {
            Some(Trigger::TurnFinished)
        }
        AcpEvent::PermissionRequest {
            request_id,
            options,
            ..
        } => Some(Trigger::NeedsYou {
            needs: NeedsKind::Permission,
            permission: Some((
                request_id.clone(),
                options
                    .iter()
                    .map(|o| (o.option_id.clone(), o.kind.clone()))
                    .collect(),
            )),
        }),
        AcpEvent::QuestionRequest { .. } => Some(Trigger::NeedsYou {
            needs: NeedsKind::Question,
            permission: None,
        }),
        AcpEvent::PlanApprovalRequest { .. } => Some(Trigger::NeedsYou {
            needs: NeedsKind::Plan,
            permission: None,
        }),
        AcpEvent::Error { code, message, .. }
            if !code
                .as_deref()
                .is_some_and(|c| QUIET_ERROR_CODES.contains(&c)) =>
        {
            Some(Trigger::Error {
                message: message.clone(),
            })
        }
        _ => None,
    }
}

/// The per-session cooldowns.
#[derive(Debug, Default)]
pub struct Throttle {
    last: HashMap<(i32, PushKind), Instant>,
}

impl Throttle {
    /// Whether to push `kind` for `conversation_id` now; records it if so.
    pub fn admit(&mut self, conversation_id: i32, kind: PushKind, now: Instant) -> bool {
        self.last
            .retain(|_, at| now.saturating_duration_since(*at) < ERROR_SHADOW.max(COOLDOWN));
        if kind == PushKind::TurnFinished {
            if let Some(at) = self.last.get(&(conversation_id, PushKind::Error)) {
                if now.saturating_duration_since(*at) < ERROR_SHADOW {
                    return false;
                }
            }
        }
        // Permission and question gates are each a distinct blocked moment
        // (the channel push exempts them from its debounce too), but two
        // within a few seconds still read as one buzz.
        if let Some(at) = self.last.get(&(conversation_id, kind)) {
            if now.saturating_duration_since(*at) < COOLDOWN {
                return false;
            }
        }
        self.last.insert((conversation_id, kind), now);
        true
    }
}

/// What a session's notification names.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub title: Option<String>,
    pub folder_name: Option<String>,
    /// The stored agent id (`claude_code`, …).
    pub agent_type: String,
    /// The agent's display name.
    pub agent_label: String,
    pub kind: ConversationKind,
}

pub async fn session_info(db: &DatabaseConnection, conversation_id: i32) -> Option<SessionInfo> {
    let row = conversation::Entity::find_by_id(conversation_id)
        .one(db)
        .await
        .ok()
        .flatten()?;
    let folder_name = folder::Entity::find_by_id(row.folder_id)
        .one(db)
        .await
        .ok()
        .flatten()
        .map(|f| f.alias.filter(|a| !a.trim().is_empty()).unwrap_or(f.name));
    Some(SessionInfo {
        conversation_id: row.id,
        folder_id: row.folder_id,
        title: row.title,
        folder_name,
        agent_label: conversation_service::parse_agent_type(&row.agent_type).to_string(),
        agent_type: row.agent_type,
        kind: row.kind,
    })
}

/// The notification a trigger raises for a session, worded like the
/// desktop's.
pub fn session_message(
    lang: Lang,
    info: &SessionInfo,
    trigger: &Trigger,
    connection_id: &str,
) -> PushMessage {
    let agent = info.agent_label.as_str();
    let (content, needs, permission) = match trigger {
        Trigger::TurnFinished => (wording::turn_finished(lang, agent), None, None),
        Trigger::NeedsYou { needs, permission } => {
            let content = match needs {
                NeedsKind::Permission => wording::permission(lang, agent),
                NeedsKind::Question => wording::question(lang, agent),
                NeedsKind::Plan => wording::plan(lang, agent),
            };
            let action = permission.as_ref().map(|(request_id, options)| {
                PermissionAction::from_options(
                    connection_id,
                    request_id,
                    options
                        .iter()
                        .map(|(id, kind)| (id.as_str(), kind.as_str())),
                )
            });
            (content, Some(*needs), action)
        }
        Trigger::Error { message } => (wording::error(lang, agent, message), None, None),
    };
    let (title, body) = wording::session_title_and_body(
        info.title.as_deref(),
        info.folder_name.as_deref(),
        content,
    );
    PushMessage {
        kind: trigger.kind(),
        title,
        body,
        conversation_id: Some(info.conversation_id),
        folder_id: Some(info.folder_id),
        agent_type: Some(info.agent_type.clone()),
        alert_id: uuid::Uuid::new_v4().simple().to_string(),
        critical_kind: None,
        needs,
        permission,
        sound: true,
    }
}

/// A critical alert's notification.
pub fn critical_message(
    lang: Lang,
    alert: &CriticalAlert,
    agent_type: Option<String>,
) -> PushMessage {
    let (title, body) = wording::critical(lang, alert.kind, alert.title.as_deref());
    PushMessage {
        kind: PushKind::Critical,
        title,
        body,
        conversation_id: Some(alert.conversation_id),
        folder_id: Some(alert.folder_id),
        agent_type,
        alert_id: alert.id.clone(),
        critical_kind: Some(alert.kind),
        needs: None,
        permission: None,
        sound: alert.sound,
    }
}

/// Push the critical alerts that just fired. Returns the ids of the alerts
/// that reached at least one device — the chat-channel fallback skips those
/// (unless "also send to chat channel" is on).
pub async fn deliver_critical(
    db: &DatabaseConnection,
    alerts: &[CriticalAlert],
    looking: &Looking,
) -> HashSet<String> {
    let mut pushed = HashSet::new();
    if alerts.is_empty() || !has_devices(db).await {
        return pushed;
    }
    let settings = load_push_settings(db).await;
    let lang = push_lang(db, &settings).await;
    for alert in alerts {
        let agent_type = session_info(db, alert.conversation_id)
            .await
            .map(|info| info.agent_type);
        let message = critical_message(lang, alert, agent_type);
        let report = deliver(db, &message, looking).await;
        if report.delivered > 0 {
            pushed.insert(alert.id.clone());
        }
    }
    pushed
}

async fn push_session(
    db: DatabaseConnection,
    conversation_id: i32,
    connection_id: String,
    trigger: Trigger,
) {
    if !has_devices(&db).await {
        return;
    }
    let Some(info) = session_info(&db, conversation_id).await else {
        return;
    };
    // A delegated sub-agent's turns belong to its parent session.
    if info.kind == ConversationKind::Delegate {
        return;
    }
    let settings = load_push_settings(&db).await;
    let lang = push_lang(&db, &settings).await;
    let message = session_message(lang, &info, &trigger, &connection_id);
    let report = deliver(&db, &message, &presence::snapshot()).await;
    if report.delivered > 0 || !report.failed.is_empty() || report.removed > 0 {
        tracing::info!(
            "[push] {} for conversation {conversation_id}: {} delivered, {} removed, {} failed",
            message.kind.as_str(),
            report.delivered,
            report.removed,
            report.failed.len()
        );
    }
}

async fn conversation_of(
    manager: &ConnectionManager,
    links: &mut HashMap<String, i32>,
    connection_id: &str,
) -> Option<i32> {
    if let Some(id) = links.get(connection_id) {
        return Some(*id);
    }
    let state = manager.get_state(connection_id).await?;
    let id = state.read().await.conversation_id?;
    links.insert(connection_id.to_string(), id);
    Some(id)
}

/// The bus subscriber. Subscribes synchronously (no event between spawn and
/// the first poll is lost) and returns the future to spawn — in the desktop
/// setup and in `codeg-server`, next to the critical watchdog.
pub fn push_event_task(
    bus: Arc<InternalEventBus>,
    manager: ConnectionManager,
    db: DatabaseConnection,
) -> impl Future<Output = ()> + Send + 'static {
    let mut rx = bus.subscribe();
    async move {
        let mut links: HashMap<String, i32> = HashMap::new();
        let mut throttle = Throttle::default();
        loop {
            let envelope: Arc<EventEnvelope> = match rx.recv().await {
                Ok(envelope) => envelope,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::debug!("[push] event subscriber lagged by {n}");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            match &envelope.payload {
                AcpEvent::ConversationLinked {
                    conversation_id, ..
                } => {
                    links.insert(envelope.connection_id.clone(), *conversation_id);
                    continue;
                }
                AcpEvent::StatusChanged {
                    status: ConnectionStatus::Disconnected,
                } => {
                    links.remove(&envelope.connection_id);
                    continue;
                }
                _ => {}
            }
            let Some(trigger) = trigger_for(&envelope.payload) else {
                continue;
            };
            let Some(conversation_id) =
                conversation_of(&manager, &mut links, &envelope.connection_id).await
            else {
                continue;
            };
            if !throttle.admit(conversation_id, trigger.kind(), Instant::now()) {
                continue;
            }
            // Off the bus loop: a slow APNs answer must not hold events up.
            tokio::spawn(push_session(
                db.clone(),
                conversation_id,
                envelope.connection_id.clone(),
                trigger,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::PermissionOptionInfo;

    fn permission_event() -> AcpEvent {
        AcpEvent::PermissionRequest {
            request_id: "req-1".into(),
            tool_call: serde_json::json!({}),
            options: vec![
                PermissionOptionInfo {
                    option_id: "yes".into(),
                    name: "Allow".into(),
                    kind: "allow_once".into(),
                    meta: None,
                },
                PermissionOptionInfo {
                    option_id: "no".into(),
                    name: "Deny".into(),
                    kind: "reject_once".into(),
                    meta: None,
                },
            ],
            queued: 0,
        }
    }

    #[test]
    fn the_desktop_triggers_map_to_pushes() {
        assert_eq!(
            trigger_for(&AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            }),
            Some(Trigger::TurnFinished)
        );
        assert_eq!(
            trigger_for(&AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "cancelled".into(),
                agent_type: "claude_code".into(),
            }),
            None,
            "a turn the user stopped is not news"
        );
        assert!(matches!(
            trigger_for(&permission_event()),
            Some(Trigger::NeedsYou {
                needs: NeedsKind::Permission,
                permission: Some(_)
            })
        ));
        assert!(matches!(
            trigger_for(&AcpEvent::QuestionRequest {
                question_id: "q".into(),
                questions: vec![],
            }),
            Some(Trigger::NeedsYou {
                needs: NeedsKind::Question,
                ..
            })
        ));
        assert!(matches!(
            trigger_for(&AcpEvent::PlanApprovalRequest {
                approval_id: "a".into(),
                tool_call_id: "t".into(),
                plan_markdown: String::new(),
            }),
            Some(Trigger::NeedsYou {
                needs: NeedsKind::Plan,
                ..
            })
        ));
        let error = |code: Option<&str>| AcpEvent::Error {
            message: "boom".into(),
            agent_type: "codex".into(),
            code: code.map(str::to_string),
            details: None,
            terminal: false,
        };
        assert_eq!(
            trigger_for(&error(None)),
            Some(Trigger::Error {
                message: "boom".into()
            })
        );
        assert_eq!(
            trigger_for(&error(Some("turn_failed_empty"))),
            Some(Trigger::Error {
                message: "boom".into()
            })
        );
        assert_eq!(trigger_for(&error(Some("set_mode_failed"))), None);
        assert_eq!(trigger_for(&error(Some("compaction_failed"))), None);
        assert_eq!(
            trigger_for(&AcpEvent::ContentDelta {
                text: "x".into(),
                parent_tool_use_id: None
            }),
            None
        );
    }

    #[test]
    fn the_throttle_collapses_bursts_and_hides_finished_after_an_error() {
        let t0 = Instant::now();
        let mut throttle = Throttle::default();
        assert!(throttle.admit(1, PushKind::NeedsYou, t0));
        assert!(!throttle.admit(1, PushKind::NeedsYou, t0 + Duration::from_secs(1)));
        assert!(throttle.admit(2, PushKind::NeedsYou, t0 + Duration::from_secs(1)));
        assert!(throttle.admit(1, PushKind::NeedsYou, t0 + COOLDOWN));

        assert!(throttle.admit(1, PushKind::Error, t0));
        assert!(!throttle.admit(1, PushKind::TurnFinished, t0 + Duration::from_secs(2)));
        assert!(throttle.admit(1, PushKind::TurnFinished, t0 + ERROR_SHADOW));
    }

    fn info(title: Option<&str>) -> SessionInfo {
        SessionInfo {
            conversation_id: 42,
            folder_id: 7,
            title: title.map(str::to_string),
            folder_name: Some("codeg".into()),
            agent_type: "claude_code".into(),
            agent_label: "Claude Code".into(),
            kind: ConversationKind::Regular,
        }
    }

    #[test]
    fn session_messages_read_like_the_desktop_notification() {
        let msg = session_message(
            Lang::En,
            &info(Some("Fix login")),
            &Trigger::TurnFinished,
            "c1",
        );
        assert_eq!(msg.kind, PushKind::TurnFinished);
        assert_eq!(msg.title, "Fix login");
        assert_eq!(msg.body, "codeg · Claude Code has finished responding");
        assert_eq!(msg.conversation_id, Some(42));
        assert_eq!(msg.agent_type.as_deref(), Some("claude_code"));

        let trigger = trigger_for(&permission_event()).unwrap();
        let msg = session_message(Lang::En, &info(None), &trigger, "conn-9");
        assert_eq!(msg.title, "codeg - Codeg");
        assert_eq!(
            msg.body,
            "Claude Code: Agent requests permission to continue this turn."
        );
        let permission = msg.permission.unwrap();
        assert_eq!(permission.connection_id, "conn-9");
        assert_eq!(permission.request_id, "req-1");
        assert_eq!(permission.approve_option_id.as_deref(), Some("yes"));
        assert_eq!(permission.deny_option_id.as_deref(), Some("no"));
    }
}
