/**
 * Pi's live calls reach the thread under the names history gives them, so the
 * same cards and groupings apply: a `subagent` launch is titled `agent` by the
 * backend (`acp::pi_meta::marks_subagent`), a `bgj_run` is a command, and the
 * `bgj_*` polls keep their names for the background-task grouping.
 */
import { describe, expect, it } from "vitest"

import { inferLiveToolName } from "@/lib/tool-call-normalization"

describe("Pi live tool names", () => {
  it("draws a launch as an Agent card and a job as a command", () => {
    expect(
      inferLiveToolName({
        title: "agent",
        kind: "other",
        rawInput: JSON.stringify({
          subagent_type: "scout",
          agent: "scout",
          task: "Run ls",
          async: true,
        }),
      })
    ).toBe("agent")
    expect(
      inferLiveToolName({
        title: "bgj_run",
        kind: "other",
        rawInput: JSON.stringify({ command: "sleep 6; echo bg-done" }),
      })
    ).toBe("bash")
  })

  it("keeps the polls' own names", () => {
    for (const tool of ["bgj_wait", "bgj_status", "bgj_kill"]) {
      expect(
        inferLiveToolName({
          title: tool,
          kind: "other",
          rawInput: JSON.stringify({ id: "jb-mwdx4odn-5ox8", timeout: 60 }),
        })
      ).toBe(tool)
    }
  })
})
