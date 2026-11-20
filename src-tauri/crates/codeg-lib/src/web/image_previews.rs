//! History pictures as small previews, for clients on a slow link.
//!
//! Once tools return screenshots, a session's history is mostly pictures: a
//! `Read` of a PNG or a browser screenshot comes back as a base64 image inside
//! its tool result, and the phone's history read fetches the last turns again
//! on every open. One session's last 20 turns were 1.8 MB, 97% of it three
//! screenshots, all of it over mobile data before the new messages showed.
//!
//! A client that asks for it (`imagePreviews: true` on
//! `get_folder_conversation` and `get_folder_conversation_turns`) gets every
//! inline image larger than [`KEEP_INLINE_MAX`] as a small JPEG instead, with
//! a `full_image` object beside it that says what the picture is and where the
//! whole of it is served:
//!
//! ```json
//! { "data": "<base64 JPEG preview>", "mime_type": "image/jpeg",
//!   "full_image": { "ref": "/api/conversation_image/237/<id>", "id": "<id>",
//!                   "mime_type": "image/png", "bytes": 612345,
//!                   "width": 1920, "height": 1080 } }
//! ```
//!
//! - The preview is at most 512 pixels on its long side and aims at 20 KB.
//! - `data` and `mime_type` always describe the bytes sent inline. A picture
//!   this server cannot decode (a format the `image` crate here lacks) is sent
//!   as the small placeholder glyph instead, with `full_image.placeholder:
//!   true`, and its size when the header gave one.
//! - `id` is a content hash of the picture as the transcript stores it, so it
//!   is the same on every read and across restarts. `ref` is the path, relative
//!   to the server's origin, that serves the full picture to an authenticated
//!   request ([`serve_conversation_image`]).
//! - Images are found wherever an object pairs a base64 `data` with an
//!   `image/*` `mime_type` (`mimeType` too): tool results, attachments,
//!   generated images. Also inside JSON carried as a string, and as
//!   whole-string `data:image/…;base64,` URLs, which become the preview's data
//!   URL (a string has nowhere to carry a reference).
//! - Without the flag nothing here runs, and the response is byte for byte the
//!   one it always was: the desktop, the web UI and older phones never see a
//!   preview.
//!
//! Previews are kept in memory by id ([`PreviewCache`]), so a session opened
//! again costs one hash per picture, not a decode. `/api/health` advertises the
//! capability as `imagePreviews`: [`IMAGE_PREVIEWS_VERSION`].

use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Extension, Path as AxumPath},
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageEncoder, ImageReader, Limits, RgbImage};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::ws_frame_cap::IMAGE_PLACEHOLDER_PNG;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::models::message::{ContentBlock, ImageData, MessageTurn};

/// The version `/api/health` advertises as `imagePreviews`. A client sends the
/// opt-in to any server (an older one ignores the field); this tells it the
/// full-image path exists before it needs one.
pub const IMAGE_PREVIEWS_VERSION: u64 = 1;

/// Where full pictures are served: `<prefix><conversation id>/<image id>`.
pub const CONVERSATION_IMAGE_PATH_PREFIX: &str = "/api/conversation_image/";

/// The key a previewed image carries.
pub const FULL_IMAGE_KEY: &str = "full_image";

/// Images whose base64 text is at most this long stay as they are: about
/// 24 KB of picture, no larger than a preview would be.
pub const KEEP_INLINE_MAX: usize = 32 * 1024;

/// A preview aims at this many bytes of JPEG (about 27 KB as base64), taking
/// the first of [`PREVIEW_STEPS`] that fits.
const PREVIEW_TARGET_BYTES: usize = 20 * 1024;

/// Longest side and JPEG quality, tried in order until one fits the target.
/// A transcript shows pictures at most 320 points high, and a preview is a
/// stand-in until the full picture is opened. Dense screenshots (text on a
/// desktop) mostly land on the second or third step: lowering the quality
/// saves them little, the size does.
const PREVIEW_STEPS: &[(u32, u8)] = &[(512, 65), (448, 60), (384, 55), (256, 50)];

/// A picture larger than this on either side is not decoded (its size still
/// is); it gets the placeholder.
const MAX_DECODE_SIDE: u32 = 16_384;

/// Memory a decode may take.
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;

/// Previews kept, in bytes of base64 (about 600 screenshots).
const CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Length of an image id: the first 16 bytes of a SHA-256, in hex.
const ID_HEX_LEN: usize = 32;

// ── ids ─────────────────────────────────────────────────────────────────────

