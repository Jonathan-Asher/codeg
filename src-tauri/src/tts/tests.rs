//! Service tests: a scripted in-memory sidecar stands in for codeg-tts, so
//! speak / poll / cancel, idle shutdown and restarts run without models. The
//! `#[ignore]`d test at the bottom drives the real binary and models.

use std::sync::atomic::AtomicUsize;

use super::client::tests::FakeSidecar;
use super::*;

fn tiny_catalog() -> Vec<ModelFile> {
    let entry = |path: &str, size: u64| ModelFile {
        path: path.to_string(),
        // Nothing listens on port 9 (discard); downloads there fail fast.
        url: format!("http://127.0.0.1:9/{path}"),
        size,
        sha256: "0".repeat(64),
    };
    vec![
        entry("bluetts/model.onnx", 64),
        entry("voices/noa.json", 8),
        entry("voices/adam.json", 8),
    ]
}

#[derive(Default)]
struct Script {
    requests: Mutex<Vec<serde_json::Value>>,
    spawns: AtomicUsize,
}

impl Script {
    fn ops(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r["op"].as_str().unwrap_or("?").to_string())
            .collect()
    }
}

/// A sidecar that answers like codeg-tts: `ready`, `loaded` on load, two
/// chunks and `done` per synthesis. Text `slow…` sends one chunk and waits for
/// a cancel; `fail` reports an error; `crash` exits mid-request.
fn scripted_spawner(script: Arc<Script>) -> EngineSpawner {
    Arc::new(move |_models: &Path| {
        script.spawns.fetch_add(1, Ordering::SeqCst);
        let (mut fake, from_sidecar, to_sidecar) = FakeSidecar::pair();
        let script = script.clone();
        tokio::spawn(async move {
            fake.send(
                serde_json::json!({"event":"ready","protocol":1,"voices":["adam","noa"],"sampleRate":44100}),
                b"",
            )
            .await;
            while let Some(req) = fake.next_request().await {
                script.requests.lock().unwrap().push(req.clone());
                let id = req["id"].as_u64().unwrap_or(0);
                match req["op"].as_str() {
                    Some("load") => {
                        fake.send(serde_json::json!({"event":"loaded","ms":3}), b"")
                            .await
                    }
                    Some("synthesize") => {
                        let text = req["text"].as_str().unwrap_or("");
                        if text.starts_with("slow") {
                            fake.chunk(id, 0, &[1, 0], false).await;
                        } else if text == "fail" {
                            fake.send(
                                serde_json::json!({"event":"error","id":id,"message":"voice x not found"}),
                                b"",
                            )
                            .await;
                        } else if text == "crash" {
                            return;
                        } else {
                            fake.chunk(id, 0, &[1, 0, 2, 0], false).await;
                            fake.chunk(id, 1, &[3, 0], true).await;
                            fake.done(id, 2, false).await;
                        }
                    }
                    Some("cancel") => fake.done(id, 1, true).await,
                    Some("shutdown") => return,
                    _ => {}
                }
            }
        });
        Ok(SpawnedEngine {
            stdout: Box::new(from_sidecar),
            stdin: Box::new(to_sidecar),
            child: None,
        })
    })
}

fn service(dir: &Path, script: &Arc<Script>, idle: Duration, reap: Duration) -> Arc<TtsService> {
    Arc::new(TtsService::new(TtsConfig {
        models_dir: dir.join("tts").join(catalog::PACK_DIR),
        catalog: Ok(tiny_catalog()),
        spawner: Some(scripted_spawner(script.clone())),
        unsupported_reason: None,
        idle_shutdown: idle,
        reap_every: reap,
    }))
}

fn installed(dir: &Path, script: &Arc<Script>) -> Arc<TtsService> {
    let svc = service(dir, script, IDLE_SHUTDOWN, Duration::from_secs(30));
    svc.store().unwrap().install_placeholder_for_tests();
    svc
}

fn speak(text: &str) -> SpeakRequest {
    SpeakRequest {
        text: text.to_string(),
        voice: None,
        speed: None,
    }
}

