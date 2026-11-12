//! The APNs request one notification becomes: the JSON body and the
//! per-notification headers. This is the contract the iOS client reads —
//! `docs/ios-push.md` documents it field by field; keep the two in step.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::prefs::{DeviceSounds, SoundChoice, SoundContext, SoundSlot};
use crate::acp::critical_watch::CriticalAlertKind;
use crate::pending::PendingKind;

/// Critical-session alerts. Actions: `ACK`, `SNOOZE`, `OPEN`.
pub const CATEGORY_CRITICAL: &str = "CODEG_CRITICAL";
/// A permission request. Actions: `APPROVE`, `OPEN`.
pub const CATEGORY_PERMISSION: &str = "CODEG_PERMISSION";
/// A question set waiting for answers. Actions: `OPEN`, plus one answer
/// button per option, which the app builds from the payload's `question`
/// when it is `answerable` (the push is `mutable-content` for that).
pub const CATEGORY_QUESTION: &str = "CODEG_QUESTION";
/// Everything else about a session. Action: `OPEN`.
pub const CATEGORY_SESSION: &str = "CODEG_SESSION";

/// How long APNs keeps trying to reach a device that is offline.
const EXPIRATION_SECS: i64 = 60 * 60;

/// Longest title / body sent; the whole payload must stay under 4 KB.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 600;
/// Longest question text, header and option label in `question`.
const MAX_QUESTION_CHARS: usize = 300;
const MAX_HEADER_CHARS: usize = 40;
const MAX_OPTION_CHARS: usize = 60;

/// What a notification is about. Also the `kind` custom field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushKind {
    TurnFinished,
    NeedsYou,
    Error,
    Critical,
    Test,
    /// A silent badge-only update (no alert, no sound).
    Badge,
}

impl PushKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PushKind::TurnFinished => "turn_finished",
            PushKind::NeedsYou => "needs_you",
            PushKind::Error => "error",
            PushKind::Critical => "critical",
            PushKind::Test => "test",
            PushKind::Badge => "badge",
        }
    }
}

/// What a needs-you notification waits on. The `needs` custom field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsKind {
    Permission,
    Question,
    Plan,
}

impl NeedsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NeedsKind::Permission => "permission",
            NeedsKind::Question => "question",
            NeedsKind::Plan => "plan",
        }
    }
}

/// What the `APPROVE` button needs to answer a permission request through
/// `acp_respond_permission`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionAction {
    pub connection_id: String,
    pub request_id: String,
    /// The request's "allow once" option (else its first "allow" option).
    pub approve_option_id: Option<String>,
    /// The request's "reject once" option (else its first "reject" option).
    pub deny_option_id: Option<String>,
}

impl PermissionAction {
    /// Pick the approve / deny options out of a request's option list
    /// (`(option_id, kind)` pairs, ACP kinds `allow_once`, `allow_always`,
    /// `reject_once`, `reject_always`).
    pub fn from_options<'a>(
        connection_id: &str,
        request_id: &str,
        options: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let options: Vec<(&str, &str)> = options.into_iter().collect();
        let pick = |exact: &str, prefix: &str| {
            options
                .iter()
                .find(|(_, kind)| *kind == exact)
                .or_else(|| options.iter().find(|(_, kind)| kind.starts_with(prefix)))
                .map(|(id, _)| (*id).to_string())
        };
        // Claude Code's plan card: its only allow-once option is "Yes,
        // manually approve edits". The card already leads with the mode to
        // continue in (`crate::acp::claude_plan_mode`), so APPROVE takes that.
        let plan_lead = options
            .iter()
            .any(|(id, _)| id.starts_with("exit-plan-"))
            .then(|| options.iter().find(|(_, kind)| kind.starts_with("allow")))
            .flatten()
            .map(|(id, _)| (*id).to_string());
        Self {
            connection_id: connection_id.to_string(),
            request_id: request_id.to_string(),
            approve_option_id: plan_lead.or_else(|| pick("allow_once", "allow")),
            deny_option_id: pick("reject_once", "reject"),
        }
    }
}

/// The first question of a pending question set, for answer buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionPush {
    /// The set's id: `questionId` of `acp_answer_question`.
    pub question_id: String,
    /// The question's own id: `answers[].questionId`.
    pub item_id: String,
    pub text: String,
    pub header: String,
    pub multi_select: bool,
    /// The option labels; an answer carries the chosen label.
    pub options: Vec<String>,
    /// How many questions the set asks.
    pub count: u32,
}

