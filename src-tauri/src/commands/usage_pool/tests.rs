use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use super::*;
use crate::commands::plan_usage::{PlanUsageReport, PlanUsageWindowKind};

/// 2027-01-15T08:00:00Z.
const NOW: i64 = 1_800_000_000;
const MIN: i64 = 60;
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;

/// Stand-ins shaped like the credentials a real config and status carry.
/// None of them may come out the other side.
const FAKE_KEY: &str = "test-key-not-real";
const FAKE_ACCESS: &str = "test-access-not-real";
const FAKE_REFRESH: &str = "test-refresh-not-real";

fn ms(secs: i64) -> i64 {
    secs * 1000
}

fn iso(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap()
        .to_rfc3339()
}

/// A status shaped like maxpool's: `alpha` at its 5-hour limit with its
/// probe failing, `beta` serving, `gamma` switched off, plus every field the
/// allow-list must drop.
fn status_fixture() -> Value {
    json!({
        "version": { "current": "9.9.9", "latest": "9.9.9" },
        "runningVersion": "9.9.9",
        "currentAccount": "beta",
        "switchThreshold": 0.9,
        "routing": {
            "mode": "preferred",
            "preferredAccount": "alpha",
            "crossProviderFallbackPolicy": "never"
        },
        "accounts": [
            {
                "name": "alpha",
                "type": "oauth",
                "enabled": true,
                "status": "active",
                "refreshDead": false,
                "inFlight": 0,
                "accessToken": FAKE_ACCESS,
                "refreshToken": FAKE_REFRESH,
                "apiKey": FAKE_KEY,
                "lastError": "upstream said something with test-access-not-real in it",
                "cooldownUntil": null,
                "rateLimitedUntil": null,
                "quota": {
                    "unified5h": 1.0,
                    "unified7d": 0.51,
                    "unified5hReset": ms(NOW + 2 * HOUR),
                    "unified7dReset": ms(NOW + 3 * DAY),
                    "unifiedStatus": "rejected",
                    "tokensLimit": 123,
                    "tokensRemaining": 4,
                    "scopedWeekly": {
                        "lyra": { "utilization": 0, "resetAt": null, "isActive": false, "severity": "none" }
                    },
                    "lastProbeOkAt": ms(NOW - 20 * MIN),
                    "lastHeaderQuotaAt": ms(NOW - 5 * MIN),
                    "lastProbeError": "429 from the usage endpoint, token test-refresh-not-real",
                    "lastProbeErrorStatus": 429,
                    "consecutiveProbeFailures": 4
                },
                "weekly": { "state": "exhausted", "rawState": "exhausted", "effectiveUsage": 1.0 },
                "usage": { "inputTokens": 10, "outputTokens": 20 }
            },
            {
                "name": "beta",
                "type": "oauth",
                "enabled": true,
                "status": "active",
                "inFlight": 2,
                "accessToken": FAKE_ACCESS,
                "quota": {
                    "unified5h": 0.56,
                    "unified7d": 0.06,
                    "unified5hReset": ms(NOW + 72 * MIN),
                    "unified7dReset": ms(NOW + 6 * DAY),
                    "unifiedStatus": "allowed",
                    "scopedWeekly": {
                        "orca": { "utilization": 0.3, "resetAt": ms(NOW + 6 * DAY), "isActive": true }
                    },
                    "lastProbeOkAt": ms(NOW - 2 * MIN)
                },
                "weekly": { "state": "normal", "rawState": "normal" }
            },
            {
                "name": "gamma",
                "type": "oauth",
                "enabled": false,
                "status": "active",
                "refreshToken": FAKE_REFRESH,
                "quota": { "unified5h": 0.1 }
            }
        ],
        "scheduler": { "mode": "adaptive-least-loaded", "globalInFlight": 2 },
        "sessions": { "stickyBindings": 3 }
    })
}

