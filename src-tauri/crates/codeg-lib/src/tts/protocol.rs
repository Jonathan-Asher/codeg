//! The codeg-tts wire protocol (version 1), the Rust half of
//! `native/codeg-tts/Sources/CodegTTSCore/Protocol.swift`.
//!
//! Requests are one JSON object per line on the sidecar's stdin. The sidecar
//! answers with frames on stdout: a one-line JSON header, followed by exactly
//! `bytes` raw bytes when the header has a `bytes` field (16-bit PCM for a
//! `chunk`), nothing otherwise.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

pub const PROTOCOL_VERSION: u32 = 1;
/// Bigger than any sentence of audio (60 s of 44.1 kHz 16-bit is ~5 MB);
/// a header that claims more is garbage.
pub const MAX_PAYLOAD_BYTES: u64 = 64 << 20;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request<'a> {
    Synthesize {
        id: u64,
        text: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        voice: Option<&'a str>,
        speed: f64,
    },
    Cancel {
        id: u64,
    },
    Load,
    Shutdown,
}

impl Request<'_> {
    /// The request as one line, newline included.
    pub fn encode(&self) -> Vec<u8> {
        let mut line = serde_json::to_vec(self).expect("requests always serialize");
        line.push(b'\n');
        line
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Ready {
        protocol: u32,
        #[serde(default)]
        voices: Vec<String>,
        sample_rate: u32,
    },
    #[serde(rename_all = "camelCase")]
    Loaded { ms: u64 },
    #[serde(rename_all = "camelCase")]
    Chunk {
        id: u64,
        index: u32,
        sample_rate: u32,
        #[serde(rename = "final")]
        is_final: bool,
        #[serde(default)]
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        id: u64,
        chunks: u32,
        cancelled: bool,
        #[serde(default)]
        audio_ms: u64,
        #[serde(default)]
        elapsed_ms: u64,
        #[serde(default)]
        first_chunk_ms: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Error { id: Option<u64>, message: String },
    /// An event a newer sidecar sends that this backend doesn't know.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub event: Event,
    /// The raw bytes after the header (PCM for a chunk); empty otherwise.
    pub payload: Vec<u8>,
}

/// Read the next frame. `Ok(None)` at a clean end of stream. Lines that are
/// not JSON objects are skipped (logged), so a stray print can't wedge the
/// stream; a payload cut short is an error.
pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Frame>> {
    loop {
        let mut line = Vec::new();
        let n = reader.read_until(b'\n', &mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        if line.last() != Some(&b'\n') {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the sidecar's output ended inside a frame header",
            ));
        }
        let text = line.trim_ascii();
        if text.is_empty() {
            continue;
        }
        let Ok(serde_json::Value::Object(header)) =
            serde_json::from_slice::<serde_json::Value>(text)
        else {
            tracing::warn!(
                "[TTS] skipping a non-frame line from the sidecar: {}",
                String::from_utf8_lossy(text)
                    .chars()
                    .take(200)
                    .collect::<String>()
            );
            continue;
        };
        let bytes = header.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
        if bytes > MAX_PAYLOAD_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("frame payload of {bytes} bytes is too large"),
            ));
        }
        let mut payload = vec![0u8; bytes as usize];
        reader.read_exact(&mut payload).await?;
        let event = serde_json::from_value(serde_json::Value::Object(header)).unwrap_or_else(|e| {
            tracing::warn!("[TTS] unreadable sidecar event: {e}");
            Event::Unknown
        });
        return Ok(Some(Frame { event, payload }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(header: &str, payload: &[u8]) -> Vec<u8> {
        let mut v = header.as_bytes().to_vec();
        v.push(b'\n');
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn requests_encode_as_one_line() {
        let r = Request::Synthesize {
            id: 3,
            text: "שלום \"world\"\nשורה",
            voice: Some("noa"),
            speed: 1.25,
        };
        let line = r.encode();
        assert_eq!(line.iter().filter(|&&b| b == b'\n').count(), 1);
        assert_eq!(line.last(), Some(&b'\n'));
        let v: serde_json::Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(v["op"], "synthesize");
        assert_eq!(v["id"], 3);
        assert_eq!(v["voice"], "noa");
        assert_eq!(v["speed"], 1.25);
        assert_eq!(v["text"], "שלום \"world\"\nשורה");

        let v: serde_json::Value = serde_json::from_slice(
            &Request::Synthesize {
                id: 1,
                text: "x",
                voice: None,
                speed: 1.0,
            }
            .encode(),
        )
        .unwrap();
        assert!(v.get("voice").is_none());
        assert_eq!(
            Request::Cancel { id: 9 }.encode(),
            b"{\"op\":\"cancel\",\"id\":9}\n"
        );
        assert_eq!(Request::Load.encode(), b"{\"op\":\"load\"}\n");
        assert_eq!(Request::Shutdown.encode(), b"{\"op\":\"shutdown\"}\n");
    }

    #[tokio::test]
    async fn reads_frames_with_and_without_payloads() {
        let mut data = Vec::new();
        data.extend(frame(
            r#"{"event":"ready","protocol":1,"sampleRate":44100,"voices":["adam","noa"]}"#,
            b"",
        ));
        // A payload that itself contains newlines and JSON must not confuse
        // the reader.
        data.extend(frame(
            r#"{"bytes":6,"elapsedMs":700,"event":"chunk","final":false,"format":"s16le","id":4,"index":0,"sampleRate":44100,"samples":3}"#,
            b"\n{}\n\0\0",
        ));
        data.extend(b"\n");
        data.extend(frame(
            r#"{"audioMs":900,"cancelled":false,"chunks":1,"elapsedMs":800,"event":"done","firstChunkMs":700,"id":4}"#,
            b"",
        ));
        data.extend(frame(r#"{"event":"error","message":"boom"}"#, b""));
        data.extend(frame(
            r#"{"event":"error","id":5,"message":"no voice"}"#,
            b"",
        ));
        data.extend(frame(r#"{"event":"loaded","ms":1500}"#, b""));
        let mut r = tokio::io::BufReader::new(&data[..]);

        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            f.event,
            Event::Ready {
                protocol: 1,
                voices: vec!["adam".into(), "noa".into()],
                sample_rate: 44100
            }
        );
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            f.event,
            Event::Chunk {
                id: 4,
                index: 0,
                sample_rate: 44100,
                is_final: false,
                elapsed_ms: 700
            }
        );
        assert_eq!(f.payload, b"\n{}\n\0\0");
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            f.event,
            Event::Done {
                id: 4,
                chunks: 1,
                cancelled: false,
                audio_ms: 900,
                elapsed_ms: 800,
                first_chunk_ms: Some(700)
            }
        );
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            f.event,
            Event::Error {
                id: None,
                message: "boom".into()
            }
        );
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            f.event,
            Event::Error {
                id: Some(5),
                message: "no voice".into()
            }
        );
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(f.event, Event::Loaded { ms: 1500 });
        assert!(read_frame(&mut r).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unknown_events_keep_their_payload_aligned() {
        let mut data = frame(r#"{"event":"spectrum","bytes":3}"#, b"abc");
        data.extend(frame(r#"{"event":"loaded","ms":1}"#, b""));
        let mut r = tokio::io::BufReader::new(&data[..]);
        let f = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(f.event, Event::Unknown);
        assert_eq!(f.payload, b"abc");
        assert_eq!(
            read_frame(&mut r).await.unwrap().unwrap().event,
            Event::Loaded { ms: 1 }
        );
    }

    #[tokio::test]
    async fn stray_text_lines_are_skipped() {
        let mut data = b"objc[123]: Class X is implemented in both\n".to_vec();
        data.extend(frame(r#"{"event":"loaded","ms":2}"#, b""));
        let mut r = tokio::io::BufReader::new(&data[..]);
        assert_eq!(
            read_frame(&mut r).await.unwrap().unwrap().event,
            Event::Loaded { ms: 2 }
        );
    }

    #[tokio::test]
    async fn truncated_frames_are_errors() {
        let data = frame(
            r#"{"event":"chunk","id":1,"index":0,"sampleRate":44100,"final":true,"bytes":10}"#,
            b"abc",
        );
        let mut r = tokio::io::BufReader::new(&data[..]);
        assert!(read_frame(&mut r).await.is_err());

        let data = br#"{"event":"loaded""#.to_vec();
        let mut r = tokio::io::BufReader::new(&data[..]);
        assert!(read_frame(&mut r).await.is_err());

        let data = frame(r#"{"event":"chunk","bytes":999999999999}"#, b"");
        let mut r = tokio::io::BufReader::new(&data[..]);
        assert!(read_frame(&mut r).await.is_err());
    }
}
