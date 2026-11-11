//! Reset listings from both providers' answers (shapes captured from live
//! reads), the use flow's outcome and error mapping, the request shapes
//! against a mock Anthropic server, and Codex's app-server protocol against
//! a scripted server on an in-memory pipe. Nothing here reaches a provider.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::claude::{self, ClaudeApi, HttpFailure, StoredLogin};
use super::codex::{self, AppServer, RpcError};
use super::*;
use crate::commands::plan_usage::{PlanUsageSource, PlanUsageWindowKind};

/// 2026-11-12T18:00:00Z.
const NOW: i64 = 1_794_506_400;

// ─── Claude: reading grants ─────────────────────────────────────────────

/// A usage read as the interactive CLI gets it (2026-11-11, Max 20x),
/// trimmed to the reset block and one window.
fn claude_eligible_body() -> Value {
    json!({
        "five_hour": null,
        "seven_day": { "utilization": 88.0, "resets_at": "2026-11-13T18:59:59.638559+00:00" },
        "cedar_ember": {
            "eligible": true,
            "ineligible_reason": null,
            "at_limit": false,
            "exhausted": [],
            "grants": [
                {
                    "id": "launch-2610-fable",
                    "label": "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
                    "resets_total": 1,
                    "resets_left": 1,
                    "starts_at": "2026-11-09T18:00:00+00:00",
                    "ends_at": "2027-03-09T07:59:00+00:00",
                    "clears": ["seven_day_overage_included"],
                    "paused": false,
                    "usable_now": true,
                    "use_requires_limit": false,
                    "percent_used": { "seven_day_overage_included": 0, "seven_day": 88 },
                    "blocking": [],
                    "arm": null,
                    "type": "full",
                    "unavailable_reason": null,
                    "gives_back_weekly": true
                },
                {
                    "id": "full-reset-2611",
                    "label": "One full limit reset (November 2026)",
                    "resets_total": 1,
                    "resets_left": 1,
                    "starts_at": "2026-11-10T21:30:00+00:00",
                    "ends_at": "2026-12-10T22:00:00+00:00",
                    "clears": ["seven_day", "seven_day_overage_included"],
                    "paused": false,
                    "usable_now": true,
                    "use_requires_limit": false,
                    "percent_used": { "seven_day": 88, "seven_day_overage_included": 0 },
                    "blocking": [],
                    "arm": null,
                    "type": "weekly",
                    "unavailable_reason": null,
                    "gives_back_weekly": false
                }
            ],
            "next_grant_id": "full-reset-2611",
            "weekly_resets_at": "2026-11-13T19:00:00+00:00",
            "cooldown_until": null,
            "event_props": { "surface": "claude_code_cli", "tier": "claude_max_20x" }
        },
        "juniper_tide": null
    })
}

/// The same account read with the Agent SDK's User-Agent.
fn claude_surface_body() -> Value {
    json!({
        "seven_day": { "utilization": 88.0, "resets_at": "2026-11-13T19:00:00.244170+00:00" },
        "cedar_ember": {
            "eligible": false,
            "ineligible_reason": "surface",
            "at_limit": false,
            "exhausted": [],
            "grants": [],
            "next_grant_id": null,
            "weekly_resets_at": null,
            "cooldown_until": null,
            "event_props": null
        },
        "juniper_tide": null
    })
}

fn rfc3339(text: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp()
}

#[test]
fn claude_grants_parse_from_the_live_shape() {
    let resets = claude::parse_resets(&claude_eligible_body(), NOW).expect("reset block");
    assert!(resets.eligible);
    assert!(!resets.at_limit);
    assert_eq!(resets.available(), 2);
    // Soonest to expire first.
    let ids: Vec<_> = resets
        .items
        .iter()
        .map(|i| i.id.as_deref().unwrap())
        .collect();
    assert_eq!(ids, ["full-reset-2611", "launch-2610-fable"]);

    let weekly = &resets.items[0];
    assert_eq!(weekly.kind, LimitResetKind::Weekly);
    assert_eq!(
        weekly.label.as_deref(),
        Some("One full limit reset (November 2026)")
    );
    assert_eq!(weekly.count, 1);
    assert_eq!(
        weekly.expires_at,
        Some(rfc3339("2026-12-10T22:00:00+00:00"))
    );
    assert!(weekly.usable_now);
    assert!(!weekly.requires_limit);
    assert_eq!(weekly.clears, ["seven_day", "seven_day_overage_included"]);
    assert_eq!(weekly.unavailable_reason, None);

    assert_eq!(resets.items[1].kind, LimitResetKind::Fable);
    assert_eq!(resets.next_grant_id.as_deref(), Some("full-reset-2611"));
    assert_eq!(
        resets.default_grant().and_then(|g| g.id.as_deref()),
        Some("full-reset-2611")
    );
}

#[test]
fn claude_sdk_surface_answer_lists_nothing_and_says_why() {
    let resets = claude::parse_resets(&claude_surface_body(), NOW);
    let listing = claude_listing(resets.as_ref(), Some("me@example.com".into()), NOW);
    assert_eq!(listing.available, 0);
    assert!(listing.items.is_empty());
    assert_eq!(listing.account.as_deref(), Some("me@example.com"));
    let error = listing.error.expect("an explanation");
    assert_eq!(error.code, LimitResetErrorCode::NotEligible);
    assert_eq!(error.reason.as_deref(), Some("surface"));
}

#[test]
fn claude_ineligible_reasons_map_to_errors_or_to_nothing() {
    assert!(claude::ineligible_error(Some("no_grant")).is_ok());
    assert!(claude::ineligible_error(Some("config_off")).is_ok());
    let version = claude::ineligible_error(Some("cli_version")).unwrap_err();
    assert_eq!(version.code, LimitResetErrorCode::UnsupportedVersion);
    let tier = claude::ineligible_error(Some("tier")).unwrap_err();
    assert_eq!(tier.code, LimitResetErrorCode::NotEligible);
    assert_eq!(tier.reason.as_deref(), Some("tier"));
    let unknown = claude::ineligible_error(None).unwrap_err();
    assert_eq!(unknown.code, LimitResetErrorCode::NotEligible);
    assert_eq!(unknown.reason, None);

    let no_grant = json!({ "cedar_ember": { "eligible": false, "ineligible_reason": "no_grant" } });
    let listing = claude_listing(claude::parse_resets(&no_grant, NOW).as_ref(), None, NOW);
    assert_eq!(listing.error, None);
    assert_eq!(listing.available, 0);
}

