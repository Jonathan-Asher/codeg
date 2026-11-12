//! Claude Code's prompt suggestions: the prompt it expects the user to send
//! next, predicted after each turn.
//!
//! codeg's own claude-agent-acp build publishes the prediction as the
//! `_codeg/prompt_suggestion` notification (`{sessionId, suggestion}`, where
//! `null` clears it) about three seconds after a turn ends, and advertises the
//! notification as `agentCapabilities._meta.codeg.promptSuggestions`. Claude
//! Code sends none after a session's first turn, in plan mode, after an API
//! error or at the usage limit. The connection turns each one into
//! [`AcpEvent::PromptSuggestion`](crate::acp::types::AcpEvent), the session
//! state keeps the latest so a client that attaches later gets it from the
//! snapshot, and the composer shows it as ghost text that Tab accepts.
//!
//! Each prediction costs one extra request with the session's full context
//! after every turn, so the setting (General → "Claude prompt suggestions",
//! on unless the user turned it off) can stop them. Off rides the per-launch
//! `runtime_env` like [`SessionPersistence`](crate::acp::session_persistence):
//! `build_session_runtime_env` stamps it from the stored setting,
//! `spawn_agent_connection` reads it back, and the session-establishing
//! requests carry `promptSuggestions: false` in `_meta.claudeCode.options`,
//! which makes Claude Code skip the prediction request entirely. A change
//! therefore reaches a session the next time it connects.
//!
//! Three counters in `app_metadata` record how the feature is used: the
//! predictions that arrived, the ones a client showed, and the ones the user
//! accepted with Tab. Clients report the last two once per prediction; the
//! session state makes sure several clients showing the same one count it
//! once.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_client_protocol::schema::v1::{
    LoadSessionRequest, Meta, NewSessionRequest, ResumeSessionRequest,
};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::models::AgentType;

/// The notification claude-agent-acp (codeg's build) sends a prediction on.
pub const PROMPT_SUGGESTION_METHOD: &str = "_codeg/prompt_suggestion";

/// `app_metadata` key of [`PromptSuggestionSettings`]. Per data directory, like
/// the other session settings: it describes this backend's sessions.
pub const PROMPT_SUGGESTION_SETTINGS_KEY: &str = "prompt_suggestion_settings";

/// `app_metadata` counters (see the module docs).
pub const RECEIVED_COUNTER_KEY: &str = "prompt_suggestions.received";
pub const SHOWN_COUNTER_KEY: &str = "prompt_suggestions.shown";
pub const ACCEPTED_COUNTER_KEY: &str = "prompt_suggestions.accepted";

/// Per-launch `runtime_env` key. Only [`PROMPT_SUGGESTIONS_OFF`] means
/// anything; any other value (or none) leaves Claude Code's default (on).
pub(crate) const PROMPT_SUGGESTIONS_ENV: &str = "CODEG_PROMPT_SUGGESTIONS";

/// The value that turns the predictions off for the launch.
pub(crate) const PROMPT_SUGGESTIONS_OFF: &str = "off";

/// "Claude prompt suggestions" (General settings). On unless the user turned
/// it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PromptSuggestionSettings {
    pub enabled: bool,
}

impl Default for PromptSuggestionSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// The stored setting. A missing or unreadable row reads as the default (on).
pub async fn load_settings(conn: &DatabaseConnection) -> PromptSuggestionSettings {
    match app_metadata_service::get_value(conn, PROMPT_SUGGESTION_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[prompt-suggestions] unreadable settings ({e}); using the default");
            PromptSuggestionSettings::default()
        }),
        Ok(None) => PromptSuggestionSettings::default(),
        Err(e) => {
            tracing::warn!("[prompt-suggestions] failed to load settings ({e}); using the default");
            PromptSuggestionSettings::default()
        }
    }
}

pub async fn save_settings(
    conn: &DatabaseConnection,
    settings: PromptSuggestionSettings,
) -> Result<PromptSuggestionSettings, AppCommandError> {
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize prompt suggestion settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, PROMPT_SUGGESTION_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    Ok(settings)
}

/// Whether one launch asks Claude Code for predictions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PromptSuggestions {
    /// Claude Code's default: a prediction after every turn.
    #[default]
    Default,
    /// `promptSuggestions: false`: no prediction request at all.
    Off,
}

