//! Dictation clean-up and translation.
//!
//! A client that transcribes speech itself (the iOS app dictates in Hebrew
//! with an on-device Whisper) sends the transcript here; codeg cleans it up
//! and/or translates it with a fast cloud model and returns the text. The
//! provider keys stay in codeg and never reach a client.
//!
//! * [`prompt`] — the system prompt (refine, translate, or both).
//! * [`providers`] — the request each provider takes, the retry loop and the
//!   error wording.
//!
//! Settings are an `app_metadata` row (`dictation_refine_settings`). Each
//! provider's key is a named secret (`secret:dictation-refine-<provider>`):
//! the OS keyring on desktop, the 0600 `tokens.json` on a server. The
//! settings API reports only whether a key is stored. `docs/dictation-refine.md`
//! is the client contract.

pub mod prompt;
pub mod providers;
#[cfg(test)]
mod tests;

use std::time::Instant;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::service::app_metadata_service;
use crate::keyring_store;

use prompt::{language_name, stage_prompt, Stage};
use providers::Job;
pub use providers::{RefineProvider, Refiner, GOOGLE_MODEL};

/// `app_metadata` key of [`DictationRefineSettings`].
pub const SETTINGS_KEY: &str = "dictation_refine_settings";
/// Where the user fixes what an error is about.
pub const SETTINGS_LOCATION: &str = "Settings › General › Dictation clean-up and translation";
/// `provider` in a result when there was nothing to do.
pub const NO_PROVIDER: &str = "none";
const DEFAULT_TARGET_LANGUAGE: &str = "English";

/// The secret a provider's key is stored under (`secret:` is added by the
/// store).
pub fn key_secret_name(provider: RefineProvider) -> String {
    format!("dictation-refine-{}", provider.id())
}

/// Why a refine call failed. Every message is meant for the user.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RefineError {
    #[error("{0}")]
    InvalidInput(String),
    /// A key, an endpoint or a model is missing.
    #[error("{0}")]
    NotConfigured(String),
    /// The settings ask for something the provider cannot do.
    #[error("{0}")]
    Unsupported(String),
    /// The key store would not open.
    #[error("{0}")]
    KeyStore(String),
    /// No answer: offline, DNS, timeout.
    #[error("{0}")]
    Unreachable(String),
    /// The provider answered with an error status.
    #[error("{message}")]
    Http { status: u16, message: String },
    #[error("{0}")]
    BadResponse(String),
    #[error("{0} returned an empty result")]
    Empty(String),
    /// Clean-up dropped most of a long dictation.
    #[error("{0}")]
    Gutted(String),
}

impl From<RefineError> for AppCommandError {
    fn from(err: RefineError) -> Self {
        let code = match &err {
            RefineError::InvalidInput(_) => AppErrorCode::InvalidInput,
            RefineError::NotConfigured(_) => AppErrorCode::ConfigurationMissing,
            RefineError::Unsupported(_) => AppErrorCode::ConfigurationInvalid,
            RefineError::KeyStore(_) => AppErrorCode::IoError,
            RefineError::Http {
                status: 401 | 403, ..
            } => AppErrorCode::AuthenticationFailed,
            RefineError::Http { status: 404, .. } => AppErrorCode::ConfigurationInvalid,
            RefineError::Unreachable(_) | RefineError::Http { .. } => AppErrorCode::NetworkError,
            RefineError::BadResponse(_) | RefineError::Empty(_) | RefineError::Gutted(_) => {
                AppErrorCode::TaskExecutionFailed
            }
        };
        AppCommandError::new(code, err.to_string())
    }
}

// ── Settings ──

/// "Dictation clean-up and translation" (Settings › General), minus the keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationRefineSettings {
    pub provider: RefineProvider,
    /// Model override; empty uses the provider's default.
    pub model: String,
    /// The custom provider's base URL or full `/chat/completions` URL.
    pub endpoint: String,
    /// A language name ("English") or code ("en").
    pub target_language: String,
    /// Clean up the dictation (filler, false starts, punctuation).
    pub refine: bool,
    /// Translate it to `target_language`.
    pub translate: bool,
    /// The user's own instructions, added to the built-in ones.
    pub instructions: String,
}

