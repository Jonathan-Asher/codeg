//! Grok's permission mode as a live composer selector.
//!
//! Grok advertises no ACP `modes` for permissions. Its `session/set_mode`
//! takes only `default`, `ask` and `plan` (the conversation mode), and its
//! `configOptions` list only `model`. What it does take, on a running session,
//! is the notification its own TUI sends when the user cycles the mode:
//! `_x.ai/yolo_mode_changed {sessionId, yolo_mode, auto_mode}`. Probed on the
//! wire against 1.0.89 (the pin) and 1.0.92, with a stand-in model endpoint so
//! every turn ran one shell command and one file write:
//!
//! - with both fields set, every switch between Ask, Auto and Always approve
//!   takes effect from the next tool call, from a session launched in any of
//!   `--permission-mode default`, `auto` or `bypassPermissions`;
//! - a field left out is left alone, so codeg always sends both;
//! - a permission prompt already open stays open until it is answered;
//! - the choice is not written to `config.toml`, and a new grok process
//!   resuming the session starts in its launch mode again, which is why
//!   codeg re-applies the session's choice on every reconnect.
//!
//! What is re-applied is only a mode the conversation PICKED (in the composer,
//! with `codeg run --mode`, or saved in a task's selection): the Grok settings'
//! permission mode is the default for every session that never picked one, so a
//! session that did not follows those settings when they change, from its next
//! reconnect on. The selector record leaves the mode out until a pick
//! (`SessionState::grok_permission_picked`), and a new session never starts
//! from another chat's pick.
//!
//! The documented route, `_meta.yoloMode` / `_meta.autoMode` on
//! `session/load` and `session/resume`, also works on a running session and on
//! a new process, but it cannot turn Auto off (`autoMode: false` is ignored,
//! and `yoloMode: false` falls back to Auto when Grok was launched with it).
//! codeg puts it on its resume and load requests, so the session comes back in
//! its mode from the first moment, and sends the notification after them.
//!
//! Grok reports one half of the mode back: each entry of its connection-level
//! `_x.ai/sessions/changed` roster carries `yolo` (whether Always approve is
//! on), sent when a turn starts and ends. That is what corrects the selector
//! when the mode moved without codeg (Grok's own `/always-approve` command, or
//! a Grok that came back asking after a restart). Auto is not reported.
//!
//! `--permission-mode acceptEdits`, `plan` and `dontAsk` are accepted at
//! launch but behave like Ask over ACP on both versions (edits and commands
//! both ask; no `current_mode_update` names plan). The selector shows such a
//! launch mode as the session's fixed base, with Auto and Always approve
//! available on top of it.

use crate::acp::types::{
    SessionConfigKindInfo, SessionConfigOptionInfo, SessionConfigSelectInfo,
    SessionConfigSelectOptionInfo,
};

/// The selector's id: the one Claude Code's permission-mode selector uses, so
/// the composer orders and summarizes it the same way.
pub(crate) const GROK_PERMISSION_OPTION_ID: &str = "mode";

/// The notification that switches a running session (what Grok's TUI sends).
pub(crate) const GROK_YOLO_MODE_CHANGED_METHOD: &str = "_x.ai/yolo_mode_changed";

/// Grok's session roster broadcast; names no session at the top level.
pub(crate) const GROK_SESSIONS_CHANGED_METHOD: &str = "_x.ai/sessions/changed";

/// The selector values are Grok's own `--permission-mode` ids.
pub(crate) const ASK: &str = "default";
pub(crate) const AUTO: &str = "auto";
pub(crate) const ALWAYS_APPROVE: &str = "bypassPermissions";

/// How long after codeg switched the mode a roster report is not trusted: the
/// switch and a report Grok built before it can cross on the wire.
pub(crate) const REPORT_GUARD: std::time::Duration = std::time::Duration::from_secs(2);

/// The permission mode a Grok process puts its sessions in: its
/// `--permission-mode`, or Ask when none is passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrokLaunchMode {
    Ask,
    Auto,
    AlwaysApprove,
    /// `acceptEdits`, `plan` or `dontAsk`: accepted at launch, not switchable
    /// to over ACP. Holds the id.
    Fixed(String),
}

