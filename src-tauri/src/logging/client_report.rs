//! Uncaught frontend errors, written to this process's log.
//!
//! A window whose React tree throws shows Next's "Application error: a
//! client-side exception has occurred" and nothing else; the stack only ever
//! reached the webview's own console, so a crash on a machine nobody had a
//! devtools window open on could not be diagnosed afterwards. The frontend
//! now reports `error` / `unhandledrejection` events and error-boundary
//! catches here (`src/lib/client-error-report.ts`), and they land in the log
//! as one WARN line each.
//!
//! Only the shape of the failure is kept: the error's message and stack
//! frames, the component stack, the route's path. All of it is cut to size
//! and stripped of anything that could carry content — query strings and
//! fragments go, control characters go — and the endpoint is rate-limited,
//! since a render loop can throw on every frame.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// One report, as the frontend sends it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientErrorReport {
    /// `error`, `unhandledrejection` or `boundary`.
    pub kind: String,
    /// Which error boundary caught it (`boundary` only).
    pub scope: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
    /// The page's path.
    pub route: Option<String>,
}

const MAX_MESSAGE_CHARS: usize = 300;
const MAX_STACK_LINES: usize = 15;
const MAX_COMPONENT_STACK_LINES: usize = 10;
const MAX_LINE_CHARS: usize = 200;
const MAX_ROUTE_CHARS: usize = 120;
const MAX_SCOPE_CHARS: usize = 64;

/// At most this many reports are written per [`REPORT_WINDOW`]; the rest are
/// counted and the count is written with the next one admitted.
pub const MAX_REPORTS_PER_WINDOW: u32 = 20;
pub const REPORT_WINDOW: Duration = Duration::from_secs(60);

