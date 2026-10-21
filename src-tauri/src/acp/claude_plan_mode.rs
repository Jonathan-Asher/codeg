//! Claude Code plan mode without permission prompts.
//!
//! codeg runs Claude Code through the Agent SDK, and an SDK session is not an
//! interactive terminal. Two things follow from that:
//!
//! * Plan mode keeps its blocks. A session that was in Bypass before planning
//!   enters plan mode "plain": every shell command outside the built-in
//!   read-only set and every MCP tool raises a permission request. (The
//!   terminal skips those prompts only when bypass is available AND the session
//!   is interactive.) From Auto, the classifier keeps reviewing shell commands
//!   during planning, but MCP tools still prompt.
//! * The plan-approval card's options are sorted by kind, so "Yes, manually
//!   approve edits" (the only allow-once option) comes first. Taking the first
//!   button leaves the session in Manual mode and every later action prompts.
//!
//! No SDK option makes a host session behave like the interactive terminal
//! here, so codeg answers those requests itself (allow once), and reorders the
//! plan card so it leads with the mode the user was in before planning.
//!
//! What is NEVER answered automatically: the plan approval itself, questions,
//! file edits (plan mode's own block covers them), any `rm`/`rmdir`/`unlink`
//! (or `find -delete`) — a superset of the critical-path removals — and
//! anything one of the user's `permissions.ask` rules names.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::types::PermissionOptionInfo;
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

/// `app_metadata` key of [`ClaudePlanSettings`].
pub const CLAUDE_PLAN_SETTINGS_KEY: &str = "claude_plan_mode_settings";

/// The mode id Claude Code uses for plan mode.
pub const PLAN_MODE: &str = "plan";

/// "Don't ask for permission while planning".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlanningPrompts {
    /// Answer the agent's requests while planning when the session was in
    /// Auto or Bypass before it started planning — what the terminal does.
    #[default]
    WhenElevated,
    /// Answer them whatever the mode before planning was.
    Always,
    /// Never: every request shows a card, as before.
    Off,
}

/// "After approving a plan, continue in". Decides which option leads the
/// plan-approval card (the primary button).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AfterPlanMode {
    /// The mode the session was in before it started planning.
    #[default]
    PrePlan,
    Bypass,
    Auto,
    /// Manual: ask before each action.
    Ask,
}

/// Settings → Agents → Claude Code, the plan-mode section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ClaudePlanSettings {
    pub while_planning: PlanningPrompts,
    pub after_approval: AfterPlanMode,
}

/// The live settings. Read on every permission request of a planning Claude
/// session, which has no database handle, so it is cached in-process: seeded
/// at startup by [`apply_persisted_claude_plan_settings`] and replaced on save.
static SETTINGS: RwLock<ClaudePlanSettings> = RwLock::new(ClaudePlanSettings {
    while_planning: PlanningPrompts::WhenElevated,
    after_approval: AfterPlanMode::PrePlan,
});

pub fn current_settings() -> ClaudePlanSettings {
    *SETTINGS.read().unwrap_or_else(|e| e.into_inner())
}

fn store_settings(settings: ClaudePlanSettings) {
    *SETTINGS.write().unwrap_or_else(|e| e.into_inner()) = settings;
}

/// The stored settings. A missing or unreadable row reads as the default.
pub async fn load_claude_plan_settings(conn: &DatabaseConnection) -> ClaudePlanSettings {
    match app_metadata_service::get_value(conn, CLAUDE_PLAN_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[plan-mode] unreadable settings ({e}); using the default");
            ClaudePlanSettings::default()
        }),
        Ok(None) => ClaudePlanSettings::default(),
        Err(e) => {
            tracing::warn!("[plan-mode] failed to load settings ({e}); using the default");
            ClaudePlanSettings::default()
        }
    }
}

