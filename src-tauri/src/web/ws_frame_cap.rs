//! Size cap for the event socket's text frames.
//!
//! A frame carries whatever its event carries, and some events carry a lot: a
//! background-activity upsert re-sends a still-growing transcript turn whole on
//! every poll tick, tool output and file contents ride along verbatim, and an
//! attach snapshot or replay batches several of those at once. Nothing bounded
//! any of it, and a client with a message limit — `URLSessionWebSocketTask`
//! defaults to 1 MiB — loses its whole stream on the first frame past it
//! (`EMSGSIZE`, "Message too long").
//!
//! Every frame is serialized normally first and sent untouched when it fits,
//! which is all but a handful. One that does not is shrunk by cutting its
//! longest strings, and only those: keys, ids, numbers and the shape of every
//! object stay exactly as they were, so a client parses it like any other
//! frame. The cut is water-filled — one length, the largest that brings the
//! frame under the cap, applied to every string longer than it — so a single
//! huge tool output gives up its tail while every ordinary string in the same
//! frame, a plan awaiting approval or a question to the user, goes through
//! whole. Cut text ends with a marker saying so; base64 payloads (images) are
//! emptied instead, since half an image decodes to nothing.
//!
//! Only the live socket is capped. The desktop webview receives events through
//! Tauri, untouched, and every client loads the full content over HTTP when it
//! fetches the conversation — which is what the web client already does once
//! out-of-turn activity settles, and what the marker tells a reader to do.

use serde::Serialize;
use serde_json::Value;

/// Largest text frame the event socket sends: a quarter below the 1 MiB
/// default of `URLSessionWebSocketTask`, so a client on that default keeps its
/// stream with room for the frame header and for whatever a future field adds.
pub const MAX_FRAME_BYTES: usize = 768 * 1024;

/// Strings this short are never cut, however large the frame: ids, titles,
/// short messages. The cut length only comes down this far for a frame swollen
/// by a great many medium strings (a snapshot of a turn with hundreds of tool
/// calls); one long output keeps the cut length far above it. A frame that is
/// still too large at this length is sent at the size it came down to.
const MIN_KEPT_BYTES: usize = 256;

/// A frame that had to be cut to fit, for the caller's log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shrink {
    /// Serialized size before cutting.
    pub original_bytes: usize,
    /// Serialized size actually sent.
    pub sent_bytes: usize,
    /// Strings cut or emptied.
    pub fields: usize,
}

/// A serialized frame, and how it was cut if it had to be.
#[derive(Debug)]
pub struct Frame {
    pub text: String,
    pub shrunk: Option<Shrink>,
}

/// Serialize `msg` for the event socket, cut to [`MAX_FRAME_BYTES`].
pub fn to_frame_text<T: Serialize>(msg: &T) -> serde_json::Result<Frame> {
    to_frame_text_capped(msg, MAX_FRAME_BYTES)
}

fn to_frame_text_capped<T: Serialize>(msg: &T, cap: usize) -> serde_json::Result<Frame> {
    let text = serde_json::to_string(msg)?;
    if text.len() <= cap {
        return Ok(Frame { text, shrunk: None });
    }
    let original_bytes = text.len();
    drop(text);
    let mut value = serde_json::to_value(msg)?;
    let fields = shrink(&mut value, original_bytes, cap);
    let text = serde_json::to_string(&value)?;
    Ok(Frame {
        shrunk: Some(Shrink {
            original_bytes,
            sent_bytes: text.len(),
            fields,
        }),
        text,
    })
}

/// The marker that replaces the cut tail of a string. Plain ASCII so it reads
/// the same in every renderer, on its own paragraph so it does not run into the
/// text it follows.
fn marker(omitted: usize) -> String {
    format!(
        "\n\n[... {omitted} more bytes not sent to this live view; reload the conversation \
         to see all of it]"
    )
}

/// Serialized size of the longest marker [`marker`] can produce: the text plus
/// JSON's escaping of the two newlines, with room for any byte count.
fn max_marker_bytes() -> usize {
    marker(usize::MAX).len() + 2
}