fn poll(id: &str) -> PollRequest {
    PollRequest {
        stream_id: id.to_string(),
        wait_ms: Some(2_000),
    }
}

/// Poll until the stream is done; returns every chunk's PCM and the last answer.
async fn drain(svc: &TtsService, id: &str) -> (Vec<Vec<u8>>, PollResult) {
    let mut pcm = Vec::new();
    for _ in 0..20 {
        let r = svc.poll(poll(id)).await.unwrap();
        for c in &r.chunks {
            assert_eq!(c.sample_rate, 44100);
            pcm.push(
                base64::engine::general_purpose::STANDARD
                    .decode(&c.pcm)
                    .unwrap(),
            );
        }
        if r.done {
            return (pcm, r);
        }
    }
    panic!("stream never finished");
}

#[tokio::test]
async fn nothing_is_spoken_or_started_before_the_models_are_downloaded() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = service(dir.path(), &script, IDLE_SHUTDOWN, Duration::from_secs(30));
    let status = svc.status();
    assert!(status.supported);
    assert!(!status.installed);
    assert_eq!(status.pack_bytes, 80);
    assert_eq!(status.voices, vec!["noa".to_string(), "adam".to_string()]);
    assert_eq!(status.default_voice, "noa");
    assert!(!status.engine_running);
    assert!(matches!(
        svc.speak(speak("שלום")).await,
        Err(TtsError::NotInstalled)
    ));
    assert_eq!(script.spawns.load(Ordering::SeqCst), 0);
    assert!(!dir.path().join("tts").exists(), "nothing written");
}

#[tokio::test]
async fn speak_streams_chunks_and_warm_starts_one_engine() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);

    let started = svc
        .speak(SpeakRequest {
            text: "  שלום world.  ".into(),
            voice: Some("adam".into()),
            speed: Some(9.0),
        })
        .await
        .unwrap();
    let (pcm, last) = drain(&svc, &started.stream_id).await;
    assert_eq!(pcm, vec![vec![1, 0, 2, 0], vec![3, 0]]);
    assert!(last.error.is_none());
    assert_eq!(last.stats.unwrap().chunks, 2);

    // The finished stream is gone.
    assert!(matches!(
        svc.poll(poll(&started.stream_id)).await,
        Err(TtsError::StreamNotFound)
    ));

    // A second reply reuses the running engine.
    let again = svc.speak(speak("again")).await.unwrap();
    drain(&svc, &again.stream_id).await;
    assert_eq!(script.spawns.load(Ordering::SeqCst), 1);
    assert_eq!(script.ops(), vec!["load", "synthesize", "synthesize"]);
    let first = script.requests.lock().unwrap()[1].clone();
    assert_eq!(first["text"], "שלום world.", "trimmed");
    assert_eq!(first["voice"], "adam");
    assert_eq!(first["speed"], MAX_SPEED, "clamped");

    let status = svc.status();
    assert!(status.engine_running);
    assert!(status.engine_loaded);
}

#[tokio::test]
async fn cancel_stops_the_synthesis_in_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);
    let s = svc.speak(speak("slow and long")).await.unwrap();
    let r = svc.poll(poll(&s.stream_id)).await.unwrap();
    assert_eq!(r.chunks.len(), 1);
    assert!(!r.done);

    svc.cancel(&s.stream_id).await;
    assert!(matches!(
        svc.poll(poll(&s.stream_id)).await,
        Err(TtsError::StreamNotFound)
    ));
    for _ in 0..50 {
        if script.ops().contains(&"cancel".to_string()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let requests = script.requests.lock().unwrap().clone();
    let synth = requests.iter().find(|r| r["op"] == "synthesize").unwrap();
    let cancel = requests.iter().find(|r| r["op"] == "cancel").unwrap();
    assert_eq!(cancel["id"], synth["id"]);
}

#[tokio::test]
async fn a_failed_synthesis_ends_its_stream_with_the_error() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);
    let s = svc.speak(speak("fail")).await.unwrap();
    let (_, last) = drain(&svc, &s.stream_id).await;
    assert_eq!(last.error.as_deref(), Some("voice x not found"));
}