fn raw_status(value: Value) -> RawStatus {
    serde_json::from_value(value).expect("status parses")
}

fn config() -> PoolConfig {
    PoolConfig {
        status_url: status_url(None, None),
        key: Some(ProxyKey(FAKE_KEY.into())),
        switch_threshold: Some(90.0),
        preferred_account: None,
        routing_mode: None,
    }
}

fn pool_from(value: Value) -> PlanUsagePool {
    build_pool(raw_status(value), &config(), NOW)
}

fn fixture_pool() -> PlanUsagePool {
    pool_from(status_fixture())
}

fn account<'a>(pool: &'a PlanUsagePool, name: &str) -> &'a PoolAccount {
    pool.accounts.iter().find(|a| a.name == name).unwrap()
}

/// The fixture with one account's fields replaced.
fn with_account(name: &str, patch: Value) -> Value {
    let mut status = status_fixture();
    let accounts = status["accounts"].as_array_mut().unwrap();
    let target = accounts
        .iter_mut()
        .find(|a| a["name"] == name)
        .unwrap()
        .as_object_mut()
        .unwrap();
    for (key, value) in patch.as_object().unwrap() {
        if key == "quota" {
            let quota = target
                .entry("quota")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap();
            for (k, v) in value.as_object().unwrap() {
                quota.insert(k.clone(), v.clone());
            }
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
    status
}

// ─── Parsing ────────────────────────────────────────────────────────────

#[test]
fn reads_every_account_into_the_allow_listed_shape() {
    insta::assert_json_snapshot!(fixture_pool());
}

#[test]
fn lists_disabled_and_failing_accounts_too() {
    let pool = pool_from(with_account(
        "alpha",
        json!({ "status": "error", "refreshDead": true }),
    ));
    let names: Vec<&str> = pool.accounts.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["alpha", "beta", "gamma"]);
    assert_eq!(account(&pool, "alpha").state, PoolAccountState::Failing);
    assert!(account(&pool, "alpha").refresh_failed);
    assert_eq!(account(&pool, "gamma").state, PoolAccountState::Disabled);
    assert!(!account(&pool, "gamma").enabled);
}

#[test]
fn marks_the_serving_and_preferred_accounts() {
    let pool = fixture_pool();
    assert!(account(&pool, "beta").serving);
    assert!(!account(&pool, "beta").preferred);
    assert!(account(&pool, "alpha").preferred);
    assert!(!account(&pool, "alpha").serving);
    assert_eq!(pool.current_account.as_deref(), Some("beta"));
    assert_eq!(pool.preferred_account.as_deref(), Some("alpha"));
    assert_eq!(pool.routing_mode.as_deref(), Some("preferred"));
    assert_eq!(pool.version.as_deref(), Some("9.9.9"));
}

#[test]
fn windows_become_percentages_with_their_resets() {
    let pool = fixture_pool();
    let beta = account(&pool, "beta");
    let ids: Vec<&str> = beta.windows.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(ids, ["five_hour", "seven_day", "seven_day_orca"]);
    let five = &beta.windows[0];
    assert_eq!(five.kind, PlanUsageWindowKind::Session);
    assert!((five.used_percent - 56.0).abs() < 1e-9);
    assert_eq!(five.resets_at, Some(NOW + 72 * MIN));
    assert_eq!(five.observed_at, Some(NOW - 2 * MIN));
    let orca = &beta.windows[2];
    assert_eq!(orca.kind, PlanUsageWindowKind::WeeklyModel);
    assert_eq!(orca.label, "Orca");
    // The newest of a probe and a live header.
    assert_eq!(account(&pool, "alpha").observed_at, Some(NOW - 5 * MIN));
    assert_eq!(pool.observed_at, Some(NOW - 2 * MIN));
}

#[test]
fn an_inactive_model_window_is_left_out() {
    let pool = fixture_pool();
    assert!(account(&pool, "alpha")
        .windows
        .iter()
        .all(|w| w.id != "seven_day_lyra"));
}

#[test]
fn a_window_with_no_reading_is_left_out() {
    let pool = fixture_pool();
    let ids: Vec<&str> = account(&pool, "gamma")
        .windows
        .iter()
        .map(|w| w.id.as_str())
        .collect();
    assert_eq!(ids, ["five_hour"]);
}

#[test]
fn odd_fields_read_as_absent_instead_of_failing_the_status() {
    let pool = pool_from(json!({
        "currentAccount": 7,
        "switchThreshold": "high",
        "routing": "preferred",
        "accounts": [
            { "name": "alpha", "enabled": "yes", "inFlight": -3, "quota": "n/a", "weekly": [] },
            { "enabled": true },
            { "name": "   " },
            "beta",
            { "name": "delta\u{7}\n", "quota": { "unified5h": "0.5", "scopedWeekly": { "Bad Family!": { "utilization": 0.9 } } } }
        ]
    }));
    let names: Vec<&str> = pool.accounts.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, ["alpha", "delta"]);
    assert!(pool.accounts[0].enabled);
    assert_eq!(pool.accounts[0].in_flight, 0);
    assert!(pool.accounts[1].windows.is_empty());
    assert_eq!(pool.switch_threshold, 90.0);
    assert_eq!(pool.current_account, None);
}

