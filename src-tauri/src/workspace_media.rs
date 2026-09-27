//! Streaming workspace media (video preview).
//!
//! A `<video src>` can neither carry a Bearer header nor afford to receive a
//! multi-GB file as base64 JSON, so previews go through a *capability*: the
//! authenticated caller mints a short-lived token scoped to exactly one file
//! (`WorkspaceTransferManager::issue_media_capability`), and the token is the
//! only credential the byte endpoint accepts. Every request re-resolves the
//! file through the same path rules as the download API, so a capability can
//! never reach anything the caller could not already download.
//!
//! Three transports read through this module:
//!
//! * **web / server** — `GET /api/workspace_media/{token}/{name}` streams
//!   straight from disk with real HTTP Range support (`200`/`206`/`416`).
//! * **local desktop** — the `codeg-media://` URI scheme reads a bounded slice
//!   of the file per request (the Tauri responder takes a whole body, so a
//!   range is capped at [`LOCAL_SCHEME_CHUNK_BYTES`]).
//! * **remote desktop** — the same URI scheme forwards each Range request to
//!   the remote server's byte endpoint, again capped per request, so the
//!   webview never has to reach the remote origin itself (mixed content,
//!   custom connection headers).
//!
//! The range arithmetic is shared by all three and lives here, free of any
//! runtime dependency, so it is unit-tested once.

use std::path::Path;

/// Largest slice the local URI scheme answers a single Range request with.
/// Media elements happily follow a short `206` with the next request, and a
/// small slice keeps the first frame fast and memory flat.
pub const LOCAL_SCHEME_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

/// Largest slice forwarded per request on the remote path. Bigger than the
/// local one because every request pays a network round trip.
pub const REMOTE_SCHEME_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// Byte endpoint path (under `/api`) for a minted capability.
pub const MEDIA_ROUTE_PREFIX: &str = "/api/workspace_media";

/// A syntactically valid single `bytes=` range, before it meets a length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeSpec {
    /// `bytes=a-b`
    FromTo(u64, u64),
    /// `bytes=a-`
    From(u64),
    /// `bytes=-n` (the last `n` bytes)
    Suffix(u64),
}

/// What a `Range` header asks for, read without knowing the file length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeRequest {
    /// No header, a unit other than `bytes`, or a multi-range request. RFC 9110
    /// lets a server ignore all three and send the whole representation.
    Ignore,
    /// One well-formed byte range.
    Single(RangeSpec),
    /// A `bytes=` header that cannot be parsed (`bytes=5-2`, `bytes=abc`).
    Invalid,
}

/// How to answer a request for a file of a known length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangePlan {
    /// `200` with the whole file.
    Full,
    /// `206` with the inclusive byte span `start..=end`.
    Partial { start: u64, end: u64 },
    /// `416` with `Content-Range: bytes */len`.
    Unsatisfiable,
}

fn parse_digits(raw: &str) -> Option<u64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>().ok()
}

/// Parse a `Range` header value.
pub fn parse_range_header(header: Option<&str>) -> RangeRequest {
    let Some(raw) = header else {
        return RangeRequest::Ignore;
    };
    let raw = raw.trim();
    let Some((unit, spec)) = raw.split_once('=') else {
        return RangeRequest::Ignore;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeRequest::Ignore;
    }
    let spec = spec.trim();
    if spec.contains(',') {
        return RangeRequest::Ignore;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return RangeRequest::Invalid;
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        return match parse_digits(last) {
            Some(n) => RangeRequest::Single(RangeSpec::Suffix(n)),
            None => RangeRequest::Invalid,
        };
    }
    let Some(start) = parse_digits(first) else {
        return RangeRequest::Invalid;
    };
    if last.is_empty() {
        return RangeRequest::Single(RangeSpec::From(start));
    }
    match parse_digits(last) {
        Some(end) if end >= start => RangeRequest::Single(RangeSpec::FromTo(start, end)),
        _ => RangeRequest::Invalid,
    }
}

/// Resolve a `Range` header against a file of `len` bytes.
pub fn plan_range(header: Option<&str>, len: u64) -> RangePlan {
    match parse_range_header(header) {
        RangeRequest::Ignore => RangePlan::Full,
        RangeRequest::Invalid => RangePlan::Unsatisfiable,
        RangeRequest::Single(spec) => plan_spec(spec, len),
    }
}