#[test]
fn claude_read_without_a_reset_block_lists_nothing() {
    let body = json!({ "seven_day": { "utilization": 10.0 } });
    assert!(claude::parse_resets(&body, NOW).is_none());
    let listing = claude_listing(None, None, NOW);
    assert_eq!(listing.available, 0);
    assert_eq!(listing.error, None);
    assert_eq!(listing.source, LimitResetSource::ClaudeOauth);
}

#[test]
fn claude_grants_skip_malformed_spent_and_expired_ones() {
    let body = json!({ "cedar_ember": { "eligible": true, "grants": [
        { "id": "Bad Id", "resets_left": 1, "usable_now": true },
        { "id": "spent", "resets_left": 0, "usable_now": true },
        { "id": "over", "resets_left": 1, "ends_at": "2026-11-01T00:00:00Z", "usable_now": true },
        { "id": "paused", "resets_left": 2, "paused": true, "usable_now": true },
        { "id": "later", "resets_left": 1, "starts_at": "2026-12-01T00:00:00Z", "usable_now": true },
        { "id": "blocked", "resets_left": 1, "usable_now": false, "unavailable_reason": "needs_limit" },
        { "id": "saved", "resets_left": 1, "usable_now": true, "clears": ["five_hour", "made_up"] }
    ] } });
    let resets = claude::parse_resets(&body, NOW).unwrap();
    let ids: Vec<_> = resets.items.iter().map(|i| i.id.clone().unwrap()).collect();
    assert_eq!(ids, ["paused", "later", "blocked", "saved"]);
    let by_id = |id: &str| resets.find(id).unwrap();
    assert!(!by_id("paused").usable_now);
    assert_eq!(
        by_id("paused").unavailable_reason.as_deref(),
        Some("paused")
    );
    assert_eq!(
        by_id("later").unavailable_reason.as_deref(),
        Some("not_started")
    );
    assert_eq!(
        by_id("blocked").unavailable_reason.as_deref(),
        Some("needs_limit")
    );
    assert!(by_id("saved").usable_now);
    // An unknown window id is dropped; `use_requires_limit` defaults to true.
    assert_eq!(by_id("saved").clears, ["five_hour"]);
    assert!(by_id("saved").requires_limit);
    assert_eq!(by_id("saved").kind, LimitResetKind::Session);
    // Every reset still in date counts, usable now or not.
    assert_eq!(resets.available(), 5);
}

