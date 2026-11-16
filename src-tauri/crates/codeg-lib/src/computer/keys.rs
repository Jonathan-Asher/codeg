//! The keys and chords computer use's actions name, and the rules of which a
//! grant allows. Shared with the `codeg-mcp` companion, which parses them from
//! an agent's arguments (`codeg_mcp_protocol::computer::keys`); re-exported
//! here, where the rest of computer use reads them.

pub use codeg_mcp_protocol::computer::keys::*;
