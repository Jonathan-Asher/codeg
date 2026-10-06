//! Size budget for the event socket's text frames, per client.
//!
//! A frame carries whatever its event carries, and some events carry a lot: a
//! background-activity upsert re-sends a still-growing transcript turn whole on
//! every poll tick, tool output and file contents ride along verbatim, images
//! travel as base64, and an attach snapshot or replay batches several of those
//! at once.
//!
//! Most clients take frames of any size. Browsers and the desktop's WebKit
//! have no message limit worth the name, so a web or remote-desktop window
//! gets every frame exactly as it was serialized. The iOS app's
//! `URLSessionWebSocketTask` does have one: 1 MiB by default, and a frame past
//! it kills the whole stream (`EMSGSIZE`, "Message too long"). An app that
//! raised its limit says so by offering a `codeg-max-frame.<bytes>`
//! subprotocol; an iOS client that offers none is held to the old default.
//! See [`FrameBudget::for_client`].
//!
//! A frame over its client's budget is shrunk in steps, each one only if the
//! one before was not enough, and never by dropping keys, ids, numbers or the
//! shape of any object, so the client parses it like any other frame:
//!
//! 1. **Images by reference.** Every base64 image (an object with `data` and an
//!    `image/*` `mime_type`, also inside JSON carried as a string) is kept in
//!    [`crate::web::live_images`]; its `data` becomes a small placeholder PNG
//!    and a `data_ref` field names the path that serves the real one. An image
//!    is never emptied: half an image decodes to nothing, and an empty one is
//!    a failed image on every client.
//! 2. **Finished tool payloads of a snapshot.** A snapshot's completed and
//!    failed tool calls lose `input` / `output` / `content` / `locations`, the
//!    same trim the snapshot itself applies past its own budget. Those results
//!    are durable in the transcript; the live reply's text is not touched.
//! 3. **Tool payload text, then any text,** cut to one water-filled length, the
//!    largest that brings the frame under budget, so one huge output gives up
//!    its tail while every ordinary string goes through whole. A string that
//!    holds JSON is cut inside, string by string, and written back as valid
//!    JSON. Cut text ends with a marker.
//!
//! Every frame that was shrunk says so at the top level (`"frame_cut": true`),
//! so a client that knows the field reloads the conversation over HTTP — which
//! always carries everything — instead of keeping the shrunk copy. An event
//! frame still too large for the client after all of that is replaced by a
//! small `frame_dropped` event (same subscription and sequence number) rather
//! than killing the client's stream.
//!
//! Only the live socket is budgeted. The desktop webview receives events
//! through Tauri, untouched, and the HTTP conversation detail is never cut.

use serde::Serialize;
use serde_json::{Map, Value};

use super::live_images::LiveImageStore;
use crate::presence::IOS_CLIENT_PROTOCOL;

/// Subprotocol prefix a client offers to state the largest text frame it
/// accepts, e.g. `codeg-max-frame.67108864`.
pub const MAX_FRAME_PROTOCOL_PREFIX: &str = "codeg-max-frame.";

/// The default message limit of `URLSessionWebSocketTask`.
pub const IOS_DEFAULT_MESSAGE_LIMIT: usize = 1024 * 1024;

/// Budget for an iOS client that announced no limit: a quarter below its 1 MiB
/// default, leaving room for the frame header and whatever a field adds.
pub const LEGACY_IOS_FRAME_BYTES: usize = IOS_DEFAULT_MESSAGE_LIMIT / 4 * 3;

/// Smallest budget an announcement can set. Anything lower is a mistake, and
/// honoring it would cut ordinary frames.
const MIN_ANNOUNCED_FRAME_BYTES: usize = 64 * 1024;

/// Strings this short are never cut, however large the frame: ids, titles,
/// short messages.
const MIN_KEPT_BYTES: usize = 256;

/// Images at most this long (base64) stay inline: a reference and placeholder
/// would cost about as much.
const INLINE_IMAGE_MAX: usize = 1024;

