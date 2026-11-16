//! The `codeg-mcp` companion builds without this library, so its own tests
//! cannot see the built-in agent list. This checks, from codeg's side, that
//! the `delegate_to_agent` schema it embeds enumerates exactly the built-in
//! agents codeg has, in their wire spelling.

use codeg_lib::models::agent::BUILTIN_AGENT_TYPES;

const TOOL_SCHEMA_JSON: &str = include_str!("../../codeg-mcp/src/tool_schema.json");

#[test]
fn the_delegate_schema_enumerates_every_builtin_agent() {
    let schema: serde_json::Value = serde_json::from_str(TOOL_SCHEMA_JSON).unwrap();
    let agents: Vec<String> = schema
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "delegate_to_agent")
        .unwrap()["inputSchema"]["properties"]["agent_type"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent.as_str().unwrap().to_string())
        .collect();
    assert_eq!(agents.len(), BUILTIN_AGENT_TYPES.len(), "{agents:?}");
    for agent in BUILTIN_AGENT_TYPES {
        let wire = agent.as_wire();
        assert!(
            agents.iter().any(|a| a == wire.as_ref()),
            "{wire} is missing from the schema"
        );
    }
}
