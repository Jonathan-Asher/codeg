//! Computer use's wire types: what the companion's `computer_*` tools parse
//! from an agent's arguments and send across the broker socket, and what
//! codeg answers. codeg re-exports them where they were written
//! (`computer::types`, `computer::keys`, `computer::targets`,
//! `acp::computer_tools`).

use serde::{Deserialize, Serialize};

pub mod keys;
pub mod types;

/// The target id of the whole screen, next to the window targets (see
/// `computer::targets` in codeg).
pub const SCREEN_TARGET_ID: &str = "d1";

/// The longest accessibility tree `computer_snapshot` returns by default, in
/// characters.
pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 40_000;

/// What `computer_clipboard_read` / `computer_clipboard_write` ask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardOp {
    Read,
    Write { text: String },
}

/// What `computer_snapshot` asks for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    /// Cap on the returned tree in characters. `None` →
    /// [`DEFAULT_SNAPSHOT_MAX_CHARS`]; `Some(0)` → no cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<u32>,
    /// Keep only the lines mentioning this (and their ancestors).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}
