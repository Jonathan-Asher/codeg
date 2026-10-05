/**
 * Opening a conversation must never look like nothing is happening.
 *
 * Two legs precede a usable session, and BOTH used to report `status === null`
 * to the UI:
 *
 *   1. `preparing` — the panel holds auto-connect back until it has resolved
 *      the historical conversation's `external_id` (connecting without it makes
 *      the backend take `session/new` and orphan the history).
 *   2. `connecting` — `connect()` is in flight. The store gets no entry until
 *      the backend call returns, and that call spans agent spawn + `initialize`
 *      + `session/resume`, i.e. the slow part.
 *
 * These pin what each leg reports: a status-bar task row, and selector loading
 * so the composer can show placeholders instead of an empty control row.
 */

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// The per-agent option template: what the LAST session of the agent reported,
// current values included. Null until a test puts one there.
const template = vi.hoisted(() => ({
  value: null as {
    modes: unknown
    configOptions: unknown
  } | null,
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ setActiveKey: vi.fn(), touchActivity: vi.fn() }),
  getCachedSelectors: () => template.value,
}))

const tasks = vi.hoisted(() => ({
  added: [] as { id: string; label: string; description?: string }[],
  updated: [] as { id: string; status?: string }[],
  removed: [] as string[],
  reset() {
    tasks.added = []
    tasks.updated = []
    tasks.removed = []
  },
  /** Rows currently on the status bar: added, never retired. */
  live() {
    const settled = new Set([
      ...tasks.removed,
      ...tasks.updated
        .filter((u) => u.status === "completed" || u.status === "failed")
        .map((u) => u.id),
    ])
    return tasks.added.filter((t) => !settled.has(t.id))
  },
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({
    addTask: (id: string, label: string, description?: string) =>
      tasks.added.push({ id, label, description }),
    updateTask: (id: string, update: { status?: string }) =>
      tasks.updated.push({ id, ...update }),
    removeTask: (id: string) => tasks.removed.push(id),
  }),
}))

const conn = vi.hoisted(() => ({
  status: null as string | null,
  attachPhase: null as string | null,
  selectorsReady: false,
  hasCachedSelectors: false,
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: conn.status,
    attachPhase: conn.attachPhase,
    selectorsReady: conn.selectorsReady,
    hasCachedSelectors: conn.hasCachedSelectors,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    modes: null,
    configOptions: null,
    isViewer: false,
    backgroundOutstanding: 0,
  }),
}))

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import type { SelectorValues } from "@/lib/selector-display"
import type { SessionConfigOptionInfo } from "@/lib/types"

function renderLifecycle(
  preparing: boolean,
  storedSelectors: SelectorValues | null = null
) {
  return renderHook(
    (props: { preparing: boolean }) =>
      useConnectionLifecycle({
        contextKey: "ctx-1",
        agentType: "claude_code",
        // Mirrors the panel: the auto-connect gate is CLOSED while preparing.
        isActive: !props.preparing,
        preparing: props.preparing,
        storedSelectors,
      }),
    { initialProps: { preparing } }
  )
}

/** A Claude Code option list as some session last reported it. */
function claudeOptions(
  model: string,
  effort: string
): SessionConfigOptionInfo[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      kind: {
        type: "select",
        current_value: model,
        options: [
          { value: "opus", name: "Opus 5.5" },
          { value: "sonnet", name: "Sonnet 5.5" },
        ],
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
    },
  ]
}

