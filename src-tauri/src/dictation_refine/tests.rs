//! Request shapes, answers, errors, the settings merge and the key handling,
//! against a mock provider.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Value};

use super::providers::{build_call, custom_url, humanize_http, parse_answer, Answer, Job};
use super::*;
use crate::db::test_helpers;

// ── Fakes ──

#[derive(Default)]
struct MemoryKeys {
    keys: Mutex<HashMap<RefineProvider, String>>,
    broken: bool,
}

impl MemoryKeys {
    fn with(provider: RefineProvider, key: &str) -> Self {
        let keys = Self::default();
        keys.set(provider, key).unwrap();
        keys
    }
}

impl KeyStore for MemoryKeys {
    fn get(&self, provider: RefineProvider) -> Result<Option<String>, String> {
        if self.broken {
            return Err("keychain locked".into());
        }
        Ok(self.keys.lock().unwrap().get(&provider).cloned())
    }
    fn set(&self, provider: RefineProvider, key: &str) -> Result<(), String> {
        self.keys.lock().unwrap().insert(provider, key.to_string());
        Ok(())
    }
    fn delete(&self, provider: RefineProvider) -> Result<(), String> {
        self.keys.lock().unwrap().remove(&provider);
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Value,
}

/// A scripted reply; past the script, a plain OpenAI-shaped answer.
#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: String,
    delay: Duration,
}

impl Reply {
    fn json(status: StatusCode, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }
}

fn chat_answer(text: &str) -> Value {
    json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] })
}

#[derive(Clone, Default)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
    script: Arc<Mutex<VecDeque<Reply>>>,
}

impl Mock {
    fn hits(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

async fn answer(
    State(mock): State<Mock>,
    uri: Uri,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: String,
) -> Response {
    mock.seen.lock().unwrap().push(Seen {
        path: uri.path().to_string(),
        query,
        headers,
        body: serde_json::from_str(&body).unwrap_or(Value::Null),
    });
    let reply = mock
        .script
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or_else(|| Reply::json(StatusCode::OK, chat_answer("The clean text.")));
    if !reply.delay.is_zero() {
        tokio::time::sleep(reply.delay).await;
    }
    (
        reply.status,
        [("content-type", "application/json")],
        reply.body,
    )
        .into_response()
}

async fn mock_provider(script: Vec<Reply>) -> (String, Mock) {
    let mock = Mock {
        script: Arc::new(Mutex::new(script.into())),
        ..Mock::default()
    };
    let app = Router::new().fallback(answer).with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), mock)
}

fn refiner(base: &str) -> Refiner {
    Refiner::new(Duration::from_secs(5), Some(base.to_string()))
}

fn request(text: &str) -> RefineRequest {
    RefineRequest {
        text: text.to_string(),
        ..RefineRequest::default()
    }
}

const HEBREW: &str = "אה… תשמע, בעצם, אני צריך לשלוח את המסמך ללקוח.";

fn job<'a>(provider: RefineProvider, model: &'a str) -> Job<'a> {
    Job {
        provider,
        model,
        endpoint: "",
        system: "SYSTEM",
        text: "TEXT",
        target_language: "English",
        source_language: None,
    }
}

// ── Request shapes ──

#[test]
fn openai_compatible_providers_send_a_chat_completion_with_a_bearer_key() {
    for (provider, url, model) in [
        (
            RefineProvider::Groq,
            "https://api.groq.com/openai/v1/chat/completions",
            "openai/gpt-oss-120b",
        ),
        (
            RefineProvider::Cerebras,
            "https://api.cerebras.ai/v1/chat/completions",
            "gpt-oss-120b",
        ),
        (
            RefineProvider::Openai,
            "https://api.openai.com/v1/chat/completions",
            "gpt-4o-mini",
        ),
    ] {
        assert_eq!(provider.default_model(), Some(model));
        let call = build_call(&job(provider, model), "k-123", None);
        assert_eq!(call.url, url);
        assert!(call.query.is_empty());
        assert_eq!(
            call.headers,
            vec![("authorization", "Bearer k-123".to_string())]
        );
        assert_eq!(
            call.body,
            json!({
                "model": model,
                "temperature": 0.1,
                "messages": [
                    { "role": "system", "content": "SYSTEM" },
                    { "role": "user", "content": "<dictation>\nTEXT\n</dictation>" },
                ],
            })
        );
    }
}

#[test]
fn anthropic_sends_a_messages_request_without_temperature() {
    let call = build_call(
        &job(RefineProvider::Anthropic, "claude-haiku-4-5-20251001"),
        "ak-1",
        None,
    );
    assert_eq!(call.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(
        call.headers,
        vec![
            ("x-api-key", "ak-1".to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ]
    );
    assert_eq!(
        call.body,
        json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 2048,
            "system": "SYSTEM",
            "messages": [{ "role": "user", "content": "<dictation>\nTEXT\n</dictation>" }],
        })
    );
    assert!(call.body.get("temperature").is_none());
}

