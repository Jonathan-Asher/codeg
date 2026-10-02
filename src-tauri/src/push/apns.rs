//! The APNs HTTP/2 client: one request per device, with token auth, retries
//! and Apple's answer sorted into what to do about the device.
//!
//! Apple's hosts speak HTTP/2 only; rustls negotiates it through ALPN. The
//! base URL can be pointed elsewhere with `CODEG_APNS_BASE_URL` (a local mock
//! in tests and end-to-end checks; plain `http://` then speaks HTTP/1.1).

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::jwt::TokenCache;
use super::payload::PushMessage;
use super::ApnsEnvironment;

/// Overrides both APNs hosts (tests, a local mock).
pub const BASE_URL_ENV: &str = "CODEG_APNS_BASE_URL";

const PRODUCTION_URL: &str = "https://api.push.apple.com";
const SANDBOX_URL: &str = "https://api.sandbox.push.apple.com";

/// Tries per notification for throttling (429), Apple's 5xx and network
/// errors.
const MAX_ATTEMPTS: u32 = 3;

/// Longest wait a `Retry-After` may impose.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

/// The host for `environment`, unless `CODEG_APNS_BASE_URL` overrides it.
pub fn base_url(environment: ApnsEnvironment) -> String {
    if let Ok(url) = std::env::var(BASE_URL_ENV) {
        let url = url.trim().trim_end_matches('/');
        if !url.is_empty() {
            return url.to_string();
        }
    }
    match environment {
        ApnsEnvironment::Production => PRODUCTION_URL.to_string(),
        ApnsEnvironment::Sandbox => SANDBOX_URL.to_string(),
    }
}

/// What one APNs answer means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Delivered,
    /// The token is dead (410 Unregistered/ExpiredToken, 400 BadDeviceToken):
    /// forget the device.
    DeviceGone,
    /// Apple rejected the provider token: mint a new one and try again.
    RefreshToken,
    /// Throttled or Apple-side trouble: try again later.
    Retry,
    Fail,
}

pub fn classify(status: u16, reason: Option<&str>) -> Disposition {
    match (status, reason) {
        (200, _) => Disposition::Delivered,
        (410, _) => Disposition::DeviceGone,
        (400, Some("BadDeviceToken")) => Disposition::DeviceGone,
        (403, Some("ExpiredProviderToken" | "InvalidProviderToken")) => Disposition::RefreshToken,
        (429, _) | (500..=599, _) => Disposition::Retry,
        _ => Disposition::Fail,
    }
}

/// How long to wait before attempt `attempt + 1`.
pub fn backoff(attempt: u32, retry_after_secs: Option<u64>) -> Duration {
    match retry_after_secs {
        Some(secs) => Duration::from_secs(secs).min(MAX_RETRY_AFTER),
        None => Duration::from_secs(1u64 << attempt.saturating_sub(1).min(4)),
    }
}

/// How one notification to one device ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    Delivered { apns_id: Option<String> },
    DeviceGone { reason: String },
    Failed { status: Option<u16>, reason: String },
}

/// The credentials a send signs with.
#[derive(Clone)]
pub struct Credentials {
    pub team_id: String,
    pub key_id: String,
    /// The `.p8` contents. Never logged.
    pub key_pem: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("team_id", &self.team_id)
            .field("key_id", &self.key_id)
            .field("key_pem", &"<redacted>")
            .finish()
    }
}

/// Where one notification goes.
#[derive(Debug, Clone)]
pub struct Target<'a> {
    pub device_id: i32,
    pub token: &'a str,
    pub topic: &'a str,
    pub environment: ApnsEnvironment,
}

#[derive(Deserialize)]
struct ApnsError {
    reason: String,
}

/// A device token in logs: its tail only.
pub fn token_hint(token: &str) -> String {
    let tail: String = token
        .chars()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

/// The APNs client: a pooled HTTP/2 connection per host and the provider
/// token in use.
pub struct ApnsSender {
    client: reqwest::Client,
    tokens: Mutex<TokenCache>,
    /// Fixed base URL (tests); `None` reads [`base_url`].
    base_url: Option<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(10 * 60))
        .build()
        .unwrap_or_else(|e| {
            tracing::warn!("[push] building the APNs client failed ({e}); using defaults");
            reqwest::Client::new()
        })
}

impl ApnsSender {
    pub fn new() -> Self {
        Self {
            client: http_client(),
            tokens: Mutex::new(TokenCache::default()),
            base_url: None,
        }
    }

    /// A sender bound to one base URL, whatever the device's environment.
    pub fn with_base_url(url: impl Into<String>) -> Self {
        Self {
            base_url: Some(url.into()),
            ..Self::new()
        }
    }