/// Writes the row, then the cache: a failed write must not leave the running
/// process obeying a choice the next launch will not remember.
pub async fn save_claude_plan_settings(
    conn: &DatabaseConnection,
    settings: ClaudePlanSettings,
) -> Result<ClaudePlanSettings, AppCommandError> {
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize the plan-mode settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, CLAUDE_PLAN_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    store_settings(settings);
    Ok(settings)
}

/// Seeds the cache at startup, before any session can connect.
pub async fn apply_persisted_claude_plan_settings(conn: &DatabaseConnection) {
    store_settings(load_claude_plan_settings(conn).await);
}

// --- Auto-approval while planning ---

/// Why a request during planning still shows its card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepPrompt {
    NotPlanning,
    SettingOff,
    /// The mode before planning was not Auto or Bypass (or is unknown).
    PrePlanModeNotElevated,
    PlanApproval,
    Question,
    FileEdit,
    Removal,
    AskRule,
    /// The request offers no allow-once option to pick.
    NoAllowOnce,
}

/// The outcome of [`planning_auto_approval`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanningDecision {
    /// Answer with `option_id` (allow once). `tool` is the tool name, for the
    /// log line; it never carries the tool's input.
    Approve {
        option_id: String,
        tool: String,
    },
    Prompt(KeepPrompt),
}

/// The session facts the decision needs.
#[derive(Debug, Clone, Copy)]
pub struct PlanningContext<'a> {
    pub current_mode: Option<&'a str>,
    pub pre_plan_mode: Option<&'a str>,
    pub setting: PlanningPrompts,
}

fn is_elevated(mode: Option<&str>) -> bool {
    matches!(mode, Some("bypassPermissions") | Some("auto"))
}

/// Whether a request is Claude Code's plan approval (ExitPlanMode). Its
/// options all carry `exit-plan-*` ids, and it is presented as a mode switch.
pub fn is_plan_approval(tool_call: &Value, options: &[PermissionOptionInfo]) -> bool {
    options
        .iter()
        .any(|o| o.option_id.starts_with("exit-plan-"))
        || tool_call.get("kind").and_then(Value::as_str) == Some("switch_mode")
        || matches!(
            meta_tool_name(tool_call),
            Some("ExitPlanMode") | Some("EnterPlanMode")
        )
}

