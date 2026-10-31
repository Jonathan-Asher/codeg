//! The talk frame: the hidden note codeg appends to a new message while its
//! conversation is in Talk mode (see `crate::talk`), and removes again
//! wherever history is shown.
//!
//! On the wire a frame is its own text block, the last one of the message:
//!
//! ```text
//! RS{"kind":"codeg_internal_talk","version":1,"mode":"compact","spoken":true,"len":512,"digest":"…"}\n<body>RS
//! ```
//!
//! `RS` is U+001E, the separator the `@agent` routing frame uses too
//! (`agent_mentions`), which every prompt has scrubbed at ingress — so a frame
//! that still parses in a transcript can only be one codeg appended.
//!
//! A frame is recognized by its DESCRIPTOR, not by its wording: `len` is the
//! body's length in UTF-8 bytes and `digest` the first 16 hex digits of the
//! SHA-256 of `<mode>\n<spoken>\n<body>`. The rules a frame carries (`crate::talk::rules`) can therefore
//! change from one release to the next without the frames already written into
//! agents' transcripts turning into visible history — unlike the routing
//! frame, whose identity is its exact wording.
//!
//! The separators are the one part an agent may not give back (Antigravity's
//! ACP server turns each into a space; see `agent_mentions`), so the finder
//! anchors on the descriptor's opening bytes and treats the separators as
//! optional surroundings: removed with the frame when they are there, left to
//! the callers' trim when an agent replaced them with whitespace.

use serde::{Deserialize, Serialize};

const SEPARATOR: char = '\u{001e}';
const KIND: &str = "codeg_internal_talk";
const VERSION: u8 = 1;
/// The descriptor's opening bytes: `kind` is its first field, so every frame
/// starts with this (`descriptor_starts_with_the_anchor` guards the order).
const DESCRIPTOR_PREFIX: &str = "{\"kind\":\"codeg_internal_talk\"";
/// Longest descriptor line accepted. A real one is about 110 bytes.
const MAX_DESCRIPTOR_BYTES: usize = 256;
/// Longest body accepted. The Full rules are about 2 KB.
const MAX_BODY_BYTES: usize = 16 * 1024;
/// Hex digits of the body's SHA-256 a descriptor carries.
const DIGEST_HEX_DIGITS: usize = 16;

/// Which note a frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TalkFrameMode {
    /// The full talk rules: the first message on a connection in Talk mode.
    Full,
    /// A short reminder: the rules are already in the agent's context.
    Compact,
    /// Talk mode is over: back to the normal written style.
    Off,
}

impl TalkFrameMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TalkFrameMode::Full => "full",
            TalkFrameMode::Compact => "compact",
            TalkFrameMode::Off => "off",
        }
    }
}

/// What a frame found in a transcript said about its message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TalkFrameInfo {
    pub mode: TalkFrameMode,
    /// The message was spoken (dictated through the phone's Talk mode).
    pub spoken: bool,
}

/// The descriptor line. Field order is load-bearing: a candidate is accepted
/// only if it re-serializes to the exact bytes it was read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    kind: String,
    version: u8,
    mode: TalkFrameMode,
    spoken: bool,
    len: usize,
    digest: String,
}

/// Covers the flags as well as the body, so a frame is checked whole.
fn frame_digest(mode: TalkFrameMode, spoken: bool, body: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("{}\n{spoken}\n", mode.as_str()).as_bytes());
    hasher.update(body.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..DIGEST_HEX_DIGITS].to_string()
}

/// The frame for `body`, separators included: the text block to append.
pub fn render(mode: TalkFrameMode, spoken: bool, body: &str) -> String {
    let descriptor = Descriptor {
        kind: KIND.to_string(),
        version: VERSION,
        mode,
        spoken,
        len: body.len(),
        digest: frame_digest(mode, spoken, body),
    };
    let descriptor = serde_json::to_string(&descriptor).expect("talk descriptor is serializable");
    format!("{SEPARATOR}{descriptor}\n{body}{SEPARATOR}")
}