#[test]
fn a_body_that_is_not_a_status_reads_as_empty() {
    assert!(raw_status(json!({})).accounts.is_empty());
    assert!(raw_status(json!({ "accounts": {} })).accounts.is_empty());
}

#[test]
fn times_come_as_milliseconds_seconds_or_rfc3339() {
    assert_eq!(epoch_from(&json!(ms(NOW))), Some(NOW));
    assert_eq!(epoch_from(&json!(NOW)), Some(NOW));
    assert_eq!(epoch_from(&json!(iso(NOW))), Some(NOW));
    assert_eq!(
        epoch_from(&json!("2027-01-15T10:00:00.000Z")),
        Some(NOW + 2 * HOUR)
    );
    assert_eq!(epoch_from(&json!(null)), None);
    assert_eq!(epoch_from(&json!(0)), None);
    assert_eq!(epoch_from(&json!("soon")), None);
}

#[test]
fn cooldowns_given_as_timestamps_count() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "cooldownUntil": iso(NOW + 90), "rateLimitedUntil": iso(NOW + 30) }),
    ));
    assert_eq!(account(&pool, "beta").cooling_until, Some(NOW + 90));
    let past = pool_from(with_account(
        "beta",
        json!({ "cooldownUntil": iso(NOW - 90) }),
    ));
    assert_eq!(account(&past, "beta").cooling_until, None);
}

// ─── Secrets ────────────────────────────────────────────────────────────

/// Credential-ish words and the fake values themselves, as they would
/// appear in serialized output.
const FORBIDDEN: &[&str] = &[
    "token",
    "Token",
    "apiKey",
    "api_key",
    "secret",
    "lastError",
    "last_error",
    FAKE_KEY,
    FAKE_ACCESS,
    FAKE_REFRESH,
    "upstream said",
];

fn assert_clean(serialized: &str) {
    for word in FORBIDDEN {
        assert!(
            !serialized.contains(word),
            "serialized output contains {word:?}: {serialized}"
        );
    }
}

#[test]
fn the_serialized_reading_carries_no_credentials() {
    let pool = fixture_pool();
    assert_clean(&serde_json::to_string(&pool).unwrap());
    let report = PlanUsageReport {
        pool: Some(pool.clone()),
        ..PlanUsageReport::default()
    };
    assert_clean(&serde_json::to_string(&report).unwrap());
    // The event payload too.
    assert_clean(&serde_json::to_string(&Some(&pool)).unwrap());
    // And a stale one.
    let stale = pool.into_stale(FetchError::of(PoolError::Timeout), NOW);
    assert_clean(&serde_json::to_string(&stale).unwrap());
}