/// The id of a picture: SHA-256 over its mime type and its base64 text as the
/// transcript stores them, the first 16 bytes in lowercase hex. A plain
/// content hash on purpose: the same picture has the same id on every read,
/// after a restart and on every client, and the path that serves it is
/// authenticated and scoped to its conversation.
pub fn image_id(mime_type: &str, data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(mime_type.as_bytes());
    hasher.update([0u8]);
    hasher.update(data.trim().as_bytes());
    hasher
        .finalize()
        .iter()
        .take(ID_HEX_LEN / 2)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The path that serves picture `id` of `conversation_id`.
pub fn image_ref(conversation_id: i32, id: &str) -> String {
    format!("{CONVERSATION_IMAGE_PATH_PREFIX}{conversation_id}/{id}")
}

fn is_image_id(id: &str) -> bool {
    id.len() == ID_HEX_LEN && id.bytes().all(|b| b.is_ascii_hexdigit())
}

// ── previews ────────────────────────────────────────────────────────────────

/// What a picture becomes in a previewed response.
#[derive(Debug)]
struct Preview {
    /// The JPEG preview, base64; `None` when the picture could not be decoded
    /// here, and the placeholder goes instead.
    jpeg: Option<String>,
    /// The picture's size in bytes, decoded from base64.
    bytes: usize,
    width: Option<u32>,
    height: Option<u32>,
}

impl Preview {
    fn cost(&self) -> usize {
        self.jpeg.as_ref().map_or(0, String::len) + 64
    }
}

fn decode_base64(data: &str) -> Option<Vec<u8>> {
    let text = data.trim();
    STANDARD
        .decode(text)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(text))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(text))
        .ok()
}

/// A reader for `bytes`, its format guessed from the content. `strict` adds
/// the size limits a decode needs; reading the size alone goes without them.
fn reader(bytes: &[u8], strict: bool) -> Option<ImageReader<Cursor<&[u8]>>> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.format()?;
    if strict {
        let mut limits = Limits::default();
        limits.max_alloc = Some(MAX_DECODE_ALLOC);
        limits.max_image_width = Some(MAX_DECODE_SIDE);
        limits.max_image_height = Some(MAX_DECODE_SIDE);
        reader.limits(limits);
    }
    Some(reader)
}

fn make_preview(data: &str) -> Preview {
    let Some(bytes) = decode_base64(data) else {
        return Preview {
            jpeg: None,
            bytes: data.trim().len() / 4 * 3,
            width: None,
            height: None,
        };
    };
    let size = reader(&bytes, false).and_then(|r| r.into_dimensions().ok());
    let decodable = size.is_some_and(|(w, h)| w <= MAX_DECODE_SIDE && h <= MAX_DECODE_SIDE);
    let jpeg = decodable
        .then(|| reader(&bytes, true))
        .flatten()
        .and_then(|r| r.decode().ok())
        .and_then(|picture| encode_preview(&picture))
        .map(|jpeg| STANDARD.encode(jpeg));
    Preview {
        jpeg,
        bytes: bytes.len(),
        width: size.map(|(w, _)| w),
        height: size.map(|(_, h)| h),
    }
}

/// The picture scaled down and encoded as JPEG: the first of
/// [`PREVIEW_STEPS`] that fits [`PREVIEW_TARGET_BYTES`], else the last.
fn encode_preview(picture: &DynamicImage) -> Option<Vec<u8>> {
    let mut previous: Option<DynamicImage> = None;
    let mut last = None;
    for &(side, quality) in PREVIEW_STEPS {
        let source = previous.as_ref().unwrap_or(picture);
        let scaled = if source.width().max(source.height()) > side {
            source.thumbnail(side, side)
        } else {
            source.clone()
        };
        let jpeg = encode_jpeg(&scaled, quality)?;
        let fits = jpeg.len() <= PREVIEW_TARGET_BYTES;
        last = Some(jpeg);
        if fits {
            break;
        }
        previous = Some(scaled);
    }
    last
}

fn encode_jpeg(picture: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let rgb = flatten(picture);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(out)
}

/// RGB for JPEG, which has no alpha: a transparent picture is laid on white,
/// as a light page shows it, rather than on black.
fn flatten(picture: &DynamicImage) -> RgbImage {
    if !picture.color().has_alpha() {
        return picture.to_rgb8();
    }
    let rgba = picture.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (out, px) in rgb.pixels_mut().zip(rgba.pixels()) {
        let alpha = u32::from(px[3]);
        let blend = |c: u8| ((u32::from(c) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        *out = image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]);
    }
    rgb
}

// ── cache ───────────────────────────────────────────────────────────────────

struct CacheInner {
    entries: HashMap<String, Arc<Preview>>,
    /// Ids, least recently used first.
    order: VecDeque<String>,
    bytes: usize,
}

/// Previews by image id, bounded in bytes, least recently used out first.
/// Undecodable pictures are kept too, so they are not tried on every read.
pub struct PreviewCache {
    inner: Mutex<CacheInner>,
    max_bytes: usize,
}

