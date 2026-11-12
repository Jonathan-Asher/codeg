//! The pool's usage-limit resets: reading `GET /maxpool/resets`, putting it on
//! the pool reading, using one and reading an account again through a stand-in
//! pool, and that codeg has no way of its own to the provider's resets.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use super::*;
use crate::commands::usage_pool::{build_pool, status_url, RawStatus};

/// 2027-01-15T08:00:00Z.
const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const KEY: &str = "test-pool-key-not-real";

fn ms(secs: i64) -> i64 {
    secs * 1000
}

fn config_at(base: &str) -> PoolConfig {
    PoolConfig {
        status_url: format!("{base}/maxpool/status"),
        key: Some(ProxyKey(KEY.into())),
        switch_threshold: Some(90.0),
        preferred_account: None,
        routing_mode: None,
        accounts: BTreeMap::new(),
    }
}

/// What a pool with the routes answers (`src/reset-routes.js`): times in
/// epoch milliseconds.
fn listing() -> Value {
    json!({
        "ok": true,
        "generatedAt": ms(NOW),
        "autoRedeem": { "enabled": true, "policy": { "wallWeekly": 0.9 } },
        "accounts": [
            {
                "name": "primary", "enabled": true, "provider": "anthropic", "type": "oauth",
                "grants": [
                    { "id": "late", "label": "One full limit reset", "resetsLeft": 1, "resetsTotal": 1,
                      "endsAt": ms(NOW + 20 * DAY), "clears": ["five_hour", "seven_day"],
                      "usableNow": true, "paused": false, "requiresLimit": true, "expired": false },
                    { "id": "soon", "label": null, "resetsLeft": 2, "resetsTotal": 2,
                      "endsAt": ms(NOW + 2 * DAY), "clears": ["seven_day", "seven_day_overage_included"],
                      "usableNow": true, "paused": false, "requiresLimit": false, "expired": false },
                    { "id": "held", "resetsLeft": 1, "endsAt": ms(NOW + 5 * DAY), "clears": ["five_hour"],
                      "usableNow": true, "paused": true, "requiresLimit": false },
                    { "id": "gone", "resetsLeft": 1, "endsAt": ms(NOW - DAY), "clears": ["seven_day"],
                      "usableNow": true },
                    { "id": "spent", "resetsLeft": 0, "endsAt": ms(NOW + DAY), "usableNow": false },
                    { "resetsLeft": 1, "usableNow": true }
                ],
                "nextGrantId": "soon", "cooldownUntil": null, "eligible": true, "reason": null,
                "checkedAt": ms(NOW - 30), "stale": false, "error": null, "lastClaimAt": null,
                "autoRedeem": { "wouldAct": true, "grantId": "soon", "reason": "at wall" }
            },
            {
                "name": "spare@example.com", "enabled": true, "provider": "anthropic", "type": "oauth",
                "grants": [], "nextGrantId": null, "cooldownUntil": ms(NOW + 3600), "eligible": false,
                "reason": "tier", "checkedAt": ms(NOW - 60), "autoRedeem": { "wouldAct": false }
            },
            {
                "name": "off", "enabled": false, "provider": "anthropic", "type": "oauth",
                "grants": [{ "id": "x", "resetsLeft": 1, "usableNow": true }],
                "autoRedeem": { "wouldAct": true }
            },
            {
                "name": "glm", "enabled": true, "provider": "zai", "type": "provider", "grants": [],
                "cards": { "fiveHour": [{ "recordId": 7, "expiresAt": ms(NOW + DAY) }], "weekly": [] }
            }
        ]
    })
}

fn listed() -> Vec<(String, PoolAccountResets)> {
    parse_resets(listing().to_string().as_bytes(), NOW).expect("a listing parses")
}

