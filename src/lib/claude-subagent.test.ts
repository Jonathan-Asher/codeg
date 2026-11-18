import { describe, expect, it } from "vitest"

import {
  agentIdFromResultText,
  claudeSubagentTarget,
  subagentRuntimeId,
  type ClaudeSubagentCard,
} from "./claude-subagent"

const card = (extra: Partial<ClaudeSubagentCard> = {}): ClaudeSubagentCard => ({
  transcriptAgentType: "claude_code",
  parentConversationId: 7,
  toolCallId: "toolu_01",
  state: "output-available",
  output: null,
  agentStats: null,
  backgroundTaskId: null,
  subagentType: "Explore",
  description: "Find the bug",
  ...extra,
})

describe("claudeSubagentTarget", () => {
  it("follows the parser's word on a parsed card", () => {
    expect(
      claudeSubagentTarget(
        card({ agentStats: { status: "completed", subagent_id: "a1b2c3d4" } })
      )
    ).toEqual({
      parentConversationId: 7,
      toolCallId: "toolu_01",
      agentId: "a1b2c3d4",
      subagentType: "Explore",
      description: "Find the bug",
    })
    // Parsed, and no file named: the transcript is not on disk.
    expect(
      claudeSubagentTarget(
        card({
          agentStats: { status: "completed" },
          output: "done\nagentId: a1b2c3d4",
        })
      )
    ).toBeNull()
  })

  it("takes a background launch's task id", () => {
    expect(
      claudeSubagentTarget(card({ backgroundTaskId: "abc123def" }))?.agentId
    ).toBe("abc123def")
  })

  it("expects the file of a call still running", () => {
    expect(claudeSubagentTarget(card({ state: "input-available" }))).toEqual({
      parentConversationId: 7,
      toolCallId: "toolu_01",
      subagentType: "Explore",
      description: "Find the bug",
    })
    expect(claudeSubagentTarget(card({ state: "input-streaming" }))).toBeNull()
    expect(claudeSubagentTarget(card({ state: "output-error" }))).toBeNull()
  })

  it("is for Claude Code transcripts with a session only", () => {
    const running = { state: "input-available" as const }
    expect(
      claudeSubagentTarget(card({ ...running, transcriptAgentType: "codex" }))
    ).toBeNull()
    expect(
      claudeSubagentTarget(card({ ...running, transcriptAgentType: null }))
    ).toBeNull()
    expect(
      claudeSubagentTarget(card({ ...running, parentConversationId: null }))
    ).toBeNull()
    expect(
      claudeSubagentTarget(card({ ...running, toolCallId: "" }))
    ).toBeNull()
  })
})

describe("agentIdFromResultText", () => {
  it("reads the id Claude Code ends a result with", () => {
    expect(
      agentIdFromResultText(
        "Report.\nagentId: a17eaf41d5a9437c4 (use SendMessage with to: 'a17eaf41d5a9437c4' to continue this agent)"
      )
    ).toBe("a17eaf41d5a9437c4")
    expect(
      agentIdFromResultText(
        "Async agent launched successfully. (internal metadata) agentId: abc123"
      )
    ).toBe("abc123")
    expect(agentIdFromResultText("no id here")).toBeNull()
    expect(agentIdFromResultText(null)).toBeNull()
  })
})

describe("subagentRuntimeId", () => {
  it("is a negative key, stable per tab", () => {
    const id = subagentRuntimeId("sub-7-toolu_01")
    expect(id).toBeLessThan(0)
    expect(subagentRuntimeId("sub-7-toolu_01")).toBe(id)
    expect(subagentRuntimeId("sub-7-toolu_02")).not.toBe(id)
  })
})