impl PromptSuggestions {
    /// Read the per-launch key. Deliberately not falling back to codeg's own
    /// process env, like the other per-launch keys.
    pub fn from_env(runtime_env: &BTreeMap<String, String>) -> Self {
        match runtime_env.get(PROMPT_SUGGESTIONS_ENV).map(|v| v.trim()) {
            Some(value) if value.eq_ignore_ascii_case(PROMPT_SUGGESTIONS_OFF) => Self::Off,
            _ => Self::Default,
        }
    }

    /// Stamp a launch as asking for no predictions. Idempotent.
    pub fn mark_off(runtime_env: &mut BTreeMap<String, String>) {
        runtime_env.insert(
            PROMPT_SUGGESTIONS_ENV.to_string(),
            PROMPT_SUGGESTIONS_OFF.to_string(),
        );
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Default => "on",
            Self::Off => "off",
        }
    }
}

/// Stamp the stored setting onto a launch's `runtime_env`. Only Claude Code
/// makes predictions, so every other agent's launch is left as it is.
pub async fn stamp_launch(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    runtime_env: &mut BTreeMap<String, String>,
) {
    if agent_type != AgentType::ClaudeCode {
        return;
    }
    if !load_settings(conn).await.enabled {
        PromptSuggestions::mark_off(runtime_env);
    }
}

/// Add `promptSuggestions: false` to a Claude Code request's
/// `_meta.claudeCode.options` when the launch turned predictions off, keeping
/// every option already there. Meta without a `claudeCode` object (any other
/// agent) and the default setting leave the meta untouched.
pub fn apply_to_claude_meta(meta: Option<Meta>, setting: PromptSuggestions) -> Option<Meta> {
    let mut meta = meta?;
    if setting == PromptSuggestions::Default {
        return Some(meta);
    }
    if let Some(serde_json::Value::Object(claude_code)) = meta.get_mut("claudeCode") {
        if let Some(options) = claude_code
            .entry("options")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            .as_object_mut()
        {
            options.insert(
                "promptSuggestions".to_string(),
                serde_json::Value::Bool(false),
            );
        }
    }
    Some(meta)
}

/// Applies a launch's [`PromptSuggestions`] to a session-establishing request
/// (`session/new`, `load`, `resume`): the requests Claude Code reads its
/// options from.
pub(crate) trait SuggestingSession: Sized {
    fn prompt_suggestions(self, setting: PromptSuggestions) -> Self;
}

macro_rules! impl_suggesting_session {
    ($($request:ty),*) => {$(
        impl SuggestingSession for $request {
            fn prompt_suggestions(mut self, setting: PromptSuggestions) -> Self {
                self.meta = apply_to_claude_meta(self.meta.take(), setting);
                self
            }
        }
    )*};
}

impl_suggesting_session!(NewSessionRequest, LoadSessionRequest, ResumeSessionRequest);

/// One prediction as clients receive it. `id` is unique within this codeg
/// process and grows with every prediction, so a client reports what it
/// showed by id and a later one is always told apart from an earlier one with
/// the same text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptSuggestion {
    pub id: u64,
    pub text: String,
}