impl PreviewCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                entries: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
            }),
            max_bytes,
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Preview>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let hit = inner.entries.get(id).cloned()?;
        if inner.order.back().map(String::as_str) != Some(id) {
            inner.order.retain(|k| k != id);
            inner.order.push_back(id.to_string());
        }
        Some(hit)
    }

    fn put(&self, id: &str, preview: Arc<Preview>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.entries.contains_key(id) {
            return;
        }
        let cost = preview.cost();
        while inner.bytes + cost > self.max_bytes {
            let Some(oldest) = inner.order.pop_front() else {
                break;
            };
            if let Some(gone) = inner.entries.remove(&oldest) {
                inner.bytes -= gone.cost();
            }
        }
        inner.bytes += cost;
        inner.entries.insert(id.to_string(), preview);
        inner.order.push_back(id.to_string());
    }

    /// The preview of the picture `data` with id `id`, made now if it isn't
    /// kept. Two reads making the same one at once both make it; the first
    /// kept wins.
    fn get_or_make(&self, id: &str, data: &str) -> Arc<Preview> {
        if let Some(hit) = self.get(id) {
            return hit;
        }
        let made = Arc::new(make_preview(data));
        self.put(id, made.clone());
        made
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .len()
    }
}

static CACHE: LazyLock<PreviewCache> = LazyLock::new(|| PreviewCache::new(CACHE_MAX_BYTES));

/// The process-wide preview cache.
pub fn cache() -> &'static PreviewCache {
    &CACHE
}

// ── finding images ──────────────────────────────────────────────────────────

/// Whether `s` is base64 text rather than prose. Only asked of strings long
/// enough to matter, where an accidental match would need thousands of bytes
/// without a space or a punctuation mark.
fn is_base64_payload(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

/// The key holding an object's `image/*` mime type, and the type.
fn image_mime(map: &Map<String, Value>) -> Option<(&'static str, &str)> {
    ["mime_type", "mimeType"].into_iter().find_map(|key| {
        map.get(key)
            .and_then(Value::as_str)
            .filter(|mime| mime.starts_with("image/"))
            .map(|mime| (key, mime))
    })
}

/// An object's inline picture large enough to preview: the mime type's key,
/// the mime type and the base64 text.
fn large_image(map: &Map<String, Value>) -> Option<(&'static str, &str, &str)> {
    if map.contains_key(FULL_IMAGE_KEY) || map.contains_key("data_ref") {
        return None;
    }
    let (key, mime) = image_mime(map)?;
    let data = map
        .get("data")
        .and_then(Value::as_str)
        .filter(|data| data.len() > KEEP_INLINE_MAX && is_base64_payload(data))?;
    Some((key, mime, data))
}

/// `(mime, base64 body)` of a whole-string `data:image/…;base64,` URL.
fn data_url_image(s: &str) -> Option<(&str, &str)> {
    let rest = s.strip_prefix("data:")?;
    let (mime, body) = rest.split_once(";base64,")?;
    let mime = mime.split(';').next().unwrap_or(mime);
    (mime.starts_with("image/") && is_base64_payload(body)).then_some((mime, body))
}

/// A JSON object or array carried as a string (tool input and output often
/// are).
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

// ── the preview pass ────────────────────────────────────────────────────────

/// What one pass changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PreviewReport {
    /// Pictures sent as a JPEG preview.
    pub previewed: usize,
    /// Pictures sent as the placeholder (not decodable here).
    pub placeholders: usize,
}

/// Replace every large inline picture in `value` (a serialized history
/// response of `conversation_id`) with its preview and `full_image`.
pub fn apply_previews(
    value: &mut Value,
    conversation_id: i32,
    cache: &PreviewCache,
) -> PreviewReport {
    let mut report = PreviewReport::default();
    rewrite(value, conversation_id, cache, &mut report);
    report
}

fn rewrite(
    value: &mut Value,
    conversation_id: i32,
    cache: &PreviewCache,
    report: &mut PreviewReport,
) {
    match value {
        Value::Object(map) => {
            let is_image = rewrite_image(map, conversation_id, cache, report);
            for (key, child) in map.iter_mut() {
                if is_image && (key == "data" || key == FULL_IMAGE_KEY) {
                    continue;
                }
                rewrite(child, conversation_id, cache, report);
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite(item, conversation_id, cache, report);
            }
        }
        Value::String(s) if s.len() > KEEP_INLINE_MAX => {
            if let Some((mime, body)) = data_url_image(s) {
                let preview = cache.get_or_make(&image_id(mime, body), body);
                let smaller = preview.jpeg.as_ref().filter(|jpeg| jpeg.len() < body.len());
                if let Some(jpeg) = smaller.map(|jpeg| format!("data:image/jpeg;base64,{jpeg}")) {
                    *s = jpeg;
                    report.previewed += 1;
                }
                return;
            }
            let Some(mut inner) = embedded_json(s) else {
                return;
            };
            let before = *report;
            rewrite(&mut inner, conversation_id, cache, report);
            if *report != before {
                if let Ok(text) = serde_json::to_string(&inner) {
                    *s = text;
                }
            }
        }
        _ => {}
    }
}

