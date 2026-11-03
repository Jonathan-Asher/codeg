//! The `ask_user_question` contract: one question and its choices, the bounds
//! both sides enforce, and the parsing the companion does before anything
//! reaches codeg. codeg's `acp::question` re-exports all of it next to the
//! rest of its question handling (the pending set, answers, the elicitation
//! and native-ask bridges).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

/// Max questions per `ask_user_question` call, as in the `AskUserQuestion`
/// contract this tool mirrors; the JSON schema advertises the same `maxItems`.
pub const MAX_QUESTIONS: usize = 4;
/// Min / max selectable options per question. Fewer than two options is not a
/// meaningful choice; more than four overwhelms the card. Same as
/// `AskUserQuestion`.
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;
/// Max characters for a question's short `header` chip. A longer header is
/// shortened to fit ([`fit_header`]), never rejected: it is only a label.
pub const MAX_HEADER_CHARS: usize = 12;
/// Marks a header [`fit_header`] had to shorten.
const HEADER_ELLIPSIS: char = '…';
/// Per-field sanity bound (characters) for every agent/user-supplied free-text
/// field: the question text, each option label + description, and the free-text
/// "Other" answer. The full text rides in the broadcast event, the snapshot, and
/// the agent-facing tool result, so this caps the blast radius of a pathological
/// field — whether from a malformed agent (`parse_questions`) or a hand-rolled
/// client hitting `acp_answer_question` directly (codeg's `build_outcome`). The UI can't
/// produce anything this long.
pub const MAX_QUESTION_TEXT_CHARS: usize = 4096;

/// One selectable choice in a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Concise display text. A recommended option puts itself first and ends
    /// its label with "(Recommended)" (a string convention, as in
    /// `AskUserQuestion`).
    pub label: String,
    /// What this choice means / its trade-off. May be empty.
    pub description: String,
}

/// A single multiple-choice question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionSpec {
    /// Backend-minted stable id. Used as the answer correlation key instead of
    /// the question text (which `AskUserQuestion` keys on) so duplicate question
    /// strings or reordering can't collide.
    pub id: String,
    /// The full question shown to the user.
    pub question: String,
    /// Short category label (≤ [`MAX_HEADER_CHARS`], see [`header_or_derived`])
    /// rendered as a chip.
    pub header: String,
    /// When true the user may select multiple options.
    pub multi_select: bool,
    /// The choices (0..=[`MAX_OPTIONS`]). Empty means free-text: the card
    /// renders only its always-present "Other" input (codex `request_user_input`
    /// and MCP-server elicitations both ask open questions this way; the
    /// codeg-mcp ask tool still requires [`MIN_OPTIONS`] at its own parse
    /// layer).
    pub options: Vec<QuestionOption>,
    /// True when the answer is a secret (codex `request_user_input` marks API
    /// keys etc. with `_meta.codex.isSecret`): the card masks the free-text
    /// input. Default false — absent on the wire for every non-secret source.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_secret: bool,
}

