/**
 * A brand-new chat can be set up before its session is: agent, mode, model
 * and effort are all pickable from the first frame, whatever the connection
 * is doing.
 *
 * These pin the lifecycle's half — what the selector row shows from the
 * agent's remembered lists, where a pick made before the session is ready
 * goes (the agent's saved picks, never a connection that is not this chat's),
 * that it reaches the session once it is ready and holds sends until then,
 * and what is remembered for the next new chat.
 */

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// The connection store's view of the per-agent lists is the real persisted
// cache.
vi.mock("@/contexts/acp-connections-context", async () => {
  const cache = await import("@/lib/selector-options-cache")
  return {
    useAcpActions: () => ({ setActiveKey: vi.fn(), touchActivity: vi.fn() }),
    getCachedSelectors: (agentType: string) =>
      cache.getSelectorTemplate(agentType),
  }
})

const tasks = vi.hoisted(() => ({
  added: [] as { id: string; label: string }[],
  removed: [] as string[],
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({
    addTask: (id: string, label: string) => tasks.added.push({ id, label }),
    updateTask: () => {},
    removeTask: (id: string) => tasks.removed.push(id),
  }),
}))

const conn = vi.hoisted(() => ({
  status: null as string | null,
  agentType: null as string | null,
  connectionId: null as string | null,
  connectedWorkingDir: null as string | null,
  selectorsReady: false,
  modes: null as unknown,
  configOptions: null as unknown,
  setConfigOption: null as unknown as ReturnType<typeof vi.fn>,
  connect: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: conn.status,
    agentType: conn.agentType,
    connectionId: conn.connectionId,
    connectedWorkingDir: conn.connectedWorkingDir,
    attachPhase: null,
    selectorsReady: conn.selectorsReady,
    hasCachedSelectors: false,
    connect: conn.connect,
    disconnect: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: conn.setConfigOption,
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    modes: conn.modes,
    configOptions: conn.configOptions,
    isViewer: false,
    backgroundOutstanding: 0,
  }),
}))

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import {
  getNewSessionValues,
  rememberNewSessionValues,
  rememberSelectorConfigOptions,
  resetSelectorOptionsCacheForTests,
} from "@/lib/selector-options-cache"
import {
  getSavedPrefsForConnect,
  saveConfigPreference,
} from "@/lib/selector-prefs-storage"
import type { AgentType, SessionConfigOptionInfo } from "@/lib/types"

const WORKDIR = "/work/project"

function claudeOptions(
  model: string,
  effort: string,
  models: string[] = ["opus", "sonnet"]
): SessionConfigOptionInfo[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      kind: {
        type: "select",
        current_value: model,
        options: models.map((value) => ({ value, name: value.toUpperCase() })),
        groups: [],
      },
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      kind: {
        type: "select",
        current_value: effort,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
        groups: [],
      },
      recommended_value: "high",
    },
  ]
}

function values(options: SessionConfigOptionInfo[] | null) {
  return Object.fromEntries(
    (options ?? []).map((o) => [o.id, o.kind.current_value])
  )
}

function renderNewChat(agentType: AgentType = "claude_code") {
  return renderHook(
    (props: { agentType: AgentType; newSession: boolean }) =>
      useConnectionLifecycle({
        contextKey: "tab-1",
        agentType: props.agentType,
        isActive: true,
        workingDir: WORKDIR,
        storedSelectors: getSavedPrefsForConnect(props.agentType),
        newSession: props.newSession,
      }),
    { initialProps: { agentType, newSession: true } }
  )
}

/** Lets the picks' application (a chain of awaited calls) run to the end. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** The chat's own session is up and set up, reporting `options`. */
function sessionReady(
  agentType: string,
  options: SessionConfigOptionInfo[],
  connectionId = "conn-1"
) {
  conn.status = "connected"
  conn.agentType = agentType
  conn.connectionId = connectionId
  conn.connectedWorkingDir = WORKDIR
  conn.selectorsReady = true
  conn.configOptions = options
}

