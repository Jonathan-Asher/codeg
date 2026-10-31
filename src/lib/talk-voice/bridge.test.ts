import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ConnectionState,
  LiveContentBlock,
} from "@/contexts/acp-connections-context"
import type { EventEnvelope, MessageTurn, PendingItem } from "@/lib/types"
import type { TalkVoiceApi } from "./api"
import type { TalkSendAdapter } from "./adapters"
import {
  TalkBridge,
  type TalkBridgeActions,
  type TalkBridgeBackend,
  type TalkBridgeOptions,
} from "./bridge"
import { GRACE_MS } from "./live-text"
import type { WindowMessage } from "./protocol"

const KEY = "conv-3-claude_code-42"

const text = (value: string, parentToolUseId?: string): LiveContentBlock =>
  parentToolUseId
    ? { type: "text", text: value, parentToolUseId }
    : { type: "text", text: value }

const permission = {
  request_id: "perm-7",
  tool_call: { title: "rm -rf build" },
  options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
}

function connection(extra: Partial<ConnectionState> = {}): ConnectionState {
  return {
    connectionId: "conn-1",
    contextKey: KEY,
    status: "connected",
    nativeSteering: false,
    awaitingBackground: false,
    backgroundOutstanding: 0,
    pendingPermission: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    liveMessage: null,
    error: null,
    ...extra,
  } as ConnectionState
}

function live(content: LiveContentBlock[]): ConnectionState["liveMessage"] {
  return { id: "live-1", role: "assistant", content, startedAt: 0 }
}

function item(
  id: string,
  conversation: number,
  root: number,
  extra: Partial<PendingItem> = {}
): PendingItem {
  return {
    id,
    kind: "permission",
    source: "permission",
    conversation_id: conversation,
    root_conversation_id: root,
    folder_id: 3,
    folder_name: "codeg",
    title: "Fix the build",
    agent_type: "claude_code",
    agent_label: "Claude Code",
    connection_id: `conn-${conversation}`,
    request_id: id,
    asked_at: "2026-11-01T09:31:02Z",
    text: "Run npm test",
    options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    question: null,
    queued: 0,
    reminders_sent: 0,
    last_reminded_at: null,
    next_reminder_at: null,
    phone_notified: false,
    ...extra,
  } as PendingItem
}

function turn(id: string, value: string): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text: value }],
    timestamp: "2026-11-01T09:40:12Z",
  } as MessageTurn
}

/** A scripted backend: the relay and the helper behind it. */
function fakeApi() {
  let handler: ((payload: unknown) => void) | null = null
  const batches: WindowMessage[][] = []
  const starts: { local: boolean; message: WindowMessage }[] = []
  const deliver = (message: unknown, talkId = 7) =>
    handler?.({ talkId, message })
  const api: TalkVoiceApi = {
    status: vi.fn(),
    onStatus: vi.fn(),
    onShortcut: vi.fn(),
    start: vi.fn(async (_conversationId, local, message) => {
      starts.push({ local, message })
      return { talkId: 7, hello: { protocol: 1 } }
    }),
    send: vi.fn(async (_talkId, messages) => {
      batches.push(messages)
    }),
    // The helper answers `end` with `ended`.
    stop: vi.fn(async () => {
      deliver({ type: "ended", reason: "ended", error: null })
    }),
    onMessage: vi.fn(async (next) => {
      handler = next
      return () => {
        handler = null
      }
    }),
  }
  return {
    api,
    starts,
    deliver,
    sent: () => batches.flat(),
    listening: () => handler !== null,
  }
}

