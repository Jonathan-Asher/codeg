/**
 * Grok's permission selector (`mode`) in the composer before the session has
 * reported its own selectors: a Grok chat opening, reconnecting after an idle
 * sweep or a restart, or brand new.
 *
 * Its pick is never saved per agent and is recorded on a conversation only
 * once picked there, so the stored values the row shows in that time never
 * name it, and the row used to leave the Mode out until the session was up.
 * It shows the mode the Grok settings launch the session in, which is what a
 * new chat starts in and a chat that never picked one comes back in.
 */

import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/contexts/acp-connections-context", async () => {
  const cache = await import("@/lib/selector-options-cache")
  return {
    useAcpActions: () => ({
      setActiveKey: vi.fn(),
      releaseActiveKey: vi.fn(),
      touchActivity: vi.fn(),
    }),
    getCachedSelectors: (agentType: string) =>
      cache.getSelectorTemplate(agentType),
  }
})

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({
    addTask: () => {},
    updateTask: () => {},
    removeTask: () => {},
  }),
}))

// The Grok settings' `[ui].permission_mode`, as the agent registry has it:
// `undefined` until the registry has loaded.
const registry = vi.hoisted(() => ({
  grokPermissionMode: undefined as string | null | undefined,
}))

vi.mock("@/hooks/use-acp-agents", () => ({
  useGrokLaunchPermissionMode: () => registry.grokPermissionMode,
}))

const conn = vi.hoisted(() => ({
  status: null as string | null,
  agentType: null as string | null,
  configOptions: null as unknown,
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: conn.status,
    agentType: conn.agentType,
    connectionId: null,
    connectedWorkingDir: null,
    attachPhase: null,
    selectorsReady: false,
    hasCachedSelectors: false,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    modes: null,
    configOptions: conn.configOptions,
    isViewer: false,
    backgroundOutstanding: 0,
    asyncTasks: [],
    remoteControl: null,
    delegatedChildren: [],
  }),
}))

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import {
  rememberNewSessionValues,
  rememberSelectorConfigOptions,
  resetSelectorOptionsCacheForTests,
} from "@/lib/selector-options-cache"
import type { SelectorValues } from "@/lib/selector-display"
import type { SessionConfigOptionInfo } from "@/lib/types"

const select = (
  id: string,
  category: string,
  current: string,
  values: string[]
): SessionConfigOptionInfo => ({
  id,
  name: id,
  category,
  kind: {
    type: "select",
    current_value: current,
    options: values.map((value) => ({ value, name: value })),
    groups: [],
  },
})

/** What the last Grok session reported: on Always approve. */
const GROK_LISTS: SessionConfigOptionInfo[] = [
  select("model", "model", "grok-4.7-build-fast", [
    "grok-4.7",
    "grok-4.7-build-fast",
  ]),
  select("mode", "mode", "bypassPermissions", [
    "default",
    "auto",
    "bypassPermissions",
  ]),
  select("reasoning_effort", "thought_level", "xhigh", [
    "xhigh",
    "high",
    "low",
  ]),
]

function values(options: SessionConfigOptionInfo[] | null) {
  return Object.fromEntries(
    (options ?? []).map((o) => [o.id, o.kind.current_value])
  )
}

function renderGrokTab(stored: SelectorValues | null, newSession = false) {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "tab-grok",
      agentType: "grok",
      isActive: true,
      workingDir: "/work/project",
      sessionId: newSession ? undefined : "01a20dda",
      conversationId: newSession ? undefined : 53,
      storedSelectors: stored,
      newSession,
    })
  )
}

const RECORD: SelectorValues = {
  modeId: null,
  configValues: { model: "grok-4.7", reasoning_effort: "high" },
}

beforeEach(() => {
  localStorage.clear()
  resetSelectorOptionsCacheForTests()
  rememberSelectorConfigOptions("grok", GROK_LISTS)
  registry.grokPermissionMode = "bypassPermissions"
  conn.status = "connecting"
  conn.agentType = "grok"
  conn.configOptions = null
})

afterEach(() => {
  localStorage.clear()
  resetSelectorOptionsCacheForTests()
})

describe("Grok's Mode before the session reports", () => {
  it("shows in a chat that never picked one, on the mode the Grok settings launch it in", () => {
    const { result } = renderGrokTab(RECORD)
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "grok-4.7",
      mode: "bypassPermissions",
      reasoning_effort: "high",
    })
  })

  it("follows the Grok settings, not the mode another session reported", () => {
    registry.grokPermissionMode = null
    const { result } = renderGrokTab(RECORD)
    expect(values(result.current.displayConfigOptions).mode).toBe("default")
  })

  it("shows the conversation's own pick when it made one", () => {
    const { result } = renderGrokTab({
      modeId: null,
      configValues: { ...RECORD.configValues, mode: "auto" },
    })
    expect(values(result.current.displayConfigOptions).mode).toBe("auto")
  })

  it("shows in a brand-new chat next to its saved picks", () => {
    // What an older version's new session started with: no mode yet.
    rememberNewSessionValues("grok", {
      modeId: null,
      configValues: { model: "grok-4.7", reasoning_effort: "high" },
    })
    const { result } = renderGrokTab(
      {
        modeId: null,
        configValues: {
          model: "grok-4.7-build-fast",
          reasoning_effort: "xhigh",
        },
      },
      true
    )
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "grok-4.7-build-fast",
      mode: "bypassPermissions",
      reasoning_effort: "xhigh",
    })
  })

  it("is not guessed while the Grok settings are not known yet", () => {
    registry.grokPermissionMode = undefined
    const { result } = renderGrokTab(RECORD)
    expect(values(result.current.displayConfigOptions)).toEqual({
      model: "grok-4.7",
      reasoning_effort: "high",
    })
  })

  it("is the session's own once it reports", () => {
    const live = GROK_LISTS.map((o) =>
      o.id === "mode" && o.kind.type === "select"
        ? { ...o, kind: { ...o.kind, current_value: "auto" } }
        : o
    )
    conn.status = "connected"
    conn.configOptions = live
    const { result } = renderGrokTab(RECORD)
    expect(result.current.displayConfigOptions).toBe(live)
  })
})
