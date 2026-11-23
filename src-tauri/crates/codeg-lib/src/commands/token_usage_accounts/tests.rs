//! The join (call ↔ pool record), the weekly-limit shares, the prices,
//! sub-agent linking and the session list, end to end on an in-memory
//! database. Nothing here reads this machine's transcripts or its pool.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::Path;

use chrono::{DateTime, Utc};
use sea_orm::EntityTrait;
use serde_json::json;

use super::assemble::{self, parse_stored_time};
use super::build_sessions_report;
use super::calls::{rows_of, CALL_SCHEMA_VERSION};
use super::meter::{PctSource, BASELINE_USD_PER_PCT};
use super::pool::{recompute_shares, row_of};
use super::pricing::{self, CallTokens};
use crate::commands::usage_pool::records::PoolRecord;
use crate::db::entities::usage_pool_request;
use crate::db::service::token_usage_accounts_service::{
    self as service, AccountsQuery, CallRow, CallStamp, ThreadRow,
};
use crate::db::service::token_usage_service::{self as usage_service, UsageFact};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::db::AppDatabase;
use crate::models::token_usage::{
    TokenUsageFilter, TokenUsagePoolState, TokenUsageSessionsQuery, TOKEN_USAGE_NO_ACCOUNT,
};
use crate::models::AgentType;
use crate::parsers::claude::usage_calls;

fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

fn call(thread: &str, msg: Option<&str>, req: Option<&str>, when: &str, output: i64) -> CallRow {
    let tokens = CallTokens {
        input: 2,
        output: output as u64,
        cache_read: 100_000,
        cache_write_5m: 1_000,
        cache_write_1h: 0,
    };
    CallRow {
        thread_key: thread.to_string(),
        message_id: msg.map(str::to_string),
        request_id: req.map(str::to_string),
        occurred_at: at(when),
        model: Some("claude-opus-5-5".to_string()),
        input_tokens: 2,
        output_tokens: output,
        cache_read_tokens: 100_000,
        cache_write_5m_tokens: 1_000,
        cache_write_1h_tokens: 0,
        cost_usd: pricing::cost_usd(Some("claude-opus-5-5"), &tokens),
    }
}

fn record(
    id: &str,
    account: &str,
    ts: &str,
    msg: Option<&str>,
    req: Option<&str>,
    util: Option<f64>,
    output: u64,
) -> PoolRecord {
    PoolRecord {
        id: Some(id.to_string()),
        ts: Some(at(ts).timestamp_millis()),
        account: Some(account.to_string()),
        kind: Some("claude".to_string()),
        model: Some("claude-opus-5-5".to_string()),
        message_id: msg.map(str::to_string),
        request_id: req.map(str::to_string),
        input: Some(2),
        output: Some(output),
        cache_read: Some(100_000),
        cache_write5m: Some(1_000),
        cache_write1h: Some(0),
        util7d: util,
        reset7d: Some(at("2026-11-26T00:00:00Z").timestamp_millis()),
        ..Default::default()
    }
}

async fn claude_session(db: &AppDatabase, folder: i32) -> i32 {
    seed_conversation(db, folder, AgentType::ClaudeCode).await
}

fn stamp() -> CallStamp {
    CallStamp {
        source_path: "/x/sess.jsonl".to_string(),
        source_fingerprint: "f".to_string(),
        schema_version: CALL_SCHEMA_VERSION,
    }
}

fn threads() -> Vec<ThreadRow> {
    vec![
        ThreadRow {
            thread_key: String::new(),
            label: None,
            agent_type: None,
            parent_key: None,
        },
        ThreadRow {
            thread_key: "aaa".to_string(),
            label: Some("Review the diff".to_string()),
            agent_type: Some("general-purpose".to_string()),
            parent_key: None,
        },
    ]
}

