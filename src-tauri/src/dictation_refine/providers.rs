//! The providers: what each request looks like, how its answer is read, and
//! the one-retry HTTP loop. Ported from Speakly's translation stage (10 s
//! timeout, one retry after 300 ms, an empty answer is a failure, HTTP errors
//! turned into something a user can act on), on async reqwest.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{RefineError, SETTINGS_LOCATION};
use crate::dictation_refine::prompt::google_lang_code;

/// Per attempt.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(10);
/// Before the one retry.
pub(crate) const RETRY_DELAY: Duration = Duration::from_millis(300);

/// `model` reported for Google, which has none to pick.
pub const GOOGLE_MODEL: &str = "cloud-translation-v2";

/// A clean-up and translation service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefineProvider {
    #[default]
    Groq,
    Cerebras,
    Openai,
    Anthropic,
    Google,
    Custom,
}

impl RefineProvider {
    pub const ALL: [RefineProvider; 6] = [
        RefineProvider::Groq,
        RefineProvider::Cerebras,
        RefineProvider::Openai,
        RefineProvider::Anthropic,
        RefineProvider::Google,
        RefineProvider::Custom,
    ];

    pub fn id(self) -> &'static str {
        match self {
            RefineProvider::Groq => "groq",
            RefineProvider::Cerebras => "cerebras",
            RefineProvider::Openai => "openai",
            RefineProvider::Anthropic => "anthropic",
            RefineProvider::Google => "google",
            RefineProvider::Custom => "custom",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim().to_ascii_lowercase();
        Self::ALL.into_iter().find(|p| p.id() == raw)
    }

    pub fn label(self) -> &'static str {
        match self {
            RefineProvider::Groq => "Groq",
            RefineProvider::Cerebras => "Cerebras",
            RefineProvider::Openai => "OpenAI",
            RefineProvider::Anthropic => "Anthropic",
            RefineProvider::Google => "Google Cloud Translation",
            RefineProvider::Custom => "Custom (OpenAI-compatible)",
        }
    }

    /// The model used when the settings name none. Google has no model; a
    /// custom endpoint has no default.
    pub fn default_model(self) -> Option<&'static str> {
        match self {
            RefineProvider::Groq => Some("openai/gpt-oss-120b"),
            RefineProvider::Cerebras => Some("gpt-oss-120b"),
            RefineProvider::Openai => Some("gpt-4o-mini"),
            RefineProvider::Anthropic => Some("claude-haiku-4-5-20251001"),
            RefineProvider::Google | RefineProvider::Custom => None,
        }
    }

    /// Only the LLMs can clean up; Google only translates.
    pub fn can_refine(self) -> bool {
        self != RefineProvider::Google
    }

    /// A custom endpoint may be a local server that takes no key.
    pub fn needs_key(self) -> bool {
        self != RefineProvider::Custom
    }

    fn api_url(self) -> Option<&'static str> {
        match self {
            RefineProvider::Groq => Some("https://api.groq.com/openai/v1/chat/completions"),
            RefineProvider::Cerebras => Some("https://api.cerebras.ai/v1/chat/completions"),
            RefineProvider::Openai => Some("https://api.openai.com/v1/chat/completions"),
            RefineProvider::Anthropic => Some("https://api.anthropic.com/v1/messages"),
            RefineProvider::Google => {
                Some("https://translation.googleapis.com/language/translate/v2")
            }
            RefineProvider::Custom => None,
        }
    }
}

/// One provider call, fully resolved.
#[derive(Debug, Clone)]
pub(crate) struct Job<'a> {
    pub provider: RefineProvider,
    /// The model to ask for (ignored by Google).
    pub model: &'a str,
    /// The custom provider's endpoint.
    pub endpoint: &'a str,
    pub system: &'a str,
    pub text: &'a str,
    /// For Google, which takes a code rather than a prompt.
    pub target_language: &'a str,
    pub source_language: Option<&'a str>,
}

