use super::*;
use serde_json::json;

fn caps() -> PiLiveCaps {
    PiLiveCaps {
        agent_turns: true,
        custom_messages: true,
        subagents: true,
        background_jobs: true,
        compaction: true,
        async_tasks: true,
    }
}

fn live_state() -> PiLiveState {
    PiLiveState {
        caps: Some(caps()),
        ..PiLiveState::default()
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

#[test]
fn caps_come_from_pi_acps_initialize_meta() {
    let meta = object(json!({
        "steering": {"supported": true},
        "piAcp": {"capabilities": {"version": 1, "agentTurns": 1, "customMessages": 1,
            "subagents": 1, "backgroundJobs": 1, "compaction": 1, "extensionCommands": 1, "replay": 1}},
        "jetbrains": {"air": {"version": 1, "capabilities": ["asyncTasks"]}}
    }));
    assert_eq!(
        PiLiveCaps::from_init_meta(AgentType::Pi, Some(&meta)),
        Some(caps())
    );
    let older = object(json!({"steering": {"supported": true}}));
    assert_eq!(
        PiLiveCaps::from_init_meta(AgentType::Pi, Some(&older)),
        None
    );
    assert_eq!(
        PiLiveCaps::from_init_meta(AgentType::ClaudeCode, Some(&meta)),
        None,
        "piAcp is pi-acp's namespace"
    );
    let no_air = object(json!({"piAcp": {"capabilities": {"agentTurns": 1}}}));
    let caps = PiLiveCaps::from_init_meta(AgentType::Pi, Some(&no_air)).expect("caps");
    assert!(caps.agent_turns && !caps.async_tasks && !caps.subagents);
}

#[test]
fn only_a_launch_is_marked_as_a_sub_agent() {
    let launch = object(json!({"piAcp": {"subagent": {"version": 1, "role": "run"}}}));
    let control = object(
        json!({"piAcp": {"subagent": {"version": 1, "role": "control", "action": "status"}}}),
    );
    assert!(marks_subagent(AgentType::Pi, Some(&launch)));
    assert!(!marks_subagent(AgentType::Pi, Some(&control)));
    assert!(!marks_subagent(AgentType::Codex, Some(&launch)));
    assert!(!marks_subagent(AgentType::Pi, None));
}

#[test]
fn a_run_frame_gets_the_history_card_and_input() {
    let mut pi = live_state();
    let args = json!({"agent": "scout", "async": true, "task": "Run ls in the current directory."});
    let mut raw_input = Some(args.to_string());
    let mut meta = Some(json!({"piAcp": {
        "subagent": {"version": 1, "role": "run", "tool": "subagent"},
        "subagentRun": {"version": 1, "toolCallId": "call-1", "mode": "single", "async": true,
            "status": "running", "agent": "scout",
            "children": [{"key": "#0", "label": "scout", "agent": "scout", "status": "pending"}]}
    }}));
    let card = pi
        .decorate_call(
            "call-1",
            Some(&args),
            &mut raw_input,
            &mut meta,
            Some("Async: scout [r-1]\nDetached."),
            Some("completed"),
        )
        .expect("a card update");
    let meta = meta.expect("meta");
    assert_eq!(meta["codeg.subagentRun"]["status"], "running");
    assert_eq!(meta["codeg.subagentRun"]["notes"][0]["kind"], "launch");
    assert_eq!(meta["piAcp"]["subagent"]["role"], "run", "the marker stays");
    assert!(
        meta["piAcp"].get("subagentRun").is_none(),
        "the raw card does not"
    );
    let input: Value = serde_json::from_str(raw_input.as_deref().expect("input")).unwrap();
    assert_eq!(input["subagent_type"], "scout");
    assert_eq!(input["description"], "Run ls in the current directory.");
    let AcpEvent::ToolCard { tool_call_id, meta } = card else {
        panic!("not a card");
    };
    assert_eq!(tool_call_id, "call-1");
    assert_eq!(meta["codeg.subagentRun"]["agent"], "scout");
    assert!(
        meta.get("piAcp").is_none(),
        "a card update carries the card only"
    );
}

#[test]
fn a_frame_without_pi_meta_is_left_alone() {
    let mut pi = live_state();
    let mut raw_input = Some("{\"command\":\"ls\"}".to_string());
    let mut meta = Some(json!({"terminal_info": {"terminal_id": "t"}}));
    assert!(pi
        .decorate_call("c", None, &mut raw_input, &mut meta, None, None)
        .is_none());
    assert_eq!(meta, Some(json!({"terminal_info": {"terminal_id": "t"}})));
    assert_eq!(raw_input.as_deref(), Some("{\"command\":\"ls\"}"));

    let mut inert = PiLiveState::default();
    let mut meta = Some(json!({"piAcp": {"backgroundJob": {"state": "running"}}}));
    assert!(inert
        .decorate_call("c", None, &mut raw_input, &mut meta, None, None)
        .is_none());
    assert!(
        meta.unwrap()["piAcp"].get("backgroundJob").is_some(),
        "no caps, no rewrite"
    );
}

#[test]
fn a_workflows_child_launches_and_answered_replies_are_not_drawn() {
    let mut pi = live_state();
    let mut meta = Some(json!({"piAcp": {
        "subagent": {"version": 1, "role": "run"},
        "subagentRun": {"version": 1, "toolCallId": "wf", "mode": "workflow", "status": "running",
            "children": [{"key": "lane", "agent": "worker", "status": "running",
                "exchanges": [{"requestId": "q-1", "question": "Which branch?"}]}]}
    }}));
    pi.decorate_call("wf", None, &mut None, &mut meta, None, None);
    assert!(pi.drops_call("wf/1", Some("subagent_launch"), None));
    assert!(
        pi.drops_call("wf/1", None, None),
        "later frames follow the first"
    );
    assert!(!pi.drops_call("other/1", Some("subagent_launch"), None));
    let reply = json!({"action": "reply", "replyTo": "q-1", "message": "main"});
    assert!(pi.drops_call("r-call", Some("subagent_supervisor"), Some(&reply)));
    let unknown = json!({"action": "reply", "replyTo": "q-9", "message": "?"});
    assert!(!pi.drops_call("r-other", Some("subagent_supervisor"), Some(&unknown)));
    assert!(!pi.drops_call("wf", Some("agent"), None));
}

#[test]
fn stop_reasons_map_onto_codegs() {
    assert_eq!(stop_reason(Some("end_turn"), Some("settled")), "end_turn");
    assert_eq!(
        stop_reason(Some("max_tokens"), Some("settled")),
        "max_tokens"
    );
    assert_eq!(
        stop_reason(Some("cancelled"), Some("cancelled")),
        "cancelled"
    );
    assert_eq!(stop_reason(Some("error"), Some("settled")), "rejected");
    assert_eq!(stop_reason(None, Some("processExited")), "cancelled");
    assert_eq!(stop_reason(None, None), "end_turn");
}

#[test]
fn stop_and_a_prompt_end_the_agent_turn_bookkeeping() {
    let mut pi = live_state();
    pi.turn = Some(AgentTurn {
        id: "t-1".into(),
        wake: None,
        output: false,
    });
    assert!(pi.agent_turn_open());
    assert!(pi.cancel_turn());
    assert!(!pi.agent_turn_open());
    assert!(pi.finished.contains(&"t-1".to_string()));
    assert!(!pi.cancel_turn(), "nothing left to stop");
    pi.turn = Some(AgentTurn {
        id: "t-2".into(),
        wake: None,
        output: false,
    });
    pi.close = Some(TurnClose {
        stop_reason: "end_turn",
        error: None,
    });
    pi.prompt_started();
    assert!(!pi.agent_turn_open());
    assert!(pi.take_close().is_none());
}
