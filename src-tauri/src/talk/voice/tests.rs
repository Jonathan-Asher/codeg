//! The relay against a scripted helper on in-memory pipes: message order,
//! window ownership, replacement, a closed window, a crash, a helper that
//! speaks another protocol or stops answering, presence, and gating.

use std::sync::atomic::AtomicUsize;

use super::catalog::{self, SMART_TURN, ZIPFORMER};
use super::*;

/// How a scripted helper behaves.
#[derive(Clone, Copy)]
struct Script {
    protocol: u32,
    /// Answer `end` with `ended`.
    answers_end: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            answers_end: true,
        }
    }
}

/// One scripted helper, as the test drives it.
struct FakeHelper {
    /// Every line the relay wrote to it.
    received: Arc<Mutex<Vec<Value>>>,
    /// A line for the relay; `None` makes the helper exit.
    say: mpsc::UnboundedSender<Option<String>>,
}

#[derive(Default)]
struct Fakes {
    script: Mutex<Script>,
    helpers: Mutex<Vec<FakeHelper>>,
    launches: Mutex<Vec<HelperLaunch>>,
    spawned: AtomicUsize,
}

impl Fakes {
    fn helper(
        &self,
        index: usize,
    ) -> (
        Arc<Mutex<Vec<Value>>>,
        mpsc::UnboundedSender<Option<String>>,
    ) {
        let helpers = self.helpers.lock().unwrap();
        let helper = &helpers[index];
        (helper.received.clone(), helper.say.clone())
    }

    fn received(&self, index: usize) -> Vec<Value> {
        self.helper(index).0.lock().unwrap().clone()
    }

    fn say(&self, index: usize, message: Value) {
        let _ = self.helper(index).1.send(Some(message.to_string()));
    }

    fn crash(&self, index: usize) {
        let _ = self.helper(index).1.send(None);
    }
}

fn fake_spawner(fakes: Arc<Fakes>) -> HelperSpawner {
    Arc::new(move |launch: &HelperLaunch| {
        fakes.spawned.fetch_add(1, Ordering::SeqCst);
        fakes.launches.lock().unwrap().push(launch.clone());
        let script = *fakes.script.lock().unwrap();
        let (relay_stdin, helper_in) = tokio::io::duplex(1 << 16);
        let (relay_stdout, mut helper_out) = tokio::io::duplex(1 << 16);
        let received = Arc::new(Mutex::new(Vec::new()));
        let (say_tx, mut say_rx) = mpsc::unbounded_channel::<Option<String>>();
        fakes.helpers.lock().unwrap().push(FakeHelper {
            received: received.clone(),
            say: say_tx.clone(),
        });
        tokio::spawn(async move {
            let hello = json!({"type": "hello", "protocol": script.protocol, "version": "test", "mic": "granted"});
            if helper_out
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
            let mut lines = tokio::io::BufReader::new(helper_in).lines();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        let Ok(Some(line)) = line else { return };
                        let message: Value = serde_json::from_str(&line).unwrap();
                        received.lock().unwrap().push(message.clone());
                        let reply = match message["type"].as_str() {
                            Some("start") => Some(json!({"type": "state", "phase": "listening"})),
                            Some("echo") => Some(json!({"type": "echo", "n": message["n"].clone()})),
                            // As codeg-talk answers it.
                            Some("end") if script.answers_end => {
                                Some(json!({"type": "ended", "reason": "ended", "error": null}))
                            }
                            _ => None,
                        };
                        if let Some(reply) = reply {
                            if helper_out.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    }
                    said = say_rx.recv() => {
                        match said.flatten() {
                            Some(line) => {
                                if helper_out.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                                    return;
                                }
                            }
                            // Exit: stdout closes.
                            None => return,
                        }
                    }
                }
            }
        });
        Ok(SpawnedHelper {
            stdout: Box::new(relay_stdout),
            stdin: Box::new(relay_stdin),
            child: None,
        })
    })
}

#[derive(Default)]
struct Recorder {
    delivered: Mutex<Vec<(String, Value)>>,
    active: Mutex<Vec<bool>>,
    presence: Mutex<Vec<(String, i32, bool)>>,
    statuses: AtomicUsize,
}

