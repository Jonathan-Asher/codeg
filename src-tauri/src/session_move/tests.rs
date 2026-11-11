//! The move end to end: guards, per-agent files, rows, children, tabs,
//! events, the note to the agent, a rescan afterwards and a move back.
//! Every agent root is a temp dir — never the real `~/.claude` or `~/.pi`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tokio::sync::RwLock;

use super::*;
use crate::acp::session_state::SessionState;
use crate::db::entities::conversation::{self, ConversationLimitResume};
use crate::db::service::{conversation_service, folder_service, tab_service};
use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
use crate::models::{AgentType, OpenedTab};
use crate::web::event_bridge::{
    WebEvent, WebEventBroadcaster, CONVERSATION_CHANGED_EVENT, TABS_CHANGED_EVENT,
};

const SID: &str = "11111111-2222-4333-8444-555555555555";
const OLD: &str = "/work/old-project";
const NEW: &str = "/work/new-project";

struct Fixture {
    db: AppDatabase,
    manager: ConnectionManager,
    env: MoveEnv,
    emitter: EventEmitter,
    events: tokio::sync::broadcast::Receiver<WebEvent>,
    old_folder: i32,
    new_folder: i32,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_paths(OLD, NEW).await
    }

    async fn with_paths(old: &str, new: &str) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let old_folder = seed_folder(&db, old).await;
        let new_folder = seed_folder(&db, new).await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let events = broadcaster.subscribe();
        let env = MoveEnv {
            claude: ClaudeRoots {
                config_dir: tmp.path().join("claude"),
                temp_root: Some(tmp.path().join("claude-tmp")),
            },
            claude_runtime_env: BTreeMap::new(),
            pi: PiRoots {
                sessions_dir: tmp.path().join("pi-sessions"),
                session_map: None,
            },
            claude_support: ClaudeSupport::Known(Some(true)),
            close_timeout: Duration::from_secs(1),
            check_registry: false,
        };
        Self {
            db,
            manager: ConnectionManager::new(),
            env,
            emitter: EventEmitter::test_web_only(broadcaster),
            events,
            old_folder,
            new_folder,
            _tmp: tmp,
        }
    }

    async fn session(&self, agent: AgentType, external_id: Option<&str>) -> i32 {
        let row = conversation_service::create(
            &self.db.conn,
            self.old_folder,
            agent,
            Some("Topic".into()),
            None,
        )
        .await
        .unwrap();
        if let Some(eid) = external_id {
            conversation_service::bind_external_id(&self.db.conn, row.id, eid, &[])
                .await
                .unwrap();
        }
        row.id
    }

    async fn move_to(
        &self,
        id: i32,
        folder: i32,
    ) -> Result<MoveConversationResult, AppCommandError> {
        move_conversation_with(
            &self.db,
            &self.emitter,
            &self.manager,
            &self.env,
            id,
            folder,
            false,
        )
        .await
    }

    async fn dry_run(
        &self,
        id: i32,
        folder: i32,
    ) -> Result<MoveConversationResult, AppCommandError> {
        move_conversation_with(
            &self.db,
            &self.emitter,
            &self.manager,
            &self.env,
            id,
            folder,
            true,
        )
        .await
    }

    async fn row(&self, id: i32) -> conversation::Model {
        conversation::Entity::find_by_id(id)
            .one(&self.db.conn)
            .await
            .unwrap()
            .unwrap()
    }

    async fn set(&self, id: i32, column: conversation::Column, value: sea_orm::Value) {
        conversation::Entity::update_many()
            .col_expr(column, Expr::value(value))
            .filter(conversation::Column::Id.eq(id))
            .exec(&self.db.conn)
            .await
            .unwrap();
    }

    fn claude_transcript(&self, cwd: &str, id: &str) -> PathBuf {
        let dir = self
            .env
            .claude
            .config_dir
            .join("projects")
            .join(crate::commands::quick_ask::claude_project_dir_name(cwd));
        std::fs::create_dir_all(dir.join(id).join("subagents")).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        let record = serde_json::json!({
            "type": "user",
            "sessionId": id,
            "cwd": cwd,
            "timestamp": "2020-01-01T10:00:00.000Z",
            "uuid": "u1",
            "message": {"role": "user", "content": "hello"},
        });
        std::fs::write(&path, format!("{record}\n")).unwrap();
        path
    }

    fn drain(&mut self) -> Vec<WebEvent> {
        let mut out = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            out.push(event);
        }
        out
    }
}