#[test]
fn the_key_never_prints() {
    let config = config();
    let printed = format!("{config:?} {:?}", config.key);
    assert!(!printed.contains(FAKE_KEY), "{printed}");
    assert!(printed.contains("<redacted>"));
}

#[test]
fn the_key_header_is_marked_sensitive() {
    let value = ProxyKey(FAKE_KEY.into()).header_value().unwrap();
    assert!(value.is_sensitive());
    assert!(!format!("{value:?}").contains(FAKE_KEY));
    assert!(ProxyKey(String::new()).header_value().is_none());
}

// ─── Config ─────────────────────────────────────────────────────────────

fn write_config(dir: &tempfile::TempDir, body: &str) -> PathBuf {
    let path = dir.path().join("maxpool.json");
    std::fs::write(&path, body).unwrap();
    path
}

#[test]
fn discovery_reads_the_proxy_and_routing() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        &dir,
        &json!({
            "proxy": { "host": "0.0.0.0", "port": 4567, "apiKey": FAKE_KEY },
            "switchThreshold": 0.85,
            "routing": { "mode": "preferred", "preferredAccount": "alpha" },
            "accounts": [
                { "name": "alpha", "accessToken": FAKE_ACCESS, "refreshToken": FAKE_REFRESH }
            ]
        })
        .to_string(),
    );
    let Discovery::Found(config) = discover_at(&path) else {
        panic!("config should be found");
    };
    assert_eq!(config.status_url, "http://127.0.0.1:4567/maxpool/status");
    assert_eq!(config.key.as_ref().map(|k| k.0.as_str()), Some(FAKE_KEY));
    assert!((config.switch_threshold.unwrap() - 85.0).abs() < 1e-9);
    assert_eq!(config.preferred_account.as_deref(), Some("alpha"));
    assert_eq!(config.routing_mode.as_deref(), Some("preferred"));
    let printed = format!("{config:?}");
    for secret in [FAKE_KEY, FAKE_ACCESS, FAKE_REFRESH] {
        assert!(!printed.contains(secret), "{printed}");
    }
}

#[test]
fn a_config_without_a_proxy_section_uses_the_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, "{}");
    let Discovery::Found(config) = discover_at(&path) else {
        panic!("config should be found");
    };
    assert_eq!(config.status_url, "http://127.0.0.1:3456/maxpool/status");
    assert!(config.key.is_none());
    assert_eq!(config.switch_threshold, None);
}

#[test]
fn no_config_is_no_pool_and_a_broken_one_is_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        discover_at(&dir.path().join("missing.json")),
        Discovery::Absent
    ));
    let broken = write_config(&dir, "{ not json");
    assert!(matches!(discover_at(&broken), Discovery::Unreadable));
    let list = write_config(&dir, "[1, 2]");
    assert!(matches!(discover_at(&list), Discovery::Unreadable));
}

#[test]
fn the_status_address_comes_from_the_proxy_bind() {
    assert_eq!(
        status_url(Some("127.0.0.1"), Some(3456)),
        "http://127.0.0.1:3456/maxpool/status"
    );
    assert_eq!(
        status_url(Some(""), None),
        "http://127.0.0.1:3456/maxpool/status"
    );
    assert_eq!(
        status_url(Some("::"), Some(9)),
        "http://127.0.0.1:9/maxpool/status"
    );
    assert_eq!(
        status_url(Some("[::]"), Some(9)),
        "http://127.0.0.1:9/maxpool/status"
    );
    assert_eq!(
        status_url(Some("::1"), Some(9)),
        "http://[::1]:9/maxpool/status"
    );
    assert_eq!(
        status_url(Some("localhost"), Some(0)),
        "http://localhost:3456/maxpool/status"
    );
    // Anything that isn't a plain host stays on loopback.
    assert_eq!(
        status_url(Some("evil.example/x?y"), Some(9)),
        "http://127.0.0.1:9/maxpool/status"
    );
    assert_eq!(
        status_url(Some("user@evil.example"), Some(9)),
        "http://127.0.0.1:9/maxpool/status"
    );
}