impl QuestionPush {
    /// One single-choice question with options a button can carry whole (an
    /// answer names the exact label): a button per option answers it.
    pub fn answerable(&self) -> bool {
        self.count == 1
            && !self.multi_select
            && !self.options.is_empty()
            && self
                .options
                .iter()
                .all(|o| o.chars().count() <= MAX_OPTION_CHARS)
    }
}

/// What the pending registry (`crate::pending`) adds to a needs-you push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPush {
    /// The item's id in `list_pending_items`.
    pub id: String,
    pub kind: PendingKind,
    /// When the session started waiting.
    pub since: DateTime<Utc>,
    pub reminder: bool,
    /// 0 for the first push (and the catch-up), `n` for the n-th reminder.
    pub attempt: u32,
    pub connection_id: String,
    /// The session that asks. When it is not `conversation_id` (a delegated
    /// sub-agent), `conversation_id` is the session to open.
    pub asking_conversation_id: i32,
    pub question: Option<QuestionPush>,
    /// A plan approval's id: `approvalId` of `acp_answer_plan_approval`.
    pub approval_id: Option<String>,
}

/// One notification, before it is addressed to a device.
#[derive(Debug, Clone, PartialEq)]
pub struct PushMessage {
    pub kind: PushKind,
    pub title: String,
    pub body: String,
    pub conversation_id: Option<i32>,
    pub folder_id: Option<i32>,
    /// The agent's stored id (`claude_code`, `codex`, …).
    pub agent_type: Option<String>,
    /// Unique per notification; a critical alert's own id.
    pub alert_id: String,
    pub critical_kind: Option<CriticalAlertKind>,
    pub needs: Option<NeedsKind>,
    pub permission: Option<PermissionAction>,
    /// Play a sound: the one each device chose for it
    /// ([`PushMessage::sound_for`]), else the default one.
    pub sound: bool,
    /// `aps.badge`: how many items wait on the user. Filled at delivery.
    pub badge: Option<u32>,
    pub pending: Option<PendingPush>,
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn critical_kind_str(kind: CriticalAlertKind) -> &'static str {
    match kind {
        CriticalAlertKind::Idle => "idle",
        CriticalAlertKind::NeedsYou => "needs_you",
        CriticalAlertKind::Interrupted => "interrupted",
        CriticalAlertKind::Stalled => "stalled",
        CriticalAlertKind::BackgroundStalled => "background_stalled",
        CriticalAlertKind::LimitPaused => "limit_paused",
        CriticalAlertKind::LimitContinued => "limit_continued",
    }
}

impl PushMessage {
    /// A silent badge-only update to `count`.
    pub fn badge_only(count: u32) -> Self {
        Self {
            kind: PushKind::Badge,
            title: String::new(),
            body: String::new(),
            conversation_id: None,
            folder_id: None,
            agent_type: None,
            alert_id: uuid::Uuid::new_v4().simple().to_string(),
            critical_kind: None,
            needs: None,
            permission: None,
            sound: false,
            badge: Some(count),
            pending: None,
        }
    }

    /// A reminder goes out whatever "only when away" says.
    pub fn is_reminder(&self) -> bool {
        self.pending.as_ref().is_some_and(|p| p.reminder)
    }