/// Placeholder an image moved out of a frame carries in `data`: a small grey
/// picture glyph (96 x 72 PNG), so a client that cannot follow `data_ref`
/// shows a picture-shaped stand-in rather than an image that failed to decode.
pub const IMAGE_PLACEHOLDER_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAYAAAAJZ/BjAAABlElEQVR42u2dMXLDMAwEqRs/Kp9K49EzMG7yqTwrrePEI0cReRCxV8psdAsSEMwhW0NWLVsDbrePT2zar+v1/W0XAIwfA2J50fwVC3cptiAsG+Zj/MEgHiEsT8zH+I4g7iGINX+87r3WL78T/f30w1sR/d5ZIKLfOwuEH14BAAAAQEZdsOB7u2B0MSLM/9NzAAwwfygEYb4XgjDfC4EqiDIUAAgAAGiVe/IHjwfAgaauzAAfhJUlyAdhpRmXNycwA6iCUAkAAQC/+QEAf+QHAFiOygAose5nBRAV4ajwX4QBAJ9xaaosndTQmKXK0omjOWZI8ppkKfnv2CAH9IUQWWeHCtT7kXmJ0iTmH7nHM2YGEI0ekg1AtPN0UdkdncC8qXZHR3GYVgDBjPIBKNdeJgecLJBE9HvfR5jvfS9hvvf9yAGTJeEqVU9kBFCt5Ixsu6M5a4gcAAAEAAAgAJwXAN3LweWrWts+Yh21bqepiw8q78ebXr1oAPW5S4Dj6zMdX88FDgkucOA4+wRXmABi3CU+yKwvys1ozj50wxIAAAAASUVORK5CYII=";

/// Key a shrunk frame carries at its top level.
pub const FRAME_CUT_KEY: &str = "frame_cut";

/// Keys whose strings are tool payload: what a tool read, ran or returned.
/// Cut before any other text, because the transcript holds all of it.
const TOOL_PAYLOAD_KEYS: &[&str] = &[
    "active_tool_calls",
    "raw_output",
    "raw_input",
    "output",
    "input",
    "output_preview",
    "input_preview",
    "locations",
];

/// The largest text frame one client accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameBudget(Option<usize>);

impl FrameBudget {
    /// No limit: every frame goes out as serialized.
    pub const UNBOUNDED: FrameBudget = FrameBudget(None);

    /// A fixed budget (tests, and the legacy iOS default).
    pub const fn bytes(max: usize) -> FrameBudget {
        FrameBudget(Some(max))
    }

    /// The budget for a socket, from the subprotocols it offered.
    ///
    /// * `codeg-max-frame.<n>` — the client's own limit; frames are kept to
    ///   three quarters of it.
    /// * `codeg-client.ios` without an announcement — an iOS app on the
    ///   `URLSessionWebSocketTask` default of 1 MiB (codeg-ios 1.3.4 and older).
    /// * anything else — a browser or desktop window: no budget.
    pub fn for_client(protocols: Option<&str>) -> FrameBudget {
        let offered = || {
            protocols
                .into_iter()
                .flat_map(|v| v.split(','))
                .map(str::trim)
        };
        let announced = offered()
            .filter_map(|p| p.strip_prefix(MAX_FRAME_PROTOCOL_PREFIX))
            .filter_map(|n| n.parse::<usize>().ok())
            .max();
        if let Some(limit) = announced {
            return FrameBudget(Some((limit / 4 * 3).max(MIN_ANNOUNCED_FRAME_BYTES)));
        }
        if offered().any(|p| p == IOS_CLIENT_PROTOCOL) {
            return FrameBudget(Some(LEGACY_IOS_FRAME_BYTES));
        }
        FrameBudget::UNBOUNDED
    }

    pub fn limit(self) -> Option<usize> {
        self.0
    }

    /// What the client itself rejects: the budget plus the headroom it keeps.
    fn hard_limit(self) -> Option<usize> {
        self.0.map(|b| b / 3 * 4)
    }
}

/// How a frame was shrunk, for the caller's log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Shrink {
    /// Serialized size before shrinking.
    pub original_bytes: usize,
    /// Serialized size actually sent.
    pub sent_bytes: usize,
    /// Images moved out by reference.
    pub images: usize,
    /// Finished tool calls whose payload a snapshot left out.
    pub tool_payloads: usize,
    /// Strings cut.
    pub fields: usize,
    /// Still too large for the client: replaced by a `frame_dropped` event.
    pub dropped: bool,
}

/// A serialized frame, and how it was shrunk if it had to be.
#[derive(Debug)]
pub struct Frame {
    pub text: String,
    pub shrunk: Option<Shrink>,
}