/// Main thread: A (acct1), B (no record). Sub-agent aaa: C (acct2), D
/// (acct2, matched by request id only).
async fn seeded() -> (AppDatabase, i32, i32) {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/usage-accounts").await;
    let conv = claude_session(&db, folder).await;
    let calls = vec![
        call(
            "",
            Some("msg_A"),
            Some("req_A"),
            "2026-11-23T10:00:00Z",
            1000,
        ),
        call(
            "",
            Some("msg_B"),
            Some("req_B"),
            "2026-11-23T10:01:00Z",
            500,
        ),
        call(
            "aaa",
            Some("msg_C"),
            Some("req_C"),
            "2026-11-23T10:02:00Z",
            3000,
        ),
        call(
            "aaa",
            Some("msg_D"),
            Some("req_D"),
            "2026-11-23T10:03:00Z",
            100,
        ),
    ];
    service::replace_conversation_calls(&db.conn, conv, &calls, &threads(), &stamp())
        .await
        .unwrap();
    let rows: Vec<_> = [
        record(
            "r1",
            "acct1",
            "2026-11-23T10:00:01Z",
            Some("msg_A"),
            Some("req_A"),
            Some(0.40),
            1000,
        ),
        record(
            "r2",
            "acct2",
            "2026-11-23T10:02:01Z",
            Some("msg_C"),
            Some("req_C"),
            Some(0.10),
            3000,
        ),
        record(
            "r3",
            "acct2",
            "2026-11-23T10:03:01Z",
            None,
            Some("req_D"),
            Some(0.10),
            100,
        ),
        // Another client's request on acct1: in the pool total, in no session.
        record(
            "r4",
            "acct1",
            "2026-11-23T10:04:00Z",
            Some("msg_X"),
            None,
            Some(0.41),
            2000,
        ),
    ]
    .iter()
    .filter_map(row_of)
    .collect();
    service::insert_pool_records(&db.conn, rows).await.unwrap();
    let codex = seed_conversation(&db, folder, AgentType::Codex).await;
    usage_service::replace_conversation_facts(
        &db.conn,
        codex,
        at("2026-11-23T11:00:00Z"),
        &[UsageFact {
            turn_key: "t1".into(),
            occurred_at: at("2026-11-23T10:30:00Z"),
            model: Some("gpt-5.5".into()),
            input_tokens: 50_000,
            output_tokens: 1_000,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            duration_ms: 0,
        }],
    )
    .await
    .unwrap();
    (db, conv, codex)
}

fn window() -> AccountsQuery {
    AccountsQuery {
        start: Some(at("2026-11-23T00:00:00Z")),
        end: Some(at("2026-11-24T00:00:00Z")),
        ..Default::default()
    }
}

#[tokio::test]
async fn calls_join_pool_records_by_message_id_then_request_id() {
    let (db, conv, _) = seeded().await;
    let groups = service::call_groups(&db.conn, &window()).await.unwrap();
    let mut got: Vec<(String, String, i64)> = groups
        .iter()
        .filter(|g| g.conversation_id == conv)
        .map(|g| {
            (
                g.thread_key.clone(),
                g.account
                    .clone()
                    .unwrap_or_else(|| TOKEN_USAGE_NO_ACCOUNT.into()),
                g.calls,
            )
        })
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            ("".into(), "__none__".into(), 1),
            ("".into(), "acct1".into(), 1),
            ("aaa".into(), "acct2".into(), 2),
        ],
        "B has no record; D matched acct2 through its request id"
    );
}

#[tokio::test]
async fn a_session_expands_into_its_threads_with_their_account_split() {
    let (db, conv, codex) = seeded().await;
    let q = window();
    let groups = service::call_groups(&db.conn, &q).await.unwrap();
    let turns = service::turn_totals(&db.conn, &q).await.unwrap();
    let has = service::conversations_with_calls(&db.conn, &[conv, codex])
        .await
        .unwrap();
    assert_eq!(has, HashSet::from([conv]));
    let drafts = assemble::rank_sessions(&turns, &groups, &has, None, 8);
    assert_eq!(drafts.len(), 2);
    let claude = drafts.iter().find(|d| d.conversation_id == conv).unwrap();
    assert!(claude.detail);
    let per_call = |out: u64| 2 + out + 100_000 + 1_000;
    assert_eq!(
        claude.usage.tokens,
        per_call(1000) + per_call(500) + per_call(3000) + per_call(100)
    );
    assert_eq!(claude.usage.calls, 4);
    assert_eq!(claude.threads.len(), 2);
    assert_eq!(claude.threads[0].key, "", "main thread first");
    assert_eq!(claude.threads[1].key, "aaa");
    assert_eq!(
        claude.threads[1].usage.tokens,
        per_call(3000) + per_call(100)
    );
    let accounts: Vec<&str> = claude
        .by_account
        .iter()
        .map(|s| s.account.as_str())
        .collect();
    assert_eq!(
        accounts,
        vec!["acct2", "acct1", "__none__"],
        "largest first, unmatched last"
    );
    // The thread's split sums to the thread.
    let main_sum: u64 = claude.threads[0]
        .by_account
        .iter()
        .map(|s| s.usage.tokens)
        .sum();
    assert_eq!(main_sum, claude.threads[0].usage.tokens);

    let codex_row = drafts.iter().find(|d| d.conversation_id == codex).unwrap();
    assert!(!codex_row.detail, "Codex: totals only");
    assert_eq!(codex_row.usage.tokens, 51_000);
    assert!(codex_row.by_account.is_empty() && codex_row.threads.is_empty());
    assert_eq!(codex_row.usage.cost_usd, None);
}

