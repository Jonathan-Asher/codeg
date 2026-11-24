//! The pool's per-request usage records: `GET /maxpool/usage/requests`.
//!
//! maxpool appends one metadata record per request it served (account,
//! model, the upstream message and request ids, the Claude Code session id,
//! token counters, the account's weekly reading after and before the
//! response) and serves them with the same key as its status. Nothing in a
//! record is a request or response body. The usage page joins them to the
//! transcripts' calls by message id (`commands::token_usage_accounts`).
//!
//! Same rules as the status read: the key goes only to the address the
//! config names, as a sensitive header, with no redirects; the body is
//! parsed into the allow-listed struct below and capped in size. A pool
//! without the route answers 404 (its `/maxpool/` paths are its own), which
//! reads as [`RecordsError::Unsupported`].

use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use super::{
    clean_label, discover, lenient, lenient_list, Discovery, PoolConfig, ProxyKey, CLIENT,
};

const STATUS_PATH: &str = "/maxpool/status";
const RECORDS_PATH: &str = "/maxpool/usage/requests";
/// A page of 5 000 records is about 2 MB.
const RECORDS_MAX_BYTES: usize = 16 * 1024 * 1024;
const PAGE_LIMIT: u32 = 5_000;
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
const ID_MAX_CHARS: usize = 128;

/// Why a read of the records gave nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordsError {
    /// No pool is configured on this machine.
    NotConfigured,
    /// The pool's config can't be read.
    Unreadable,
    Unreachable,
    Unauthorized,
    /// The pool has no records route (an older or unpatched maxpool), or
    /// switched records off.
    Unsupported,
    InvalidResponse,
}

impl RecordsError {
    pub fn code(self) -> &'static str {
        match self {
            RecordsError::NotConfigured => "not_configured",
            RecordsError::Unreadable => "unreadable_config",
            RecordsError::Unreachable => "unreachable",
            RecordsError::Unauthorized => "unauthorized",
            RecordsError::Unsupported => "unsupported",
            RecordsError::InvalidResponse => "invalid_response",
        }
    }
}

/// One record, allow-listed. Numbers that don't parse read as absent.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PoolRecord {
    #[serde(deserialize_with = "lenient")]
    pub id: Option<String>,
    /// Epoch ms.
    #[serde(deserialize_with = "lenient")]
    pub ts: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    pub account: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub link_row: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub model: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub message_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub request_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub input: Option<u64>,
    #[serde(deserialize_with = "lenient")]
    pub output: Option<u64>,
    #[serde(deserialize_with = "lenient")]
    pub cache_read: Option<u64>,
    #[serde(deserialize_with = "lenient")]
    pub cache_write5m: Option<u64>,
    #[serde(deserialize_with = "lenient")]
    pub cache_write1h: Option<u64>,
    #[serde(deserialize_with = "lenient")]
    pub util7d: Option<f64>,
    #[serde(deserialize_with = "lenient")]
    pub util7d_prev: Option<f64>,
    #[serde(deserialize_with = "lenient")]
    pub reset7d: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawPage {
    #[serde(deserialize_with = "lenient")]
    ok: Option<bool>,
    #[serde(deserialize_with = "lenient_list")]
    records: Vec<PoolRecord>,
    #[serde(deserialize_with = "lenient")]
    next: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RecordsPage {
    pub records: Vec<PoolRecord>,
    pub next: Option<String>,
}

fn clean_id(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let s = raw.trim();
    let ok = !s.is_empty()
        && s.len() <= ID_MAX_CHARS
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.'));
    ok.then(|| s.to_string())
}

/// Keep a record only when it names itself, its time and its account; clean
/// every string the page will show or join on.
pub(crate) fn sanitize(record: PoolRecord) -> Option<PoolRecord> {
    let id = clean_id(record.id)?;
    let ts = record.ts.filter(|t| *t > 0)?;
    let account = clean_label(record.account)?;
    Some(PoolRecord {
        id: Some(id),
        ts: Some(ts),
        account: Some(account),
        kind: clean_label(record.kind)
            .filter(|k| matches!(k.as_str(), "claude" | "provider" | "link")),
        link_row: clean_label(record.link_row),
        model: clean_label(record.model),
        message_id: clean_id(record.message_id),
        request_id: clean_id(record.request_id),
        session_id: clean_id(record.session_id),
        util7d: record.util7d.filter(|u| u.is_finite() && *u >= 0.0),
        util7d_prev: record.util7d_prev.filter(|u| u.is_finite() && *u >= 0.0),
        reset7d: record.reset7d.filter(|t| *t > 0),
        ..record
    })
}

/// Parse one page of the route's answer.
pub(crate) fn parse_page(body: &[u8]) -> Option<RecordsPage> {
    let value: Value = serde_json::from_slice(body).ok()?;
    if !value.is_object() {
        return None;
    }
    let raw: RawPage = serde_json::from_value(value).ok()?;
    if raw.ok != Some(true) {
        return None;
    }
    Some(RecordsPage {
        records: raw.records.into_iter().filter_map(sanitize).collect(),
        next: raw.next.filter(|c| {
            !c.is_empty()
                && c.len() <= 64
                && c.chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | ':'))
        }),
    })
}