describe("useConnectionLifecycle opening legs", () => {
  beforeEach(() => {
    tasks.reset()
    conn.status = null
    conn.attachPhase = null
    conn.selectorsReady = false
    conn.hasCachedSelectors = false
    template.value = null
  })

  it("reports the historical-session wait as a status-bar task and as loading selectors", () => {
    const { result } = renderLifecycle(true)

    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.preparingTitle:{"agent":"Claude Code"}',
    ])
    expect(result.current.modeLoading).toBe(true)
    expect(result.current.configOptionsLoading).toBe(true)
  })

  it("hands the row over from `preparing` to `connecting` rather than keeping stale wording", () => {
    const { rerender } = renderLifecycle(true)
    const prepared = tasks.live()[0]
    expect(prepared.label).toContain("preparingTitle")

    // The detail landed, so the panel opens the gate and connect() publishes
    // its in-flight marker — which `useConnection` reports as `connecting`.
    conn.status = "connecting"
    act(() => rerender({ preparing: false }))

    expect(tasks.removed).toContain(prepared.id)
    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.connectingTitle:{"agent":"Claude Code"}',
    ])
  })

  it("settles the connect row once the session is up, leaving the bar clean", () => {
    const { rerender } = renderLifecycle(true)
    conn.status = "connecting"
    act(() => rerender({ preparing: false }))
    expect(tasks.live()).toHaveLength(1)

    // `connected` + selectors_ready is the end of the whole establishment.
    conn.status = "connected"
    conn.selectorsReady = true
    act(() => rerender({ preparing: false }))

    expect(tasks.live()).toEqual([])
  })

  it("adds nothing while idle — a settled, disconnected tab is not opening", () => {
    const { result } = renderLifecycle(false)
    expect(tasks.live()).toEqual([])
    expect(result.current.configOptionsLoading).toBe(false)
  })

  it("shows the conversation's own stored selectors while it opens, not the last session's", () => {
    // Another session of the agent was last seen on Sonnet / Low. This one runs
    // Opus / Max: that is what its chips read until its own session reports.
    template.value = {
      modes: null,
      configOptions: claudeOptions("sonnet", "low"),
    }
    const { result } = renderLifecycle(true, {
      modeId: null,
      configValues: { model: "opus", effort: "max" },
    })
    const shown = Object.fromEntries(
      (result.current.displayConfigOptions ?? []).map((o) => [
        o.id,
        o.kind.current_value,
      ])
    )
    expect(shown).toEqual({ model: "opus", effort: "max" })
    // Something of its own to show: no placeholder over it.
    expect(result.current.modeLoading).toBe(false)
    expect(result.current.configOptionsLoading).toBe(false)
    // The status-bar row is independent of the chips — the session itself is
    // still not up.
    expect(tasks.live()).toHaveLength(1)
  })

  it("shows a placeholder rather than another session's values when nothing is stored", () => {
    template.value = {
      modes: null,
      configOptions: claudeOptions("sonnet", "low"),
    }
    conn.hasCachedSelectors = true
    const { result } = renderLifecycle(true)
    expect(result.current.displayConfigOptions).toBeNull()
    expect(result.current.displayModes).toBeNull()
    expect(result.current.configOptionsLoading).toBe(true)
  })

  it("skips the placeholder for an agent known to have no selectors at all", () => {
    template.value = { modes: null, configOptions: null }
    const { result } = renderLifecycle(true)
    expect(result.current.modeLoading).toBe(false)
    expect(result.current.configOptionsLoading).toBe(false)
  })
})

// The status bar is global and every tab stays mounted, so a tab the user is
// not looking at must not put rows there: a background Pi tab reconnecting
// used to show "Initializing Pi session" over a brand-new Claude Code tab.
describe("useConnectionLifecycle status-bar rows belong to the foreground tab", () => {
  beforeEach(() => {
    tasks.reset()
    conn.status = null
    conn.attachPhase = null
    conn.selectorsReady = false
    conn.hasCachedSelectors = false
  })

  function renderTab(isActive: boolean) {
    return renderHook(
      (props: { isActive: boolean }) =>
        useConnectionLifecycle({
          contextKey: "ctx-bg",
          agentType: "pi",
          isActive: props.isActive,
        }),
      { initialProps: { isActive } }
    )
  }

  it("adds no row for a background tab that is connecting or initializing", () => {
    conn.status = "connecting"
    conn.attachPhase = "resuming"
    const { rerender } = renderTab(false)
    expect(tasks.live()).toEqual([])

    conn.status = "connected"
    act(() => rerender({ isActive: false }))
    expect(tasks.live()).toEqual([])
  })

  it("shows the tab's row once it is in front, and drops it when it goes back", () => {
    conn.status = "connecting"
    conn.attachPhase = "resuming"
    const { rerender } = renderTab(false)
    act(() => rerender({ isActive: true }))
    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.resumingTitle:{"agent":"Pi"}',
    ])

    act(() => rerender({ isActive: false }))
    expect(tasks.live()).toEqual([])
  })

  it("names a resume that is waiting for an attach slot", () => {
    conn.status = "connecting"
    conn.attachPhase = "queued"
    renderTab(true)
    expect(tasks.live().map((t) => t.label)).toEqual([
      'tasks.queuedTitle:{"agent":"Pi"}',
    ])
  })
})
