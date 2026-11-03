//! The built-in browser's agent requests: what a browser tool asks codeg to
//! do to a tab, as the companion builds it from the tool's arguments and the
//! broker carries it. codeg's `browser::{agent, console, capture, eval}` and
//! `acp::browser_tools` re-export them next to the code that carries them out.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Acting on an element (`browser::agent`)
// ---------------------------------------------------------------------------

/// Which mouse button a click is made with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PointerButton {
    #[default]
    Left,
    Right,
}

/// What an agent asks to do to an element. Serialized exactly as the world's
/// `ActionRequest` expects it (`{"kind": "click", …}`), so the host builds the
/// call by serializing this and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActionKind {
    Click {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<PointerButton>,
        /// 1 for a click, 2 for a double click.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count: Option<u8>,
    },
    Hover,
    /// Replace a field's value with `text`. `submit` presses Enter after.
    Type {
        text: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        submit: bool,
    },
    /// Press a key — `"Enter"`, `"a"`, `"Control+Shift+k"` — on the element,
    /// or on whatever has focus when the request names none.
    Press {
        key: String,
    },
    /// Choose options of a `<select>`, by value or by label.
    Select {
        values: Vec<String>,
    },
}

impl ActionKind {
    /// Whether this action goes to a point on screen — the two the platform
    /// can deliver a real pointer for.
    pub fn is_pointer(&self) -> bool {
        matches!(self, ActionKind::Click { .. } | ActionKind::Hover)
    }
}

/// One action on one tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    /// The `generation` of the snapshot that named [`Self::target`]: the token
    /// an agent echoes back, opaque to it, checked by both the host and the
    /// world.
    pub generation: String,
    /// The element's ref. `None` only for [`ActionKind::Press`], which then
    /// goes to whatever has focus.
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub action: ActionKind,
}

// ---------------------------------------------------------------------------
// Reading the console (`browser::console`)
// ---------------------------------------------------------------------------

/// Severity, in the order a `minLevel` filter compares it: everything from
/// `Debug` up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "debug" => Some(Self::Debug),
            "log" => Some(Self::Log),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Log => "log",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// What a read asks for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleQuery {
    /// Only lines after this `seq`. `0` is everything the ring holds.
    #[serde(default)]
    pub since: u64,
    /// Only lines at this level or above. Absent is everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<ConsoleLevel>,
    /// At most this many lines, oldest first. Absent is codeg's
    /// `browser::console::DEFAULT_CONSOLE_LIMIT`; `0` is treated the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Screenshots (`browser::capture`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureFormat {
    #[default]
    Png,
    Jpeg,
}

impl CaptureFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpeg" => Some(Self::Jpeg),
            _ => None,
        }
    }
}

/// What an agent asks a capture for. `generation` and `ref` name an element
/// from a snapshot to crop to; both or neither.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Output width in pixels; the height follows. Absent or `0` is codeg's
    /// `browser::capture::DEFAULT_CAPTURE_MAX_WIDTH`; capped at its
    /// `CAPTURE_MAX_WIDTH_CEILING`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub format: CaptureFormat,
}

impl CaptureRequest {
    /// The element to crop to, when the request names one.
    pub fn clip_target(&self) -> Option<(&str, &str)> {
        match (self.generation.as_deref(), self.target.as_deref()) {
            (Some(generation), Some(target)) => Some((generation, target)),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Running code on a page (`browser::eval`)
// ---------------------------------------------------------------------------

/// The most code a caller may send in one call.
///
/// A cap on consent rather than on cost. The person approving a snippet has to
/// be able to read it; four thousand characters is already more than anyone
/// reads carefully, and a tool that accepted a hundred kilobytes of minified
/// script would be asking for a signature on a document nobody opened.
pub const MAX_EVAL_CODE_CHARS: usize = 4000;

/// What an agent asks to run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    /// A function body: the code runs inside `function () { … }`, so it
    /// `return`s the value to report. Statements, `const`, early returns and
    /// comments all behave as they read.
    pub code: String,
}

/// Why a snippet was not even put in front of a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadCode {
    Empty,
    TooLong,
}

impl BadCode {
    pub fn message(self) -> String {
        match self {
            BadCode::Empty => "browser_eval needs `code`: the body of a function to run on the \
                               page, which returns the value to report."
                .to_string(),
            BadCode::TooLong => format!(
                "browser_eval takes at most {MAX_EVAL_CODE_CHARS} characters of code. A person \
                 has to read and approve every snippet before it runs, so send the smallest \
                 piece that answers your question rather than a program."
            ),
        }
    }
}

/// Whether this is a snippet worth showing a person at all.
///
/// Length is counted in characters, not bytes: it stands in for how much there
/// is to read, and a page's worth of Japanese is a page's worth either way.
pub fn validate_code(code: &str) -> Result<(), BadCode> {
    if code.trim().is_empty() {
        return Err(BadCode::Empty);
    }
    if code.chars().count() > MAX_EVAL_CODE_CHARS {
        return Err(BadCode::TooLong);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Opening, pointing and closing tabs (`acp::browser_tools`)
// ---------------------------------------------------------------------------

/// Which of the three tab tools is being asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrowserTabOp {
    /// Open a new tab on this address, in the foreground.
    Open { url: String },
    /// Point an existing tab at this address.
    Navigate { tab_id: String, url: String },
    /// Close an existing tab.
    Close { tab_id: String },
}

impl BrowserTabOp {
    /// The tab the op names, for a refusal that has to name one before the
    /// access impl is reached.
    pub fn tab_id(&self) -> Option<&str> {
        match self {
            Self::Open { .. } => None,
            Self::Navigate { tab_id, .. } | Self::Close { tab_id } => Some(tab_id),
        }
    }
}