/// Preview `map` if it is a large inline picture. Returns whether it is a
/// picture at all (its `data` is then not walked).
fn rewrite_image(
    map: &mut Map<String, Value>,
    conversation_id: i32,
    cache: &PreviewCache,
    report: &mut PreviewReport,
) -> bool {
    let Some((mime_key, mime, data)) = large_image(map) else {
        return image_mime(map).is_some();
    };
    let id = image_id(mime, data);
    let preview = cache.get_or_make(&id, data);
    let (inline, inline_mime) = match &preview.jpeg {
        Some(jpeg) if jpeg.len() < data.len() => (jpeg.clone(), "image/jpeg"),
        // Not smaller than the picture itself: it goes as it is.
        Some(_) => return true,
        None => (IMAGE_PLACEHOLDER_PNG.to_string(), "image/png"),
    };
    let mut full = Map::new();
    full.insert("ref".into(), Value::String(image_ref(conversation_id, &id)));
    full.insert("id".into(), Value::String(id));
    full.insert("mime_type".into(), Value::String(mime.to_string()));
    full.insert("bytes".into(), preview.bytes.into());
    if let Some(width) = preview.width {
        full.insert("width".into(), width.into());
    }
    if let Some(height) = preview.height {
        full.insert("height".into(), height.into());
    }
    if preview.jpeg.is_none() {
        full.insert("placeholder".into(), Value::Bool(true));
        report.placeholders += 1;
    } else {
        report.previewed += 1;
    }
    map.insert("data".into(), Value::String(inline));
    map.insert(mime_key.into(), Value::String(inline_mime.into()));
    map.insert(FULL_IMAGE_KEY.into(), Value::Object(full));
    true
}

/// The picture `id` names in `value` (an unpreviewed history value): its
/// mime type and base64 text.
pub fn find_image(value: &Value, id: &str) -> Option<(String, String)> {
    match value {
        Value::Object(map) => {
            if let Some((_, mime, data)) = large_image(map) {
                if image_id(mime, data) == id {
                    return Some((mime.to_string(), data.to_string()));
                }
            }
            map.values().find_map(|child| find_image(child, id))
        }
        Value::Array(items) => items.iter().find_map(|item| find_image(item, id)),
        Value::String(s) if s.len() > KEEP_INLINE_MAX => {
            if let Some((mime, body)) = data_url_image(s) {
                return (image_id(mime, body) == id).then(|| (mime.to_string(), body.to_string()));
            }
            embedded_json(s).and_then(|inner| find_image(&inner, id))
        }
        _ => None,
    }
}

/// The picture `id` names in a conversation's turns, newest turns first (the
/// pictures people open are mostly recent ones). The typed places pictures
/// sit in are compared without a copy; a block is serialized and walked
/// ([`find_image`]) only when a long string in it could carry one inside.
pub fn find_image_in_turns(turns: &[MessageTurn], id: &str) -> Option<(String, String)> {
    let same = |mime: &str, data: &str| {
        (data.len() > KEEP_INLINE_MAX && is_base64_payload(data) && image_id(mime, data) == id)
            .then(|| (mime.to_string(), data.to_string()))
    };
    let typed = |image: &ImageData| {
        if image.mime_type.starts_with("image/") {
            same(&image.mime_type, &image.data)
        } else {
            None
        }
    };
    turns.iter().rev().find_map(|turn| {
        turn.blocks.iter().find_map(|block| {
            let found = match block {
                ContentBlock::Image {
                    data, mime_type, ..
                } if mime_type.starts_with("image/") => same(mime_type, data),
                ContentBlock::ImageGeneration {
                    image: Some(image), ..
                } => typed(image),
                ContentBlock::ToolResult { images, .. } => images.iter().find_map(typed),
                _ => None,
            };
            found.or_else(|| {
                if !may_hide_a_picture(block) {
                    return None;
                }
                serde_json::to_value(block)
                    .ok()
                    .and_then(|value| find_image(&value, id))
            })
        })
    })
}