fn plan_spec(spec: RangeSpec, len: u64) -> RangePlan {
    if len == 0 {
        return RangePlan::Unsatisfiable;
    }
    match spec {
        RangeSpec::Suffix(0) => RangePlan::Unsatisfiable,
        RangeSpec::Suffix(n) => RangePlan::Partial {
            start: len - n.min(len),
            end: len - 1,
        },
        RangeSpec::From(start) if start >= len => RangePlan::Unsatisfiable,
        RangeSpec::From(start) => RangePlan::Partial {
            start,
            end: len - 1,
        },
        RangeSpec::FromTo(start, _) if start >= len => RangePlan::Unsatisfiable,
        RangeSpec::FromTo(start, end) => RangePlan::Partial {
            start,
            end: end.min(len - 1),
        },
    }
}

/// Bound a plan to at most `max_chunk` bytes, for transports that must hold
/// the whole response body in memory. A full-file answer larger than the
/// bound becomes a `206` for its first slice — media elements always send a
/// Range header, and treat a short `206` as "ask again from here".
pub fn cap_plan(plan: RangePlan, len: u64, max_chunk: u64) -> RangePlan {
    let max_chunk = max_chunk.max(1);
    match plan {
        RangePlan::Full if len > max_chunk => RangePlan::Partial {
            start: 0,
            end: max_chunk - 1,
        },
        RangePlan::Partial { start, end } => RangePlan::Partial {
            start,
            end: end.min(start.saturating_add(max_chunk - 1)),
        },
        other => other,
    }
}

/// The bounded `Range` header the remote proxy sends upstream for a client
/// request. The length is unknown at this point, so an open-ended or missing
/// range is closed off at `max_chunk` bytes; the server clamps the end itself.
/// `None` means "forward the client's header untouched" (an invalid range the
/// server should answer with its own `416`).
pub fn upstream_range_header(client: Option<&str>, max_chunk: u64) -> Option<String> {
    let max_chunk = max_chunk.max(1);
    match parse_range_header(client) {
        RangeRequest::Ignore => Some(format!("bytes=0-{}", max_chunk - 1)),
        RangeRequest::Invalid => None,
        RangeRequest::Single(RangeSpec::FromTo(start, end)) => Some(format!(
            "bytes={start}-{}",
            end.min(start.saturating_add(max_chunk - 1))
        )),
        RangeRequest::Single(RangeSpec::From(start)) => Some(format!(
            "bytes={start}-{}",
            start.saturating_add(max_chunk - 1)
        )),
        RangeRequest::Single(RangeSpec::Suffix(n)) => Some(format!("bytes=-{}", n.min(max_chunk))),
    }
}

fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// `Content-Type` for a streamable media file, or `None` when the extension is
/// not one the preview streams. Minting is refused for anything else so the
/// byte endpoint can never be turned into a general file server that answers
/// with, say, `text/html`.
///
/// `.mov` is labelled `video/mp4`: QuickTime and MP4 share the ISO base media
/// layout, WebKit plays either label, and Chromium only plays the file when it
/// is not announced as `video/quicktime`.
pub fn media_content_type(name: &str) -> Option<&'static str> {
    Some(match extension_of(name).as_str() {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mpg" | "mpeg" => "video/mpeg",
        _ => return None,
    })
}

/// A capability token as minted: 32 lowercase hex chars (`Uuid::simple`).
/// Checked before a token is spliced into a URL or used as a map key from an
/// untrusted request path.
pub fn is_valid_media_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Custom URI scheme the desktop webview loads previews from.
pub const MEDIA_URI_SCHEME: &str = "codeg-media";

/// What a `codeg-media://` request addresses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaSchemeRoute {
    /// A capability minted by this app (local desktop window).
    Local { token: String },
    /// A capability minted by the remote server behind a saved connection.
    Remote { connection_id: i32, token: String },
}

