//! Startup check for a codeg started from inside one of its own sessions.
//!
//! However codeg is started — Finder, a shell script, an agent's bash tool —
//! it inherits the environment of whatever started it, and macOS `open` passes
//! the caller's environment through as well. When that caller is one of
//! codeg's own agent processes (or integrated terminals), the environment is
//! the one codeg built for THAT child: a per-launch scratch `TMPDIR`, codeg's
//! git credential helper, launch flags meant for one agent, and the identity
//! of the agent session itself. None of it describes the new process, and some
//! of it does real damage:
//!
//! * The scratch `TMPDIR` belongs to the parent. Its owner deletes it when the
//!   agent exits, and the startup sweep deletes it once that owner is dead —
//!   which took the new codeg's delegation socket with it, half a second after
//!   the bind, and failed every companion call from then on. It was also
//!   handed to every new agent as a writable root.
//! * Everything else rides along into every agent the new codeg launches:
//!   another session's id and messaging socket, a forced colour mode, one
//!   agent's launch flags.
//!
//! [`sanitize`] runs first thing in both runtimes, while the process is still
//! single-threaded, and undoes it. The temp variables go back to the system
//! temp dir; the variables codeg itself injects into a child are removed.
//! Nothing happens unless the environment carries a mark only codeg puts
//! there, so an ordinary launch is never touched.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::acp::scratch_dir::{is_in_scratch_namespace, TEMP_ENV_KEYS};

/// Which binary is starting. Decides whether `CODEG_DATA_DIR` is codeg's own
/// hand-me-down or the operator's configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    Desktop,
    Server,
}

/// What [`sanitize`] changed, for the one log line it is reported in. Names
/// only: values can carry tokens and are never kept.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Sanitized {
    /// Why the launch was recognised as coming from inside a codeg session.
    pub signals: Vec<&'static str>,
    /// Temp variables pointed back at the system temp dir.
    pub reset: Vec<String>,
    /// Variables removed.
    pub removed: Vec<String>,
}

impl Sanitized {
    /// Report what was done: one INFO line, variable names only.
    pub fn log(&self) {
        tracing::info!(
            "[startup] launched from inside a codeg session ({}); reset to the system temp \
             dir: {}; removed: {}",
            self.signals.join(", "),
            list_or_none(&self.reset),
            list_or_none(&self.removed),
        );
    }
}

fn list_or_none(names: &[String]) -> String {
    if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    }
}

const SIGNAL_SCRATCH_TEMP: &str = "temp dir inside codeg's agent scratch space";
const SIGNAL_CREDENTIAL_HELPER: &str = "codeg's git credential helper";

/// The `GIT_CONFIG_*` triple codeg sets to put its credential helper first
/// (`commands::terminal::prepare_credential_env`), in every agent launch and
/// every integrated terminal.
const GIT_CONFIG_TRIPLE: [&str; 3] = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