impl TalkHost for Recorder {
    fn deliver(&self, window: &str, payload: &Value) {
        self.delivered
            .lock()
            .unwrap()
            .push((window.to_string(), payload.clone()));
    }

    fn talk_active(&self, active: bool) {
        self.active.lock().unwrap().push(active);
    }

    fn presence(&self, key: &str, conversation_id: i32, talking: bool) {
        self.presence
            .lock()
            .unwrap()
            .push((key.to_string(), conversation_id, talking));
    }

    fn status_changed(&self, _status: &TalkVoiceStatus) {
        self.statuses.fetch_add(1, Ordering::SeqCst);
    }
}

impl Recorder {
    /// The messages delivered to `window`, with their Talk ids.
    fn to(&self, window: &str) -> Vec<(u64, Value)> {
        self.delivered
            .lock()
            .unwrap()
            .iter()
            .filter(|(w, _)| w == window)
            .map(|(_, p)| (p["talkId"].as_u64().unwrap(), p["message"].clone()))
            .collect()
    }

    fn of_type(&self, window: &str, kind: &str) -> Vec<(u64, Value)> {
        self.to(window)
            .into_iter()
            .filter(|(_, m)| m["type"] == kind)
            .collect()
    }
}

struct Harness {
    service: Arc<TalkVoiceService>,
    fakes: Arc<Fakes>,
    host: Arc<Recorder>,
    _dir: tempfile::TempDir,
}

fn harness_with(script: Script, prober: Option<HelperProber>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let fakes = Arc::new(Fakes::default());
    *fakes.script.lock().unwrap() = script;
    let voice_dir = dir.path().join("tts/bluetts-2.5");
    let service = TalkVoiceService::new(TalkVoiceConfig {
        models_dir: dir.path().join("talk"),
        catalog: Ok(catalog::builtin()),
        voice: Arc::new(move || Some(voice_dir.clone())),
        espeak_data: Some(PathBuf::from("/app/Resources/tts/espeak-ng-data")),
        spawner: Some(fake_spawner(fakes.clone())),
        prober,
        unsupported_reason: None,
        hello_timeout: Duration::from_secs(2),
        end_timeout: Duration::from_millis(200),
        heartbeat: Duration::from_millis(20),
    });
    service
        .models()
        .install_placeholders_for_tests(&[ZIPFORMER, SMART_TURN]);
    let host = Arc::new(Recorder::default());
    let as_host: Arc<dyn TalkHost> = host.clone();
    service.set_host(|| as_host);
    Harness {
        service,
        fakes,
        host,
        _dir: dir,
    }
}

fn harness() -> Harness {
    harness_with(Script::default(), None)
}

fn start_message(conversation_id: i32) -> Value {
    json!({
        "type": "start",
        "protocol": PROTOCOL_VERSION,
        "conversationId": conversation_id,
        "title": "Fix the build",
        "port": {"isInFlight": false},
    })
}