#[test]
fn google_translates_by_language_code_with_the_key_in_the_query() {
    let mut google = job(RefineProvider::Google, GOOGLE_MODEL);
    let call = build_call(&google, "gk-1", None);
    assert_eq!(
        call.url,
        "https://translation.googleapis.com/language/translate/v2"
    );
    assert_eq!(call.query, vec![("key", "gk-1".to_string())]);
    assert!(call.headers.is_empty());
    assert_eq!(
        call.body,
        json!({ "q": "TEXT", "target": "en", "format": "text" })
    );

    google.source_language = Some("Hebrew");
    let call = build_call(&google, "gk-1", None);
    assert_eq!(call.body["source"], "he");
}

#[test]
fn a_custom_endpoint_gets_chat_completions_and_no_auth_without_a_key() {
    assert_eq!(
        custom_url("http://localhost:11434/v1/"),
        "http://localhost:11434/v1/chat/completions"
    );
    assert_eq!(
        custom_url("https://x.example/v1/chat/completions"),
        "https://x.example/v1/chat/completions"
    );
    let mut custom = job(RefineProvider::Custom, "llama3");
    custom.endpoint = "http://localhost:11434/v1";
    let call = build_call(&custom, "", None);
    assert_eq!(call.url, "http://localhost:11434/v1/chat/completions");
    assert!(call.headers.is_empty());
    assert_eq!(call.body["model"], "llama3");
    let call = build_call(&custom, "ck", None);
    assert_eq!(
        call.headers,
        vec![("authorization", "Bearer ck".to_string())]
    );
}

#[test]
fn a_base_override_keeps_the_path() {
    let call = build_call(
        &job(RefineProvider::Groq, "m"),
        "k",
        Some("http://127.0.0.1:9/"),
    );
    assert_eq!(call.url, "http://127.0.0.1:9/openai/v1/chat/completions");
}

// ── Answers and errors ──

#[test]
fn answers_are_read_per_provider() {
    let whole = |text: &str| Answer {
        text: text.into(),
        truncated: false,
    };
    assert_eq!(
        parse_answer(RefineProvider::Groq, &chat_answer("hi")).unwrap(),
        whole("hi")
    );
    let anthropic = json!({
        "content": [{ "type": "thinking", "thinking": "…" }, { "type": "text", "text": "hello" }],
        "stop_reason": "end_turn",
    });
    assert_eq!(
        parse_answer(RefineProvider::Anthropic, &anthropic).unwrap(),
        whole("hello")
    );
    let refused = json!({ "content": [], "stop_reason": "refusal" });
    assert!(matches!(
        parse_answer(RefineProvider::Anthropic, &refused),
        Err(RefineError::BadResponse(m)) if m.contains("refused")
    ));
    let google = json!({ "data": { "translations": [{ "translatedText": "Hello world" }] } });
    assert_eq!(
        parse_answer(RefineProvider::Google, &google).unwrap(),
        whole("Hello world")
    );
    assert!(matches!(
        parse_answer(RefineProvider::Openai, &json!({})),
        Err(RefineError::BadResponse(_))
    ));
}

#[test]
fn an_answer_cut_short_is_marked_truncated() {
    for reason in ["length", "content_filter"] {
        let body = json!({ "choices": [{
            "message": { "role": "assistant", "content": "I need to send" },
            "finish_reason": reason,
        }] });
        assert!(
            parse_answer(RefineProvider::Groq, &body).unwrap().truncated,
            "{reason}"
        );
    }
    let done = json!({ "choices": [{
        "message": { "role": "assistant", "content": "Done." },
        "finish_reason": "stop",
    }] });
    assert!(
        !parse_answer(RefineProvider::Cerebras, &done)
            .unwrap()
            .truncated
    );
    for (stop, cut) in [("max_tokens", true), ("end_turn", false)] {
        let body = json!({
            "content": [{ "type": "text", "text": "I need to" }],
            "stop_reason": stop,
        });
        assert_eq!(
            parse_answer(RefineProvider::Anthropic, &body)
                .unwrap()
                .truncated,
            cut,
            "{stop}"
        );
    }
}

