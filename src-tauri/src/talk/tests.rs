use std::sync::Arc;

use tokio::sync::mpsc;

use super::*;
use crate::acp::connection::{ConnectionCommand, PromptTalk, SteerOutcome};
use crate::acp::error::AcpError;
use crate::acp::types::{AcpEvent, UserMessageBlock};
use crate::db::service::conversation_service::read_talk_state;
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::db::AppDatabase;
use crate::web::event_bridge::WebEventBroadcaster;

fn text(t: &str) -> Vec<PromptInputBlock> {
    vec![PromptInputBlock::Text { text: t.into() }]
}

fn image() -> PromptInputBlock {
    PromptInputBlock::Image {
        data: "iVBORw0KGgo=".into(),
        mime_type: "image/png".into(),
        uri: None,
    }
}

/// What a frame on the wire says, or `None` without one.
fn frame_info(frame: &Option<String>) -> Option<talk_frame::TalkFrameInfo> {
    frame.as_deref().map(|frame| {
        let (rest, info) = talk_frame::strip(frame);
        assert_eq!(rest, "", "a frame is a block of its own");
        info.expect("an intact talk frame")
    })
}

fn mode_of(frame: &Option<String>) -> Option<TalkFrameMode> {
    frame_info(frame).map(|info| info.mode)
}

/// A conversation with a live (test) connection whose command channel the
/// test reads, playing the connection loop.
struct Fixture {
    db: AppDatabase,
    mgr: ConnectionManager,
    rx: mpsc::Receiver<ConnectionCommand>,
    cid: i32,
    broadcaster: Arc<WebEventBroadcaster>,
}

const CONN: &str = "talk-conn";

async fn fixture(agent: AgentType) -> Fixture {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/codeg-talk").await;
    let cid = seed_conversation(&db, folder, agent).await;
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let mgr = ConnectionManager::new();
    let rx = mgr
        .insert_test_connection_live(CONN, agent, None, emitter)
        .await;
    {
        let state = mgr.get_state(CONN).await.unwrap();
        let mut s = state.write().await;
        s.conversation_id = Some(cid);
        s.folder_id = Some(folder);
    }
    Fixture {
        db,
        mgr,
        rx,
        cid,
        broadcaster,
    }
}

struct SentPrompt {
    blocks: Vec<PromptInputBlock>,
    user_message: Option<(String, Vec<UserMessageBlock>)>,
    talk: PromptTalk,
}

impl Fixture {
    fn emitter(&self) -> EventEmitter {
        EventEmitter::test_web_only(self.broadcaster.clone())
    }

    async fn session(&self) -> Arc<RwLock<SessionState>> {
        self.mgr.get_state(CONN).await.unwrap()
    }

    async fn state(&self) -> Option<ConversationTalkState> {
        read_talk_state(&self.db.conn, self.cid)
            .await
            .unwrap()
            .flatten()
    }

    async fn set_talk(&self, enabled: bool) {
        set_conversation_talk_mode_core(
            &self.db.conn,
            &self.emitter(),
            &self.mgr,
            self.cid,
            enabled,
        )
        .await
        .expect("switch talk");
    }

    /// Send a client prompt; the turn it starts ends at once. Returns what
    /// the connection loop received.
    async fn prompt(&mut self, blocks: Vec<PromptInputBlock>, spoken: bool) -> SentPrompt {
        self.mgr
            // Already linked: no folder or conversation to name.
            .send_client_prompt_spoken(&self.db, CONN, blocks, None, None, None, spoken)
            .await
            .expect("prompt accepted");
        self.session().await.write().await.turn_in_flight = false;
        match self.rx.try_recv() {
            Ok(ConnectionCommand::Prompt {
                blocks,
                user_message,
                talk,
            }) => SentPrompt {
                blocks,
                user_message,
                talk,
            },
            _ => panic!("expected a prompt command"),
        }
    }
}

#[test]
fn frame_mode_follows_the_state_and_the_connection() {
    assert_eq!(frame_mode(None, false), None);
    assert_eq!(frame_mode(None, true), None);
    assert_eq!(
        frame_mode(Some(ConversationTalkState::On), false),
        Some(TalkFrameMode::Full)
    );
    assert_eq!(
        frame_mode(Some(ConversationTalkState::On), true),
        Some(TalkFrameMode::Compact)
    );
    for delivered in [false, true] {
        assert_eq!(
            frame_mode(Some(ConversationTalkState::Ending), delivered),
            Some(TalkFrameMode::Off)
        );
    }
}