/// The next prediction id (see [`PromptSuggestion::id`]). Starts at 1.
pub fn next_suggestion_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// The prediction a `_codeg/prompt_suggestion` notification carries:
/// `Some(Some(text))` for a prediction, `Some(None)` for a clear, `None` when
/// the params are not that notification's. A blank prediction is a clear: an
/// empty hint in the composer would say nothing.
pub fn parse_notification(params: &serde_json::Value) -> Option<Option<String>> {
    let suggestion = params.as_object()?.get("suggestion")?;
    match suggestion {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            Some((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        _ => None,
    }
}

/// What a client reports about the prediction on its screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionAction {
    /// The composer showed it as ghost text.
    Shown,
    /// The user took it into the composer with Tab.
    Accepted,
}

/// Which predictions of one connection have been counted, so several clients
/// (two windows, the phone) reporting the same one count it once. Only the
/// newest prediction reported is tracked: an older one's report is stale.
#[derive(Debug, Clone, Default)]
pub struct SuggestionReports {
    id: u64,
    shown: bool,
    accepted: bool,
}

impl SuggestionReports {
    /// Record a report and return the counters it adds to (none for a repeat
    /// or a stale id). `latest_published` is the newest id this connection
    /// published; a report for an id it never published is ignored. An accept
    /// also counts as shown: the prediction was on screen to be accepted.
    pub fn record(
        &mut self,
        id: u64,
        action: SuggestionAction,
        latest_published: u64,
    ) -> Vec<&'static str> {
        if id == 0 || id > latest_published || id < self.id {
            return Vec::new();
        }
        if id > self.id {
            *self = Self {
                id,
                shown: false,
                accepted: false,
            };
        }
        let mut counters = Vec::new();
        if !self.shown {
            self.shown = true;
            counters.push(SHOWN_COUNTER_KEY);
        }
        if action == SuggestionAction::Accepted && !self.accepted {
            self.accepted = true;
            counters.push(ACCEPTED_COUNTER_KEY);
        }
        counters
    }
}

/// The three counters, for the settings page and the check-in on whether the
/// predictions are worth what they cost.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSuggestionStats {
    pub received: i64,
    pub shown: i64,
    pub accepted: i64,
}

pub async fn load_stats(conn: &DatabaseConnection) -> PromptSuggestionStats {
    let read = |key: &'static str| async move {
        app_metadata_service::read_counter(conn, key)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("[prompt-suggestions] failed to read {key}: {e}");
                0
            })
    };
    PromptSuggestionStats {
        received: read(RECEIVED_COUNTER_KEY).await,
        shown: read(SHOWN_COUNTER_KEY).await,
        accepted: read(ACCEPTED_COUNTER_KEY).await,
    }
}

/// Count a client's report that it showed prediction `id` of connection
/// `conn_id`, or that the user accepted it. Several clients reporting the
/// same prediction count it once.
pub async fn report(
    manager: &crate::acp::manager::ConnectionManager,
    conn: &DatabaseConnection,
    conn_id: &str,
    id: u64,
    action: SuggestionAction,
) -> Result<(), crate::acp::error::AcpError> {
    let counters = manager
        .record_prompt_suggestion_report(conn_id, id, action)
        .await?;
    bump(conn, &counters).await;
    Ok(())
}