/// Whether `s` is a base64 payload (or a data URL around one) rather than text.
/// Only asked of strings long enough to be cut, where an accidental match would
/// need hundreds of bytes without a single space or punctuation mark.
fn is_base64_payload(s: &str) -> bool {
    let body = match s.strip_prefix("data:") {
        Some(rest) => match rest.split_once(";base64,") {
            Some((_, body)) => body,
            None => return false,
        },
        None => s,
    };
    !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

/// One string the frame could give up, as the planner sees it.
struct Leaf {
    len: usize,
    base64: bool,
}

fn collect_leaves(value: &Value, out: &mut Vec<Leaf>) {
    match value {
        Value::String(s) if s.len() > MIN_KEPT_BYTES => out.push(Leaf {
            len: s.len(),
            base64: is_base64_payload(s),
        }),
        Value::Array(items) => items.iter().for_each(|item| collect_leaves(item, out)),
        Value::Object(map) => map.values().for_each(|item| collect_leaves(item, out)),
        _ => {}
    }
}

/// Bytes saved by cutting one string of `len` bytes to `keep`, and zero when
/// it is not to be cut. The single rule both the planner and [`cut`] follow, so
/// the planner's sum is exactly what the cut achieves at the least: a text cut
/// lands on a char boundary at or below `keep`, and escapes in the removed text
/// only make the real saving larger. Text is cut only where that beats the
/// marker it gains; a base64 payload is emptied whole.
fn saving(len: usize, base64: bool, keep: usize, marker_bytes: usize) -> usize {
    if len <= keep.max(MIN_KEPT_BYTES) {
        0
    } else if base64 {
        len
    } else {
        (len - keep).saturating_sub(marker_bytes)
    }
}

fn savings(leaves: &[Leaf], keep: usize, marker_bytes: usize) -> usize {
    leaves
        .iter()
        .map(|leaf| saving(leaf.len, leaf.base64, keep, marker_bytes))
        .sum()
}

/// The largest per-string length that saves at least `excess` bytes, or
/// [`MIN_KEPT_BYTES`] when even that does not.
fn keep_length(leaves: &[Leaf], excess: usize, marker_bytes: usize) -> usize {
    let mut lo = MIN_KEPT_BYTES;
    let mut hi = leaves
        .iter()
        .map(|leaf| leaf.len)
        .max()
        .unwrap_or(lo)
        .max(lo);
    if savings(leaves, lo, marker_bytes) < excess {
        return lo;
    }
    // Invariant: `lo` saves enough. Savings only fall as `keep` grows.
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if savings(leaves, mid, marker_bytes) >= excess {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

fn cut(value: &mut Value, keep: usize, marker_bytes: usize, fields: &mut usize) {
    match value {
        Value::String(s) => {
            let base64 = s.len() > MIN_KEPT_BYTES && is_base64_payload(s);
            if saving(s.len(), base64, keep, marker_bytes) == 0 {
                return;
            }
            if base64 {
                s.clear();
            } else {
                let mut end = keep;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                let omitted = s.len() - end;
                s.truncate(end);
                s.push_str(&marker(omitted));
            }
            *fields += 1;
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| cut(item, keep, marker_bytes, fields)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| cut(item, keep, marker_bytes, fields)),
        _ => {}
    }
}

/// Cut `value`'s longest strings until it serializes to `cap` bytes or less,
/// and return how many were cut. `serialized` is its current serialized size.
fn shrink(value: &mut Value, serialized: usize, cap: usize) -> usize {
    let marker_bytes = max_marker_bytes();
    let mut leaves = Vec::new();
    collect_leaves(value, &mut leaves);
    let excess = serialized.saturating_sub(cap);
    let keep = keep_length(&leaves, excess, marker_bytes);
    let mut fields = 0;
    cut(value, keep, marker_bytes, &mut fields);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(value: &Value) -> usize {
        serde_json::to_string(value).unwrap().len()
    }

    /// The common case costs nothing: a frame that fits is sent byte for byte.
    #[test]
    fn a_frame_that_fits_is_sent_untouched() {
        let msg = json!({"type": "event", "text": "x".repeat(10_000)});
        let frame = to_frame_text_capped(&msg, 64 * 1024).unwrap();
        assert!(frame.shrunk.is_none());
        assert_eq!(frame.text, serde_json::to_string(&msg).unwrap());
    }

    /// One huge string is cut to fit; everything else — the small strings, the
    /// numbers, the keys — arrives exactly as it was.
    #[test]
    fn one_huge_string_is_cut_to_fit_and_marked() {
        let cap = 64 * 1024;
        let msg = json!({
            "type": "event",
            "subscription_id": "sub-1",
            "envelope": {
                "seq": 42,
                "type": "tool_call_update",
                "tool_call_id": "toolu_01",
                "raw_output": "line of output\n".repeat(20_000),
                "title": "Read a big file",
            }
        });
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        let shrunk = frame.shrunk.expect("must be cut");
        assert!(frame.text.len() <= cap, "{} > {cap}", frame.text.len());
        assert_eq!(shrunk.sent_bytes, frame.text.len());
        assert_eq!(shrunk.fields, 1);

        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(sent["type"], "event");
        assert_eq!(sent["subscription_id"], "sub-1");
        assert_eq!(sent["envelope"]["seq"], 42);
        assert_eq!(sent["envelope"]["tool_call_id"], "toolu_01");
        assert_eq!(sent["envelope"]["title"], "Read a big file");
        let output = sent["envelope"]["raw_output"].as_str().unwrap();
        assert!(output.starts_with("line of output\nline of output\n"));
        assert!(
            output.ends_with("reload the conversation to see all of it]"),
            "{}",
            &output[output.len() - 200..]
        );
    }

    /// Water-filling: the longest strings give way first, and a moderately long
    /// one — a plan awaiting approval, say — is left whole when cutting the
    /// longest is enough.
    #[test]
    fn the_longest_strings_give_way_first() {
        let cap = 64 * 1024;
        let plan = "step\n".repeat(1_600); // 8 KB
        let msg = json!({
            "a": "a".repeat(300_000) + " ",
            "b": "b".repeat(200_000) + " ",
            "plan": plan,
        });
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        assert!(frame.text.len() <= cap);
        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(
            sent["plan"].as_str().unwrap(),
            plan,
            "the plan must arrive whole"
        );
        assert_eq!(frame.shrunk.unwrap().fields, 2);
        // Both long strings were cut to the same length.
        let a = sent["a"].as_str().unwrap();
        let b = sent["b"].as_str().unwrap();
        assert_eq!(
            a.split("\n\n[...").next().unwrap().len(),
            b.split("\n\n[...").next().unwrap().len()
        );
    }

    /// Half a base64 image decodes to nothing, so an oversized one is emptied
    /// rather than cut — and the text beside it keeps more of itself for it.
    #[test]
    fn a_base64_payload_is_emptied_not_cut() {
        let cap = 64 * 1024;
        let image = "iVBORw0KGgoAAAANSUhEUgAA".repeat(20_000);
        let msg = json!({
            "blocks": [
                {"type": "image", "data": image, "mime_type": "image/png"},
                {"type": "image", "data": format!("data:image/png;base64,{image}"), "mime_type": "image/png"},
                {"type": "text", "text": "a caption"},
            ]
        });
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        assert!(frame.text.len() <= cap);
        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(sent["blocks"][0]["data"], "");
        assert_eq!(sent["blocks"][1]["data"], "");
        assert_eq!(sent["blocks"][0]["mime_type"], "image/png");
        assert_eq!(sent["blocks"][2]["text"], "a caption");
    }

    /// Text with no spaces is still text if it has punctuation; it is cut and
    /// marked like any other.
    #[test]
    fn base64_detection_is_narrow() {
        assert!(is_base64_payload("QUJD+/=="));
        assert!(is_base64_payload("data:image/jpeg;base64,QUJD"));
        assert!(!is_base64_payload("data:text/plain,hello"));
        assert!(!is_base64_payload("{\"key\":\"value\"}"));
        assert!(!is_base64_payload("hello world"));
        assert!(!is_base64_payload(""));
    }

    /// A cut never splits a multi-byte character, so what is sent is still
    /// valid UTF-8 and still parses.
    #[test]
    fn a_cut_lands_on_a_char_boundary() {
        let cap = 32 * 1024;
        let msg = json!({"text": "שלום עולם 🌍 ".repeat(20_000)});
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        assert!(frame.text.len() <= cap);
        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert!(sent["text"].as_str().unwrap().starts_with("שלום"));
    }

    /// Escapes count: text full of quotes and newlines serializes far larger
    /// than its raw length, and the frame must still land under the cap.
    #[test]
    fn escape_heavy_text_still_fits() {
        let cap = 32 * 1024;
        let msg = json!({"text": "\"\\\n\t".repeat(50_000), "other": "\"".repeat(30_000)});
        assert!(size(&msg) > 400_000, "escaping doubles it");
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        assert!(frame.text.len() <= cap, "{} > {cap}", frame.text.len());
    }

    /// A frame swollen by a hundred-odd medium strings rather than one huge one
    /// — a snapshot of a long turn — still comes in under the cap, and a string
    /// only a little longer than the cut length is left alone rather than
    /// traded for a longer marker.
    #[test]
    fn many_medium_strings_still_fit() {
        let cap = 64 * 1024;
        let calls: Vec<Value> = (0..120)
            .map(|i| {
                json!({
                    "tool_call_id": format!("toolu_{i:04}"),
                    "output": "o".repeat(5_000),
                })
            })
            .collect();
        let msg = json!({"active_tool_calls": calls});
        assert!(size(&msg) > 8 * cap);
        let frame = to_frame_text_capped(&msg, cap).unwrap();
        assert!(frame.text.len() <= cap, "{} > {cap}", frame.text.len());
        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(sent["active_tool_calls"][119]["tool_call_id"], "toolu_0119");

        let marker_bytes = max_marker_bytes();
        assert_eq!(saving(1_000 + marker_bytes, false, 1_000, marker_bytes), 0);
        assert_eq!(saving(1_001 + marker_bytes, false, 1_000, marker_bytes), 1);
        assert_eq!(saving(MIN_KEPT_BYTES, true, 0, marker_bytes), 0);
    }

    /// The real shape, end to end: a background-activity upsert carrying a turn
    /// with a 2 MB tool output, inside the attach protocol's `event` frame,
    /// fits the real cap and still carries every id the client keys on.
    #[test]
    fn an_oversized_background_activity_event_fits_the_real_cap() {
        use crate::acp::types::{AcpEvent, EventEnvelope};
        use crate::models::message::MessageTurn;
        use crate::web::ws_attach::ServerMsg;
        use std::sync::Arc;

        // A turn the way the watcher re-emits it on every tick: what the agent
        // said, then a tool result two megabytes long.
        let turn: MessageTurn = serde_json::from_value(json!({
            "id": "bg-78721455-0",
            "role": "assistant",
            "timestamp": "2026-10-04T16:34:35Z",
            "blocks": [
                {"type": "text", "text": "Reading the file."},
                {"type": "text", "text": "0123456789abcdef ".repeat(120_000)},
            ],
        }))
        .unwrap();

        let msg = ServerMsg::Event {
            subscription_id: "sub-ios".into(),
            envelope: Arc::new(EventEnvelope {
                seq: 7,
                connection_id: "e003d95e".into(),
                payload: AcpEvent::BackgroundActivity {
                    session_id: "40d4a7de".into(),
                    turns: vec![turn],
                    outstanding: 4,
                    settled: vec![],
                    watermark: 79_991_152,
                },
            }),
        };
        let original = serde_json::to_string(&msg).unwrap().len();
        assert!(
            original > 1024 * 1024,
            "the fixture must reproduce the failure"
        );

        let frame = to_frame_text(&msg).unwrap();
        assert!(frame.text.len() <= MAX_FRAME_BYTES);
        assert!(frame.text.len() < 1024 * 1024);
        let sent: Value = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(sent["subscription_id"], "sub-ios");
        assert_eq!(sent["envelope"]["seq"], 7);
        assert_eq!(sent["envelope"]["connection_id"], "e003d95e");
        assert_eq!(sent["envelope"]["session_id"], "40d4a7de");
        assert_eq!(sent["envelope"]["watermark"], 79_991_152);
        assert_eq!(sent["envelope"]["outstanding"], 4);
        let turn = &sent["envelope"]["turns"][0];
        assert_eq!(turn["id"], "bg-78721455-0");
        assert_eq!(turn["blocks"][0]["text"], "Reading the file.");
        // The event's own type tag survives, so the client still routes it.
        assert_eq!(
            sent["envelope"]["type"],
            serde_json::to_value(&msg).unwrap()["envelope"]["type"]
        );
    }
}