impl Default for DictationRefineSettings {
    fn default() -> Self {
        Self {
            provider: RefineProvider::Groq,
            model: String::new(),
            endpoint: String::new(),
            target_language: DEFAULT_TARGET_LANGUAGE.to_string(),
            refine: true,
            translate: true,
            instructions: String::new(),
        }
    }
}

impl DictationRefineSettings {
    pub fn sanitized(self) -> Self {
        let target = self.target_language.trim();
        Self {
            model: self.model.trim().to_string(),
            endpoint: self.endpoint.trim().to_string(),
            target_language: if target.is_empty() {
                DEFAULT_TARGET_LANGUAGE.to_string()
            } else {
                target.to_string()
            },
            instructions: self.instructions.trim().to_string(),
            ..self
        }
    }

    /// The model a call uses: the override, else the provider's default.
    pub fn effective_model(&self) -> &str {
        if self.provider == RefineProvider::Google {
            return GOOGLE_MODEL;
        }
        if !self.model.is_empty() {
            return &self.model;
        }
        self.provider.default_model().unwrap_or("")
    }

    /// Apply a partial update. Switching provider without naming a model
    /// drops the old override: model ids rarely carry across providers.
    pub fn apply(&mut self, update: &DictationRefineSettingsUpdate) -> Result<(), AppCommandError> {
        if let Some(raw) = &update.provider {
            let provider = parse_provider(raw)?;
            if provider != self.provider && update.model.is_none() {
                self.model.clear();
            }
            self.provider = provider;
        }
        if let Some(model) = &update.model {
            self.model = model.clone();
        }
        if let Some(endpoint) = &update.endpoint {
            self.endpoint = endpoint.clone();
        }
        if let Some(target) = &update.target_language {
            self.target_language = target.clone();
        }
        if let Some(refine) = update.refine {
            self.refine = refine;
        }
        if let Some(translate) = update.translate {
            self.translate = translate;
        }
        if let Some(instructions) = &update.instructions {
            self.instructions = instructions.clone();
        }
        *self = std::mem::take(self).sanitized();
        if !self.endpoint.is_empty() {
            let ok = url::Url::parse(&self.endpoint)
                .map(|u| matches!(u.scheme(), "http" | "https"))
                .unwrap_or(false);
            if !ok {
                return Err(AppCommandError::invalid_input(
                    "The endpoint must be an http(s) URL, like https://example.com/v1.",
                ));
            }
        }
        Ok(())
    }
}

fn parse_provider(raw: &str) -> Result<RefineProvider, AppCommandError> {
    RefineProvider::parse(raw).ok_or_else(|| {
        let ids: Vec<&str> = RefineProvider::ALL.iter().map(|p| p.id()).collect();
        AppCommandError::invalid_input(format!(
            "Unknown provider \"{}\": use one of {}.",
            raw.trim(),
            ids.join(", ")
        ))
    })
}

/// A partial update: absent (or `null`) fields keep their value. `apiKey`
/// replaces the key of `keyProvider` (default: the provider after this
/// update); `""` removes it. Deliberately neither `Serialize` nor a derived
/// `Debug`, so the key cannot be written back out or logged by accident.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationRefineSettingsUpdate {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    pub target_language: Option<String>,
    pub refine: Option<bool>,
    pub translate: Option<bool>,
    pub instructions: Option<String>,
    pub api_key: Option<String>,
    pub key_provider: Option<String>,
}

impl std::fmt::Debug for DictationRefineSettingsUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DictationRefineSettingsUpdate")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("endpoint", &self.endpoint)
            .field("target_language", &self.target_language)
            .field("refine", &self.refine)
            .field("translate", &self.translate)
            .field("instructions", &self.instructions)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("key_provider", &self.key_provider)
            .finish()
    }
}

/// One provider as the settings UI lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: &'static str,
    pub label: &'static str,
    pub has_key: bool,
    pub default_model: Option<&'static str>,
}

/// What `get_dictation_refine_settings` returns: the settings, each
/// provider's key state, never a key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationRefineSettingsView {
    #[serde(flatten)]
    pub settings: DictationRefineSettings,
    /// The selected provider can be called: it has a key (a custom one needs
    /// its endpoint and model instead).
    pub configured: bool,
    pub providers: Vec<ProviderView>,
    /// The key store would not open (keys may still be there).
    pub key_error: Option<String>,
}