#[test]
fn claude_grant_kinds_come_from_type_label_or_windows() {
    let kind = |grant: Value| {
        let clears: Vec<String> = grant
            .get("clears")
            .and_then(Value::as_array)
            .map(|l| l.iter().map(|v| v.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        claude::grant_kind(&grant, &clears)
    };
    assert_eq!(kind(json!({ "type": "session" })), LimitResetKind::Session);
    assert_eq!(kind(json!({ "type": "weekly" })), LimitResetKind::Weekly);
    assert_eq!(kind(json!({ "type": "full" })), LimitResetKind::Full);
    assert_eq!(
        kind(json!({ "type": "full", "label": "One Fable reset" })),
        LimitResetKind::Fable
    );
    assert_eq!(
        kind(json!({ "clears": ["five_hour", "seven_day"] })),
        LimitResetKind::Full
    );
    assert_eq!(
        kind(json!({ "clears": ["seven_day_opus"] })),
        LimitResetKind::Weekly
    );
    assert_eq!(kind(json!({})), LimitResetKind::Other);
}

#[test]
fn claude_chooses_the_requested_or_the_next_usable_grant() {
    let resets = claude::parse_resets(&claude_eligible_body(), NOW).unwrap();
    assert_eq!(
        choose_claude_grant(&resets, Some("launch-2610-fable")),
        Ok("launch-2610-fable".to_string())
    );
    assert_eq!(
        choose_claude_grant(&resets, None),
        Ok("full-reset-2611".to_string())
    );
    assert_eq!(
        choose_claude_grant(&resets, Some("gone")),
        Err(LimitResetOutcome::NoReset)
    );

    // Saved for a limit while none is reached: nothing to reset.
    let saved = json!({ "cedar_ember": { "eligible": true, "at_limit": false,
        "next_grant_id": "saved",
        "grants": [{ "id": "saved", "resets_left": 1, "usable_now": false, "use_requires_limit": true }] } });
    let saved = claude::parse_resets(&saved, NOW).unwrap();
    assert_eq!(
        choose_claude_grant(&saved, None),
        Err(LimitResetOutcome::NothingToReset)
    );

    // The server's next grant is paused: the first usable one is taken.
    let next_paused = json!({ "cedar_ember": { "eligible": true, "next_grant_id": "first",
        "grants": [
            { "id": "first", "resets_left": 1, "usable_now": true, "paused": true, "ends_at": "2026-11-20T00:00:00Z" },
            { "id": "second", "resets_left": 1, "usable_now": true, "ends_at": "2026-11-25T00:00:00Z" }
        ] } });
    let next_paused = claude::parse_resets(&next_paused, NOW).unwrap();
    assert_eq!(
        choose_claude_grant(&next_paused, None),
        Ok("second".to_string())
    );
}

#[test]
fn claude_claim_answers_map_to_outcomes() {
    let reset = claude::parse_claim(&json!({
        "result": "reset", "resets_left": 0,
        "cleared": ["seven_day", "seven_day_overage_included", "mystery"],
        "weekly_resets_at": "2026-11-13T19:00:00+00:00"
    }));
    assert_eq!(reset.outcome, LimitResetOutcome::Reset);
    assert_eq!(reset.cleared, ["seven_day", "seven_day_overage_included"]);
    assert_eq!(reset.resets_left, Some(0));

    let outcome = |result: &str| claude::parse_claim(&json!({ "result": result })).outcome;
    assert_eq!(outcome("already_used"), LimitResetOutcome::AlreadyUsed);
    assert_eq!(outcome("not_limited"), LimitResetOutcome::NothingToReset);
    assert_eq!(outcome("cooldown"), LimitResetOutcome::Cooldown);
    assert_eq!(outcome("ineligible"), LimitResetOutcome::NoReset);
    assert_eq!(outcome("unavailable"), LimitResetOutcome::Unconfirmed);
    assert_eq!(outcome("something_new"), LimitResetOutcome::Unconfirmed);
    assert_eq!(
        claude::parse_claim(&json!("not an object")).outcome,
        LimitResetOutcome::Unconfirmed
    );
}

#[test]
fn claude_claims_without_an_answer_are_refused_or_unconfirmed() {
    let refused = |status| {
        claude::claim_failure(&HttpFailure::Status(status))
            .unwrap_err()
            .code
    };
    assert_eq!(refused(401), LimitResetErrorCode::LoginExpired);
    assert_eq!(refused(403), LimitResetErrorCode::NotLoggedIn);
    assert_eq!(refused(429), LimitResetErrorCode::Network);
    for failure in [
        HttpFailure::Status(500),
        HttpFailure::Status(502),
        HttpFailure::Network("connection reset".into()),
        HttpFailure::Unreadable,
    ] {
        assert_eq!(
            claude::claim_failure(&failure),
            Ok(LimitResetOutcome::Unconfirmed),
            "{failure:?}"
        );
    }
    assert_eq!(
        claude::error_for_failure(&HttpFailure::Network("dns".into())).code,
        LimitResetErrorCode::Network
    );
    assert_eq!(
        claude::error_for_failure(&HttpFailure::Unreadable).code,
        LimitResetErrorCode::Failed
    );
}

// ─── Claude: the stored login ───────────────────────────────────────────

#[test]
fn claude_keychain_item_is_named_like_the_cli_names_it() {
    assert_eq!(
        claude::keychain_service(None, false, Some("/Users/someone/.claude")),
        "Claude Code-credentials"
    );
    assert_eq!(
        claude::keychain_service(None, true, Some("/Users/someone/.claude-work")),
        "Claude Code-credentials-18cc900a"
    );
    assert_eq!(
        claude::keychain_service(
            Some("/tmp/secure"),
            true,
            Some("/Users/someone/.claude-work")
        ),
        "Claude Code-credentials-7f494bd1"
    );
    // Set but empty: the plain item.
    assert_eq!(
        claude::keychain_service(Some(""), true, Some("/Users/someone/.claude-work")),
        "Claude Code-credentials"
    );
}

#[test]
fn claude_keychain_account_falls_back_like_the_cli() {
    assert_eq!(
        claude::keychain_account(Some("johnny.s_1-x")),
        "johnny.s_1-x"
    );
    assert_eq!(
        claude::keychain_account(Some("has space")),
        "claude-code-user"
    );
    assert_eq!(claude::keychain_account(Some("")), "claude-code-user");
    assert_eq!(claude::keychain_account(None), "claude-code-user");
}

#[test]
fn claude_stored_login_is_read_without_ever_showing_the_token() {
    let doc = json!({
        "claudeAiOauth": {
            "accessToken": "sk-ant-oat01-SECRET",
            "refreshToken": "sk-ant-ort01-SECRET",
            "expiresAt": 1_794_510_000_000_i64,
            "scopes": ["user:inference", "user:profile"],
            "subscriptionType": "max"
        },
        "mcpOAuth": {}
    });
    let login = claude::parse_stored_login(&doc.to_string()).expect("login");
    assert_eq!(login.expires_at, Some(1_794_510_000));
    assert!(login.can_read_usage());
    assert!(!login.is_expired(NOW));
    assert!(login.is_expired(1_794_510_000 - 30));
    let shown = format!("{login:?}");
    assert!(!shown.contains("SECRET"), "{shown}");

    assert!(claude::parse_stored_login("{}").is_none());
    assert!(claude::parse_stored_login(r#"{"claudeAiOauth":{"accessToken":"  "}}"#).is_none());
    assert!(claude::parse_stored_login("not json").is_none());
    let inference_only = claude::parse_stored_login(
        r#"{"claudeAiOauth":{"accessToken":"t","scopes":["user:inference"]}}"#,
    )
    .unwrap();
    assert!(!inference_only.can_read_usage());
    assert!(!inference_only.is_expired(NOW));
}

#[test]
fn claude_version_and_user_agent() {
    assert_eq!(
        claude::parse_cli_version("2.1.303 (Claude Code)\n").as_deref(),
        Some("2.1.303")
    );
    assert_eq!(claude::parse_cli_version("Claude Code"), None);
    assert_eq!(
        claude::user_agent("2.1.303"),
        "claude-cli/2.1.303 (external, sdk-ts, client-app/codeg)"
    );
}

// ─── Claude: the two calls, against a mock server ───────────────────────

#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Value,
}

#[derive(Clone, Default)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
    script: Arc<Mutex<VecDeque<(StatusCode, Value)>>>,
}

async fn answer(
    State(mock): State<Mock>,
    method: Method,
    uri: Uri,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: String,
) -> Response {
    mock.seen.lock().unwrap().push(Seen {
        method,
        path: uri.path().to_string(),
        query,
        headers,
        body: serde_json::from_str(&body).unwrap_or(Value::Null),
    });
    let (status, body) = mock
        .script
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or((StatusCode::INTERNAL_SERVER_ERROR, json!({})));
    if status.is_redirection() {
        return (
            status,
            [("location", "https://elsewhere.example/steal")],
            "",
        )
            .into_response();
    }
    (
        status,
        [("content-type", "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn mock_anthropic(script: Vec<(StatusCode, Value)>) -> (String, Mock) {
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

fn header<'a>(seen: &'a Seen, name: &str) -> &'a str {
    seen.headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
}

#[tokio::test]
async fn claude_calls_carry_the_clis_headers_and_body() {
    let (base, mock) = mock_anthropic(vec![
        (StatusCode::OK, claude_eligible_body()),
        (
            StatusCode::OK,
            json!({ "result": "reset", "resets_left": 0, "cleared": ["seven_day"] }),
        ),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let login = StoredLogin::for_test("tok-123", Some(NOW + 3600));
    let agent = claude::user_agent("2.1.303");

    let body = api.usage(&login, &agent).await.expect("usage");
    assert!(claude::parse_resets(&body, NOW).unwrap().eligible);
    let claim = api
        .claim(&login, &agent, "org-uuid-1", "full-reset-2611", "req-1")
        .await
        .expect("claim");
    assert_eq!(
        claude::parse_claim(&claim).outcome,
        LimitResetOutcome::Reset
    );

    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    let read = &seen[0];
    assert_eq!(read.method, Method::GET);
    assert_eq!(read.path, "/api/oauth/usage");
    assert_eq!(read.query.as_deref(), Some("cedar_ember=1&skip_spend=1"));
    let used = &seen[1];
    assert_eq!(used.method, Method::POST);
    assert_eq!(used.path, "/api/organizations/org-uuid-1/reset_rate_limits");
    assert_eq!(
        used.body,
        json!({ "program": "cedar_ember", "grant_id": "full-reset-2611", "request_id": "req-1" })
    );
    for request in &seen {
        assert_eq!(header(request, "authorization"), "Bearer tok-123");
        assert_eq!(header(request, "anthropic-beta"), "oauth-2025-04-20");
        assert_eq!(header(request, "user-agent"), agent);
        assert_eq!(header(request, "content-type"), "application/json");
    }
}

#[tokio::test]
async fn claude_calls_report_refusals_and_never_follow_a_redirect() {
    let (base, mock) = mock_anthropic(vec![
        (
            StatusCode::UNAUTHORIZED,
            json!({ "error": { "type": "authentication_error" } }),
        ),
        (StatusCode::FOUND, json!({})),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let login = StoredLogin::for_test("tok", None);
    assert_eq!(
        api.usage(&login, "ua").await.unwrap_err(),
        HttpFailure::Status(401)
    );
    assert_eq!(
        api.claim(&login, "ua", "org", "grant", "req")
            .await
            .unwrap_err(),
        HttpFailure::Status(302)
    );
    // The redirect target was never asked.
    assert_eq!(mock.seen.lock().unwrap().len(), 2);
}

// ─── Codex: reading credits ─────────────────────────────────────────────

/// An `account/rateLimits/read` answer as Codex 0.156 gave it (2026-11-11,
/// ChatGPT Pro Lite).
fn codex_read_result() -> Value {
    json!({
        "ordinaryUsageAllowed": true,
        "rateLimits": {
            "limitId": "codex",
            "limitName": null,
            "primary": { "usedPercent": 5, "windowDurationMins": 10080, "resetsAt": 1_794_985_215 },
            "secondary": null,
            "credits": null,
            "planType": "prolite",
            "rateLimitReachedType": null
        },
        "rateLimitsByLimitId": { "codex": {} },
        "rateLimitResetCredits": {
            "availableCount": 2,
            "credits": [
                {
                    "id": "RateLimitResetCredit_912825d28b6c81919ec824f94309ef74",
                    "resetType": "codexRateLimits",
                    "status": "available",
                    "grantedAt": 1_793_573_330,
                    "expiresAt": 1_796_165_330,
                    "title": "Full reset",
                    "description": "Thanks for using Codex! You've been granted one free rate limit reset."
                },
                {
                    "id": "RateLimitResetCredit_97204d3755cc8191802afd10f3057a26",
                    "resetType": "codexRateLimits",
                    "status": "available",
                    "grantedAt": 1_793_478_038,
                    "expiresAt": 1_796_070_038,
                    "title": "Full reset",
                    "description": "Thanks for using Codex! You've been granted one free rate limit reset."
                }
            ]
        },
        "accountId": null,
        "rateLimitUpsell": null
    })
}

#[test]
fn codex_credits_parse_from_the_live_shape() {
    let reading = codex::parse_reading(&codex_read_result(), NOW);
    assert_eq!(reading.available, 2);
    assert_eq!(reading.items.len(), 2);
    // Soonest to expire first.
    assert_eq!(
        reading.items[0].id.as_deref(),
        Some("RateLimitResetCredit_97204d3755cc8191802afd10f3057a26")
    );
    assert_eq!(reading.items[0].expires_at, Some(1_796_070_038));
    for item in &reading.items {
        assert_eq!(item.kind, LimitResetKind::Full);
        assert_eq!(item.label.as_deref(), Some("Full reset"));
        assert!(item.description.as_deref().unwrap().starts_with("Thanks"));
        assert_eq!(item.count, 1);
        assert!(item.usable_now);
        assert!(!item.requires_limit);
    }

    let snapshot = reading.snapshot.clone().expect("windows");
    assert_eq!(snapshot.source, PlanUsageSource::Live);
    assert_eq!(snapshot.plan_label.as_deref(), Some("Pro Lite"));
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].kind, PlanUsageWindowKind::Weekly);
    assert_eq!(snapshot.windows[0].label, "7d");
    assert_eq!(snapshot.windows[0].used_percent, 5.0);
    assert_eq!(snapshot.windows[0].resets_at, Some(1_794_985_215));
    assert_eq!(snapshot.observed_at, NOW);

    let listing = codex_listing(Some("me@example.com".into()), &reading, NOW);
    assert_eq!(listing.source, LimitResetSource::CodexAppServer);
    assert_eq!(listing.available, 2);
    assert_eq!(listing.account.as_deref(), Some("me@example.com"));
}

#[test]
fn codex_count_without_details_becomes_one_item_the_backend_picks_from() {
    let (available, items) =
        codex::parse_credits(Some(&json!({ "availableCount": 3, "credits": null })), NOW);
    assert_eq!(available, 3);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, None);
    assert_eq!(items[0].count, 3);
    assert_eq!(items[0].kind, LimitResetKind::Full);

    let (none, empty) =
        codex::parse_credits(Some(&json!({ "availableCount": 0, "credits": null })), NOW);
    assert_eq!((none, empty.len()), (0, 0));
    let (none, empty) = codex::parse_credits(None, NOW);
    assert_eq!((none, empty.len()), (0, 0));
    let (none, empty) = codex::parse_credits(Some(&Value::Null), NOW);
    assert_eq!((none, empty.len()), (0, 0));
}

#[test]
fn codex_skips_used_and_expired_credits() {
    let summary = json!({ "availableCount": 1, "credits": [
        { "id": "a", "resetType": "codexRateLimits", "status": "redeemed", "expiresAt": null },
        { "id": "b", "resetType": "codexRateLimits", "status": "redeeming", "expiresAt": null },
        { "id": "c", "resetType": "codexRateLimits", "status": "available", "expiresAt": NOW - 1 },
        { "id": "d", "resetType": "somethingElse", "status": "available", "expiresAt": null },
        { "id": "e", "resetType": "codexRateLimits", "status": "available", "expiresAt": null }
    ] });
    let (available, items) = codex::parse_credits(Some(&summary), NOW);
    let ids: Vec<_> = items.iter().map(|i| i.id.clone().unwrap()).collect();
    assert_eq!(ids, ["d", "e"]);
    assert_eq!(items[0].kind, LimitResetKind::Other);
    // The count never says less than the list shows.
    assert_eq!(available, 2);
}

#[test]
fn codex_account_must_be_a_chatgpt_sign_in() {
    let signed_out =
        codex::parse_account(&json!({ "account": null, "requiresOpenaiAuth": true })).unwrap_err();
    assert_eq!(signed_out.code, LimitResetErrorCode::NotLoggedIn);
    let api_key = codex::parse_account(&json!({ "account": { "type": "apiKey" } })).unwrap_err();
    assert_eq!(api_key.code, LimitResetErrorCode::NotEligible);
    assert_eq!(api_key.reason.as_deref(), Some("apiKey"));
    let chatgpt = codex::parse_account(
        &json!({ "account": { "type": "chatgpt", "email": "me@example.com", "planType": "prolite" } }),
    )
    .unwrap();
    assert_eq!(chatgpt.email.as_deref(), Some("me@example.com"));
}

#[test]
fn codex_outcomes_and_failures_map_like_the_tui_reads_them() {
    let outcome = |o: &str| codex::parse_outcome(&json!({ "outcome": o }));
    assert_eq!(outcome("reset"), Some(LimitResetOutcome::Reset));
    assert_eq!(
        outcome("nothingToReset"),
        Some(LimitResetOutcome::NothingToReset)
    );
    assert_eq!(outcome("noCredit"), Some(LimitResetOutcome::NoReset));
    assert_eq!(
        outcome("alreadyRedeemed"),
        Some(LimitResetOutcome::AlreadyUsed)
    );
    assert_eq!(outcome("later"), None);

    let server = |code: i64, message: &str| RpcError::Server {
        code,
        message: message.to_string(),
    };
    // Refused before it reached the backend: a plain failure.
    let auth = codex::consume_failure(&server(
        -32600,
        "chatgpt authentication required for rate limit reset credits",
    ))
    .unwrap_err();
    assert_eq!(auth.code, LimitResetErrorCode::NotLoggedIn);
    let old = codex::consume_failure(&server(-32601, "method not found")).unwrap_err();
    assert_eq!(old.code, LimitResetErrorCode::UnsupportedVersion);
    // After that, it may have gone through.
    for error in [
        server(-32603, "rate limit reset consume timed out"),
        server(
            -32603,
            "failed to consume rate limit reset: 502 Bad Gateway",
        ),
        RpcError::Timeout,
        RpcError::Closed,
        RpcError::Io("broken pipe".into()),
    ] {
        assert_eq!(
            codex::consume_failure(&error),
            Ok(LimitResetOutcome::Unconfirmed),
            "{error:?}"
        );
    }

    assert_eq!(
        codex::error_from_rpc(&server(-32603, "error sending request for url")).code,
        LimitResetErrorCode::Network
    );
    assert_eq!(
        codex::error_from_rpc(&server(-32603, "usage endpoint returned 500")).code,
        LimitResetErrorCode::Failed
    );
    assert_eq!(
        codex::error_from_rpc(&RpcError::Timeout).code,
        LimitResetErrorCode::Network
    );
}

// ─── Codex: the app-server protocol, on an in-memory pipe ───────────────

/// One step of a scripted app-server: the method it expects next, a check
/// on its params, and what it sends back (`None`: no answer at all).
struct Step {
    method: &'static str,
    check: Box<dyn Fn(&Value) + Send>,
    reply: Option<Value>,
    /// Lines sent before the answer: notifications, server requests.
    before: Vec<Value>,
}

fn step(method: &'static str, reply: Value) -> Step {
    Step {
        method,
        check: Box::new(|_| {}),
        reply: Some(reply),
        before: Vec::new(),
    }
}

/// A fake app-server on one end of a duplex pipe. Returns the client end
/// and the lines the client sent that were not requests (notifications,
/// replies to the server's own requests).
fn fake_app_server(
    script: Vec<Step>,
) -> (
    AppServer<
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    >,
    Arc<Mutex<Vec<Value>>>,
) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (server_read, mut server_write) = tokio::io::split(server);
    let other = Arc::new(Mutex::new(Vec::new()));
    let other_seen = other.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let mut script: VecDeque<Step> = script.into();
        while let Ok(Some(line)) = lines.next_line().await {
            let message: Value = serde_json::from_str(&line).unwrap();
            let is_request = message.get("method").is_some() && message.get("id").is_some();
            if !is_request {
                other_seen.lock().unwrap().push(message);
                continue;
            }
            let Some(next) = script.pop_front() else {
                break;
            };
            assert_eq!(
                message["method"], next.method,
                "unexpected request {message}"
            );
            (next.check)(message.get("params").unwrap_or(&Value::Null));
            for line in next.before {
                let mut bytes = line.to_string().into_bytes();
                bytes.push(b'\n');
                server_write.write_all(&bytes).await.unwrap();
            }
            if let Some(reply) = next.reply {
                let mut answer = reply;
                answer["id"] = message["id"].clone();
                let mut bytes = answer.to_string().into_bytes();
                bytes.push(b'\n');
                server_write.write_all(&bytes).await.unwrap();
            }
        }
    });
    let (client_read, client_write) = tokio::io::split(client);
    (AppServer::new(client_read, client_write), other)
}

fn ok(result: Value) -> Value {
    json!({ "result": result })
}

fn initialize_step() -> Step {
    Step {
        method: "initialize",
        check: Box::new(|params| {
            assert_eq!(params["clientInfo"]["name"], "codeg");
            assert!(params["capabilities"].is_null());
        }),
        reply: Some(ok(
            json!({ "userAgent": "codeg/0.156.1", "codexHome": "/tmp/codex" }),
        )),
        before: Vec::new(),
    }
}

fn chatgpt_account() -> Value {
    ok(
        json!({ "account": { "type": "chatgpt", "email": "me@example.com", "planType": "prolite" } }),
    )
}

#[tokio::test]
async fn codex_reads_credits_over_the_app_server() {
    let (mut server, other) = fake_app_server(vec![
        initialize_step(),
        Step {
            method: "account/read",
            check: Box::new(|params| assert_eq!(params["refreshToken"], false)),
            reply: Some(chatgpt_account()),
            before: vec![
                json!({ "method": "account/updated", "params": {} }),
                // A request from the server: codeg must decline it, not hang.
                json!({ "id": "srv-1", "method": "item/tool/requestUserInput", "params": {} }),
            ],
        },
        Step {
            method: "account/rateLimits/read",
            check: Box::new(|params| {
                assert_eq!(params["excludeResetCreditDetails"], false);
                assert!(params.get("supportsLunaReserve").is_none());
            }),
            reply: Some(ok(codex_read_result())),
            before: Vec::new(),
        },
    ]);
    server.initialize("1.0.0").await.expect("initialize");
    let (account, reading) = codex::read(&mut server, NOW).await.expect("read");
    assert_eq!(account.email.as_deref(), Some("me@example.com"));
    assert_eq!(reading.available, 2);
    assert_eq!(reading.items.len(), 2);

    let other = other.lock().unwrap().clone();
    assert!(other.iter().any(|m| m["method"] == "initialized"));
    let declined = other
        .iter()
        .find(|m| m["id"] == "srv-1")
        .expect("the server's request was answered");
    assert_eq!(declined["error"]["code"], -32601);
}

#[tokio::test]
async fn codex_read_falls_back_to_no_params_on_an_older_app_server() {
    let (mut server, _) = fake_app_server(vec![
        step("account/read", chatgpt_account()),
        step(
            "account/rateLimits/read",
            json!({ "error": { "code": -32602, "message": "invalid params" } }),
        ),
        Step {
            method: "account/rateLimits/read",
            check: Box::new(|params| assert!(params.is_null())),
            reply: Some(ok(codex_read_result())),
            before: Vec::new(),
        },
    ]);
    let (_, reading) = codex::read(&mut server, NOW).await.expect("read");
    assert_eq!(reading.available, 2);
}

#[tokio::test]
async fn codex_read_reports_a_signed_out_account() {
    let (mut server, _) = fake_app_server(vec![step(
        "account/read",
        ok(json!({ "account": null, "requiresOpenaiAuth": true })),
    )]);
    let error = codex::read(&mut server, NOW).await.unwrap_err();
    assert_eq!(error.code, LimitResetErrorCode::NotLoggedIn);
}

#[tokio::test]
async fn codex_consume_sends_the_attempt_key_and_the_chosen_credit() {
    let (mut server, _) = fake_app_server(vec![
        Step {
            method: "account/rateLimitResetCredit/consume",
            check: Box::new(|params| {
                assert_eq!(
                    params,
                    &json!({ "idempotencyKey": "key-1", "creditId": "RateLimitResetCredit_1" })
                );
            }),
            reply: Some(ok(json!({ "outcome": "reset" }))),
            before: Vec::new(),
        },
        Step {
            method: "account/rateLimitResetCredit/consume",
            check: Box::new(|params| assert_eq!(params, &json!({ "idempotencyKey": "key-2" }))),
            reply: Some(ok(json!({ "outcome": "noCredit" }))),
            before: Vec::new(),
        },
    ]);
    assert_eq!(
        codex::consume(&mut server, Some("RateLimitResetCredit_1"), "key-1").await,
        Ok(LimitResetOutcome::Reset)
    );
    assert_eq!(
        codex::consume(&mut server, None, "key-2").await,
        Ok(LimitResetOutcome::NoReset)
    );
}

#[tokio::test(start_paused = true)]
async fn codex_consume_that_gets_no_answer_is_unconfirmed() {
    let (mut server, _) = fake_app_server(vec![Step {
        method: "account/rateLimitResetCredit/consume",
        check: Box::new(|_| {}),
        reply: None,
        before: Vec::new(),
    }]);
    assert_eq!(
        codex::consume(&mut server, Some("c"), "key").await,
        Ok(LimitResetOutcome::Unconfirmed)
    );
}

#[tokio::test]
async fn codex_app_server_that_exits_is_reported_closed() {
    let (mut server, _) = fake_app_server(Vec::new());
    assert_eq!(
        server
            .request("account/read", json!({}), codex::READ_TIMEOUT)
            .await,
        Err(RpcError::Closed)
    );
}

// ─── Using a reset, end to end against mocks ────────────────────────────

fn claude_test_context() -> ClaudeContext {
    ClaudeContext {
        cli_version: "2.1.303".into(),
        org_id: "org-uuid-1".into(),
        email: Some("me@example.com".into()),
        login: StoredLogin::for_test("tok", Some(NOW + 3600)),
    }
}

/// An eligible read offering one usable weekly grant, `left` times.
fn one_grant_body(id: &str, left: u32) -> Value {
    json!({ "cedar_ember": { "eligible": true, "at_limit": false, "next_grant_id": id,
        "grants": [{ "id": id, "label": "Weekly reset", "type": "weekly",
            "resets_left": left, "usable_now": left > 0, "use_requires_limit": false,
            "ends_at": "2026-12-10T22:00:00+00:00", "clears": ["seven_day"] }] } })
}

fn claims(mock: &Mock) -> Vec<Seen> {
    mock.seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.method == Method::POST)
        .cloned()
        .collect()
}

#[tokio::test]
async fn claude_redeem_checks_the_grant_uses_it_and_reads_again() {
    let mut after = claude_eligible_body();
    after["cedar_ember"]["grants"][1]["resets_left"] = json!(0);
    after["seven_day"] = json!({ "utilization": 0.0, "resets_at": "2026-11-13T19:00:00+00:00" });
    let (base, mock) = mock_anthropic(vec![
        (StatusCode::OK, claude_eligible_body()),
        (
            StatusCode::OK,
            json!({ "result": "reset", "resets_left": 0, "cleared": ["seven_day", "seven_day_overage_included"] }),
        ),
        (StatusCode::OK, after),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let (attempt, refreshed) = redeem_claude(&api, &claude_test_context(), None)
        .await
        .expect("redeemed");
    assert_eq!(attempt.outcome, LimitResetOutcome::Reset);
    assert_eq!(attempt.cleared, ["seven_day", "seven_day_overage_included"]);
    let resets = attempt.resets.expect("read again");
    assert_eq!(resets.available, 1);
    assert_eq!(resets.items[0].kind, LimitResetKind::Fable);
    assert_eq!(refreshed.unwrap()["seven_day"]["utilization"], 0.0);

    let claims = claims(&mock);
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].body["grant_id"], "full-reset-2611");
    let request_id = claims[0].body["request_id"].as_str().unwrap();
    assert_eq!(
        uuid::Uuid::parse_str(request_id).unwrap().get_version_num(),
        4
    );
}

#[tokio::test]
async fn claude_redeem_uses_nothing_when_the_grant_is_gone_or_not_offered() {
    let (base, mock) = mock_anthropic(vec![
        (StatusCode::OK, claude_eligible_body()),
        (StatusCode::OK, claude_surface_body()),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let (gone, _) = redeem_claude(&api, &claude_test_context(), Some("gone-grant"))
        .await
        .expect("answered");
    assert_eq!(gone.outcome, LimitResetOutcome::NoReset);
    assert_eq!(gone.resets.unwrap().available, 2);

    let refused = redeem_claude(&api, &claude_test_context(), None)
        .await
        .unwrap_err();
    assert_eq!(refused.code, LimitResetErrorCode::NotEligible);
    assert_eq!(refused.reason.as_deref(), Some("surface"));
    assert!(claims(&mock).is_empty(), "nothing was claimed");
}

#[tokio::test]
async fn claude_redeem_whose_answer_is_lost_retries_under_the_same_request_id() {
    let grant = "lost-answer-grant";
    let (base, mock) = mock_anthropic(vec![
        (StatusCode::OK, one_grant_body(grant, 1)),
        (StatusCode::BAD_GATEWAY, json!({})),
        (StatusCode::OK, one_grant_body(grant, 1)),
        // The retry.
        (StatusCode::OK, one_grant_body(grant, 1)),
        (
            StatusCode::OK,
            json!({ "result": "already_used", "resets_left": 0 }),
        ),
        (StatusCode::OK, one_grant_body(grant, 0)),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let (first, _) = redeem_claude(&api, &claude_test_context(), Some(grant))
        .await
        .expect("first try");
    assert_eq!(first.outcome, LimitResetOutcome::Unconfirmed);
    let (second, _) = redeem_claude(&api, &claude_test_context(), Some(grant))
        .await
        .expect("retry");
    assert_eq!(second.outcome, LimitResetOutcome::AlreadyUsed);
    assert_eq!(second.resets.unwrap().available, 0);

    let claims = claims(&mock);
    assert_eq!(claims.len(), 2);
    assert_eq!(claims[0].body["request_id"], claims[1].body["request_id"]);
    // Settled: a later attempt gets a new id.
    assert_ne!(
        json!(attempt_id(PlanUsageAgent::ClaudeCode, Some(grant))),
        claims[0].body["request_id"]
    );
}

#[tokio::test]
async fn claude_redeem_refused_by_the_server_keeps_no_attempt() {
    let grant = "refused-claim-grant";
    let (base, mock) = mock_anthropic(vec![
        (StatusCode::OK, one_grant_body(grant, 1)),
        (StatusCode::UNAUTHORIZED, json!({})),
    ])
    .await;
    let api = ClaudeApi::new(base);
    let error = redeem_claude(&api, &claude_test_context(), Some(grant))
        .await
        .unwrap_err();
    assert_eq!(error.code, LimitResetErrorCode::LoginExpired);
    let sent = claims(&mock)[0].body["request_id"].clone();
    assert_ne!(
        json!(attempt_id(PlanUsageAgent::ClaudeCode, Some(grant))),
        sent
    );
}

fn record_key(
    keys: &Arc<Mutex<Vec<Value>>>,
    credit: Option<&'static str>,
) -> Box<dyn Fn(&Value) + Send> {
    let keys = keys.clone();
    Box::new(move |params: &Value| {
        let key = params["idempotencyKey"].as_str().unwrap();
        assert!(!key.is_empty());
        assert_eq!(params.get("creditId").and_then(Value::as_str), credit);
        keys.lock().unwrap().push(json!(key));
    })
}

fn after_redeem_steps(credits_left: u64) -> Vec<Step> {
    let mut result = codex_read_result();
    result["rateLimitResetCredits"]["availableCount"] = json!(credits_left);
    result["rateLimitResetCredits"]["credits"]
        .as_array_mut()
        .unwrap()
        .truncate(credits_left as usize);
    vec![
        step("account/read", chatgpt_account()),
        step("account/rateLimits/read", ok(result)),
    ]
}

#[tokio::test]
async fn codex_redeem_uses_a_credit_and_reads_again() {
    let keys = Arc::new(Mutex::new(Vec::new()));
    let credit = "RateLimitResetCredit_redeem_test";
    let mut script = vec![
        step("account/read", chatgpt_account()),
        Step {
            method: "account/rateLimitResetCredit/consume",
            check: record_key(&keys, Some(credit)),
            reply: Some(ok(json!({ "outcome": "reset" }))),
            before: Vec::new(),
        },
    ];
    script.extend(after_redeem_steps(1));
    let (mut server, _) = fake_app_server(script);
    let redeemed = redeem_codex(&mut server, Some(credit))
        .await
        .expect("redeemed");
    assert_eq!(redeemed.outcome, LimitResetOutcome::Reset);
    let (account, reading) = redeemed.after.expect("read again");
    assert_eq!(account.email.as_deref(), Some("me@example.com"));
    assert_eq!(reading.available, 1);
    assert!(reading.snapshot.is_some());
    assert_eq!(keys.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn codex_redeem_that_gets_no_answer_is_retried_under_the_same_key() {
    let keys = Arc::new(Mutex::new(Vec::new()));
    let credit = "RateLimitResetCredit_timeout_test";
    let mut first = vec![
        step("account/read", chatgpt_account()),
        Step {
            method: "account/rateLimitResetCredit/consume",
            check: record_key(&keys, Some(credit)),
            reply: None,
            before: Vec::new(),
        },
    ];
    first.extend(after_redeem_steps(2));
    let (mut server, _) = fake_app_server(first);
    let unconfirmed = redeem_codex(&mut server, Some(credit))
        .await
        .expect("answered");
    assert_eq!(unconfirmed.outcome, LimitResetOutcome::Unconfirmed);

    let mut retry = vec![
        step("account/read", chatgpt_account()),
        Step {
            method: "account/rateLimitResetCredit/consume",
            check: record_key(&keys, Some(credit)),
            reply: Some(ok(json!({ "outcome": "alreadyRedeemed" }))),
            before: Vec::new(),
        },
    ];
    retry.extend(after_redeem_steps(1));
    let (mut server, _) = fake_app_server(retry);
    let settled = redeem_codex(&mut server, Some(credit))
        .await
        .expect("answered");
    assert_eq!(settled.outcome, LimitResetOutcome::AlreadyUsed);

    let keys = keys.lock().unwrap().clone();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], keys[1], "the retry reused the attempt's key");
    assert_ne!(
        json!(attempt_id(PlanUsageAgent::Codex, Some(credit))),
        keys[0]
    );
}

#[tokio::test]
async fn codex_redeem_without_a_chatgpt_sign_in_uses_nothing() {
    let (mut server, _) = fake_app_server(vec![step(
        "account/read",
        ok(json!({ "account": { "type": "apiKey" }, "requiresOpenaiAuth": true })),
    )]);
    let error = redeem_codex(&mut server, None)
        .await
        .err()
        .expect("refused");
    assert_eq!(error.code, LimitResetErrorCode::NotEligible);
}

// ─── The use flow's guards ──────────────────────────────────────────────

#[test]
fn an_unconfirmed_attempt_is_retried_under_the_same_id() {
    let provider = PlanUsageAgent::Codex;
    let reset = Some("attempt-test-credit");
    let first = attempt_id(provider, reset);
    settle_attempt(
        provider,
        reset,
        &first,
        Some(LimitResetOutcome::Unconfirmed),
    );
    assert_eq!(attempt_id(provider, reset), first);
    // Another reset, or another provider, gets its own.
    assert_ne!(attempt_id(provider, Some("attempt-test-other")), first);
    assert_ne!(attempt_id(PlanUsageAgent::ClaudeCode, reset), first);
    // Any answer settles it.
    settle_attempt(
        provider,
        reset,
        &first,
        Some(LimitResetOutcome::AlreadyUsed),
    );
    assert_ne!(attempt_id(provider, reset), first);
    // A refused attempt keeps nothing either.
    let second = attempt_id(provider, reset);
    settle_attempt(provider, reset, &second, None);
    assert_ne!(attempt_id(provider, reset), second);
}

#[test]
fn only_one_attempt_runs_per_provider() {
    let first = InFlight::take(PlanUsageAgent::Codex).expect("free");
    assert!(InFlight::take(PlanUsageAgent::Codex).is_none());
    let other = InFlight::take(PlanUsageAgent::ClaudeCode).expect("the other provider is free");
    drop(first);
    assert!(InFlight::take(PlanUsageAgent::Codex).is_some());
    drop(other);
}

#[test]
fn errors_carry_their_i18n_key_and_reason() {
    let error = LimitResetError::new(LimitResetErrorCode::NotEligible, "not offered here")
        .with_reason(Some("surface".into()))
        .into_app_error();
    assert!(matches!(error.code, AppErrorCode::PermissionDenied));
    assert_eq!(error.message, "not offered here");
    assert_eq!(error.i18n_key.as_deref(), Some("resets.error.notEligible"));
    assert_eq!(
        error.i18n_params.unwrap().get("reason").map(String::as_str),
        Some("surface")
    );
    let busy = LimitResetError::new(LimitResetErrorCode::Busy, "busy").into_app_error();
    assert_eq!(busy.i18n_key.as_deref(), Some("resets.error.busy"));
    assert!(busy.i18n_params.is_none());
}

#[test]
fn listing_serializes_in_the_shape_the_frontend_reads() {
    let resets = claude::parse_resets(&claude_eligible_body(), NOW).unwrap();
    let mut listing = claude_listing(Some(&resets), Some("me@example.com".into()), NOW);
    listing.error = Some(
        LimitResetError::new(LimitResetErrorCode::NotEligible, "x")
            .with_reason(Some("surface".into())),
    );
    let value = serde_json::to_value(LimitResetsReport {
        providers: vec![listing],
    })
    .unwrap();
    let provider = &value["providers"][0];
    assert_eq!(provider["provider"], "claude_code");
    assert_eq!(provider["source"], "claude_oauth");
    assert_eq!(provider["available"], 2);
    assert_eq!(provider["account"], "me@example.com");
    assert_eq!(provider["fetched_at"], NOW);
    assert_eq!(provider["error"]["code"], "not_eligible");
    assert_eq!(provider["error"]["reason"], "surface");
    let item = &provider["items"][0];
    assert_eq!(item["id"], "full-reset-2611");
    assert_eq!(item["kind"], "weekly");
    assert_eq!(item["count"], 1);
    assert_eq!(item["expires_at"], rfc3339("2026-12-10T22:00:00+00:00"));
    assert_eq!(item["usable_now"], true);
    assert_eq!(item["requires_limit"], false);
    assert_eq!(
        item["clears"],
        json!(["seven_day", "seven_day_overage_included"])
    );

    let result = serde_json::to_value(UseLimitResetResult {
        provider: PlanUsageAgent::Codex,
        outcome: LimitResetOutcome::NothingToReset,
        cleared: Vec::new(),
        resets: None,
        paused_conversations: vec![4, 7],
        continued: Some(3),
    })
    .unwrap();
    assert_eq!(result["outcome"], "nothing_to_reset");
    assert_eq!(result["paused_conversations"], json!([4, 7]));
    assert_eq!(result["continued"], 3);
}

// ─── Plan usage, fed by the reset flow ──────────────────────────────────

#[test]
fn a_usage_read_updates_the_account_windows_in_percent() {
    let body = json!({
        "five_hour": { "utilization": 1.0, "resets_at": "2026-11-11T20:00:00+00:00" },
        "seven_day": { "utilization": 88.0, "resets_at": "2026-11-13T18:59:59.638559+00:00" },
        "seven_day_opus": { "utilization": 12.0, "resets_at": null },
        "seven_day_cowork": { "utilization": 3.0 },
        "extra_usage": { "is_enabled": true },
        "cedar_ember": { "eligible": false }
    });
    let update =
        plan_usage::claude_update_from_usage_read(&body, &["seven_day_opus".to_string()]).unwrap();
    let ids: Vec<_> = update.windows.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(ids, ["five_hour", "seven_day", "seven_day_opus"]);
    // The endpoint speaks percent: 1.0 is 1 %, not a full window.
    assert_eq!(update.windows[0].used_percent, 1.0);
    assert_eq!(
        update.windows[0].resets_at,
        Some(rfc3339("2026-11-11T20:00:00+00:00"))
    );
    assert_eq!(update.windows[1].used_percent, 88.0);
    assert_eq!(update.windows[2].resets_at, None);
    assert_eq!(update.status, None);

    assert!(
        plan_usage::claude_update_from_usage_read(&json!({ "five_hour": null }), &[]).is_none()
    );
    assert!(plan_usage::claude_update_from_usage_read(&json!("x"), &[]).is_none());
}

#[test]
fn the_newer_codex_reading_wins() {
    let reading = |observed_at: i64, source: PlanUsageSource| {
        let mut snapshot = codex::snapshot_from_rate_limits(
            Some(&json!({ "primary": { "usedPercent": 50, "windowDurationMins": 300, "resetsAt": null } })),
            observed_at,
        )
        .unwrap();
        snapshot.source = source;
        snapshot
    };
    let rollout = reading(100, PlanUsageSource::Transcript);
    let live = reading(200, PlanUsageSource::Live);
    assert_eq!(
        plan_usage::newest_codex_snapshot(Some(rollout.clone()), Some(live.clone()))
            .unwrap()
            .source,
        PlanUsageSource::Live
    );
    let newer_rollout = reading(300, PlanUsageSource::Transcript);
    assert_eq!(
        plan_usage::newest_codex_snapshot(Some(newer_rollout), Some(live.clone()))
            .unwrap()
            .source,
        PlanUsageSource::Transcript
    );
    assert_eq!(
        plan_usage::newest_codex_snapshot(None, Some(live))
            .unwrap()
            .source,
        PlanUsageSource::Live
    );
    assert_eq!(
        plan_usage::newest_codex_snapshot(Some(rollout), None)
            .unwrap()
            .source,
        PlanUsageSource::Transcript
    );
    assert!(plan_usage::newest_codex_snapshot(None, None).is_none());
}