fn refusal(result: Result<MoveConversationResult, AppCommandError>) -> String {
    result.expect_err("refused").detail.unwrap_or_default()
}

// ─── Guards ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn missing_rows_and_folders_are_refused() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Codex, Some("thread-1")).await;
    assert_eq!(
        refusal(fx.move_to(9999, fx.new_folder).await),
        "conversation_not_found"
    );
    assert_eq!(refusal(fx.move_to(id, 9999).await), "folder_not_found");
    assert_eq!(refusal(fx.move_to(id, fx.old_folder).await), "same_folder");
    let err = fx.move_to(id, 9999).await.unwrap_err();
    assert_eq!(err.i18n_key.as_deref(), Some("errors.folder_not_found"));
}

#[tokio::test]
async fn chat_sessions_and_chat_folders_are_refused() {
    let fx = Fixture::new().await;
    let chat = conversation_service::create_chat(
        &fx.db.conn,
        fx.old_folder,
        AgentType::ClaudeCode,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        refusal(fx.move_to(chat.id, fx.new_folder).await),
        "chat_conversation"
    );

    let id = fx.session(AgentType::Codex, Some("thread-1")).await;
    let chat_folder = folder_service::add_chat_folder(&fx.db.conn, "/work/chat-scratch")
        .await
        .unwrap();
    assert_eq!(refusal(fx.move_to(id, chat_folder.id).await), "chat_folder");
}

#[tokio::test]
async fn a_sub_session_and_a_work_task_session_are_refused() {
    let fx = Fixture::new().await;
    let parent = fx.session(AgentType::ClaudeCode, None).await;
    let child = fx.session(AgentType::Codex, None).await;
    fx.set(child, conversation::Column::ParentId, Some(parent).into())
        .await;
    assert_eq!(
        refusal(fx.move_to(child, fx.new_folder).await),
        "subsession"
    );

    let id = fx.session(AgentType::Codex, Some("thread-2")).await;
    let task = crate::db::service::work_task_service::create(
        &fx.db.conn,
        crate::models::WorkTaskDraft {
            folder_id: fx.old_folder,
            title: "a task".into(),
            config: serde_json::json!({}),
        },
    )
    .await
    .unwrap();
    crate::db::entities::work_task::Entity::update_many()
        .col_expr(
            crate::db::entities::work_task::Column::ConversationId,
            Expr::value(Some(id)),
        )
        .filter(crate::db::entities::work_task::Column::Id.eq(task.id))
        .exec(&fx.db.conn)
        .await
        .unwrap();
    assert_eq!(
        refusal(fx.move_to(id, fx.new_folder).await),
        "work_task_linked"
    );
}

#[tokio::test]
async fn a_running_turn_or_a_pending_continuation_is_refused() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Codex, Some("thread-1")).await;

    fx.set(
        id,
        conversation::Column::TurnState,
        Some("running".to_string()).into(),
    )
    .await;
    assert_eq!(
        refusal(fx.move_to(id, fx.new_folder).await),
        "conversation_running"
    );
    assert_eq!(
        refusal(fx.dry_run(id, fx.new_folder).await),
        "conversation_running"
    );
    let err = fx.move_to(id, fx.new_folder).await.unwrap_err();
    assert!(matches!(err.code, AppErrorCode::TurnInProgress), "409");
    fx.set(
        id,
        conversation::Column::TurnState,
        sea_orm::Value::String(None),
    )
    .await;

    fx.set(
        id,
        conversation::Column::AutoResume,
        Some("pending".to_string()).into(),
    )
    .await;
    assert_eq!(
        refusal(fx.move_to(id, fx.new_folder).await),
        "resume_pending"
    );
    fx.set(
        id,
        conversation::Column::AutoResume,
        sea_orm::Value::String(None),
    )
    .await;

    let scheduled: sea_orm::Value = ConversationLimitResume::Scheduled.into();
    fx.set(id, conversation::Column::LimitResumeState, scheduled)
        .await;
    assert_eq!(
        refusal(fx.move_to(id, fx.new_folder).await),
        "resume_pending"
    );
    // With its automatic continuation off, nothing will continue it.
    fx.set(id, conversation::Column::LimitAutoContinue, false.into())
        .await;
    assert!(fx.move_to(id, fx.new_folder).await.is_ok());
}

