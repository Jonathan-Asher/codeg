//! Codex's reset credits from its app-server's answers (shapes captured from
//! a live read), the use flow's outcome and error mapping, and the
//! app-server protocol against a scripted server on an in-memory pipe.
//! Nothing here reaches a provider, and Claude Code is never driven.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::codex::{self, AppServer, RpcError};
use super::*;
use crate::commands::plan_usage::{PlanUsageSource, PlanUsageWindowKind};
use crate::db::test_helpers;

/// 2026-11-12T18:00:00Z.
const NOW: i64 = 1_794_506_400;

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

/// The client end of an in-memory app-server pipe.
type PipeClient = AppServer<
    tokio::io::ReadHalf<tokio::io::DuplexStream>,
    tokio::io::WriteHalf<tokio::io::DuplexStream>,
>;

/// Lines a client sent that were not requests.
type NonRequests = Arc<Mutex<Vec<Value>>>;

/// A fake app-server on one end of a duplex pipe. Returns the client end
/// and the lines the client sent that were not requests (notifications,
/// replies to the server's own requests).
fn fake_app_server(script: Vec<Step>) -> (PipeClient, NonRequests) {
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

// ─── Using a reset, end to end against the scripted app-server ──────────

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
    assert_ne!(json!(attempt_key(Some(credit))), keys[0]);
}

#[tokio::test]
async fn codex_redeem_without_a_chatgpt_sign_in_uses_nothing() {
    let (mut server, _) = fake_app_server(vec![step(
        "account/read",
        ok(json!({ "account": { "type": "apiKey" }, "requiresOpenaiAuth": true })),
    )]);
    let error = redeem_codex(&mut server, None).await.expect_err("refused");
    assert_eq!(error.code, LimitResetErrorCode::NotEligible);
}

// ─── The use flow's guards ──────────────────────────────────────────────

#[test]
fn an_unconfirmed_attempt_is_retried_under_the_same_key() {
    let reset = Some("attempt-test-credit");
    let first = attempt_key(reset);
    settle_attempt(reset, &first, Some(LimitResetOutcome::Unconfirmed));
    assert_eq!(attempt_key(reset), first);
    // Another reset gets its own.
    assert_ne!(attempt_key(Some("attempt-test-other")), first);
    // Any answer settles it.
    settle_attempt(reset, &first, Some(LimitResetOutcome::AlreadyUsed));
    assert_ne!(attempt_key(reset), first);
    // A refused attempt keeps nothing either.
    let second = attempt_key(reset);
    settle_attempt(reset, &second, None);
    assert_ne!(attempt_key(reset), second);
}

#[test]
fn only_one_attempt_runs_at_a_time() {
    let first = InFlight::take().expect("free");
    assert!(InFlight::take().is_none());
    drop(first);
    let again = InFlight::take().expect("free again once the first is done");
    drop(again);
}

#[tokio::test]
async fn claude_code_is_refused_before_anything_runs() {
    let db = test_helpers::fresh_in_memory_db().await;
    let dir = tempfile::tempdir().unwrap();
    let error = use_limit_reset_core(
        &db,
        dir.path(),
        &EventEmitter::Noop,
        PlanUsageAgent::ClaudeCode,
        Some("any-grant".into()),
        Some(7),
    )
    .await
    .expect_err("Claude Code's resets are used in its own apps");
    assert!(matches!(error.code, AppErrorCode::PermissionDenied));
    assert_eq!(error.i18n_key.as_deref(), Some("resets.error.notEligible"));
    assert_eq!(
        error.i18n_params.unwrap().get("reason").map(String::as_str),
        Some("claude_app")
    );
    assert!(error.message.contains("claude.ai"));
    // Refused up front: it never took the attempt slot.
    drop(InFlight::take().expect("the attempt slot was left alone"));
}

#[test]
fn errors_carry_their_i18n_key_and_reason() {
    let error = LimitResetError::new(LimitResetErrorCode::NotEligible, "not offered here")
        .with_reason(Some("apiKey".into()))
        .into_app_error();
    assert!(matches!(error.code, AppErrorCode::PermissionDenied));
    assert_eq!(error.message, "not offered here");
    assert_eq!(error.i18n_key.as_deref(), Some("resets.error.notEligible"));
    assert_eq!(
        error.i18n_params.unwrap().get("reason").map(String::as_str),
        Some("apiKey")
    );
    let busy = LimitResetError::new(LimitResetErrorCode::Busy, "busy").into_app_error();
    assert_eq!(busy.i18n_key.as_deref(), Some("resets.error.busy"));
    assert!(busy.i18n_params.is_none());
}

#[test]
fn listing_serializes_in_the_shape_the_frontend_reads() {
    let reading = codex::parse_reading(&codex_read_result(), NOW);
    let listing = codex_listing(Some("me@example.com".into()), &reading, NOW);
    let value = serde_json::to_value(LimitResetsReport {
        providers: vec![listing],
    })
    .unwrap();
    let provider = &value["providers"][0];
    assert_eq!(provider["provider"], "codex");
    assert_eq!(provider["source"], "codex_app_server");
    assert_eq!(provider["available"], 2);
    assert_eq!(provider["account"], "me@example.com");
    assert_eq!(provider["fetched_at"], NOW);
    assert!(provider["error"].is_null());
    let item = &provider["items"][0];
    assert_eq!(
        item["id"],
        "RateLimitResetCredit_97204d3755cc8191802afd10f3057a26"
    );
    assert_eq!(item["kind"], "full");
    assert_eq!(item["label"], "Full reset");
    assert_eq!(item["count"], 1);
    assert_eq!(item["expires_at"], 1_796_070_038);

    let failed = serde_json::to_value(ProviderLimitResets::failed(
        NOW,
        LimitResetError::new(LimitResetErrorCode::NotEligible, "x")
            .with_reason(Some("apiKey".into())),
    ))
    .unwrap();
    assert_eq!(failed["error"]["code"], "not_eligible");
    assert_eq!(failed["error"]["reason"], "apiKey");
    assert_eq!(failed["available"], 0);

    let result = serde_json::to_value(UseLimitResetResult {
        provider: PlanUsageAgent::Codex,
        outcome: LimitResetOutcome::NothingToReset,
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