beforeEach(() => {
  localStorage.clear()
  resetSelectorOptionsCacheForTests()
  tasks.added = []
  tasks.removed = []
  conn.status = null
  conn.agentType = null
  conn.connectionId = null
  conn.connectedWorkingDir = null
  conn.selectorsReady = false
  conn.modes = null
  conn.configOptions = null
  conn.setConfigOption = vi.fn().mockResolvedValue(undefined)
  conn.connect = vi.fn().mockResolvedValue(undefined)
})

afterEach(() => {
  localStorage.clear()
  resetSelectorOptionsCacheForTests()
})

describe("a new chat before its session is up", () => {
  it("shows the remembered selectors at once, with what the chat will start with", () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("sonnet", "low"))
    rememberNewSessionValues("claude_code", {
      modeId: null,
      configValues: { model: "opus" },
    })
    // Remembered after a restart: nothing has connected in this one.
    resetSelectorOptionsCacheForTests()

    const { result } = renderNewChat()

    // Model: what the last new session started with. Effort: never seen in
    // a new session — the agent's own recommendation. Never the "sonnet" /
    // "low" another session happened to report last.
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "opus",
      effort: "high",
    })
    expect(result.current.selectorsAwaitConnection).toBe(false)
    expect(result.current.presetsPending).toBe(false)
  })

  it("says the options load when connected for an agent no session described", () => {
    const { result } = renderNewChat("pi")
    expect(result.current.displayConfigOptions).toBeNull()
    expect(result.current.selectorsAwaitConnection).toBe(true)
  })

  it("saves a pick made while connecting as the agent's pick, sending it nowhere", () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    conn.status = "connecting"
    const { result, rerender } = renderNewChat()

    act(() => result.current.handleSetConfigOption("model", "sonnet"))

    expect(conn.setConfigOption).not.toHaveBeenCalled()
    expect(getSavedPrefsForConnect("claude_code").configValues).toEqual({
      model: "sonnet",
    })
    // The row follows the saved pick right away.
    rerender({ agentType: "claude_code", newSession: true })
    expect(values(result.current.displayConfigOptions)).toMatchObject({
      model: "sonnet",
    })
    // A first message waits for it.
    expect(result.current.presetsPending).toBe(true)
  })

  it("hands the picks to the session once it is ready, model first, then lets sends go", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    conn.status = "connecting"
    const { result, rerender } = renderNewChat()
    act(() => {
      result.current.handleSetConfigOption("effort", "max")
      result.current.handleSetConfigOption("model", "sonnet")
    })

    // The connect had already shipped the picks of its moment: the session
    // comes up on Opus / High.
    sessionReady("claude_code", claudeOptions("opus", "high"))
    rerender({ agentType: "claude_code", newSession: true })
    // Until it has taken them, the picks stay on screen over its values.
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "sonnet",
      effort: "max",
    })

    await flush()
    expect(conn.setConfigOption.mock.calls).toEqual([
      ["model", "sonnet"],
      ["effort", "max"],
    ])
    expect(result.current.presetsPending).toBe(false)
  })

  it("does not resend a pick the connect already applied", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    const { result, rerender } = renderNewChat()
    act(() => result.current.handleSetConfigOption("model", "sonnet"))
    sessionReady("claude_code", claudeOptions("sonnet", "high"))
    rerender({ agentType: "claude_code", newSession: true })
    await flush()
    expect(conn.setConfigOption).not.toHaveBeenCalled()
    expect(result.current.presetsPending).toBe(false)
  })

  it("drops a pick the live session no longer offers, without holding sends", async () => {
    rememberSelectorConfigOptions(
      "claude_code",
      claudeOptions("opus", "high", ["opus", "sonnet", "haiku"])
    )
    conn.status = "connecting"
    const { result, rerender } = renderNewChat()
    act(() => result.current.handleSetConfigOption("model", "haiku"))
    sessionReady("claude_code", claudeOptions("opus", "high"))
    rerender({ agentType: "claude_code", newSession: true })
    await flush()
    expect(conn.setConfigOption).not.toHaveBeenCalled()
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "opus",
      effort: "high",
    })
    expect(result.current.presetsPending).toBe(false)
  })

  it("replaces the remembered lists with the live ones once the session reports", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    const { result, rerender } = renderNewChat()
    const live = claudeOptions("opus-6", "max", ["opus-6", "sonnet"])
    sessionReady("claude_code", live)
    await act(async () => {
      rerender({ agentType: "claude_code", newSession: true })
    })
    expect(result.current.displayConfigOptions).toBe(live)
  })

  it("remembers what the new session started with, for options not picked", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    saveConfigPreference("claude_code", "model", "sonnet")
    const { rerender } = renderNewChat()
    sessionReady("claude_code", claudeOptions("sonnet", "max"))
    await act(async () => {
      rerender({ agentType: "claude_code", newSession: true })
    })
    // The model was the user's pick, not a default: only the effort counts.
    expect(getNewSessionValues("claude_code")).toEqual({
      modeId: null,
      configValues: { effort: "max" },
    })
  })
})