/// Parse the path of a `codeg-media://localhost/<path>` request.
///
/// The frontend builds the URL with Tauri's `convertFileSrc`, which
/// percent-encodes the whole path (slashes included), so it is decoded first.
/// Shapes: `local/<token>[/<name>]` and `remote/<connection id>/<token>[/<name>]`;
/// the trailing name only gives the URL a real extension and is ignored.
pub fn parse_media_scheme_path(path: &str) -> Option<MediaSchemeRoute> {
    let decoded = percent_encoding::percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let mut parts = decoded.split('/');
    match parts.next()? {
        "local" => {
            let token = parts.next()?;
            is_valid_media_token(token).then(|| MediaSchemeRoute::Local {
                token: token.to_string(),
            })
        }
        "remote" => {
            let connection_id = parse_digits(parts.next()?)?;
            let connection_id = i32::try_from(connection_id).ok()?;
            let token = parts.next()?;
            is_valid_media_token(token).then(|| MediaSchemeRoute::Remote {
                connection_id,
                token: token.to_string(),
            })
        }
        _ => None,
    }
}

/// `Content-Range` value for a satisfiable span.
pub fn content_range(start: u64, end: u64, len: u64) -> String {
    format!("bytes {start}-{end}/{len}")
}

/// `Content-Range` value for a `416`.
pub fn unsatisfied_content_range(len: u64) -> String {
    format!("bytes */{len}")
}

