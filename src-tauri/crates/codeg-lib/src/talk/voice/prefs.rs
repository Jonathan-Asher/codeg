//! Settings › Talk on this Mac: the global shortcut, hands-free or hold to
//! talk, interrupting by speaking, whether the whisper pack makes the final
//! transcript, and the rest of the helper's `prefs` (patience, echo
//! cancellation, progress phrases, Smart Turn, telemetry). Kept in
//! `app_metadata` of this Mac's own backend; the window sends them with each
//! `start`.

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

/// `app_metadata` key of [`TalkVoicePrefs`].
pub const TALK_VOICE_PREFS_KEY: &str = "talk_voice_prefs";

/// ⌥⌘T, in the accelerator syntax the shortcut registrar takes.
pub const DEFAULT_TALK_SHORTCUT: &str = "Alt+Super+KeyT";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TalkVoicePrefs {
    /// The global shortcut is registered: a press mutes and unmutes, holding
    /// it is push to talk, and with no Talk running it starts one on the
    /// session in front.
    pub shortcut_enabled: bool,
    pub shortcut: String,
    /// Listen all the time (true), or only while the shortcut or the orb is
    /// held.
    pub hands_free: bool,
    /// Talking over a reply stops it (on speakers this needs echo
    /// cancellation, which the helper turns on).
    pub interrupt_by_speaking: bool,
    /// The whisper pack makes the final transcript when it is downloaded.
    pub use_whisper: bool,
    /// How long a pause ends what you say: `short`, `normal`, `long`.
    pub patience: String,
    /// Echo cancellation: `automatic` (by the route), `voiceProcessing`,
    /// `off`.
    pub echo_mode: String,
    /// A short phrase while long work runs.
    pub speak_progress: bool,
    /// Smart Turn decides the end of turn (otherwise it only logs).
    pub smart_turn_active: bool,
    /// Talk's tuning report goes to this Mac's diagnostics.
    pub share_telemetry: bool,
}

impl Default for TalkVoicePrefs {
    fn default() -> Self {
        Self {
            shortcut_enabled: true,
            shortcut: DEFAULT_TALK_SHORTCUT.to_string(),
            hands_free: true,
            interrupt_by_speaking: true,
            use_whisper: true,
            patience: "normal".to_string(),
            echo_mode: "automatic".to_string(),
            speak_progress: false,
            smart_turn_active: false,
            share_telemetry: true,
        }
    }
}

impl TalkVoicePrefs {
    /// A shortcut the registrar can take, or why not; an unknown patience or
    /// echo mode reads as the default.
    pub fn normalized(mut self) -> Result<Self, String> {
        self.shortcut = crate::commands::quick_ask::normalize_shortcut(&self.shortcut)?;
        if !matches!(self.patience.as_str(), "short" | "normal" | "long") {
            self.patience = "normal".into();
        }
        if !matches!(
            self.echo_mode.as_str(),
            "automatic" | "voiceProcessing" | "off"
        ) {
            self.echo_mode = "automatic".into();
        }
        Ok(self)
    }
}

/// The stored preferences; a missing or unreadable row reads as the default.
pub async fn load_prefs(conn: &DatabaseConnection) -> TalkVoicePrefs {
    match app_metadata_service::get_value(conn, TALK_VOICE_PREFS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[talk-voice] unreadable preferences ({e}); using the default");
            TalkVoicePrefs::default()
        }),
        Ok(None) => TalkVoicePrefs::default(),
        Err(e) => {
            tracing::warn!("[talk-voice] failed to load preferences ({e}); using the default");
            TalkVoicePrefs::default()
        }
    }
}

/// Check and store the preferences.
pub async fn save_prefs(
    conn: &DatabaseConnection,
    prefs: TalkVoicePrefs,
) -> Result<TalkVoicePrefs, AppCommandError> {
    let prefs = prefs
        .normalized()
        .map_err(|e| AppCommandError::invalid_input(format!("Invalid shortcut: {e}")))?;
    let raw = serde_json::to_string(&prefs).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize Talk preferences")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, TALK_VOICE_PREFS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_option_command_t_hands_free_with_interrupting() {
        let prefs = TalkVoicePrefs::default();
        assert_eq!(prefs.shortcut, "Alt+Super+KeyT");
        assert!(prefs.shortcut_enabled && prefs.hands_free && prefs.interrupt_by_speaking);
        assert!(prefs.use_whisper);
        assert_eq!(prefs.clone().normalized().unwrap(), prefs);
    }

    #[test]
    fn missing_fields_take_the_default_and_names_are_camel_case() {
        let prefs: TalkVoicePrefs = serde_json::from_str(r#"{"handsFree": false}"#).unwrap();
        assert!(!prefs.hands_free);
        assert_eq!(prefs.shortcut, DEFAULT_TALK_SHORTCUT);
        let json = serde_json::to_value(&prefs).unwrap();
        assert_eq!(json["interruptBySpeaking"], true);
        assert_eq!(json["shortcutEnabled"], true);
    }

    #[test]
    fn unknown_patience_or_echo_mode_reads_as_the_default() {
        let prefs = TalkVoicePrefs {
            patience: "forever".into(),
            echo_mode: "loud".into(),
            ..TalkVoicePrefs::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(prefs.patience, "normal");
        assert_eq!(prefs.echo_mode, "automatic");
        let json = serde_json::to_value(TalkVoicePrefs::default()).unwrap();
        for key in [
            "handsFree",
            "patience",
            "interruptBySpeaking",
            "speakProgress",
            "smartTurnActive",
            "echoMode",
            "shareTelemetry",
        ] {
            assert!(json.get(key).is_some(), "the helper's prefs carry {key}");
        }
    }

    #[test]
    fn a_shortcut_without_a_modifier_is_refused() {
        let prefs = TalkVoicePrefs {
            shortcut: "KeyT".into(),
            ..TalkVoicePrefs::default()
        };
        assert!(prefs.normalized().is_err());
    }
}
