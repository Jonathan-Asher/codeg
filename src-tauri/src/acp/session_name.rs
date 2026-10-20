//! The display name a Claude Code session runs under.
//!
//! Claude Code names every session it runs. Without a name of its own a session
//! gets a derived one (`<cwd basename>-<hex>`, e.g. `codeg-1e`), and that is
//! the name cross-session messaging lists it by — not the title codeg shows.
//! The CLI's `-n, --name <name>` sets the display name the same way `/rename`
//! does: the session's title, the prompt box, and its name in the session
//! registry other sessions read.
//!
//! codeg passes the conversation's own title there. The adapter forwards
//! `_meta.claudeCode.options.extraArgs` to the SDK, which turns `{name}` into
//! `--name`. The adapter has no request for renaming a live session, so the
//! name is applied whenever codeg opens the session (`session/new`, `load`,
//! `resume`); a rename in codeg reaches the CLI on the next connect. The
//! adapter keys warm-session reuse on these options, so a changed name
//! restarts that session's process at the next connect, and an unchanged one
//! keeps it.
//!
//! Like [`SessionPersistence`](crate::acp::session_persistence), the name rides
//! the per-launch `runtime_env`: the connect command stamps it from the
//! conversation row bound to the session being opened, `spawn_agent_connection`
//! reads it back, and `run_connection` adds it to the Claude requests.

use std::collections::BTreeMap;

use agent_client_protocol::schema::v1::Meta;

/// Per-launch `runtime_env` key holding the sanitized session name.
pub(crate) const SESSION_NAME_ENV: &str = "CODEG_SESSION_NAME";

/// Longest name passed on, in characters. The CLI keeps up to 200; a name is
/// read in one-line session lists, so a long first-prompt title is cut well
/// before that.
const MAX_SESSION_NAME_CHARS: usize = 100;