// ─── Claude Code ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_claude_session_moves_fully_with_its_files_tab_and_events() {
    let mut fx = Fixture::new().await;
    let id = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    let old_transcript = fx.claude_transcript(OLD, SID);
    // An open tab on it, as a client saved it.
    let saved = tab_service::save_all_tabs_cas(
        &fx.db.conn,
        vec![OpenedTab {
            id: 0,
            folder_id: fx.old_folder,
            conversation_id: Some(id),
            agent_type: AgentType::ClaudeCode,
            position: 0,
            is_active: true,
            is_pinned: true,
        }],
        0,
    )
    .await
    .unwrap();
    assert!(saved.accepted);
    fx.drain();

    let result = fx.move_to(id, fx.new_folder).await.expect("moved");
    assert_eq!(result.mode, MoveMode::Full);
    assert_eq!(result.reason, None);
    assert!(!result.dry_run);
    assert_eq!(result.conversation.folder_id, fx.new_folder);
    assert_eq!(result.conversation.working_dir.as_deref(), Some(NEW));

    // Files: moved, not copied, with the relocation record.
    let new_transcript = fx
        .env
        .claude
        .config_dir
        .join("projects")
        .join(crate::commands::quick_ask::claude_project_dir_name(NEW))
        .join(format!("{SID}.jsonl"));
    assert!(!old_transcript.exists());
    assert!(new_transcript.exists());
    assert!(new_transcript
        .with_file_name(SID)
        .join("subagents")
        .is_dir());
    let last = std::fs::read_to_string(&new_transcript)
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .to_string();
    assert_eq!(last, relocate::relocated_record(SID, NEW));

    // The row: new folder, nothing left saying it runs elsewhere, the note
    // for the agent pending.
    let row = fx.row(id).await;
    assert_eq!(row.folder_id, fx.new_folder);
    assert_eq!(row.origin_cwd, None);
    assert_eq!(row.moved_from_cwd.as_deref(), Some(OLD));

    // The tab follows, and every client hears about both.
    let (tabs, _) = tab_service::snapshot_tabs(&fx.db.conn).await.unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].folder_id, fx.new_folder);
    assert!(tabs[0].is_active);
    let events = fx.drain();
    let tab_event = events
        .iter()
        .find(|e| e.channel == TABS_CHANGED_EVENT)
        .expect("tabs://changed");
    assert_eq!(tab_event.payload["origin"], "server");
    assert_eq!(tab_event.payload["tabs"][0]["folder_id"], fx.new_folder);
    let upsert = events
        .iter()
        .find(|e| e.channel == CONVERSATION_CHANGED_EVENT && e.payload["summary"]["id"] == id)
        .expect("conversation://changed");
    assert_eq!(upsert.payload["summary"]["folder_id"], fx.new_folder);
    assert_eq!(upsert.payload["summary"]["working_dir"], NEW);
}

#[tokio::test]
async fn a_dry_run_says_what_would_happen_and_changes_nothing() {
    let mut fx = Fixture::new().await;
    let id = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    let transcript = fx.claude_transcript(OLD, SID);
    let before = fx.row(id).await;
    fx.drain();

    let result = fx.dry_run(id, fx.new_folder).await.unwrap();
    assert!(result.dry_run);
    assert_eq!(result.mode, MoveMode::Full);
    assert_eq!(result.conversation.folder_id, fx.old_folder);
    assert!(transcript.exists());
    assert_eq!(fx.row(id).await, before);
    assert!(fx.drain().is_empty(), "nothing broadcast");
}

