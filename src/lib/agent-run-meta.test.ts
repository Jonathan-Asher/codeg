import { describe, expect, it } from "vitest"

import {
  compactCount,
  firstLine,
  parseAgentWake,
  parseBackgroundJob,
  parseSubagentRun,
} from "@/lib/agent-run-meta"

describe("parseSubagentRun", () => {
  it("reads the run, its children and the text the model saw", () => {
    const run = parseSubagentRun({
      "codeg.subagentRun": {
        version: 1,
        mode: "workflow",
        async: true,
        status: "failed",
        agent: "researcher",
        durationMs: 28700,
        error: "Cannot read runs.all result property 'mina'.",
        children: [
          {
            key: "uma",
            label: "uma",
            agent: "researcher",
            status: "failed",
            error: "requested unavailable child tools",
            sessionId: "child-uma",
            tokens: 7921,
            turns: 3,
            exchanges: [{ question: "No web tools?", answer: "Close it." }],
          },
          { key: "mina", status: "mystery" },
          { status: "failed" },
        ],
        notes: [{ kind: "launch", text: "Run fan-out: 0/64 used" }, {}],
      },
    })
    expect(run).not.toBeNull()
    expect(run!.status).toBe("failed")
    expect(run!.async).toBe(true)
    expect(run!.children.map((c) => c.key)).toEqual(["uma", "mina"])
    expect(run!.children[0]).toMatchObject({
      sessionId: "child-uma",
      tokens: 7921,
      exchanges: [{ question: "No web tools?", answer: "Close it." }],
    })
    // An unknown status is not guessed at; a row without a key is dropped.
    expect(run!.children[1].status).toBeNull()
    expect(run!.children[1].label).toBe("mina")
    expect(run!.notes).toEqual([
      { kind: "launch", text: "Run fan-out: 0/64 used" },
    ])
  })

  it("is null for any other meta", () => {
    expect(parseSubagentRun(null)).toBeNull()
    expect(parseSubagentRun({ claudeCode: { title: "x" } })).toBeNull()
    expect(
      parseSubagentRun({ "codeg.subagentRun": { status: "weird" } })
    ).toBeNull()
  })
})

describe("parseBackgroundJob", () => {
  it("reads how the job ended", () => {
    expect(
      parseBackgroundJob({
        "codeg.backgroundJob": {
          version: 1,
          id: "jb-1",
          state: "killed",
          killedBy: "timeout",
          duration: "15m",
          tail: "rate limited",
        },
      })
    ).toEqual({
      id: "jb-1",
      state: "killed",
      exitCode: null,
      killedBy: "timeout",
      duration: "15m",
      tail: "rate limited",
      notice: null,
    })
  })

  it("is null for an unknown state or no marker", () => {
    expect(parseBackgroundJob({ "codeg.backgroundJob": { state: "x" } })).toBe(
      null
    )
    expect(parseBackgroundJob(undefined)).toBeNull()
  })
})

describe("parseAgentWake", () => {
  it("reads what woke the agent, tolerating unknown kinds", () => {
    expect(
      parseAgentWake({
        "codeg.agentWake": {
          version: 1,
          triggers: [
            { kind: "jobExit", text: "✅ Background job finished" },
            { kind: "later", text: "x" },
          ],
        },
      })
    ).toEqual({
      triggers: [
        { kind: "jobExit", text: "✅ Background job finished" },
        { kind: "extension", text: "x" },
      ],
    })
    expect(parseAgentWake({ "codeg.agentWake": { triggers: [] } })).toBeNull()
  })
})

describe("text helpers", () => {
  it("compacts token counts", () => {
    expect(compactCount(950)).toBe("950")
    expect(compactCount(7921)).toBe("7.9K")
    expect(compactCount(12000)).toBe("12K")
    expect(compactCount(250_000)).toBe("250K")
    expect(compactCount(3_400_000)).toBe("3.4M")
  })

  it("takes the first non-blank line", () => {
    expect(firstLine("\n  \nboom\nstack")).toBe("boom")
  })
})