    /// The notification category the iOS app registers its buttons under.
    pub fn category(&self) -> &'static str {
        let question = self
            .pending
            .as_ref()
            .is_some_and(|p| p.question.is_some());
        match self.kind {
            PushKind::Critical => CATEGORY_CRITICAL,
            PushKind::NeedsYou if self.permission.is_some() => CATEGORY_PERMISSION,
            PushKind::NeedsYou if question => CATEGORY_QUESTION,
            _ => CATEGORY_SESSION,
        }
    }

    /// Which kind of notification this is to a device's sounds.
    pub fn sound_slot(&self) -> SoundSlot {
        let plan = self.needs == Some(NeedsKind::Plan)
            || self
                .pending
                .as_ref()
                .is_some_and(|p| p.kind == PendingKind::Plan);
        match self.kind {
            PushKind::NeedsYou if self.is_reminder() => SoundSlot::Reminder,
            PushKind::NeedsYou if plan => SoundSlot::Plan,
            PushKind::NeedsYou => SoundSlot::NeedsYou,
            PushKind::Critical => SoundSlot::Critical,
            PushKind::Error => SoundSlot::Error,
            // A test sounds like what most pushes are; a badge plays nothing.
            PushKind::TurnFinished | PushKind::Test | PushKind::Badge => SoundSlot::TurnFinished,
        }
    }

    /// What this notification plays on a device with `sounds`: its session's
    /// sound, its project's, the critical sessions' one, else its kind's
    /// ([`DeviceSounds::resolve`]).
    pub fn sound_for<'a>(
        &self,
        sounds: &'a DeviceSounds,
        context: SoundContext,
    ) -> &'a SoundChoice {
        sounds.resolve(
            self.conversation_id,
            self.folder_id,
            context,
            self.sound_slot(),
        )
    }

    /// Critical alerts and a blocked agent break through Focus.
    pub fn time_sensitive(&self) -> bool {
        matches!(self.kind, PushKind::Critical | PushKind::NeedsYou)
    }

    /// `apns-collapse-id`: a newer notification about the same session
    /// replaces the one still on screen. At most 64 bytes.
    pub fn collapse_id(&self, server_id: &str) -> String {
        let id = match self.conversation_id {
            Some(conversation_id) => format!("{server_id}-c{conversation_id}"),
            None => format!("{server_id}-{}", self.kind.as_str()),
        };
        id.chars().take(64).collect()
    }

    /// `aps.thread-id`: Notification Center groups a session's notifications.
    /// Namespaced by the server, since two codeg servers number their
    /// sessions independently.
    pub fn thread_id(&self, server_id: &str) -> String {
        match self.conversation_id {
            Some(conversation_id) => format!("{server_id}-{conversation_id}"),
            None => format!("{server_id}-codeg"),
        }
    }

    /// `apns-expiration`: a test is delivered now or never; the rest are kept
    /// an hour for a phone that is offline.
    pub fn expiration(&self, unix_now: i64) -> i64 {
        match self.kind {
            PushKind::Test => 0,
            _ => unix_now + EXPIRATION_SECS,
        }
    }

    /// The JSON body with the default sound.
    pub fn body_json(&self, server_id: &str) -> Value {
        self.body_json_for(server_id, &SoundChoice::Default)
    }

    /// The JSON body for a device on which this notification plays `sound`
    /// ([`PushMessage::sound_for`]): `aps` plus codeg's custom fields at the
    /// top level.
    pub fn body_json_for(&self, server_id: &str, sound: &SoundChoice) -> Value {
        if self.kind == PushKind::Badge {
            return json!({
                "aps": { "badge": self.badge.unwrap_or(0) },
                "server_id": server_id,
                "kind": self.kind.as_str(),
                "alert_id": self.alert_id,
            });
        }
        let mut aps = Map::new();
        aps.insert(
            "alert".into(),
            json!({
                "title": clip(&self.title, MAX_TITLE_CHARS),
                "body": clip(&self.body, MAX_BODY_CHARS),
            }),
        );
        if let Some(name) = sound.aps_sound().filter(|_| self.sound) {
            aps.insert("sound".into(), json!(name));
        }
        aps.insert("thread-id".into(), json!(self.thread_id(server_id)));
        aps.insert("category".into(), json!(self.category()));
        aps.insert(
            "interruption-level".into(),
            json!(if self.time_sensitive() {
                "time-sensitive"
            } else {
                "active"
            }),
        );
        if let Some(badge) = self.badge {
            aps.insert("badge".into(), json!(badge));
        }
        if self.category() == CATEGORY_QUESTION {
            // Lets a notification service extension add the answer buttons.
            aps.insert("mutable-content".into(), json!(1));
        }

        let mut body = Map::new();
        body.insert("aps".into(), Value::Object(aps));
        body.insert("server_id".into(), json!(server_id));
        body.insert("kind".into(), json!(self.kind.as_str()));
        body.insert("alert_id".into(), json!(self.alert_id));
        if let Some(id) = self.conversation_id {
            body.insert("conversation_id".into(), json!(id));
        }
        if let Some(id) = self.folder_id {
            body.insert("folder_id".into(), json!(id));
        }
        if let Some(agent) = &self.agent_type {
            body.insert("agent_type".into(), json!(agent));
        }
        if let Some(kind) = self.critical_kind {
            body.insert("critical_kind".into(), json!(critical_kind_str(kind)));
        }
        if let Some(needs) = self.needs {
            body.insert("needs".into(), json!(needs.as_str()));
        }
        if let Some(permission) = &self.permission {
            body.insert("connection_id".into(), json!(permission.connection_id));
            body.insert("request_id".into(), json!(permission.request_id));
            if let Some(id) = &permission.approve_option_id {
                body.insert("approve_option_id".into(), json!(id));
            }
            if let Some(id) = &permission.deny_option_id {
                body.insert("deny_option_id".into(), json!(id));
            }
        }
        if let Some(pending) = &self.pending {
            body.insert("pending_id".into(), json!(pending.id));
            body.insert("pending_kind".into(), json!(pending.kind.as_str()));
            body.insert(
                "pending_since".into(),
                json!(pending
                    .since
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
            );
            body.insert("reminder".into(), json!(pending.reminder));
            body.insert("attempt".into(), json!(pending.attempt));
            body.entry("connection_id")
                .or_insert_with(|| json!(pending.connection_id));
            if self.conversation_id != Some(pending.asking_conversation_id) {
                body.insert(
                    "asking_conversation_id".into(),
                    json!(pending.asking_conversation_id),
                );
            }
            if let Some(q) = &pending.question {
                let options: Vec<String> =
                    q.options.iter().map(|o| clip(o, MAX_OPTION_CHARS)).collect();
                body.insert(
                    "question".into(),
                    json!({
                        "question_id": q.question_id,
                        "item_id": q.item_id,
                        "text": clip(&q.text, MAX_QUESTION_CHARS),
                        "header": clip(&q.header, MAX_HEADER_CHARS),
                        "multi_select": q.multi_select,
                        "options": options,
                        "count": q.count,
                        "answerable": q.answerable(),
                    }),
                );
            }
            if let Some(id) = &pending.approval_id {
                body.insert("approval_id".into(), json!(id));
            }
        }
        Value::Object(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: PushKind) -> PushMessage {
        PushMessage {
            kind,
            title: "Fix the login bug".into(),
            body: "codeg · Claude Code has finished responding".into(),
            conversation_id: Some(42),
            folder_id: Some(7),
            agent_type: Some("claude_code".into()),
            alert_id: "a1".into(),
            critical_kind: None,
            needs: None,
            permission: None,
            sound: true,
            badge: None,
            pending: None,
        }
    }

    #[test]
    fn a_turn_finished_payload_has_the_documented_shape() {
        let body = message(PushKind::TurnFinished).body_json("srv1");
        assert_eq!(
            body,
            json!({
                "aps": {
                    "alert": {
                        "title": "Fix the login bug",
                        "body": "codeg · Claude Code has finished responding"
                    },
                    "sound": "default",
                    "thread-id": "srv1-42",
                    "category": "CODEG_SESSION",
                    "interruption-level": "active"
                },
                "server_id": "srv1",
                "kind": "turn_finished",
                "alert_id": "a1",
                "conversation_id": 42,
                "folder_id": 7,
                "agent_type": "claude_code"
            })
        );
    }

    #[test]
    fn a_critical_alert_is_time_sensitive_with_ack_and_snooze() {
        let mut msg = message(PushKind::Critical);
        msg.critical_kind = Some(CriticalAlertKind::BackgroundStalled);
        msg.sound = false;
        let body = msg.body_json("srv1");
        assert_eq!(body["aps"]["category"], "CODEG_CRITICAL");
        assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
        assert_eq!(body["critical_kind"], "background_stalled");
        assert!(body["aps"].get("sound").is_none());
        assert_eq!(msg.collapse_id("srv1"), "srv1-c42");
    }

    #[test]
    fn a_permission_request_carries_what_approve_needs() {
        let mut msg = message(PushKind::NeedsYou);
        msg.needs = Some(NeedsKind::Permission);
        msg.permission = Some(PermissionAction::from_options(
            "conn-1",
            "req-9",
            [
                ("always", "allow_always"),
                ("once", "allow_once"),
                ("no", "reject_once"),
            ],
        ));
        let body = msg.body_json("srv1");
        assert_eq!(body["aps"]["category"], "CODEG_PERMISSION");
        assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
        assert_eq!(body["needs"], "permission");
        assert_eq!(body["connection_id"], "conn-1");
        assert_eq!(body["request_id"], "req-9");
        assert_eq!(body["approve_option_id"], "once");
        assert_eq!(body["deny_option_id"], "no");
    }

    #[test]
    fn a_question_needs_you_but_has_no_approve_button() {
        let mut msg = message(PushKind::NeedsYou);
        msg.needs = Some(NeedsKind::Question);
        assert_eq!(msg.category(), CATEGORY_SESSION);
        assert!(msg.time_sensitive());
    }

    #[test]
    fn approve_falls_back_to_any_allow_option() {
        let action = PermissionAction::from_options("c", "r", [("yes", "allow_always")]);
        assert_eq!(action.approve_option_id.as_deref(), Some("yes"));
        assert_eq!(action.deny_option_id, None);
    }

    #[test]
    fn approving_claudes_plan_card_takes_its_lead_option_not_manual_mode() {
        let action = PermissionAction::from_options(
            "c",
            "r",
            [
                ("exit-plan-bypass", "allow_always"),
                ("exit-plan-default", "allow_once"),
                ("exit-plan-auto", "allow_always"),
                ("reject", "reject_once"),
            ],
        );
        assert_eq!(
            action.approve_option_id.as_deref(),
            Some("exit-plan-bypass")
        );
        assert_eq!(action.deny_option_id.as_deref(), Some("reject"));
    }

    #[test]
    fn long_text_is_clipped_and_a_test_expires_at_once() {
        let mut msg = message(PushKind::Test);
        msg.conversation_id = None;
        msg.body = "x".repeat(5000);
        let body = msg.body_json("srv1");
        let text = body["aps"]["alert"]["body"].as_str().unwrap();
        assert_eq!(text.chars().count(), MAX_BODY_CHARS);
        assert!(text.ends_with('…'));
        assert_eq!(msg.expiration(1000), 0);
        assert_eq!(msg.collapse_id("srv1"), "srv1-test");
        assert_eq!(message(PushKind::Error).expiration(1000), 1000 + 3600);
        assert!(serde_json::to_vec(&body).unwrap().len() < 4096);
    }

    fn question_push(options: &[&str]) -> PendingPush {
        PendingPush {
            id: "question:q-1".into(),
            kind: PendingKind::Question,
            since: "2026-10-26T09:00:00Z".parse().unwrap(),
            reminder: true,
            attempt: 2,
            connection_id: "conn-3".into(),
            asking_conversation_id: 51,
            question: Some(QuestionPush {
                question_id: "q-1".into(),
                item_id: "q-1-0".into(),
                text: "Which database?".into(),
                header: "Storage".into(),
                multi_select: false,
                options: options.iter().map(|o| o.to_string()).collect(),
                count: 1,
            }),
            approval_id: None,
        }
    }

    #[test]
    fn a_question_reminder_carries_the_item_its_options_and_the_badge() {
        let mut msg = message(PushKind::NeedsYou);
        msg.needs = Some(NeedsKind::Question);
        msg.badge = Some(3);
        msg.pending = Some(question_push(&["SQLite", "Postgres"]));
        let body = msg.body_json("srv1");
        assert_eq!(body["aps"]["category"], CATEGORY_QUESTION);
        assert_eq!(body["aps"]["mutable-content"], 1);
        assert_eq!(body["aps"]["badge"], 3);
        assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
        assert_eq!(body["needs"], "question");
        assert_eq!(body["pending_id"], "question:q-1");
        assert_eq!(body["pending_kind"], "question");
        assert_eq!(body["pending_since"], "2026-10-26T09:00:00Z");
        assert_eq!(body["reminder"], true);
        assert_eq!(body["attempt"], 2);
        assert_eq!(body["connection_id"], "conn-3");
        // The session to open is 42; the sub-agent asking is 51.
        assert_eq!(body["conversation_id"], 42);
        assert_eq!(body["asking_conversation_id"], 51);
        assert_eq!(
            body["question"],
            json!({
                "question_id": "q-1",
                "item_id": "q-1-0",
                "text": "Which database?",
                "header": "Storage",
                "multi_select": false,
                "options": ["SQLite", "Postgres"],
                "count": 1,
                "answerable": true
            })
        );
        assert!(msg.is_reminder());
    }

    #[test]
    fn a_free_text_question_is_not_answerable_from_the_notification() {
        let mut msg = message(PushKind::NeedsYou);
        let mut pending = question_push(&[]);
        pending.asking_conversation_id = 42;
        pending.reminder = false;
        pending.attempt = 0;
        msg.pending = Some(pending);
        let body = msg.body_json("srv1");
        assert_eq!(body["aps"]["category"], CATEGORY_QUESTION);
        assert_eq!(body["question"]["answerable"], false);
        assert_eq!(body["reminder"], false);
        assert!(body.get("asking_conversation_id").is_none());
        assert!(body["aps"].get("badge").is_none());
        assert!(!msg.is_reminder());
    }

    #[test]
    fn a_permission_keeps_its_category_and_its_own_connection() {
        let mut msg = message(PushKind::NeedsYou);
        msg.needs = Some(NeedsKind::Permission);
        msg.permission = Some(PermissionAction::from_options(
            "conn-1",
            "req-9",
            [("once", "allow_once")],
        ));
        msg.pending = Some(PendingPush {
            id: "permission:req-9".into(),
            kind: PendingKind::Plan,
            since: "2026-10-26T09:00:00Z".parse().unwrap(),
            reminder: false,
            attempt: 0,
            connection_id: "conn-1".into(),
            asking_conversation_id: 42,
            question: None,
            approval_id: None,
        });
        let body = msg.body_json("srv1");
        assert_eq!(body["aps"]["category"], CATEGORY_PERMISSION);
        assert!(body["aps"].get("mutable-content").is_none());
        assert_eq!(body["needs"], "permission");
        assert_eq!(body["pending_kind"], "plan");
        assert_eq!(body["connection_id"], "conn-1");
        assert_eq!(body["request_id"], "req-9");
    }

    fn sounds(chosen: Value) -> DeviceSounds {
        DeviceSounds::from_wire(&chosen).0
    }

    #[test]
    fn each_kind_plays_the_sound_the_device_chose_for_it() {
        let chosen = sounds(json!({ "kinds": {
            "needs_you": "codeg-chime.caf",
            "plan": "codeg-marimba.caf",
            "reminder": "codeg-bell.caf",
            "turn_finished": "codeg-pop.caf",
            "critical": "codeg-glass.caf",
            "error": "codeg-knock.caf",
        }}));
        let sound_of = |msg: &PushMessage| {
            msg.body_json_for("srv1", msg.sound_for(&chosen, SoundContext::default()))["aps"]
                ["sound"]
                .clone()
        };

        let mut question = message(PushKind::NeedsYou);
        question.needs = Some(NeedsKind::Question);
        question.pending = Some(PendingPush {
            reminder: false,
            attempt: 0,
            ..question_push(&["SQLite", "Postgres"])
        });
        assert_eq!(sound_of(&question), "codeg-chime.caf");

        let mut permission = message(PushKind::NeedsYou);
        permission.needs = Some(NeedsKind::Permission);
        assert_eq!(sound_of(&permission), "codeg-chime.caf");

        let mut plan = message(PushKind::NeedsYou);
        plan.needs = Some(NeedsKind::Plan);
        assert_eq!(sound_of(&plan), "codeg-marimba.caf");

        // Claude Code's plan card is a permission request: still a plan.
        let mut plan_card = permission.clone();
        plan_card.pending = Some(PendingPush {
            kind: PendingKind::Plan,
            reminder: false,
            attempt: 0,
            question: None,
            ..question_push(&[])
        });
        assert_eq!(sound_of(&plan_card), "codeg-marimba.caf");

        // A reminder of any of them.
        let mut reminder = question.clone();
        reminder.pending = Some(question_push(&["SQLite", "Postgres"]));
        assert_eq!(sound_of(&reminder), "codeg-bell.caf");
        let mut plan_reminder = plan_card.clone();
        plan_reminder.pending.as_mut().unwrap().reminder = true;
        assert_eq!(sound_of(&plan_reminder), "codeg-bell.caf");

        assert_eq!(sound_of(&message(PushKind::TurnFinished)), "codeg-pop.caf");
        assert_eq!(sound_of(&message(PushKind::Test)), "codeg-pop.caf");
        assert_eq!(sound_of(&message(PushKind::Critical)), "codeg-glass.caf");
        assert_eq!(sound_of(&message(PushKind::Error)), "codeg-knock.caf");
    }

    #[test]
    fn the_session_project_and_critical_sounds_come_before_the_kind() {
        let chosen = sounds(json!({
            "kinds": { "turn_finished": "codeg-pop.caf" },
            "critical": "codeg-bell.caf",
            "projects": { "7": "codeg-chime.caf" },
            "sessions": { "42": "codeg-ping.caf" },
        }));
        let critical = SoundContext {
            critical_session: true,
            root_folder_id: None,
        };
        // message() is conversation 42 in folder 7.
        let msg = message(PushKind::TurnFinished);
        assert_eq!(
            msg.sound_for(&chosen, critical),
            &SoundChoice::File("codeg-ping.caf".into())
        );
        let mut other_session = msg.clone();
        other_session.conversation_id = Some(5);
        assert_eq!(
            other_session.sound_for(&chosen, critical),
            &SoundChoice::File("codeg-chime.caf".into())
        );
        let mut other_project = other_session.clone();
        other_project.folder_id = Some(9);
        assert_eq!(
            other_project.sound_for(&chosen, critical),
            &SoundChoice::File("codeg-bell.caf".into())
        );
        assert_eq!(
            other_project.sound_for(&chosen, SoundContext::default()),
            &SoundChoice::File("codeg-pop.caf".into())
        );
        // Folder 9 is a worktree of project 7.
        let in_worktree = SoundContext {
            critical_session: true,
            root_folder_id: Some(7),
        };
        assert_eq!(
            other_project.sound_for(&chosen, in_worktree),
            &SoundChoice::File("codeg-chime.caf".into())
        );
        let body = other_project.body_json_for("srv1", other_project.sound_for(&chosen, critical));
        assert_eq!(body["aps"]["sound"], "codeg-bell.caf");
    }

    #[test]
    fn a_kind_the_device_left_alone_plays_the_default_sound() {
        let only_plans = sounds(json!({ "kinds": { "plan": "codeg-chime.caf" } }));
        let msg = message(PushKind::TurnFinished);
        let sound = msg.sound_for(&only_plans, SoundContext::default());
        assert_eq!(sound, &SoundChoice::Default);
        assert_eq!(msg.body_json_for("srv1", sound), msg.body_json("srv1"));
        assert_eq!(msg.body_json("srv1")["aps"]["sound"], "default");
    }

    #[test]
    fn none_drops_the_sound_and_keeps_the_rest() {
        let mut msg = message(PushKind::NeedsYou);
        msg.needs = Some(NeedsKind::Question);
        msg.badge = Some(1);
        msg.pending = Some(PendingPush {
            reminder: false,
            attempt: 0,
            ..question_push(&["SQLite", "Postgres"])
        });
        let body = msg.body_json_for("srv1", &SoundChoice::Silent);
        assert!(body["aps"].get("sound").is_none());
        assert_eq!(body["aps"]["alert"]["title"], "Fix the login bug");
        assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
        assert_eq!(body["aps"]["category"], CATEGORY_QUESTION);
        assert_eq!(body["aps"]["mutable-content"], 1);
        assert_eq!(body["aps"]["badge"], 1);
        // The sound is all that changes.
        let mut loud = msg.body_json("srv1");
        assert_eq!(loud["aps"]["sound"], "default");
        loud["aps"].as_object_mut().unwrap().remove("sound");
        assert_eq!(body, loud);
    }

    #[test]
    fn a_silent_push_stays_silent_whatever_the_device_chose() {
        let glass = SoundChoice::File("codeg-glass.caf".into());
        let mut msg = message(PushKind::Critical);
        msg.sound = false;
        assert!(msg.body_json_for("srv1", &glass)["aps"]
            .get("sound")
            .is_none());
        let badge = PushMessage::badge_only(2);
        assert_eq!(badge.body_json_for("srv1", &glass), badge.body_json("srv1"));
    }

    #[test]
    fn a_badge_only_update_is_silent() {
        let msg = PushMessage::badge_only(0);
        let body = msg.body_json("srv1");
        assert_eq!(
            body,
            json!({
                "aps": { "badge": 0 },
                "server_id": "srv1",
                "kind": "badge",
                "alert_id": msg.alert_id,
            })
        );
        assert!(!msg.time_sensitive());
        assert_eq!(msg.collapse_id("srv1"), "srv1-badge");
    }
}