fn request(window: &str, conversation_id: i32, local: bool) -> StartRequest {
    StartRequest {
        window: window.to_string(),
        conversation_id,
        local,
        message: start_message(conversation_id),
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for: {what}");
}

#[tokio::test]
async fn messages_reach_the_helper_in_order_and_its_replies_reach_only_the_owner() {
    let h = harness();
    let started = h.service.start(request("main", 42, true)).await.unwrap();
    assert_eq!(started.hello.protocol, PROTOCOL_VERSION);
    assert_eq!(started.hello.mic, Some(json!("granted")));
    for n in 0..50 {
        h.service
            .send("main", started.talk_id, json!({"type": "echo", "n": n}))
            .unwrap();
    }
    eventually("50 echoes", || h.host.of_type("main", "echo").len() == 50).await;
    let echoes = h.host.of_type("main", "echo");
    let order: Vec<i64> = echoes
        .iter()
        .map(|(_, m)| m["n"].as_i64().unwrap())
        .collect();
    assert_eq!(order, (0..50).collect::<Vec<_>>());
    assert!(echoes.iter().all(|(id, _)| *id == started.talk_id));
    // The start's own reply came first.
    assert_eq!(h.host.to("main")[0].1["type"], "state");
    let delivered = h.host.delivered.lock().unwrap();
    assert!(delivered.iter().all(|(window, _)| window == "main"));
    drop(delivered);
    // The helper got the start before the echoes, with the models added.
    let received = h.fakes.received(0);
    assert_eq!(received[0]["type"], "start");
    assert_eq!(received[0]["conversationId"], 42);
    let models = &received[0]["models"];
    let file = |value: &Value, pack: &str, name: &str| {
        let path = PathBuf::from(value.as_str().unwrap());
        assert!(path.is_absolute());
        assert!(path.ends_with(format!("talk/{pack}/{name}")), "{path:?}");
    };
    file(
        &models["zipformer"]["encoder"],
        ZIPFORMER,
        "zipformer2-66m-streaming-he-encoder.int8.onnx",
    );
    file(
        &models["zipformer"]["decoder"],
        ZIPFORMER,
        "zipformer2-66m-streaming-he-decoder.int8.onnx",
    );
    file(
        &models["zipformer"]["joiner"],
        ZIPFORMER,
        "zipformer2-66m-streaming-he-joiner.int8.onnx",
    );
    file(
        &models["zipformer"]["tokens"],
        ZIPFORMER,
        "zipformer2-66m-streaming-he-tokens.txt",
    );
    file(&models["vad"], ZIPFORMER, "ggml-silero-v5.1.2.bin");
    file(&models["smartTurn"], SMART_TURN, "smart-turn-v3.2-cpu.onnx");
    assert!(models["whisper"].is_null(), "not downloaded");
    assert!(models["languageID"].is_null());
    assert!(models["bluetts"].as_str().unwrap().ends_with("bluetts-2.5"));
    assert_eq!(models["espeakData"], "/app/Resources/tts/espeak-ng-data");
    // The helper's own fixture (native/codeg-talk/fixtures/protocol) has the
    // same keys.
    let fixture: Value =
        serde_json::from_str(include_str!("testdata/to-helper.start.json")).unwrap();
    let keys = |v: &Value| {
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(models), keys(&fixture["models"]));
    assert_eq!(
        keys(&models["zipformer"]),
        keys(&fixture["models"]["zipformer"])
    );
    assert_eq!(received[1]["n"], 0);
    // espeak-ng's data also went on the command line.
    let launch = h.fakes.launches.lock().unwrap()[0].clone();
    assert_eq!(
        helper_args(&launch),
        vec!["--espeak-data", "/app/Resources/tts/espeak-ng-data"]
    );
    assert_eq!(*h.host.active.lock().unwrap(), vec![true]);
    let active = h.service.active().unwrap();
    assert_eq!(
        (active.window.as_str(), active.conversation_id, active.local),
        ("main", 42, true)
    );
}

#[tokio::test]
async fn only_the_window_that_holds_the_talk_drives_or_ends_it() {
    let h = harness();
    let started = h.service.start(request("main", 7, true)).await.unwrap();
    let message = json!({"type": "control", "op": "skip"});
    assert!(matches!(
        h.service
            .send("remote-workspace-3", started.talk_id, message.clone()),
        Err(TalkVoiceError::NotOwner)
    ));
    assert!(matches!(
        h.service.send("main", started.talk_id + 1, message.clone()),
        Err(TalkVoiceError::NotRunning)
    ));
    assert!(matches!(
        h.service.stop("remote-workspace-3", started.talk_id).await,
        Err(TalkVoiceError::NotOwner)
    ));
    assert!(matches!(
        h.service
            .send("main", started.talk_id, json!({"op": "skip"})),
        Err(TalkVoiceError::InvalidInput(_))
    ));
    assert!(matches!(
        h.service.send("main", started.talk_id, start_message(7)),
        Err(TalkVoiceError::InvalidInput(_))
    ));
    assert!(h.service.active().is_some(), "still running");
    h.service.send("main", started.talk_id, message).unwrap();
    eventually("the control", || h.fakes.received(0).len() == 2).await;
}

#[tokio::test]
async fn stopping_sends_end_and_delivers_the_helpers_ended() {
    let h = harness();
    let started = h.service.start(request("main", 7, false)).await.unwrap();
    h.service.stop("main", started.talk_id).await.unwrap();
    let ended = h.host.of_type("main", "ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].0, started.talk_id);
    assert_eq!(ended[0].1["reason"], "ended", "the helper's own word");
    let received = h.fakes.received(0);
    assert_eq!(received.last().unwrap()["type"], "end");
    assert!(h.service.active().is_none());
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false]);
    assert!(matches!(
        h.service.stop("main", started.talk_id).await,
        Err(TalkVoiceError::NotRunning)
    ));
    // The helper stays for the next Talk.
    let again = h.service.start(request("main", 8, false)).await.unwrap();
    assert!(again.talk_id > started.talk_id);
    assert_eq!(h.fakes.spawned.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_new_talk_replaces_the_one_running() {
    let h = harness();
    let first = h.service.start(request("main", 1, true)).await.unwrap();
    let second = h
        .service
        .start(request("remote-workspace-2", 2, false))
        .await
        .unwrap();
    let ended = h.host.of_type("main", "ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].0, first.talk_id);
    assert_eq!(ended[0].1["reason"], "replaced");
    eventually("the second start", || h.fakes.received(0).len() == 3).await;
    let kinds: Vec<String> = h
        .fakes
        .received(0)
        .iter()
        .map(|m| m["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(kinds, vec!["start", "end", "start"]);
    let active = h.service.active().unwrap();
    assert_eq!(active.talk_id, second.talk_id);
    assert_eq!(active.window, "remote-workspace-2");
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false, true]);
    // The old window can no longer drive anything.
    assert!(h
        .service
        .send(
            "main",
            first.talk_id,
            json!({"type": "control", "op": "skip"})
        )
        .is_err());
    // The new one's messages go to the new window only.
    h.service
        .send(
            "remote-workspace-2",
            second.talk_id,
            json!({"type": "echo", "n": 1}),
        )
        .unwrap();
    eventually("the echo", || {
        h.host.of_type("remote-workspace-2", "echo").len() == 1
    })
    .await;
    assert!(h.host.of_type("main", "echo").is_empty());
}

#[tokio::test]
async fn closing_or_reloading_the_window_ends_its_talk() {
    let h = harness();
    h.service.start(request("main", 5, true)).await.unwrap();
    h.service.window_gone("remote-workspace-9").await;
    assert!(
        h.service.active().is_some(),
        "another window's going changes nothing"
    );
    h.service.window_gone("main").await;
    assert!(h.service.active().is_none());
    let received = h.fakes.received(0);
    assert_eq!(received.last().unwrap()["type"], "end");
    assert_eq!(received.last().unwrap()["reason"], "windowClosed");
    assert!(
        h.host.of_type("main", "ended").is_empty(),
        "nothing is delivered to a window that is gone"
    );
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false]);
}

#[tokio::test]
async fn a_helper_crash_ends_the_talk_and_the_next_talk_starts_a_new_helper() {
    let h = harness();
    let started = h.service.start(request("main", 5, true)).await.unwrap();
    h.fakes.crash(0);
    eventually("ended", || !h.host.of_type("main", "ended").is_empty()).await;
    let ended = h.host.of_type("main", "ended");
    assert_eq!(ended[0].0, started.talk_id);
    assert_eq!(ended[0].1["reason"], "crashed");
    eventually("no Talk", || h.service.active().is_none()).await;
    assert!(!h.service.status().helper_running);
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false]);
    h.service.start(request("main", 6, true)).await.unwrap();
    assert_eq!(h.fakes.spawned.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn the_helper_ending_the_talk_itself_finishes_it() {
    let h = harness();
    let started = h.service.start(request("main", 5, false)).await.unwrap();
    // "End the conversation", said aloud.
    h.fakes.say(0, json!({"type": "ended", "reason": "user"}));
    eventually("no Talk", || h.service.active().is_none()).await;
    let ended = h.host.of_type("main", "ended");
    assert_eq!(
        ended,
        vec![(started.talk_id, json!({"type": "ended", "reason": "user"}))]
    );
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false]);
}

