//! The APNs request one notification becomes: the JSON body and the
//! per-notification headers. This is the contract the iOS client reads —
//! `docs/ios-push.md` documents it field by field; keep the two in step.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::acp::critical_watch::CriticalAlertKind;

/// Critical-session alerts. Actions: `ACK`, `SNOOZE`, `OPEN`.
pub const CATEGORY_CRITICAL: &str = "CODEG_CRITICAL";
/// A permission request. Actions: `APPROVE`, `OPEN`.
pub const CATEGORY_PERMISSION: &str = "CODEG_PERMISSION";
/// Everything else about a session. Action: `OPEN`.
pub const CATEGORY_SESSION: &str = "CODEG_SESSION";

/// How long APNs keeps trying to reach a device that is offline.
const EXPIRATION_SECS: i64 = 60 * 60;

/// Longest title / body sent; the whole payload must stay under 4 KB.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 600;

/// What a notification is about. Also the `kind` custom field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushKind {
    TurnFinished,
    NeedsYou,
    Error,
    Critical,
    Test,
}

impl PushKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PushKind::TurnFinished => "turn_finished",
            PushKind::NeedsYou => "needs_you",
            PushKind::Error => "error",
            PushKind::Critical => "critical",
            PushKind::Test => "test",
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
        Self {
            connection_id: connection_id.to_string(),
            request_id: request_id.to_string(),
            approve_option_id: pick("allow_once", "allow"),
            deny_option_id: pick("reject_once", "reject"),
        }
    }
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
    /// Play the default sound.
    pub sound: bool,
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
    /// The notification category the iOS app registers its buttons under.
    pub fn category(&self) -> &'static str {
        match self.kind {
            PushKind::Critical => CATEGORY_CRITICAL,
            PushKind::NeedsYou if self.permission.is_some() => CATEGORY_PERMISSION,
            _ => CATEGORY_SESSION,
        }
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

    /// The JSON body: `aps` plus codeg's custom fields at the top level.
    pub fn body_json(&self, server_id: &str) -> Value {
        let mut aps = Map::new();
        aps.insert(
            "alert".into(),
            json!({
                "title": clip(&self.title, MAX_TITLE_CHARS),
                "body": clip(&self.body, MAX_BODY_CHARS),
            }),
        );
        if self.sound {
            aps.insert("sound".into(), json!("default"));
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
}