/// The frame whose descriptor starts at `start` (on [`DESCRIPTOR_PREFIX`]):
/// its byte span, separators included when the agent kept them, and what it
/// says. `None` when the bytes there are not a whole, intact frame.
fn frame_at(input: &str, start: usize) -> Option<((usize, usize), TalkFrameInfo)> {
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
    if frame_digest(descriptor.mode, descriptor.spoken, body) != descriptor.digest {
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
    Some((
        (span_start, span_end),
        TalkFrameInfo {
            mode: descriptor.mode,
            spoken: descriptor.spoken,
        },
    ))
}

/// Every intact frame in `input`, in order. A look-alike opening is skipped
/// one anchor at a time, so it can never hide a real frame further along.
fn frames(input: &str) -> Vec<((usize, usize), TalkFrameInfo)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(rel) = input.get(from..).and_then(|s| s.find(DESCRIPTOR_PREFIX)) {
        let start = from + rel;
        match frame_at(input, start) {
            Some((span, info)) => {
                from = span.1;
                found.push((span, info));
            }
            None => from = start + DESCRIPTOR_PREFIX.len(),
        }
    }
    found
}

/// Whether `input` holds at least one intact frame. One substring scan for
/// text without any.
pub fn contains(input: &str) -> bool {
    input.contains(DESCRIPTOR_PREFIX) && !frames(input).is_empty()
}

/// `input` with every intact frame removed, and what the last one said.
/// Whitespace an agent put around a frame is left to the caller's trim.
pub fn strip(input: &str) -> (String, Option<TalkFrameInfo>) {
    if !input.contains(DESCRIPTOR_PREFIX) {
        return (input.to_string(), None);
    }
    let found = frames(input);
    let Some(&(_, last)) = found.last() else {
        return (input.to_string(), None);
    };
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for ((start, end), _) in &found {
        output.push_str(&input[cursor..*start]);
        cursor = *end;
    }
    output.push_str(&input[cursor..]);
    // A spoken message says so in every frame it carries; any one is enough.
    let spoken = found.iter().any(|(_, info)| info.spoken);
    (output, Some(TalkFrameInfo { spoken, ..last }))
}