// ── Keys ──

/// Where provider keys live. The keyring in the app; a map in tests.
pub trait KeyStore: Send + Sync {
    fn get(&self, provider: RefineProvider) -> Result<Option<String>, String>;
    fn set(&self, provider: RefineProvider, key: &str) -> Result<(), String>;
    fn delete(&self, provider: RefineProvider) -> Result<(), String>;
}

/// The app's secret store (`keyring_store`'s named secrets).
pub struct KeyringKeys;

impl KeyStore for KeyringKeys {
    fn get(&self, provider: RefineProvider) -> Result<Option<String>, String> {
        keyring_store::get_secret(&key_secret_name(provider))
            .map(|key| key.filter(|k| !k.trim().is_empty()))
    }

    fn set(&self, provider: RefineProvider, key: &str) -> Result<(), String> {
        keyring_store::set_secret(&key_secret_name(provider), key)
    }

    fn delete(&self, provider: RefineProvider) -> Result<(), String> {
        keyring_store::delete_secret(&key_secret_name(provider))
    }
}

pub async fn load_settings(conn: &DatabaseConnection) -> DictationRefineSettings {
    match app_metadata_service::get_value(conn, SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<DictationRefineSettings>(&raw)
            .map(DictationRefineSettings::sanitized)
            .unwrap_or_else(|e| {
                tracing::warn!("[dictation] unreadable settings ({e}); using the defaults");
                DictationRefineSettings::default()
            }),
        Ok(None) => DictationRefineSettings::default(),
        Err(e) => {
            tracing::warn!("[dictation] failed to load settings: {e}");
            DictationRefineSettings::default()
        }
    }
}

pub fn settings_view(
    settings: DictationRefineSettings,
    keys: &dyn KeyStore,
) -> DictationRefineSettingsView {
    let mut key_error = None;
    let providers: Vec<ProviderView> = RefineProvider::ALL
        .into_iter()
        .map(|provider| {
            let has_key = match keys.get(provider) {
                Ok(key) => key.is_some(),
                Err(e) => {
                    if key_error.is_none() {
                        key_error = Some(e);
                    }
                    false
                }
            };
            ProviderView {
                id: provider.id(),
                label: provider.label(),
                has_key,
                default_model: provider.default_model(),
            }
        })
        .collect();
    let has_key = providers
        .iter()
        .any(|p| p.id == settings.provider.id() && p.has_key);
    let configured = if settings.provider.needs_key() {
        has_key
    } else {
        !settings.endpoint.is_empty() && !settings.model.is_empty()
    };
    DictationRefineSettingsView {
        settings,
        configured,
        providers,
        key_error,
    }
}

pub async fn get_settings(
    conn: &DatabaseConnection,
    keys: &dyn KeyStore,
) -> DictationRefineSettingsView {
    settings_view(load_settings(conn).await, keys)
}

pub async fn save_settings(
    conn: &DatabaseConnection,
    keys: &dyn KeyStore,
    update: DictationRefineSettingsUpdate,
) -> Result<DictationRefineSettingsView, AppCommandError> {
    let mut settings = load_settings(conn).await;
    settings.apply(&update)?;
    if let Some(key) = &update.api_key {
        let provider = match &update.key_provider {
            Some(raw) => parse_provider(raw)?,
            None => settings.provider,
        };
        let key = key.trim();
        if key.is_empty() {
            keys.delete(provider).map_err(|e| {
                AppCommandError::io_error(format!("Could not remove the {} key", provider.label()))
                    .with_detail(e)
            })?;
        } else {
            keys.set(provider, key).map_err(|e| {
                AppCommandError::io_error(format!("Could not store the {} key", provider.label()))
                    .with_detail(e)
            })?;
        }
    }
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize the dictation settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    tracing::info!(
        "[dictation] settings saved ({}, model {}, refine {}, translate {} → {})",
        settings.provider.id(),
        settings.effective_model(),
        settings.refine,
        settings.translate,
        settings.target_language,
    );
    Ok(settings_view(settings, keys))
}

// ── Refine ──