impl GrokLaunchMode {
    /// From the value `build_agent` passes as `--permission-mode` (`None` when
    /// it passes none).
    pub(crate) fn from_flag(flag: Option<&str>) -> Self {
        match flag.map(str::trim) {
            Some(AUTO) => Self::Auto,
            Some(ALWAYS_APPROVE) => Self::AlwaysApprove,
            Some(id @ ("acceptEdits" | "plan" | "dontAsk")) => Self::Fixed(id.to_string()),
            _ => Self::Ask,
        }
    }

    /// The row with neither Auto nor Always approve on: Ask, or the fixed
    /// launch mode.
    pub(crate) fn base_value(&self) -> &str {
        match self {
            Self::Fixed(id) => id,
            _ => ASK,
        }
    }

    /// The value a new session starts on.
    pub(crate) fn initial_value(&self) -> &str {
        match self {
            Self::Ask | Self::Fixed(_) => self.base_value(),
            Self::Auto => AUTO,
            Self::AlwaysApprove => ALWAYS_APPROVE,
        }
    }

    /// The selector values, base row first.
    pub(crate) fn values(&self) -> [&str; 3] {
        [self.base_value(), AUTO, ALWAYS_APPROVE]
    }

    pub(crate) fn offers(&self, value: &str) -> bool {
        self.values().contains(&value)
    }

    /// Where Grok lands when Always approve goes off without codeg (its own
    /// `/always-approve off`): the launch mode, or Ask for a session launched
    /// in Always approve. Seen on both versions: launched in Auto it is Auto
    /// again, launched in Always approve it asks.
    fn fallback_from_always_approve(&self) -> &str {
        match self {
            Self::Auto => AUTO,
            _ => self.base_value(),
        }
    }
}

fn row(value: &str, name: &str, description: &str) -> SessionConfigSelectOptionInfo {
    SessionConfigSelectOptionInfo {
        value: value.to_string(),
        name: name.to_string(),
        description: Some(description.to_string()),
    }
}

/// The base row for a launch mode. The frontend relabels these by id in every
/// locale; these English names are what other clients show.
fn base_row(launch: &GrokLaunchMode) -> SessionConfigSelectOptionInfo {
    const FIXED: &str = "Set at launch in Grok settings; fixed for this session";
    match launch {
        GrokLaunchMode::Fixed(id) => {
            let name = match id.as_str() {
                "acceptEdits" => "Auto-approve edits",
                "plan" => "Plan",
                "dontAsk" => "Don't ask",
                other => other,
            };
            row(id, name, FIXED)
        }
        _ => row(ASK, "Ask", "Asks before edits and commands"),
    }
}

/// The composer selector, on `current` (the launch mode's initial value when
/// `current` is not one it offers).
pub(crate) fn permission_option(launch: &GrokLaunchMode, current: &str) -> SessionConfigOptionInfo {
    let current_value = if launch.offers(current) {
        current
    } else {
        launch.initial_value()
    };
    SessionConfigOptionInfo {
        id: GROK_PERMISSION_OPTION_ID.to_string(),
        name: "Mode".to_string(),
        description: Some("Session permission mode".to_string()),
        category: Some("mode".to_string()),
        kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
            current_value: current_value.to_string(),
            options: vec![
                base_row(launch),
                row(
                    AUTO,
                    "Auto",
                    "Grok checks each call and asks only when it is unsure",
                ),
                row(
                    ALWAYS_APPROVE,
                    "Always approve",
                    "Runs every tool call without asking; deny rules still apply",
                ),
            ],
            groups: Vec::new(),
        }),
        recommended_value: None,
    }
}

/// `(yolo_mode, auto_mode)` for a selector value, or `None` for one the launch
/// mode does not offer.
fn flags(launch: &GrokLaunchMode, value: &str) -> Option<(bool, bool)> {
    if value == ALWAYS_APPROVE {
        Some((true, false))
    } else if value == AUTO {
        Some((false, true))
    } else if value == launch.base_value() {
        Some((false, false))
    } else {
        None
    }
}