/// Variables the agent CLI exports to its own tool subprocesses to name the
/// session they belong to: the session and its process, the socket and token
/// to reach it, and the flags that mark a process as running inside it. Taken
/// from the environment of a codeg that an agent's bash tool started. Every one
/// of them names the PARENT session — a process id that is
/// not ours, a socket that dies with it — and passing them on would tell every
/// agent this codeg starts that it belongs to that session.
const PARENT_SESSION_MARKERS: &[&str] = &[
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

/// The same agent CLI sets `GIT_EDITOR=true` for its tool subprocesses, so a
/// `git commit` there never waits on an editor. Inherited, it would reach every
/// integrated terminal this codeg opens, where a `git commit` then aborts for an
/// empty message instead of opening the user's editor. Only that exact value is
/// removed; any other `GIT_EDITOR` is somebody's choice of editor.
const AGENT_GIT_EDITOR: (&str, &str) = ("GIT_EDITOR", "true");

/// Every variable codeg itself puts into a child's environment, other than the
/// temp variables and the credential-helper triple (which are matched by value).
/// Assembled from the constants the launch path uses, so it follows them:
///
/// * `merge_agent_env`: the colour defaults, set when colourised command output
///   is on;
/// * the static `env` of every built-in agent in the registry;
/// * the codex launch policy and its debug log directory;
/// * the per-launch `runtime_env` markers: private sessions and OpenClaw's
///   fresh-session flag.
///
/// Per-agent settings rows and model-provider credentials are injected too, but
/// they live in the database and are not knowable this early; proxy variables
/// and `PATH` are left alone because codeg recomputes both for every launch.
fn injected_keys() -> Vec<&'static str> {
    use crate::acp::connection::{
        CODEX_APP_SERVER_LOGS_ENV, CODEX_INITIAL_MODE_ENV, CODEX_MCP_FILTERING_ENV,
        DEFAULT_COMMAND_COLOR_ENV,
    };
    use crate::acp::registry::{builtin_acp_agents, get_agent_meta, AgentDistribution};

    let mut keys: Vec<&'static str> = DEFAULT_COMMAND_COLOR_ENV.iter().map(|(k, _)| *k).collect();
    for agent in builtin_acp_agents() {
        let env = match get_agent_meta(agent).distribution {
            AgentDistribution::Npx { env, .. }
            | AgentDistribution::Binary { env, .. }
            | AgentDistribution::Uvx { env, .. } => env,
        };
        keys.extend(env.iter().map(|(k, _)| *k));
    }
    keys.extend([
        CODEX_MCP_FILTERING_ENV,
        CODEX_INITIAL_MODE_ENV,
        CODEX_APP_SERVER_LOGS_ENV,
        crate::acp::session_persistence::SESSION_PERSISTENCE_ENV,
        crate::commands::acp::OPENCLAW_RESET_SESSION_ENV,
    ]);
    keys
}

/// The process environment as a map, keys that are not UTF-8 left out (none of
/// the variables this module handles are spelled that way).
type Env = BTreeMap<String, OsString>;

/// Look `key` up the way the platform does: exactly on Unix, ignoring ASCII
/// case on Windows, where `Tmp` and `TMP` are the same variable. Returns the
/// spelling actually present, which is the one to remove.
fn find<'a>(env: &'a Env, key: &str) -> Option<(&'a String, &'a OsString)> {
    if cfg!(windows) {
        env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key))
    } else {
        env.get_key_value(key)
    }
}

/// Whether the credential-helper triple is codeg's own: one entry, naming the
/// helper script codeg writes. Any other shape is left alone — it is not what
/// codeg sets, and renumbering someone else's `GIT_CONFIG_*` list is not ours to
/// do.
fn carries_codeg_credential_helper(env: &Env) -> bool {
    let text = |key: &str| find(env, key).map(|(_, v)| v.to_string_lossy().into_owned());
    text("GIT_CONFIG_COUNT").as_deref().map(str::trim) == Some("1")
        && text("GIT_CONFIG_KEY_0").as_deref().map(str::trim) == Some("credential.helper")
        && text("GIT_CONFIG_VALUE_0")
            .is_some_and(|v| v.contains(crate::git_credential::CREDENTIAL_HELPER_SCRIPT_STEM))
}

/// What to change, decided from an environment without touching the real one.
#[derive(Debug, Default, PartialEq, Eq)]
struct Plan {
    signals: Vec<&'static str>,
    /// Temp variables and their new value; `None` removes the variable, for a
    /// platform where no system temp dir could be determined.
    temp: Vec<(String, Option<PathBuf>)>,
    remove: Vec<String>,
}

impl Plan {
    fn report(&self) -> Sanitized {
        let mut report = Sanitized {
            signals: self.signals.clone(),
            ..Sanitized::default()
        };
        for (key, value) in &self.temp {
            if value.is_some() {
                report.reset.push(key.clone());
            } else {
                report.removed.push(key.clone());
            }
        }
        report.removed.extend(self.remove.iter().cloned());
        report
    }
}