fn meta_tool_name(tool_call: &Value) -> Option<&str> {
    tool_call
        .get("_meta")
        .and_then(|m| m.get("claudeCode"))
        .and_then(|c| c.get("toolName"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn raw_input(tool_call: &Value) -> Option<&Value> {
    tool_call
        .get("rawInput")
        .or_else(|| tool_call.get("raw_input"))
}

fn raw_input_str<'a>(tool_call: &'a Value, key: &str) -> Option<&'a str> {
    raw_input(tool_call)
        .and_then(|r| r.get(key))
        .and_then(Value::as_str)
}

/// The shell command of a Bash request.
pub fn shell_command(tool_call: &Value) -> Option<&str> {
    if tool_call.get("kind").and_then(Value::as_str) != Some("execute")
        && meta_tool_name(tool_call) != Some("Bash")
    {
        return None;
    }
    raw_input_str(tool_call, "command")
}

/// The tool a permission request is for. The adapter names MCP and subagent
/// tools in `_meta.claudeCode.toolName`; the rest are recognized by kind and
/// input. `None` when nothing identifies it.
pub fn request_tool_name(tool_call: &Value) -> Option<String> {
    if let Some(name) = meta_tool_name(tool_call) {
        return Some(name.to_string());
    }
    let kind = tool_call.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = match kind {
        "execute" if raw_input_str(tool_call, "command").is_some() => "Bash",
        "edit" => "Edit",
        "fetch" if raw_input_str(tool_call, "url").is_some() => "WebFetch",
        "fetch" if raw_input_str(tool_call, "query").is_some() => "WebSearch",
        "switch_mode" => "ExitPlanMode",
        _ => return None,
    };
    Some(name.to_string())
}

/// Decide whether codeg answers a Claude Code permission request raised while
/// planning. `ask_rules` are the user's `permissions.ask` rules, `None` when
/// they could not be read (then nothing is answered automatically).
pub fn planning_auto_approval(
    ctx: PlanningContext<'_>,
    tool_call: &Value,
    options: &[PermissionOptionInfo],
    ask_rules: Option<&[String]>,
) -> PlanningDecision {
    use PlanningDecision::Prompt;
    if ctx.current_mode != Some(PLAN_MODE) {
        return Prompt(KeepPrompt::NotPlanning);
    }
    match ctx.setting {
        PlanningPrompts::Off => return Prompt(KeepPrompt::SettingOff),
        PlanningPrompts::WhenElevated if !is_elevated(ctx.pre_plan_mode) => {
            return Prompt(KeepPrompt::PrePlanModeNotElevated)
        }
        _ => {}
    }
    if is_plan_approval(tool_call, options) {
        return Prompt(KeepPrompt::PlanApproval);
    }
    let tool = request_tool_name(tool_call);
    let kind = tool_call.get("kind").and_then(Value::as_str).unwrap_or("");
    if is_question(tool.as_deref(), kind) {
        return Prompt(KeepPrompt::Question);
    }
    if is_file_edit(tool.as_deref(), kind) {
        return Prompt(KeepPrompt::FileEdit);
    }
    let command = shell_command(tool_call);
    if command.is_some_and(is_removal) {
        return Prompt(KeepPrompt::Removal);
    }
    let Some(rules) = ask_rules else {
        return Prompt(KeepPrompt::AskRule);
    };
    let ask_rule_applies = match tool.as_deref() {
        Some(name) => rules.iter().any(|r| ask_rule_matches(r, name, command)),
        // Nothing to compare a rule against: any rule at all might be this one.
        None => !rules.is_empty(),
    };
    if ask_rule_applies {
        return Prompt(KeepPrompt::AskRule);
    }
    let Some(allow) = options.iter().find(|o| o.kind == "allow_once") else {
        return Prompt(KeepPrompt::NoAllowOnce);
    };
    PlanningDecision::Approve {
        option_id: allow.option_id.clone(),
        tool: tool.unwrap_or_else(|| {
            if kind.is_empty() {
                "tool".to_string()
            } else {
                kind.to_string()
            }
        }),
    }
}

fn is_question(tool: Option<&str>, kind: &str) -> bool {
    kind == "question"
        || tool.is_some_and(|t| {
            t == "AskUserQuestion" || t.to_ascii_lowercase().contains("ask_user_question")
        })
}

fn is_file_edit(tool: Option<&str>, kind: &str) -> bool {
    matches!(kind, "edit" | "delete" | "move")
        || matches!(
            tool,
            Some("Edit") | Some("Write") | Some("MultiEdit") | Some("NotebookEdit")
        )
}

/// Words of a shell command, split on whitespace and shell separators, with
/// quotes dropped. Coarse on purpose: it only has to find command names.
fn shell_words(command: &str) -> Vec<String> {
    command
        .split(|c: char| c.is_whitespace() || ";&|()`<>{}".contains(c) || c == '$')
        .map(|w| w.trim_matches(|c: char| c == '"' || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether a shell command removes files: any `rm`, `rmdir` or `unlink` word
/// (also behind `sudo`, `xargs`, a path like `/bin/rm`, or quoted), or
/// `find … -delete`. A superset of the critical-path removals Claude Code
/// always asks about, so none of those can slip through.
pub fn is_removal(command: &str) -> bool {
    let words = shell_words(command);
    let names = words
        .iter()
        .map(|w| w.rsplit('/').next().unwrap_or(w.as_str()));
    let mut has_find = false;
    let mut has_delete = false;
    for (name, word) in names.zip(words.iter()) {
        if matches!(name, "rm" | "rmdir" | "unlink") {
            return true;
        }
        has_find |= name == "find";
        has_delete |= word == "-delete";
    }
    has_find && has_delete
}

/// The segments of a shell command (`a && b; c | d` → `a`, `b`, `c`, `d`).
fn shell_segments(command: &str) -> Vec<&str> {
    command
        .split(['\n', ';', '&', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &text[first.len()..];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(i) => rest = &rest[i + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

fn shell_rule_matches(content: &str, command: &str) -> bool {
    let mut candidates = vec![command.trim()];
    candidates.extend(shell_segments(command));
    if let Some(prefix) = content.strip_suffix(":*") {
        let prefix = prefix.trim();
        return candidates
            .iter()
            .any(|c| *c == prefix || c.starts_with(&format!("{prefix} ")));
    }
    if content.contains('*') {
        return candidates.iter().any(|c| wildcard_match(content, c));
    }
    candidates
        .iter()
        .any(|c| *c == content || c.starts_with(&format!("{content} ")))
}

/// Whether a `permissions.ask` rule (`Tool`, `Tool(content)`, `mcp__server`,
/// `mcp__server__tool`, `mcp__server__*`) covers this request. Leans towards
/// "yes": a rule whose content codeg does not evaluate counts as matching
/// whenever it names the tool.
pub fn ask_rule_matches(rule: &str, tool: &str, command: Option<&str>) -> bool {
    let rule = rule.trim();
    let (name, content) = match rule.find('(') {
        Some(open) if rule.ends_with(')') => (
            rule[..open].trim(),
            Some(rule[open + 1..rule.len() - 1].trim()),
        ),
        _ => (rule, None),
    };
    let names_tool = name == tool
        || (tool.starts_with("mcp__")
            && (tool.starts_with(&format!("{name}__"))
                || name
                    .strip_suffix('*')
                    .is_some_and(|prefix| tool.starts_with(prefix))));
    if !names_tool {
        return false;
    }
    match content {
        None | Some("") | Some("*") => true,
        Some(content) => match (tool, command) {
            ("Bash", Some(command)) => shell_rule_matches(content, command),
            _ => true,
        },
    }
}

/// The settings files whose `permissions.ask` rules apply to a session in
/// `cwd`: managed, user, project and local.
fn settings_files(cwd: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if cfg!(target_os = "macos") {
        files.push(PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        ));
    } else if cfg!(target_os = "linux") {
        files.push(PathBuf::from("/etc/claude-code/managed-settings.json"));
    }
    files.push(crate::parsers::claude::resolve_claude_config_dir().join("settings.json"));
    files.push(cwd.join(".claude").join("settings.json"));
    files.push(cwd.join(".claude").join("settings.local.json"));
    files
}

/// Every `permissions.ask` rule in `files`. `None` when a file exists but
/// cannot be read as JSON: its rules are unknown, so none may be assumed away.
pub fn read_ask_rules(files: &[PathBuf]) -> Option<Vec<String>> {
    let mut rules = Vec::new();
    for file in files {
        let raw = match std::fs::read_to_string(file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        let json: Value = serde_json::from_str(&raw).ok()?;
        if let Some(ask) = json
            .get("permissions")
            .and_then(|p| p.get("ask"))
            .and_then(Value::as_array)
        {
            rules.extend(ask.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }
    Some(rules)
}

/// The `permissions.ask` rules that apply to a session in `cwd`.
pub fn ask_rules_for(cwd: &Path) -> Option<Vec<String>> {
    read_ask_rules(&settings_files(cwd))
}

// --- The plan-approval card ---

/// The option that should lead the plan-approval card. `None` leaves the
/// adapter's order alone.
pub fn preferred_plan_exit_option(
    pre_plan_mode: Option<&str>,
    after: AfterPlanMode,
) -> Option<&'static str> {
    match after {
        AfterPlanMode::Bypass => Some("exit-plan-bypass"),
        AfterPlanMode::Auto => Some("exit-plan-auto"),
        AfterPlanMode::Ask => Some("exit-plan-default"),
        AfterPlanMode::PrePlan => match pre_plan_mode {
            Some("bypassPermissions") => Some("exit-plan-bypass"),
            Some("auto") => Some("exit-plan-auto"),
            Some("acceptEdits") => Some("exit-plan-accept-edits"),
            Some("default") => Some("exit-plan-default"),
            _ => None,
        },
    }
}

/// Put the option for the mode to continue in first, so it is the card's
/// primary button. The adapter sorts its options by kind, which puts "Yes,
/// manually approve edits" (the only allow-once option) first; when codeg
/// does not know the mode before planning it leads with the adapter's own
/// preference instead — its first "keep context" elevated option.
pub fn order_plan_approval_options(
    options: &mut Vec<PermissionOptionInfo>,
    pre_plan_mode: Option<&str>,
    after: AfterPlanMode,
) {
    let wanted = preferred_plan_exit_option(pre_plan_mode, after);
    let index = wanted
        .and_then(|id| options.iter().position(|o| o.option_id == id))
        .or_else(|| {
            options.iter().position(|o| {
                matches!(
                    o.option_id.as_str(),
                    "exit-plan-bypass" | "exit-plan-auto" | "exit-plan-accept-edits"
                )
            })
        });
    if let Some(index) = index {
        let lead = options.remove(index);
        options.insert(0, lead);
    }
}

/// The mode before planning, tracked across a mode change to `next`.
pub fn next_pre_plan_mode(
    current: Option<&str>,
    pre_plan: Option<&str>,
    next: &str,
) -> Option<String> {
    if next != PLAN_MODE {
        None
    } else if current == Some(PLAN_MODE) {
        pre_plan.map(str::to_string)
    } else {
        current.map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opt(id: &str, kind: &str) -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            meta: None,
        }
    }

    fn yes_no() -> Vec<PermissionOptionInfo> {
        vec![
            opt("allow-once", "allow_once"),
            opt("reject", "reject_once"),
        ]
    }

    fn plan_card() -> Vec<PermissionOptionInfo> {
        vec![
            opt("exit-plan-default", "allow_once"),
            opt("exit-plan-clear-bypass", "allow_always"),
            opt("exit-plan-bypass", "allow_always"),
            opt("exit-plan-auto", "allow_always"),
            opt("reject", "reject_once"),
        ]
    }

    fn bash(command: &str) -> Value {
        json!({"toolCallId": "t1", "title": command, "kind": "execute", "rawInput": {"command": command}})
    }

    fn mcp(name: &str) -> Value {
        json!({"toolCallId": "t2", "title": name, "kind": "other", "rawInput": {"key": "a"},
               "_meta": {"claudeCode": {"toolName": name, "mcpServer": {"name": "probe", "source": "dynamic"}}}})
    }

    fn planning(pre: Option<&'static str>) -> PlanningContext<'static> {
        PlanningContext {
            current_mode: Some("plan"),
            pre_plan_mode: pre,
            setting: PlanningPrompts::WhenElevated,
        }
    }

    fn approve(id: &str, tool: &str) -> PlanningDecision {
        PlanningDecision::Approve {
            option_id: id.to_string(),
            tool: tool.to_string(),
        }
    }

    const NO_RULES: Option<&[String]> = Some(&[]);

    #[test]
    fn shell_and_mcp_requests_are_approved_while_planning_after_bypass_or_auto() {
        for pre in ["bypassPermissions", "auto"] {
            assert_eq!(
                planning_auto_approval(
                    planning(Some(pre)),
                    &bash("python3 -c 'print(42)'"),
                    &yes_no(),
                    NO_RULES
                ),
                approve("allow-once", "Bash")
            );
            assert_eq!(
                planning_auto_approval(
                    planning(Some(pre)),
                    &mcp("mcp__probe__lookup_note"),
                    &yes_no(),
                    NO_RULES
                ),
                approve("allow-once", "mcp__probe__lookup_note")
            );
        }
    }

    #[test]
    fn the_allow_once_option_is_picked_never_an_always_rule() {
        let options = vec![
            opt("allow-with-updates", "allow_always"),
            opt("allow-once", "allow_once"),
            opt("reject", "reject_once"),
        ];
        assert_eq!(
            planning_auto_approval(planning(Some("auto")), &bash("ls -la"), &options, NO_RULES),
            approve("allow-once", "Bash")
        );
        let only_always = vec![
            opt("allow-with-updates", "allow_always"),
            opt("reject", "reject_once"),
        ];
        assert_eq!(
            planning_auto_approval(planning(Some("auto")), &bash("ls"), &only_always, NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::NoAllowOnce)
        );
    }

    #[test]
    fn outside_plan_mode_nothing_is_approved() {
        let ctx = PlanningContext {
            current_mode: Some("default"),
            pre_plan_mode: None,
            setting: PlanningPrompts::Always,
        };
        assert_eq!(
            planning_auto_approval(ctx, &bash("ls"), &yes_no(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::NotPlanning)
        );
    }

    #[test]
    fn the_pre_plan_mode_decides_under_the_default_setting() {
        for pre in [Some("default"), Some("acceptEdits"), Some("dontAsk"), None] {
            assert_eq!(
                planning_auto_approval(planning(pre), &bash("ls"), &yes_no(), NO_RULES),
                PlanningDecision::Prompt(KeepPrompt::PrePlanModeNotElevated),
                "{pre:?}"
            );
        }
        let always = PlanningContext {
            setting: PlanningPrompts::Always,
            ..planning(Some("default"))
        };
        assert_eq!(
            planning_auto_approval(always, &bash("ls"), &yes_no(), NO_RULES),
            approve("allow-once", "Bash")
        );
    }

    #[test]
    fn the_setting_off_brings_every_prompt_back() {
        let off = PlanningContext {
            setting: PlanningPrompts::Off,
            ..planning(Some("bypassPermissions"))
        };
        assert_eq!(
            planning_auto_approval(off, &bash("ls"), &yes_no(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::SettingOff)
        );
        assert_eq!(
            planning_auto_approval(off, &mcp("mcp__probe__lookup_note"), &yes_no(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::SettingOff)
        );
    }

    #[test]
    fn the_plan_approval_is_never_approved() {
        let exit = json!({"toolCallId": "t3", "title": "Approve Plan", "kind": "switch_mode",
                          "rawInput": {"plan": "Test plan."}});
        let always = PlanningContext {
            setting: PlanningPrompts::Always,
            ..planning(Some("bypassPermissions"))
        };
        assert_eq!(
            planning_auto_approval(always, &exit, &plan_card(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::PlanApproval)
        );
        // Even if the kind were missing, the exit-plan option ids give it away.
        let bare = json!({"toolCallId": "t3", "title": "Approve Plan"});
        assert_eq!(
            planning_auto_approval(always, &bare, &plan_card(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::PlanApproval)
        );
    }

    #[test]
    fn questions_are_never_approved() {
        let ask = json!({"toolCallId": "t4", "title": "Question", "kind": "other",
                         "_meta": {"claudeCode": {"toolName": "AskUserQuestion"}}});
        assert_eq!(
            planning_auto_approval(planning(Some("auto")), &ask, &yes_no(), NO_RULES),
            PlanningDecision::Prompt(KeepPrompt::Question)
        );
        assert_eq!(
            planning_auto_approval(
                planning(Some("auto")),
                &mcp("mcp__codeg__ask_user_question"),
                &yes_no(),
                NO_RULES
            ),
            PlanningDecision::Prompt(KeepPrompt::Question)
        );
    }

    #[test]
    fn file_edits_are_left_to_plan_modes_own_block() {
        let edit = json!({"toolCallId": "t5", "title": "Edit a.rs", "kind": "edit",
                          "rawInput": {"file_path": "/x/a.rs", "old_string": "a", "new_string": "b"}});
        let write = json!({"toolCallId": "t6", "title": "Write", "kind": "other",
                           "_meta": {"claudeCode": {"toolName": "Write"}}});
        for call in [edit, write] {
            assert_eq!(
                planning_auto_approval(
                    planning(Some("bypassPermissions")),
                    &call,
                    &yes_no(),
                    NO_RULES
                ),
                PlanningDecision::Prompt(KeepPrompt::FileEdit)
            );
        }
    }

    #[test]
    fn removals_are_never_approved() {
        for command in [
            "rm -rf /",
            "rm -rf ~",
            "cd /tmp && rm x",
            "sudo rm -r /etc",
            "/bin/rm file",
            "ls | xargs rm",
            "rmdir build",
            "unlink a",
            "find . -name '*.o' -delete",
            "echo hi; \"rm\" -rf $HOME",
        ] {
            assert_eq!(
                planning_auto_approval(
                    planning(Some("bypassPermissions")),
                    &bash(command),
                    &yes_no(),
                    NO_RULES
                ),
                PlanningDecision::Prompt(KeepPrompt::Removal),
                "{command}"
            );
        }
        for command in [
            "git rm --cached -n x",
            "npm run format",
            "grep -r rmx .",
            "find . -name x",
        ] {
            let decision = planning_auto_approval(
                planning(Some("bypassPermissions")),
                &bash(command),
                &yes_no(),
                NO_RULES,
            );
            if command.starts_with("git rm") {
                // Conservative: the word `rm` is enough.
                assert_eq!(decision, PlanningDecision::Prompt(KeepPrompt::Removal));
            } else {
                assert_eq!(decision, approve("allow-once", "Bash"), "{command}");
            }
        }
    }

    #[test]
    fn explicit_ask_rules_keep_their_prompt() {
        let rules = |r: &[&str]| r.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let cases: &[(&[&str], Value, bool)] = &[
            (&["Bash(git push:*)"], bash("git push origin main"), true),
            (&["Bash(git push:*)"], bash("cd x && git push"), true),
            (&["Bash(git push:*)"], bash("git status"), false),
            (&["Bash(curl *)"], bash("curl -s https://x"), true),
            (&["Bash"], bash("ls"), true),
            (&["Bash(npm test)"], bash("npm test"), true),
            (&["mcp__probe"], mcp("mcp__probe__lookup_note"), true),
            (&["mcp__probe__*"], mcp("mcp__probe__lookup_note"), true),
            (
                &["mcp__probe__lookup_note"],
                mcp("mcp__probe__lookup_note"),
                true,
            ),
            (&["mcp__other"], mcp("mcp__probe__lookup_note"), false),
            (&["WebFetch(domain:example.com)"], bash("ls"), false),
        ];
        for (r, call, prompts) in cases {
            let r = rules(r);
            let decision =
                planning_auto_approval(planning(Some("auto")), call, &yes_no(), Some(r.as_slice()));
            assert_eq!(
                decision == PlanningDecision::Prompt(KeepPrompt::AskRule),
                *prompts,
                "{r:?} {call}"
            );
        }
        // Unreadable settings: their rules are unknown, so nothing is approved.
        assert_eq!(
            planning_auto_approval(planning(Some("auto")), &bash("ls"), &yes_no(), None),
            PlanningDecision::Prompt(KeepPrompt::AskRule)
        );
    }

    #[test]
    fn ask_rules_are_read_from_every_settings_file() {
        let dir = std::env::temp_dir().join(format!("codeg-plan-rules-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        std::fs::write(
            &a,
            r#"{"permissions":{"ask":["Bash(git push:*)"],"allow":["Read"]}}"#,
        )
        .unwrap();
        std::fs::write(&b, r#"{"permissions":{"ask":["mcp__probe"]}}"#).unwrap();
        let missing = dir.join("missing.json");
        assert_eq!(
            read_ask_rules(&[a.clone(), missing, b.clone()]),
            Some(vec![
                "Bash(git push:*)".to_string(),
                "mcp__probe".to_string()
            ])
        );
        std::fs::write(&b, "{ not json").unwrap();
        assert_eq!(read_ask_rules(&[a, b]), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_plan_card_leads_with_the_mode_before_planning() {
        let ids =
            |o: &[PermissionOptionInfo]| o.iter().map(|o| o.option_id.clone()).collect::<Vec<_>>();
        let mut options = plan_card();
        order_plan_approval_options(
            &mut options,
            Some("bypassPermissions"),
            AfterPlanMode::PrePlan,
        );
        assert_eq!(
            ids(&options),
            [
                "exit-plan-bypass",
                "exit-plan-default",
                "exit-plan-clear-bypass",
                "exit-plan-auto",
                "reject"
            ]
        );
        let mut options = plan_card();
        order_plan_approval_options(&mut options, Some("auto"), AfterPlanMode::PrePlan);
        assert_eq!(ids(&options)[0], "exit-plan-auto");
        let mut options = plan_card();
        order_plan_approval_options(&mut options, Some("default"), AfterPlanMode::PrePlan);
        assert_eq!(ids(&options), ids(&plan_card()));
    }

    #[test]
    fn the_after_approval_setting_overrides_the_pre_plan_mode() {
        let mut options = plan_card();
        order_plan_approval_options(&mut options, Some("bypassPermissions"), AfterPlanMode::Auto);
        assert_eq!(options[0].option_id, "exit-plan-auto");
        let mut options = plan_card();
        order_plan_approval_options(&mut options, Some("auto"), AfterPlanMode::Bypass);
        assert_eq!(options[0].option_id, "exit-plan-bypass");
        let mut options = plan_card();
        order_plan_approval_options(&mut options, Some("bypassPermissions"), AfterPlanMode::Ask);
        assert_eq!(options[0].option_id, "exit-plan-default");
    }

    #[test]
    fn an_unknown_pre_plan_mode_leads_with_the_adapters_elevated_choice() {
        let mut options = plan_card();
        order_plan_approval_options(&mut options, None, AfterPlanMode::PrePlan);
        assert_eq!(options[0].option_id, "exit-plan-bypass");
        // A missing preferred option falls back the same way.
        let mut options: Vec<_> = plan_card()
            .into_iter()
            .filter(|o| o.option_id != "exit-plan-auto")
            .collect();
        order_plan_approval_options(&mut options, Some("auto"), AfterPlanMode::PrePlan);
        assert_eq!(options[0].option_id, "exit-plan-bypass");
    }

    #[test]
    fn the_pre_plan_mode_is_the_mode_planning_started_from() {
        assert_eq!(
            next_pre_plan_mode(Some("auto"), None, "plan").as_deref(),
            Some("auto")
        );
        // Re-announcing plan mode keeps what it started from.
        assert_eq!(
            next_pre_plan_mode(Some("plan"), Some("bypassPermissions"), "plan").as_deref(),
            Some("bypassPermissions")
        );
        assert_eq!(
            next_pre_plan_mode(Some("plan"), Some("auto"), "bypassPermissions"),
            None
        );
        assert_eq!(next_pre_plan_mode(None, None, "plan"), None);
    }

    #[test]
    fn settings_default_to_the_terminals_behaviour_and_round_trip() {
        let d = ClaudePlanSettings::default();
        assert_eq!(d.while_planning, PlanningPrompts::WhenElevated);
        assert_eq!(d.after_approval, AfterPlanMode::PrePlan);
        let s = ClaudePlanSettings {
            while_planning: PlanningPrompts::Off,
            after_approval: AfterPlanMode::Ask,
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert_eq!(raw, r#"{"while_planning":"off","after_approval":"ask"}"#);
        assert_eq!(serde_json::from_str::<ClaudePlanSettings>(&raw).unwrap(), s);
        assert_eq!(serde_json::from_str::<ClaudePlanSettings>("{}").unwrap(), d);
    }
}