/// Serialize `msg` for a client with `budget`, keeping images it cannot carry
/// in `images`.
pub fn to_frame_text<T: Serialize>(
    msg: &T,
    budget: FrameBudget,
    images: &LiveImageStore,
) -> serde_json::Result<Frame> {
    let text = serde_json::to_string(msg)?;
    let Some(cap) = budget.limit() else {
        return Ok(Frame { text, shrunk: None });
    };
    if text.len() <= cap {
        return Ok(Frame { text, shrunk: None });
    }
    let original_bytes = text.len();
    drop(text);
    let mut value = serde_json::to_value(msg)?;
    // Leave room for the `frame_cut` flag added below.
    let target = cap.saturating_sub(FRAME_CUT_KEY.len() + 8);
    let mut shrink = shrink(&mut value, original_bytes, target, images);
    if let Value::Object(map) = &mut value {
        map.insert(FRAME_CUT_KEY.to_string(), Value::Bool(true));
    }
    let mut text = serde_json::to_string(&value)?;
    if budget.hard_limit().is_some_and(|hard| text.len() > hard) {
        if let Some(notice) = dropped_event(&value) {
            shrink.dropped = true;
            text = serde_json::to_string(&notice)?;
        }
    }
    shrink.original_bytes = original_bytes;
    shrink.sent_bytes = text.len();
    Ok(Frame {
        text,
        shrunk: Some(shrink),
    })
}

/// A small stand-in for an attach `event` frame no shrinking could fit: the
/// same subscription and sequence number, an event type no client acts on, and
/// `frame_cut` so a client that knows it reloads. Snapshots, replays and the
/// legacy broadcast shape get none — they are sent as small as they came down.
fn dropped_event(frame: &Value) -> Option<Value> {
    let map = frame.as_object()?;
    if map.get("type")?.as_str()? != "event" {
        return None;
    }
    let envelope = map.get("envelope")?.as_object()?;
    let mut out_env = Map::new();
    for key in ["seq", "connection_id", "session_id", "conversation_id"] {
        if let Some(v) = envelope.get(key) {
            out_env.insert(key.to_string(), v.clone());
        }
    }
    out_env.insert("type".into(), Value::String("frame_dropped".into()));
    if let Some(t) = envelope.get("type") {
        out_env.insert("dropped_type".into(), t.clone());
    }
    let mut out = Map::new();
    out.insert("type".into(), Value::String("event".into()));
    if let Some(sub) = map.get("subscription_id") {
        out.insert("subscription_id".into(), sub.clone());
    }
    out.insert("envelope".into(), Value::Object(out_env));
    out.insert(FRAME_CUT_KEY.into(), Value::Bool(true));
    Some(Value::Object(out))
}