/// `refine_dictation`'s arguments. `null` falls back to the settings.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RefineRequest {
    pub text: String,
    pub translate: Option<bool>,
    pub refine: Option<bool>,
    pub target_language: Option<String>,
    pub source_language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineResult {
    pub text: String,
    /// The provider id, or `"none"` when neither step was asked for.
    pub provider: String,
    pub model: String,
    pub elapsed_ms: u64,
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Clean up and/or translate one dictation.
pub async fn refine(
    settings: &DictationRefineSettings,
    keys: &dyn KeyStore,
    refiner: &Refiner,
    request: &RefineRequest,
) -> Result<RefineResult, RefineError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err(RefineError::InvalidInput(
            "There is no text to clean up.".into(),
        ));
    }
    let do_refine = request.refine.unwrap_or(settings.refine);
    let do_translate = request.translate.unwrap_or(settings.translate);
    if !do_refine && !do_translate {
        return Ok(RefineResult {
            text: text.to_string(),
            provider: NO_PROVIDER.to_string(),
            model: String::new(),
            elapsed_ms: 0,
        });
    }
    let provider = settings.provider;
    let label = provider.label();
    if do_refine && !provider.can_refine() {
        return Err(RefineError::Unsupported(format!(
            "Clean-up needs an LLM provider — {label} can only translate. Pick Groq, Cerebras, \
             OpenAI, Anthropic or a custom provider, or turn clean-up off."
        )));
    }
    let key = keys
        .get(provider)
        .map_err(|e| RefineError::KeyStore(format!("Could not read the {label} key: {e}")))?
        .unwrap_or_default();
    if key.is_empty() && provider.needs_key() {
        return Err(RefineError::NotConfigured(format!(
            "No {label} API key is saved. Add it in {SETTINGS_LOCATION}."
        )));
    }
    if provider == RefineProvider::Custom {
        if settings.endpoint.is_empty() {
            return Err(RefineError::NotConfigured(format!(
                "The custom provider has no endpoint. Set it in {SETTINGS_LOCATION}."
            )));
        }
        if settings.model.is_empty() {
            return Err(RefineError::NotConfigured(format!(
                "The custom provider has no model. Set it in {SETTINGS_LOCATION}."
            )));
        }
    }

    let target = non_blank(request.target_language.as_deref())
        .unwrap_or(&settings.target_language)
        .to_string();
    let source = non_blank(request.source_language.as_deref()).map(language_name);
    let target_name = language_name(&target);
    let system = stage_prompt(&Stage {
        refine: do_refine,
        translate: do_translate,
        target_language: &target_name,
        source_language: source.as_deref(),
        instructions: &settings.instructions,
    });
    let model = settings.effective_model().to_string();
    let job = Job {
        provider,
        model: &model,
        endpoint: &settings.endpoint,
        system: &system,
        text,
        target_language: &target,
        source_language: source.as_deref(),
    };

    let started = Instant::now();
    let out = refiner.run(&job, &key).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let out = match out {
        Ok(out) => out,
        Err(e) => {
            tracing::warn!(
                "[dictation] {} failed after {elapsed_ms} ms: {e}",
                provider.id()
            );
            return Err(e);
        }
    };

    // Clean-up must never swallow the message: losing half of a long
    // dictation is a provider failure, not an edit. (A translation can
    // legitimately be shorter, so that only logs.)
    let before = text.chars().count();
    let after = out.chars().count();
    let gutted = before > 200 && after * 2 < before;
    if gutted && !do_translate {
        tracing::warn!("[dictation] clean-up returned {after} chars for {before}; refusing it");
        return Err(RefineError::Gutted(
            "Clean-up returned far less text than was dictated — keep the original.".into(),
        ));
    }
    if gutted {
        tracing::warn!("[dictation] translation returned {after} chars for {before}");
    }
    tracing::info!(
        "[dictation] {}{} via {} ({model}): {before} → {after} chars in {elapsed_ms} ms",
        if do_refine { "refine" } else { "" },
        if do_translate { "+translate" } else { "" },
        provider.id(),
    );
    Ok(RefineResult {
        text: out,
        provider: provider.id().to_string(),
        model,
        elapsed_ms,
    })
}
