//! iPhone push notifications.
//!
//! codeg's own backend sends the alerts to Apple Push Notification service
//! (APNs) with the team's `.p8` auth key — one user, no relay. Both the
//! desktop app and `codeg-server` run it, for the sessions they own.
//!
//! * [`apns`] — the HTTP/2 client: token auth, retries, dead tokens.
//! * [`jwt`] — the ES256 provider token, cached ~50 min.
//! * [`payload`] — the notification body and headers: the iOS contract.
//! * [`prefs`] — per-device preferences and the "away" rule.
//! * [`fanout`] — the triggers: the desktop notification's own (turn
//!   finished, needs you, errors) from the event bus, plus every critical
//!   session alert.
//! * [`wording`] — what the notifications say.
//!
//! Settings (team id, key id, bundle id, environment) are an `app_metadata`
//! row; the `.p8` key itself lives in the keyring (`secret:apns-auth-key`) and
//! is never logged or sent back to a client. Devices are `push_device` rows.
//! `docs/ios-push.md` is the user and client documentation.

pub mod apns;
pub mod fanout;
pub mod jwt;
pub mod payload;
pub mod prefs;
pub mod wording;

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::chat_channel::i18n::Lang;
use crate::db::entities::push_device;
use crate::db::service::{app_metadata_service, push_device_service};
use crate::keyring_store;
use crate::presence::Looking;

use apns::{ApnsSender, Credentials, SendOutcome, Target};
use payload::{PushKind, PushMessage};
use prefs::DevicePrefs;

/// `app_metadata` key of [`PushSettings`].
pub const PUSH_SETTINGS_KEY: &str = "push_settings";
/// `app_metadata` key of this server's push identity (see [`server_id`]).
pub const SERVER_ID_KEY: &str = "push_server_id";
/// Keyring name of the `.p8` key (stored as `secret:apns-auth-key`).
pub const AUTH_KEY_SECRET: &str = "apns-auth-key";
/// Chat-channel message language, the fallback for the push language.
const CHANNEL_LANGUAGE_KEY: &str = "chat_message_language";

/// Which APNs host serves a device token.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApnsEnvironment {
    /// TestFlight and App Store builds.
    #[default]
    Production,
    /// Builds run from Xcode.
    Sandbox,
}

impl ApnsEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            ApnsEnvironment::Production => "production",
            ApnsEnvironment::Sandbox => "sandbox",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "production" | "prod" => Some(ApnsEnvironment::Production),
            "sandbox" | "development" | "dev" => Some(ApnsEnvironment::Sandbox),
            _ => None,
        }
    }
}

/// "iPhone push" (Settings › General, with the other notification settings),
/// minus the key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PushSettings {
    /// The Apple Developer team id (10 characters).
    pub team_id: String,
    /// The APNs key's id (10 characters, also in its file name).
    pub key_id: String,
    /// The iOS app's bundle id: the default `apns-topic`.
    pub bundle_id: String,
    /// The environment of a device that registers without saying.
    pub environment: ApnsEnvironment,
    /// The app language the notifications are worded in (`en`, `zh-CN`, …);
    /// empty falls back to the chat-channel message language.
    pub language: String,
}

