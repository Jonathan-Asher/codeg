import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TurnBusyError } from "@/lib/turn-busy"

// A fake connection store standing in for `AcpConnectionsProvider`: one entry
// under the Quick Ask key, subscribers notified on every change. The hook
// re-reads `useConnection` on each render, so tests `rerender()` after moving
// the connection along.
const h = vi.hoisted(() => {
  type FakeConn = {
    connectionId: string
    agentType: string
    workingDir: string | null
    status: string
    nativeSteering: boolean
    sessionId: string | null
    isViewer: boolean
    error: string | null
    liveMessage: unknown
    configOptions: null
  }
  const state: {
    conn: FakeConn | undefined
    connectedStatus: string
    nativeSteering: boolean
    listeners: Set<() => void>
  } = {
    conn: undefined,
    connectedStatus: "connected",
    nativeSteering: false,
    listeners: new Set(),
  }
  const emit = () => state.listeners.forEach((l) => l())
  const store = {
    getConnection: () => state.conn,
    getConnectPending: () => undefined,
    getConnectError: () => undefined,
    getActiveKey: () => null,
    subscribeKey: (_key: string, cb: () => void) => {
      state.listeners.add(cb)
      return () => state.listeners.delete(cb)
    },
    subscribeActiveKey: () => () => {},
  }
  const actions = {
    connect: vi.fn(
      async (
        _key: string,
        agentType: string,
        workingDir?: string,
        sessionId?: string
      ) => {
        state.conn = {
          connectionId: "conn-1",
          agentType,
          workingDir: workingDir ?? null,
          status: state.connectedStatus,
          nativeSteering: state.nativeSteering,
          sessionId: sessionId ?? "sess-new",
          isViewer: false,
          error: null,
          liveMessage: null,
          configOptions: null,
        }
        emit()
      }
    ),
    disconnect: vi.fn(async () => {
      state.conn = undefined
      emit()
      return true
    }),
    disconnectIfIdle: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    registerLiveSurfaceKeys: vi.fn(),
  }
  const api = {
    createChatDir: vi.fn(async () => ({
      path: "/data/chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef",
    })),
    createConversation: vi.fn(async () => 77),
    discardPrivateQuickAsk: vi.fn(async (dir: string) => ({
      removed: [dir],
      failed: [],
    })),
    submitSessionFeedback: vi.fn(async () => ({ id: "note-1" })),
  }
  return { state, emit, store, actions, api }
})

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => h.actions,
  useConnectionStore: () => h.store,
}))
vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: h.state.conn?.status ?? null,
    agentType: h.state.conn?.agentType ?? null,
    configOptions: null,
  }),
}))
vi.mock("@/lib/api", () => h.api)

import {
  quickAskContextKey,
  useQuickAskSession,
  type UseQuickAskSessionArgs,
} from "./use-quick-ask-session"

/** The key of the window's first question. */
const QUICK_ASK_CONTEXT_KEY = quickAskContextKey(0)

const PRIVATE_DIR =
  "/data/chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef"

function setup(overrides: Partial<UseQuickAskSessionArgs>) {
  const args: UseQuickAskSessionArgs = {
    target: "new",
    agentType: "claude_code",
    folder: { id: 5, path: "/work/project", name: "project" },
    session: null,
    configValues: { model: "haiku", effort: "low" },
    onFolderUsed: vi.fn(),
    onSessionUsed: vi.fn(),
    ...overrides,
  }
  const hook = renderHook(
    (props: UseQuickAskSessionArgs) => useQuickAskSession(props),
    { initialProps: args }
  )
  return { ...hook, args }
}

/** Move the fake connection to `status` (optionally with a reply) and let
 *  the hook see it. */
function moveTo(
  rerender: (props: UseQuickAskSessionArgs) => void,
  args: UseQuickAskSessionArgs,
  status: string,
  liveMessage?: unknown
) {
  act(() => {
    h.state.conn = {
      ...h.state.conn!,
      status,
      ...(liveMessage !== undefined ? { liveMessage } : {}),
    }
    h.emit()
    rerender({ ...args })
  })
}

const reply = (text: string) => ({
  id: `live-${text}`,
  role: "assistant",
  content: [{ type: "text", text }],
  startedAt: 1,
})