/// The `_x.ai/yolo_mode_changed` params that put `session_id` in `value`.
pub(crate) fn switch_params(
    launch: &GrokLaunchMode,
    session_id: &str,
    value: &str,
) -> Option<serde_json::Value> {
    let (yolo, auto) = flags(launch, value)?;
    Some(serde_json::json!({
        "sessionId": session_id,
        "yolo_mode": yolo,
        "auto_mode": auto,
    }))
}

/// The `_meta` keys a `session/resume` or `session/load` carries to bring the
/// session back in `value`. Ask carries `yoloMode: false`, which turns a
/// launch-time Always approve off; leaving a launch-time Auto needs the
/// notification sent after the request.
pub(crate) fn establish_meta(
    launch: &GrokLaunchMode,
    value: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let (yolo, auto) = flags(launch, value)?;
    let mut meta = serde_json::Map::new();
    if auto {
        meta.insert("autoMode".to_string(), serde_json::Value::Bool(true));
    } else {
        meta.insert("yoloMode".to_string(), serde_json::Value::Bool(yolo));
    }
    Some(meta)
}

/// Merge [`establish_meta`] into a request's `_meta`.
pub(crate) fn with_establish_meta(
    meta: Option<serde_json::Map<String, serde_json::Value>>,
    launch: &GrokLaunchMode,
    value: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let Some(extra) = establish_meta(launch, value) else {
        return meta;
    };
    let mut meta = meta.unwrap_or_default();
    meta.extend(extra);
    Some(meta)
}

/// Grok's `yolo` flag for `session_id` from an `_x.ai/sessions/changed`
/// broadcast (`{"upserted": [{"sessionId", "yolo", …}], "removed": [..]}`), or
/// `None` when the broadcast does not mention the session or carries no flag.
pub(crate) fn reported_yolo(params: &serde_json::Value, session_id: &str) -> Option<bool> {
    params
        .get("upserted")?
        .as_array()?
        .iter()
        .find(|entry| {
            entry.get("sessionId").and_then(serde_json::Value::as_str) == Some(session_id)
        })?
        .get("yolo")?
        .as_bool()
}

/// The value the selector should move to after Grok reported `yolo`, or `None`
/// when the report agrees with `current` (or arrived too soon after codeg's
/// own switch to be trusted).
pub(crate) fn reconcile_reported_yolo<'a>(
    launch: &'a GrokLaunchMode,
    current: &str,
    yolo: bool,
    since_switch: Option<std::time::Duration>,
) -> Option<&'a str> {
    if since_switch.is_some_and(|elapsed| elapsed < REPORT_GUARD) {
        return None;
    }
    match (yolo, current == ALWAYS_APPROVE) {
        (true, false) => Some(ALWAYS_APPROVE),
        (false, true) => Some(launch.fallback_from_always_approve()),
        _ => None,
    }
}

/// The selector's current value in an options list, if it is there.
pub(crate) fn current_value(opts: &[SessionConfigOptionInfo]) -> Option<&str> {
    opts.iter()
        .find(|o| o.id == GROK_PERMISSION_OPTION_ID)
        .and_then(|o| match &o.kind {
            SessionConfigKindInfo::Select(sel) => Some(sel.current_value.as_str()),
            SessionConfigKindInfo::Boolean(_) => None,
        })
}