#[tokio::test]
async fn account_chips_keep_only_what_the_chosen_accounts_served() {
    let (db, conv, _) = seeded().await;
    let q = window();
    let groups = service::call_groups(&db.conn, &q).await.unwrap();
    let turns = service::turn_totals(&db.conn, &q).await.unwrap();
    let has = HashSet::from([conv]);
    let only = HashSet::from(["acct1".to_string()]);
    let drafts = assemble::rank_sessions(&turns, &groups, &has, Some(&only), 8);
    assert_eq!(drafts.len(), 1, "Codex has no account to match");
    let d = &drafts[0];
    assert_eq!(d.usage.calls, 1);
    assert_eq!(
        d.threads.len(),
        1,
        "the sub-agent served by acct2 drops out"
    );
    assert_eq!(d.by_account.len(), 1);
    assert_eq!(d.by_account[0].account, "acct1");
    let none = HashSet::from([TOKEN_USAGE_NO_ACCOUNT.to_string()]);
    let drafts = assemble::rank_sessions(&turns, &groups, &has, Some(&none), 8);
    assert_eq!(
        drafts[0].usage.calls, 1,
        "the unmatched bucket is a chip too"
    );
}

#[tokio::test]
async fn weekly_shares_come_from_meter_steps_and_sum_to_the_movement() {
    let db = fresh_in_memory_db().await;
    // acct1 at 40 %: three requests at 40 %, then one at 41 % (a step),
    // then one more at 41 % (no step yet: an estimate).
    let mut recs = vec![record(
        "p0",
        "acct1",
        "2026-11-23T09:00:00Z",
        Some("m0"),
        None,
        Some(0.40),
        1000,
    )];
    recs[0].util7d_prev = Some(0.40);
    recs.push(record(
        "p1",
        "acct1",
        "2026-11-23T09:01:00Z",
        Some("m1"),
        None,
        Some(0.40),
        1000,
    ));
    recs.push(record(
        "p2",
        "acct1",
        "2026-11-23T09:02:00Z",
        Some("m2"),
        None,
        Some(0.41),
        3000,
    ));
    recs.push(record(
        "p3",
        "acct1",
        "2026-11-23T09:03:00Z",
        Some("m3"),
        None,
        Some(0.41),
        1000,
    ));
    let rows: Vec<_> = recs.iter().filter_map(row_of).collect();
    service::insert_pool_records(&db.conn, rows).await.unwrap();
    recompute_shares(&db.conn).await.unwrap();
    let mut stored = usage_pool_request::Entity::find()
        .all(&db.conn)
        .await
        .unwrap();
    stored.sort_by_key(|r| r.record_id.clone());
    let metered: f64 = stored
        .iter()
        .filter(|r| r.pct_source == PctSource::Meter as i32)
        .map(|r| r.pct.unwrap())
        .sum();
    assert!((metered - 1.0).abs() < 1e-9, "one step of 1 %: {metered}");
    // Shared by price: p2 costs more than p0 or p1, so it took more.
    assert!(stored[2].pct.unwrap() > stored[0].pct.unwrap());
    assert_eq!(stored[3].pct_source, PctSource::Pending as i32);
    let p3_cost = stored[3].cost_usd.unwrap();
    assert!((stored[3].pct.unwrap() - p3_cost / BASELINE_USD_PER_PCT).abs() < 1e-12);

    // The next step revises the estimate into a meter share.
    let next: Vec<_> = [record(
        "p4",
        "acct1",
        "2026-11-23T09:04:00Z",
        Some("m4"),
        None,
        Some(0.42),
        1000,
    )]
    .iter()
    .filter_map(row_of)
    .collect();
    service::insert_pool_records(&db.conn, next).await.unwrap();
    recompute_shares(&db.conn).await.unwrap();
    let stored = usage_pool_request::Entity::find()
        .all(&db.conn)
        .await
        .unwrap();
    assert!(stored
        .iter()
        .all(|r| r.pct_source == PctSource::Meter as i32));
    let total: f64 = stored.iter().map(|r| r.pct.unwrap()).sum();
    assert!((total - 2.0).abs() < 1e-9, "40 % → 42 %: {total}");
}