fn is_apple_id(value: &str) -> bool {
    value.len() == 10 && value.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_bundle_id(value: &str) -> bool {
    !value.is_empty()
        && value.contains('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

impl PushSettings {
    pub fn sanitized(self) -> Self {
        Self {
            team_id: self.team_id.trim().to_ascii_uppercase(),
            key_id: self.key_id.trim().to_ascii_uppercase(),
            bundle_id: self.bundle_id.trim().to_string(),
            language: self.language.trim().to_string(),
            ..self
        }
    }

    /// Empty fields are allowed (not set up yet); set ones must look right.
    pub fn validate(&self) -> Result<(), AppCommandError> {
        if !self.team_id.is_empty() && !is_apple_id(&self.team_id) {
            return Err(AppCommandError::invalid_input(
                "The Team ID is 10 letters and digits (Apple Developer › Membership).",
            ));
        }
        if !self.key_id.is_empty() && !is_apple_id(&self.key_id) {
            return Err(AppCommandError::invalid_input(
                "The Key ID is 10 letters and digits (shown with the key, and in its AuthKey_<KEYID>.p8 file name).",
            ));
        }
        if !self.bundle_id.is_empty() && !is_bundle_id(&self.bundle_id) {
            return Err(AppCommandError::invalid_input(
                "The bundle ID looks like com.example.app.",
            ));
        }
        Ok(())
    }

    fn lang(&self) -> Option<Lang> {
        (!self.language.is_empty()).then(|| Lang::from_str_lossy(&self.language))
    }
}

/// What the settings UI reads: the settings, whether a key is stored, and
/// this server's push identity. Never the key itself.
#[derive(Debug, Clone, Serialize)]
pub struct PushSettingsView {
    #[serde(flatten)]
    pub settings: PushSettings,
    pub has_key: bool,
    /// The keyring would not open (the key may still be there).
    pub key_error: Option<String>,
    pub server_id: String,
    /// Everything needed to send is there.
    pub configured: bool,
}

pub async fn load_push_settings(conn: &DatabaseConnection) -> PushSettings {
    match app_metadata_service::get_value(conn, PUSH_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<PushSettings>(&raw)
            .map(PushSettings::sanitized)
            .unwrap_or_else(|e| {
                tracing::warn!("[push] unreadable settings ({e}); using none");
                PushSettings::default()
            }),
        Ok(None) => PushSettings::default(),
        Err(e) => {
            tracing::warn!("[push] failed to load settings: {e}");
            PushSettings::default()
        }
    }
}

/// This server's push identity: a random id minted once per data directory.
/// Sent in every payload, so an app talking to several codeg servers knows
/// which one a notification is from.
pub async fn server_id(conn: &DatabaseConnection) -> String {
    if let Ok(Some(id)) = app_metadata_service::get_value(conn, SERVER_ID_KEY).await {
        if !id.trim().is_empty() {
            return id;
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    if let Err(e) = app_metadata_service::upsert_value(conn, SERVER_ID_KEY, &id).await {
        tracing::warn!("[push] failed to store the server id: {e}");
    }
    id
}

fn stored_key() -> Result<Option<String>, String> {
    keyring_store::get_secret(AUTH_KEY_SECRET).map(|key| key.filter(|k| !k.trim().is_empty()))
}

pub async fn push_settings_view(conn: &DatabaseConnection) -> PushSettingsView {
    let settings = load_push_settings(conn).await;
    let (has_key, key_error) = match stored_key() {
        Ok(key) => (key.is_some(), None),
        Err(e) => (false, Some(e)),
    };
    let configured = has_key
        && !settings.team_id.is_empty()
        && !settings.key_id.is_empty()
        && !settings.bundle_id.is_empty();
    PushSettingsView {
        settings,
        has_key,
        key_error,
        server_id: server_id(conn).await,
        configured,
    }
}

/// Store the settings. `auth_key`: `None` keeps the stored key, an empty
/// string removes it, anything else must be a `.p8` key and replaces it.
pub async fn save_push_settings(
    conn: &DatabaseConnection,
    settings: PushSettings,
    auth_key: Option<String>,
) -> Result<PushSettingsView, AppCommandError> {
    let settings = settings.sanitized();
    settings.validate()?;
    if let Some(key) = auth_key {
        let key = key.trim();
        if key.is_empty() {
            keyring_store::delete_secret(AUTH_KEY_SECRET).map_err(|e| {
                AppCommandError::io_error("Could not remove the APNs key").with_detail(e)
            })?;
        } else {
            jwt::SigningKey::from_p8(key).map_err(|e| {
                AppCommandError::invalid_input(format!("This is not a usable .p8 key: {e}."))
            })?;
            keyring_store::set_secret(AUTH_KEY_SECRET, key).map_err(|e| {
                AppCommandError::io_error("Could not store the APNs key").with_detail(e)
            })?;
        }
    }
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize the push settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, PUSH_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    apns::sender().invalidate_token();
    tracing::info!(
        "[push] settings saved (team {}, key {}, topic {}, {})",
        settings.team_id,
        settings.key_id,
        settings.bundle_id,
        settings.environment.as_str()
    );
    Ok(push_settings_view(conn).await)
}

/// Everything a send needs, or why it cannot happen.
pub struct SendSetup {
    pub settings: PushSettings,
    pub credentials: Credentials,
}

pub async fn load_send_setup(conn: &DatabaseConnection) -> Result<SendSetup, AppCommandError> {
    let settings = load_push_settings(conn).await;
    let mut missing = Vec::new();
    if settings.team_id.is_empty() {
        missing.push("Team ID");
    }
    if settings.key_id.is_empty() {
        missing.push("Key ID");
    }
    if settings.bundle_id.is_empty() {
        missing.push("bundle ID");
    }
    let key = stored_key().map_err(|e| {
        AppCommandError::configuration_missing("Could not read the APNs key from the keyring")
            .with_detail(e)
    })?;
    if key.is_none() {
        missing.push(".p8 key");
    }
    if !missing.is_empty() {
        return Err(AppCommandError::configuration_missing(format!(
            "iPhone push is not set up: add the {} in Settings › General › iPhone push.",
            missing.join(", ")
        )));
    }
    let credentials = Credentials {
        team_id: settings.team_id.clone(),
        key_id: settings.key_id.clone(),
        key_pem: key.unwrap_or_default(),
    };
    Ok(SendSetup {
        settings,
        credentials,
    })
}

/// The language notifications are worded in.
pub async fn push_lang(conn: &DatabaseConnection, settings: &PushSettings) -> Lang {
    if let Some(lang) = settings.lang() {
        return lang;
    }
    app_metadata_service::get_value(conn, CHANNEL_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

// ── Devices ──

/// A registered device, as clients see it. The token shows only its tail.
#[derive(Debug, Clone, Serialize)]
pub struct PushDeviceView {
    pub id: i32,
    pub name: String,
    pub platform: String,
    pub environment: String,
    pub bundle_id: String,
    pub token_hint: String,
    pub prefs: DevicePrefs,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

impl From<&push_device::Model> for PushDeviceView {
    fn from(row: &push_device::Model) -> Self {
        Self {
            id: row.id,
            name: row.name.clone(),
            platform: row.platform.clone(),
            environment: row.environment.clone(),
            bundle_id: row.bundle_id.clone(),
            token_hint: apns::token_hint(&row.token),
            prefs: DevicePrefs::from_json(&row.prefs),
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
        }
    }
}

/// What the iOS app registers with.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RegisterDevice {
    /// The APNs device token, hex.
    pub token: String,
    /// `sandbox` or `production`; default: the settings' environment.
    pub environment: Option<String>,
    /// default: the settings' bundle id.
    pub bundle_id: Option<String>,
    pub name: Option<String>,
    pub platform: Option<String>,
}

/// The answer to a registration.
#[derive(Debug, Clone, Serialize)]
pub struct RegisteredDevice {
    pub device: PushDeviceView,
    pub server_id: String,
}

fn normalize_token(raw: &str) -> Result<String, AppCommandError> {
    let token: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '<' && *c != '>')
        .collect::<String>()
        .to_ascii_lowercase();
    if token.len() < 32 || token.len() > 400 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input(
            "The device token must be the APNs token in hex.",
        ));
    }
    Ok(token)
}

pub async fn register_device(
    conn: &DatabaseConnection,
    input: RegisterDevice,
) -> Result<RegisteredDevice, AppCommandError> {
    let token = normalize_token(&input.token)?;
    let settings = load_push_settings(conn).await;
    let environment = match input.environment.as_deref().map(str::trim) {
        None | Some("") => settings.environment,
        Some(raw) => ApnsEnvironment::parse(raw).ok_or_else(|| {
            AppCommandError::invalid_input("environment is \"sandbox\" or \"production\".")
        })?,
    };
    let bundle_id = input
        .bundle_id
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| settings.bundle_id.clone());
    if !bundle_id.is_empty() && !is_bundle_id(&bundle_id) {
        return Err(AppCommandError::invalid_input(
            "The bundle ID looks like com.example.app.",
        ));
    }
    let name = input
        .name
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "iPhone".to_string());
    let platform = input
        .platform
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "ios".to_string());
    let row = push_device_service::upsert(
        conn,
        push_device_service::NewDevice {
            token,
            environment: environment.as_str().to_string(),
            bundle_id,
            name,
            platform,
        },
        &DevicePrefs::default().to_json(),
    )
    .await
    .map_err(AppCommandError::from)?;
    tracing::info!(
        "[push] device {} registered ({}, {}, {})",
        row.id,
        row.name,
        row.environment,
        apns::token_hint(&row.token)
    );
    Ok(RegisteredDevice {
        device: PushDeviceView::from(&row),
        server_id: server_id(conn).await,
    })
}

/// Remove a device by id (Settings) or by token (the app signing out).
pub async fn unregister_device(
    conn: &DatabaseConnection,
    id: Option<i32>,
    token: Option<String>,
) -> Result<bool, AppCommandError> {
    let removed = match (id, token) {
        (Some(id), _) => push_device_service::delete(conn, id).await,
        (None, Some(token)) => {
            push_device_service::delete_by_token(conn, &normalize_token(&token)?).await
        }
        (None, None) => {
            return Err(AppCommandError::invalid_input(
                "Name the device: its id or its token.",
            ))
        }
    }
    .map_err(AppCommandError::from)?;
    tracing::info!("[push] device unregistered (removed: {removed})");
    Ok(removed)
}

pub async fn list_devices(
    conn: &DatabaseConnection,
) -> Result<Vec<PushDeviceView>, AppCommandError> {
    Ok(push_device_service::list(conn)
        .await
        .map_err(AppCommandError::from)?
        .iter()
        .map(PushDeviceView::from)
        .collect())
}

pub async fn update_device_prefs(
    conn: &DatabaseConnection,
    id: i32,
    prefs: DevicePrefs,
) -> Result<PushDeviceView, AppCommandError> {
    let row = push_device_service::update_prefs(conn, id, &prefs.to_json())
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("No push device {id}")))?;
    Ok(PushDeviceView::from(&row))
}

