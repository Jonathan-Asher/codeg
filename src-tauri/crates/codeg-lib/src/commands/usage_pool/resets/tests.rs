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
    let scope = |list: &[&str]| grant_scope(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let refills = |list: &[&str]| scope(list).refills;

    assert_eq!(scope(&["five_hour", "seven_day"]).kind, LimitResetKind::Full);
    assert_eq!(refills(&["five_hour", "seven_day"]), ["five_hour", "seven_day"]);
    assert_eq!(scope(&["seven_day"]).kind, LimitResetKind::Weekly);
    assert_eq!(scope(&["five_hour"]).kind, LimitResetKind::Session);
    assert_eq!(refills(&["five_hour"]), ["five_hour"]);

    // Fable's own weekly limit, and nothing else.
    let fable = scope(&["seven_day_overage_included"]);
    assert_eq!(fable.kind, LimitResetKind::ModelWeekly);
    assert_eq!(fable.model.as_deref(), Some("Fable"));
    assert_eq!(fable.refills, ["seven_day_fable"]);
    // With the general weekly limit it is a weekly reset that refills both.
    let both = scope(&["seven_day", "seven_day_overage_included"]);
    assert_eq!(both.kind, LimitResetKind::Weekly);
    assert_eq!(both.model, None);
    assert_eq!(both.refills, ["seven_day", "seven_day_fable"]);
    assert_eq!(
        scope(&["five_hour", "seven_day", "seven_day_overage_included"]).kind,
        LimitResetKind::Full
    );

    // A window not known here is not guessed at, whatever its name starts
    // with: alone it is an unknown reset that refills nothing named.
    let unknowns: [&[&str]; 4] = [&["seven_day_cowork"], &["seven_day_opus"], &["overage"], &[]];
    for unknown in unknowns {
        let s = scope(unknown);
        assert_eq!(s.kind, LimitResetKind::Other, "{unknown:?}");
        assert!(s.refills.is_empty(), "{unknown:?}");
        assert_eq!(s.model, None);
    }
    assert_eq!(scope(&["seven_day", "seven_day_cowork"]).refills, ["seven_day"]);
}

/// The pool's listing of an account holding the three Fable resets of the
/// November launch, as `GET /maxpool/resets` sent it (account name
/// changed): each clears only `seven_day_overage_included`, and the pool's
/// `appliesTo` also names `general` because `givesBackWeekly` is set.
fn fable_launch_listing() -> Value {
    let grant = |id: &str, label: &str| {
        json!({
            "id": id, "label": label, "resetsLeft": 1, "resetsTotal": 1,
            "startsAt": 1_794_247_200_000_i64, "endsAt": 1_804_579_140_000_i64,
            "clears": ["seven_day_overage_included"], "appliesTo": ["fable", "general"],
            "givesBackWeekly": true, "usableNow": true, "paused": false, "requiresLimit": false,
            "blocking": false, "unavailableReason": null, "expired": false
        })
    };
    json!({
        "ok": true,
        "generatedAt": ms(NOW),
        "autoRedeem": { "enabled": true, "wouldAct": false },
        "accounts": [
            { "name": "launch@example.com", "enabled": true, "provider": "anthropic", "type": "oauth",
              "grants": [
                  grant("launch-2610-fable", "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium"),
                  grant("launch-2610-fable-12mo", "New model launch: one more Fable reset at 12 months' tenure"),
                  grant("launch-2610-fable-6mo", "New model launch: one more Fable reset at 6 months' tenure"),
              ],
              "nextGrantId": "launch-2610-fable", "cooldownUntil": null, "eligible": true,
              "checkedAt": ms(NOW - 60), "stale": false, "lastError": null, "lastClaimAt": null,
              "resetSettling": false,
              "autoRedeem": { "wouldAct": false, "grantId": null, "scope": null, "reason": "below wall" } },
            { "name": "spent@example.com", "enabled": true, "provider": "anthropic", "type": "oauth",
              "grants": [], "nextGrantId": null, "cooldownUntil": null, "eligible": true,
              "autoRedeem": { "wouldAct": false, "reason": "no grant held" } }
        ]
    })
}

#[test]
fn a_fable_reset_refills_only_fables_weekly_limit_whatever_the_pool_applies_it_to() {
    let listed = parse_resets(fable_launch_listing().to_string().as_bytes(), NOW).unwrap();
    let launch = &listed[0].1;
    assert_eq!(launch.available, 3);
    assert_eq!(launch.next_grant_id.as_deref(), Some("launch-2610-fable"));
    for grant in &launch.grants {
        assert_eq!(grant.kind, LimitResetKind::ModelWeekly, "{}", grant.id);
        assert_eq!(grant.model.as_deref(), Some("Fable"));
        assert_eq!(grant.refills, ["seven_day_fable"], "never the general weekly");
        assert!(grant.gives_back_weekly);
        assert!(grant.usable_now && !grant.requires_limit);
        assert_eq!(grant.count, 1);
        assert_eq!(grant.expires_at, Some(1_804_579_140));
    }
    assert_eq!(
        launch.grants[0].label.as_deref(),
        Some("New model launch: one Fable reset for Max, Team Premium and Enterprise Premium"),
        "the provider's name is kept whole"
    );
    assert!(listed[1].1.grants.is_empty());

    let json = serde_json::to_value(&launch.grants[0]).unwrap();
    assert_eq!(json["kind"], "model_weekly");
    assert_eq!(json["model"], "Fable");
    assert_eq!(json["refills"], json!(["seven_day_fable"]));
    assert_eq!(json["gives_back_weekly"], true);
}