#[tokio::test]
async fn re_reading_overlapping_records_inserts_nothing_twice() {
    let db = fresh_in_memory_db().await;
    let r = record(
        "same",
        "acct1",
        "2026-11-23T09:00:00Z",
        Some("m0"),
        None,
        Some(0.4),
        10,
    );
    for _ in 0..3 {
        service::insert_pool_records(&db.conn, vec![row_of(&r).unwrap()])
            .await
            .unwrap();
    }
    assert_eq!(
        usage_pool_request::Entity::find()
            .all(&db.conn)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn linked_pool_requests_are_estimated_from_their_price() {
    let mut r = record(
        "l1",
        "acct1",
        "2026-11-23T09:00:00Z",
        Some("m"),
        None,
        Some(0.5),
        1000,
    );
    r.kind = Some("link".to_string());
    let row = row_of(&r).unwrap();
    let cost = row.cost_usd.clone().unwrap().unwrap();
    assert_eq!(row.pct_source.clone().unwrap(), PctSource::Estimate as i32);
    assert!((row.pct.clone().unwrap().unwrap() - cost / BASELINE_USD_PER_PCT).abs() < 1e-12);
    let mut p = r.clone();
    p.kind = Some("provider".to_string());
    p.model = Some("glm-5.3".to_string());
    let row = row_of(&p).unwrap();
    assert_eq!(row.pct.unwrap(), None);
    assert_eq!(
        row.cost_usd.unwrap(),
        None,
        "no list price for a provider model"
    );
}

#[tokio::test]
async fn the_legend_has_every_account_with_its_session_share_and_pool_total() {
    let (db, _, _) = seeded().await;
    recompute_shares(&db.conn).await.unwrap();
    let report = build_sessions_report(
        &db.conn,
        TokenUsageSessionsQuery {
            filter: TokenUsageFilter {
                start: Some(at("2026-11-23T00:00:00Z")),
                end: Some(at("2026-11-24T00:00:00Z")),
                ..Default::default()
            },
            accounts: None,
            limit: None,
        },
        TokenUsagePoolState {
            configured: true,
            reachable: true,
            ..Default::default()
        },
        false,
    )
    .await
    .unwrap();
    let by: HashMap<&str, _> = report
        .accounts
        .iter()
        .map(|a| (a.account.as_str(), a))
        .collect();
    assert_eq!(by["acct1"].usage.calls, 1, "one session call on acct1");
    assert_eq!(
        by["acct1"].pool_calls, 2,
        "the pool served it two: one from another client"
    );
    assert_eq!(by["acct2"].usage.calls, 2);
    assert_eq!(by["__none__"].kind, "none");
    assert_eq!(by["__none__"].pool_calls, 0);
    assert_eq!(
        by["acct1"].usd_per_pct,
        Some(BASELINE_USD_PER_PCT),
        "too little movement to measure"
    );
    assert!(!by["acct1"].usd_per_pct_measured);
    assert_eq!(report.accounts.last().unwrap().account, "__none__");
    // Session rows carry titles and thread labels from the store.
    let claude = report.sessions.iter().find(|s| s.detail).unwrap();
    assert_eq!(claude.agent_type, "claude_code");
    let sub = claude.threads.iter().find(|t| !t.main).unwrap();
    assert_eq!(sub.label.as_deref(), Some("Review the diff"));
    assert_eq!(sub.agent_type.as_deref(), Some("general-purpose"));
    let codex = report.sessions.iter().find(|s| !s.detail).unwrap();
    assert_eq!(codex.agent_type, "codex");
}

#[tokio::test]
async fn replacing_a_sessions_calls_swaps_the_whole_set_and_stamps_it() {
    let (db, conv, _) = seeded().await;
    let fresh = vec![call("", Some("msg_Z"), None, "2026-11-23T12:00:00Z", 1)];
    let stamp2 = CallStamp {
        source_fingerprint: "g".to_string(),
        ..stamp()
    };
    service::replace_conversation_calls(&db.conn, conv, &fresh, &[], &stamp2)
        .await
        .unwrap();
    let groups = service::call_groups(&db.conn, &window()).await.unwrap();
    let mine: Vec<_> = groups
        .iter()
        .filter(|g| g.conversation_id == conv)
        .collect();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].calls, 1);
    let threads = service::threads_of(&db.conn, &[conv]).await.unwrap();
    assert_eq!(threads.len(), 1, "the main thread's stamp row only");
    assert_eq!(threads[0].source_fingerprint.as_deref(), Some("g"));
}

