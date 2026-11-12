//! The move frame: the hidden note codeg appends to the first message after a
//! session was moved to another project with its files (see
//! `crate::session_move`), and removes again wherever history is shown.
//!
//! The agent's history still names the old folder, so without a word it keeps
//! reading and editing files there. The note says once where the session lives
//! now; nothing else changes — not the system prompt, not the tools — exactly
//! like the talk frame (`acp::talk_frame`), whose wire shape this shares:
//!
//! ```text
//! RS{"kind":"codeg_internal_move","version":1,"len":97,"digest":"…"}\n<body>RS
//! ```
//!
//! `RS` is U+001E, scrubbed from every prompt at ingress, so a frame that still
//! parses in a transcript can only be one codeg appended. A frame is recognized
//! by its descriptor — `len` is the body's length in UTF-8 bytes and `digest`
//! the first 16 hex digits of its SHA-256 — so the wording can change between
//! releases without old frames turning into visible history. The separators
//! are optional surroundings, as for the talk frame: an agent that turned them
//! into spaces still has its frame found and removed.

use serde::{Deserialize, Serialize};

const SEPARATOR: char = '\u{001e}';
const KIND: &str = "codeg_internal_move";
const VERSION: u8 = 1;
/// The descriptor's opening bytes: `kind` is its first field, so every frame
/// starts with this.
const DESCRIPTOR_PREFIX: &str = "{\"kind\":\"codeg_internal_move\"";
/// Longest descriptor line accepted. A real one is about 90 bytes.
const MAX_DESCRIPTOR_BYTES: usize = 256;
/// Longest body accepted: two absolute paths and a sentence.
const MAX_BODY_BYTES: usize = 16 * 1024;
/// Hex digits of the body's SHA-256 a descriptor carries.
const DIGEST_HEX_DIGITS: usize = 16;

/// The descriptor line. Field order is load-bearing: a candidate is accepted
/// only if it re-serializes to the exact bytes it was read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    kind: String,
    version: u8,
    len: usize,
    digest: String,
}

fn body_digest(body: &str) -> String {
    use sha2::{Digest, Sha256};
    let hex = format!("{:x}", Sha256::digest(body.as_bytes()));
    hex[..DIGEST_HEX_DIGITS].to_string()
}

/// What the note says: the one sentence the first message after a move
/// carries.
pub fn note(from: &str, to: &str) -> String {
    format!("This session moved from {from} to {to}; files are now under {to}.")
}

/// The frame for `body`, separators included: the text to append.
pub fn render(body: &str) -> String {
    let descriptor = Descriptor {
        kind: KIND.to_string(),
        version: VERSION,
        len: body.len(),
        digest: body_digest(body),
    };
    let descriptor = serde_json::to_string(&descriptor).expect("move descriptor is serializable");
    format!("{SEPARATOR}{descriptor}\n{body}{SEPARATOR}")
}

/// The byte span of the intact frame whose descriptor starts at `start`,
/// separators included when the agent kept them.
fn frame_at(input: &str, start: usize) -> Option<(usize, usize)> {
    let rest = &input[start..];
    let line_len = rest
        .bytes()
        .take(MAX_DESCRIPTOR_BYTES)
        .position(|b| b == b'\n')?;
    let line = &rest[..line_len];
    let descriptor: Descriptor = serde_json::from_str(line).ok()?;
    if descriptor.kind != KIND
        || descriptor.version != VERSION
        || descriptor.len > MAX_BODY_BYTES
        || descriptor.digest.len() != DIGEST_HEX_DIGITS
        || serde_json::to_string(&descriptor).ok()? != line
    {
        return None;
    }
    let body_start = start + line_len + 1;
    let body_end = body_start.checked_add(descriptor.len)?;
    let body = input.get(body_start..body_end)?;
    if body_digest(body) != descriptor.digest {
        return None;
    }
    let mut span_start = start;
    if input[..start].ends_with(SEPARATOR) {
        span_start -= SEPARATOR.len_utf8();
    }
    let mut span_end = body_end;
    if input[body_end..].starts_with(SEPARATOR) {
        span_end += SEPARATOR.len_utf8();
    }
    Some((span_start, span_end))
}

