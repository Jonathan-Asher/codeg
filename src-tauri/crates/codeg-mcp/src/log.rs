//! The companion's diagnostics: one `codeg-mcp: …` line per event on stderr,
//! which the agent CLI keeps in its MCP server log. Never stdout, which is the
//! JSON-RPC channel. There is no file, level or filter: the companion logs only
//! why it is exiting, and several of them run at once.

use std::io::Write;

/// Write one line to stderr. A stderr that is gone is not a reason to fail
/// whatever wanted to report something, so errors are ignored.
pub fn line(message: std::fmt::Arguments<'_>) {
    let _ = writeln!(std::io::stderr().lock(), "codeg-mcp: {message}");
}

/// `log!("read stdin: {e}")` writes `codeg-mcp: read stdin: …` to stderr.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        $crate::log::line(format_args!($($arg)*))
    };
}