fn cut(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// One line of text: control characters (newlines included) become spaces.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Drop the query string and fragment from every URL-ish token in a stack
/// frame (`…/chunk.js?v=1:2:3` → `…/chunk.js:2:3`). The `:line:col` suffix
/// after them is kept.
fn strip_queries(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '?' || c == '#' {
            // Skip to the next `:digit`, `)`, whitespace or end.
            while let Some(&next) = chars.peek() {
                if next == ')' || next.is_whitespace() {
                    break;
                }
                if next == ':' {
                    let mut ahead = chars.clone();
                    ahead.next();
                    if ahead.peek().is_some_and(|d| d.is_ascii_digit()) {
                        break;
                    }
                }
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn sanitize_stack(stack: &str, max_lines: usize) -> String {
    let lines: Vec<String> = stack
        .lines()
        .map(|line| cut(&strip_queries(&one_line(line)), MAX_LINE_CHARS))
        .filter(|line| !line.is_empty())
        .collect();
    let mut out = lines
        .iter()
        .take(max_lines)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n  ");
    if lines.len() > max_lines {
        out.push_str(&format!("\n  … {} more frame(s)", lines.len() - max_lines));
    }
    out
}

fn sanitize_route(route: &str) -> String {
    let path = route.split(['?', '#']).next().unwrap_or_default();
    cut(&one_line(path), MAX_ROUTE_CHARS)
}

fn sanitize_scope(scope: &str) -> String {
    scope
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .take(MAX_SCOPE_CHARS)
        .collect()
}

fn sanitize_kind(kind: &str) -> &'static str {
    match kind {
        "error" => "error",
        "unhandledrejection" => "unhandledrejection",
        "boundary" => "boundary",
        _ => "other",
    }
}

/// The log line for one report.
pub fn format_report(report: &ClientErrorReport, suppressed: u64) -> String {
    let kind = sanitize_kind(&report.kind);
    let mut line = format!("[client-error] {kind}");
    if let Some(scope) = report.scope.as_deref().map(sanitize_scope) {
        if !scope.is_empty() {
            line.push_str(&format!(" in {scope}"));
        }
    }
    if let Some(route) = report.route.as_deref().map(sanitize_route) {
        if !route.is_empty() {
            line.push_str(&format!(" at {route}"));
        }
    }
    let message = cut(&one_line(&report.message), MAX_MESSAGE_CHARS);
    line.push_str(": ");
    line.push_str(if message.is_empty() {
        "(no message)"
    } else {
        &message
    });
    if suppressed > 0 {
        line.push_str(&format!(
            " ({suppressed} more report(s) dropped by the rate limit before this one)"
        ));
    }
    if let Some(stack) = report.stack.as_deref() {
        let stack = sanitize_stack(stack, MAX_STACK_LINES);
        if !stack.is_empty() {
            line.push_str("\n  stack: ");
            line.push_str(&stack);
        }
    }
    if let Some(stack) = report.component_stack.as_deref() {
        let stack = sanitize_stack(stack, MAX_COMPONENT_STACK_LINES);
        if !stack.is_empty() {
            line.push_str("\n  components: ");
            line.push_str(&stack);
        }
    }
    line
}

/// Fixed-window rate limit for [`log_client_error`]. Pure: the caller passes
/// the clock.
#[derive(Debug)]
pub struct ReportBudget {
    window_start: Option<Instant>,
    admitted: u32,
    suppressed: u64,
}

impl ReportBudget {
    pub const fn new() -> Self {
        Self {
            window_start: None,
            admitted: 0,
            suppressed: 0,
        }
    }

    /// `Some(dropped since the last admitted one)` when this report may be
    /// written, `None` when it is over the budget.
    pub fn admit(&mut self, now: Instant) -> Option<u64> {
        let fresh = self
            .window_start
            .is_none_or(|start| now.saturating_duration_since(start) >= REPORT_WINDOW);
        if fresh {
            self.window_start = Some(now);
            self.admitted = 0;
        }
        if self.admitted >= MAX_REPORTS_PER_WINDOW {
            self.suppressed += 1;
            return None;
        }
        self.admitted += 1;
        Some(std::mem::take(&mut self.suppressed))
    }
}

impl Default for ReportBudget {
    fn default() -> Self {
        Self::new()
    }
}

static BUDGET: Mutex<ReportBudget> = Mutex::new(ReportBudget::new());

/// Write `report` to the log at WARN, unless the rate limit is spent.
pub fn log_client_error(report: &ClientErrorReport) {
    let admitted = match BUDGET.lock() {
        Ok(mut budget) => budget.admit(Instant::now()),
        Err(poisoned) => poisoned.into_inner().admit(Instant::now()),
    };
    if let Some(suppressed) = admitted {
        tracing::warn!(target: "codeg::client", "{}", format_report(report, suppressed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> ClientErrorReport {
        ClientErrorReport {
            kind: "boundary".into(),
            scope: Some("workspace-main".into()),
            message: "Cannot read properties of undefined (reading 'items')".into(),
            stack: Some(
                "TypeError: Cannot read properties of undefined (reading 'items')\n    \
                 at AutoResumeToasts (tauri://localhost/_next/static/chunks/app.js?v=9f1:2:3456)\n    \
                 at renderWithHooks (tauri://localhost/_next/static/chunks/react.js#x:1:99)"
                    .into(),
            ),
            component_stack: Some("\n    at AutoResumeToasts\n    at FolderLayoutShell".into()),
            route: Some("/workspace?folder=/Users/someone/secret#tab".into()),
        }
    }

    #[test]
    fn a_report_becomes_one_warn_entry_with_the_failure_and_nothing_else() {
        let line = format_report(&report(), 0);
        assert_eq!(
            line,
            "[client-error] boundary in workspace-main at /workspace: Cannot read properties \
             of undefined (reading 'items')\n  stack: TypeError: Cannot read properties of \
             undefined (reading 'items')\n  at AutoResumeToasts \
             (tauri://localhost/_next/static/chunks/app.js:2:3456)\n  at renderWithHooks \
             (tauri://localhost/_next/static/chunks/react.js:1:99)\n  components: at \
             AutoResumeToasts\n  at FolderLayoutShell"
        );
        assert!(!line.contains("secret"));
        assert!(!line.contains("v=9f1"));
    }

    #[test]
    fn everything_is_cut_to_size() {
        let long = ClientErrorReport {
            kind: "made-up".into(),
            scope: Some("scope with spaces & <tags>".into()),
            message: format!("{}\nsecond line", "x".repeat(1_000)),
            stack: Some((0..40).map(|i| format!("at f{i} (a.js:1:{i})\n")).collect()),
            component_stack: None,
            route: Some("/".repeat(500)),
        };
        let line = format_report(&long, 3);
        assert!(line.starts_with("[client-error] other in scopewithspacestags at /"));
        let message_line = line.lines().next().unwrap();
        assert!(message_line.contains(&format!("{}…", "x".repeat(MAX_MESSAGE_CHARS))));
        assert!(message_line.contains("3 more report(s) dropped"));
        assert!(!message_line.contains("second line"));
        assert!(line.contains("… 25 more frame(s)"));
        assert_eq!(line.lines().count(), 1 + MAX_STACK_LINES + 1);
    }

    #[test]
    fn a_report_without_details_still_says_what_happened() {
        let bare = ClientErrorReport {
            kind: "unhandledrejection".into(),
            ..Default::default()
        };
        assert_eq!(
            format_report(&bare, 0),
            "[client-error] unhandledrejection: (no message)"
        );
    }

    #[test]
    fn the_budget_admits_a_window_s_worth_then_counts_the_rest() {
        let start = Instant::now();
        let mut budget = ReportBudget::new();
        for _ in 0..MAX_REPORTS_PER_WINDOW {
            assert_eq!(budget.admit(start), Some(0));
        }
        assert_eq!(budget.admit(start + Duration::from_secs(1)), None);
        assert_eq!(budget.admit(start + Duration::from_secs(2)), None);
        // Next window: admitted again, carrying the count of what was dropped.
        assert_eq!(budget.admit(start + REPORT_WINDOW), Some(2));
        assert_eq!(budget.admit(start + REPORT_WINDOW), Some(0));
    }

    #[test]
    fn a_report_deserializes_from_the_frontend_shape() {
        let parsed: ClientErrorReport = serde_json::from_value(serde_json::json!({
            "kind": "error",
            "message": "boom",
            "componentStack": "at X",
            "unknownField": 1
        }))
        .unwrap();
        assert_eq!(parsed.kind, "error");
        assert_eq!(parsed.component_stack.as_deref(), Some("at X"));
        assert!(parsed.stack.is_none());
    }
}