#[tokio::test]
async fn an_outdated_claude_adapter_or_missing_files_keep_it_listed_only() {
    let mut fx = Fixture::new().await;
    // No transcript where Claude Code keeps it.
    let id = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    let result = fx.dry_run(id, fx.new_folder).await.unwrap();
    assert_eq!(result.mode, MoveMode::ListedOnly);
    assert_eq!(result.reason, Some(ListedOnlyReason::SessionFilesNotFound));

    fx.claude_transcript(OLD, SID);
    fx.env.claude_support = ClaudeSupport::Known(Some(false));
    let result = fx.move_to(id, fx.new_folder).await.unwrap();
    assert_eq!(result.mode, MoveMode::ListedOnly);
    assert_eq!(result.reason, Some(ListedOnlyReason::ClaudeAdapterOutdated));
    let row = fx.row(id).await;
    assert_eq!(
        row.origin_cwd.as_deref(),
        Some(OLD),
        "keeps running where it ran"
    );
    assert_eq!(
        row.moved_from_cwd, None,
        "the agent's directory did not change"
    );
}

#[tokio::test]
async fn a_session_with_no_agent_session_yet_moves_fully() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::ClaudeCode, None).await;
    let result = fx.move_to(id, fx.new_folder).await.unwrap();
    assert_eq!(result.mode, MoveMode::Full);
    assert_eq!(fx.row(id).await.moved_from_cwd, None, "no agent to tell");
}

// ─── Other agents ────────────────────────────────────────────────────────

#[tokio::test]
async fn codex_and_openclaw_resume_in_the_new_folder_as_they_are() {
    let fx = Fixture::new().await;
    for agent in [AgentType::Codex, AgentType::OpenClaw] {
        let id = fx.session(agent, Some("session-x")).await;
        let result = fx.move_to(id, fx.new_folder).await.unwrap();
        assert_eq!(result.mode, MoveMode::Full, "{agent:?}");
        let row = fx.row(id).await;
        assert_eq!(row.folder_id, fx.new_folder);
        assert_eq!(row.origin_cwd, None);
        assert_eq!(row.moved_from_cwd.as_deref(), Some(OLD));
    }
}

#[tokio::test]
async fn a_pi_session_moves_into_the_new_bucket() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Pi, Some(SID)).await;
    let bucket = fx.env.pi.sessions_dir.join(relocate::pi_bucket_name(OLD));
    std::fs::create_dir_all(&bucket).unwrap();
    let file = bucket.join(format!("2026-11-11T10-00-00-000Z_{SID}.jsonl"));
    std::fs::write(
        &file,
        format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{SID}\",\"cwd\":\"{OLD}\"}}\n"),
    )
    .unwrap();

    let result = fx.move_to(id, fx.new_folder).await.unwrap();
    assert_eq!(result.mode, MoveMode::Full);
    let moved = fx
        .env
        .pi
        .sessions_dir
        .join(relocate::pi_bucket_name(NEW))
        .join(file.file_name().unwrap());
    assert!(!file.exists());
    let header = std::fs::read_to_string(&moved).unwrap();
    assert!(header.contains(&format!("\"cwd\":\"{NEW}\"")), "{header}");
}

#[tokio::test]
async fn gemini_and_the_other_agents_are_listed_only_and_keep_running_where_they_ran() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("old");
    let new = tmp.path().join("new");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(&new).unwrap();
    let (old, new) = (
        old.to_string_lossy().to_string(),
        new.to_string_lossy().to_string(),
    );
    let fx = Fixture::with_paths(&old, &new).await;
    for agent in [AgentType::Gemini, AgentType::OpenCode, AgentType::Cline] {
        let id = fx.session(agent, Some("session-g")).await;
        let preview = fx.dry_run(id, fx.new_folder).await.unwrap();
        assert_eq!(preview.mode, MoveMode::ListedOnly, "{agent:?}");
        assert_eq!(preview.reason, Some(ListedOnlyReason::AgentUnsupported));

        let result = fx.move_to(id, fx.new_folder).await.unwrap();
        assert_eq!(result.conversation.folder_id, fx.new_folder);
        assert_eq!(
            result.conversation.origin_cwd.as_deref(),
            Some(old.as_str())
        );
        // Every reopen connects where it ran.
        assert_eq!(
            result.conversation.working_dir.as_deref(),
            Some(old.as_str())
        );
        assert_eq!(
            conversation_service::working_dir_of(&fx.db.conn, id)
                .await
                .unwrap()
                .as_deref(),
            Some(old.as_str())
        );

        // Moving it back clears the note.
        let back = fx.move_to(id, fx.old_folder).await.unwrap();
        assert_eq!(back.conversation.origin_cwd, None);
        assert_eq!(back.conversation.working_dir.as_deref(), Some(old.as_str()));
    }
}