/// Decide what [`sanitize`] would change in `env`, or `None` when the launch did
/// not come from inside a codeg session. Pure, so it can be tested against any
/// environment.
fn plan(env: &Env, runtime: Runtime, system_temp: Option<&Path>) -> Option<Plan> {
    let scratch_temp: Vec<String> = TEMP_ENV_KEYS
        .iter()
        .filter_map(|key| find(env, key))
        .filter(|(_, value)| !value.is_empty() && is_in_scratch_namespace(Path::new(value)))
        .map(|(key, _)| key.clone())
        .collect();
    let credential_helper = carries_codeg_credential_helper(env);

    let mut plan = Plan::default();
    if !scratch_temp.is_empty() {
        plan.signals.push(SIGNAL_SCRATCH_TEMP);
    }
    if credential_helper {
        plan.signals.push(SIGNAL_CREDENTIAL_HELPER);
    }
    if plan.signals.is_empty() {
        return None;
    }

    // A system temp dir that is itself in the scratch space would only move
    // the problem; fall back to removing the variables instead.
    let system_temp = system_temp
        .filter(|dir| !is_in_scratch_namespace(dir))
        .map(Path::to_path_buf);
    plan.temp = scratch_temp
        .into_iter()
        .map(|key| (key, system_temp.clone()))
        .collect();

    let mut remove: Vec<&str> = Vec::new();
    if credential_helper {
        remove.extend(GIT_CONFIG_TRIPLE);
    }
    remove.extend(injected_keys());
    remove.extend(PARENT_SESSION_MARKERS);
    if find(env, AGENT_GIT_EDITOR.0).is_some_and(|(_, v)| v.to_str() == Some(AGENT_GIT_EDITOR.1)) {
        remove.push(AGENT_GIT_EDITOR.0);
    }
    // The desktop exports its resolved data dir into its own environment so
    // every child inherits it (`lib.rs` setup), and resolves it again from
    // scratch at startup — so an inherited one is the PARENT's data dir, which
    // for a parent codeg-server is a different database altogether. The server
    // reads the variable as its configuration and keeps it.
    if runtime == Runtime::Desktop {
        remove.push("CODEG_DATA_DIR");
    }

    for key in remove {
        if let Some((present, _)) = find(env, key) {
            if !plan.remove.contains(present) && !plan.temp.iter().any(|(k, _)| k == present) {
                plan.remove.push(present.clone());
            }
        }
    }
    Some(plan)
}

/// The directory the OS hands out as this user's temp dir when nothing
/// overrides it.
///
/// macOS: the per-user `/var/folders/…/T/` from `confstr`, which is what
/// launchd puts in `TMPDIR` for a normal launch. Other Unix: `/tmp`. Windows:
/// `%LOCALAPPDATA%\Temp`, the default `TMP`/`TEMP`, or `None` when even that is
/// unknown (the variables are then removed, and `GetTempPathW` falls back on
/// its own).
pub fn system_temp_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut buf: Vec<libc::c_char> = vec![0; 1024];
        // SAFETY: `buf` is a writable buffer of the length passed, and
        // `confstr` NUL-terminates what it writes within that length.
        let needed =
            unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr(), buf.len()) };
        if needed > 0 && needed <= buf.len() {
            // SAFETY: NUL-terminated within `buf`, per the length check above.
            let bytes = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_bytes();
            if !bytes.is_empty() {
                return Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)));
            }
        }
        Some(PathBuf::from("/tmp"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(PathBuf::from("/tmp"))
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(|dir| PathBuf::from(dir).join("Temp"))
    }
}

