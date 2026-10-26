pub mod acp;
#[cfg(feature = "tauri-runtime")]
pub mod app_update;
#[cfg(feature = "tauri-runtime")]
pub mod auto_resume;
#[cfg(feature = "tauri-runtime")]
pub mod critical_sessions;
#[cfg(feature = "tauri-runtime")]
pub mod claude_plan_mode;
#[cfg(feature = "tauri-runtime")]
pub mod limit_continue;
#[cfg(feature = "tauri-runtime")]
pub mod push;
pub mod automation;
pub mod background;
pub mod backup;
#[cfg(feature = "tauri-runtime")]
pub mod browser;
/// The browser tool group's on/off switch. Unlike `browser` itself this is not
/// desktop-only: the shared codeg-mcp plumbing reads it in both runtimes.
pub mod browser_tools;
pub mod canvas;
pub mod chat_authoring;
pub mod chat_channel;
pub mod claude_auth;
/// Files-onto-the-OS-clipboard. Only the command itself is desktop-gated; the
/// path validation and URI encoding stay compiled in every mode so their tests
/// run without the tauri stack.
pub mod clipboard;
pub mod config_sync;
pub mod attention;
pub mod conversation_export;
/// "New folder" in the directory browser (both runtimes).
pub mod create_directory;
pub mod message_search;
pub mod conversations;
pub mod custom_agents;
pub mod custom_skills;
pub mod deepseek_settings;
pub mod delegation;
/// Dictation clean-up and translation. Compiled in every runtime: the iOS app
/// calls it on codeg-server.
pub mod dictation_refine;
pub mod experts;
/// Natural read-aloud (models, sidecar, audio streams). Both runtimes: a
/// browser reads aloud through its server.
pub mod tts;
pub mod feedback;
#[cfg(feature = "tauri-runtime")]
pub mod file_io;
pub mod folder_commands;
pub mod folder_links;
pub mod folders;
pub mod forge;
pub mod logging;
pub mod client_diagnostics;
pub mod mcp;
pub mod mcp_service;
pub mod model_provider;
pub mod office_tools;
pub mod open_in;
/// `stat_paths`: existence, kind, size and mtime for a batch of paths.
pub mod path_stat;
#[cfg(feature = "tauri-runtime")]
pub mod notification;
/// What a pending item's macOS notification answers, and when it is stale.
#[cfg(feature = "tauri-runtime")]
pub mod notification_answers;
pub mod pet;
pub mod plan_usage;
pub mod project_boot;
pub mod question;
/// Quick Ask: the global-shortcut question window (desktop) and the cleanup
/// of its private questions (every runtime).
pub mod quick_ask;
pub mod quick_messages;
#[cfg(feature = "tauri-runtime")]
pub mod remote_proxy;
#[cfg(feature = "tauri-runtime")]
pub mod remote_workspace;
pub mod science;
pub mod session_info;
pub mod system_settings;
pub mod terminal;
pub mod token_usage;
pub mod turn_window;
pub mod usage_pool;
pub mod version_control;
#[cfg(feature = "tauri-runtime")]
pub mod windows;
pub mod work_task;
#[cfg(feature = "tauri-runtime")]
pub mod workspace_media;
/// Content search for the file tree tab (both runtimes).
pub mod workspace_search;
pub mod workspace_state;
#[cfg(feature = "tauri-runtime")]
pub mod workspace_windows;