/// Validate + parse the MCP `ask_user_question` arguments into typed
/// [`QuestionSpec`]s, minting a stable id per question. Enforces the contract
/// (1..=[`MAX_QUESTIONS`] questions, each with a non-empty question and
/// [`MIN_OPTIONS`]..=[`MAX_OPTIONS`] labeled options) so a malformed call is
/// rejected synchronously with a helpful message the LLM can fix, rather than
/// round-tripping bad data. `multiSelect` defaults to false; an option
/// `description` defaults to empty (lenient).
///
/// The `header` is lenient too ([`header_or_derived`]): models routinely write
/// one a few characters over [`MAX_HEADER_CHARS`], and failing the whole call
/// for a chip label cost a visible error card plus a retry round trip on almost
/// every ask. A long header is shortened to fit; a missing one is derived from
/// the question. The result still reports the header as sent — see
/// [`restore_sent_headers`].
pub fn parse_questions(arguments: &Value) -> Result<Vec<QuestionSpec>, String> {
    let arr = arguments
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ask_user_question requires a `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("ask_user_question requires at least one question".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        return Err(format!(
            "ask_user_question supports at most {MAX_QUESTIONS} questions per call"
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (qi, q) in arr.iter().enumerate() {
        let question = q
            .get("question")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `question`"))?;
        if question.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return Err(format!(
                "questions[{qi}] `question` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
            ));
        }
        let header = header_or_derived(q.get("header").and_then(|v| v.as_str()), question);
        let multi_select = q
            .get("multiSelect")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if opts.len() < MIN_OPTIONS || opts.len() > MAX_OPTIONS {
            return Err(format!(
                "questions[{qi}] must have between {MIN_OPTIONS} and {MAX_OPTIONS} options"
            ));
        }
        let mut options = Vec::with_capacity(opts.len());
        for (oi, o) in opts.iter().enumerate() {
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    format!("questions[{qi}].options[{oi}] is missing a non-empty `label`")
                })?;
            if label.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `label` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            let description = o
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if description.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `description` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            options.push(QuestionOption {
                label: label.to_string(),
                description,
            });
        }
        // Reject duplicate option labels within a question: the UI uses the
        // label as both the React key and the selection identity, and the
        // answer is submitted by label — duplicates would be ambiguous (select
        // one, select both) and collide on the key.
        let mut seen_labels = std::collections::HashSet::new();
        for o in &options {
            if !seen_labels.insert(o.label.as_str()) {
                return Err(format!(
                    "questions[{qi}] has duplicate option label {:?}",
                    o.label
                ));
            }
        }
        out.push(QuestionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            question: question.to_string(),
            header,
            multi_select,
            options,
            is_secret: false,
        });
    }
    Ok(out)
}

/// Re-assert the [`parse_questions`] count + size bounds on already-typed specs.
/// The companion validates before sending, but the broker socket is only
/// token-gated, so a hand-rolled client could bypass that path and ride
/// oversized or malformed specs straight into the broadcast `QuestionRequest`
/// event and the `pending_question` snapshot. The listener registers through
/// this, declining the ask on `Err` rather than trusting unbounded input — the
/// authoritative answer-side bounds already live in codeg's `build_outcome`, so this
/// closes the matching gap on the request side. Bounds mirror `parse_questions`.
///
/// Also like `parse_questions`, the header is the one field repaired rather
/// than rejected: once the set passes, every header is run through
/// [`header_or_derived`] in place (a no-op for one that already fits, so the
/// bridges that keep their own copy of the specs still match the stored one).
/// A set that fails is left untouched.
pub fn validate_specs(specs: &mut [QuestionSpec]) -> Result<(), String> {
    if specs.is_empty() || specs.len() > MAX_QUESTIONS {
        return Err(format!(
            "expected 1..={MAX_QUESTIONS} questions, got {}",
            specs.len()
        ));
    }
    let mut seen_ids = std::collections::HashSet::new();
    for (qi, q) in specs.iter().enumerate() {
        // `parse_questions` mints a fresh uuid per question; a hand-rolled client
        // could send empty / colliding ids, and the answer routing + UI state map
        // key on `id`, so duplicates would misroute or collide.
        if q.id.trim().is_empty() {
            return Err(format!("questions[{qi}] has an empty `id`"));
        }
        if !seen_ids.insert(q.id.as_str()) {
            return Err(format!("questions[{qi}] has a duplicate `id` {:?}", q.id));
        }
        if q.question.trim().is_empty() {
            return Err(format!("questions[{qi}] has an empty `question`"));
        }
        if q.question.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return Err(format!(
                "questions[{qi}] `question` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
            ));
        }
        // Unlike `parse_questions` (the codeg-mcp tool contract, which keeps
        // its [`MIN_OPTIONS`] floor), typed specs allow 0..=[`MAX_OPTIONS`]:
        // a question with no options is a legal free-text ask — the card
        // renders its always-present "Other" input alone (codex elicitation
        // and MCP-server forms ask open questions this way).
        if q.options.len() > MAX_OPTIONS {
            return Err(format!(
                "questions[{qi}] must have at most {MAX_OPTIONS} options"
            ));
        }
        let mut seen_labels = std::collections::HashSet::new();
        for (oi, o) in q.options.iter().enumerate() {
            if o.label.trim().is_empty() {
                return Err(format!(
                    "questions[{qi}].options[{oi}] has an empty `label`"
                ));
            }
            if o.label.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `label` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            // Mirror parse_questions: labels are the React key + selection identity
            // and answers are submitted by label, so duplicates (trimmed) are
            // ambiguous.
            if !seen_labels.insert(o.label.trim()) {
                return Err(format!(
                    "questions[{qi}] has a duplicate option label {:?}",
                    o.label
                ));
            }
            if o.description.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `description` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
        }
    }
    for q in specs.iter_mut() {
        q.header = header_or_derived(Some(&q.header), &q.question);
    }
    Ok(())
}

/// Some native asks carry NO `header` (the short category chip codeg renders):
/// grok's `ask_user_question` tool and pi's extension-UI `select` both send bare
/// question text. Synthesize one from the leading characters, bounded to
/// [`MAX_HEADER_CHARS`]. Always returns a non-empty, in-bounds string that
/// [`header_or_derived`] leaves as it is.
pub fn synthesize_header(question: &str) -> String {
    let header = grapheme_prefix(question.trim(), MAX_HEADER_CHARS).trim();
    if header.is_empty() {
        "Ask".to_string()
    } else {
        header.to_string()
    }
}

/// Fit an agent-supplied header to the chip: trimmed, and when it runs past
/// [`MAX_HEADER_CHARS`], cut to leave room for a trailing "…" so the chip shows
/// it was shortened. The cut falls between grapheme clusters, so a Hebrew
/// letter keeps its niqqud and an emoji its modifiers or ZWJ sequence. Empty
/// for a blank header. Idempotent: a fitted header comes back unchanged.
pub fn fit_header(header: &str) -> String {
    let header = header.trim();
    if header.chars().count() <= MAX_HEADER_CHARS {
        return header.to_string();
    }
    let mut fitted = grapheme_prefix(header, MAX_HEADER_CHARS - 1)
        .trim_end()
        .to_string();
    fitted.push(HEADER_ELLIPSIS);
    fitted
}

/// The header a question carries: the one it was given, fitted to the chip
/// ([`fit_header`]), or — when that is absent or blank — one derived from the
/// question ([`synthesize_header`]). Every path that builds or registers a
/// [`QuestionSpec`] goes through this, so a header is never a reason to fail an
/// ask and the result is always non-empty and in bounds.
pub fn header_or_derived(header: Option<&str>, question: &str) -> String {
    match header.map(fit_header) {
        Some(fitted) if !fitted.is_empty() => fitted,
        _ => synthesize_header(question),
    }
}

/// The longest prefix of `s` made of whole grapheme clusters and at most
/// `max_chars` chars long. A single cluster longer than the whole budget (a
/// pathological pile of combining marks) can't be kept whole, so that one case
/// falls back to a plain char cut rather than returning nothing.
fn grapheme_prefix(s: &str, max_chars: usize) -> &str {
    let mut chars = 0;
    let mut end = 0;
    for g in s.graphemes(true) {
        chars += g.chars().count();
        if chars > max_chars {
            break;
        }
        end += g.len();
    }
    if end == 0 {
        return match s.char_indices().nth(max_chars) {
            Some((i, _)) => &s[..i],
            None => s,
        };
    }
    &s[..end]
}

/// The header each `ask_user_question` question was SENT with, index-aligned
/// with what [`parse_questions`] returns: verbatim, or empty when the agent
/// gave none (or a non-string). `None` marks a header too large to echo back
/// (over [`MAX_QUESTION_TEXT_CHARS`]), which keeps its fitted form instead.
pub fn sent_headers(arguments: &Value) -> Vec<Option<String>> {
    arguments
        .get("questions")
        .and_then(Value::as_array)
        .map(|qs| {
            qs.iter()
                .map(|q| {
                    let sent = q.get("header").and_then(Value::as_str).unwrap_or("");
                    (sent.chars().count() <= MAX_QUESTION_TEXT_CHARS).then(|| sent.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Put the headers the agent SENT back on its `ask_user_question` result (the
/// `{ answers, declined }` envelope), replacing the fitted ones the card used.
///
/// The agent CLI persists that result next to the tool input it sent, and the
/// history cards (web and iOS) pair each answer with its question by the
/// `(header, question)` signature. A header [`parse_questions`] shortened or
/// derived would break that pairing, and the reloaded card would lose the
/// user's picks. Answers arrive in asked order (codeg's `build_outcome` walks the
/// specs in order, skipping unanswered ones), so they are matched forward
/// against `specs` — two questions that share the same text and fitted header
/// still map back one-to-one. `sent` is [`sent_headers`] of the same call.
pub fn restore_sent_headers(outcome: &mut Value, specs: &[QuestionSpec], sent: &[Option<String>]) {
    let Some(answers) = outcome.get_mut("answers").and_then(Value::as_array_mut) else {
        return;
    };
    let mut next = 0;
    for answer in answers {
        let question = answer.get("question").and_then(Value::as_str);
        let header = answer.get("header").and_then(Value::as_str);
        let Some(offset) = specs.get(next..).and_then(|rest| {
            rest.iter().position(|s| {
                question == Some(s.question.as_str()) && header == Some(s.header.as_str())
            })
        }) else {
            continue;
        };
        let idx = next + offset;
        next = idx + 1;
        if let (Some(Some(original)), Some(slot)) = (sent.get(idx), answer.get_mut("header")) {
            *slot = Value::String(original.clone());
        }
    }
}
