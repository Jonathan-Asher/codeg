import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  acpPreconnect: vi.fn(async () => ({ status: "opening", connection_id: "c" })),
}))

import { acpPreconnect } from "@/lib/api"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  cancelConversationPreconnect,
  cancelSessionPreconnect,
  createPreconnectScheduler,
  preconnectConversation,
  preconnectTargetFor,
  requestSessionPreconnect,
  type PreconnectTarget,
} from "@/lib/session-preconnect"

const target = (sessionId: string): PreconnectTarget => ({
  agentType: "claude_code",
  workingDir: "/work/proj",
  sessionId,
})

/** A `run` whose calls stay in flight until the test settles them. */
function controlledRun() {
  const calls: { target: PreconnectTarget; settle: () => void }[] = []
  const run = vi.fn(
    (t: PreconnectTarget) =>
      new Promise<void>((resolve) => {
        calls.push({ target: t, settle: resolve })
      })
  )
  return { run, calls }
}

describe("createPreconnectScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts nothing until the intent has lasted the delay", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(299)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(target("a"))
  })

  it("debounces: sweeping across rows only opens the one the pointer rests on", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(100)
    s.intend(target("b"))
    vi.advanceTimersByTime(100)
    s.intend(target("c"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(target("c"))
  })

  it("a repeated intent for the pending target does not restart the delay", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(200)
    s.intend(target("a"))
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("withdrawing before the delay cancels the open", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(200)
    s.withdraw(target("a"))
    vi.advanceTimersByTime(1000)
    expect(run).not.toHaveBeenCalled()
  })

  it("withdrawing a different target leaves the pending one alone", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("b"))
    s.withdraw(target("a"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledWith(target("b"))
  })

  it("caps requests in flight and drops, never queues, the overflow", async () => {
    const { run, calls } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, maxConcurrent: 1, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(300)
    s.intend(target("b"))
    vi.advanceTimersByTime(300)
    // "a" is still opening: "b" is dropped, not parked behind it.
    expect(run).toHaveBeenCalledTimes(1)
    calls[0].settle()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)

    // With the slot free again a new intent goes through.
    s.intend(target("c"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith(target("c"))
  })

  it("allows up to maxConcurrent opens at once", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, maxConcurrent: 2, run })
    for (const id of ["a", "b", "c"]) {
      s.intend(target(id))
      vi.advanceTimersByTime(300)
    }
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.map(([t]) => t.sessionId)).toEqual(["a", "b"])
  })

  it("does not ask about the same session again within the cooldown", async () => {
    let clock = 0
    const { run, calls } = controlledRun()
    const s = createPreconnectScheduler({
      delayMs: 300,
      cooldownMs: 60_000,
      run,
      now: () => clock,
    })
    s.intend(target("a"))
    vi.advanceTimersByTime(300)
    calls[0].settle()
    await vi.runAllTimersAsync()

    clock = 30_000
    s.intend(target("a"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(1)

    clock = 61_000
    s.intend(target("a"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("a failed request is swallowed and frees its slot", async () => {
    const run = vi.fn(async () => {
      throw new Error("backend down")
    })
    const s = createPreconnectScheduler({ delayMs: 300, maxConcurrent: 1, run })
    s.intend(target("a"))
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()
    s.intend(target("b"))
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("dispose drops the pending intent", () => {
    const { run } = controlledRun()
    const s = createPreconnectScheduler({ delayMs: 300, run })
    s.intend(target("a"))
    s.dispose()
    vi.advanceTimersByTime(1000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("requestSessionPreconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(acpPreconnect).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("asks the backend once the intent settles, and not when it is withdrawn", () => {
    requestSessionPreconnect(target("x"))
    cancelSessionPreconnect(target("x"))
    vi.advanceTimersByTime(1000)
    expect(acpPreconnect).not.toHaveBeenCalled()

    requestSessionPreconnect(target("y"))
    vi.advanceTimersByTime(300)
    expect(acpPreconnect).toHaveBeenCalledWith("claude_code", "/work/proj", "y")
  })

  it("a conversation row resolves its folder from the workspace store", () => {
    useAppWorkspaceStore.setState({
      allFolders: [
        { id: 7, path: "/work/seven", kind: "regular" },
      ] as unknown as ReturnType<
        typeof useAppWorkspaceStore.getState
      >["allFolders"],
    })
    const row = {
      agent_type: "claude_code",
      external_id: "sid-7",
      folder_id: 7,
    } as const
    preconnectConversation(row)
    cancelConversationPreconnect(row)
    vi.advanceTimersByTime(1000)
    expect(acpPreconnect).not.toHaveBeenCalled()

    preconnectConversation(row)
    vi.advanceTimersByTime(300)
    expect(acpPreconnect).toHaveBeenCalledWith(
      "claude_code",
      "/work/seven",
      "sid-7"
    )
  })
})

describe("preconnectTargetFor", () => {
  const folders = [
    { id: 1, path: "/work/proj", kind: "project" },
    { id: 2, path: "/chats/abc", kind: "chat" },
  ]

  it("targets the folder path and the row's external id", () => {
    expect(
      preconnectTargetFor(
        { agent_type: "claude_code", external_id: "sid-1", folder_id: 1 },
        folders
      )
    ).toEqual({
      agentType: "claude_code",
      workingDir: "/work/proj",
      sessionId: "sid-1",
    })
  })

  it("skips rows it cannot reopen the way their tab would", () => {
    // Nothing to resume yet.
    expect(
      preconnectTargetFor(
        { agent_type: "claude_code", external_id: null, folder_id: 1 },
        folders
      )
    ).toBeNull()
    // Cline tabs connect without a session id.
    expect(
      preconnectTargetFor(
        { agent_type: "cline", external_id: "sid", folder_id: 1 },
        folders
      )
    ).toBeNull()
    // Chat-mode tabs connect from a per-tab directory.
    expect(
      preconnectTargetFor(
        { agent_type: "claude_code", external_id: "sid", folder_id: 2 },
        folders
      )
    ).toBeNull()
    // Unknown folder.
    expect(
      preconnectTargetFor(
        { agent_type: "claude_code", external_id: "sid", folder_id: 9 },
        folders
      )
    ).toBeNull()
  })
})