    /// Forget the provider token (the credentials changed).
    pub fn invalidate_token(&self) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .invalidate();
    }

    fn provider_token(&self, creds: &Credentials) -> Result<String, String> {
        let unix_now = chrono::Utc::now().timestamp();
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_mint(
                &creds.team_id,
                &creds.key_id,
                &creds.key_pem,
                Instant::now(),
                unix_now,
            )
            .map_err(|e| e.to_string())
    }

    fn url(&self, target: &Target<'_>) -> String {
        let base = self
            .base_url
            .clone()
            .unwrap_or_else(|| base_url(target.environment));
        format!("{base}/3/device/{}", target.token)
    }

    /// Send one notification to one device: retries throttling and Apple's
    /// errors, refreshes a rejected provider token once.
    pub async fn send(
        &self,
        creds: &Credentials,
        target: &Target<'_>,
        message: &PushMessage,
        server_id: &str,
    ) -> SendOutcome {
        let url = self.url(target);
        let body = message.body_json(server_id);
        let collapse_id = message.collapse_id(server_id);
        let hint = token_hint(target.token);
        let mut refreshed = false;
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let token = match self.provider_token(creds) {
                Ok(token) => token,
                Err(reason) => {
                    tracing::warn!("[push] cannot sign the provider token: {reason}");
                    return SendOutcome::Failed {
                        status: None,
                        reason,
                    };
                }
            };
            let expiration = message.expiration(chrono::Utc::now().timestamp());
            let response = self
                .client
                .post(&url)
                .header("authorization", format!("bearer {token}"))
                .header("apns-push-type", "alert")
                .header("apns-topic", target.topic)
                .header("apns-priority", "10")
                .header("apns-expiration", expiration.to_string())
                .header("apns-collapse-id", &collapse_id)
                .json(&body)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(e) => {
                    tracing::warn!(
                        "[push] device {} ({hint}) attempt {attempt}: request failed: {e}",
                        target.device_id
                    );
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(backoff(attempt, None)).await;
                        continue;
                    }
                    return SendOutcome::Failed {
                        status: None,
                        reason: e.to_string(),
                    };
                }
            };
            let status = response.status().as_u16();
            let apns_id = response
                .headers()
                .get("apns-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let reason = if status == 200 {
                None
            } else {
                response.json::<ApnsError>().await.ok().map(|e| e.reason)
            };
            let disposition = classify(status, reason.as_deref());
            tracing::info!(
                "[push] device {} ({hint}) {} {}: {status} {} apns-id={}",
                target.device_id,
                message.kind.as_str(),
                message.alert_id,
                reason.as_deref().unwrap_or("ok"),
                apns_id.as_deref().unwrap_or("-")
            );
            let reason_text = || reason.clone().unwrap_or_else(|| format!("HTTP {status}"));
            match disposition {
                Disposition::Delivered => return SendOutcome::Delivered { apns_id },
                Disposition::DeviceGone => {
                    return SendOutcome::DeviceGone {
                        reason: reason_text(),
                    }
                }
                Disposition::RefreshToken if !refreshed => {
                    refreshed = true;
                    self.invalidate_token();
                    continue;
                }
                Disposition::Retry if attempt < MAX_ATTEMPTS => {
                    tokio::time::sleep(backoff(attempt, retry_after)).await;
                    continue;
                }
                _ => {
                    return SendOutcome::Failed {
                        status: Some(status),
                        reason: reason_text(),
                    }
                }
            }
        }
    }
}

impl Default for ApnsSender {
    fn default() -> Self {
        Self::new()
    }
}

static SENDER: LazyLock<ApnsSender> = LazyLock::new(ApnsSender::new);

/// The process-wide sender.
pub fn sender() -> &'static ApnsSender {
    &SENDER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_answers_are_sorted() {
        assert_eq!(classify(200, None), Disposition::Delivered);
        assert_eq!(classify(410, Some("Unregistered")), Disposition::DeviceGone);
        assert_eq!(
            classify(400, Some("BadDeviceToken")),
            Disposition::DeviceGone
        );
        assert_eq!(
            classify(400, Some("DeviceTokenNotForTopic")),
            Disposition::Fail
        );
        assert_eq!(
            classify(403, Some("ExpiredProviderToken")),
            Disposition::RefreshToken
        );
        assert_eq!(classify(403, Some("BadCertificate")), Disposition::Fail);
        assert_eq!(classify(429, Some("TooManyRequests")), Disposition::Retry);
        assert_eq!(
            classify(503, Some("ServiceUnavailable")),
            Disposition::Retry
        );
        assert_eq!(classify(413, Some("PayloadTooLarge")), Disposition::Fail);
    }

    #[test]
    fn backoff_doubles_and_honours_retry_after_up_to_a_cap() {
        assert_eq!(backoff(1, None), Duration::from_secs(1));
        assert_eq!(backoff(2, None), Duration::from_secs(2));
        assert_eq!(backoff(3, None), Duration::from_secs(4));
        assert_eq!(backoff(1, Some(5)), Duration::from_secs(5));
        assert_eq!(backoff(1, Some(3600)), MAX_RETRY_AFTER);
    }

    #[test]
    fn logs_show_only_a_token_tail() {
        assert_eq!(token_hint("0123456789abcdef"), "…89abcdef");
        assert_eq!(token_hint("abc"), "…abc");
    }

    #[test]
    fn credentials_never_print_the_key() {
        let creds = Credentials {
            team_id: "T".into(),
            key_id: "K".into(),
            key_pem: "SECRET".into(),
        };
        assert!(!format!("{creds:?}").contains("SECRET"));
    }

    #[test]
    fn the_base_url_follows_the_environment() {
        // No override set in this process for these hosts.
        if std::env::var(BASE_URL_ENV).is_err() {
            assert_eq!(base_url(ApnsEnvironment::Production), PRODUCTION_URL);
            assert_eq!(base_url(ApnsEnvironment::Sandbox), SANDBOX_URL);
        }
    }
}