#[tokio::test]
async fn a_crashed_engine_fails_the_stream_and_is_restarted_next_time() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);
    let s = svc.speak(speak("crash")).await.unwrap();
    let (_, last) = drain(&svc, &s.stream_id).await;
    assert!(last.error.is_some());

    let s = svc.speak(speak("hello")).await.unwrap();
    let (pcm, _) = drain(&svc, &s.stream_id).await;
    assert_eq!(pcm.len(), 2);
    assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_idle_engine_is_shut_down_and_started_again_on_demand() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = service(
        dir.path(),
        &script,
        Duration::from_millis(80),
        Duration::from_millis(20),
    );
    svc.store().unwrap().install_placeholder_for_tests();
    let s = svc.speak(speak("hello")).await.unwrap();
    drain(&svc, &s.stream_id).await;
    assert!(svc.status().engine_running);

    for _ in 0..100 {
        if !svc.status().engine_running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!svc.status().engine_running, "idle engine still running");
    assert!(script.ops().contains(&"shutdown".to_string()));

    let s = svc.speak(speak("hello again")).await.unwrap();
    drain(&svc, &s.stream_id).await;
    assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_stream_being_read_keeps_the_engine_alive() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = service(
        dir.path(),
        &script,
        Duration::from_millis(40),
        Duration::from_millis(10),
    );
    svc.store().unwrap().install_placeholder_for_tests();
    let s = svc.speak(speak("slow reply")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(svc.status().engine_running, "stopped mid-stream");
    svc.cancel(&s.stream_id).await;
}

#[tokio::test]
async fn bad_requests_are_rejected_before_the_engine_starts() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);
    for request in [
        speak("   "),
        speak(&"א".repeat(MAX_TEXT_CHARS + 1)),
        SpeakRequest {
            text: "hi".into(),
            voice: Some("../../x".into()),
            speed: None,
        },
    ] {
        assert!(matches!(
            svc.speak(request).await,
            Err(TtsError::InvalidInput(_))
        ));
    }
    assert_eq!(script.spawns.load(Ordering::SeqCst), 0);
    assert!(matches!(
        svc.poll(poll("no-such-stream")).await,
        Err(TtsError::StreamNotFound)
    ));
}

#[tokio::test]
async fn an_unsupported_backend_says_why_and_downloads_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let svc = Arc::new(TtsService::new(TtsConfig {
        models_dir: dir.path().join("tts"),
        catalog: Ok(tiny_catalog()),
        spawner: None,
        unsupported_reason: Some("platform".into()),
        idle_shutdown: IDLE_SHUTDOWN,
        reap_every: Duration::from_secs(30),
    }));
    let status = svc.status();
    assert!(!status.supported);
    assert_eq!(status.unsupported_reason.as_deref(), Some("platform"));
    assert!(matches!(
        svc.start_download(),
        Err(TtsError::Unsupported(_))
    ));
    assert!(matches!(
        svc.speak(speak("hi")).await,
        Err(TtsError::Unsupported(_))
    ));

    let broken = TtsService::new(TtsConfig {
        models_dir: dir.path().join("tts"),
        catalog: Err("CODEG_TTS_CATALOG is not a JSON list".into()),
        spawner: None,
        unsupported_reason: None,
        idle_shutdown: IDLE_SHUTDOWN,
        reap_every: Duration::from_secs(30),
    });
    assert_eq!(
        broken.status().unsupported_reason.as_deref(),
        Some("CODEG_TTS_CATALOG is not a JSON list")
    );
}

