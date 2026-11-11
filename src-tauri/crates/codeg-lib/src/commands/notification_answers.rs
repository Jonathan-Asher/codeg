//! Answering a pending item (a permission, a question, a plan) from its macOS
//! notification: what a notification's buttons send, and when a notification
//! has gone stale. Platform-free; the native glue is in `notification.rs`.
//!
//! The window that raises the notification builds its buttons — it has the
//! item, the user's "hide contents" choice and the strings — and hands them
//! over with it (`src/lib/notification-actions.ts`). They ride in the
//! notification's `userInfo` next to its route, so an activation needs
//! nothing but the notification, even after a restart.
//!
//! An answer goes to the backend the raising window is bound to, over the
//! transport that window uses: the local connection manager for the local
//! workspace, the remote proxy (`remote_http_call`) for a remote one. It is
//! the call the in-app card makes (`acp_respond_permission`,
//! `acp_answer_question`, `acp_answer_plan_approval`), with the fields the
//! iPhone's answer buttons use (`docs/ios-push.md`). Answering an item that is
//! no longer waiting is a silent no-op on the backend, so the item is looked
//! up first: one that is gone opens its session with a notice instead.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The button that only opens the session.
pub const OPEN_BUTTON_ID: &str = "open";

/// How long a notification about an item its backend does not list is left
/// alone. A first notification is posted on the agent's event, which can
/// reach the window before the backend's list (rebuilt every second) does.
pub const STALE_GRACE_SECS: f64 = 30.0;

/// How the item is answered (`pending::PendingSource` on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerSource {
    Permission,
    Question,
    PlanApproval,
}

/// One button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationButton {
    pub id: String,
    pub title: String,
    /// What it answers: a permission option's id or a question option's
    /// exact label. Unused by a plan's approve and by the open button.
    #[serde(default)]
    pub value: String,
}

/// An inline text answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationReply {
    #[serde(default)]
    pub placeholder: String,
}

/// The pending item a notification is about, and the buttons that answer
/// it. With contents hidden it has no buttons and no reply, and still names
/// the item, so the notification is withdrawn when the item clears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNotification {
    /// The item's id in `list_pending_items` (`<source>:<request id>`).
    pub pending_id: String,
    pub source: AnswerSource,
    /// The asking session's connection (a delegated sub-agent's own).
    pub connection_id: String,
    /// The permission request's, the question set's or the approval's id.
    pub request_id: String,
    /// A question's own id (`answers[].questionId`).
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub buttons: Vec<NotificationButton>,
    #[serde(default)]
    pub reply: Option<NotificationReply>,
}

impl PendingNotification {
    /// The buttons that answer, without the one that only opens.
    pub fn answer_buttons(&self) -> impl Iterator<Item = &NotificationButton> {
        self.buttons.iter().filter(|b| b.id != OPEN_BUTTON_ID)
    }

    /// Whether the notification offers any way to answer.
    pub fn is_answerable(&self) -> bool {
        self.answer_buttons().next().is_some() || self.reply.is_some()
    }
}

/// `userInfo` key the [`PendingNotification`] is stored under.
pub const PENDING_USER_INFO_KEY: &str = "codegPending";

pub fn encode_pending(pending: &PendingNotification) -> String {
    serde_json::to_string(pending).unwrap_or_default()
}

/// `None` for anything this build did not write.
pub fn decode_pending(raw: &str) -> Option<PendingNotification> {
    serde_json::from_str::<PendingNotification>(raw)
        .ok()
        .filter(|p| !p.pending_id.is_empty())
}

/// What the user did with a notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Activation {
    /// Clicked the notification itself.
    Clicked,
    /// The action button, which carries the first button's title.
    Primary,
    /// A button, by id.
    Button(String),
    /// Typed an answer.
    Reply(String),
}

/// One answer, as the in-app card sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerCall {
    Permission {
        connection_id: String,
        request_id: String,
        option_id: String,
    },
    Question {
        connection_id: String,
        question_id: String,
        item_id: String,
        label: String,
    },
    ApprovePlan {
        connection_id: String,
        approval_id: String,
    },
}

impl AnswerCall {
    /// The API command, the same name over Tauri and HTTP.
    pub fn command(&self) -> &'static str {
        match self {
            AnswerCall::Permission { .. } => "acp_respond_permission",
            AnswerCall::Question { .. } => "acp_answer_question",
            AnswerCall::ApprovePlan { .. } => "acp_answer_plan_approval",
        }
    }

    /// Its arguments, as the frontend sends them (camelCase).
    pub fn args(&self) -> Value {
        match self {
            AnswerCall::Permission {
                connection_id,
                request_id,
                option_id,
            } => json!({
                "connectionId": connection_id,
                "requestId": request_id,
                "optionId": option_id,
            }),
            AnswerCall::Question {
                connection_id,
                question_id,
                item_id,
                label,
            } => json!({
                "connectionId": connection_id,
                "questionId": question_id,
                "answer": {
                    "answers": [{"questionId": item_id, "labels": [label]}],
                    "declined": false,
                },
            }),
            AnswerCall::ApprovePlan {
                connection_id,
                approval_id,
            } => json!({
                "connectionId": connection_id,
                "approvalId": approval_id,
                "answer": {"decision": "approve", "feedback": null},
            }),
        }
    }
}