fn size(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

/// Shrink `value` (serialized at `serialized` bytes) toward `cap`.
fn shrink(value: &mut Value, serialized: usize, cap: usize, images: &LiveImageStore) -> Shrink {
    let mut report = Shrink {
        images: move_images(value, images),
        ..Shrink::default()
    };
    let mut current = if report.images > 0 {
        size(value)
    } else {
        serialized
    };
    if current <= cap {
        return report;
    }

    if is_snapshot(value) {
        report.tool_payloads = trim_finished_tool_payloads(value);
        if report.tool_payloads > 0 {
            current = size(value);
            if current <= cap {
                return report;
            }
        }
    }

    for tier in [Tier::ToolPayload, Tier::Any] {
        // The planner is exact for plain strings and close for JSON carried in
        // strings (escaping, re-serialization); re-measure and go again.
        for _ in 0..4 {
            if current <= cap {
                return report;
            }
            let mut leaves = Vec::new();
            collect_leaves(value, tier, false, &mut leaves);
            if leaves.is_empty() {
                break;
            }
            let keep = keep_length(&leaves, current - cap, max_marker_bytes());
            let mut fields = 0;
            cut(value, tier, false, keep, max_marker_bytes(), &mut fields);
            if fields == 0 {
                break;
            }
            report.fields += fields;
            current = size(value);
            if keep <= MIN_KEPT_BYTES {
                break;
            }
        }
    }
    report
}

fn is_snapshot(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("snapshot")
}

// ── images ──────────────────────────────────────────────────────────────────

fn mime_of(map: &Map<String, Value>) -> Option<&str> {
    map.get("mime_type")
        .or_else(|| map.get("mimeType"))
        .and_then(Value::as_str)
}

/// Move every sizeable base64 image in `value` into `images`, leaving the
/// placeholder and a `data_ref`. Returns how many were moved.
fn move_images(value: &mut Value, images: &LiveImageStore) -> usize {
    match value {
        Value::Object(map) => {
            let mut moved = 0;
            let image = mime_of(map)
                .filter(|m| m.starts_with("image/"))
                .map(str::to_owned)
                .zip(
                    map.get("data")
                        .and_then(Value::as_str)
                        .filter(|d| d.len() > INLINE_IMAGE_MAX && is_base64_payload(d))
                        .map(str::to_owned),
                );
            let is_image = image.is_some();
            if let Some((mime, data)) = image {
                if let Some(path) = images.put(&data, &mime) {
                    map.insert("data".into(), Value::String(IMAGE_PLACEHOLDER_PNG.into()));
                    map.insert("data_ref".into(), Value::String(path));
                    moved += 1;
                }
            }
            for (key, child) in map.iter_mut() {
                if key == "data" && is_image {
                    continue;
                }
                moved += move_images(child, images);
            }
            moved
        }
        Value::Array(items) => items.iter_mut().map(|v| move_images(v, images)).sum(),
        Value::String(s) if s.len() > INLINE_IMAGE_MAX => {
            if let Some(path) = data_url_image(s).and_then(|(mime, body)| images.put(body, mime)) {
                *s = path;
                return 1;
            }
            let Some(mut inner) = embedded_json(s) else {
                return 0;
            };
            let moved = move_images(&mut inner, images);
            if moved > 0 {
                if let Ok(text) = serde_json::to_string(&inner) {
                    *s = text;
                }
            }
            moved
        }
        _ => 0,
    }
}

/// `(mime, base64 body)` of a `data:image/...;base64,` URL.
fn data_url_image(s: &str) -> Option<(&str, &str)> {
    let rest = s.strip_prefix("data:")?;
    let (mime, body) = rest.split_once(";base64,")?;
    (mime.starts_with("image/") && is_base64_payload(body)).then_some((mime, body))
}

/// A JSON object or array carried as a string (tool input/output often is).
fn embedded_json(s: &str) -> Option<Value> {
    let t = s.trim_start();
    if !(t.starts_with('{') || t.starts_with('[')) {
        return None;
    }
    match serde_json::from_str::<Value>(s) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => Some(v),
        _ => None,
    }
}

/// Whether `s` is a base64 payload rather than text. Only asked of strings long
/// enough to matter, where an accidental match would need hundreds of bytes
/// without a single space or punctuation mark.
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

// ── finished tool payloads (snapshots) ──────────────────────────────────────

fn trim_finished_tool_payloads(value: &mut Value) -> usize {
    let Some(calls) = value
        .get_mut("snapshot")
        .and_then(|s| s.get_mut("active_tool_calls"))
        .and_then(Value::as_array_mut)
    else {
        return 0;
    };
    let mut trimmed = 0;
    for call in calls.iter_mut() {
        let Some(map) = call.as_object_mut() else {
            continue;
        };
        let finished = matches!(
            map.get("status").and_then(Value::as_str),
            Some("completed" | "failed")
        );
        if !finished {
            continue;
        }
        let mut any = false;
        for key in ["input", "output", "content", "locations"] {
            if map.get(key).is_some_and(|v| !v.is_null()) {
                map.insert(key.to_string(), Value::Null);
                any = true;
            }
        }
        if any {
            trimmed += 1;
        }
    }
    trimmed
}

// ── text ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    /// Only strings under a tool payload key.
    ToolPayload,
    /// Every string.
    Any,
}

impl Tier {
    fn admits(self, in_tool_payload: bool) -> bool {
        match self {
            Tier::ToolPayload => in_tool_payload,
            Tier::Any => true,
        }
    }
}