/// Add one to each of `counters`. Best effort: a failed write costs a count,
/// never the request that caused it.
pub async fn bump(conn: &DatabaseConnection, counters: &[&'static str]) {
    for key in counters {
        if let Err(e) = app_metadata_service::increment_counter(conn, key).await {
            tracing::warn!("[prompt-suggestions] failed to count {key}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[test]
    fn the_launch_key_reads_back_off_only_when_stamped() {
        let mut env = BTreeMap::new();
        assert_eq!(
            PromptSuggestions::from_env(&env),
            PromptSuggestions::Default
        );
        env.insert(PROMPT_SUGGESTIONS_ENV.to_string(), "maybe".to_string());
        assert_eq!(
            PromptSuggestions::from_env(&env),
            PromptSuggestions::Default
        );
        PromptSuggestions::mark_off(&mut env);
        PromptSuggestions::mark_off(&mut env);
        assert_eq!(PromptSuggestions::from_env(&env), PromptSuggestions::Off);
        env.insert(PROMPT_SUGGESTIONS_ENV.to_string(), " OFF ".to_string());
        assert_eq!(PromptSuggestions::from_env(&env), PromptSuggestions::Off);
    }

    #[tokio::test]
    async fn the_setting_defaults_to_on_and_stamps_only_claude_launches() {
        let db = fresh_in_memory_db().await;
        assert!(load_settings(&db.conn).await.enabled);

        let mut env = BTreeMap::new();
        stamp_launch(&db.conn, AgentType::ClaudeCode, &mut env).await;
        assert!(
            env.is_empty(),
            "on is Claude Code's default: nothing to stamp"
        );

        save_settings(&db.conn, PromptSuggestionSettings { enabled: false })
            .await
            .unwrap();
        assert!(!load_settings(&db.conn).await.enabled);
        stamp_launch(&db.conn, AgentType::ClaudeCode, &mut env).await;
        assert_eq!(PromptSuggestions::from_env(&env), PromptSuggestions::Off);

        let mut codex = BTreeMap::new();
        stamp_launch(&db.conn, AgentType::Codex, &mut codex).await;
        assert!(codex.is_empty(), "other agents make no predictions");
    }

    #[test]
    fn off_adds_the_option_and_keeps_the_others() {
        let mut meta = Meta::new();
        meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({"emitRawSDKMessages": true, "options": {"persistSession": false}}),
        );
        let off = apply_to_claude_meta(Some(meta.clone()), PromptSuggestions::Off).unwrap();
        assert_eq!(
            serde_json::Value::Object(off),
            serde_json::json!({"claudeCode": {
                "emitRawSDKMessages": true,
                "options": {"persistSession": false, "promptSuggestions": false},
            }})
        );
        let on = apply_to_claude_meta(Some(meta.clone()), PromptSuggestions::Default).unwrap();
        assert_eq!(on, meta);
        // Another agent's meta, and no meta at all, are left alone.
        let mut pi = Meta::new();
        pi.insert("piAcp".to_string(), serde_json::json!({"sessionName": "x"}));
        assert_eq!(
            apply_to_claude_meta(Some(pi.clone()), PromptSuggestions::Off),
            Some(pi)
        );
        assert_eq!(apply_to_claude_meta(None, PromptSuggestions::Off), None);
    }

    #[test]
    fn parses_predictions_and_clears() {
        assert_eq!(
            parse_notification(
                &serde_json::json!({"sessionId": "s", "suggestion": "  run the tests "})
            ),
            Some(Some("run the tests".to_string()))
        );
        assert_eq!(
            parse_notification(&serde_json::json!({"sessionId": "s", "suggestion": null})),
            Some(None)
        );
        assert_eq!(
            parse_notification(&serde_json::json!({"sessionId": "s", "suggestion": "   "})),
            Some(None),
            "a blank prediction clears"
        );
        assert_eq!(
            parse_notification(&serde_json::json!({"sessionId": "s"})),
            None
        );
        assert_eq!(
            parse_notification(&serde_json::json!({"suggestion": 3})),
            None
        );
    }

    #[test]
    fn ids_grow() {
        let a = next_suggestion_id();
        let b = next_suggestion_id();
        assert!(a >= 1 && b > a);
    }

    #[test]
    fn each_prediction_counts_once_however_many_clients_report_it() {
        let mut reports = SuggestionReports::default();
        assert_eq!(
            reports.record(5, SuggestionAction::Shown, 5),
            [SHOWN_COUNTER_KEY]
        );
        // A second window showing the same prediction.
        assert!(reports.record(5, SuggestionAction::Shown, 5).is_empty());
        assert_eq!(
            reports.record(5, SuggestionAction::Accepted, 5),
            [ACCEPTED_COUNTER_KEY]
        );
        assert!(reports.record(5, SuggestionAction::Accepted, 5).is_empty());
        // A newer prediction starts over; an accept without a show counts both.
        assert_eq!(
            reports.record(9, SuggestionAction::Accepted, 9),
            [SHOWN_COUNTER_KEY, ACCEPTED_COUNTER_KEY]
        );
        // Stale, unpublished and zero ids count nothing.
        assert!(reports.record(5, SuggestionAction::Shown, 9).is_empty());
        assert!(reports.record(12, SuggestionAction::Shown, 9).is_empty());
        assert!(reports.record(0, SuggestionAction::Shown, 9).is_empty());
    }

    #[tokio::test]
    async fn counters_add_up_in_app_metadata() {
        let db = fresh_in_memory_db().await;
        assert_eq!(load_stats(&db.conn).await, PromptSuggestionStats::default());
        bump(&db.conn, &[RECEIVED_COUNTER_KEY]).await;
        bump(&db.conn, &[RECEIVED_COUNTER_KEY]).await;
        bump(&db.conn, &[SHOWN_COUNTER_KEY, ACCEPTED_COUNTER_KEY]).await;
        assert_eq!(
            load_stats(&db.conn).await,
            PromptSuggestionStats {
                received: 2,
                shown: 1,
                accepted: 1
            }
        );
    }
}