/// An HTTP request before it is sent. Holds the key, so it is deliberately
/// not `Debug`.
pub(crate) struct Call {
    pub url: String,
    pub query: Vec<(&'static str, String)>,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

/// `.../chat/completions` for a custom endpoint given as its base URL.
pub(crate) fn custom_url(endpoint: &str) -> String {
    let endpoint = endpoint.trim();
    if endpoint.contains("/chat/completions") {
        endpoint.to_string()
    } else {
        format!("{}/chat/completions", endpoint.trim_end_matches('/'))
    }
}

/// The request a job sends. `base` replaces the scheme and host of the
/// built-in URLs (tests point it at a mock).
pub(crate) fn build_call(job: &Job<'_>, api_key: &str, base: Option<&str>) -> Call {
    let url = match job.provider.api_url() {
        Some(url) => rebase(url, base),
        None => custom_url(job.endpoint),
    };
    match job.provider {
        // Anthropic Messages API. No `temperature` — current Claude models
        // reject sampling params; the minimal request shape is also the most
        // compatible.
        RefineProvider::Anthropic => Call {
            url,
            query: Vec::new(),
            headers: vec![
                ("x-api-key", api_key.to_string()),
                ("anthropic-version", "2023-06-01".to_string()),
            ],
            body: json!({
                "model": job.model,
                "max_tokens": 2048,
                "system": job.system,
                "messages": [{ "role": "user", "content": job.text }],
            }),
        },
        // Google Cloud Translation v2 (API key): translation only, by code.
        RefineProvider::Google => {
            let mut body = json!({
                "q": job.text,
                "target": google_lang_code(job.target_language),
                "format": "text",
            });
            if let Some(source) = job.source_language.filter(|s| !s.trim().is_empty()) {
                body["source"] = Value::String(google_lang_code(source));
            }
            Call {
                url,
                query: vec![("key", api_key.to_string())],
                headers: Vec::new(),
                body,
            }
        }
        RefineProvider::Groq
        | RefineProvider::Cerebras
        | RefineProvider::Openai
        | RefineProvider::Custom => Call {
            url,
            query: Vec::new(),
            headers: if api_key.is_empty() {
                Vec::new()
            } else {
                vec![("authorization", format!("Bearer {api_key}"))]
            },
            body: json!({
                "model": job.model,
                "temperature": 0.1,
                "messages": [
                    { "role": "system", "content": job.system },
                    { "role": "user", "content": job.text },
                ],
            }),
        },
    }
}

fn rebase(url: &str, base: Option<&str>) -> String {
    let Some(base) = base else {
        return url.to_string();
    };
    let path = url::Url::parse(url)
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    format!("{}{path}", base.trim_end_matches('/'))
}

/// The text out of a successful answer.
pub(crate) fn parse_answer(provider: RefineProvider, body: &Value) -> Result<String, RefineError> {
    let label = provider.label();
    let text = match provider {
        RefineProvider::Anthropic => {
            if body["stop_reason"].as_str() == Some("refusal") {
                return Err(RefineError::BadResponse(format!(
                    "{label}: the request was refused"
                )));
            }
            body["content"].as_array().and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b["type"].as_str() == Some("text"))
                    .and_then(|b| b["text"].as_str())
            })
        }
        RefineProvider::Google => body["data"]["translations"][0]["translatedText"].as_str(),
        _ => body["choices"][0]["message"]["content"].as_str(),
    };
    text.map(str::to_string)
        .ok_or_else(|| RefineError::BadResponse(format!("{label}: no text in the answer")))
}

/// Turn provider HTTP failures into messages a user can act on. The raw
/// detail goes to the log; only actionable text reaches the client.
pub(crate) fn humanize_http(provider: RefineProvider, status: u16, detail: &str) -> RefineError {
    let label = provider.label();
    let message = match status {
        401 | 403 => {
            if provider == RefineProvider::Google
                && (detail.contains("blocked") || detail.contains("has not been used"))
            {
                format!(
                    "{label}: the Cloud Translation API isn't enabled for this key's project — \
                     enable it at console.cloud.google.com (APIs & Services), and check the \
                     key's API restrictions"
                )
            } else {
                format!("{label}: the API key was rejected — check it in {SETTINGS_LOCATION}")
            }
        }
        404 => format!(
            "{label}: that model isn't available — pick a different model in {SETTINGS_LOCATION} \
             ({})",
            truncate(detail, 120)
        ),
        429 => format!("{label}: rate limited — try again in a moment"),
        500..=599 => format!("{label} is having trouble right now — try again shortly"),
        _ => format!(
            "{label}: request failed ({status}): {}",
            truncate(detail, 120)
        ),
    };
    RefineError::Http { status, message }
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// Sends jobs: a pooled client, and (tests) a mock base URL.
pub struct Refiner {
    client: reqwest::Client,
    base: Option<String>,
}

impl Refiner {
    /// The process-wide refiner, its connections kept warm between
    /// dictations.
    pub fn shared() -> &'static Refiner {
        static SHARED: OnceLock<Refiner> = OnceLock::new();
        SHARED.get_or_init(|| Refiner::new(TIMEOUT, None))
    }

    pub(crate) fn new(timeout: Duration, base: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(5 * 60))
            .build()
            .unwrap_or_else(|e| {
                tracing::warn!("[dictation] building the HTTP client failed ({e}); using defaults");
                reqwest::Client::new()
            });
        Self { client, base }
    }

    /// One attempt, then one more after [`RETRY_DELAY`]. Returns the answer,
    /// trimmed; an empty one counts as a failure.
    pub(crate) async fn run(&self, job: &Job<'_>, api_key: &str) -> Result<String, RefineError> {
        let mut last = RefineError::Empty(job.provider.label().to_string());
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            match self.once(job, api_key).await {
                Ok(text) if !text.trim().is_empty() => return Ok(text.trim().to_string()),
                Ok(_) => last = RefineError::Empty(job.provider.label().to_string()),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    async fn once(&self, job: &Job<'_>, api_key: &str) -> Result<String, RefineError> {
        let call = build_call(job, api_key, self.base.as_deref());
        let label = job.provider.label();
        let mut request = self.client.post(&call.url).json(&call.body);
        if !call.query.is_empty() {
            request = request.query(&call.query);
        }
        for (name, value) in &call.headers {
            request = request.header(*name, value);
        }
        // `without_url`: Google's key travels in the query string, and a
        // reqwest error prints its URL.
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                RefineError::Unreachable(format!(
                    "{label} didn't respond — check the internet connection"
                ))
            } else {
                RefineError::Unreachable(format!("{label}: {}", e.without_url()))
            }
        })?;
        let status = response.status();
        let raw = response.text().await.map_err(|e| {
            RefineError::Unreachable(format!(
                "{label}: the answer was cut off ({})",
                e.without_url()
            ))
        })?;
        let body: Option<Value> = serde_json::from_str(&raw).ok();
        if !status.is_success() {
            let detail = body
                .as_ref()
                .and_then(|b| b["error"]["message"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| truncate(raw.trim(), 200));
            tracing::warn!("[dictation] {label} HTTP {status}: {detail}");
            return Err(humanize_http(job.provider, status.as_u16(), &detail));
        }
        let body = body
            .ok_or_else(|| RefineError::BadResponse(format!("{label}: the answer is not JSON")))?;
        parse_answer(job.provider, &body)
    }
}