#[tokio::test]
async fn a_removed_origin_directory_falls_back_to_the_folder() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Gemini, Some("session-g")).await;
    fx.set(
        id,
        conversation::Column::OriginCwd,
        Some("/work/gone-worktree".to_string()).into(),
    )
    .await;
    assert_eq!(
        conversation_service::working_dir_of(&fx.db.conn, id)
            .await
            .unwrap()
            .as_deref(),
        Some(OLD)
    );
    let summary = conversation_service::get_by_id(&fx.db.conn, id)
        .await
        .unwrap();
    assert_eq!(summary.working_dir.as_deref(), Some(OLD));
}

// ─── Children, move back, rescan ─────────────────────────────────────────

#[tokio::test]
async fn sub_sessions_in_the_same_folder_move_along_and_others_stay() {
    let fx = Fixture::new().await;
    let parent = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    fx.claude_transcript(OLD, SID);
    let child_sid = "22222222-2222-4333-8444-555555555555";
    let child = fx.session(AgentType::ClaudeCode, Some(child_sid)).await;
    fx.claude_transcript(OLD, child_sid);
    fx.set(child, conversation::Column::ParentId, Some(parent).into())
        .await;
    let grandchild = fx.session(AgentType::Codex, Some("thread-gc")).await;
    fx.set(
        grandchild,
        conversation::Column::ParentId,
        Some(child).into(),
    )
    .await;
    let elsewhere_folder = seed_folder(&fx.db, "/work/elsewhere").await;
    let elsewhere = fx.session(AgentType::Codex, Some("thread-e")).await;
    fx.set(
        elsewhere,
        conversation::Column::ParentId,
        Some(parent).into(),
    )
    .await;
    fx.set(
        elsewhere,
        conversation::Column::FolderId,
        elsewhere_folder.into(),
    )
    .await;

    let result = fx.move_to(parent, fx.new_folder).await.unwrap();
    let mut children = result.moved_children.clone();
    children.sort_unstable();
    let mut expected = vec![child, grandchild];
    expected.sort_unstable();
    assert_eq!(children, expected);
    assert_eq!(fx.row(child).await.folder_id, fx.new_folder);
    assert_eq!(fx.row(grandchild).await.folder_id, fx.new_folder);
    assert_eq!(fx.row(elsewhere).await.folder_id, elsewhere_folder);
    let child_file = fx
        .env
        .claude
        .config_dir
        .join("projects")
        .join(crate::commands::quick_ask::claude_project_dir_name(NEW))
        .join(format!("{child_sid}.jsonl"));
    assert!(child_file.exists(), "the child's transcript moved too");

    // A running child holds the whole move.
    let other = fx.session(AgentType::Codex, Some("thread-o")).await;
    let busy_child = fx.session(AgentType::Codex, Some("thread-b")).await;
    fx.set(
        busy_child,
        conversation::Column::ParentId,
        Some(other).into(),
    )
    .await;
    fx.set(
        busy_child,
        conversation::Column::TurnState,
        Some("running".to_string()).into(),
    )
    .await;
    assert_eq!(
        refusal(fx.move_to(other, fx.new_folder).await),
        "conversation_running"
    );
}

#[tokio::test]
async fn moving_back_before_the_agent_heard_needs_no_note() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    let original = fx.claude_transcript(OLD, SID);
    fx.move_to(id, fx.new_folder).await.unwrap();
    assert_eq!(fx.row(id).await.moved_from_cwd.as_deref(), Some(OLD));
    let back = fx.move_to(id, fx.old_folder).await.unwrap();
    assert_eq!(back.mode, MoveMode::Full);
    let row = fx.row(id).await;
    assert_eq!(row.folder_id, fx.old_folder);
    assert_eq!(row.moved_from_cwd, None, "back where the agent last ran");
    assert!(
        original.exists(),
        "the transcript is back in its project folder"
    );
}

