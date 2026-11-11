//! Talks to a running codeg-tts sidecar: writes requests, reads frames, and
//! routes each frame to the synthesis it belongs to. Works over any byte
//! stream, so the tests drive it with an in-memory pipe and the service with
//! the child's stdin/stdout.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::protocol::{read_frame, Event, Request};

/// What a synthesis yields, in order: chunks, then exactly one `Done` or
/// `Failed`.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Chunk(AudioChunk),
    Done(DoneStats),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioChunk {
    pub index: u32,
    pub sample_rate: u32,
    pub is_final: bool,
    /// Since the request reached the sidecar.
    pub elapsed_ms: u64,
    /// 16-bit little-endian mono PCM.
    pub pcm: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneStats {
    pub chunks: u32,
    pub cancelled: bool,
    pub audio_ms: u64,
    pub elapsed_ms: u64,
    pub first_chunk_ms: Option<u64>,
}

pub struct Synthesis {
    pub id: u64,
    pub events: mpsc::UnboundedReceiver<StreamEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("the speech engine is not running")]
    NotRunning,
    #[error("writing to the speech engine failed: {0}")]
    Write(#[from] std::io::Error),
}

type Routes = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<StreamEvent>>>>;

#[derive(Default)]
struct Shared {
    alive: AtomicBool,
    loaded: AtomicBool,
    voices: Mutex<Vec<String>>,
    last_error: Mutex<Option<String>>,
}

pub struct SidecarClient {
    writer: tokio::sync::Mutex<Pin<Box<dyn AsyncWrite + Send>>>,
    routes: Routes,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl SidecarClient {
    /// Start reading `reader` (the sidecar's stdout) in the background.
    pub fn new<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + 'static,
    {
        let routes: Routes = Arc::default();
        let shared = Arc::new(Shared::default());
        shared.alive.store(true, Ordering::SeqCst);
        let reader = tokio::spawn(read_loop(
            BufReader::new(reader),
            routes.clone(),
            shared.clone(),
        ));
        Self {
            writer: tokio::sync::Mutex::new(Box::pin(writer)),
            routes,
            shared,
            next_id: AtomicU64::new(1),
            reader,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// The models are in memory (a `loaded` event, or audio already came back).
    pub fn is_loaded(&self) -> bool {
        self.shared.loaded.load(Ordering::SeqCst)
    }

    pub fn voices(&self) -> Vec<String> {
        self.shared.voices.lock().unwrap().clone()
    }

    /// The last error the sidecar reported outside any synthesis.
    pub fn last_error(&self) -> Option<String> {
        self.shared.last_error.lock().unwrap().clone()
    }

    /// How many syntheses are waiting for their `done`.
    pub fn in_flight(&self) -> usize {
        self.routes.lock().unwrap().len()
    }

    async fn send(&self, request: &Request<'_>) -> Result<(), ClientError> {
        if !self.is_alive() {
            return Err(ClientError::NotRunning);
        }
        let line = request.encode();
        let mut writer = self.writer.lock().await;
        let result: std::io::Result<()> = async {
            writer.write_all(&line).await?;
            writer.flush().await
        }
        .await;
        if let Err(e) = result {
            self.shared.alive.store(false, Ordering::SeqCst);
            return Err(ClientError::Write(e));
        }
        Ok(())
    }

    /// Start synthesizing `text`; its audio arrives on the returned stream.
    pub async fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: f64,
    ) -> Result<Synthesis, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::unbounded_channel();
        // Routed before the request goes out, so no frame can beat it here.
        self.routes.lock().unwrap().insert(id, tx);
        let sent = self
            .send(&Request::Synthesize {
                id,
                text,
                voice,
                speed,
            })
            .await;
        if let Err(e) = sent {
            self.routes.lock().unwrap().remove(&id);
            return Err(e);
        }
        Ok(Synthesis { id, events: rx })
    }

    /// Stop a synthesis. Its stream still ends with `Done { cancelled }`.
    pub async fn cancel(&self, id: u64) {
        if self.routes.lock().unwrap().contains_key(&id) {
            let _ = self.send(&Request::Cancel { id }).await;
        }
    }

    /// Load the models now (warm start) instead of on the first request.
    pub async fn load(&self) -> Result<(), ClientError> {
        self.send(&Request::Load).await
    }

    /// Ask the sidecar to exit.
    pub async fn shutdown(&self) {
        let _ = self.send(&Request::Shutdown).await;
        let mut writer = self.writer.lock().await;
        let _ = writer.shutdown().await;
    }
}

async fn read_loop<R>(mut reader: BufReader<R>, routes: Routes, shared: Arc<Shared>)
where
    R: AsyncRead + Unpin,
{
    let reason = loop {
        match read_frame(&mut reader).await {
            Ok(Some(frame)) => dispatch(frame.event, frame.payload, &routes, &shared),
            Ok(None) => break "the speech engine exited".to_string(),
            Err(e) => break format!("the speech engine's output broke off: {e}"),
        }
    };
    shared.alive.store(false, Ordering::SeqCst);
    let pending: Vec<_> = routes.lock().unwrap().drain().collect();
    for (_, tx) in pending {
        let _ = tx.send(StreamEvent::Failed(reason.clone()));
    }
    tracing::info!("[TTS] {reason}");
}

fn dispatch(event: Event, payload: Vec<u8>, routes: &Routes, shared: &Shared) {
    match event {
        Event::Ready {
            protocol, voices, ..
        } => {
            if protocol != super::protocol::PROTOCOL_VERSION {
                tracing::warn!(
                    "[TTS] the sidecar speaks protocol {protocol}, expected {}",
                    super::protocol::PROTOCOL_VERSION
                );
            }
            *shared.voices.lock().unwrap() = voices;
        }
        Event::Loaded { ms } => {
            shared.loaded.store(true, Ordering::SeqCst);
            tracing::info!("[TTS] models loaded in {ms} ms");
        }
        Event::Chunk {
            id,
            index,
            sample_rate,
            is_final,
            elapsed_ms,
        } => {
            shared.loaded.store(true, Ordering::SeqCst);
            if let Some(tx) = routes.lock().unwrap().get(&id) {
                let _ = tx.send(StreamEvent::Chunk(AudioChunk {
                    index,
                    sample_rate,
                    is_final,
                    elapsed_ms,
                    pcm: payload,
                }));
            }
        }
        Event::Done {
            id,
            chunks,
            cancelled,
            audio_ms,
            elapsed_ms,
            first_chunk_ms,
        } => {
            if let Some(tx) = routes.lock().unwrap().remove(&id) {
                let _ = tx.send(StreamEvent::Done(DoneStats {
                    chunks,
                    cancelled,
                    audio_ms,
                    elapsed_ms,
                    first_chunk_ms,
                }));
            }
        }
        Event::Error {
            id: Some(id),
            message,
        } => {
            if let Some(tx) = routes.lock().unwrap().remove(&id) {
                let _ = tx.send(StreamEvent::Failed(message));
            }
        }
        Event::Error { id: None, message } => {
            tracing::warn!("[TTS] sidecar: {message}");
            *shared.last_error.lock().unwrap() = Some(message);
        }
        Event::Unknown => {}
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use tokio::io::{AsyncBufReadExt, DuplexStream};

    use super::*;

    /// The sidecar's side of an in-memory pipe: reads request lines, writes
    /// frames.
    pub(crate) struct FakeSidecar {
        requests: tokio::io::Lines<BufReader<DuplexStream>>,
        out: DuplexStream,
    }

    impl FakeSidecar {
        pub(crate) fn pair() -> (FakeSidecar, DuplexStream, DuplexStream) {
            let (client_in, sidecar_out) = tokio::io::duplex(1 << 20);
            let (sidecar_in, client_out) = tokio::io::duplex(1 << 20);
            (
                FakeSidecar {
                    requests: BufReader::new(sidecar_in).lines(),
                    out: sidecar_out,
                },
                client_in,
                client_out,
            )
        }

        pub(crate) async fn next_request(&mut self) -> Option<serde_json::Value> {
            let line = self.requests.next_line().await.ok()??;
            Some(serde_json::from_str(&line).unwrap())
        }

        pub(crate) async fn send(&mut self, header: serde_json::Value, payload: &[u8]) {
            let mut line = serde_json::to_vec(&header).unwrap();
            line.push(b'\n');
            line.extend_from_slice(payload);
            self.out.write_all(&line).await.unwrap();
            self.out.flush().await.unwrap();
        }

        pub(crate) async fn chunk(&mut self, id: u64, index: u32, pcm: &[u8], is_final: bool) {
            self.send(
                serde_json::json!({"event":"chunk","id":id,"index":index,"sampleRate":44100,
                    "format":"s16le","samples":pcm.len()/2,"bytes":pcm.len(),"final":is_final,"elapsedMs":5}),
                pcm,
            )
            .await;
        }

        pub(crate) async fn done(&mut self, id: u64, chunks: u32, cancelled: bool) {
            self.send(
                serde_json::json!({"event":"done","id":id,"chunks":chunks,"cancelled":cancelled,
                    "audioMs":100,"elapsedMs":20,"firstChunkMs":5}),
                b"",
            )
            .await;
        }
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<StreamEvent>) -> StreamEvent {
        tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for a stream event")
            .expect("stream closed")
    }

    #[tokio::test]
    async fn synthesis_streams_chunks_then_done() {
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let client = SidecarClient::new(from_sidecar, to_sidecar);
        fake.send(
            serde_json::json!({"event":"ready","protocol":1,"voices":["noa"],"sampleRate":44100}),
            b"",
        )
        .await;

        let mut s = client
            .synthesize("שלום world.", Some("noa"), 1.1)
            .await
            .unwrap();
        let req = fake.next_request().await.unwrap();
        assert_eq!(req["op"], "synthesize");
        assert_eq!(req["id"], s.id);
        assert_eq!(req["text"], "שלום world.");
        assert_eq!(req["voice"], "noa");
        assert_eq!(req["speed"], 1.1);

        fake.chunk(s.id, 0, &[1, 0, 2, 0], false).await;
        fake.chunk(s.id, 1, &[3, 0], true).await;
        fake.done(s.id, 2, false).await;

        match next(&mut s.events).await {
            StreamEvent::Chunk(c) => {
                assert_eq!(
                    (c.index, c.pcm.as_slice(), c.is_final),
                    (0, &[1u8, 0, 2, 0][..], false)
                )
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(next(&mut s.events).await, StreamEvent::Chunk(c) if c.is_final));
        assert!(matches!(
            next(&mut s.events).await,
            StreamEvent::Done(DoneStats {
                chunks: 2,
                cancelled: false,
                ..
            })
        ));
        assert!(s.events.recv().await.is_none(), "nothing after done");
        assert_eq!(client.voices(), vec!["noa".to_string()]);
        assert!(client.is_loaded());
        assert_eq!(client.in_flight(), 0);
    }

    #[tokio::test]
    async fn cancel_reaches_the_sidecar_and_ends_the_stream() {
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let client = SidecarClient::new(from_sidecar, to_sidecar);
        let mut s = client.synthesize("a long reply", None, 1.0).await.unwrap();
        let req = fake.next_request().await.unwrap();
        assert!(req.get("voice").is_none());
        fake.chunk(s.id, 0, &[0, 0], false).await;
        assert!(matches!(next(&mut s.events).await, StreamEvent::Chunk(_)));

        client.cancel(s.id).await;
        let cancel = fake.next_request().await.unwrap();
        assert_eq!(cancel, serde_json::json!({"op":"cancel","id":s.id}));
        fake.done(s.id, 1, true).await;
        assert!(matches!(
            next(&mut s.events).await,
            StreamEvent::Done(DoneStats {
                cancelled: true,
                ..
            })
        ));
        // Cancelling something already finished sends nothing.
        client.cancel(s.id).await;
        client.load().await.unwrap();
        assert_eq!(
            fake.next_request().await.unwrap(),
            serde_json::json!({"op":"load"})
        );
    }

    #[tokio::test]
    async fn concurrent_syntheses_are_routed_by_id_and_errors_end_only_theirs() {
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let client = SidecarClient::new(from_sidecar, to_sidecar);
        let mut a = client.synthesize("a", None, 1.0).await.unwrap();
        let mut b = client.synthesize("b", Some("adam"), 1.0).await.unwrap();
        assert_ne!(a.id, b.id);
        fake.next_request().await.unwrap();
        fake.next_request().await.unwrap();

        fake.chunk(b.id, 0, &[9, 9], true).await;
        fake.send(
            serde_json::json!({"event":"error","id":a.id,"message":"voice x not found"}),
            b"",
        )
        .await;
        fake.send(
            serde_json::json!({"event":"error","message":"general"}),
            b"",
        )
        .await;
        fake.done(b.id, 1, false).await;

        assert_eq!(
            next(&mut a.events).await,
            StreamEvent::Failed("voice x not found".into())
        );
        assert!(matches!(next(&mut b.events).await, StreamEvent::Chunk(c) if c.pcm == [9, 9]));
        assert!(matches!(next(&mut b.events).await, StreamEvent::Done(_)));
        assert_eq!(client.last_error().as_deref(), Some("general"));
        assert!(client.is_alive());
    }

    #[tokio::test]
    async fn a_sidecar_that_exits_fails_every_open_stream() {
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let client = SidecarClient::new(from_sidecar, to_sidecar);
        let mut s = client.synthesize("x", None, 1.0).await.unwrap();
        fake.next_request().await.unwrap();
        drop(fake);

        assert!(matches!(next(&mut s.events).await, StreamEvent::Failed(_)));
        assert!(!client.is_alive());
        assert!(matches!(
            client.synthesize("y", None, 1.0).await,
            Err(ClientError::NotRunning)
        ));
    }

    #[tokio::test]
    async fn shutdown_sends_the_request_and_closes_stdin() {
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let client = SidecarClient::new(from_sidecar, to_sidecar);
        client.shutdown().await;
        assert_eq!(
            fake.next_request().await.unwrap(),
            serde_json::json!({"op":"shutdown"})
        );
        assert!(fake.next_request().await.is_none(), "stdin closed");
    }
}