fn records_url(config: &PoolConfig) -> String {
    let base = config
        .status_url
        .strip_suffix(STATUS_PATH)
        .unwrap_or(&config.status_url);
    format!("{base}{RECORDS_PATH}")
}

/// The configured pool, or why there is none.
pub(crate) fn pool_config() -> Result<PoolConfig, RecordsError> {
    match discover() {
        Discovery::Found(config) => Ok(config),
        Discovery::Absent => Err(RecordsError::NotConfigured),
        Discovery::Unreadable => Err(RecordsError::Unreadable),
    }
}

/// One page of records with `ts >= since_ms`, from `cursor` on.
pub(crate) async fn fetch_page(
    config: &PoolConfig,
    since_ms: i64,
    cursor: Option<&str>,
) -> Result<RecordsPage, RecordsError> {
    let client = CLIENT.as_ref().ok_or(RecordsError::Unreachable)?;
    let mut query: Vec<(&str, String)> = vec![
        ("since", since_ms.max(0).to_string()),
        ("limit", PAGE_LIMIT.to_string()),
    ];
    if let Some(cursor) = cursor {
        query.push(("cursor", cursor.to_string()));
    }
    let mut request = client
        .get(records_url(config))
        .query(&query)
        .timeout(PAGE_TIMEOUT);
    if let Some(value) = config.key.as_ref().and_then(ProxyKey::header_value) {
        request = request.header("x-api-key", value);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| RecordsError::Unreachable)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(RecordsError::Unauthorized);
    }
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
    {
        return Err(RecordsError::Unsupported);
    }
    if !status.is_success() {
        return Err(RecordsError::InvalidResponse);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RecordsError::Unreachable)?
    {
        if body.len() + chunk.len() > RECORDS_MAX_BYTES {
            return Err(RecordsError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    parse_page(&body).ok_or(RecordsError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_page_into_the_allow_listed_shape() {
        let body = br#"{"ok":true,"schema":1,"count":2,"next":"2026-11-23:4096","records":[
            {"id":"m1abc-1","ts":1763900000123,"account":"eliamarlawoffice","kind":"claude","model":"claude-opus-5-5",
             "messageId":"msg_011A","requestId":"req_011B","sessionId":"749094a3-8cdc-4a98-8b95-b01196467410",
             "input":2,"output":715,"cacheRead":261146,"cacheWrite5m":2169,"cacheWrite1h":0,
             "util7d":0.42,"util7dPrev":0.41,"reset7d":1764000000000,"status":200,"complete":true,
             "prompt":"never read"},
            {"id":"m1abc-2","ts":1763900000999,"account":"jonathanashur@gmail.com","kind":"link","linkRow":"x-cloud"}
        ]}"#;
        let page = parse_page(body).expect("page");
        assert_eq!(page.next.as_deref(), Some("2026-11-23:4096"));
        assert_eq!(page.records.len(), 2);
        let r = &page.records[0];
        assert_eq!(r.account.as_deref(), Some("eliamarlawoffice"));
        assert_eq!(r.message_id.as_deref(), Some("msg_011A"));
        assert_eq!(r.cache_write5m, Some(2169));
        assert_eq!(r.util7d, Some(0.42));
        assert_eq!(page.records[1].kind.as_deref(), Some("link"));
    }

    #[test]
    fn drops_records_without_an_id_time_or_account_and_odd_ids() {
        let body = br#"{"ok":true,"records":[
            {"ts":1,"account":"a"},
            {"id":"x","account":"a"},
            {"id":"y","ts":5},
            {"id":"z","ts":5,"account":"a","messageId":"msg 1; drop","kind":"weird","util7d":-1}
        ]}"#;
        let page = parse_page(body).unwrap();
        assert_eq!(page.records.len(), 1);
        let r = &page.records[0];
        assert_eq!(r.message_id, None);
        assert_eq!(r.kind, None);
        assert_eq!(r.util7d, None);
    }

    #[test]
    fn a_body_that_is_not_an_ok_page_is_invalid() {
        assert!(parse_page(b"[]").is_none());
        assert!(parse_page(br#"{"ok":false,"error":"disabled"}"#).is_none());
        assert!(parse_page(b"not json").is_none());
    }
}