/// A conversation title made fit to be a CLI session name, or `None` when
/// nothing usable is left.
///
/// - `[label](uri)` reference links fold to their label, as the sidebar shows
///   the title.
/// - Control and format characters (newlines, tabs, zero-width and bidi marks)
///   become spaces. The CLI drops them anyway, and they would otherwise glue
///   words together.
/// - Whitespace runs collapse to one space and the ends are trimmed.
/// - The result is cut to [`MAX_SESSION_NAME_CHARS`] characters on a character
///   boundary, then trimmed again.
pub fn sanitize_session_name(title: &str) -> Option<String> {
    let folded = crate::parsers::fold_reference_links(title);
    let spaced: String = folded
        .chars()
        .map(|c| {
            if c.is_control() || is_format_char(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = collapsed.chars().take(MAX_SESSION_NAME_CHARS).collect();
    let name = cut.trim_end();
    (!name.is_empty()).then(|| name.to_string())
}

/// Unicode "format" characters (category Cf) that show up in pasted titles:
/// zero-width spaces and joiners, bidi marks and isolates, the BOM, the soft
/// hyphen. The CLI strips Cf as well.
fn is_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// Stamp `title` (sanitized) as this launch's session name. A title with
/// nothing usable in it stamps nothing.
pub fn stamp(runtime_env: &mut BTreeMap<String, String>, title: &str) {
    if let Some(name) = sanitize_session_name(title) {
        runtime_env.insert(SESSION_NAME_ENV.to_string(), name);
    }
}

/// Read the name back. Deliberately not falling back to codeg's own process
/// env: a stray variable must never name every session the same.
pub fn from_env(runtime_env: &BTreeMap<String, String>) -> Option<String> {
    runtime_env
        .get(SESSION_NAME_ENV)
        .map(String::as_str)
        .and_then(sanitize_session_name)
}

/// Add `name` to a Claude Code request's `_meta` as
/// `claudeCode.options.extraArgs.name`, keeping every option and extra arg
/// already there. Meta without a `claudeCode` object (any other agent) and a
/// missing name leave the meta untouched.
pub fn apply_to_claude_meta(meta: Option<Meta>, name: Option<&str>) -> Option<Meta> {
    let mut meta = meta?;
    let Some(name) = name else {
        return Some(meta);
    };
    if let Some(serde_json::Value::Object(claude_code)) = meta.get_mut("claudeCode") {
        let extra_args = claude_code
            .entry("options")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            .as_object_mut()
            .map(|options| {
                options
                    .entry("extraArgs")
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            })
            .and_then(serde_json::Value::as_object_mut);
        if let Some(extra_args) = extra_args {
            extra_args.insert(
                "name".to_string(),
                serde_json::Value::String(name.to_string()),
            );
        }
    }
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_titles_pass_through() {
        assert_eq!(
            sanitize_session_name("Codeg-refactor-cc").as_deref(),
            Some("Codeg-refactor-cc")
        );
        assert_eq!(
            sanitize_session_name("[Fork-2] Fix the auth flow").as_deref(),
            Some("[Fork-2] Fix the auth flow")
        );
        assert_eq!(
            sanitize_session_name("תיקון באג בהתחברות").as_deref(),
            Some("תיקון באג בהתחברות")
        );
    }

    #[test]
    fn whitespace_and_control_characters_collapse() {
        assert_eq!(
            sanitize_session_name("  Fix\nthe\t\tbuild \u{200B}now\u{202E}  ").as_deref(),
            Some("Fix the build now")
        );
        assert_eq!(sanitize_session_name(" \n\t\u{200B} "), None);
        assert_eq!(sanitize_session_name(""), None);
    }

    #[test]
    fn reference_links_fold_to_their_label() {
        assert_eq!(
            sanitize_session_name("Look at [README.md](file:///work/README.md) first").as_deref(),
            Some("Look at README.md first")
        );
    }

    #[test]
    fn long_titles_are_cut_on_a_character_boundary() {
        let long = "é".repeat(150);
        let name = sanitize_session_name(&long).unwrap();
        assert_eq!(name.chars().count(), MAX_SESSION_NAME_CHARS);

        let words = format!("{} tail", "a".repeat(MAX_SESSION_NAME_CHARS - 1));
        let name = sanitize_session_name(&words).unwrap();
        assert!(!name.ends_with(' '), "a cut never leaves a trailing space");
    }

    #[test]
    fn stamp_round_trips_and_skips_empty_titles() {
        let mut env = BTreeMap::new();
        stamp(&mut env, "   ");
        assert!(env.is_empty());
        stamp(&mut env, " Release\nprep ");
        assert_eq!(from_env(&env).as_deref(), Some("Release prep"));
        assert_eq!(from_env(&BTreeMap::new()), None);
    }

    fn claude_meta(options: Option<serde_json::Value>) -> Meta {
        let mut claude_code = serde_json::Map::new();
        claude_code.insert("emitRawSDKMessages".into(), json!(true));
        if let Some(options) = options {
            claude_code.insert("options".into(), options);
        }
        let mut meta = Meta::new();
        meta.insert("claudeCode".into(), serde_json::Value::Object(claude_code));
        meta
    }

    #[test]
    fn name_lands_in_claude_extra_args() {
        let meta = apply_to_claude_meta(Some(claude_meta(None)), Some("Release prep")).unwrap();
        assert_eq!(
            serde_json::Value::Object(meta),
            json!({
                "claudeCode": {
                    "emitRawSDKMessages": true,
                    "options": { "extraArgs": { "name": "Release prep" } }
                }
            })
        );
    }

    #[test]
    fn existing_options_and_extra_args_are_kept() {
        let meta = apply_to_claude_meta(
            Some(claude_meta(Some(json!({
                "persistSession": false,
                "extraArgs": { "debug": null }
            })))),
            Some("Release prep"),
        )
        .unwrap();
        assert_eq!(
            meta["claudeCode"]["options"],
            json!({
                "persistSession": false,
                "extraArgs": { "debug": null, "name": "Release prep" }
            })
        );
    }

    #[test]
    fn other_agents_and_missing_names_are_untouched() {
        assert_eq!(apply_to_claude_meta(None, Some("Release prep")), None);
        let other = {
            let mut meta = Meta::new();
            meta.insert("codex".into(), json!({}));
            meta
        };
        assert_eq!(
            apply_to_claude_meta(Some(other.clone()), Some("Release prep")),
            Some(other)
        );
        let claude = claude_meta(None);
        assert_eq!(
            apply_to_claude_meta(Some(claude.clone()), None),
            Some(claude)
        );
    }
}