/// Whether a child of `map` under `key` holds tool payload.
fn tool_payload_child(map: &Map<String, Value>, key: &str) -> bool {
    TOOL_PAYLOAD_KEYS.contains(&key) || (key == "content" && map.contains_key("tool_call_id"))
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

/// One string the frame could give up, as the planner sees it.
struct Leaf {
    len: usize,
}

fn collect_leaves(value: &Value, tier: Tier, in_payload: bool, out: &mut Vec<Leaf>) {
    match value {
        Value::String(s) if s.len() > MIN_KEPT_BYTES => {
            if !tier.admits(in_payload) {
                // A JSON document under a non-payload key can still hold
                // payload keys of its own.
                if let Some(inner) = embedded_json(s) {
                    collect_leaves(&inner, tier, in_payload, out);
                }
                return;
            }
            match embedded_json(s) {
                Some(inner) => collect_leaves(&inner, tier, in_payload, out),
                None => out.push(Leaf { len: s.len() }),
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_leaves(item, tier, in_payload, out)),
        Value::Object(map) => map.iter().for_each(|(k, item)| {
            let payload = in_payload || tool_payload_child(map, k);
            // An image's placeholder and reference are never text to cut.
            if (k == "data" || k == "data_ref") && map.contains_key("data_ref") {
                return;
            }
            collect_leaves(item, tier, payload, out)
        }),
        _ => {}
    }
}

/// Bytes saved by cutting one string of `len` bytes to `keep`, and zero when
/// it is not to be cut. Text is cut only where that beats the marker it gains.
fn saving(len: usize, keep: usize, marker_bytes: usize) -> usize {
    if len <= keep.max(MIN_KEPT_BYTES) {
        0
    } else {
        (len - keep).saturating_sub(marker_bytes)
    }
}

fn savings(leaves: &[Leaf], keep: usize, marker_bytes: usize) -> usize {
    leaves
        .iter()
        .map(|leaf| saving(leaf.len, keep, marker_bytes))
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

fn cut(
    value: &mut Value,
    tier: Tier,
    in_payload: bool,
    keep: usize,
    marker_bytes: usize,
    fields: &mut usize,
) {
    match value {
        Value::String(s) if s.len() > MIN_KEPT_BYTES => {
            if let Some(mut inner) = embedded_json(s) {
                let before = *fields;
                cut(&mut inner, tier, in_payload, keep, marker_bytes, fields);
                if *fields > before {
                    if let Ok(text) = serde_json::to_string(&inner) {
                        *s = text;
                    }
                }
                return;
            }
            if !tier.admits(in_payload) || saving(s.len(), keep, marker_bytes) == 0 {
                return;
            }
            let mut end = keep;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            let omitted = s.len() - end;
            s.truncate(end);
            s.push_str(&marker(omitted));
            *fields += 1;
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| cut(item, tier, in_payload, keep, marker_bytes, fields)),
        Value::Object(map) => {
            let is_ref_image = map.contains_key("data_ref");
            let payload_keys: Vec<bool> = map
                .keys()
                .map(|k| in_payload || tool_payload_child(map, k))
                .collect();
            for ((k, item), payload) in map.iter_mut().zip(payload_keys) {
                if is_ref_image && (k == "data" || k == "data_ref") {
                    continue;
                }
                cut(item, tier, payload, keep, marker_bytes, fields);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> LiveImageStore {
        // A private store per test: tests run in parallel.
        super::super::live_images::tests_support::store()
    }

    fn frame(msg: &Value, cap: usize) -> Frame {
        to_frame_text(msg, FrameBudget::bytes(cap), &store()).unwrap()
    }

    fn big_png() -> String {
        // Valid base64 the store accepts; the bytes need not be a real PNG.
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(vec![0x89u8; 300_000])
    }

    /// The common case costs nothing: a frame that fits is sent byte for byte.
    #[test]
    fn a_frame_that_fits_is_sent_untouched() {
        let msg = json!({"type": "event", "text": "x".repeat(10_000)});
        let f = frame(&msg, 64 * 1024);
        assert!(f.shrunk.is_none());
        assert_eq!(f.text, serde_json::to_string(&msg).unwrap());
    }

    /// A browser or desktop window has no budget: even a 3 MB snapshot full
    /// of images goes out exactly as serialized.
    #[test]
    fn a_window_client_is_never_cut() {
        let budget = FrameBudget::for_client(Some("codeg-events, codeg-token.abc"));
        assert_eq!(budget, FrameBudget::UNBOUNDED);
        let msg = json!({
            "type": "snapshot",
            "snapshot": {"active_tool_calls": [{"id": "t1", "images": [
                {"data": big_png(), "mime_type": "image/png"}
            ]}]},
            "text": "y".repeat(3_000_000),
        });
        let f = to_frame_text(&msg, budget, &store()).unwrap();
        assert!(f.shrunk.is_none());
        assert_eq!(f.text, serde_json::to_string(&msg).unwrap());
    }

    #[test]
    fn budgets_follow_what_the_client_offered() {
        assert_eq!(
            FrameBudget::for_client(Some("codeg-events, codeg-token.x, codeg-client.ios")),
            FrameBudget::bytes(LEGACY_IOS_FRAME_BYTES),
            "an iOS app that announced nothing is on the 1 MiB default"
        );
        assert_eq!(
            FrameBudget::for_client(Some(
                "codeg-events, codeg-client.ios, codeg-max-frame.67108864"
            )),
            FrameBudget::bytes(67108864 / 4 * 3),
        );
        assert_eq!(
            FrameBudget::for_client(Some("codeg-events, codeg-max-frame.10")),
            FrameBudget::bytes(MIN_ANNOUNCED_FRAME_BYTES),
            "a nonsense announcement cannot make ordinary frames cut"
        );
        assert_eq!(FrameBudget::for_client(None), FrameBudget::UNBOUNDED);
    }

    /// The shape behind the 417-byte frame of 2026-10-06: an image the user
    /// pasted, echoed in a `user_message` event. It used to be emptied; now the
    /// frame keeps a placeholder and a reference the client can load, and is
    /// marked as shrunk.
    #[test]
    fn an_image_is_moved_out_by_reference_not_emptied() {
        let images = store();
        let image = big_png();
        let msg = json!({
            "type": "event",
            "subscription_id": "sub-ios",
            "envelope": {
                "seq": 12, "connection_id": "c1", "type": "user_message",
                "blocks": [
                    {"type": "image", "data": image, "mime_type": "image/png"},
                    {"type": "text", "text": "what is wrong here?"},
                ],
            }
        });
        let f = to_frame_text(&msg, FrameBudget::bytes(64 * 1024), &images).unwrap();
        let shrunk = f.shrunk.unwrap();
        assert_eq!(shrunk.images, 1);
        assert_eq!(shrunk.fields, 0, "nothing else needed cutting");
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(sent[FRAME_CUT_KEY], true);
        let block = &sent["envelope"]["blocks"][0];
        assert_eq!(block["data"], IMAGE_PLACEHOLDER_PNG);
        assert_eq!(block["mime_type"], "image/png");
        let path = block["data_ref"].as_str().unwrap();
        let key = path
            .strip_prefix(super::super::live_images::LIVE_IMAGE_PATH_PREFIX)
            .unwrap();
        let (mime, bytes) = images.get(key).expect("the image is served by reference");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes.len(), 300_000);
        assert_eq!(sent["envelope"]["blocks"][1]["text"], "what is wrong here?");
    }

    /// A snapshot of an image-heavy turn: the images go by reference and the
    /// live reply's text arrives whole.
    #[test]
    fn a_snapshot_keeps_its_reply_text_and_structure() {
        let reply = "The logo now sits 24 px from the edge.\n".repeat(200); // 7.8 KB
        let calls: Vec<Value> = (0..4)
            .map(|i| {
                json!({
                    "id": format!("toolu_{i}"), "kind": "read", "label": "Read logo.png",
                    "status": "completed", "input": {"file_path": "/x/logo.png"},
                    "output": null, "content": null, "meta": null,
                    "images": [{"data": big_png(), "mime_type": "image/png"}],
                })
            })
            .collect();
        let msg = json!({
            "type": "snapshot", "subscription_id": "s", "connection_id": "c", "event_seq": 9,
            "snapshot": {
                "status": "prompting",
                "live_message": {"id": "live-1", "role": "assistant", "content": [
                    {"type": "text", "text": reply},
                    {"type": "tool_call_ref", "tool_call_id": "toolu_0"},
                ]},
                "active_tool_calls": calls,
            }
        });
        assert!(size(&msg) > 1_200_000);
        let f = frame(&msg, LEGACY_IOS_FRAME_BYTES);
        assert!(f.text.len() <= LEGACY_IOS_FRAME_BYTES);
        let shrunk = f.shrunk.unwrap();
        assert_eq!(shrunk.images, 4);
        assert_eq!(shrunk.fields, 0);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(
            sent["snapshot"]["live_message"]["content"][0]["text"],
            reply
        );
        let tools = sent["snapshot"]["active_tool_calls"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        for t in tools {
            assert!(t["images"][0]["data_ref"]
                .as_str()
                .unwrap()
                .starts_with("/api/live_image/"));
            assert_eq!(t["label"], "Read logo.png");
        }
    }

    /// Past the images, a snapshot drops finished tool payloads before it cuts
    /// any text, and a running call keeps everything.
    #[test]
    fn a_snapshot_drops_finished_tool_payloads_before_cutting_text() {
        let reply = "Here is the plan.\n".repeat(500);
        let mut calls: Vec<Value> = (0..30)
            .map(|i| {
                json!({
                    "id": format!("toolu_{i:02}"), "kind": "execute", "label": "Bash",
                    "status": "completed", "input": {"command": "ls"},
                    "output": {"type": "text", "text": "o".repeat(40_000)},
                    "content": "c".repeat(1_000), "locations": null, "meta": null, "images": [],
                })
            })
            .collect();
        calls.push(json!({
            "id": "toolu_live", "kind": "execute", "label": "Bash", "status": "in_progress",
            "input": {"command": "make"}, "output": {"type": "text", "text": "building\n".repeat(100)},
            "content": null, "locations": null, "meta": null, "images": [],
        }));
        let msg = json!({
            "type": "snapshot", "subscription_id": "s", "connection_id": "c", "event_seq": 9,
            "snapshot": {
                "live_message": {"content": [{"type": "text", "text": reply}]},
                "active_tool_calls": calls,
            }
        });
        let f = frame(&msg, LEGACY_IOS_FRAME_BYTES);
        assert!(f.text.len() <= LEGACY_IOS_FRAME_BYTES);
        let shrunk = f.shrunk.unwrap();
        assert_eq!(shrunk.tool_payloads, 30);
        assert_eq!(shrunk.fields, 0, "no text needed cutting");
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(
            sent["snapshot"]["live_message"]["content"][0]["text"],
            reply
        );
        assert!(sent["snapshot"]["active_tool_calls"][0]["output"].is_null());
        assert_eq!(sent["snapshot"]["active_tool_calls"][0]["label"], "Bash");
        assert_eq!(
            sent["snapshot"]["active_tool_calls"][30]["output"]["text"],
            "building\n".repeat(100),
            "a running call keeps its output"
        );
    }

    /// One huge tool output is cut to fit; everything else — the small strings,
    /// the numbers, the keys, the agent's own text — arrives exactly as it was.
    #[test]
    fn tool_output_is_cut_before_the_agent_text() {
        let cap = 64 * 1024;
        let said = "I read the file and found the bug. ".repeat(500); // 17.5 KB
        let msg = json!({
            "type": "event",
            "subscription_id": "sub-1",
            "envelope": {
                "seq": 42,
                "type": "tool_call_update",
                "tool_call_id": "toolu_01",
                "raw_output": "line of output\n".repeat(20_000),
                "title": "Read a big file",
                "said": said,
            }
        });
        let f = frame(&msg, cap);
        let shrunk = f.shrunk.expect("must be cut");
        assert!(f.text.len() <= cap, "{} > {cap}", f.text.len());
        assert_eq!(shrunk.fields, 1);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(sent["envelope"]["seq"], 42);
        assert_eq!(sent["envelope"]["tool_call_id"], "toolu_01");
        assert_eq!(sent["envelope"]["title"], "Read a big file");
        assert_eq!(
            sent["envelope"]["said"], said,
            "the agent's text is not touched"
        );
        let output = sent["envelope"]["raw_output"].as_str().unwrap();
        assert!(output.starts_with("line of output\nline of output\n"));
        assert!(output.ends_with("reload the conversation to see all of it]"));
    }

    /// JSON carried in a string is cut inside and stays valid JSON, so a client
    /// that parses a tool's output still can.
    #[test]
    fn json_inside_a_string_stays_valid() {
        let cap = 32 * 1024;
        let inner = json!({"start_line": 1, "content": "fn main() {}\n".repeat(20_000)});
        let msg = json!({
            "type": "event",
            "envelope": {"type": "tool_call_update", "tool_call_id": "t",
                         "raw_output": serde_json::to_string(&inner).unwrap()},
        });
        let f = frame(&msg, cap);
        assert!(f.text.len() <= cap, "{} > {cap}", f.text.len());
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        let raw = sent["envelope"]["raw_output"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(raw).expect("still JSON");
        assert_eq!(parsed["start_line"], 1);
        assert!(parsed["content"]
            .as_str()
            .unwrap()
            .starts_with("fn main() {}"));
    }

    /// An image inside JSON carried as a string is found and moved out too.
    #[test]
    fn an_image_inside_embedded_json_is_moved_out() {
        let images = store();
        let payload =
            json!({"result": [{"type": "image", "data": big_png(), "mimeType": "image/jpeg"}]});
        let msg = json!({
            "type": "event",
            "envelope": {"type": "tool_call_update", "tool_call_id": "t",
                         "raw_output": serde_json::to_string(&payload).unwrap()},
        });
        let f = to_frame_text(&msg, FrameBudget::bytes(64 * 1024), &images).unwrap();
        assert_eq!(f.shrunk.unwrap().images, 1);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        let inner: Value =
            serde_json::from_str(sent["envelope"]["raw_output"].as_str().unwrap()).unwrap();
        assert!(inner["result"][0]["data_ref"].as_str().is_some());
        assert_eq!(inner["result"][0]["mimeType"], "image/jpeg");
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
        let f = frame(&msg, cap);
        assert!(f.text.len() <= cap);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(
            sent["plan"].as_str().unwrap(),
            plan,
            "the plan must arrive whole"
        );
        assert_eq!(f.shrunk.unwrap().fields, 2);
    }

    /// A cut never splits a multi-byte character.
    #[test]
    fn a_cut_lands_on_a_char_boundary() {
        let cap = 32 * 1024;
        let msg = json!({"text": "שלום עולם 🌍 ".repeat(20_000)});
        let f = frame(&msg, cap);
        assert!(f.text.len() <= cap);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert!(sent["text"].as_str().unwrap().starts_with("שלום"));
    }

    /// Escapes count: text full of quotes and newlines serializes far larger
    /// than its raw length, and the frame must still land under the cap.
    #[test]
    fn escape_heavy_text_still_fits() {
        let cap = 32 * 1024;
        let msg = json!({"text": "\"\\\n\t".repeat(50_000), "other": "\"".repeat(30_000)});
        let f = frame(&msg, cap);
        assert!(f.text.len() <= cap, "{} > {cap}", f.text.len());
    }

    /// An event no shrinking can fit is replaced by a small notice the client
    /// can see, instead of a frame that would kill its stream.
    #[test]
    fn an_event_that_cannot_fit_is_replaced_by_a_notice() {
        let cap = 64 * 1024;
        // Thousands of distinct short ids: nothing to cut below the floor.
        let ids: Vec<Value> = (0..20_000)
            .map(|i| json!({"id": format!("item-{i:06}")}))
            .collect();
        let msg = json!({
            "type": "event", "subscription_id": "sub-9",
            "envelope": {"seq": 77, "connection_id": "c", "type": "available_commands", "commands": ids},
        });
        let f = frame(&msg, cap);
        let shrunk = f.shrunk.unwrap();
        assert!(shrunk.dropped);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(sent["subscription_id"], "sub-9");
        assert_eq!(sent["envelope"]["seq"], 77);
        assert_eq!(sent["envelope"]["type"], "frame_dropped");
        assert_eq!(sent["envelope"]["dropped_type"], "available_commands");
        assert_eq!(sent[FRAME_CUT_KEY], true);
    }

    /// The real shape, end to end: a background-activity upsert carrying a turn
    /// with a 2 MB tool output, sent to an iOS app on the 1 MiB default.
    #[test]
    fn an_oversized_background_activity_event_fits_the_legacy_budget() {
        use crate::acp::types::{AcpEvent, EventEnvelope};
        use crate::models::message::MessageTurn;
        use crate::web::ws_attach::ServerMsg;
        use std::sync::Arc;

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
        let budget = FrameBudget::for_client(Some("codeg-events, codeg-client.ios"));
        let f = to_frame_text(&msg, budget, &store()).unwrap();
        assert!(f.text.len() <= LEGACY_IOS_FRAME_BYTES);
        let sent: Value = serde_json::from_str(&f.text).unwrap();
        assert_eq!(sent["subscription_id"], "sub-ios");
        assert_eq!(sent["envelope"]["seq"], 7);
        assert_eq!(sent["envelope"]["watermark"], 79_991_152);
        let turn = &sent["envelope"]["turns"][0];
        assert_eq!(turn["id"], "bg-78721455-0");
        assert_eq!(turn["blocks"][0]["text"], "Reading the file.");
        assert_eq!(sent[FRAME_CUT_KEY], true);
    }

    #[test]
    fn base64_detection_is_narrow() {
        assert!(is_base64_payload("QUJD+/=="));
        assert!(is_base64_payload("data:image/jpeg;base64,QUJD"));
        assert!(!is_base64_payload("data:text/plain,hello"));
        assert!(!is_base64_payload("{\"key\":\"value\"}"));
        assert!(!is_base64_payload("hello world"));
        assert!(!is_base64_payload(""));
    }

    /// The placeholder is a real, decodable PNG.
    #[test]
    fn the_placeholder_is_a_png() {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(IMAGE_PLACEHOLDER_PNG)
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