/// Every intact frame in `input`, in order. A look-alike opening is skipped
/// one anchor at a time, so it can never hide a real frame further along.
fn frames(input: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(rel) = input.get(from..).and_then(|s| s.find(DESCRIPTOR_PREFIX)) {
        let start = from + rel;
        match frame_at(input, start) {
            Some(span) => {
                from = span.1;
                found.push(span);
            }
            None => from = start + DESCRIPTOR_PREFIX.len(),
        }
    }
    found
}

/// Whether `input` holds at least one intact frame.
pub fn contains(input: &str) -> bool {
    input.contains(DESCRIPTOR_PREFIX) && !frames(input).is_empty()
}

/// `input` with every intact frame removed. Whitespace an agent put around a
/// frame is left to the caller's trim.
pub fn strip(input: &str) -> String {
    if !input.contains(DESCRIPTOR_PREFIX) {
        return input.to_string();
    }
    let found = frames(input);
    if found.is_empty() {
        return input.to_string();
    }
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for (start, end) in found {
        output.push_str(&input[cursor..start]);
        cursor = end;
    }
    output.push_str(&input[cursor..]);
    output
}

/// Where a title must be cut so no part of a frame shows: the descriptor's
/// opening, or a cut-off piece of it at the very end (a parser capped the
/// title inside it and appended `...`).
pub fn title_cut(text: &str) -> Option<usize> {
    if let Some(at) = text.find(DESCRIPTOR_PREFIX) {
        return Some(at);
    }
    // Shorter than `{"kind":"codeg_` is a generic JSON opening, not ours.
    const SHORTEST_FRAGMENT: usize = "{\"kind\":\"codeg_".len();
    let capped = text.trim_end_matches('.');
    (SHORTEST_FRAGMENT..DESCRIPTOR_PREFIX.len())
        .rev()
        .find(|&length| capped.ends_with(&DESCRIPTOR_PREFIX[..length]))
        .map(|length| capped.len() - length)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> String {
        note("/work/old", "/work/new")
    }

    #[test]
    fn the_note_names_both_folders() {
        let body = body();
        assert!(body.contains("from /work/old to /work/new"));
        assert!(body.contains("files are now under /work/new"));
    }

    #[test]
    fn a_frame_round_trips() {
        let frame = render(&body());
        assert!(frame.starts_with(SEPARATOR));
        assert!(frame[SEPARATOR.len_utf8()..].starts_with(DESCRIPTOR_PREFIX));
        assert!(frame.ends_with(SEPARATOR));
        assert!(contains(&frame));
        assert_eq!(strip(&frame), "");
    }

    #[test]
    fn prose_around_the_frame_is_kept() {
        let frame = render(&body());
        for joined in [
            format!("keep going{frame}"),
            format!("keep going\n\n{frame}"),
        ] {
            assert_eq!(strip(&joined).trim_end(), "keep going");
        }
        // Without its separators (an agent that turned them into spaces).
        let bare = frame.replace(SEPARATOR, " ");
        assert_eq!(strip(&format!("keep going{bare}")).trim_end(), "keep going");
    }

    #[test]
    fn a_frame_is_recognized_by_its_digest_not_its_wording() {
        let reworded = render("Some other wording a later release uses.");
        assert_eq!(strip(&reworded), "");
    }

    #[test]
    fn a_tampered_frame_is_left_alone() {
        let frame = render(&body());
        let edited = frame.replace("/work/new", "/work/neu");
        let respaced = frame.replace("\"version\":1", "\"version\": 1");
        let truncated = frame[..frame.len() - 10].to_string();
        for forged in [edited, respaced, truncated] {
            assert!(!contains(&forged), "{forged:?}");
            assert_eq!(strip(&forged), forged);
        }
    }

    #[test]
    fn text_without_a_frame_comes_back_unchanged() {
        for text in ["", "plain prose", "{\"kind\":\"codeg_internal_move\"}"] {
            assert!(!contains(text));
            assert_eq!(strip(text), text);
        }
    }

    #[test]
    fn a_title_is_cut_before_any_part_of_a_frame() {
        let frame = render(&body());
        let bare = frame.trim_start_matches(SEPARATOR);
        assert_eq!(title_cut(&format!("hi {bare}")), Some(3));
        let capped = format!("hi {}...", &DESCRIPTOR_PREFIX[..20]);
        assert_eq!(title_cut(&capped), Some(3));
        assert_eq!(title_cut("hi there"), None);
    }
}