// ── Delivery ──

/// What one fan-out did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeliveryReport {
    /// Devices Apple accepted the notification for.
    pub delivered: usize,
    /// Devices dropped because Apple said their token is dead.
    pub removed: usize,
    /// `(device id, why)` for the rest.
    pub failed: Vec<(i32, String)>,
}

/// The outcome for one device, after acting on it (a dead token's row is
/// deleted).
async fn send_to_device(
    sender: &ApnsSender,
    conn: &DatabaseConnection,
    setup: &SendSetup,
    device: &push_device::Model,
    message: &PushMessage,
    server_id: &str,
) -> SendOutcome {
    let topic = if device.bundle_id.is_empty() {
        setup.settings.bundle_id.as_str()
    } else {
        device.bundle_id.as_str()
    };
    let target = Target {
        device_id: device.id,
        token: &device.token,
        topic,
        environment: ApnsEnvironment::parse(&device.environment)
            .unwrap_or(setup.settings.environment),
    };
    let outcome = sender
        .send(&setup.credentials, &target, message, server_id)
        .await;
    if let SendOutcome::DeviceGone { reason } = &outcome {
        tracing::info!(
            "[push] device {} ({}) is gone ({reason}); removing it",
            device.id,
            apns::token_hint(&device.token)
        );
        if let Err(e) = push_device_service::delete(conn, device.id).await {
            tracing::warn!("[push] failed to remove device {}: {e}", device.id);
        }
    }
    outcome
}