#[test]
fn each_claude_accounts_resets_are_read_from_the_listing() {
    let listed = listed();
    let names: Vec<&str> = listed.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["primary", "spare@example.com", "off"], "API providers are left out");

    let primary = &listed[0].1;
    let ids: Vec<&str> = primary.grants.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(ids, ["soon", "held", "late"], "in date, not spent, soonest first");
    assert_eq!(primary.available, 4);
    assert_eq!(primary.next_grant_id.as_deref(), Some("soon"));
    assert!(primary.auto_redeem);
    assert_eq!(primary.eligible, Some(true));
    assert_eq!(primary.checked_at, Some(NOW - 30), "milliseconds become seconds");

    let soon = &primary.grants[0];
    assert_eq!(soon.kind, LimitResetKind::Weekly);
    assert_eq!(soon.count, 2);
    assert_eq!(soon.expires_at, Some(NOW + 2 * DAY));
    assert!(soon.usable_now);
    assert!(!soon.requires_limit);
    let held = &primary.grants[1];
    assert_eq!(held.kind, LimitResetKind::Session);
    assert!(!held.usable_now, "a paused grant can't be used");
    let late = &primary.grants[2];
    assert_eq!(late.kind, LimitResetKind::Full);
    assert_eq!(late.label.as_deref(), Some("One full limit reset"));
    assert!(late.requires_limit);

    let spare = &listed[1].1;
    assert_eq!(spare.available, 0);
    assert_eq!(spare.eligible, Some(false));
    assert_eq!(spare.cooldown_until, Some(NOW + 3600));
    assert!(!spare.auto_redeem);

    let off = &listed[2].1;
    assert!(off.grants.is_empty(), "a paused account's resets aren't the pool's");
    assert!(!off.auto_redeem);
}

#[test]
fn automatic_use_is_reported_only_while_the_pool_does_it() {
    let mut body = listing();
    body["autoRedeem"]["enabled"] = json!(false);
    let listed = parse_resets(body.to_string().as_bytes(), NOW).unwrap();
    assert!(!listed[0].1.auto_redeem);
}

#[test]
fn an_answer_that_is_not_a_listing_reads_as_none() {
    // What an older pool's upstream says to a path it forwards.
    let forwarded = json!({ "type": "error", "error": { "type": "not_found_error", "message": "Not found" } });
    assert!(parse_resets(forwarded.to_string().as_bytes(), NOW).is_none());
    assert!(parse_resets(b"[]", NOW).is_none());
    assert!(parse_resets(b"not json", NOW).is_none());
    assert!(parse_resets(json!({ "ok": false, "accounts": [] }).to_string().as_bytes(), NOW).is_none());
}

#[test]
fn what_a_grant_refills_follows_the_windows_it_clears() {
    let w = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(grant_kind(&w(&["five_hour", "seven_day"])), LimitResetKind::Full);
    assert_eq!(grant_kind(&w(&["seven_day"])), LimitResetKind::Weekly);
    assert_eq!(grant_kind(&w(&["five_hour"])), LimitResetKind::Session);
    assert_eq!(grant_kind(&w(&[])), LimitResetKind::Other);
}

fn status_with(names: &[&str]) -> RawStatus {
    let accounts: Vec<Value> = names
        .iter()
        .map(|name| json!({ "name": name, "enabled": true, "status": "active", "type": "oauth",
                            "quota": { "unified7d": 0.5, "unified7dReset": ms(NOW + DAY) } }))
        .collect();
    serde_json::from_value(json!({ "runningVersion": "1.24.5", "accounts": accounts })).unwrap()
}

#[test]
fn resets_go_on_the_accounts_and_stay_while_the_pool_does_not_answer() {
    let config = config_at("http://127.0.0.1:9");
    let mut pool = build_pool(status_with(&["primary", "other"]), &config, NOW);
    attach(&mut pool, ResetsRead::Listed(listed()), None);
    assert!(pool.resets_supported);
    assert_eq!(pool.accounts[0].resets.as_ref().map(|r| r.available), Some(4));
    assert!(pool.accounts[1].resets.is_none(), "an account the listing doesn't name has none");
    let json = serde_json::to_value(&pool).unwrap();
    assert_eq!(json["resets_supported"], true);
    assert_eq!(json["accounts"][0]["resets"]["grants"][0]["kind"], "weekly");
    assert_eq!(json["accounts"][0]["resets"]["grants"][0]["expires_at"], NOW + 2 * DAY);

    let mut next = build_pool(status_with(&["primary", "other"]), &config, NOW + 60);
    attach(&mut next, ResetsRead::Unavailable, Some(&pool));
    assert!(next.resets_supported);
    assert_eq!(next.accounts[0].resets, pool.accounts[0].resets);

    let mut old = build_pool(status_with(&["primary"]), &config, NOW);
    attach(&mut old, ResetsRead::Unsupported, Some(&pool));
    assert!(!old.resets_supported);
    assert!(old.accounts[0].resets.is_none());
    let json = serde_json::to_value(&old).unwrap();
    assert!(json.get("resets_supported").is_none(), "an older pool's reading is unchanged");
    assert!(json["accounts"][0].get("resets").is_none());
}