describe("switching a new chat's agent while it connects", () => {
  it("keeps a pick for the newly selected agent off the connection still bound to the old one", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    rememberSelectorConfigOptions("pi", claudeOptions("opus", "high"))
    // Claude Code's session is up; the user has just switched to Pi.
    sessionReady("claude_code", claudeOptions("opus", "high"))
    const { result, rerender } = renderNewChat()
    rerender({ agentType: "pi", newSession: true })

    act(() => result.current.handleSetConfigOption("model", "sonnet"))
    await flush()

    expect(conn.setConfigOption).not.toHaveBeenCalled()
    expect(getSavedPrefsForConnect("pi").configValues).toEqual({
      model: "sonnet",
    })
    expect(getSavedPrefsForConnect("claude_code").configValues).toBeNull()
    // The row shows Pi's own values, not the Claude Code session's.
    expect(values(result.current.displayConfigOptions)).toMatchObject({
      model: "sonnet",
    })
  })

  it("leaves a pick made for the previous agent behind when the chat switches", async () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("opus", "high"))
    conn.status = "connecting"
    const { result, rerender } = renderNewChat()
    act(() => result.current.handleSetConfigOption("model", "sonnet"))
    expect(result.current.presetsPending).toBe(true)

    rerender({ agentType: "pi", newSession: true })
    expect(result.current.presetsPending).toBe(false)
    // Pi's session comes up: nothing of Claude Code's picks goes to it.
    sessionReady("pi", claudeOptions("opus", "high"))
    rerender({ agentType: "pi", newSession: true })
    await flush()
    expect(conn.setConfigOption).not.toHaveBeenCalled()
    // ...but it stays Claude Code's saved pick for its next session.
    expect(getSavedPrefsForConnect("claude_code").configValues).toEqual({
      model: "sonnet",
    })
  })

  it("connects the newly selected agent and names it on the status bar", () => {
    conn.status = "connecting"
    const { rerender } = renderNewChat()
    expect(conn.connect).toHaveBeenLastCalledWith(
      "claude_code",
      WORKDIR,
      undefined,
      undefined
    )
    const first = tasks.added.at(-1)
    expect(first?.label).toContain("Claude Code")

    rerender({ agentType: "pi", newSession: true })
    expect(conn.connect).toHaveBeenLastCalledWith(
      "pi",
      WORKDIR,
      undefined,
      undefined
    )
    expect(tasks.removed).toContain(first?.id)
    expect(tasks.added.at(-1)?.label).toContain("Pi")
  })
})

describe("an existing conversation", () => {
  it("keeps sending a pick to its connection and shows only its own values", () => {
    rememberSelectorConfigOptions("claude_code", claudeOptions("sonnet", "low"))
    conn.status = "connecting"
    const { result } = renderHook(() =>
      useConnectionLifecycle({
        contextKey: "tab-2",
        agentType: "claude_code",
        isActive: true,
        workingDir: WORKDIR,
        sessionId: "sess-1",
        conversationId: 7,
        storedSelectors: { modeId: null, configValues: { model: "opus" } },
      })
    )
    // Only what its record names: no new-chat defaults for the effort.
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "opus",
    })
    act(() => result.current.handleSetConfigOption("effort", "max"))
    expect(conn.setConfigOption).toHaveBeenCalledWith("effort", "max")
    expect(getSavedPrefsForConnect("claude_code").configValues).toBeNull()
    expect(result.current.presetsPending).toBe(false)
    expect(result.current.selectorsAwaitConnection).toBe(false)
  })
})