function fakeStore(initial: ConnectionState | undefined) {
  let conn = initial
  const listeners = new Set<() => void>()
  return {
    getConnection: (key: string) => (key === KEY ? conn : undefined),
    subscribeKey: (_key: string, cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    set(next: Partial<ConnectionState>) {
      conn = { ...(conn ?? connection()), ...next } as ConnectionState
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

function fakeItems(initial: PendingItem[]) {
  let items = initial
  const listeners = new Set<() => void>()
  return {
    get: () => items,
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    set(next: PendingItem[]) {
      items = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function setup(
  opts: {
    conn?: ConnectionState
    items?: PendingItem[]
    local?: boolean
    adapter?: TalkSendAdapter | null
  } = {}
) {
  const backendApi = fakeApi()
  const store = fakeStore(opts.conn ?? connection())
  const items = fakeItems(opts.items ?? [])
  const actions: TalkBridgeActions = {
    respondPermission: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
    answerPlanApproval: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    registerLiveSurfaceKeys: vi.fn(),
  }
  const backend: TalkBridgeBackend = {
    setTalkMode: vi.fn(async () => {}),
    fetchSettings: vi.fn(async () => ({
      language: "he" as const,
      address: "masculine" as const,
    })),
    respondItem: vi.fn(async () => {}),
    answerItem: vi.fn(async () => {}),
    answerItemPlan: vi.fn(async () => {}),
    uploadReport: vi.fn(async () => {}),
  }
  const setTalking = vi.fn()
  const onUi = vi.fn()
  const onEnded = vi.fn()
  const adapter =
    opts.adapter === undefined
      ? { contextKey: KEY, sendSpoken: vi.fn(async () => "insert" as const) }
      : opts.adapter
  const options: TalkBridgeOptions = {
    conversationId: 42,
    contextKey: KEY,
    local: opts.local ?? true,
    api: backendApi.api,
    actions,
    backend,
    sources: {
      store,
      pendingItems: items,
      title: () => "Fix the flaky build",
      folder: () => "codeg",
      adapter: () => adapter,
    },
    setTalking,
    onUi,
    onEnded,
  }
  const bridge = new TalkBridge(options)
  const start = () =>
    bridge.start({
      settings: { language: "auto", address: "masculine" },
      prefs: {
        handsFree: true,
        patience: "normal",
        interruptBySpeaking: true,
        speakProgress: false,
        smartTurnActive: false,
        echoMode: "automatic",
        shareTelemetry: true,
        useWhisper: true,
      },
      voice: { name: "noa", speed: 1 },
      app: { version: "0.9.2-fork.318", build: "318", bundleId: "app.codeg" },
    })
  return {
    ...backendApi,
    store,
    items,
    actions,
    backend,
    setTalking,
    onUi,
    onEnded,
    adapter,
    bridge,
    start,
  }
}

function envelope(
  seq: number,
  event: Record<string, unknown>,
  connectionId = "conn-1"
): EventEnvelope {
  return { seq, connection_id: connectionId, ...event } as EventEnvelope
}

const types = (messages: WindowMessage[]) => messages.map((m) => m.type)

afterEach(() => {
  vi.useRealTimers()
})

describe("TalkBridge", () => {
  it("starts with the session as it is: the port, the turn in progress, its sub-agents' items", async () => {
    const t = setup({
      conn: connection({
        status: "prompting",
        nativeSteering: true,
        liveMessage: live([text("בדקתי את הלוגים.")]),
        pendingPermission: permission as ConnectionState["pendingPermission"],
      }),
      items: [
        item("permission:conn-9:perm-11", 57, 42),
        item("permission:conn-1:perm-7", 42, 42),
        item("permission:conn-5:perm-2", 60, 61),
      ],
      local: false,
    })
    await expect(t.start()).resolves.toBe(7)
    expect(t.starts).toHaveLength(1)
    expect(t.starts[0].local).toBe(false)
    expect(t.starts[0].message).toMatchObject({
      type: "start",
      protocol: 1,
      conversationId: 42,
      title: "Fix the flaky build",
      folder: "codeg",
      settings: { language: "auto", address: "masculine" },
      voice: { name: "noa", speed: 1 },
      app: { build: "318" },
      port: {
        title: "Fix the flaky build",
        isInFlight: true,
        canInsertIntoTurn: true,
        pendingPermission: permission,
        pendingQuestion: null,
      },
      live: { turnId: "42:1", text: "בדקתי את הלוגים.", streaming: true },
    })
    const start = t.starts[0].message as Extract<
      WindowMessage,
      { type: "start" }
    >
    // Only this conversation's sub-agents: its own cards are in the port.
    expect(start.items.map((i) => i.id)).toEqual(["permission:conn-9:perm-11"])
    expect(t.actions.registerLiveSurfaceKeys).toHaveBeenCalledWith(
      "talk-voice",
      new Set([KEY])
    )
    expect(t.bridge.running).toBe(true)
  })

  it("tells the helper what changes, in order", async () => {
    const t = setup({ conn: connection() })
    await t.start()
    t.store.set({ status: "prompting", liveMessage: live([]) })
    t.store.set({ liveMessage: live([text("Looking.")]) })
    t.store.set({
      pendingPermission: permission as ConnectionState["pendingPermission"],
    })
    t.store.set({ pendingPermission: null })
    await vi.waitFor(() => expect(t.sent()).toHaveLength(4))
    expect(t.sent()).toEqual([
      { type: "port", isInFlight: true },
      { type: "live", turnId: "42:1", text: "Looking.", streaming: true },
      { type: "port", pendingPermission: permission },
      { type: "port", pendingPermission: null },
    ])
    // Batched: never more calls than messages, in the order they were made.
    expect(vi.mocked(t.api.send).mock.calls.length).toBeLessThanOrEqual(4)
  })

  it("ends each turn once, after its final text, with the agent's stop reason", async () => {
    const t = setup({ conn: connection() })
    await t.start()
    t.store.set({ status: "prompting", liveMessage: live([]) })
    t.store.set({
      liveMessage: live([text("Fixed it."), text("sub-agent", "toolu_1")]),
    })
    // The reducer moves the status, then the raw event arrives.
    t.store.set({ status: "connected" })
    t.bridge.onEnvelope(
      envelope(30, {
        type: "turn_complete",
        session_id: "s",
        stop_reason: "end_turn",
      })
    )
    // A web window delivers an event once per surface key.
    t.bridge.onEnvelope(
      envelope(30, {
        type: "turn_complete",
        session_id: "s",
        stop_reason: "end_turn",
      })
    )
    // Another connection's events are not this Talk's.
    t.bridge.onEnvelope(
      envelope(
        31,
        { type: "turn_complete", session_id: "x", stop_reason: "end_turn" },
        "conn-other"
      )
    )
    await vi.waitFor(() => expect(types(t.sent())).toContain("turnEnded"))
    const sent = t.sent().filter((m) => m.type !== "port")
    expect(sent).toEqual([
      { type: "live", turnId: "42:1", text: "Fixed it.", streaming: true },
      { type: "live", turnId: "42:1", text: "Fixed it.", streaming: false },
      { type: "turnEnded", turnId: "42:1", stopReason: "end_turn" },
    ])

    // The next turn has the next id.
    t.store.set({ status: "prompting", liveMessage: live([text("Next.")]) })
    await vi.waitFor(() =>
      expect(t.sent().at(-1)).toMatchObject({ type: "live", turnId: "42:2" })
    )
  })

  it("gives a turn that left without turn_complete the grace, then ends it", async () => {
    vi.useFakeTimers()
    const t = setup({ conn: connection() })
    await t.start()
    t.store.set({ status: "prompting", liveMessage: live([text("On it.")]) })
    t.store.set({ status: "disconnected" })
    vi.advanceTimersByTime(GRACE_MS)
    await vi.waitFor(() => expect(types(t.sent())).toContain("turnEnded"))
    expect(t.sent().at(-1)).toEqual({
      type: "turnEnded",
      turnId: "42:1",
      stopReason: null,
    })
  })

  it("sends what the person said through the tab's own pipeline", async () => {
    const t = setup()
    await t.start()
    t.deliver({ type: "req", id: 3, op: "sendSpoken", text: "תריץ שוב" })
    await vi.waitFor(() =>
      expect(t.sent()).toContainEqual({
        type: "res",
        id: 3,
        ok: true,
        value: "insert",
      })
    )
    expect(t.adapter?.sendSpoken).toHaveBeenCalledWith("תריץ שוב")
  })

  it("answers a spoken message as failed when the tab is gone", async () => {
    const t = setup({ adapter: null })
    await t.start()
    t.deliver({ type: "req", id: 4, op: "sendSpoken", text: "hello" })
    await vi.waitFor(() =>
      expect(t.sent()).toContainEqual({
        type: "res",
        id: 4,
        ok: false,
        error: "the session's tab is not open",
      })
    )
  })

  it("answers cards with the cards' own actions, and sub-agents' items on their connections", async () => {
    const t = setup()
    await t.start()
    const ref = {
      itemId: "permission:conn-9:perm-11",
      connectionId: "conn-9",
      requestId: "perm-11",
      conversationId: 57,
    }
    t.deliver({
      type: "req",
      id: 1,
      op: "respondPermission",
      requestId: "perm-7",
      optionId: "allow",
    })
    t.deliver({ type: "req", id: 2, op: "declineQuestion", questionId: "q-3" })
    t.deliver({
      type: "req",
      id: 3,
      op: "answerQuestion",
      questionId: "q-3",
      answer: {
        answers: [{ questionId: "1b7c", labels: ["staging"] }],
        declined: false,
      },
    })
    t.deliver({
      type: "req",
      id: 4,
      op: "answerPlanApproval",
      approvalId: "plan-2",
      decision: "request_changes",
      feedback: "Run the tests first",
    })
    t.deliver({
      type: "req",
      id: 5,
      op: "respondItem",
      item: ref,
      optionId: "allow",
    })
    t.deliver({ type: "req", id: 6, op: "setTalkMode", enabled: true })
    t.deliver({ type: "req", id: 7, op: "fetchSettings" })
    t.deliver({
      type: "req",
      id: 8,
      op: "answerItemPlan",
      item: ref,
      decision: "approve",
      feedback: null,
    })
    t.deliver({
      type: "req",
      id: 9,
      op: "uploadReport",
      report: { kind: "talk_lab" },
    })
    await vi.waitFor(() =>
      expect(t.sent().filter((m) => m.type === "res")).toHaveLength(9)
    )
    expect(t.actions.respondPermission).toHaveBeenCalledWith(
      KEY,
      "perm-7",
      "allow"
    )
    expect(t.actions.answerQuestion).toHaveBeenCalledWith(KEY, "q-3", {
      answers: [],
      declined: true,
    })
    expect(t.actions.answerQuestion).toHaveBeenCalledWith(KEY, "q-3", {
      answers: [{ questionId: "1b7c", labels: ["staging"] }],
      declined: false,
    })
    expect(t.actions.answerPlanApproval).toHaveBeenCalledWith(KEY, "plan-2", {
      decision: "request_changes",
      feedback: "Run the tests first",
    })
    expect(t.backend.respondItem).toHaveBeenCalledWith(ref, "allow")
    expect(t.backend.setTalkMode).toHaveBeenCalledWith(42, true)
    expect(t.backend.answerItemPlan).toHaveBeenCalledWith(ref, "approve", null)
    expect(t.backend.uploadReport).toHaveBeenCalledWith({ kind: "talk_lab" })
    expect(t.sent()).toContainEqual({
      type: "res",
      id: 7,
      ok: true,
      value: { language: "he", address: "masculine" },
    })
    expect(t.sent()).toContainEqual({
      type: "res",
      id: 1,
      ok: true,
      value: true,
    })
  })

  it("answers a request that failed with its error", async () => {
    const t = setup()
    vi.mocked(t.actions.respondPermission).mockRejectedValueOnce(
      new Error("no permission request is pending")
    )
    await t.start()
    t.deliver({
      type: "req",
      id: 6,
      op: "respondPermission",
      requestId: "perm-7",
      optionId: "allow",
    })
    await vi.waitFor(() =>
      expect(t.sent()).toContainEqual({
        type: "res",
        id: 6,
        ok: false,
        error: "no permission request is pending",
      })
    )
  })

  it("stops the agent's turn when the helper says cancel", async () => {
    const t = setup()
    await t.start()
    t.deliver({ type: "cmd", op: "cancel" })
    await vi.waitFor(() => expect(t.actions.cancel).toHaveBeenCalledWith(KEY))
  })

  it("says talking to a remote server, and leaves a local session's to the backend", async () => {
    const remote = setup({ local: false })
    await remote.start()
    remote.deliver({
      type: "flags",
      keepsStreamAttached: true,
      isTalking: true,
      holdSession: true,
    })
    expect(remote.setTalking).toHaveBeenLastCalledWith(42)
    remote.deliver({
      type: "flags",
      keepsStreamAttached: true,
      isTalking: false,
      holdSession: true,
    })
    expect(remote.setTalking).toHaveBeenLastCalledWith(null)

    const local = setup({ local: true })
    await local.start()
    local.deliver({
      type: "flags",
      keepsStreamAttached: true,
      isTalking: true,
      holdSession: true,
    })
    expect(local.setTalking).not.toHaveBeenCalledWith(42)
  })

  it("sends this conversation's sub-agents' items when they change", async () => {
    const t = setup({ items: [item("permission:conn-9:perm-11", 57, 42)] })
    await t.start()
    t.items.set([
      item("permission:conn-9:perm-11", 57, 42),
      item("permission:conn-1:perm-8", 42, 42),
      item("question:conn-9:q-12", 57, 42, {
        kind: "question",
        source: "question",
      }),
      item("permission:conn-5:perm-2", 60, 61),
    ])
    await vi.waitFor(() => expect(types(t.sent())).toContain("items"))
    const sent = t.sent().find((m) => m.type === "items") as Extract<
      WindowMessage,
      { type: "items" }
    >
    expect(sent.items.map((i) => i.id)).toEqual([
      "permission:conn-9:perm-11",
      "question:conn-9:q-12",
    ])
    // The same list again: nothing new to say.
    t.items.set([...t.items.get()])
    await Promise.resolve()
    expect(t.sent().filter((m) => m.type === "items")).toHaveLength(1)
  })

  it("passes turns written outside a turn: new ones, and grown ones whole", async () => {
    const t = setup()
    await t.start()
    const activity = (
      seq: number,
      turns: MessageTurn[],
      connectionId?: string
    ) =>
      t.bridge.onEnvelope(
        envelope(
          seq,
          {
            type: "background_activity",
            session_id: "s",
            turns,
            outstanding: 1,
            watermark: seq,
          },
          connectionId
        )
      )
    activity(40, [turn("bg-1", "The build passed.")])
    activity(41, [turn("bg-1", "The build passed.")])
    activity(42, [turn("bg-1", "The build passed. All green.")])
    activity(43, [turn("bg-9", "not ours")], "conn-other")
    await vi.waitFor(() =>
      expect(t.sent().filter((m) => m.type === "bgTurns")).toHaveLength(2)
    )
    const bg = t.sent().filter((m) => m.type === "bgTurns") as Extract<
      WindowMessage,
      { type: "bgTurns" }
    >[]
    expect(bg[0].turns[0].id).toBe("bg-1")
    expect(bg[1].turns[0].blocks).toEqual([
      { type: "text", text: "The build passed. All green." },
    ])
  })

  it("passes the helper's state to the dock and ignores another Talk's messages", async () => {
    const t = setup()
    await t.start()
    t.deliver({ type: "state", status: "listening", spoken: [] }, 99)
    expect(t.onUi).not.toHaveBeenCalled()
    t.deliver({ type: "state", status: "listening", spoken: [] })
    expect(t.onUi).toHaveBeenCalledWith(
      expect.objectContaining({ status: "listening" })
    )
  })

  it("keeps what the helper said before the start answered", async () => {
    const t = setup()
    vi.mocked(t.api.start).mockImplementationOnce(async () => {
      t.deliver({ type: "state", status: "starting", spoken: [] })
      return { talkId: 7, hello: { protocol: 1 } }
    })
    await t.start()
    expect(t.onUi).toHaveBeenCalledWith(
      expect.objectContaining({ status: "starting" })
    )
  })

  it("ends when the helper says so, and lets go of everything", async () => {
    const t = setup({ local: false })
    await t.start()
    t.deliver({
      type: "ended",
      reason: "failed",
      error: "the models didn't load",
    })
    expect(t.onEnded).toHaveBeenCalledWith({
      reason: "failed",
      error: "the models didn't load",
    })
    expect(t.bridge.running).toBe(false)
    expect(t.listening()).toBe(false)
    expect(t.store.listeners.size).toBe(0)
    expect(t.setTalking).toHaveBeenLastCalledWith(null)
    expect(t.actions.registerLiveSurfaceKeys).toHaveBeenLastCalledWith(
      "talk-voice",
      new Set()
    )
    const count = t.sent().length
    t.store.set({ status: "prompting" })
    await Promise.resolve()
    expect(t.sent()).toHaveLength(count)
  })

  it("stops through the backend, and reports the helper's ended once", async () => {
    const t = setup()
    await t.start()
    await t.bridge.stop()
    expect(t.api.stop).toHaveBeenCalledWith(7)
    expect(t.onEnded).toHaveBeenCalledTimes(1)
    expect(t.onEnded).toHaveBeenCalledWith({ reason: "ended", error: null })
    await t.bridge.stop()
    expect(t.onEnded).toHaveBeenCalledTimes(1)
  })

  it("ends here when the backend can't be told", async () => {
    const t = setup()
    await t.start()
    vi.mocked(t.api.stop).mockRejectedValueOnce(new Error("gone"))
    await t.bridge.stop()
    expect(t.onEnded).toHaveBeenCalledWith({ reason: "stopped", error: null })
  })

  it("lets go when the start is refused", async () => {
    const t = setup()
    vi.mocked(t.api.start).mockRejectedValueOnce(new Error("models missing"))
    await expect(t.start()).rejects.toThrow("models missing")
    expect(t.listening()).toBe(false)
    expect(t.bridge.running).toBe(false)
  })
})