// ─── A stand-in pool ────────────────────────────────────────────────────

#[derive(Default)]
struct Seen {
    resets_gets: usize,
    redeems: Vec<Value>,
    rechecks: Vec<String>,
}

type Shared = Arc<Mutex<Seen>>;

fn keyed(headers: &HeaderMap) -> bool {
    headers.get("x-api-key").and_then(|v| v.to_str().ok()) == Some(KEY)
}

async fn stand_in_pool(listing_status: StatusCode) -> (String, Shared) {
    let seen: Shared = Arc::default();
    async fn resets(
        State((seen, status)): State<(Shared, StatusCode)>,
        headers: HeaderMap,
    ) -> axum::response::Response {
        seen.lock().unwrap().resets_gets += 1;
        if !keyed(&headers) {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        if status != StatusCode::OK {
            return (status, r#"{"type":"error","error":{"type":"not_found_error"}}"#).into_response();
        }
        axum::Json(listing()).into_response()
    }
    async fn redeem(
        State((seen, _)): State<(Shared, StatusCode)>,
        headers: HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> axum::response::Response {
        if !keyed(&headers) {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        seen.lock().unwrap().redeems.push(body.clone());
        match body["account"].as_str() {
            Some("primary") => axum::Json(json!({ "ok": true, "account": "primary", "grantId": "soon",
                "alreadyUsed": false, "cleared": ["rateLimitedUntil"], "probe": { "ok": true } })).into_response(),
            Some("again") => (StatusCode::CONFLICT, axum::Json(json!({ "ok": false, "error": "recently_claimed",
                "message": "A reset was just used on this account." }))).into_response(),
            Some("slow") => (StatusCode::GATEWAY_TIMEOUT, axum::Json(json!({ "ok": false, "error": "claim_timeout" })))
                .into_response(),
            _ => (StatusCode::NOT_FOUND, axum::Json(json!({ "ok": false, "error": "account_not_found" }))).into_response(),
        }
    }
    async fn recheck(
        State((seen, _)): State<(Shared, StatusCode)>,
        headers: HeaderMap,
        UrlPath(name): UrlPath<String>,
    ) -> axum::response::Response {
        if !keyed(&headers) {
            return (StatusCode::UNAUTHORIZED, "{}").into_response();
        }
        seen.lock().unwrap().rechecks.push(name.clone());
        let recovered = if name == "a b@example.com" {
            json!({ "reason": "quota probe: no longer at its limit", "cleared": ["rateLimitedUntil"] })
        } else {
            Value::Null
        };
        axum::Json(json!({ "ok": true, "account": name, "probe": { "ok": true, "status": 200 },
            "recovered": recovered })).into_response()
    }
    let app = Router::new()
        .route("/maxpool/resets", get(resets))
        .route("/maxpool/resets/redeem", post(redeem))
        .route("/maxpool/accounts/{name}/recheck", post(recheck))
        .with_state((seen.clone(), listing_status));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn a_reset_is_used_and_an_account_read_again_through_the_pool_with_its_key() {
    let (base, seen) = stand_in_pool(StatusCode::OK).await;
    let config = config_at(&base);

    let outcome = redeem_with(&config, "primary", Some("soon")).await.unwrap();
    assert_eq!(outcome, PoolResetOutcome::Reset);
    assert_eq!(
        seen.lock().unwrap().redeems[0],
        json!({ "account": "primary", "grantId": "soon" })
    );

    let refused = redeem_with(&config, "again", None).await.unwrap_err();
    assert_eq!(refused.i18n_key.as_deref(), Some("pool.resets.error.recentlyUsed"));
    assert_eq!(
        refused.i18n_params.as_ref().and_then(|p| p.get("reason")).map(String::as_str),
        Some("recently_claimed")
    );
    assert_eq!(
        seen.lock().unwrap().redeems[1],
        json!({ "account": "again" }),
        "no grant named: the pool picks"
    );
    assert_eq!(
        redeem_with(&config, "slow", None).await.unwrap(),
        PoolResetOutcome::Unconfirmed,
        "the pool's own wait ran out: it may have gone through"
    );

    let (read, lifted) = recheck_with(&config, "a b@example.com").await.unwrap();
    assert!(read && lifted);
    let (read, lifted) = recheck_with(&config, "primary").await.unwrap();
    assert!(read && !lifted);
    assert_eq!(seen.lock().unwrap().rechecks, ["a b@example.com", "primary"]);

    let keyless = PoolConfig { key: None, ..config.clone() };
    assert!(redeem_with(&keyless, "primary", None).await.is_err());
    assert_eq!(seen.lock().unwrap().redeems.len(), 3, "a refused key reached no handler");
}

#[tokio::test]
async fn the_listing_is_read_once_per_version_from_a_pool_without_the_routes() {
    // Each stand-in pool has its own address, so other tests' pools can't
    // touch what is noted for these.
    let (base, seen) = stand_in_pool(StatusCode::OK).await;
    let config = config_at(&base);
    let ResetsRead::Listed(listed) = read_resets(&config, Some("test-patched"), NOW).await else {
        panic!("a pool with the route lists its resets");
    };
    assert_eq!(listed.len(), 3);
    assert!(known_supported(&config.status_url, Some("test-patched")));

    let (old_base, old_seen) = stand_in_pool(StatusCode::NOT_FOUND).await;
    let old = config_at(&old_base);
    assert!(matches!(read_resets(&old, Some("test-old"), NOW).await, ResetsRead::Unsupported));
    assert!(matches!(read_resets(&old, Some("test-old"), NOW).await, ResetsRead::Unsupported));
    assert_eq!(old_seen.lock().unwrap().resets_gets, 1, "an older pool is asked once, not every poll");
    // A new version is asked again.
    let _ = read_resets(&old, Some("test-old-2"), NOW).await;
    assert_eq!(old_seen.lock().unwrap().resets_gets, 2);
    assert_eq!(seen.lock().unwrap().resets_gets, 1);

    // Nothing listening: no answer, nothing decided.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let down = PoolConfig {
        status_url: status_url(Some("127.0.0.1"), Some(closed)),
        ..config
    };
    assert!(matches!(read_resets(&down, Some("test-down"), NOW).await, ResetsRead::Unavailable));
}

#[test]
fn routes_sit_next_to_the_status_endpoint() {
    let config = config_at("http://127.0.0.1:3456");
    assert_eq!(config.route_url("/maxpool/resets"), "http://127.0.0.1:3456/maxpool/resets");
}

// ─── No way of codeg's own to the provider's resets ─────────────────────

/// Every source file of the app (Rust and the frontend), outside tests'
/// fixtures and build output.
fn source_files() -> Vec<std::path::PathBuf> {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    // The repository root (where the frontend's package.json is), wherever
    // the crate sits under it.
    let repo = crate_dir
        .ancestors()
        .find(|dir| dir.join("package.json").is_file())
        .expect("the crate lives in the repository");
    let mut out = Vec::new();
    let mut stack = vec![crate_dir.join("src"), repo.join("src")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !matches!(name.as_str(), "node_modules" | "target" | ".next" | "out" | "snapshots") {
                    stack.push(path);
                }
            } else if name.ends_with(".rs") || name.ends_with(".ts") || name.ends_with(".tsx") {
                out.push(path);
            }
        }
    }
    out
}

#[test]
fn codeg_reads_no_claude_sign_in_and_calls_no_provider_reset_endpoint() {
    // Built from pieces so this file does not match itself.
    let needles = [
        concat!("reset_rate", "_limits"),
        concat!("cedar", "_ember"),
        concat!("/api/oauth/", "usage"),
        concat!("/api/oauth/", "profile"),
        concat!("claudeAi", "Oauth"),
        concat!("Claude Code-", "credentials"),
    ];
    let files = source_files();
    assert!(files.len() > 100, "the sources were found ({})", files.len());
    assert!(
        files.iter().any(|f| f.extension().is_some_and(|e| e == "tsx")),
        "the frontend's sources are scanned too"
    );
    let mut hits = Vec::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for needle in needles {
            if text.contains(needle) {
                hits.push(format!("{} contains {needle}", file.display()));
            }
        }
    }
    assert!(hits.is_empty(), "{hits:#?}");
}