/// The answer an activation sends, or `None` when it only opens the session
/// (a click, the open button, an empty reply, a button this notification
/// does not have).
pub fn answer_for(pending: &PendingNotification, activation: &Activation) -> Option<AnswerCall> {
    let connection_id = pending.connection_id.clone();
    let request_id = pending.request_id.clone();
    match activation {
        Activation::Clicked => None,
        Activation::Reply(text) => {
            if pending.source != AnswerSource::Question || pending.reply.is_none() {
                return None;
            }
            let label: String = text
                .trim()
                .chars()
                .take(crate::acp::question::MAX_QUESTION_TEXT_CHARS)
                .collect();
            if label.is_empty() {
                return None;
            }
            Some(AnswerCall::Question {
                connection_id,
                question_id: request_id,
                item_id: pending.item_id.clone().filter(|id| !id.is_empty())?,
                label,
            })
        }
        Activation::Primary | Activation::Button(_) => {
            let button = match activation {
                Activation::Button(id) => pending.answer_buttons().find(|b| &b.id == id)?,
                _ => pending.answer_buttons().next()?,
            };
            match pending.source {
                AnswerSource::Permission => {
                    if button.value.is_empty() {
                        return None;
                    }
                    Some(AnswerCall::Permission {
                        connection_id,
                        request_id,
                        option_id: button.value.clone(),
                    })
                }
                AnswerSource::Question => {
                    if button.value.is_empty() {
                        return None;
                    }
                    Some(AnswerCall::Question {
                        connection_id,
                        question_id: request_id,
                        item_id: pending.item_id.clone().filter(|id| !id.is_empty())?,
                        label: button.value.clone(),
                    })
                }
                AnswerSource::PlanApproval => Some(AnswerCall::ApprovePlan {
                    connection_id,
                    approval_id: request_id,
                }),
            }
        }
    }
}

/// What became of an answer sent from a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerOutcome {
    /// Sent: the notification is withdrawn.
    Answered,
    /// The item was no longer waiting (answered elsewhere, cancelled): its
    /// session opens with a notice instead.
    Gone,
    /// The backend refused or could not be reached: the session opens so it
    /// can be answered there.
    Failed,
}

/// A short notice shown where a notification's session opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationNotice {
    AlreadyAnswered,
    NotAnswered,
}

impl AnswerOutcome {
    pub fn notice(self) -> Option<NotificationNotice> {
        match self {
            AnswerOutcome::Answered => None,
            AnswerOutcome::Gone => Some(NotificationNotice::AlreadyAnswered),
            AnswerOutcome::Failed => Some(NotificationNotice::NotAnswered),
        }
    }
}

/// The backend an answer goes to.
pub(crate) trait AnswerBackend {
    /// Whether the backend still lists the item.
    async fn is_pending(&self, pending_id: &str) -> Result<bool, String>;
    async fn send(&self, call: &AnswerCall) -> Result<(), String>;
}

/// Send an answer, unless the item is already gone. A backend that cannot
/// say (an older server without the list) is answered anyway.
pub(crate) async fn run_answer<B: AnswerBackend>(
    backend: &B,
    pending_id: &str,
    call: &AnswerCall,
) -> AnswerOutcome {
    match backend.is_pending(pending_id).await {
        Ok(false) => return AnswerOutcome::Gone,
        Ok(true) => {}
        Err(err) => {
            tracing::warn!("[notification] cannot list pending items: {err}");
        }
    }
    match backend.send(call).await {
        Ok(()) => AnswerOutcome::Answered,
        Err(err) => {
            tracing::warn!("[notification] answer failed: {err}");
            AnswerOutcome::Failed
        }
    }
}

/// Whether a `list_pending_items` snapshot lists the item.
pub fn snapshot_lists(snapshot: &Value, pending_id: &str) -> bool {
    snapshot
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(pending_id))
        })
}