/// Whether `block` has a string long enough to carry a picture inside it
/// (JSON as text, a data URL), or free-form JSON that could.
fn may_hide_a_picture(block: &ContentBlock) -> bool {
    let long = |s: &Option<String>| s.as_ref().is_some_and(|s| s.len() > KEEP_INLINE_MAX);
    match block {
        ContentBlock::Text { text } | ContentBlock::Thinking { text } => {
            text.len() > KEEP_INLINE_MAX
        }
        ContentBlock::ToolUse {
            input_preview,
            meta,
            ..
        } => long(input_preview) || meta.is_some(),
        ContentBlock::ToolResult {
            output_preview,
            agent_stats,
            ..
        } => long(output_preview) || agent_stats.is_some(),
        _ => false,
    }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn millis(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// The answer to a history read that asked for previews: `value` with its
/// pictures as previews, and a `Server-Timing` header with how long the server
/// took — `app`, from the request's start (`started`) until the body was
/// ready, and `img`, the preview pass within it — so a client can tell its
/// network time from the server's.
pub async fn preview_response<T>(
    value: T,
    conversation_id: i32,
    started: Instant,
) -> Result<Response, AppCommandError>
where
    T: Serialize + Send + 'static,
{
    let (body, pass) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, Duration), serde_json::Error> {
            let mut json = serde_json::to_value(&value)?;
            drop(value);
            let pass_started = Instant::now();
            apply_previews(&mut json, conversation_id, cache());
            let pass = pass_started.elapsed();
            serde_json::to_vec(&json).map(|body| (body, pass))
        })
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    let timing = format!(
        "app;dur={:.1}, img;dur={:.1}",
        millis(started.elapsed()),
        millis(pass)
    );
    let timing = HeaderValue::from_str(&timing).unwrap_or_else(|_| HeaderValue::from_static("app"));
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (HeaderName::from_static("server-timing"), timing),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/conversation_image/{conversation_id}/{image_id}` — the full
/// picture a previewed history response named, read from the conversation's
/// transcript. Behind the API's authentication like every other route.
/// Answers 404 when the conversation holds no picture with that id (any more).
pub async fn serve_conversation_image(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath((conversation_id, id)): AxumPath<(i32, String)>,
) -> Result<Response, AppCommandError> {
    let id = id.to_ascii_lowercase();
    if !is_image_id(&id) {
        return Ok((StatusCode::NOT_FOUND, "no such image").into_response());
    }
    // The whole transcript, read in place (shared with the transcript cache,
    // not copied): a long session holds tens of MB of pictures.
    let loaded = crate::commands::conversations::load_folder_conversation(
        &state.db.conn,
        conversation_id,
        crate::commands::conversations::ContentNeed::All,
        crate::parsers::CacheUse::Fill,
    )
    .await?;
    let found = tokio::task::spawn_blocking(move || {
        find_image_in_turns(loaded.all_turns(), &id)
            .and_then(|(mime, data)| Some((mime, decode_base64(&data)?)))
    })
    .await
    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    let Some((mime, bytes)) = found else {
        return Ok((
            StatusCode::NOT_FOUND,
            "image not found in this conversation",
        )
            .into_response());
    };
    let content_type = HeaderValue::from_str(&mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::png::PngEncoder;
    use serde_json::json;

    /// A screenshot-like PNG: flat bands with "text" noise, `w` x `h`.
    fn screenshot_png(w: u32, h: u32, seed: u32) -> Vec<u8> {
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let band = ((y / 40) % 3) as u8;
            let ink = (state >> 16).is_multiple_of(7) && !(x / 6).is_multiple_of(5);
            *px = if ink {
                image::Rgb([20, 20, 30])
            } else {
                image::Rgb([240 - band * 20, 242 - band * 10, 245])
            };
        }
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn b64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    fn jpeg_size(data: &str) -> (u32, u32) {
        let bytes = STANDARD.decode(data).expect("base64");
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "a JPEG");
        reader(&bytes, false).unwrap().into_dimensions().unwrap()
    }

    #[test]
    fn a_large_screenshot_becomes_a_small_preview_naming_the_full_picture() {
        let png = screenshot_png(1600, 1000, 1);
        let data = b64(&png);
        assert!(
            data.len() > KEEP_INLINE_MAX * 4,
            "a big picture: {}",
            data.len()
        );
        let mut value = json!({ "type": "tool_result", "images": [
            { "data": data.clone(), "mime_type": "image/png" }
        ]});
        let cache = PreviewCache::new(1 << 20);
        let report = apply_previews(&mut value, 237, &cache);
        assert_eq!(report.previewed, 1);
        let image = &value["images"][0];
        assert_eq!(image["mime_type"], "image/jpeg");
        let preview = image["data"].as_str().unwrap();
        assert!(
            preview.len() < KEEP_INLINE_MAX,
            "preview is {} bytes",
            preview.len()
        );
        let (w, h) = jpeg_size(preview);
        assert!(w.max(h) <= 512 && w > h, "{w}x{h}");
        let full = &image[FULL_IMAGE_KEY];
        let id = image_id("image/png", &data);
        assert_eq!(full["id"], id.as_str());
        assert_eq!(full["ref"], format!("/api/conversation_image/237/{id}"));
        assert_eq!(full["mime_type"], "image/png");
        assert_eq!(full["bytes"], png.len());
        assert_eq!(full["width"], 1600);
        assert_eq!(full["height"], 1000);
        assert!(full.get("placeholder").is_none());
        // The original is found again by its id.
        let original = json!({ "images": [{ "data": data.clone(), "mime_type": "image/png" }] });
        assert_eq!(
            find_image(&original, &id),
            Some(("image/png".to_string(), data))
        );
        assert_eq!(find_image(&original, &"0".repeat(32)), None);
    }

    #[test]
    fn small_pictures_and_other_values_are_left_alone() {
        let small = b64(&screenshot_png(40, 30, 2));
        assert!(small.len() <= KEEP_INLINE_MAX);
        let mut value = json!({
            "blocks": [
                { "type": "image", "data": small, "mime_type": "image/png" },
                { "type": "text", "text": "x".repeat(KEEP_INLINE_MAX + 10) },
                { "data": "A".repeat(KEEP_INLINE_MAX + 10), "mime_type": "text/plain" }
            ]
        });
        let before = value.clone();
        let report = apply_previews(&mut value, 1, &PreviewCache::new(1 << 20));
        assert_eq!(report, PreviewReport::default());
        assert_eq!(value, before);
    }

    #[test]
    fn ids_are_stable_across_caches_and_restarts() {
        let data = b64(&screenshot_png(900, 700, 3));
        let mut a = json!({ "data": data.clone(), "mime_type": "image/png" });
        let mut b = a.clone();
        apply_previews(&mut a, 5, &PreviewCache::new(1 << 20));
        apply_previews(&mut b, 5, &PreviewCache::new(1 << 20));
        assert_eq!(a[FULL_IMAGE_KEY]["id"], b[FULL_IMAGE_KEY]["id"]);
        assert_eq!(
            a[FULL_IMAGE_KEY]["id"],
            image_id("image/png", &data).as_str()
        );
    }

    #[test]
    fn an_undecodable_picture_gets_the_placeholder_and_its_reference() {
        let junk: Vec<u8> = (0..60_000u32)
            .map(|i| (i.wrapping_mul(31) % 251) as u8)
            .collect();
        let data = b64(&junk);
        let mut value = json!({ "type": "image", "data": data, "mimeType": "image/heic" });
        let report = apply_previews(&mut value, 9, &PreviewCache::new(1 << 20));
        assert_eq!(report.placeholders, 1);
        assert_eq!(value["data"], IMAGE_PLACEHOLDER_PNG);
        assert_eq!(value["mimeType"], "image/png", "the key it came with");
        let full = &value[FULL_IMAGE_KEY];
        assert_eq!(full["placeholder"], true);
        assert_eq!(full["mime_type"], "image/heic");
        assert_eq!(full["bytes"], junk.len());
        assert!(full.get("width").is_none());
    }

    #[test]
    fn pictures_inside_json_strings_and_data_urls_are_previewed() {
        let data = b64(&screenshot_png(1200, 800, 4));
        let embedded = json!([{ "type": "image", "data": data.clone(), "mimeType": "image/png" }]);
        let mut value = json!({
            "raw_output": embedded.to_string(),
            "uri": format!("data:image/png;base64,{data}"),
        });
        let report = apply_previews(&mut value, 3, &PreviewCache::new(1 << 20));
        assert_eq!(report.previewed, 2);
        let inner: Value = serde_json::from_str(value["raw_output"].as_str().unwrap()).unwrap();
        assert_eq!(inner[0]["mimeType"], "image/jpeg");
        assert!(inner[0][FULL_IMAGE_KEY]["ref"]
            .as_str()
            .unwrap()
            .starts_with("/api/conversation_image/3/"));
        let url = value["uri"].as_str().unwrap();
        let jpeg = url
            .strip_prefix("data:image/jpeg;base64,")
            .expect("a JPEG data URL");
        jpeg_size(jpeg);
        // Both are found again in the original.
        let original = json!({ "raw_output": embedded.to_string(), "uri": format!("data:image/png;base64,{data}") });
        let id = image_id("image/png", &data);
        assert_eq!(
            find_image(&original, &id).map(|(m, _)| m).as_deref(),
            Some("image/png")
        );
    }

    #[test]
    fn a_transparent_picture_is_laid_on_white() {
        let rgba = image::RgbaImage::from_pixel(10, 10, image::Rgba([0, 0, 0, 0]));
        let flat = flatten(&DynamicImage::ImageRgba8(rgba));
        assert_eq!(flat.get_pixel(3, 3), &image::Rgb([255, 255, 255]));
    }

    #[test]
    fn the_cache_reuses_previews() {
        let cache = PreviewCache::new(1 << 20);
        let data = b64(&screenshot_png(800, 600, 10));
        let id = image_id("image/png", &data);
        let first = cache.get_or_make(&id, &data);
        let again = cache.get_or_make(&id, &data);
        assert!(Arc::ptr_eq(&first, &again), "kept, not made twice");
    }

    #[test]
    fn the_cache_is_bounded_and_drops_the_least_recently_used() {
        let preview = || {
            Arc::new(Preview {
                jpeg: Some("x".repeat(1000)),
                bytes: 1,
                width: None,
                height: None,
            })
        };
        let cache = PreviewCache::new(3 * (1000 + 64));
        for id in ["a", "b", "c"] {
            cache.put(id, preview());
        }
        // "a" is used again, so "b" is the oldest when "d" comes.
        assert!(cache.get("a").is_some());
        cache.put("d", preview());
        assert_eq!(cache.len(), 3);
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert!(cache.get("d").is_some());
    }

    fn turn(id: &str, blocks: Vec<ContentBlock>) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role: crate::models::message::TurnRole::Assistant,
            blocks,
            timestamp: chrono::Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
            spoken: false,
        }
    }

    #[test]
    fn the_full_picture_is_found_wherever_the_transcript_keeps_it() {
        let shot = b64(&screenshot_png(900, 600, 20));
        let generated = b64(&screenshot_png(700, 700, 21));
        let in_text = b64(&screenshot_png(800, 500, 22));
        let image = |data: &str| ImageData {
            data: data.to_string(),
            mime_type: "image/png".into(),
            uri: None,
        };
        let turns = vec![
            turn(
                "t1",
                vec![ContentBlock::ToolResult {
                    tool_use_id: Some("toolu_1".into()),
                    output_preview: None,
                    is_error: false,
                    agent_stats: None,
                    images: vec![image(&shot)],
                    exit_code: None,
                }],
            ),
            turn(
                "t2",
                vec![
                    ContentBlock::ImageGeneration {
                        revised_prompt: None,
                        image: Some(image(&generated)),
                    },
                    ContentBlock::Text {
                        text: format!("data:image/png;base64,{in_text}"),
                    },
                ],
            ),
        ];
        for data in [&shot, &generated, &in_text] {
            let id = image_id("image/png", data);
            assert_eq!(
                find_image_in_turns(&turns, &id),
                Some(("image/png".to_string(), data.to_string()))
            );
        }
        assert_eq!(find_image_in_turns(&turns, &"f".repeat(32)), None);
    }

    // ── over HTTP ───────────────────────────────────────────────────────────

    use crate::db::service::{agent_setting_service, conversation_service};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::AgentType;

    const TOKEN: &str = "image-previews-token";

    /// A server whose Claude Code transcript (in a temporary config dir) has a
    /// screenshot in a tool result. Returns the server, the conversation id and
    /// the screenshot's PNG bytes.
    async fn server_with_screenshot(
    ) -> (axum_test::TestServer, i32, Vec<u8>, Vec<tempfile::TempDir>) {
        let config_dir = tempfile::tempdir().expect("tempdir");
        let project = config_dir.path().join("projects").join("-image-previews");
        std::fs::create_dir_all(&project).expect("project dir");
        let session_id = "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
        let png = screenshot_png(1400, 900, 42);
        let cwd = "/tmp/codeg-image-previews";
        let lines = [
            json!({"type":"user","timestamp":"2026-11-20T09:00:00.000Z","uuid":"u1","cwd":cwd,
                   "message":{"role":"user","content":[{"type":"text","text":"take a screenshot"}]}}),
            json!({"type":"assistant","timestamp":"2026-11-20T09:00:05.000Z","uuid":"a1","parentUuid":"u1",
                   "message":{"id":"msg_01","role":"assistant","model":"claude-opus-5",
                              "content":[{"type":"tool_use","id":"toolu_shot","name":"Read","input":{"file_path":"/tmp/shot.png"}}]}}),
            json!({"type":"user","timestamp":"2026-11-20T09:00:06.000Z","uuid":"u2","parentUuid":"a1",
                   "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_shot",
                              "content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":b64(&png)}}]}]}}),
            json!({"type":"assistant","timestamp":"2026-11-20T09:00:09.000Z","uuid":"a2","parentUuid":"u2",
                   "message":{"id":"msg_02","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"done"}]}}),
        ];
        let text: Vec<String> = lines.iter().map(Value::to_string).collect();
        std::fs::write(project.join(format!("{session_id}.jsonl")), text.join("\n"))
            .expect("write transcript");

        let db = fresh_in_memory_db().await;
        agent_setting_service::ensure_defaults(
            &db.conn,
            &[agent_setting_service::AgentDefaultInput {
                agent_type: AgentType::ClaudeCode,
                registry_id: AgentType::ClaudeCode.to_string(),
                default_sort_order: 0,
            }],
        )
        .await
        .expect("seed agent setting");
        agent_setting_service::update(
            &db.conn,
            AgentType::ClaudeCode,
            agent_setting_service::AgentSettingsUpdate {
                enabled: true,
                env_json: Some(json!({ "CLAUDE_CONFIG_DIR": config_dir.path() }).to_string()),
                model_provider_id: None,
            },
        )
        .await
        .expect("save env_json");
        let folder_id = seed_folder(&db, cwd).await;
        let conversation_id = crate::commands::conversations::create_conversation_core(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("screenshots".into()),
        )
        .await
        .expect("create conversation");
        conversation_service::bind_external_id(&db.conn, conversation_id, session_id, &[])
            .await
            .expect("bind session");

        let data_dir = tempfile::tempdir().expect("data dir");
        let static_dir = tempfile::tempdir().expect("static dir");
        let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
        let router = crate::web::router::build_router(
            state,
            TOKEN.to_string(),
            static_dir.path().to_path_buf(),
            Arc::new(crate::web::shutdown::ShutdownSignal::new()),
        );
        let server = axum_test::TestServer::new(router).expect("test server");
        (
            server,
            conversation_id,
            png,
            vec![config_dir, data_dir, static_dir],
        )
    }

    /// Every inline picture object in a response.
    fn pictures(value: &Value) -> Vec<Map<String, Value>> {
        let mut out = Vec::new();
        fn walk(value: &Value, out: &mut Vec<Map<String, Value>>) {
            match value {
                Value::Object(map) => {
                    if image_mime(map).is_some() && map.contains_key("data") {
                        out.push(map.clone());
                    }
                    map.values().for_each(|v| walk(v, out));
                }
                Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
                _ => {}
            }
        }
        walk(value, &mut out);
        out
    }

    #[tokio::test]
    async fn the_history_sends_previews_only_when_asked_and_serves_the_full_picture() {
        let (server, conversation_id, png, _dirs) = server_with_screenshot().await;
        let auth = format!("Bearer {TOKEN}");

        // Without the opt-in: the picture as the transcript holds it.
        let plain = server
            .post("/api/get_folder_conversation")
            .add_header("authorization", auth.clone())
            .json(&json!({ "conversationId": conversation_id, "tailTurns": 40 }))
            .await;
        assert_eq!(plain.status_code(), 200);
        assert!(plain.headers().get("server-timing").is_none());
        let plain_body = plain.json::<Value>();
        let found = pictures(&plain_body);
        assert_eq!(found.len(), 1, "one screenshot: {plain_body}");
        assert_eq!(found[0]["data"], b64(&png));
        assert!(found[0].get(FULL_IMAGE_KEY).is_none());

        // With it: a preview, a reference, and the server's time.
        let previewed = server
            .post("/api/get_folder_conversation")
            .add_header("authorization", auth.clone())
            .json(&json!({ "conversationId": conversation_id, "tailTurns": 40, "imagePreviews": true }))
            .await;
        assert_eq!(previewed.status_code(), 200);
        let timing = previewed
            .headers()
            .get("server-timing")
            .expect("Server-Timing");
        assert!(
            timing.to_str().unwrap().starts_with("app;dur="),
            "{timing:?}"
        );
        let body = previewed.json::<Value>();
        let found = pictures(&body);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["mime_type"], "image/jpeg");
        let full = found[0][FULL_IMAGE_KEY]
            .as_object()
            .expect("full_image")
            .clone();
        assert_eq!(full["bytes"], png.len());
        assert_eq!(full["width"], 1400);
        // Everything but the picture is the same response.
        assert_eq!(body["turns_total"], plain_body["turns_total"]);
        assert_eq!(body["prefix_hash"], plain_body["prefix_hash"]);
        assert!(
            body.to_string().len() * 4 < plain_body.to_string().len(),
            "previewed {} vs plain {}",
            body.to_string().len(),
            plain_body.to_string().len()
        );

        // The older-history page takes the opt-in too.
        let page = server
            .post("/api/get_folder_conversation_turns")
            .add_header("authorization", auth.clone())
            .json(&json!({ "conversationId": conversation_id, "beforeIndex": 10, "limit": 10, "imagePreviews": true }))
            .await;
        assert_eq!(page.status_code(), 200);
        assert_eq!(
            pictures(&page.json::<Value>())[0][FULL_IMAGE_KEY]["id"],
            full["id"]
        );

        // The full picture, by its reference.
        let reference = full["ref"].as_str().unwrap();
        let image = server
            .get(reference)
            .add_header("authorization", auth.clone())
            .await;
        assert_eq!(image.status_code(), 200);
        assert_eq!(image.headers()["content-type"], "image/png");
        assert_eq!(image.as_bytes().as_ref(), png.as_slice());

        // Authenticated, and only for a picture the conversation holds.
        let anonymous = server.get(reference).await;
        assert_eq!(anonymous.status_code(), 401);
        let unknown = server
            .get(&image_ref(conversation_id, &"a".repeat(32)))
            .add_header("authorization", auth.clone())
            .await;
        assert_eq!(unknown.status_code(), 404);
        let malformed = server
            .get(&format!(
                "{CONVERSATION_IMAGE_PATH_PREFIX}{conversation_id}/nope"
            ))
            .add_header("authorization", auth.clone())
            .await;
        assert_eq!(malformed.status_code(), 404);

        // The capability is advertised.
        let health = server
            .post("/api/health")
            .add_header("authorization", auth)
            .json(&json!({}))
            .await;
        assert_eq!(
            health.json::<Value>()["imagePreviews"],
            IMAGE_PREVIEWS_VERSION
        );
    }
}