/// Send `message` to the devices that want it, given who is looking.
pub async fn deliver_with(
    sender: &ApnsSender,
    conn: &DatabaseConnection,
    setup: &SendSetup,
    message: &PushMessage,
    looking: &Looking,
) -> DeliveryReport {
    let devices = match push_device_service::list(conn).await {
        Ok(devices) => devices,
        Err(e) => {
            tracing::warn!("[push] failed to list devices: {e}");
            return DeliveryReport::default();
        }
    };
    let chosen = prefs::choose(
        &devices,
        |d| DevicePrefs::from_json(&d.prefs),
        message.kind,
        message.conversation_id,
        looking,
    );
    if chosen.is_empty() {
        let why = if !devices.is_empty()
            && message.kind != PushKind::Test
            && !prefs::session_unseen(message.conversation_id, looking)
        {
            "someone is looking at this session"
        } else {
            "no device wants it"
        };
        tracing::info!(
            "[push] {} for conversation {:?} not sent: {why} (away: {}, devices: {})",
            message.kind.as_str(),
            message.conversation_id,
            looking.away(),
            devices.len()
        );
        return DeliveryReport::default();
    }
    let server_id = server_id(conn).await;
    let mut report = DeliveryReport::default();
    for device in chosen {
        match send_to_device(sender, conn, setup, device, message, &server_id).await {
            SendOutcome::Delivered { .. } => report.delivered += 1,
            SendOutcome::DeviceGone { .. } => report.removed += 1,
            SendOutcome::Failed { reason, .. } => report.failed.push((device.id, reason)),
        }
    }
    report
}

/// Whether any device is registered (a cheap gate before building a
/// notification).
pub async fn has_devices(conn: &DatabaseConnection) -> bool {
    push_device_service::list(conn)
        .await
        .map(|d| !d.is_empty())
        .unwrap_or(false)
}

