//! Images a size-limited event socket could not carry inline.
//!
//! When a frame is too large for the client it goes to (see
//! [`crate::web::ws_frame_cap`]), its base64 images are taken out first: each
//! is kept here, decoded, under an unguessable key, and the frame carries a
//! small placeholder plus `data_ref`, the path this module serves it from. A
//! client that knows the field loads the real image with one GET; one that
//! does not shows the placeholder instead of an image that failed to decode.
//!
//! The key is a capability, like `/api/workspace_media/{token}`: a keyed hash
//! of the bytes under a per-process random secret, so it can't be guessed or
//! derived from an image someone has, and an `<img src>` (which carries no
//! Bearer header) can load it. The store is in memory and bounded; an evicted
//! or pre-restart key answers 404, and the conversation's own detail (which
//! always carries its images inline) is the fallback.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use axum::{
    extract::Path as AxumPath,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

/// Route prefix the references point at (relative to the server's origin).
pub const LIVE_IMAGE_PATH_PREFIX: &str = "/api/live_image/";

/// Decoded bytes kept at most. The images are re-sent whole by every snapshot
/// of their turn, so the set that matters is the few turns clients are
/// attached to right now, not the history.
const MAX_STORE_BYTES: usize = 48 * 1024 * 1024;

/// One image larger than this is not kept (it would evict everything else);
/// its reference then answers 404 and the client reloads the conversation.
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

struct Entry {
    mime_type: String,
    bytes: Arc<Vec<u8>>,
}

struct Inner {
    secret: [u8; 32],
    entries: HashMap<String, Entry>,
    /// Keys oldest first; a key put again moves to the back.
    order: VecDeque<String>,
    bytes: usize,
}

/// Bounded, in-memory, least-recently-stored image store.
pub struct LiveImageStore {
    inner: Mutex<Inner>,
    max_bytes: usize,
}

impl LiveImageStore {
    fn new(max_bytes: usize) -> Self {
        let secret: [u8; 32] = rand::random();
        Self {
            inner: Mutex::new(Inner {
                secret,
                entries: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
            }),
            max_bytes,
        }
    }

    /// Keep one base64 image and return the path a client loads it from, or
    /// `None` when `data` is not base64 or the image is too large to keep.
    pub fn put(&self, data_base64: &str, mime_type: &str) -> Option<String> {
        let bytes = STANDARD
            .decode(data_base64.trim())
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(data_base64.trim()))
            .ok()?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return None;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut hasher = Sha256::new();
        hasher.update(inner.secret);
        hasher.update(mime_type.as_bytes());
        hasher.update([0u8]);
        hasher.update(&bytes);
        let key: String = hasher
            .finalize()
            .iter()
            .take(20)
            .map(|b| format!("{b:02x}"))
            .collect();
        if inner.entries.contains_key(&key) {
            inner.order.retain(|k| k != &key);
            inner.order.push_back(key.clone());
            return Some(format!("{LIVE_IMAGE_PATH_PREFIX}{key}"));
        }
        let size = bytes.len();
        while inner.bytes + size > self.max_bytes {
            let Some(oldest) = inner.order.pop_front() else {
                break;
            };
            if let Some(gone) = inner.entries.remove(&oldest) {
                inner.bytes -= gone.bytes.len();
            }
        }
        inner.bytes += size;
        inner.entries.insert(
            key.clone(),
            Entry {
                mime_type: mime_type.to_string(),
                bytes: Arc::new(bytes),
            },
        );
        inner.order.push_back(key.clone());
        Some(format!("{LIVE_IMAGE_PATH_PREFIX}{key}"))
    }

    /// The image behind `key` (the last path segment of a reference).
    pub fn get(&self, key: &str) -> Option<(String, Arc<Vec<u8>>)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .entries
            .get(key)
            .map(|e| (e.mime_type.clone(), e.bytes.clone()))
    }
}

static STORE: LazyLock<LiveImageStore> = LazyLock::new(|| LiveImageStore::new(MAX_STORE_BYTES));

/// The process-wide store the event socket and the route share.
pub fn store() -> &'static LiveImageStore {
    &STORE
}

/// `GET /api/live_image/{key}` — one image an event frame referred to.
pub async fn serve_live_image(AxumPath(key): AxumPath<String>) -> Response {
    let valid = key.len() == 40 && key.bytes().all(|b| b.is_ascii_hexdigit());
    let found = valid.then(|| store().get(&key)).flatten();
    let Some((mime_type, bytes)) = found else {
        return (StatusCode::NOT_FOUND, "image no longer available").into_response();
    };
    let content_type = if mime_type.starts_with("image/") {
        HeaderValue::from_str(&mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
    } else {
        HeaderValue::from_static("application/octet-stream")
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400, immutable"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        bytes.as_ref().clone(),
    )
        .into_response()
}

/// A private store for tests elsewhere in the crate (tests run in parallel,
/// so they must not share the process-wide one).
#[cfg(test)]
pub(crate) mod tests_support {
    pub(crate) fn store() -> super::LiveImageStore {
        super::LiveImageStore::new(64 * 1024 * 1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(n: u8) -> String {
        // Not a real PNG; the store keeps whatever bytes the base64 decodes to.
        STANDARD.encode(vec![n; 1000])
    }

    #[test]
    fn put_then_get_round_trips_the_bytes() {
        let s = LiveImageStore::new(1 << 20);
        let path = s.put(&png(7), "image/png").expect("stored");
        let key = path.strip_prefix(LIVE_IMAGE_PATH_PREFIX).unwrap();
        assert_eq!(key.len(), 40);
        let (mime, bytes) = s.get(key).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes.as_slice(), &[7u8; 1000][..]);
        // Same bytes, same reference: a snapshot re-sent every tick does not
        // fill the store with copies.
        assert_eq!(s.put(&png(7), "image/png").unwrap(), path);
    }

    #[test]
    fn the_oldest_image_is_evicted_past_the_bound() {
        let s = LiveImageStore::new(2500);
        let a = s.put(&png(1), "image/png").unwrap();
        let b = s.put(&png(2), "image/png").unwrap();
        let c = s.put(&png(3), "image/png").unwrap();
        let key = |p: &str| p.strip_prefix(LIVE_IMAGE_PATH_PREFIX).unwrap().to_string();
        assert!(s.get(&key(&a)).is_none(), "oldest evicted");
        assert!(s.get(&key(&b)).is_some());
        assert!(s.get(&key(&c)).is_some());
    }

    #[test]
    fn non_base64_is_refused() {
        let s = LiveImageStore::new(1 << 20);
        assert!(s.put("not base64 at all!", "image/png").is_none());
        assert!(s.put("", "image/png").is_none());
    }

    #[test]
    fn keys_are_not_a_plain_content_hash() {
        // Two stores (two processes) key the same image differently, so a key
        // can't be computed from an image someone already has.
        let a = LiveImageStore::new(1 << 20)
            .put(&png(9), "image/png")
            .unwrap();
        let b = LiveImageStore::new(1 << 20)
            .put(&png(9), "image/png")
            .unwrap();
        assert_ne!(a, b);
    }
}