describe("useQuickAskSession", () => {
  beforeEach(() => {
    h.state.conn = undefined
    h.state.connectedStatus = "connected"
    h.state.nativeSteering = false
    h.state.listeners.clear()
    for (const fn of [...Object.values(h.actions), ...Object.values(h.api)]) {
      fn.mockClear()
    }
  })

  describe("new session in a folder", () => {
    it("creates a real conversation and sends linked to it", async () => {
      const { result, args } = setup({ target: "new" })
      await act(async () => {
        await result.current.send("  What does main.rs do?  ")
      })

      // Connected in the folder with Quick Ask's own picks, not the saved
      // per-agent ones.
      expect(h.actions.connect).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        "claude_code",
        "/work/project",
        undefined,
        undefined,
        {
          selectorPrefs: {
            modeId: null,
            configValues: { model: "haiku", effort: "low" },
          },
        }
      )
      expect(h.api.createConversation).toHaveBeenCalledWith(
        5,
        "claude_code",
        "What does main.rs do?"
      )
      expect(h.actions.sendPrompt).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        [{ type: "text", text: "What does main.rs do?" }],
        { folderId: 5, conversationId: 77 }
      )
      expect(args.onFolderUsed).toHaveBeenCalledWith(5)
      expect(result.current.binding).toMatchObject({
        target: "new",
        folderId: 5,
        conversationId: 77,
      })
      expect(result.current.thread).toEqual([
        expect.objectContaining({ role: "user", state: "sent" }),
      ])
    })

    it("continues the same conversation for a follow-up", async () => {
      const { result, rerender, args } = setup({ target: "new" })
      await act(async () => {
        await result.current.send("first")
      })
      moveTo(rerender, args, "prompting", reply("one"))
      moveTo(rerender, args, "connected")
      await act(async () => {
        await result.current.send("second")
      })
      expect(h.api.createConversation).toHaveBeenCalledTimes(1)
      expect(h.actions.sendPrompt).toHaveBeenLastCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        [{ type: "text", text: "second" }],
        { folderId: 5, conversationId: 77 }
      )
      // The finished reply was kept in the thread.
      expect(result.current.thread.map((t) => t.role)).toEqual([
        "user",
        "assistant",
        "user",
      ])
    })

    it("starts the next question on a fresh connection, leaving a busy one to finish", async () => {
      const { result, rerender, args } = setup({ target: "new" })
      await act(async () => {
        await result.current.send("long question")
      })
      moveTo(rerender, args, "prompting", reply("still writing"))
      await act(async () => {
        await result.current.clear()
      })
      // Released only if idle: a reply still being written lands in its
      // conversation in the background.
      expect(h.actions.disconnectIfIdle).toHaveBeenCalledWith(
        quickAskContextKey(0)
      )
      expect(h.actions.disconnect).not.toHaveBeenCalled()
      expect(result.current.contextKey).toBe(quickAskContextKey(1))

      h.state.conn = undefined
      await act(async () => {
        await result.current.send("next question")
      })
      expect(h.actions.connect).toHaveBeenLastCalledWith(
        quickAskContextKey(1),
        "claude_code",
        "/work/project",
        undefined,
        undefined,
        expect.anything()
      )
      expect(h.actions.disconnect).not.toHaveBeenCalled()
    })

    it("refuses to start without a folder", async () => {
      const { result } = setup({ target: "new", folder: null })
      let accepted = true
      await act(async () => {
        accepted = await result.current.send("hello")
      })
      expect(accepted).toBe(false)
      expect(result.current.error?.code).toBe("no_folder")
      expect(h.actions.connect).not.toHaveBeenCalled()
    })

    it("lets a saved conversation finish in the background on New question", async () => {
      const { result } = setup({ target: "new" })
      await act(async () => {
        await result.current.send("q")
      })
      await act(async () => {
        await result.current.clear()
      })
      expect(h.actions.disconnectIfIdle).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY
      )
      expect(h.actions.disconnect).not.toHaveBeenCalled()
      expect(h.api.discardPrivateQuickAsk).not.toHaveBeenCalled()
      expect(result.current.thread).toEqual([])
      expect(result.current.binding).toBeNull()
    })
  })

  describe("existing session", () => {
    const session = {
      id: 12,
      folderId: 4,
      folderPath: "/work/app",
      agentType: "codex",
      externalId: "codex-sess",
      title: "Refactor",
    }

    it("reopens the session with its own selectors and sends into it", async () => {
      const { result, args } = setup({ target: "existing", session })
      await act(async () => {
        await result.current.send("status?")
      })
      // No selector override: the session keeps its own model/effort.
      expect(h.actions.connect).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        "codex",
        "/work/app",
        "codex-sess",
        12,
        undefined
      )
      expect(h.actions.sendPrompt).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        [{ type: "text", text: "status?" }],
        { folderId: 4, conversationId: 12 }
      )
      expect(h.api.createConversation).not.toHaveBeenCalled()
      expect(args.onSessionUsed).toHaveBeenCalledWith(12)
    })

    it("steers into a busy session that takes mid-turn messages", async () => {
      h.state.connectedStatus = "prompting"
      h.state.nativeSteering = true
      const { result } = setup({ target: "existing", session })
      await act(async () => {
        await result.current.send("also check tests")
      })
      expect(h.api.submitSessionFeedback).toHaveBeenCalledWith(
        "conn-1",
        "also check tests"
      )
      expect(h.actions.sendPrompt).not.toHaveBeenCalled()
      expect(result.current.thread[0]).toMatchObject({ state: "steered" })
    })

    it("queues behind a busy reply and sends when it ends", async () => {
      h.state.connectedStatus = "prompting"
      const { result, rerender, args } = setup({ target: "existing", session })
      await act(async () => {
        await result.current.send("later please")
      })
      expect(h.actions.sendPrompt).not.toHaveBeenCalled()
      expect(result.current.thread[0]).toMatchObject({ state: "queued" })

      moveTo(rerender, args, "connected")
      await act(async () => {})
      expect(h.actions.sendPrompt).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        [{ type: "text", text: "later please" }],
        { folderId: 4, conversationId: 12 }
      )
      expect(result.current.thread[0]).toMatchObject({ state: "sent" })
    })

    it("queues when another client won the race to start a turn", async () => {
      h.actions.sendPrompt.mockRejectedValueOnce(new TurnBusyError())
      const { result } = setup({ target: "existing", session })
      await act(async () => {
        await result.current.send("race")
      })
      expect(result.current.thread[0]).toMatchObject({ state: "queued" })
      expect(result.current.error).toBeNull()
    })
  })

  describe("private question", () => {
    it("runs unrecorded in a scratch dir with the transcript turned off", async () => {
      const { result } = setup({ target: "private", folder: null })
      await act(async () => {
        await result.current.send("secret question")
      })
      expect(h.api.createChatDir).toHaveBeenCalledTimes(1)
      expect(h.actions.connect).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        "claude_code",
        PRIVATE_DIR,
        undefined,
        undefined,
        {
          selectorPrefs: {
            modeId: null,
            configValues: { model: "haiku", effort: "low" },
          },
          ephemeral: true,
        }
      )
      // No conversation row, ever: the prompt goes out unlinked.
      expect(h.api.createConversation).not.toHaveBeenCalled()
      expect(h.actions.sendPrompt).toHaveBeenCalledWith(
        QUICK_ASK_CONTEXT_KEY,
        [{ type: "text", text: "secret question" }],
        { unlinked: true }
      )
      expect(result.current.isPrivate).toBe(true)
    })

    it("deletes everything when the window is cleared", async () => {
      const { result, rerender, args } = setup({
        target: "private",
        folder: null,
      })
      await act(async () => {
        await result.current.send("secret question")
      })
      moveTo(rerender, args, "prompting", reply("42"))
      moveTo(rerender, args, "connected")
      expect(result.current.thread).toHaveLength(2)

      let report: unknown = null
      await act(async () => {
        report = await result.current.clear()
      })
      // The agent goes first (so nothing writes after the delete), then the
      // scratch dir and whatever the agent recorded for its session.
      expect(h.actions.disconnect).toHaveBeenCalledWith(QUICK_ASK_CONTEXT_KEY)
      expect(h.api.discardPrivateQuickAsk).toHaveBeenCalledWith(
        PRIVATE_DIR,
        "claude_code",
        "sess-new"
      )
      expect(h.actions.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        h.api.discardPrivateQuickAsk.mock.invocationCallOrder[0]
      )
      expect(report).toEqual({ removed: [PRIVATE_DIR], failed: [] })
      expect(result.current.thread).toEqual([])
      expect(result.current.lastCleanup).toEqual({
        removed: [PRIVATE_DIR],
        failed: [],
      })
      expect(h.actions.registerLiveSurfaceKeys).toHaveBeenLastCalledWith(
        "quick-ask",
        new Set()
      )
    })

    it("never steers a follow-up while the private reply streams", async () => {
      h.state.nativeSteering = true
      const { result, rerender, args } = setup({
        target: "private",
        folder: null,
      })
      await act(async () => {
        await result.current.send("one")
      })
      moveTo(rerender, args, "prompting", reply("partial"))
      await act(async () => {
        await result.current.send("two")
      })
      expect(h.api.submitSessionFeedback).not.toHaveBeenCalled()
      const thread = result.current.thread
      expect(thread[thread.length - 1]).toMatchObject({ state: "queued" })
    })

    it("discards a prepared scratch dir when the user switches target first", async () => {
      const { result, rerender, args } = setup({
        target: "private",
        folder: null,
      })
      await act(async () => {
        await result.current.prepare()
      })
      expect(h.api.createChatDir).toHaveBeenCalledTimes(1)
      await act(async () => {
        rerender({ ...args, target: "new" })
      })
      await act(async () => {})
      expect(h.actions.disconnect).toHaveBeenCalledWith(QUICK_ASK_CONTEXT_KEY)
      expect(h.api.discardPrivateQuickAsk).toHaveBeenCalledWith(
        PRIVATE_DIR,
        null,
        null
      )
    })

    it("creates one scratch dir however many keystrokes race to prepare it", async () => {
      const { result } = setup({ target: "private", folder: null })
      await act(async () => {
        await Promise.all([
          result.current.prepare(),
          result.current.prepare(),
          result.current.prepare(),
        ])
      })
      expect(h.api.createChatDir).toHaveBeenCalledTimes(1)
    })
  })
})