// ─── Availability ───────────────────────────────────────────────────────

#[test]
fn an_account_at_its_limit_is_held_until_the_window_resets() {
    let pool = fixture_pool();
    let alpha = account(&pool, "alpha");
    assert_eq!(alpha.state, PoolAccountState::Exhausted);
    assert_eq!(alpha.blocked_until, Some(NOW + 2 * HOUR));
    assert_eq!(account(&pool, "beta").state, PoolAccountState::Available);
    assert_eq!(account(&pool, "beta").blocked_until, None);
    assert!(!pool.exhausted);
    assert_eq!(pool_limit(&pool, NOW, None), Some(PoolLimit::Headroom));
}

#[test]
fn past_the_switch_threshold_is_held_back_but_not_exhausted() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "quota": { "unified5h": 0.93 } }),
    ));
    let beta = account(&pool, "beta");
    assert_eq!(beta.state, PoolAccountState::AtThreshold);
    assert_eq!(beta.blocked_until, Some(NOW + 72 * MIN));
    // Both held: the pool frees up when the first of them does.
    assert!(pool.exhausted);
    assert_eq!(pool.resumes_at, Some(NOW + 72 * MIN));
}

#[test]
fn every_account_out_resumes_at_the_earliest_reset() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "quota": { "unified5h": 1.0, "unified5hReset": ms(NOW + 4 * HOUR), "unifiedStatus": "rejected" } }),
    ));
    assert!(pool.exhausted);
    assert_eq!(pool.resumes_at, Some(NOW + 2 * HOUR));
    assert_eq!(
        pool_limit(&pool, NOW, None),
        Some(PoolLimit::Exhausted {
            resumes_at: Some(NOW + 2 * HOUR)
        })
    );
    // Once alpha's window has rolled over, alpha is free again.
    assert_eq!(
        pool_limit(&pool, NOW + 2 * HOUR, None),
        Some(PoolLimit::Headroom)
    );
}

#[test]
fn a_disabled_account_with_headroom_does_not_count() {
    // gamma is at 10% but switched off.
    let pool = pool_from(with_account("beta", json!({ "enabled": false })));
    assert_eq!(account(&pool, "beta").state, PoolAccountState::Disabled);
    assert!(pool.exhausted);
    assert_eq!(pool.resumes_at, Some(NOW + 2 * HOUR));
}

#[test]
fn no_enabled_account_leaves_the_decision_elsewhere() {
    let mut pool = fixture_pool();
    for account in &mut pool.accounts {
        account.enabled = false;
    }
    assert_eq!(pool_limit(&pool, NOW, None), None);
}

#[test]
fn a_cooling_account_frees_up_after_its_cooldown() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "cooldownUntil": iso(NOW + 5 * MIN) }),
    ));
    let beta = account(&pool, "beta");
    assert_eq!(beta.state, PoolAccountState::CoolingDown);
    assert_eq!(beta.blocked_until, Some(NOW + 5 * MIN));
    assert_eq!(pool.resumes_at, Some(NOW + 5 * MIN));
}

#[test]
fn several_blockers_hold_until_the_last_clears() {
    let pool = pool_from(with_account(
        "beta",
        json!({
            "cooldownUntil": iso(NOW + 3 * HOUR),
            "quota": { "unified5h": 0.95 }
        }),
    ));
    assert_eq!(account(&pool, "beta").blocked_until, Some(NOW + 3 * HOUR));
}

