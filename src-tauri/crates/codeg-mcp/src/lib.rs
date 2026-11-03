//! The `codeg-mcp` companion's library half: the MCP side of the protocol
//! ([`companion`]), the parent-process watchdog ([`parent_watcher`]) and the
//! stderr logger ([`log!`]). The binary (`main.rs`) only wires stdio to them.
//!
//! It depends on `codeg-mcp-protocol` alone, never on codeg's library, so the
//! sidecar builds in seconds and links no UI framework.

pub mod companion;
pub mod log;
pub mod parent_watcher;