/// A status in which `walled` has spent its general weekly limit (the pool
/// still lets it serve), `fable-walled` its Fable one, `busy` is past the
/// switch threshold of its 5-hour window, `rolled` spent a weekly window
/// that has since reset, and `free` has headroom everywhere.
fn status_at_limits() -> RawStatus {
    let account = |name: &str, quota: Value| {
        json!({ "name": name, "enabled": true, "status": "active", "type": "oauth", "quota": quota,
                "weekly": { "state": "normal", "rawState": "normal" } })
    };
    let fable = |utilization: f64, active: bool| {
        json!({ "fable": { "utilization": utilization, "resetAt": ms(NOW + 2 * DAY), "severity": "normal",
                           "isActive": active } })
    };
    serde_json::from_value(json!({
        "runningVersion": "1.24.90",
        "switchThreshold": 0.9,
        "accounts": [
            account("walled", json!({ "unified5h": 0.1, "unified5hReset": ms(NOW + 3600),
                "unified7d": 1.0, "unified7dReset": ms(NOW + 3 * DAY), "unifiedStatus": "allowed_warning",
                "scopedWeekly": fable(0.0, false) })),
            account("fable-walled", json!({ "unified5h": 0.1, "unified5hReset": ms(NOW + 3600),
                "unified7d": 0.4, "unified7dReset": ms(NOW + 3 * DAY), "unifiedStatus": "allowed",
                "scopedWeekly": fable(1.0, true) })),
            account("busy", json!({ "unified5h": 0.95, "unified5hReset": ms(NOW + 3600),
                "unified7d": 0.4, "unified7dReset": ms(NOW + 3 * DAY), "unifiedStatus": "allowed" })),
            account("rolled", json!({ "unified5h": 0.1, "unified5hReset": ms(NOW + 3600),
                "unified7d": 1.0, "unified7dReset": ms(NOW - 60), "unifiedStatus": "allowed" })),
            account("free", json!({ "unified5h": 0.1, "unified5hReset": ms(NOW + 3600),
                "unified7d": 0.4, "unified7dReset": ms(NOW + 3 * DAY), "unifiedStatus": "allowed",
                "scopedWeekly": fable(0.3, true) })),
        ]
    }))
    .unwrap()
}

#[test]
fn each_accounts_reached_limits_come_with_its_resets_from_the_new_reading() {
    let names = ["walled", "fable-walled", "busy", "rolled", "free"];
    let accounts: Vec<Value> = names
        .iter()
        .map(|name| json!({ "name": name, "enabled": true, "provider": "anthropic", "type": "oauth",
            "grants": [{ "id": "g", "resetsLeft": 1, "endsAt": ms(NOW + 9 * DAY),
                         "clears": ["seven_day_overage_included"], "usableNow": true }] }))
        .collect();
    let body = json!({ "ok": true, "accounts": accounts }).to_string();
    let config = config_at("http://127.0.0.1:9");
    let mut pool = build_pool(status_at_limits(), &config, NOW);
    attach(&mut pool, ResetsRead::Listed(parse_resets(body.as_bytes(), NOW).unwrap()), None);
    let reached = |name: &str| {
        pool.accounts
            .iter()
            .find(|a| a.name == name)
            .and_then(|a| a.resets.as_ref())
            .map(|r| r.limits_reached.clone())
            .unwrap()
    };
    assert_eq!(reached("walled"), ["seven_day"], "the general weekly is spent");
    assert_eq!(reached("fable-walled"), ["seven_day_fable"], "only Fable's own");
    assert_eq!(reached("busy"), ["five_hour"]);
    assert!(reached("rolled").is_empty(), "a window that reset holds nothing");
    assert!(reached("free").is_empty());
    let json = serde_json::to_value(&pool).unwrap();
    assert_eq!(json["accounts"][0]["resets"]["limits_reached"], json!(["seven_day"]));

    // A later reading the pool's listing didn't answer: the resets stay,
    // what is reached is read again.
    let mut later = build_pool(status_with(&["walled"]), &config, NOW + 60);
    attach(&mut later, ResetsRead::Unavailable, Some(&pool));
    let resets = later.accounts[0].resets.as_ref().unwrap();
    assert_eq!(resets.grants.len(), 1);
    assert!(resets.limits_reached.is_empty(), "this reading has it at half its week");
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