#[test]
fn a_failing_account_has_no_known_end() {
    let pool = pool_from(with_account("beta", json!({ "status": "error" })));
    assert_eq!(account(&pool, "beta").state, PoolAccountState::Failing);
    assert_eq!(account(&pool, "beta").blocked_until, None);
    // alpha's known reset still answers for the pool.
    assert_eq!(pool.resumes_at, Some(NOW + 2 * HOUR));
}

#[test]
fn a_full_week_waits_for_the_weekly_reset() {
    let pool = pool_from(with_account(
        "beta",
        json!({
            "quota": { "unified7d": 1.0, "unifiedStatus": "rejected" },
            "weekly": { "state": "exhausted", "rawState": "exhausted" }
        }),
    ));
    let beta = account(&pool, "beta");
    assert_eq!(beta.state, PoolAccountState::Exhausted);
    assert_eq!(beta.blocked_until, Some(NOW + 6 * DAY));
    assert_eq!(pool.resumes_at, Some(NOW + 2 * HOUR));
}

#[test]
fn a_rejected_five_hour_window_does_not_wait_for_the_week() {
    // The pool reports the weekly as exhausted when the provider rejects a
    // full 5-hour window; alpha frees up with its 5-hour reset.
    let pool = fixture_pool();
    assert_eq!(
        account(&pool, "alpha").weekly_state,
        Some(PoolWeeklyState::Exhausted)
    );
    assert_eq!(account(&pool, "alpha").blocked_until, Some(NOW + 2 * HOUR));
}

#[test]
fn a_full_model_window_blocks_only_that_model() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "quota": { "scopedWeekly": { "orca": { "utilization": 1.0, "resetAt": ms(NOW + 4 * DAY), "isActive": true } } } }),
    ));
    assert_eq!(account(&pool, "beta").state, PoolAccountState::Available);
    assert_eq!(pool_limit(&pool, NOW, None), Some(PoolLimit::Headroom));
    assert_eq!(
        pool_limit(&pool, NOW, Some("orca")),
        Some(PoolLimit::Exhausted {
            resumes_at: Some(NOW + 2 * HOUR)
        })
    );
    assert_eq!(
        pool_limit(&pool, NOW, Some("wren")),
        Some(PoolLimit::Headroom)
    );
}

#[test]
fn message_windows_map_to_model_families() {
    assert_eq!(scope_for_window("five_hour"), None);
    assert_eq!(scope_for_window("seven_day"), None);
    assert_eq!(scope_for_window("seven_day_orca"), Some("orca"));
    assert_eq!(scope_for_window("seven_day_wren"), Some("wren"));
    assert_eq!(
        scope_for_window("seven_day_overage_included"),
        Some("fable")
    );
}

// ─── Limit-continue ─────────────────────────────────────────────────────

#[test]
fn headroom_resumes_soon() {
    let pool = fixture_pool();
    assert_eq!(
        resume_at_from(&pool, NOW, Some("five_hour")),
        Some(NOW + POOL_HEADROOM_RETRY_SECS)
    );
}

#[test]
fn an_exhausted_pool_resumes_at_its_first_reset() {
    let pool = pool_from(with_account("beta", json!({ "enabled": false })));
    assert_eq!(
        resume_at_from(&pool, NOW, Some("five_hour")),
        Some(NOW + 2 * HOUR)
    );
}

#[test]
fn a_model_limit_waits_for_an_account_with_that_model_free() {
    let pool = pool_from(with_account(
        "beta",
        json!({ "quota": { "scopedWeekly": { "orca": { "utilization": 1.0, "resetAt": ms(NOW + 4 * DAY), "isActive": true } } } }),
    ));
    assert_eq!(
        resume_at_from(&pool, NOW, Some("seven_day_orca")),
        Some(NOW + 2 * HOUR)
    );
    assert_eq!(
        resume_at_from(&pool, NOW, Some("seven_day")),
        Some(NOW + POOL_HEADROOM_RETRY_SECS)
    );
}