/// Put the selector on `value` in an options list. Returns whether it moved.
pub(crate) fn set_current(opts: &mut [SessionConfigOptionInfo], value: &str) -> bool {
    let Some(SessionConfigKindInfo::Select(sel)) = opts
        .iter_mut()
        .find(|o| o.id == GROK_PERMISSION_OPTION_ID)
        .map(|o| &mut o.kind)
    else {
        return false;
    };
    if sel.current_value == value {
        return false;
    }
    sel.current_value = value.to_string();
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn values(opt: &SessionConfigOptionInfo) -> Vec<&str> {
        match &opt.kind {
            SessionConfigKindInfo::Select(sel) => {
                sel.options.iter().map(|o| o.value.as_str()).collect()
            }
            SessionConfigKindInfo::Boolean(_) => Vec::new(),
        }
    }

    #[test]
    fn launch_mode_follows_the_launch_flag() {
        assert_eq!(GrokLaunchMode::from_flag(None), GrokLaunchMode::Ask);
        assert_eq!(
            GrokLaunchMode::from_flag(Some("default")),
            GrokLaunchMode::Ask
        );
        assert_eq!(
            GrokLaunchMode::from_flag(Some("auto")),
            GrokLaunchMode::Auto
        );
        assert_eq!(
            GrokLaunchMode::from_flag(Some("bypassPermissions")),
            GrokLaunchMode::AlwaysApprove
        );
        for fixed in ["acceptEdits", "plan", "dontAsk"] {
            assert_eq!(
                GrokLaunchMode::from_flag(Some(fixed)),
                GrokLaunchMode::Fixed(fixed.to_string())
            );
        }
        // Anything else is not a flag build_agent passes; Grok asks then.
        assert_eq!(GrokLaunchMode::from_flag(Some("yolo")), GrokLaunchMode::Ask);
    }

    #[test]
    fn selector_offers_ask_auto_and_always_approve_on_the_launch_mode() {
        for (flag, initial) in [
            (None, "default"),
            (Some("auto"), "auto"),
            (Some("bypassPermissions"), "bypassPermissions"),
        ] {
            let launch = GrokLaunchMode::from_flag(flag);
            let opt = permission_option(&launch, launch.initial_value());
            assert_eq!(opt.id, "mode");
            assert_eq!(opt.category.as_deref(), Some("mode"));
            assert_eq!(values(&opt), ["default", "auto", "bypassPermissions"]);
            assert_eq!(current_value(std::slice::from_ref(&opt)), Some(initial));
        }
    }

    #[test]
    fn a_fixed_launch_mode_is_the_base_row_and_says_so() {
        let launch = GrokLaunchMode::from_flag(Some("acceptEdits"));
        let opt = permission_option(&launch, launch.initial_value());
        assert_eq!(values(&opt), ["acceptEdits", "auto", "bypassPermissions"]);
        let SessionConfigKindInfo::Select(sel) = &opt.kind else {
            unreachable!()
        };
        assert_eq!(sel.current_value, "acceptEdits");
        assert_eq!(sel.options[0].name, "Auto-approve edits");
        assert!(sel.options[0]
            .description
            .as_deref()
            .unwrap()
            .contains("fixed for this session"));
        // Ask is not offered: the base cannot be left for it in this session.
        assert!(!launch.offers("default"));
        assert!(switch_params(&launch, "s", "default").is_none());
    }

    #[test]
    fn an_unoffered_current_value_falls_back_to_the_launch_value() {
        let launch = GrokLaunchMode::from_flag(Some("plan"));
        let opt = permission_option(&launch, "default");
        assert_eq!(current_value(std::slice::from_ref(&opt)), Some("plan"));
    }

    #[test]
    fn switch_params_carry_both_flags() {
        let launch = GrokLaunchMode::Auto;
        assert_eq!(
            switch_params(&launch, "01a2", "default").unwrap(),
            serde_json::json!({"sessionId": "01a2", "yolo_mode": false, "auto_mode": false})
        );
        assert_eq!(
            switch_params(&launch, "01a2", "auto").unwrap(),
            serde_json::json!({"sessionId": "01a2", "yolo_mode": false, "auto_mode": true})
        );
        assert_eq!(
            switch_params(&launch, "01a2", "bypassPermissions").unwrap(),
            serde_json::json!({"sessionId": "01a2", "yolo_mode": true, "auto_mode": false})
        );
        assert!(switch_params(&launch, "01a2", "plan").is_none());
        // The fixed base row clears both, like Ask.
        assert_eq!(
            switch_params(&GrokLaunchMode::Fixed("plan".into()), "s", "plan").unwrap(),
            serde_json::json!({"sessionId": "s", "yolo_mode": false, "auto_mode": false})
        );
    }

    #[test]
    fn establish_meta_uses_the_documented_session_keys() {
        let launch = GrokLaunchMode::Ask;
        assert_eq!(
            serde_json::Value::Object(establish_meta(&launch, "bypassPermissions").unwrap()),
            serde_json::json!({"yoloMode": true})
        );
        assert_eq!(
            serde_json::Value::Object(establish_meta(&launch, "auto").unwrap()),
            serde_json::json!({"autoMode": true})
        );
        assert_eq!(
            serde_json::Value::Object(establish_meta(&launch, "default").unwrap()),
            serde_json::json!({"yoloMode": false})
        );
        assert!(establish_meta(&launch, "acceptEdits").is_none());
    }

    #[test]
    fn establish_meta_keeps_what_the_request_already_carries() {
        let mut existing = serde_json::Map::new();
        existing.insert("rules".into(), serde_json::json!("x"));
        let merged = with_establish_meta(Some(existing), &GrokLaunchMode::Ask, "auto").unwrap();
        assert_eq!(
            serde_json::Value::Object(merged),
            serde_json::json!({"rules": "x", "autoMode": true})
        );
        assert!(with_establish_meta(None, &GrokLaunchMode::Ask, "nonsense").is_none());
    }

    /// A roster frame as grok 1.0.89 sends it at a turn's start.
    fn roster(session: &str, yolo: bool) -> serde_json::Value {
        serde_json::json!({
            "upserted": [
                {"sessionId": "other", "title": null, "cwd": "/w", "isWorktree": false,
                 "modelId": "grok-4.6", "yolo": !yolo, "activity": "idle", "resident": true,
                 "lastChangeUnixMs": 1795810828000_u64, "origin": {"kind": "local"}},
                {"sessionId": session, "title": null, "cwd": "/w", "isWorktree": false,
                 "modelId": "grok-4.6", "yolo": yolo, "activity": "working", "resident": true,
                 "lastChangeUnixMs": 1795810828663_u64, "origin": {"kind": "local"}}
            ],
            "removed": []
        })
    }

    #[test]
    fn reported_yolo_reads_this_sessions_entry_only() {
        assert_eq!(reported_yolo(&roster("01a2", true), "01a2"), Some(true));
        assert_eq!(reported_yolo(&roster("01a2", false), "01a2"), Some(false));
        assert_eq!(reported_yolo(&roster("01a2", true), "absent"), None);
        assert_eq!(
            reported_yolo(
                &serde_json::json!({"upserted": [], "removed": ["01a2"]}),
                "01a2"
            ),
            None
        );
        assert_eq!(reported_yolo(&serde_json::json!({}), "01a2"), None);
    }

    #[test]
    fn a_report_that_disagrees_moves_the_selector() {
        let late = Some(Duration::from_secs(10));
        // Grok turned Always approve on by itself (its `/always-approve on`).
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "auto", true, late),
            Some("bypassPermissions")
        );
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "default", true, None),
            Some("bypassPermissions")
        );
        // ... or off: back to what the launch mode falls back to.
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "bypassPermissions", false, late),
            Some("default")
        );
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Auto, "bypassPermissions", false, late),
            Some("auto")
        );
        assert_eq!(
            reconcile_reported_yolo(
                &GrokLaunchMode::AlwaysApprove,
                "bypassPermissions",
                false,
                late
            ),
            Some("default")
        );
        assert_eq!(
            reconcile_reported_yolo(
                &GrokLaunchMode::Fixed("acceptEdits".into()),
                "bypassPermissions",
                false,
                late
            ),
            Some("acceptEdits")
        );
    }

    #[test]
    fn a_report_that_agrees_or_crosses_a_switch_changes_nothing() {
        let late = Some(Duration::from_secs(10));
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "bypassPermissions", true, late),
            None
        );
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "default", false, late),
            None
        );
        // Auto is not reported: yolo=false says nothing against it.
        assert_eq!(
            reconcile_reported_yolo(&GrokLaunchMode::Ask, "auto", false, late),
            None
        );
        // Right after codeg's own switch a stale report is ignored.
        assert_eq!(
            reconcile_reported_yolo(
                &GrokLaunchMode::Ask,
                "bypassPermissions",
                false,
                Some(Duration::from_millis(300))
            ),
            None
        );
    }

    #[test]
    fn set_current_reports_a_move() {
        let launch = GrokLaunchMode::Ask;
        let mut opts = vec![permission_option(&launch, "default")];
        assert!(set_current(&mut opts, "auto"));
        assert!(!set_current(&mut opts, "auto"));
        assert_eq!(current_value(&opts), Some("auto"));
        assert!(!set_current(&mut [], "auto"));
    }
}