#[tokio::test]
async fn a_helper_exiting_between_talks_is_not_a_crash() {
    let h = harness();
    let started = h.service.start(request("main", 5, false)).await.unwrap();
    h.service.stop("main", started.talk_id).await.unwrap();
    let before = h.host.delivered.lock().unwrap().len();
    // Idle for two minutes, the helper leaves.
    h.fakes.crash(0);
    eventually("helper gone", || !h.service.status().helper_running).await;
    assert_eq!(h.host.delivered.lock().unwrap().len(), before);
}

#[tokio::test]
async fn a_helper_that_ignores_end_is_stopped_and_replaced() {
    let h = harness_with(
        Script {
            answers_end: false,
            ..Script::default()
        },
        None,
    );
    let started = h.service.start(request("main", 5, false)).await.unwrap();
    h.service.stop("main", started.talk_id).await.unwrap();
    let ended = h.host.of_type("main", "ended");
    assert_eq!(ended.len(), 1, "the relay says it ended");
    assert_eq!(ended[0].1["reason"], "stopped");
    assert!(h.service.active().is_none());
    assert!(!h.service.status().helper_running, "let go of");
    h.service.start(request("main", 6, false)).await.unwrap();
    assert_eq!(h.fakes.spawned.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_helper_speaking_another_protocol_makes_talk_unsupported() {
    let h = harness_with(
        Script {
            protocol: PROTOCOL_VERSION + 1,
            ..Script::default()
        },
        None,
    );
    let error = h.service.start(request("main", 5, true)).await.unwrap_err();
    assert!(matches!(error, TalkVoiceError::Unsupported(ref r) if r == "protocol"));
    let status = h.service.status();
    assert!(!status.supported);
    assert_eq!(status.unsupported_reason.as_deref(), Some("protocol"));
    assert!(!status.helper_running);
    assert!(h.service.active().is_none());
    assert_eq!(*h.host.active.lock().unwrap(), vec![true, false]);
    assert!(h.fakes.received(0).is_empty(), "no start went out");
}

#[tokio::test]
async fn talk_needs_its_required_models() {
    let h = harness();
    h.service
        .models()
        .delete(&[SMART_TURN.to_string()])
        .await
        .unwrap();
    assert!(matches!(
        h.service.start(request("main", 5, true)).await,
        Err(TalkVoiceError::ModelsMissing)
    ));
    assert_eq!(h.fakes.spawned.load(Ordering::SeqCst), 0);
    assert!(h.host.active.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_talk_starts_with_a_start_message() {
    let h = harness();
    let mut bad = request("main", 5, true);
    bad.message = json!({"type": "live"});
    assert!(matches!(
        h.service.start(bad).await,
        Err(TalkVoiceError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn a_local_session_reports_talking_presence_while_the_helper_says_so() {
    let h = harness();
    let started = h.service.start(request("main", 11, true)).await.unwrap();
    h.fakes.say(
        0,
        json!({"type": "flags", "isTalking": true, "keepsStreamAttached": true}),
    );
    eventually("a few heartbeats", || {
        h.host
            .presence
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, _, talking)| *talking)
            .count()
            >= 3
    })
    .await;
    let key = format!("talk-voice:{}", started.talk_id);
    assert!(h
        .host
        .presence
        .lock()
        .unwrap()
        .iter()
        .all(|(k, id, _)| k == &key && *id == 11));
    // The flags still reach the window.
    assert_eq!(h.host.of_type("main", "flags").len(), 1);
    h.fakes.say(0, json!({"type": "flags", "isTalking": false}));
    eventually("talking off", || {
        h.host.presence.lock().unwrap().last().map(|p| p.2) == Some(false)
    })
    .await;
    let count = h.host.presence.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        h.host.presence.lock().unwrap().len(),
        count,
        "the heartbeat stopped"
    );
    // Talking again, then the Talk ends: presence is taken back.
    h.fakes.say(0, json!({"type": "flags", "isTalking": true}));
    eventually("talking on", || {
        h.host.presence.lock().unwrap().last().map(|p| p.2) == Some(true)
    })
    .await;
    h.service.stop("main", started.talk_id).await.unwrap();
    assert_eq!(
        h.host.presence.lock().unwrap().last().map(|p| p.2),
        Some(false)
    );
}

#[tokio::test]
async fn a_remote_session_reports_no_presence_from_here() {
    let h = harness();
    h.service
        .start(request("remote-workspace-1", 11, false))
        .await
        .unwrap();
    h.fakes.say(0, json!({"type": "flags", "isTalking": true}));
    eventually("the flags", || {
        h.host.of_type("remote-workspace-1", "flags").len() == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(h.host.presence.lock().unwrap().is_empty());
    assert!(h.service.active().unwrap().talking);
}

#[tokio::test]
async fn controls_from_the_app_reach_the_talk_running() {
    let h = harness();
    assert!(!h
        .service
        .control(json!({"type": "control", "op": "toggleMute"})));
    h.service.start(request("main", 3, true)).await.unwrap();
    assert!(h
        .service
        .control(json!({"type": "control", "op": "toggleMute"})));
    eventually("the control", || h.fakes.received(0).len() == 2).await;
    assert_eq!(h.fakes.received(0)[1]["op"], "toggleMute");
}

#[tokio::test]
async fn without_a_helper_talk_is_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let service = TalkVoiceService::new(TalkVoiceConfig {
        models_dir: dir.path().join("talk"),
        catalog: Ok(catalog::builtin()),
        voice: Arc::new(|| None),
        espeak_data: None,
        spawner: None,
        prober: None,
        unsupported_reason: Some("helperMissing".into()),
        hello_timeout: Duration::from_secs(1),
        end_timeout: Duration::from_millis(100),
        heartbeat: Duration::from_millis(20),
    });
    let status = service.status();
    assert!(!status.supported);
    assert_eq!(status.unsupported_reason.as_deref(), Some("helperMissing"));
    assert!(!status.voice_installed);
    assert!(!status.models.ready);
    assert!(matches!(
        service.start(request("main", 1, true)).await,
        Err(TalkVoiceError::Unsupported(_))
    ));
}

#[tokio::test]
async fn a_failed_probe_makes_talk_unsupported_until_it_passes() {
    let passes = Arc::new(Mutex::new(false));
    let flag = passes.clone();
    let prober: HelperProber = Arc::new(move || {
        let ok = *flag.lock().unwrap();
        Box::pin(async move {
            parse_probe(
                true,
                &format!(
                    r#"{{"arm64":true,"macos":"15.2","mic":"granted","protocol":1,"version":"1.0.0","whisperLoads":{ok}}}"#
                ),
                "",
            )
        })
    });
    let h = harness_with(Script::default(), Some(prober));
    assert!(h.service.status().supported, "nothing known yet");
    let status = h.service.probe(false).await;
    assert!(!status.supported);
    assert_eq!(status.unsupported_reason.as_deref(), Some("probe"));
    assert_eq!(
        status.probe.unwrap().error.as_deref(),
        Some("the speech engine (whisper.cpp) did not load")
    );
    assert!(h.service.start(request("main", 1, true)).await.is_err());
    *passes.lock().unwrap() = true;
    assert!(
        !h.service.probe(false).await.supported,
        "cached until refreshed"
    );
    let status = h.service.probe(true).await;
    assert!(status.supported);
    assert_eq!(status.probe.unwrap().report.unwrap()["macos"], "15.2");
}

#[test]
fn the_probe_report_is_read_from_its_last_json_line() {
    // What codeg-talk --probe prints.
    let line = r#"{"arm64":true,"macos":"26.6.2","mic":"undetermined","protocol":1,"version":"1.0.0","whisperLoads":true}"#;
    let ok = parse_probe(true, &format!("loading\n{line}\n"), "");
    assert!(ok.ok && ok.error.is_none());
    assert_eq!(ok.report.unwrap()["mic"], "undetermined");
    let denied = parse_probe(true, &line.replace("undetermined", "denied"), "");
    assert!(
        denied.ok,
        "the microphone permission is asked when Talk starts"
    );
    let intel = parse_probe(
        true,
        &line.replace(r#""arm64":true"#, r#""arm64":false"#),
        "",
    );
    assert_eq!(
        intel.error.as_deref(),
        Some("Talk on this Mac needs Apple Silicon")
    );
    let old = parse_probe(true, &line.replace("26.6.2", "14.7"), "");
    assert_eq!(
        old.error.as_deref(),
        Some("Talk on this Mac needs macOS 15 or later")
    );
    let no_whisper = parse_probe(
        true,
        &line.replace(r#""whisperLoads":true"#, r#""whisperLoads":false"#),
        "",
    );
    assert!(!no_whisper.ok);
    let other = parse_probe(
        true,
        &line.replace(r#""protocol":1"#, r#""protocol":2"#),
        "",
    );
    assert!(!other.ok);
    let failed_exit = parse_probe(false, "", "dyld: whisper.framework not found\n");
    assert!(!failed_exit.ok);
    assert_eq!(
        failed_exit.error.as_deref(),
        Some("dyld: whisper.framework not found")
    );
    let says_no = parse_probe(
        true,
        r#"{"ok":false,"error":"macOS 15 or later is needed"}"#,
        "",
    );
    assert!(!says_no.ok);
    assert_eq!(
        says_no.error.as_deref(),
        Some("macOS 15 or later is needed")
    );
    let silent = parse_probe(true, "", "");
    assert!(silent.ok, "a clean exit with no report passes");
}

#[test]
fn the_helper_is_launched_with_espeak_data_only() {
    let launch = HelperLaunch { espeak_data: None };
    assert!(helper_args(&launch).is_empty());
    let launch = HelperLaunch {
        espeak_data: Some(PathBuf::from("/app/espeak-ng-data")),
    };
    assert_eq!(
        helper_args(&launch),
        vec!["--espeak-data", "/app/espeak-ng-data"]
    );
}

#[tokio::test]
async fn whisper_goes_to_the_helper_once_downloaded_and_wanted() {
    let h = harness();
    h.service
        .models()
        .install_placeholders_for_tests(&[catalog::WHISPER]);
    let models = h.service.start_models(true);
    assert!(models["whisper"]
        .as_str()
        .unwrap()
        .ends_with("he-turbo/ggml-ivrit-large-v3-turbo-q8_0.bin"));
    assert!(models["languageID"]
        .as_str()
        .unwrap()
        .ends_with("he-turbo/ggml-tiny-q8_0.bin"));
    let without = h.service.start_models(false);
    assert!(without["whisper"].is_null() && without["languageID"].is_null());
    // The window's prefs decide.
    let mut req = request("main", 9, true);
    req.message["prefs"] = json!({"handsFree": true, "useWhisper": false});
    h.service.start(req).await.unwrap();
    eventually("the start", || !h.fakes.received(0).is_empty()).await;
    assert!(h.fakes.received(0)[0]["models"]["whisper"].is_null());
}

#[tokio::test]
async fn a_probe_naming_another_protocol_makes_talk_unsupported() {
    let prober: HelperProber = Arc::new(|| {
        Box::pin(async {
            parse_probe(
                true,
                r#"{"arm64":true,"macos":"15.4","mic":"granted","protocol":2,"version":"2.0.0","whisperLoads":true}"#,
                "",
            )
        })
    });
    let h = harness_with(Script::default(), Some(prober));
    let status = h.service.probe(false).await;
    assert!(!status.supported);
    assert_eq!(status.unsupported_reason.as_deref(), Some("protocol"));
}

#[tokio::test]
async fn the_first_status_starts_the_probe_in_the_background() {
    let runs = Arc::new(AtomicUsize::new(0));
    let counter = runs.clone();
    let prober: HelperProber = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { parse_probe(true, "", "") })
    });
    let h = harness_with(Script::default(), Some(prober));
    let before = h.host.statuses.load(Ordering::SeqCst);
    h.service.ensure_probe();
    h.service.ensure_probe();
    eventually("the probe", || h.service.status().probe.is_some()).await;
    eventually("announced", || {
        h.host.statuses.load(Ordering::SeqCst) > before
    })
    .await;
    assert_eq!(runs.load(Ordering::SeqCst), 1, "once");
    h.service.ensure_probe();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(runs.load(Ordering::SeqCst), 1, "not again");
}