/// Send `message` with the stored credentials. Not set up: nothing happens.
pub async fn deliver(
    conn: &DatabaseConnection,
    message: &PushMessage,
    looking: &Looking,
) -> DeliveryReport {
    if !has_devices(conn).await {
        return DeliveryReport::default();
    }
    let setup = match load_send_setup(conn).await {
        Ok(setup) => setup,
        Err(e) => {
            tracing::debug!("[push] skipped {}: {}", message.kind.as_str(), e.message);
            return DeliveryReport::default();
        }
    };
    deliver_with(apns::sender(), conn, &setup, message, looking).await
}

/// One device's answer to "Send test push".
#[derive(Debug, Clone, Serialize)]
pub struct TestPushResult {
    pub device_id: i32,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
    /// Apple said the token is dead; the device was removed.
    pub removed: bool,
}

fn test_outcome(device: &push_device::Model, outcome: SendOutcome) -> TestPushResult {
    let (ok, error, removed) = match outcome {
        SendOutcome::Delivered { .. } => (true, None, false),
        SendOutcome::DeviceGone { reason } => (
            false,
            Some(format!(
                "Apple says this device's token is no longer valid ({reason}); the device was removed. Open the app on it to register again."
            )),
            true,
        ),
        SendOutcome::Failed { status, reason } => (
            false,
            Some(match status {
                Some(status) => format!("APNs answered {status}: {}", explain_reason(&reason)),
                None => format!("Could not reach APNs: {reason}"),
            }),
            false,
        ),
    };
    TestPushResult {
        device_id: device.id,
        name: device.name.clone(),
        ok,
        error,
        removed,
    }
}

/// Apple's reason codes that point at a settings mistake, said plainly.
fn explain_reason(reason: &str) -> String {
    let hint = match reason {
        "InvalidProviderToken" => "the Team ID, Key ID and .p8 key do not belong together",
        "ExpiredProviderToken" => "the provider token expired (check this machine's clock)",
        "BadTopic" | "TopicDisallowed" => "the bundle ID is not one this key may push to",
        "DeviceTokenNotForTopic" => "the device was registered by an app with another bundle ID",
        "BadEnvironmentKeyInToken" | "BadCertificateEnvironment" => {
            "the key does not cover this APNs environment"
        }
        "TooManyProviderTokenUpdates" | "TooManyRequests" => "too many requests; try again later",
        _ => return reason.to_string(),
    };
    format!("{reason} — {hint}")
}

/// "Send test push": to one device, or to every registered one. Ignores the
/// prefs and presence (the user asked for it), and reports each device's
/// real error.
pub async fn send_test_with(
    sender: &ApnsSender,
    conn: &DatabaseConnection,
    setup: &SendSetup,
    device_id: Option<i32>,
) -> Result<Vec<TestPushResult>, AppCommandError> {
    let devices: Vec<push_device::Model> = push_device_service::list(conn)
        .await
        .map_err(AppCommandError::from)?
        .into_iter()
        .filter(|d| device_id.is_none_or(|id| d.id == id))
        .collect();
    if devices.is_empty() {
        return Err(AppCommandError::not_found(match device_id {
            Some(id) => format!("No push device {id}."),
            None => "No iPhone is registered yet: open the codeg iOS app and allow notifications."
                .to_string(),
        }));
    }
    let lang = push_lang(conn, &setup.settings).await;
    let message = PushMessage {
        kind: PushKind::Test,
        title: "Codeg".to_string(),
        body: wording::test_body(lang).to_string(),
        conversation_id: None,
        folder_id: None,
        agent_type: None,
        alert_id: uuid::Uuid::new_v4().simple().to_string(),
        critical_kind: None,
        needs: None,
        permission: None,
        sound: true,
    };
    let server_id = server_id(conn).await;
    let mut results = Vec::with_capacity(devices.len());
    for device in &devices {
        let outcome = send_to_device(sender, conn, setup, device, &message, &server_id).await;
        results.push(test_outcome(device, outcome));
    }
    Ok(results)
}

pub async fn send_test(
    conn: &DatabaseConnection,
    device_id: Option<i32>,
) -> Result<Vec<TestPushResult>, AppCommandError> {
    let setup = load_send_setup(conn).await?;
    send_test_with(apns::sender(), conn, &setup, device_id).await
}

#[cfg(test)]
mod tests;
