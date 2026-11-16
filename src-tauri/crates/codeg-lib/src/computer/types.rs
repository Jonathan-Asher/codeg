//! Computer use's wire types — the requests an agent's `computer_*` tools
//! make and the reports codeg answers with. They live in the protocol crate
//! the `codeg-mcp` companion shares with codeg (`codeg_mcp_protocol::computer`),
//! which parses them from an agent's arguments; re-exported here, where the
//! rest of computer use reads them.

pub use codeg_mcp_protocol::computer::types::*;