/// Undo an environment inherited from inside a codeg session, and report what
/// changed — `None` for an ordinary launch, which is left exactly as it was.
///
/// Call it before logging is set up and report the result afterwards with
/// [`Sanitized::log`]: the log file's own location is read from the
/// environment this may change.
///
/// # Safety
///
/// Mutates the process environment. The caller must guarantee that no other
/// thread exists yet — call it first thing in `main`, before any runtime,
/// logger or plugin starts a thread.
pub unsafe fn sanitize(runtime: Runtime) -> Option<Sanitized> {
    let env: Env = std::env::vars_os()
        .filter_map(|(key, value)| key.into_string().ok().map(|key| (key, value)))
        .collect();
    let plan = plan(&env, runtime, system_temp_dir().as_deref())?;
    for (key, value) in &plan.temp {
        match value {
            Some(dir) => std::env::set_var(key, dir),
            None => std::env::remove_var(key),
        }
    }
    for key in &plan.remove {
        std::env::remove_var(key);
    }
    Some(plan.report())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), OsString::from(v)))
            .collect()
    }

    const HELPER: &str =
        "!'/Users/me/Library/Application Support/app.codeg/git-credential-codeg.sh'";

    /// The environment of the codeg in the incident, trimmed to what matters:
    /// started by a script that an agent session of the previous codeg ran.
    fn from_inside_an_agent_session() -> Env {
        env(&[
            ("TMPDIR", "/tmp/codeg-acp-501/38441-ecf15960"),
            ("TEMP", "/tmp/codeg-acp-501/38441-ecf15960"),
            ("TMP", "/tmp/codeg-acp-501/38441-ecf15960"),
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", HELPER),
            ("GIT_EDITOR", "true"),
            ("CLICOLOR", "0"),
            ("CLICOLOR_FORCE", "0"),
            ("FORCE_COLOR", "1"),
            ("TERM", "xterm-256color"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "dc6fbf91"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/cc-socks/71894.sock"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
            ("CLAUDE_PID", "71894"),
            ("CLAUDE_EFFORT", "xhigh"),
            ("AI_AGENT", "claude-code_agent"),
            (
                "CODEG_DATA_DIR",
                "/Users/me/Library/Application Support/app.codeg",
            ),
            ("HOME", "/Users/me"),
            ("PATH", "/usr/bin:/bin"),
            ("SHELL", "/bin/zsh"),
            ("NO_COLOR", "1"),
        ])
    }

    fn system_temp() -> PathBuf {
        PathBuf::from("/var/folders/hl/x/T/")
    }

    #[test]
    fn an_ordinary_launch_is_left_alone() {
        let ordinary = env(&[
            ("TMPDIR", "/var/folders/hl/x/T/"),
            ("HOME", "/Users/me"),
            ("TERM", "xterm-256color"),
            ("CLICOLOR_FORCE", "1"),
            ("CODEG_DATA_DIR", "/srv/codeg"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("GIT_EDITOR", "true"),
        ]);
        for runtime in [Runtime::Desktop, Runtime::Server] {
            assert_eq!(plan(&ordinary, runtime, Some(&system_temp())), None);
        }
    }

    /// Someone else's `GIT_CONFIG_*` list is not a codeg mark, and is not ours
    /// to remove.
    #[test]
    fn a_foreign_git_config_list_is_not_a_signal() {
        let foreign = env(&[
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", "osxkeychain"),
        ]);
        assert_eq!(plan(&foreign, Runtime::Desktop, Some(&system_temp())), None);

        let two_entries = env(&[
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", HELPER),
        ]);
        assert_eq!(
            plan(&two_entries, Runtime::Desktop, Some(&system_temp())),
            None
        );
    }

    #[test]
    fn the_incident_environment_is_recognised_and_cleaned() {
        let plan = plan(
            &from_inside_an_agent_session(),
            Runtime::Desktop,
            Some(&system_temp()),
        )
        .expect("must be recognised");

        assert_eq!(
            plan.signals,
            vec![SIGNAL_SCRATCH_TEMP, SIGNAL_CREDENTIAL_HELPER]
        );
        for key in ["TMPDIR", "TEMP", "TMP"] {
            assert!(
                plan.temp.contains(&(key.to_string(), Some(system_temp()))),
                "{key} must point back at the system temp dir"
            );
        }
        for key in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_EDITOR",
            "CLICOLOR",
            "CLICOLOR_FORCE",
            "FORCE_COLOR",
            "TERM",
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_PID",
            "CLAUDE_EFFORT",
            "AI_AGENT",
            "CODEG_DATA_DIR",
        ] {
            assert!(
                plan.remove.iter().any(|k| k == key),
                "{key} must be removed"
            );
        }
        // The user's own environment survives, and so does a variable codeg
        // never sets.
        for key in ["HOME", "PATH", "SHELL", "NO_COLOR"] {
            assert!(!plan.remove.iter().any(|k| k == key), "{key} must survive");
        }
        // Only what is present is reported.
        assert!(!plan.remove.iter().any(|k| k == "CLAUDE_CODE_ENTRYPOINT"));
    }

    /// `CODEG_DATA_DIR` is the server's configuration, so the server keeps it
    /// even when everything else goes.
    #[test]
    fn the_server_keeps_its_data_dir() {
        let plan = plan(
            &from_inside_an_agent_session(),
            Runtime::Server,
            Some(&system_temp()),
        )
        .expect("must be recognised");
        assert!(!plan.remove.iter().any(|k| k == "CODEG_DATA_DIR"));
        assert!(plan.remove.iter().any(|k| k == "CLAUDECODE"));
    }

    /// An integrated terminal carries the credential helper but an ordinary
    /// `TMPDIR`: the launch is still recognised, and the temp dir is not
    /// touched.
    #[test]
    fn a_launch_from_an_integrated_terminal_keeps_its_temp_dir() {
        let terminal = env(&[
            ("TMPDIR", "/var/folders/hl/x/T/"),
            ("GIT_CONFIG_COUNT", "1"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", HELPER),
        ]);
        let plan = plan(&terminal, Runtime::Desktop, Some(&system_temp())).expect("recognised");
        assert_eq!(plan.signals, vec![SIGNAL_CREDENTIAL_HELPER]);
        assert!(plan.temp.is_empty());
        assert_eq!(
            plan.remove,
            vec!["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
        );
    }

    /// A scratch `TMPDIR` alone is enough — isolation can be on while the
    /// credential helper could not be written.
    #[test]
    fn a_scratch_temp_dir_alone_is_a_signal() {
        let only_temp = env(&[("TMPDIR", "/var/folders/hl/x/T/codeg-acp/1-deadbeef")]);
        let plan = plan(&only_temp, Runtime::Server, Some(&system_temp())).expect("recognised");
        assert_eq!(plan.signals, vec![SIGNAL_SCRATCH_TEMP]);
        assert_eq!(plan.temp, vec![("TMPDIR".to_string(), Some(system_temp()))]);
    }

    /// A `GIT_EDITOR` that names a real editor is the user's, not the agent's.
    #[test]
    fn a_real_git_editor_survives() {
        let mut env = from_inside_an_agent_session();
        env.insert("GIT_EDITOR".into(), OsString::from("vim"));
        let plan = plan(&env, Runtime::Desktop, Some(&system_temp())).expect("recognised");
        assert!(!plan.remove.iter().any(|k| k == "GIT_EDITOR"));
    }

    /// With no system temp dir to go back to, the scratch values are removed
    /// rather than kept.
    #[test]
    fn without_a_system_temp_dir_the_scratch_values_are_removed() {
        let plan =
            plan(&from_inside_an_agent_session(), Runtime::Desktop, None).expect("recognised");
        assert!(plan.temp.iter().all(|(_, value)| value.is_none()));
        let report = plan.report();
        assert!(report.reset.is_empty());
        for key in ["TMPDIR", "TEMP", "TMP"] {
            assert!(report.removed.iter().any(|k| k == key), "{key}");
        }
    }

    /// The report names variables and never carries a value.
    #[test]
    fn the_report_carries_names_only() {
        let report = plan(
            &from_inside_an_agent_session(),
            Runtime::Desktop,
            Some(&system_temp()),
        )
        .expect("recognised")
        .report();
        let text = format!("{report:?}");
        for value in ["secret", "71894", "dc6fbf91", "/tmp/codeg-acp-501", "xhigh"] {
            assert!(!text.contains(value), "{value} leaked into {text}");
        }
        assert_eq!(report.reset, vec!["TMP", "TEMP", "TMPDIR"]);
    }

    /// The list is assembled from the launch path's own constants, so it holds
    /// what the launch path sets — including the registry's per-agent `env`.
    #[test]
    fn the_injected_list_follows_the_launch_path() {
        let keys = injected_keys();
        for key in [
            "CLICOLOR_FORCE",
            "FORCE_COLOR",
            "DISABLE_MCP_CONFIG_FILTERING",
            "INITIAL_AGENT_MODE",
            "CODEG_SESSION_PERSISTENCE",
            "OPENCLAW_RESET_SESSION",
            "PI_ACP_ENABLE_EMBEDDED_CONTEXT",
        ] {
            assert!(keys.contains(&key), "{key}");
        }
        // Never a variable the new process needs to run at all.
        for key in [
            "HOME",
            "PATH",
            "USER",
            "SHELL",
            "CODEG_DATA_DIR",
            "CODEG_PORT",
        ] {
            assert!(!keys.contains(&key), "{key}");
        }
    }

    /// The real lookup: whatever the platform answers is a directory, and never
    /// one inside the scratch space it is meant to replace.
    #[cfg(unix)]
    #[test]
    fn the_system_temp_dir_is_real_and_outside_the_scratch_space() {
        let dir = system_temp_dir().expect("unix always has one");
        assert!(dir.is_dir(), "{} is not a directory", dir.display());
        assert!(!is_in_scratch_namespace(&dir));
    }
}