fn write_lines(path: &Path, lines: &[serde_json::Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut f = fs::File::create(path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn asst(
    id: &str,
    req: &str,
    ts: &str,
    model: &str,
    out: u64,
    content: serde_json::Value,
) -> serde_json::Value {
    json!({"type": "assistant", "requestId": req, "timestamp": ts, "message": {
        "id": id, "model": model, "content": content,
        "usage": {"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 50_000,
                  "cache_creation_input_tokens": 400,
                  "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 300}}
    }})
}

#[tokio::test]
async fn a_transcript_tree_becomes_priced_calls_on_labelled_threads() {
    let dir = tempfile::tempdir().unwrap();
    let main = dir.path().join("proj").join("s1.jsonl");
    write_lines(
        &main,
        &[asst(
            "msg_1",
            "req_1",
            "2026-11-23T10:00:00Z",
            "claude-opus-5-5",
            10,
            json!([
                {"type": "tool_use", "id": "toolu_9", "name": "Task", "input": {"description": "Find the bug", "subagent_type": "Explore"}}
            ]),
        )],
    );
    let sub = main
        .with_extension("")
        .join("subagents")
        .join("agent-b1.jsonl");
    write_lines(
        &sub,
        &[asst(
            "msg_2",
            "req_2",
            "2026-11-23T10:00:30Z",
            "claude-sonnet-5-5",
            20,
            json!([]),
        )],
    );
    fs::write(
        sub.with_extension("meta.json"),
        r#"{"toolUseId":"toolu_9"}"#,
    )
    .unwrap();

    let read = usage_calls::read_calls(&main);
    let (calls, threads) = rows_of(&read);
    assert_eq!(calls.len(), 2);
    let opus = CallTokens {
        input: 1,
        output: 10,
        cache_read: 50_000,
        cache_write_5m: 100,
        cache_write_1h: 300,
    };
    assert_eq!(
        calls[0].cost_usd,
        pricing::cost_usd(Some("claude-opus-5-5"), &opus)
    );
    let want = 1.0 * 4.0 / 1e6
        + 10.0 * 20.0 / 1e6
        + 50_000.0 * 0.20 / 1e6
        + 100.0 * 5.0 / 1e6
        + 300.0 * 8.0 / 1e6;
    assert!((calls[0].cost_usd.unwrap() - want).abs() < 1e-12);
    assert_eq!(calls[1].thread_key, "b1");
    assert!(
        calls[1].cost_usd.unwrap() < calls[0].cost_usd.unwrap() * 2.0,
        "Sonnet priced as Sonnet"
    );
    let b1 = threads.iter().find(|t| t.thread_key == "b1").unwrap();
    assert_eq!(
        b1.label.as_deref(),
        Some("Find the bug"),
        "labelled from the launching Task call"
    );
    assert_eq!(b1.agent_type.as_deref(), Some("Explore"));

    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/usage-tree").await;
    let conv = claude_session(&db, folder).await;
    service::replace_conversation_calls(&db.conn, conv, &calls, &threads, &stamp())
        .await
        .unwrap();
    let report = build_sessions_report(
        &db.conn,
        TokenUsageSessionsQuery::default(),
        TokenUsagePoolState::default(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(report.sessions.len(), 1);
    let s = &report.sessions[0];
    assert_eq!(s.threads.len(), 2);
    assert_eq!(s.threads[1].label.as_deref(), Some("Find the bug"));
    assert_eq!(s.by_account.len(), 1);
    assert_eq!(
        s.by_account[0].account, TOKEN_USAGE_NO_ACCOUNT,
        "no pool: every call unmatched"
    );
    assert_eq!(s.usage.pct, None);
    assert!(s.usage.cost_usd.unwrap() > 0.0);
    assert!(s.last_activity_at.is_some(), "stored times read back");
}

#[tokio::test]
async fn the_call_sync_lists_claude_sessions_with_their_stamp() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/usage-cands").await;
    let conv = claude_session(&db, folder).await;
    let codex = seed_conversation(&db, folder, AgentType::Codex).await;
    for id in [conv, codex] {
        crate::db::service::conversation_service::bind_external_id(
            &db.conn,
            id,
            &format!("ext-{id}"),
            &[],
        )
        .await
        .unwrap();
    }
    let before = service::call_sync_candidates(&db.conn).await.unwrap();
    assert_eq!(before.len(), 1, "Claude sessions only");
    assert_eq!(before[0].external_id, format!("ext-{conv}"));
    assert_eq!(before[0].source_fingerprint, None);
    service::replace_conversation_calls(&db.conn, conv, &[], &[], &stamp())
        .await
        .unwrap();
    let after = service::call_sync_candidates(&db.conn).await.unwrap();
    assert_eq!(after[0].source_fingerprint.as_deref(), Some("f"));
    assert_eq!(after[0].schema_version, Some(CALL_SCHEMA_VERSION));
}

#[test]
fn the_planner_reads_moved_recent_trees_only() {
    use super::calls::plan;
    use crate::db::service::token_usage_accounts_service::CallSyncCandidate;

    let dir = tempfile::tempdir().unwrap();
    let projects = dir.path();
    for id in ["new", "same", "fresh"] {
        write_lines(
            &projects.join("proj").join(format!("{id}.jsonl")),
            &[asst(
                &format!("m-{id}"),
                "r",
                "2026-11-23T10:00:00Z",
                "claude-opus-5-5",
                1,
                json!([]),
            )],
        );
    }
    let same_stamp = usage_calls::tree_stamp(&projects.join("proj/same.jsonl")).unwrap();
    let cand = |id: &str, conv: i32, fp: Option<String>, synced: Option<&str>| CallSyncCandidate {
        conversation_id: conv,
        external_id: id.to_string(),
        source_path: fp.as_ref().map(|_| {
            projects
                .join(format!("proj/{id}.jsonl"))
                .to_string_lossy()
                .into_owned()
        }),
        source_fingerprint: fp,
        schema_version: Some(CALL_SCHEMA_VERSION),
        synced_at: synced.map(str::to_string),
    };
    let long_ago = "2020-01-01T00:00:00Z";
    let candidates = vec![
        // Never read: found through the project index.
        CallSyncCandidate {
            source_fingerprint: None,
            schema_version: None,
            ..cand("new", 1, None, None)
        },
        // Read, and the tree has not moved.
        cand(
            "same",
            2,
            Some(same_stamp.fingerprint.clone()),
            Some(long_ago),
        ),
        // Read under an older fingerprint, but read a moment ago.
        cand(
            "fresh",
            4,
            Some("stale".into()),
            Some(&Utc::now().to_rfc3339()),
        ),
        // No transcript at all.
        cand("gone", 5, None, None),
    ];
    let planned = plan(projects, candidates.clone(), None);
    let ids: Vec<i32> = planned.iter().map(|p| p.conversation_id).collect();
    assert_eq!(ids, vec![1]);
    assert_eq!(planned[0].path, projects.join("proj/new.jsonl"));

    // A tree last written before the window is not read.
    let future_cutoff = Utc::now() + chrono::Duration::days(1);
    assert!(plan(projects, candidates, Some(future_cutoff)).is_empty());

    // A changed accounting version reads it again even when unchanged.
    let mut old_schema = cand("same", 2, Some(same_stamp.fingerprint), Some(long_ago));
    old_schema.schema_version = Some(CALL_SCHEMA_VERSION - 1);
    assert_eq!(plan(projects, vec![old_schema], None).len(), 1);
}

#[test]
fn stored_times_parse_in_every_form_sqlite_returns() {
    let want = at("2026-11-23T10:00:00.5Z");
    for raw in [
        "2026-11-23T10:00:00.5Z",
        "2026-11-23T10:00:00.500+00:00",
        "2026-11-23 10:00:00.500+00:00",
        "2026-11-23 10:00:00.500 +00:00",
        "2026-11-23 10:00:00.5",
    ] {
        assert_eq!(parse_stored_time(Some(raw)), Some(want), "{raw}");
    }
    assert_eq!(parse_stored_time(Some("nonsense")), None);
    assert_eq!(parse_stored_time(None), None);
}