/// Read the inclusive span `start..=end` of a file into memory. Only used by
/// the URI-scheme transports, whose spans are already capped.
pub async fn read_span(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let want = end.saturating_sub(start).saturating_add(1);
    let mut buf = Vec::with_capacity(want.min(REMOTE_SCHEME_CHUNK_BYTES) as usize);
    file.take(want).read_to_end(&mut buf).await?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_header_serves_the_full_file() {
        assert_eq!(plan_range(None, 100), RangePlan::Full);
    }

    #[test]
    fn closed_range_is_served_as_asked() {
        assert_eq!(
            plan_range(Some("bytes=10-19"), 100),
            RangePlan::Partial { start: 10, end: 19 }
        );
        // An end past the file is clamped to the last byte.
        assert_eq!(
            plan_range(Some("bytes=90-500"), 100),
            RangePlan::Partial { start: 90, end: 99 }
        );
        // Whitespace and unit case are tolerated.
        assert_eq!(
            plan_range(Some(" Bytes = 0-0 "), 100),
            RangePlan::Partial { start: 0, end: 0 }
        );
    }

    #[test]
    fn open_ended_range_runs_to_the_last_byte() {
        assert_eq!(
            plan_range(Some("bytes=40-"), 100),
            RangePlan::Partial { start: 40, end: 99 }
        );
        assert_eq!(
            plan_range(Some("bytes=0-"), 1),
            RangePlan::Partial { start: 0, end: 0 }
        );
    }

    #[test]
    fn suffix_range_takes_the_tail() {
        assert_eq!(
            plan_range(Some("bytes=-10"), 100),
            RangePlan::Partial { start: 90, end: 99 }
        );
        // A suffix longer than the file is the whole file, as a 206.
        assert_eq!(
            plan_range(Some("bytes=-500"), 100),
            RangePlan::Partial { start: 0, end: 99 }
        );
    }

    #[test]
    fn unsatisfiable_and_malformed_ranges_are_416() {
        for header in [
            "bytes=100-",
            "bytes=100-200",
            "bytes=-0",
            "bytes=5-2",
            "bytes=abc",
            "bytes=1-x",
            "bytes=+1-5",
            "bytes=",
            "bytes=-",
        ] {
            assert_eq!(
                plan_range(Some(header), 100),
                RangePlan::Unsatisfiable,
                "{header}"
            );
        }
        // Nothing is satisfiable in an empty file.
        assert_eq!(plan_range(Some("bytes=0-"), 0), RangePlan::Unsatisfiable);
    }

    #[test]
    fn foreign_units_and_multi_ranges_are_ignored() {
        assert_eq!(plan_range(Some("items=0-5"), 100), RangePlan::Full);
        assert_eq!(plan_range(Some("bytes=0-1,5-6"), 100), RangePlan::Full);
        assert_eq!(plan_range(Some("garbage"), 100), RangePlan::Full);
    }

    #[test]
    fn cap_plan_bounds_every_span() {
        assert_eq!(
            cap_plan(RangePlan::Full, 10, 4),
            RangePlan::Partial { start: 0, end: 3 }
        );
        assert_eq!(cap_plan(RangePlan::Full, 4, 4), RangePlan::Full);
        assert_eq!(
            cap_plan(RangePlan::Partial { start: 5, end: 99 }, 100, 10),
            RangePlan::Partial { start: 5, end: 14 }
        );
        assert_eq!(
            cap_plan(RangePlan::Partial { start: 5, end: 7 }, 100, 10),
            RangePlan::Partial { start: 5, end: 7 }
        );
        assert_eq!(
            cap_plan(RangePlan::Unsatisfiable, 100, 10),
            RangePlan::Unsatisfiable
        );
    }

    #[test]
    fn upstream_range_is_always_bounded() {
        assert_eq!(
            upstream_range_header(None, 1024).as_deref(),
            Some("bytes=0-1023")
        );
        assert_eq!(
            upstream_range_header(Some("bytes=100-"), 1024).as_deref(),
            Some("bytes=100-1123")
        );
        assert_eq!(
            upstream_range_header(Some("bytes=100-200"), 1024).as_deref(),
            Some("bytes=100-200")
        );
        assert_eq!(
            upstream_range_header(Some("bytes=0-999999"), 1024).as_deref(),
            Some("bytes=0-1023")
        );
        assert_eq!(
            upstream_range_header(Some("bytes=-99999"), 1024).as_deref(),
            Some("bytes=-1024")
        );
        assert_eq!(
            upstream_range_header(Some("bytes=0-1,4-5"), 1024).as_deref(),
            Some("bytes=0-1023")
        );
        // An invalid range is the server's to reject.
        assert_eq!(upstream_range_header(Some("bytes=9-1"), 1024), None);
    }

    #[test]
    fn media_types_cover_common_video_and_refuse_everything_else() {
        assert_eq!(media_content_type("clip.MP4"), Some("video/mp4"));
        assert_eq!(media_content_type("a/b/clip.mov"), Some("video/mp4"));
        assert_eq!(media_content_type("clip.webm"), Some("video/webm"));
        assert_eq!(media_content_type("clip.mkv"), Some("video/x-matroska"));
        assert_eq!(media_content_type("clip.m4v"), Some("video/mp4"));
        assert_eq!(media_content_type("index.html"), None);
        assert_eq!(media_content_type("notes.txt"), None);
        assert_eq!(media_content_type("mp4"), None);
    }

    #[test]
    fn token_shape_is_checked() {
        assert!(is_valid_media_token("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_media_token("../../etc/passwd"));
        assert!(!is_valid_media_token("0123456789abcdef"));
        assert!(!is_valid_media_token("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn scheme_paths_route_local_and_remote_capabilities() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_media_scheme_path(&format!("/local%2F{token}%2Fmy%20clip.mp4")),
            Some(MediaSchemeRoute::Local {
                token: token.to_string()
            })
        );
        assert_eq!(
            parse_media_scheme_path(&format!("/remote/7/{token}/clip.mov")),
            Some(MediaSchemeRoute::Remote {
                connection_id: 7,
                token: token.to_string()
            })
        );
        assert_eq!(
            parse_media_scheme_path(&format!("remote%2F12%2F{token}")),
            Some(MediaSchemeRoute::Remote {
                connection_id: 12,
                token: token.to_string()
            })
        );
        for bad in [
            "/local/..%2F..%2Fetc%2Fpasswd".to_string(),
            "/local/short".to_string(),
            format!("/remote/-1/{token}"),
            format!("/remote/abc/{token}"),
            format!("/remote/99999999999/{token}"),
            format!("/other/{token}"),
            "/".to_string(),
        ] {
            assert_eq!(parse_media_scheme_path(&bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn read_span_returns_exactly_the_inclusive_span() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        assert_eq!(read_span(&path, 2, 5).await.unwrap(), b"2345");
        assert_eq!(read_span(&path, 9, 9).await.unwrap(), b"9");
        // A span past EOF is truncated by the file, not padded.
        assert_eq!(read_span(&path, 8, 20).await.unwrap(), b"89");
    }
}