/// Whether a delivered notification about `pending_id`, `age_secs` old, is
/// stale: its item cleared since the window's last list (`gone`), or the
/// backend no longer lists it (`live`) and it is past the grace period.
pub fn is_stale(pending_id: &str, age_secs: f64, live: &[String], gone: &[String]) -> bool {
    if gone.iter().any(|id| id == pending_id) {
        return true;
    }
    !live.iter().any(|id| id == pending_id) && age_secs >= STALE_GRACE_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn button(id: &str, title: &str, value: &str) -> NotificationButton {
        NotificationButton {
            id: id.into(),
            title: title.into(),
            value: value.into(),
        }
    }

    fn permission() -> PendingNotification {
        PendingNotification {
            pending_id: "permission:r1".into(),
            source: AnswerSource::Permission,
            connection_id: "conn-child".into(),
            request_id: "r1".into(),
            item_id: None,
            buttons: vec![
                button("b0", "Allow", "allow-once"),
                button("b1", "Always allow", "allow-always"),
                button("b2", "Deny", "reject-once"),
                button(OPEN_BUTTON_ID, "Open", ""),
            ],
            reply: None,
        }
    }

    fn question() -> PendingNotification {
        PendingNotification {
            pending_id: "question:q1".into(),
            source: AnswerSource::Question,
            connection_id: "conn".into(),
            request_id: "q1".into(),
            item_id: Some("q1-0".into()),
            buttons: vec![
                button("b0", "Postgres (Recommended)", "Postgres (Recommended)"),
                button("b1", "SQLite", "SQLite"),
                button(OPEN_BUTTON_ID, "Open", ""),
            ],
            reply: Some(NotificationReply {
                placeholder: "Type your answer…".into(),
            }),
        }
    }

    fn plan() -> PendingNotification {
        PendingNotification {
            pending_id: "plan_approval:a1".into(),
            source: AnswerSource::PlanApproval,
            connection_id: "conn".into(),
            request_id: "a1".into(),
            item_id: None,
            buttons: vec![
                button("b0", "Approve", "approve"),
                button(OPEN_BUTTON_ID, "Open", ""),
            ],
            reply: None,
        }
    }

    #[test]
    fn a_permission_button_sends_its_option_on_the_asking_connection() {
        let call = answer_for(&permission(), &Activation::Button("b2".into())).unwrap();
        assert_eq!(
            call,
            AnswerCall::Permission {
                connection_id: "conn-child".into(),
                request_id: "r1".into(),
                option_id: "reject-once".into(),
            }
        );
        assert_eq!(call.command(), "acp_respond_permission");
        assert_eq!(
            call.args(),
            json!({"connectionId": "conn-child", "requestId": "r1", "optionId": "reject-once"})
        );
    }

    #[test]
    fn the_action_button_is_the_first_button() {
        let call = answer_for(&permission(), &Activation::Primary).unwrap();
        assert!(matches!(call, AnswerCall::Permission { option_id, .. } if option_id == "allow-once"));
    }

    #[test]
    fn a_question_button_sends_its_exact_label_like_the_card() {
        let call = answer_for(&question(), &Activation::Button("b0".into())).unwrap();
        assert_eq!(call.command(), "acp_answer_question");
        assert_eq!(
            call.args(),
            json!({
                "connectionId": "conn",
                "questionId": "q1",
                "answer": {
                    "answers": [{"questionId": "q1-0", "labels": ["Postgres (Recommended)"]}],
                    "declined": false,
                },
            })
        );
    }

    #[test]
    fn a_reply_answers_with_the_typed_text() {
        let call = answer_for(&question(), &Activation::Reply("  MySQL, please \n".into())).unwrap();
        assert!(matches!(call, AnswerCall::Question { label, .. } if label == "MySQL, please"));
    }

    #[test]
    fn an_empty_reply_or_a_reply_nobody_offered_only_opens() {
        assert_eq!(answer_for(&question(), &Activation::Reply("   ".into())), None);
        let mut no_reply = question();
        no_reply.reply = None;
        assert_eq!(answer_for(&no_reply, &Activation::Reply("yes".into())), None);
        // A permission takes no text.
        assert_eq!(answer_for(&permission(), &Activation::Reply("yes".into())), None);
    }

    #[test]
    fn a_question_without_its_own_id_cannot_be_answered() {
        let mut q = question();
        q.item_id = None;
        assert_eq!(answer_for(&q, &Activation::Button("b1".into())), None);
        assert_eq!(answer_for(&q, &Activation::Reply("x".into())), None);
    }

    #[test]
    fn a_plan_button_approves() {
        let call = answer_for(&plan(), &Activation::Button("b0".into())).unwrap();
        assert_eq!(call.command(), "acp_answer_plan_approval");
        assert_eq!(
            call.args(),
            json!({
                "connectionId": "conn",
                "approvalId": "a1",
                "answer": {"decision": "approve", "feedback": null},
            })
        );
    }

    #[test]
    fn a_click_the_open_button_or_an_unknown_button_only_opens() {
        for pending in [permission(), question(), plan()] {
            assert_eq!(answer_for(&pending, &Activation::Clicked), None);
            assert_eq!(
                answer_for(&pending, &Activation::Button(OPEN_BUTTON_ID.into())),
                None
            );
            assert_eq!(answer_for(&pending, &Activation::Button("b9".into())), None);
        }
    }

    #[test]
    fn hidden_contents_leave_nothing_to_answer() {
        let mut hidden = question();
        hidden.buttons.clear();
        hidden.reply = None;
        assert!(!hidden.is_answerable());
        assert_eq!(answer_for(&hidden, &Activation::Primary), None);
        assert!(question().is_answerable());
    }

    #[test]
    fn the_pending_payload_survives_user_info() {
        let q = question();
        assert_eq!(decode_pending(&encode_pending(&q)), Some(q));
        // The frontend's shape: camelCase, optional fields absent.
        let raw = r#"{"pendingId":"permission:r","source":"permission","connectionId":"c","requestId":"r"}"#;
        let decoded = decode_pending(raw).unwrap();
        assert!(decoded.buttons.is_empty() && decoded.reply.is_none());
        assert_eq!(decode_pending("{}"), None);
        assert_eq!(decode_pending("not json"), None);
    }

    #[test]
    fn a_snapshot_lists_its_items_by_id() {
        let snapshot = json!({"items": [{"id": "question:q1"}, {"id": "permission:r1"}], "count": 2});
        assert!(snapshot_lists(&snapshot, "permission:r1"));
        assert!(!snapshot_lists(&snapshot, "permission:r2"));
        assert!(!snapshot_lists(&json!({}), "permission:r1"));
    }

    #[test]
    fn stale_means_cleared_or_unlisted_past_the_grace_period() {
        let live = vec!["question:q1".to_string()];
        let gone = vec!["permission:r1".to_string()];
        // Cleared since the last list: withdrawn at once.
        assert!(is_stale("permission:r1", 1.0, &live, &gone));
        // Still waiting: kept, however old.
        assert!(!is_stale("question:q1", 9_999.0, &live, &[]));
        // Not listed: a fresh one may simply be ahead of the list.
        assert!(!is_stale("plan_approval:a1", 2.0, &live, &[]));
        assert!(is_stale("plan_approval:a1", STALE_GRACE_SECS, &live, &[]));
    }

    /// A backend that records what it was asked.
    struct FakeBackend {
        listed: Result<bool, String>,
        send: Result<(), String>,
        sent: RefCell<Vec<AnswerCall>>,
    }

    impl FakeBackend {
        fn new(listed: Result<bool, String>, send: Result<(), String>) -> Self {
            Self {
                listed,
                send,
                sent: RefCell::new(Vec::new()),
            }
        }
    }

    impl AnswerBackend for FakeBackend {
        async fn is_pending(&self, _pending_id: &str) -> Result<bool, String> {
            self.listed.clone()
        }

        async fn send(&self, call: &AnswerCall) -> Result<(), String> {
            self.sent.borrow_mut().push(call.clone());
            self.send.clone()
        }
    }

    async fn run(backend: &FakeBackend) -> AnswerOutcome {
        let call = answer_for(&permission(), &Activation::Primary).unwrap();
        run_answer(backend, "permission:r1", &call).await
    }

    #[tokio::test]
    async fn an_item_still_waiting_is_answered() {
        let backend = FakeBackend::new(Ok(true), Ok(()));
        assert_eq!(run(&backend).await, AnswerOutcome::Answered);
        assert_eq!(backend.sent.borrow().len(), 1);
        assert_eq!(AnswerOutcome::Answered.notice(), None);
    }

    #[tokio::test]
    async fn an_item_already_gone_is_not_answered_and_opens_with_a_notice() {
        let backend = FakeBackend::new(Ok(false), Ok(()));
        assert_eq!(run(&backend).await, AnswerOutcome::Gone);
        assert!(backend.sent.borrow().is_empty());
        assert_eq!(
            AnswerOutcome::Gone.notice(),
            Some(NotificationNotice::AlreadyAnswered)
        );
    }

    #[tokio::test]
    async fn a_failed_answer_opens_with_a_notice() {
        let backend = FakeBackend::new(Ok(true), Err("unreachable".into()));
        assert_eq!(run(&backend).await, AnswerOutcome::Failed);
        assert_eq!(
            AnswerOutcome::Failed.notice(),
            Some(NotificationNotice::NotAnswered)
        );
    }

    #[tokio::test]
    async fn a_backend_that_cannot_list_is_answered_anyway() {
        let backend = FakeBackend::new(Err("404".into()), Ok(()));
        assert_eq!(run(&backend).await, AnswerOutcome::Answered);
        assert_eq!(backend.sent.borrow().len(), 1);
    }
}