#[test]
fn http_errors_read_as_something_to_do() {
    let rejected = humanize_http(RefineProvider::Groq, 401, "Invalid API Key gsk_abc");
    assert_eq!(
        rejected.to_string(),
        format!("Groq: the API key was rejected — check it in {SETTINGS_LOCATION}")
    );
    // The provider's detail (which can echo part of the key) stays out.
    assert!(!rejected.to_string().contains("gsk_abc"));
    assert!(humanize_http(
        RefineProvider::Google,
        403,
        "Requests to this API are blocked."
    )
    .to_string()
    .contains("Cloud Translation API isn't enabled"));
    assert!(
        humanize_http(RefineProvider::Openai, 404, "The model `x` does not exist")
            .to_string()
            .contains("that model isn't available")
    );
    assert_eq!(
        humanize_http(RefineProvider::Cerebras, 429, "").to_string(),
        "Cerebras: rate limited — try again in a moment"
    );
    assert_eq!(
        humanize_http(RefineProvider::Anthropic, 529, "Overloaded").to_string(),
        "Anthropic is having trouble right now — try again shortly"
    );
    assert!(humanize_http(RefineProvider::Groq, 400, &"x".repeat(500))
        .to_string()
        .ends_with('…'));
}

#[test]
fn errors_become_app_errors_with_the_same_message() {
    let cases = [
        (
            RefineError::NotConfigured("no key".into()),
            AppErrorCode::ConfigurationMissing,
        ),
        (
            humanize_http(RefineProvider::Groq, 401, ""),
            AppErrorCode::AuthenticationFailed,
        ),
        (
            humanize_http(RefineProvider::Groq, 404, ""),
            AppErrorCode::ConfigurationInvalid,
        ),
        (
            humanize_http(RefineProvider::Groq, 503, ""),
            AppErrorCode::NetworkError,
        ),
        (
            RefineError::Empty("Groq".into()),
            AppErrorCode::TaskExecutionFailed,
        ),
    ];
    for (err, code) in cases {
        let message = err.to_string();
        let app: AppCommandError = err.into();
        assert_eq!(
            serde_json::to_value(app.code).unwrap(),
            serde_json::to_value(code).unwrap()
        );
        assert_eq!(app.message, message);
    }
}

// ── Against a mock provider ──

#[tokio::test]
async fn refine_cleans_and_translates_with_the_settings() {
    let (base, mock) = mock_provider(vec![Reply::json(
        StatusCode::OK,
        chat_answer("  I need to send the document to the client.\n"),
    )])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "gsk_live");
    let settings = DictationRefineSettings {
        instructions: "Keep legal terms.".into(),
        ..DictationRefineSettings::default()
    };
    let mut req = request(HEBREW);
    req.source_language = Some("he".into());
    let out = refine(&settings, &keys, &refiner(&base), &req)
        .await
        .unwrap();
    assert_eq!(out.text, "I need to send the document to the client.");
    assert_eq!(out.provider, "groq");
    assert_eq!(out.model, "openai/gpt-oss-120b");

    let hits = mock.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/openai/v1/chat/completions");
    assert_eq!(hits[0].headers["authorization"], "Bearer gsk_live");
    let system = hits[0].body["messages"][0]["content"].as_str().unwrap();
    assert!(system.starts_with(prompt::FRAME_INSTRUCTION));
    assert!(system.contains(prompt::REFINE_INSTRUCTION));
    assert!(system.contains(prompt::DATA_RULE));
    assert!(!system.contains(prompt::STRICT_RULE));
    assert!(system.contains("The dictation is in Hebrew."));
    assert!(system.contains("Then translate the result to English."));
    assert!(system.contains("Keep legal terms."));
    assert!(system.ends_with("Output only the clean translation."));
    assert_eq!(
        hits[0].body["messages"][1]["content"],
        format!("<dictation>\n{HEBREW}\n</dictation>")
    );
    assert!(!out.kept_original);
}

#[tokio::test]
async fn request_values_override_the_settings() {
    let (base, mock) = mock_provider(vec![]).await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let mut req = request(HEBREW);
    req.translate = Some(false);
    refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    let system = mock.hits()[0].body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(system.ends_with("Output only the cleaned text."));

    let mut req = request(HEBREW);
    req.refine = Some(false);
    req.target_language = Some("fr".into());
    refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    let system = mock.hits()[1].body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(system.contains(
        "\nTranslate the user's text to French. Output only the translation, nothing else.\n"
    ));
}