/// Where a title must be cut so no part of a frame shows: the descriptor's
/// opening, or a cut-off piece of it at the very end (a parser capped the
/// title inside it and appended `...`). The separator itself is handled by the
/// routing frame's cut, which shares it.
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

    const BODY: &str = "Talk mode is on (voice): one to three short spoken sentences.";

    #[test]
    fn descriptor_starts_with_the_anchor() {
        let frame = render(TalkFrameMode::Compact, true, BODY);
        assert!(frame.starts_with(SEPARATOR));
        assert!(frame[SEPARATOR.len_utf8()..].starts_with(DESCRIPTOR_PREFIX));
        assert!(frame.ends_with(SEPARATOR));
    }

    #[test]
    fn a_frame_round_trips_with_what_it_says() {
        for mode in [
            TalkFrameMode::Full,
            TalkFrameMode::Compact,
            TalkFrameMode::Off,
        ] {
            for spoken in [false, true] {
                let frame = render(mode, spoken, BODY);
                assert!(contains(&frame));
                let (rest, info) = strip(&frame);
                assert_eq!(rest, "");
                assert_eq!(info, Some(TalkFrameInfo { mode, spoken }));
            }
        }
    }

    #[test]
    fn the_descriptor_carries_length_and_digest() {
        let frame = render(TalkFrameMode::Off, false, BODY);
        let line = frame[SEPARATOR.len_utf8()..].lines().next().unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(descriptor["kind"], "codeg_internal_talk");
        assert_eq!(descriptor["version"], 1);
        assert_eq!(descriptor["mode"], "off");
        assert_eq!(descriptor["spoken"], false);
        assert_eq!(descriptor["len"], BODY.len());
        assert_eq!(descriptor["digest"].as_str().unwrap().len(), 16);
    }

    #[test]
    fn a_frame_is_recognized_by_its_digest_not_its_wording() {
        // Any body works, including one this build never renders: what an
        // older or newer release wrote still leaves history.
        let reworded = render(
            TalkFrameMode::Full,
            true,
            "Different rules, same frame.\n- one",
        );
        assert_eq!(strip(&reworded).0, "");
    }

    #[test]
    fn prose_before_the_frame_is_kept_in_every_layout() {
        let frame = render(TalkFrameMode::Compact, true, BODY);
        // A block of its own (Claude, codeg's own transcripts), joined with no
        // separator (Pi), joined with a blank line.
        for joined in [
            format!("תבדוק את הבילד{frame}"),
            format!("תבדוק את הבילד\n\n{frame}"),
        ] {
            let (rest, info) = strip(&joined);
            assert_eq!(rest.trim_end(), "תבדוק את הבילד");
            assert!(info.unwrap().spoken);
        }
    }

    #[test]
    fn a_frame_without_its_separators_is_still_removed() {
        let frame = render(TalkFrameMode::Compact, false, BODY);
        let bare = frame.replace(SEPARATOR, " ");
        let (rest, info) = strip(&format!("check the build{bare}"));
        assert_eq!(rest.trim_end(), "check the build");
        assert_eq!(info.unwrap().mode, TalkFrameMode::Compact);
    }

    #[test]
    fn a_tampered_frame_is_left_alone() {
        let frame = render(TalkFrameMode::Full, true, BODY);
        let edited_body = frame.replace("three", "four");
        let edited_flag = frame.replace("\"spoken\":true", "\"spoken\":false");
        let longer = frame.replace(
            &format!("\"len\":{}", BODY.len()),
            &format!("\"len\":{}", BODY.len() + 1),
        );
        let respaced = frame.replace("\"version\":1", "\"version\": 1");
        let extra_field = frame.replace("\"kind\"", "\"x\":1,\"kind\"");
        let truncated = frame[..frame.len() - 10].to_string();
        for forged in [
            edited_body,
            edited_flag,
            longer,
            respaced,
            extra_field,
            truncated,
        ] {
            assert!(!contains(&forged), "{forged:?}");
            assert_eq!(strip(&forged).0, forged);
        }
    }

    #[test]
    fn a_look_alike_opening_does_not_hide_a_real_frame_after_it() {
        let frame = render(TalkFrameMode::Compact, true, BODY);
        let input = format!("{{\"kind\":\"codeg_internal_talk\" is a string I typed\n{frame}");
        let (rest, info) = strip(&input);
        assert_eq!(
            rest,
            "{\"kind\":\"codeg_internal_talk\" is a string I typed\n"
        );
        assert!(info.is_some());
    }

    #[test]
    fn several_frames_all_go_and_spoken_survives() {
        let first = render(TalkFrameMode::Full, true, BODY);
        let second = render(TalkFrameMode::Compact, false, "short");
        let (rest, info) = strip(&format!("a{first}b{second}"));
        assert_eq!(rest, "ab");
        let info = info.unwrap();
        assert_eq!(info.mode, TalkFrameMode::Compact);
        assert!(info.spoken);
    }

    #[test]
    fn text_without_a_frame_comes_back_unchanged() {
        for text in [
            "",
            "plain prose",
            "{\"kind\":\"codeg_internal_talk\"}",
            "\u{1e}",
        ] {
            assert!(!contains(text));
            assert_eq!(strip(text), (text.to_string(), None));
        }
    }

    #[test]
    fn multibyte_bodies_are_measured_in_bytes() {
        let body = "מצב שיחה פעיל: עד שלושה משפטים קצרים.";
        let frame = render(TalkFrameMode::Compact, true, body);
        assert_eq!(strip(&format!("שלום{frame}")).0, "שלום");
    }

    #[test]
    fn a_title_is_cut_before_any_part_of_a_frame() {
        let frame = render(TalkFrameMode::Full, true, BODY);
        let bare = frame.trim_start_matches(SEPARATOR);
        assert_eq!(title_cut(&format!("hi {bare}")), Some(3));
        // Capped inside the descriptor by a parser, with its `...`.
        let capped = format!("hi {}...", &DESCRIPTOR_PREFIX[..20]);
        assert_eq!(title_cut(&capped), Some(3));
        assert_eq!(title_cut("hi there"), None);
        assert_eq!(title_cut("a JSON {\"kind\":\"c..."), None);
    }
}