#[test]
fn a_stale_or_empty_reading_decides_nothing() {
    let pool = fixture_pool();
    let stale = pool
        .clone()
        .into_stale(FetchError::of(PoolError::Unreachable), NOW);
    assert_eq!(resume_at_from(&stale, NOW, None), None);
    let empty = PlanUsagePool::unanswered(&config(), FetchError::of(PoolError::Timeout), NOW);
    assert_eq!(resume_at_from(&empty, NOW, None), None);
    // Every account out with no known reset: no time to give.
    let failing = pool_from(json!({
        "accounts": [{ "name": "alpha", "status": "error" }]
    }));
    assert_eq!(resume_at_from(&failing, NOW, None), None);
}

// ─── Failure handling ───────────────────────────────────────────────────

#[test]
fn a_failed_ask_keeps_the_last_reading_marked_stale() {
    let pool = fixture_pool();
    let stale = pool.clone().into_stale(
        FetchError {
            kind: PoolError::HttpStatus,
            status: Some(502),
        },
        NOW + 5 * MIN,
    );
    assert!(stale.stale);
    assert_eq!(stale.error, Some(PoolError::HttpStatus));
    assert_eq!(stale.error_status, Some(502));
    assert_eq!(stale.checked_at, NOW + 5 * MIN);
    assert_eq!(stale.accounts, pool.accounts);
    assert_eq!(stale.observed_at, pool.observed_at);
}

#[test]
fn a_pool_that_never_answered_has_no_accounts() {
    let pool = PlanUsagePool::unanswered(
        &config(),
        FetchError {
            kind: PoolError::Unauthorized,
            status: Some(401),
        },
        NOW,
    );
    assert!(pool.stale);
    assert!(pool.accounts.is_empty());
    assert_eq!(pool.error, Some(PoolError::Unauthorized));
    let json = serde_json::to_value(&pool).unwrap();
    assert_eq!(json["error"], "unauthorized");
    assert_eq!(json["error_status"], 401);
}

// ─── Fetching ───────────────────────────────────────────────────────────

async fn fake_pool() -> String {
    async fn status(headers: HeaderMap) -> axum::response::Response {
        if headers.get("x-api-key").and_then(|v| v.to_str().ok()) != Some(FAKE_KEY) {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        axum::Json(status_fixture()).into_response()
    }
    let app = Router::new()
        .route("/maxpool/status", get(status))
        .route("/garbage/maxpool/status", get(|| async { "not json" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn the_status_is_read_with_the_key_and_errors_are_classified() {
    let base = fake_pool().await;
    let with_key = PoolConfig {
        status_url: format!("{base}/maxpool/status"),
        ..config()
    };
    let raw = fetch_status(&with_key).await.expect("status answers");
    let pool = build_pool(raw, &with_key, NOW);
    assert_eq!(pool, fixture_pool());

    let without_key = PoolConfig {
        key: None,
        ..with_key.clone()
    };
    let error = fetch_status(&without_key).await.err().unwrap();
    assert_eq!(error.kind, PoolError::Unauthorized);
    assert_eq!(error.status, Some(401));

    let missing = PoolConfig {
        status_url: format!("{base}/nothing/here"),
        ..with_key.clone()
    };
    let error = fetch_status(&missing).await.err().unwrap();
    assert_eq!(error.kind, PoolError::HttpStatus);
    assert_eq!(error.status, Some(404));

    let garbage = PoolConfig {
        status_url: format!("{base}/garbage/maxpool/status"),
        ..with_key.clone()
    };
    let error = fetch_status(&garbage).await.err().unwrap();
    assert_eq!(error.kind, PoolError::InvalidResponse);

    // Nothing listening.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let down = PoolConfig {
        status_url: status_url(Some("127.0.0.1"), Some(closed)),
        ..with_key
    };
    let error = fetch_status(&down).await.err().unwrap();
    assert_eq!(error.kind, PoolError::Unreachable);
}