#[tokio::test]
async fn one_failure_is_retried() {
    let (base, mock) = mock_provider(vec![
        Reply::json(
            StatusCode::BAD_GATEWAY,
            json!({ "error": { "message": "upstream" } }),
        ),
        Reply::json(StatusCode::OK, chat_answer("ok")),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("hello"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "ok");
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn an_empty_answer_is_an_error_after_the_retry() {
    let (base, mock) = mock_provider(vec![
        Reply::json(StatusCode::OK, chat_answer("   ")),
        Reply::json(StatusCode::OK, chat_answer("")),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let err = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("hello"),
    )
    .await
    .unwrap_err();
    assert_eq!(err, RefineError::Empty("Groq".into()));
    assert_eq!(err.to_string(), "Groq returned an empty result");
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn a_rejected_key_says_so_without_echoing_it() {
    let rejected = || {
        Reply::json(
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "message": "Incorrect API key provided: sk-abc***xyz" } }),
        )
    };
    let (base, _mock) = mock_provider(vec![rejected(), rejected()]).await;
    let keys = MemoryKeys::with(RefineProvider::Openai, "sk-abcdefxyz");
    let settings = DictationRefineSettings {
        provider: RefineProvider::Openai,
        ..DictationRefineSettings::default()
    };
    let err = refine(&settings, &keys, &refiner(&base), &request("hello"))
        .await
        .unwrap_err();
    let app: AppCommandError = err.into();
    assert!(app.message.starts_with("OpenAI: the API key was rejected"));
    assert!(!serde_json::to_string(&app).unwrap().contains("sk-abc"));
}

#[tokio::test]
async fn a_provider_that_does_not_answer_in_time_is_unreachable() {
    let slow = || Reply {
        status: StatusCode::OK,
        body: chat_answer("late").to_string(),
        delay: Duration::from_secs(3),
    };
    let (base, mock) = mock_provider(vec![slow(), slow()]).await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let refiner = Refiner::new(Duration::from_millis(150), Some(base));
    let err = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner,
        &request("hello"),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&err, RefineError::Unreachable(m) if m.contains("didn't respond")),
        "{err:?}"
    );
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn anthropic_and_google_go_through_their_own_apis() {
    let (base, mock) = mock_provider(vec![
        Reply::json(
            StatusCode::OK,
            json!({ "content": [{ "type": "text", "text": "Clean." }], "stop_reason": "end_turn" }),
        ),
        Reply::json(
            StatusCode::OK,
            json!({ "data": { "translations": [{ "translatedText": "Hello world" }] } }),
        ),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Anthropic, "ak");
    keys.set(RefineProvider::Google, "g&k").unwrap();

    let anthropic = DictationRefineSettings {
        provider: RefineProvider::Anthropic,
        ..DictationRefineSettings::default()
    };
    let out = refine(&anthropic, &keys, &refiner(&base), &request(HEBREW))
        .await
        .unwrap();
    assert_eq!(
        (out.text.as_str(), out.model.as_str()),
        ("Clean.", "claude-haiku-4-5-20251001")
    );

    let google = DictationRefineSettings {
        provider: RefineProvider::Google,
        refine: false,
        ..DictationRefineSettings::default()
    };
    let mut req = request("שלום עולם");
    req.source_language = Some("he".into());
    let out = refine(&google, &keys, &refiner(&base), &req).await.unwrap();
    assert_eq!(out.text, "Hello world");
    assert_eq!(out.provider, "google");
    assert_eq!(out.model, GOOGLE_MODEL);

    let hits = mock.hits();
    assert_eq!(hits[0].path, "/v1/messages");
    assert_eq!(hits[0].headers["x-api-key"], "ak");
    assert_eq!(hits[0].headers["anthropic-version"], "2023-06-01");
    assert!(hits[0].body.get("temperature").is_none());
    assert_eq!(hits[1].path, "/language/translate/v2");
    // URL-encoded.
    assert_eq!(hits[1].query.as_deref(), Some("key=g%26k"));
    assert_eq!(
        hits[1].body,
        json!({ "q": "שלום עולם", "target": "en", "format": "text", "source": "he" })
    );
}

#[tokio::test]
async fn what_cannot_work_fails_before_any_request() {
    let (base, mock) = mock_provider(vec![]).await;
    let none = MemoryKeys::default();

    // Google cannot clean up.
    let google = DictationRefineSettings {
        provider: RefineProvider::Google,
        ..DictationRefineSettings::default()
    };
    let keys = MemoryKeys::with(RefineProvider::Google, "g");
    let err = refine(&google, &keys, &refiner(&base), &request("x"))
        .await
        .unwrap_err();
    assert!(matches!(err, RefineError::Unsupported(_)));

    // No key.
    let err = refine(
        &DictationRefineSettings::default(),
        &none,
        &refiner(&base),
        &request("x"),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err,
        RefineError::NotConfigured(format!(
            "No Groq API key is saved. Add it in {SETTINGS_LOCATION}."
        ))
    );

    // A custom provider needs its endpoint and model, not a key.
    let custom = DictationRefineSettings {
        provider: RefineProvider::Custom,
        ..DictationRefineSettings::default()
    };
    let err = refine(&custom, &none, &refiner(&base), &request("x"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no endpoint"));

    // A store that will not open.
    let broken = MemoryKeys {
        broken: true,
        ..MemoryKeys::default()
    };
    let err = refine(
        &DictationRefineSettings::default(),
        &broken,
        &refiner(&base),
        &request("x"),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, RefineError::KeyStore(_)));

    // Blank text.
    let err = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("  \n"),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, RefineError::InvalidInput(_)));

    assert!(mock.hits().is_empty());
}

#[tokio::test]
async fn a_custom_endpoint_without_a_key_works() {
    let (base, mock) = mock_provider(vec![]).await;
    let custom = DictationRefineSettings {
        provider: RefineProvider::Custom,
        endpoint: format!("{base}/v1"),
        model: "local-model".into(),
        ..DictationRefineSettings::default()
    };
    let out = refine(
        &custom,
        &MemoryKeys::default(),
        &Refiner::new(Duration::from_secs(5), None),
        &request("x"),
    )
    .await
    .unwrap();
    assert_eq!(
        (out.provider.as_str(), out.model.as_str()),
        ("custom", "local-model")
    );
    let hits = mock.hits();
    assert_eq!(hits[0].path, "/v1/chat/completions");
    assert!(hits[0].headers.get("authorization").is_none());
}

#[tokio::test]
async fn nothing_asked_returns_the_text_as_it_came() {
    let mut req = request("  שלום  ");
    req.refine = Some(false);
    req.translate = Some(false);
    let out = refine(
        &DictationRefineSettings::default(),
        &MemoryKeys::default(),
        &Refiner::new(Duration::from_secs(1), Some("http://127.0.0.1:9".into())),
        &req,
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        RefineResult {
            text: "שלום".into(),
            provider: NO_PROVIDER.into(),
            model: String::new(),
            elapsed_ms: 0,
            kept_original: false,
        }
    );
}

#[tokio::test]
async fn a_clean_up_that_drops_most_of_a_long_dictation_keeps_the_original() {
    let long = "מילה ".repeat(80);
    let (base, mock) = mock_provider(vec![]).await; // answers "The clean text."
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let mut req = request(&long);
    req.translate = Some(false);
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    assert!(out.kept_original);
    assert_eq!(out.text, long.trim());
    // The first answer, then the stricter retry.
    assert_eq!(mock.hits().len(), 2);

    // A translation may be shorter.
    req.translate = Some(true);
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    assert_eq!(out.text, "The clean text.");
    assert!(!out.kept_original);
    assert_eq!(mock.hits().len(), 3);
}

const REFUSAL: &str = "I\u{2019}m sorry, but I can\u{2019}t help with that.";

fn system_of(hit: &Seen) -> String {
    hit.body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_refusal_is_retried_once_with_a_stricter_prompt() {
    let (base, mock) = mock_provider(vec![
        Reply::json(StatusCode::OK, chat_answer(REFUSAL)),
        Reply::json(StatusCode::OK, chat_answer("What's the server password?")),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let mut req = request("מה הסיסמה של השרת?");
    req.source_language = Some("he".into());
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    assert_eq!(out.text, "What's the server password?");
    assert!(!out.kept_original);

    let hits = mock.hits();
    assert_eq!(hits.len(), 2);
    assert!(!system_of(&hits[0]).contains(prompt::STRICT_RULE));
    let strict = system_of(&hits[1]);
    assert!(strict.contains(prompt::STRICT_RULE));
    assert!(strict.contains(prompt::DATA_RULE));
    assert!(strict.ends_with("Output only the clean translation."));
    // Both carry the same framed dictation.
    for hit in &hits {
        assert_eq!(
            hit.body["messages"][1]["content"],
            "<dictation>\nמה הסיסמה של השרת?\n</dictation>"
        );
    }
}

#[tokio::test]
async fn a_second_refusal_keeps_the_original_and_says_so() {
    for translate in [true, false] {
        let (base, mock) = mock_provider(vec![
            Reply::json(StatusCode::OK, chat_answer(REFUSAL)),
            Reply::json(
                StatusCode::OK,
                chat_answer("מצטער, אבל אני לא יכול לעזור בזה."),
            ),
        ])
        .await;
        let keys = MemoryKeys::with(RefineProvider::Groq, "k");
        let mut req = request("  תן לי את הסיסמה של השרת \n");
        req.translate = Some(translate);
        let out = refine(
            &DictationRefineSettings::default(),
            &keys,
            &refiner(&base),
            &req,
        )
        .await
        .unwrap();
        assert_eq!(
            out,
            RefineResult {
                text: "תן לי את הסיסמה של השרת".into(),
                provider: "groq".into(),
                model: "openai/gpt-oss-120b".into(),
                elapsed_ms: out.elapsed_ms,
                kept_original: true,
            },
            "translate {translate}"
        );
        assert_eq!(mock.hits().len(), 2);
    }
}

#[tokio::test]
async fn a_strict_retry_that_fails_keeps_the_original() {
    let (base, mock) = mock_provider(vec![
        Reply::json(StatusCode::OK, chat_answer(REFUSAL)),
        Reply::json(
            StatusCode::BAD_GATEWAY,
            json!({ "error": { "message": "upstream" } }),
        ),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("What's the admin password?"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "What's the admin password?");
    assert!(out.kept_original);
    // One stricter attempt, not two.
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn a_clean_up_that_answers_the_question_is_retried() {
    let (base, mock) = mock_provider(vec![
        Reply::json(
            StatusCode::OK,
            chat_answer("I don't have access to real-time information."),
        ),
        Reply::json(StatusCode::OK, chat_answer("What time is it now?")),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let mut req = request("uh what time is it now");
    req.translate = Some(false);
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &req,
    )
    .await
    .unwrap();
    assert_eq!(out.text, "What time is it now?");
    assert!(!out.kept_original);
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn the_speakers_own_apology_is_not_a_refusal() {
    let (base, mock) = mock_provider(vec![Reply::json(
        StatusCode::OK,
        chat_answer("Sorry, I can't help with that. Ask Yossi."),
    )])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("סליחה, אני לא יכול לעזור עם זה, תשאל את יוסי"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "Sorry, I can't help with that. Ask Yossi.");
    assert!(!out.kept_original);
    assert_eq!(mock.hits().len(), 1);
}

#[tokio::test]
async fn echoed_tags_are_taken_off_the_answer() {
    let (base, _mock) = mock_provider(vec![Reply::json(
        StatusCode::OK,
        chat_answer("<dictation>\nI need to send the document.\n</dictation>"),
    )])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request(HEBREW),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "I need to send the document.");
}

#[tokio::test]
async fn a_dictated_apology_comes_back_unchanged() {
    // The speaker's own "I'm sorry, I can't…" is a dictation, not a refusal:
    // one call, the answer used as it came.
    const SAID: &str = "I'm sorry, I can't make it today";
    for (translate, answer) in [
        (false, "I'm sorry, I can't make it today."),
        (false, SAID),
        (true, "I\u{2019}m sorry, I can\u{2019}t make it today."),
    ] {
        let (base, mock) =
            mock_provider(vec![Reply::json(StatusCode::OK, chat_answer(answer))]).await;
        let keys = MemoryKeys::with(RefineProvider::Groq, "k");
        let mut req = request(SAID);
        req.translate = Some(translate);
        let out = refine(
            &DictationRefineSettings::default(),
            &keys,
            &refiner(&base),
            &req,
        )
        .await
        .unwrap();
        assert_eq!(out.text, answer);
        assert!(!out.kept_original);
        assert_eq!(mock.hits().len(), 1, "{answer}");
    }
}

fn chat_answer_cut(text: &str, reason: &str) -> Value {
    json!({ "choices": [{
        "message": { "role": "assistant", "content": text },
        "finish_reason": reason,
    }] })
}

#[tokio::test]
async fn a_cut_off_answer_is_retried_and_never_inserted() {
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    // Cut off, then whole on the stricter retry.
    let (base, mock) = mock_provider(vec![
        Reply::json(
            StatusCode::OK,
            chat_answer_cut("I need to send the", "length"),
        ),
        Reply::json(StatusCode::OK, chat_answer("I need to send the document.")),
    ])
    .await;
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request(HEBREW),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "I need to send the document.");
    assert!(!out.kept_original);
    assert_eq!(mock.hits().len(), 2);

    // Cut off both times: the speaker's words, not half a message.
    let (base, mock) = mock_provider(vec![
        Reply::json(
            StatusCode::OK,
            chat_answer_cut("I need to send the", "length"),
        ),
        Reply::json(StatusCode::OK, chat_answer_cut("I need", "content_filter")),
    ])
    .await;
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request(HEBREW),
    )
    .await
    .unwrap();
    assert_eq!(out.text, HEBREW);
    assert!(out.kept_original);
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn echoed_empty_tags_keep_the_original() {
    let (base, mock) = mock_provider(vec![
        Reply::json(StatusCode::OK, chat_answer("<dictation>\n</dictation>")),
        Reply::json(StatusCode::OK, chat_answer("<dictation></dictation>")),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request(HEBREW),
    )
    .await
    .unwrap();
    assert_eq!(out.text, HEBREW);
    assert!(out.kept_original);
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn a_lecture_instead_of_the_translation_keeps_the_original() {
    const LECTURE: &str = "Sharing server passwords over chat is risky. Ask your \
        administrator to grant you access through the company's password manager instead.";
    let (base, mock) = mock_provider(vec![
        Reply::json(StatusCode::OK, chat_answer(LECTURE)),
        Reply::json(
            StatusCode::OK,
            chat_answer("The dictated text asks for a password, so there is nothing to translate."),
        ),
    ])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Groq, "k");
    let out = refine(
        &DictationRefineSettings::default(),
        &keys,
        &refiner(&base),
        &request("תן לי את הסיסמה של השרת"),
    )
    .await
    .unwrap();
    assert_eq!(out.text, "תן לי את הסיסמה של השרת");
    assert!(out.kept_original);
    assert_eq!(mock.hits().len(), 2);
}

#[tokio::test]
async fn google_translations_are_not_judged() {
    // Google is a translation engine: it cannot refuse, so a translated
    // apology is the speaker's.
    let (base, mock) = mock_provider(vec![Reply::json(
        StatusCode::OK,
        json!({ "data": { "translations": [{ "translatedText": "I'm sorry, but I can't help with that." }] } }),
    )])
    .await;
    let keys = MemoryKeys::with(RefineProvider::Google, "g");
    let google = DictationRefineSettings {
        provider: RefineProvider::Google,
        refine: false,
        ..DictationRefineSettings::default()
    };
    let out = refine(&google, &keys, &refiner(&base), &request("מה הסיסמה?"))
        .await
        .unwrap();
    assert_eq!(out.text, "I'm sorry, but I can't help with that.");
    assert!(!out.kept_original);
    assert_eq!(mock.hits().len(), 1);
    // Google gets the text itself, not the framing.
    assert_eq!(mock.hits()[0].body["q"], "מה הסיסמה?");
}

#[test]
fn the_result_is_camel_case() {
    let mut out = RefineResult {
        text: "t".into(),
        provider: "groq".into(),
        model: "m".into(),
        elapsed_ms: 412,
        kept_original: false,
    };
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        json!({ "text": "t", "provider": "groq", "model": "m", "elapsedMs": 412, "keptOriginal": false })
    );
    out.kept_original = true;
    assert_eq!(serde_json::to_value(&out).unwrap()["keptOriginal"], true);
    let req: RefineRequest = serde_json::from_value(json!({
        "text": "x",
        "translate": null,
        "refine": false,
        "targetLanguage": "English",
        "sourceLanguage": null,
    }))
    .unwrap();
    assert_eq!(req.refine, Some(false));
    assert_eq!(req.translate, None);
    assert_eq!(req.target_language.as_deref(), Some("English"));
}

// ── Settings ──

fn update(value: Value) -> DictationRefineSettingsUpdate {
    serde_json::from_value(value).unwrap()
}

#[test]
fn the_defaults_are_groq_cleaning_up_and_translating_to_english() {
    let s = DictationRefineSettings::default();
    assert_eq!(s.provider, RefineProvider::Groq);
    assert!(s.refine && s.translate);
    assert_eq!(s.target_language, "English");
    assert_eq!(s.effective_model(), "openai/gpt-oss-120b");
    // A stored row missing fields reads them as the defaults.
    let partial: DictationRefineSettings =
        serde_json::from_value(json!({ "provider": "cerebras" })).unwrap();
    assert_eq!(partial.provider, RefineProvider::Cerebras);
    assert!(partial.refine && partial.translate);
}

#[test]
fn a_partial_update_changes_only_what_it_names() {
    let mut s = DictationRefineSettings {
        model: "openai/gpt-oss-20b".into(),
        instructions: "Be brief.".into(),
        ..DictationRefineSettings::default()
    };
    s.apply(&update(
        json!({ "refine": false, "targetLanguage": "  French " }),
    ))
    .unwrap();
    assert!(!s.refine && s.translate);
    assert_eq!(s.target_language, "French");
    assert_eq!(s.model, "openai/gpt-oss-20b");
    assert_eq!(s.instructions, "Be brief.");

    // null is "unchanged" too.
    s.apply(&update(json!({ "model": null, "instructions": null })))
        .unwrap();
    assert_eq!(s.model, "openai/gpt-oss-20b");

    // "" clears an override; a blank target is English again.
    s.apply(&update(json!({ "instructions": "", "targetLanguage": "" })))
        .unwrap();
    assert_eq!(s.instructions, "");
    assert_eq!(s.target_language, "English");
}

#[test]
fn switching_provider_drops_the_old_model_unless_a_new_one_is_given() {
    let mut s = DictationRefineSettings {
        model: "openai/gpt-oss-20b".into(),
        ..DictationRefineSettings::default()
    };
    s.apply(&update(json!({ "provider": "anthropic" })))
        .unwrap();
    assert_eq!(s.model, "");
    assert_eq!(s.effective_model(), "claude-haiku-4-5-20251001");

    s.apply(&update(
        json!({ "provider": "openai", "model": "gpt-4.1-mini" }),
    ))
    .unwrap();
    assert_eq!(s.effective_model(), "gpt-4.1-mini");

    // Re-sending the same provider keeps the override.
    s.apply(&update(json!({ "provider": "OpenAI" }))).unwrap();
    assert_eq!(s.model, "gpt-4.1-mini");
}

#[test]
fn bad_updates_are_refused() {
    let mut s = DictationRefineSettings::default();
    let err = s
        .apply(&update(json!({ "provider": "deepl" })))
        .unwrap_err();
    assert!(err.message.contains("Unknown provider \"deepl\""));
    assert!(err
        .message
        .contains("groq, cerebras, openai, anthropic, google, custom"));
    let err = s
        .apply(&update(json!({ "endpoint": "ftp://example.com" })))
        .unwrap_err();
    assert!(err.message.contains("http(s) URL"));
}

#[test]
fn an_update_never_prints_its_key() {
    let u = update(json!({ "apiKey": "gsk_very_secret" }));
    let printed = format!("{u:?}");
    assert!(!printed.contains("gsk_very_secret"));
    assert!(printed.contains("<redacted>"));
}

#[tokio::test]
async fn keys_are_stored_per_provider_and_never_sent_back() {
    let db = test_helpers::fresh_in_memory_db().await;
    let keys = MemoryKeys::default();

    let view = get_settings(&db.conn, &keys).await;
    assert!(!view.configured);
    assert_eq!(view.providers.len(), 6);
    assert!(view.providers.iter().all(|p| !p.has_key));

    // The key goes to the selected provider by default.
    let view = save_settings(
        &db.conn,
        &keys,
        update(json!({ "apiKey": "  gsk_secret_1  ", "instructions": "Formal." })),
    )
    .await
    .unwrap();
    assert!(view.configured);
    assert_eq!(
        keys.get(RefineProvider::Groq).unwrap().as_deref(),
        Some("gsk_secret_1")
    );

    // Or to the one named; this also switches provider.
    let view = save_settings(
        &db.conn,
        &keys,
        update(json!({ "provider": "anthropic", "apiKey": "sk-ant-secret_2" })),
    )
    .await
    .unwrap();
    assert_eq!(view.settings.provider, RefineProvider::Anthropic);
    assert!(view.configured);
    let view = save_settings(
        &db.conn,
        &keys,
        update(json!({ "keyProvider": "cerebras", "apiKey": "csk-secret_3" })),
    )
    .await
    .unwrap();
    let with_key: Vec<&str> = view
        .providers
        .iter()
        .filter(|p| p.has_key)
        .map(|p| p.id)
        .collect();
    assert_eq!(with_key, vec!["groq", "cerebras", "anthropic"]);

    // Nothing that leaves: the view, nor the stored settings row.
    let json = serde_json::to_string(&view).unwrap();
    let stored = app_metadata_service::get_value(&db.conn, SETTINGS_KEY)
        .await
        .unwrap()
        .unwrap();
    for secret in ["gsk_secret_1", "sk-ant-secret_2", "csk-secret_3"] {
        assert!(!json.contains(secret), "view leaks {secret}");
        assert!(!stored.contains(secret), "settings row holds {secret}");
    }
    let value: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["provider"], "anthropic");
    assert_eq!(value["targetLanguage"], "English");
    assert_eq!(value["instructions"], "Formal.");
    assert_eq!(value["configured"], json!(true));
    assert_eq!(
        value["providers"][0],
        json!({ "id": "groq", "label": "Groq", "hasKey": true, "defaultModel": "openai/gpt-oss-120b" })
    );
    assert_eq!(value["providers"][4]["defaultModel"], Value::Null);
    assert!(value.get("apiKey").is_none());

    // "" removes the selected provider's key.
    let view = save_settings(&db.conn, &keys, update(json!({ "apiKey": "" })))
        .await
        .unwrap();
    assert!(!view.configured);
    assert_eq!(keys.get(RefineProvider::Anthropic).unwrap(), None);
    assert_eq!(
        keys.get(RefineProvider::Groq).unwrap().as_deref(),
        Some("gsk_secret_1")
    );

    // A refused update stores nothing.
    let err = save_settings(
        &db.conn,
        &keys,
        update(json!({ "provider": "nope", "apiKey": "x" })),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err.message.split(':').next(),
        Some("Unknown provider \"nope\"")
    );
    assert_eq!(
        load_settings(&db.conn).await.provider,
        RefineProvider::Anthropic
    );
}

#[tokio::test]
async fn custom_is_configured_by_endpoint_and_model_and_a_broken_store_is_reported() {
    let db = test_helpers::fresh_in_memory_db().await;
    let keys = MemoryKeys::default();
    let view = save_settings(
        &db.conn,
        &keys,
        update(json!({ "provider": "custom", "endpoint": "http://localhost:1234/v1" })),
    )
    .await
    .unwrap();
    assert!(!view.configured);
    let view = save_settings(&db.conn, &keys, update(json!({ "model": "qwen" })))
        .await
        .unwrap();
    assert!(view.configured);

    let broken = MemoryKeys {
        broken: true,
        ..MemoryKeys::default()
    };
    let view = get_settings(&db.conn, &broken).await;
    assert_eq!(view.key_error.as_deref(), Some("keychain locked"));
}