#[tokio::test]
async fn a_rescan_neither_duplicates_nor_moves_it_back() {
    use crate::parsers::AgentParser;
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::ClaudeCode, Some(SID)).await;
    fx.claude_transcript(OLD, SID);
    fx.move_to(id, fx.new_folder).await.unwrap();

    let parser = crate::parsers::claude::ClaudeParser::with_base_dir(
        fx.env.claude.config_dir.join("projects"),
    );
    let summaries = parser.list_conversations().unwrap();
    let summary = summaries
        .into_iter()
        .find(|s| s.id == SID)
        .expect("the moved session is listed");
    let listed_folder = summary.folder_path.clone();
    // The relocation record files it under the new directory — where a
    // restore from the import picker would put it.
    assert_eq!(listed_folder.as_deref(), Some(NEW));

    let detail = parser.get_conversation(SID).unwrap();
    assert_eq!(detail.summary.folder_path.as_deref(), Some(NEW));

    // A rescan of the OLD folder finds the row by its session and leaves it.
    crate::db::service::import_service::import_summaries(
        &fx.db.conn,
        fx.old_folder,
        &[(AgentType::ClaudeCode, summary)],
        crate::db::service::import_service::DeletedPolicy::Skip,
    )
    .await
    .unwrap();
    let rows = conversation::Entity::find()
        .filter(conversation::Column::ExternalId.eq(SID))
        .all(&fx.db.conn)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1, "no duplicate");
    assert_eq!(rows[0].folder_id, fx.new_folder, "not moved back");
}

// ─── The note to the agent ───────────────────────────────────────────────

fn session_in(dir: &str) -> Arc<RwLock<SessionState>> {
    Arc::new(RwLock::new(SessionState::new(
        "c1".into(),
        AgentType::ClaudeCode,
        Some(Path::new(dir).to_path_buf()),
        "main".into(),
        None,
    )))
}

#[tokio::test]
async fn the_first_message_after_a_full_move_carries_the_note_once() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Codex, Some("thread-1")).await;
    fx.move_to(id, fx.new_folder).await.unwrap();

    // A connection still in the old directory says nothing (it would be false).
    assert!(pending_note(&fx.db.conn, id, &session_in(OLD))
        .await
        .is_none());

    let note = pending_note(&fx.db.conn, id, &session_in(NEW))
        .await
        .expect("a note");
    assert_eq!(note.from, OLD);
    let (text, _) =
        crate::acp::internal_frames::strip_all_with_talk(&format!("go on{}", note.frame));
    assert_eq!(text, "go on", "hidden from history");
    assert!(note.frame.contains(&crate::acp::move_frame::note(OLD, NEW)));

    note_delivered(&fx.db.conn, id, &note).await;
    assert!(pending_note(&fx.db.conn, id, &session_in(NEW))
        .await
        .is_none());
    assert_eq!(fx.row(id).await.moved_from_cwd, None);
}

#[tokio::test]
async fn a_later_move_keeps_its_own_note() {
    let fx = Fixture::new().await;
    let id = fx.session(AgentType::Codex, Some("thread-1")).await;
    fx.move_to(id, fx.new_folder).await.unwrap();
    let stale = pending_note(&fx.db.conn, id, &session_in(NEW))
        .await
        .unwrap();
    // Moved again before the note went out: it still starts where the agent
    // last ran.
    let third = seed_folder(&fx.db, "/work/third").await;
    fx.move_to(id, third).await.unwrap();
    assert_eq!(fx.row(id).await.moved_from_cwd.as_deref(), Some(OLD));
    // A delivery for a note that no longer stands clears only that one.
    fx.set(
        id,
        conversation::Column::MovedFromCwd,
        Some("/work/elsewhere".to_string()).into(),
    )
    .await;
    note_delivered(&fx.db.conn, id, &stale).await;
    assert_eq!(
        fx.row(id).await.moved_from_cwd.as_deref(),
        Some("/work/elsewhere")
    );
}

#[tokio::test]
async fn re_filing_no_open_tab_still_bumps_the_version_without_a_broadcast() {
    let fx = Fixture::new().await;
    let before = tab_service::get_tabs_version(&fx.db.conn).await.unwrap();
    let moved = tab_service::move_conversation_tabs_and_bump(&fx.db.conn, &[42], fx.new_folder)
        .await
        .unwrap();
    assert_eq!(moved.version, before + 1, "a barrier for stale saves");
    assert!(moved.emit.is_none());
}