#[test]
fn only_messages_with_text_that_are_not_commands_carry_a_frame() {
    assert!(carries_frame(&text("תבדוק את הבילד")));
    assert!(carries_frame(&[image(), text("what is this?")[0].clone()]));
    assert!(!carries_frame(&[image()]));
    assert!(!carries_frame(&text("   ")));
    assert!(!carries_frame(&text("/compact keep the plan")));
    assert!(!carries_frame(&text("  /clear")));
    assert!(clears_context(&text("/clear")));
    assert!(clears_context(&text("/compact keep the plan")));
    assert!(!clears_context(&text("/clearly not")));
    assert!(!clears_context(&text("/model")));
}

#[tokio::test]
async fn settings_round_trip_and_unknown_values_read_as_auto() {
    let db = fresh_in_memory_db().await;
    assert_eq!(load_talk_settings(&db.conn).await, TalkSettings::default());
    let mine = TalkSettings {
        language: TalkLanguage::He,
        address: TalkAddress::Masculine,
    };
    save_talk_settings(&db.conn, mine).await.unwrap();
    assert_eq!(load_talk_settings(&db.conn).await, mine);
    assert_eq!(
        serde_json::to_value(mine).unwrap(),
        serde_json::json!({"language": "he", "address": "masculine"})
    );
    let odd: TalkSettings =
        serde_json::from_str(r#"{"language":"fr","address":"neutral"}"#).unwrap();
    assert_eq!(odd, TalkSettings::default());
    let partial: TalkSettings = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
    assert_eq!(partial.language, TalkLanguage::En);
    assert_eq!(partial.address, TalkAddress::Auto);
}

#[test]
fn the_rules_key_names_settings_and_agent() {
    let auto = TalkSettings::default();
    let mine = TalkSettings {
        language: TalkLanguage::He,
        address: TalkAddress::Masculine,
    };
    assert_eq!(
        rules_key(auto, AgentType::Pi),
        rules_key(auto, AgentType::Pi)
    );
    assert_ne!(
        rules_key(auto, AgentType::Pi),
        rules_key(mine, AgentType::Pi)
    );
    assert_ne!(
        rules_key(auto, AgentType::Pi),
        rules_key(auto, AgentType::ClaudeCode)
    );
}

#[tokio::test]
async fn switching_talk_broadcasts_and_never_moves_updated_at() {
    let f = fixture(AgentType::Pi).await;
    let before = conversation_service::get_by_id(&f.db.conn, f.cid)
        .await
        .unwrap();
    assert!(!before.talk_mode);
    let mut rx = f.broadcaster.subscribe();

    f.set_talk(true).await;
    assert_eq!(f.state().await, Some(ConversationTalkState::On));
    let event = rx.try_recv().expect("the row is broadcast");
    assert_eq!(event.channel, "conversation://changed");
    assert_eq!(event.payload["summary"]["talk_mode"], true);

    f.set_talk(false).await;
    assert_eq!(f.state().await, Some(ConversationTalkState::Ending));
    let event = rx.try_recv().expect("the row is broadcast");
    assert_eq!(event.payload["summary"]["talk_mode"], false);

    let after = conversation_service::get_by_id(&f.db.conn, f.cid)
        .await
        .unwrap();
    assert_eq!(after.updated_at, before.updated_at);
}

#[tokio::test]
async fn off_stays_off_and_an_unknown_conversation_is_not_found() {
    let f = fixture(AgentType::Pi).await;
    f.set_talk(false).await;
    assert_eq!(f.state().await, None, "never on: nothing to tell the agent");
    let err = set_conversation_talk_mode_core(&f.db.conn, &f.emitter(), &f.mgr, 999_999, true)
        .await
        .unwrap_err();
    assert!(matches!(err.code, crate::app_error::AppErrorCode::NotFound));
}

/// The whole cycle on the wire: Full once, then the reminder, Off once after
/// Talk is turned off, then nothing. The ledger, the broadcast and what the
/// manager enqueues keep the user's own blocks; only `talk.frame` carries the
/// note, which the connection loop appends at the agent boundary.
#[tokio::test]
async fn prompts_carry_full_then_compact_then_off_then_nothing() {
    let mut f = fixture(AgentType::Pi).await;
    f.set_talk(true).await;

    let first = f.prompt(text("תבדוק למה הבילד נופל"), true).await;
    assert!(matches!(
        first.blocks.as_slice(),
        [PromptInputBlock::Text { text }] if text == "תבדוק למה הבילד נופל"
    ));
    let info = frame_info(&first.talk.frame).expect("a frame");
    assert_eq!(info.mode, TalkFrameMode::Full);
    assert!(info.spoken);
    assert!(first.talk.spoken);
    let (_, user_blocks) = first.user_message.expect("broadcast");
    assert!(matches!(
        user_blocks.as_slice(),
        [UserMessageBlock::Text { text }] if text == "תבדוק למה הבילד נופל"
    ));

    let second = f.prompt(text("and the tests?"), false).await;
    let info = frame_info(&second.talk.frame).expect("a frame");
    assert_eq!(info.mode, TalkFrameMode::Compact);
    assert!(!info.spoken, "typed while Talk is on");
    assert!(!second.talk.spoken);

    f.set_talk(false).await;
    let third = f.prompt(text("back at the desk"), false).await;
    assert_eq!(mode_of(&third.talk.frame), Some(TalkFrameMode::Off));
    assert_eq!(f.state().await, None, "the Off note ends Talk");
    assert_eq!(f.session().await.read().await.talk_rules_key, None);

    let fourth = f.prompt(text("normal again"), false).await;
    assert_eq!(fourth.talk.frame, None);
}

#[tokio::test]
async fn a_spoken_prompt_turns_talk_on_with_the_full_rules() {
    let mut f = fixture(AgentType::Pi).await;
    let mut rx = f.broadcaster.subscribe();
    let sent = f.prompt(text("hey"), true).await;
    assert_eq!(f.state().await, Some(ConversationTalkState::On));
    assert_eq!(mode_of(&sent.talk.frame), Some(TalkFrameMode::Full));
    let mut saw_on = false;
    while let Ok(event) = rx.try_recv() {
        if event.channel == "conversation://changed"
            && event.payload["summary"]["talk_mode"] == true
        {
            saw_on = true;
        }
    }
    assert!(saw_on, "every client hears Talk turned on");

    // A spoken message while Talk is ending turns it back on: the full rules
    // again, never the Off note.
    f.set_talk(false).await;
    let again = f.prompt(text("one more thing"), true).await;
    assert_eq!(mode_of(&again.talk.frame), Some(TalkFrameMode::Full));
    assert_eq!(f.state().await, Some(ConversationTalkState::On));
}

#[tokio::test]
async fn commands_and_images_carry_no_frame_and_clear_sends_the_rules_again() {
    let mut f = fixture(AgentType::Pi).await;
    f.set_talk(true).await;
    assert_eq!(
        mode_of(&f.prompt(text("hi"), true).await.talk.frame),
        Some(TalkFrameMode::Full)
    );
    assert_eq!(f.prompt(vec![image()], false).await.talk.frame, None);
    assert_eq!(f.prompt(text("/clear"), false).await.talk.frame, None);
    assert_eq!(
        mode_of(&f.prompt(text("hi again"), true).await.talk.frame),
        Some(TalkFrameMode::Full),
        "the rules left the context with /clear"
    );

    // In `ending`, a command does not use up the Off note.
    f.set_talk(false).await;
    assert_eq!(f.prompt(text("/model"), false).await.talk.frame, None);
    assert_eq!(f.state().await, Some(ConversationTalkState::Ending));
    assert_eq!(
        mode_of(&f.prompt(text("thanks"), false).await.talk.frame),
        Some(TalkFrameMode::Off)
    );
}

/// Prompts that do not come from a client (the delegation broker, chat
/// channels, automations) never carry a frame.
#[tokio::test]
async fn other_senders_carry_no_frame() {
    let mut f = fixture(AgentType::Pi).await;
    f.set_talk(true).await;
    f.mgr
        .send_prompt_linked(&f.db, CONN, text("from a channel"), None, None, None)
        .await
        .expect("sent");
    match f.rx.try_recv() {
        Ok(ConnectionCommand::Prompt { talk, .. }) => {
            assert_eq!(talk.frame, None);
            assert!(!talk.spoken);
        }
        _ => panic!("expected a prompt"),
    }
}

#[tokio::test]
async fn a_completed_compaction_or_new_settings_send_the_full_rules_again() {
    let mut f = fixture(AgentType::Pi).await;
    f.set_talk(true).await;
    f.prompt(text("one"), true).await;
    assert_eq!(
        mode_of(&f.prompt(text("two"), true).await.talk.frame),
        Some(TalkFrameMode::Compact)
    );

    // A compaction still running changes nothing; a completed one does.
    let card = |status: &str| AcpEvent::ToolCallUpdate {
        tool_call_id: "compaction-1".into(),
        title: Some("Context compaction".into()),
        status: Some(status.into()),
        content: None,
        raw_input: None,
        raw_output: None,
        raw_output_append: None,
        locations: None,
        meta: Some(serde_json::json!({"contextCompaction": {"version": 1}})),
        images: None,
    };
    f.session()
        .await
        .write()
        .await
        .apply_event(&card("in_progress"));
    assert_eq!(
        mode_of(&f.prompt(text("three"), true).await.talk.frame),
        Some(TalkFrameMode::Compact)
    );
    f.session()
        .await
        .write()
        .await
        .apply_event(&card("completed"));
    assert_eq!(
        mode_of(&f.prompt(text("four"), true).await.talk.frame),
        Some(TalkFrameMode::Full)
    );

    save_talk_settings(
        &f.db.conn,
        TalkSettings {
            language: TalkLanguage::He,
            address: TalkAddress::Masculine,
        },
    )
    .await
    .unwrap();
    let sent = f.prompt(text("five"), true).await;
    assert_eq!(mode_of(&sent.talk.frame), Some(TalkFrameMode::Full));
    let (body, _) = talk_frame::strip(&format!("x{}", sent.talk.frame.unwrap()));
    assert_eq!(body, "x");
}

/// The channel back, the blocks an insert carried and its talk frame.
type AnsweredSteer = (
    mpsc::Receiver<ConnectionCommand>,
    Vec<PromptInputBlock>,
    Option<String>,
);

/// Play the connection loop's role for one insert: answer `outcome` and hand
/// back the frame the command carried.
fn answer_steer(
    mut rx: mpsc::Receiver<ConnectionCommand>,
    outcome: SteerOutcome,
) -> tokio::task::JoinHandle<AnsweredSteer> {
    tokio::spawn(async move {
        match rx.recv().await {
            Some(ConnectionCommand::Steer {
                blocks,
                talk_frame,
                reply,
            }) => {
                let _ = reply.send(Ok(outcome));
                (rx, blocks, talk_frame)
            }
            _ => panic!("expected a Steer command"),
        }
    })
}

/// An insert (an interruption by voice) carries the frame on the wire, the
/// recorded note stays as the user said it and says it was spoken, and the
/// rules count as delivered only when the insert was injected.
#[tokio::test]
async fn an_insert_carries_the_frame_and_counts_only_when_injected() {
    let f = fixture(AgentType::Pi).await;
    {
        let session = f.session().await;
        let mut s = session.write().await;
        s.native_steering_available = true;
        s.turn_in_flight = true;
    }
    f.set_talk(true).await;
    let Fixture {
        db,
        mgr,
        rx,
        cid: _,
        broadcaster: _,
    } = f;

    // Not consumed: the turn ended first. Nothing counts as delivered.
    let answer = answer_steer(rx, SteerOutcome::PromptRequired);
    let err = mgr
        .submit_client_feedback_spoken(
            &db,
            CONN,
            "רגע, עצור".into(),
            None,
            Some("optimistic-a".into()),
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AcpError::NoActiveTurn));
    let (rx, blocks, frame) = answer.await.unwrap();
    assert_eq!(mode_of(&frame), Some(TalkFrameMode::Full));
    assert!(matches!(
        blocks.as_slice(),
        [PromptInputBlock::Text { text }] if text == "רגע, עצור"
    ));
    assert_eq!(
        mgr.get_state(CONN)
            .await
            .unwrap()
            .read()
            .await
            .talk_rules_key,
        None
    );

    // Injected: delivered, and the next insert carries only the reminder.
    let answer = answer_steer(rx, SteerOutcome::Injected);
    let item = mgr
        .submit_client_feedback_spoken(
            &db,
            CONN,
            "רגע, עצור".into(),
            None,
            Some("optimistic-b".into()),
            true,
        )
        .await
        .expect("injected");
    assert!(item.spoken);
    assert_eq!(item.text, "רגע, עצור");
    let (rx, _, frame) = answer.await.unwrap();
    assert_eq!(mode_of(&frame), Some(TalkFrameMode::Full));
    assert!(mgr
        .get_state(CONN)
        .await
        .unwrap()
        .read()
        .await
        .talk_rules_key
        .is_some());

    let answer = answer_steer(rx, SteerOutcome::Injected);
    mgr.submit_client_feedback_spoken(&db, CONN, "וגם את הטסטים".into(), None, None, true)
        .await
        .expect("injected");
    let (_, _, frame) = answer.await.unwrap();
    assert_eq!(mode_of(&frame), Some(TalkFrameMode::Compact));
}

/// A note on the pull channel (no native steering) carries no frame, still
/// says it was spoken, and still turns Talk on.
#[tokio::test]
async fn a_pulled_note_is_spoken_but_carries_no_frame() {
    let f = fixture(AgentType::Pi).await;
    {
        let session = f.session().await;
        let mut s = session.write().await;
        s.feedback_tool_available = true;
        s.turn_in_flight = true;
    }
    let item = f
        .mgr
        .submit_client_feedback_spoken(&f.db, CONN, "תעצור".into(), None, None, true)
        .await
        .expect("queued for the pull tool");
    assert!(item.spoken);
    assert_eq!(f.state().await, Some(ConversationTalkState::On));
    assert_eq!(f.session().await.read().await.talk_rules_key, None);
}