#[tokio::test]
async fn a_failed_download_is_reported_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = service(dir.path(), &script, IDLE_SHUTDOWN, Duration::from_secs(30));
    let first = svc.start_download().unwrap();
    assert!(matches!(
        first.download,
        DownloadState::Downloading {
            bytes_total: 80,
            ..
        } | DownloadState::Failed { .. }
    ));
    let mut status = svc.status();
    for _ in 0..200 {
        if !matches!(status.download, DownloadState::Downloading { .. }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
        status = svc.status();
    }
    assert!(
        matches!(status.download, DownloadState::Failed { ref message } if message.contains("bluetts/model.onnx")),
        "{:?}",
        status.download
    );
    assert!(!status.installed);

    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["download"]["state"], "failed");
    assert!(json["packBytes"].is_u64());
    assert!(json["unsupportedReason"].is_null());

    // Cancelling when nothing runs is harmless and resets nothing that matters.
    let after = svc.cancel_download().await;
    assert!(matches!(after.download, DownloadState::Failed { .. }));
}

#[tokio::test]
async fn status_changes_are_announced() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = service(dir.path(), &script, IDLE_SHUTDOWN, Duration::from_secs(30));
    let heard: Arc<Mutex<Vec<TtsStatus>>> = Arc::default();
    let sink = heard.clone();
    svc.on_status_change(|| Arc::new(move |status: TtsStatus| sink.lock().unwrap().push(status)));
    // Only the first listener counts.
    svc.on_status_change(|| panic!("a second listener must not be built"));

    svc.start_download().unwrap();
    for _ in 0..200 {
        if heard.lock().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    {
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 2, "{heard:?}");
        assert!(matches!(heard[0].download, DownloadState::Downloading { .. }));
        assert!(matches!(heard[1].download, DownloadState::Failed { .. }));
    }

    svc.store().unwrap().install_placeholder_for_tests();
    svc.delete_models().await.unwrap();
    let last = heard.lock().unwrap().last().cloned().unwrap();
    assert!(!last.installed);
    assert!(matches!(last.download, DownloadState::Idle));
}

#[tokio::test]
async fn delete_removes_the_models_and_stops_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let svc = installed(dir.path(), &script);
    let s = svc.speak(speak("hello")).await.unwrap();
    drain(&svc, &s.stream_id).await;
    assert!(svc.status().installed);

    let status = svc.delete_models().await.unwrap();
    assert!(!status.installed);
    assert!(!status.engine_running);
    assert_eq!(status.bytes_on_disk, 0);
    assert!(!svc.store().unwrap().dir().exists());
    // The fake reads its stdin on its own task.
    for _ in 0..100 {
        if script.ops().contains(&"shutdown".to_string()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(script.ops().contains(&"shutdown".to_string()));
    assert!(matches!(
        svc.speak(speak("hello")).await,
        Err(TtsError::NotInstalled)
    ));
}

#[test]
fn speed_and_voice_rules() {
    assert_eq!(clamp_speed(None), 1.0);
    assert_eq!(clamp_speed(Some(f64::NAN)), 1.0);
    assert_eq!(clamp_speed(Some(0.1)), MIN_SPEED);
    assert_eq!(clamp_speed(Some(1.3)), 1.3);
    assert!(is_safe_voice_name("noa"));
    assert!(is_safe_voice_name("voice_2-b"));
    assert!(!is_safe_voice_name("a/b"));
    assert!(!is_safe_voice_name(""));
    assert!(!is_safe_voice_name("נועה"));
}

/// The real sidecar and models, end to end through this service:
///
/// ```sh
/// CODEG_TTS_E2E_BIN=…/codeg-tts CODEG_TTS_E2E_MODELS=/tmp/models \
///   CODEG_TTS_E2E_WAV=/tmp/sample.wav \
///   cargo test --lib tts::tests::real_sidecar -- --ignored --nocapture
/// ```
///
/// The models directory may come from BlueTTSKit's `fetch-models.sh`; the
/// store verifies what is there and only fetches what is missing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn real_sidecar_speaks_mixed_hebrew_and_english() {
    let (Some(bin), Some(models)) = (
        std::env::var_os("CODEG_TTS_E2E_BIN"),
        std::env::var_os("CODEG_TTS_E2E_MODELS"),
    ) else {
        eprintln!("CODEG_TTS_E2E_BIN / CODEG_TTS_E2E_MODELS not set; skipping");
        return;
    };
    let svc = Arc::new(TtsService::new(TtsConfig {
        models_dir: PathBuf::from(models),
        catalog: Ok(catalog::builtin()),
        spawner: Some(process_spawner(PathBuf::from(bin))),
        unsupported_reason: None,
        idle_shutdown: IDLE_SHUTDOWN,
        reap_every: Duration::from_secs(30),
    }));
    let store = svc.store().unwrap();
    if !store.is_installed() {
        store
            .download(svc.http(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
    }
    assert!(svc.status().installed);

    const TEXT: &str = "עדכנתי את ה-Dockerfile ודחפתי ל-main. \
        The build passed on the M4 Max in four minutes. \
        אחר כך הרצתי pnpm test, וכל 2,140 הבדיקות עברו. \
        Next I'll open a pull request, ואז נבדוק את זה על ה-iPhone.";

    struct Run {
        first_ms: u128,
        total_ms: u128,
        samples: usize,
        chunks: usize,
        sidecar_first_ms: Option<u64>,
    }

    async fn run(svc: &Arc<TtsService>, pcm_out: &mut Vec<u8>) -> Run {
        let t0 = std::time::Instant::now();
        let s = svc.speak(speak(TEXT)).await.unwrap();
        let mut first = None;
        let mut samples = 0;
        let mut chunks = 0;
        loop {
            let r = svc
                .poll(PollRequest {
                    stream_id: s.stream_id.clone(),
                    wait_ms: Some(15_000),
                })
                .await
                .unwrap();
            for c in &r.chunks {
                first.get_or_insert_with(|| t0.elapsed().as_millis());
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&c.pcm)
                    .unwrap();
                assert!(!bytes.is_empty());
                samples += bytes.len() / 2;
                chunks += 1;
                pcm_out.extend_from_slice(&bytes);
            }
            if r.done {
                assert!(r.error.is_none(), "{:?}", r.error);
                return Run {
                    first_ms: first.unwrap(),
                    total_ms: t0.elapsed().as_millis(),
                    samples,
                    chunks,
                    sidecar_first_ms: r.stats.and_then(|s| s.first_chunk_ms),
                };
            }
        }
    }

    // cold: the first start of this binary (macOS checks a new signature once)
    // and the first model load; warm: the engine kept running, as between
    // replies; restart: started again after an idle shutdown.
    let mut cold_pcm = Vec::new();
    let cold = run(&svc, &mut cold_pcm).await;
    let mut warm_pcm = Vec::new();
    let warm = run(&svc, &mut warm_pcm).await;

    let rss_mb = svc.engine_pid().and_then(|pid| {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .ok()
            .map(|kb| kb / 1024)
    });

    svc.stop_engine().await;
    let restart = run(&svc, &mut Vec::new()).await;

    for (name, r) in [("cold", &cold), ("warm", &warm), ("restart", &restart)] {
        let audio_s = r.samples as f64 / 44_100.0;
        eprintln!(
            "{name}: {} chunks, first chunk {} ms (sidecar {:?} ms), all audio after {} ms, \
             {:.2} s of audio, RTF {:.3}",
            r.chunks,
            r.first_ms,
            r.sidecar_first_ms,
            r.total_ms,
            audio_s,
            r.total_ms as f64 / 1000.0 / audio_s
        );
        assert!(r.chunks >= 4, "one chunk per sentence at least");
        assert!(audio_s > 5.0);
    }
    eprintln!("sidecar resident memory: {rss_mb:?} MB");

    if let Some(path) = std::env::var_os("CODEG_TTS_E2E_WAV") {
        let mut wav = Vec::new();
        let data_len = warm_pcm.len() as u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        wav.extend_from_slice(&(44_100u32 * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(&warm_pcm);
        std::fs::write(&path, wav).unwrap();
        eprintln!("wrote {}", Path::new(&path).display());
    }
    svc.stop_engine().await;
}
