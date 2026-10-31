import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  MAX_AGENT_ENTRY_CHARS,
  SELECTOR_OPTIONS_STORAGE_KEY,
  getNewSessionValues,
  getSelectorTemplate,
  rememberNewSessionValues,
  rememberSelectorConfigOptions,
  rememberSelectorModes,
  rememberSelectorTemplate,
  resetSelectorOptionsCacheForTests,
  useSelectorTemplate,
} from "@/lib/selector-options-cache"
import type { SessionConfigOptionInfo, SessionModeStateInfo } from "@/lib/types"

function select(
  id: string,
  current: string,
  values: string[],
  extra: Partial<SessionConfigOptionInfo> = {}
): SessionConfigOptionInfo {
  return {
    id,
    name: id,
    kind: {
      type: "select",
      current_value: current,
      options: values.map((value) => ({ value, name: value.toUpperCase() })),
      groups: [],
    },
    ...extra,
  }
}

const MODES: SessionModeStateInfo = {
  current_mode_id: "default",
  available_modes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
}

const CLAUDE_OPTIONS = [
  select("model", "opus", ["opus", "sonnet"], { category: "model" }),
  select("effort", "high", ["low", "high", "max"], {
    category: "thought_level",
    recommended_value: "high",
  }),
]

function stored(): unknown {
  const raw = localStorage.getItem(SELECTOR_OPTIONS_STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

/** What a restart sees: only what made it to storage. */
function restart() {
  resetSelectorOptionsCacheForTests()
}

beforeEach(() => {
  localStorage.clear()
  restart()
})

afterEach(() => {
  localStorage.clear()
  restart()
})

describe("selector-options-cache", () => {
  it("keeps an agent's lists across a restart", () => {
    rememberSelectorModes("claude_code", MODES)
    rememberSelectorConfigOptions("claude_code", CLAUDE_OPTIONS)
    restart()
    expect(getSelectorTemplate("claude_code")).toEqual({
      modes: MODES,
      configOptions: CLAUDE_OPTIONS,
    })
    expect(getSelectorTemplate("pi")).toBeNull()
  })

  it("stores a versioned record", () => {
    rememberSelectorConfigOptions("pi", CLAUDE_OPTIONS)
    expect(stored()).toMatchObject({ v: 1, agents: { pi: {} } })
  })

  it("reads an unknown version or bad JSON as nothing remembered", () => {
    localStorage.setItem(
      SELECTOR_OPTIONS_STORAGE_KEY,
      JSON.stringify({
        v: 99,
        agents: { pi: { modes: null, configOptions: CLAUDE_OPTIONS } },
      })
    )
    restart()
    expect(getSelectorTemplate("pi")).toBeNull()

    localStorage.setItem(SELECTOR_OPTIONS_STORAGE_KEY, "{not json")
    restart()
    expect(getSelectorTemplate("pi")).toBeNull()
  })

  it("keeps only the well-formed parts of a damaged record", () => {
    localStorage.setItem(
      SELECTOR_OPTIONS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        agents: {
          pi: {
            modes: { current_mode_id: 7, available_modes: [] },
            configOptions: [
              CLAUDE_OPTIONS[0],
              { id: "broken", name: "Broken", kind: { type: "select" } },
              { id: "weird", name: "Weird", kind: { type: "slider" } },
              "not an option",
            ],
            newSession: { modeId: 3, configValues: { model: "opus", x: 1 } },
          },
          codex: "garbage",
        },
      })
    )
    restart()
    expect(getSelectorTemplate("pi")).toEqual({
      modes: null,
      configOptions: [CLAUDE_OPTIONS[0]],
    })
    expect(getNewSessionValues("pi")).toEqual({
      modeId: null,
      configValues: { model: "opus" },
    })
    expect(getSelectorTemplate("codex")).toBeNull()
  })

  it("returns the same template object until the lists change", () => {
    rememberSelectorConfigOptions("claude_code", CLAUDE_OPTIONS)
    const first = getSelectorTemplate("claude_code")
    // A repeat report (every reconnect sends the same lists) is no change.
    rememberSelectorConfigOptions(
      "claude_code",
      JSON.parse(JSON.stringify(CLAUDE_OPTIONS))
    )
    expect(getSelectorTemplate("claude_code")).toBe(first)
    rememberSelectorConfigOptions("claude_code", [CLAUDE_OPTIONS[0]])
    expect(getSelectorTemplate("claude_code")).not.toBe(first)
  })

  it("lets a finished session's lists replace what an older one offered", () => {
    rememberSelectorModes("claude_code", MODES)
    rememberSelectorConfigOptions("claude_code", CLAUDE_OPTIONS)
    // The agent was upgraded: no modes any more, one model renamed.
    const upgraded = [
      select("model", "opus-6", ["opus-6", "sonnet"], { category: "model" }),
    ]
    rememberSelectorTemplate("claude_code", {
      modes: null,
      configOptions: upgraded,
    })
    restart()
    expect(getSelectorTemplate("claude_code")).toEqual({
      modes: null,
      configOptions: upgraded,
    })
  })

  it("records an agent with no selectors only when nothing is known of it", () => {
    rememberSelectorTemplate("cline", { modes: null, configOptions: null })
    expect(getSelectorTemplate("cline")).toEqual({
      modes: null,
      configOptions: null,
    })

    rememberSelectorConfigOptions("claude_code", CLAUDE_OPTIONS)
    // A session that reported nothing says nothing about the lists another
    // one saw.
    rememberSelectorTemplate("claude_code", {
      modes: null,
      configOptions: null,
    })
    expect(getSelectorTemplate("claude_code")?.configOptions).toEqual(
      CLAUDE_OPTIONS
    )
  })

  it("remembers what a new session started with, merged per option", () => {
    rememberSelectorConfigOptions("pi", CLAUDE_OPTIONS)
    rememberNewSessionValues("pi", {
      modeId: "default",
      configValues: { model: "opus", effort: "high" },
    })
    rememberNewSessionValues("pi", {
      modeId: null,
      configValues: { effort: "max" },
    })
    restart()
    expect(getNewSessionValues("pi")).toEqual({
      modeId: "default",
      configValues: { model: "opus", effort: "max" },
    })
  })

  it("keeps no new-session values for an agent whose lists it never saw", () => {
    rememberNewSessionValues("pi", {
      modeId: null,
      configValues: { model: "opus" },
    })
    expect(getNewSessionValues("pi")).toBeNull()
    // ...which would otherwise read as "this agent has no selectors".
    expect(getSelectorTemplate("pi")).toBeNull()
  })

  it("keeps lists too big to store for this window only", () => {
    const huge = [
      select(
        "model",
        "m0",
        Array.from(
          { length: Math.ceil(MAX_AGENT_ENTRY_CHARS / 20) },
          (_, i) => `m${i}`
        ),
        { category: "model" }
      ),
    ]
    rememberSelectorConfigOptions("opencode", huge)
    rememberSelectorConfigOptions("pi", CLAUDE_OPTIONS)
    expect(getSelectorTemplate("opencode")?.configOptions).toEqual(huge)
    restart()
    expect(getSelectorTemplate("opencode")).toBeNull()
    expect(getSelectorTemplate("pi")?.configOptions).toEqual(CLAUDE_OPTIONS)
  })

  it("follows another window's write without dropping what only this one holds", () => {
    rememberSelectorConfigOptions("pi", CLAUDE_OPTIONS)
    const piTemplate = getSelectorTemplate("pi")
    const other = {
      v: 1,
      agents: {
        claude_code: { modes: MODES, configOptions: CLAUDE_OPTIONS, at: 1 },
      },
    }
    const { result } = renderHook(() => useSelectorTemplate("claude_code"))
    expect(result.current).toBeNull()
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: SELECTOR_OPTIONS_STORAGE_KEY,
          newValue: JSON.stringify(other),
        })
      )
    })
    expect(result.current).toEqual({
      modes: MODES,
      configOptions: CLAUDE_OPTIONS,
    })
    expect(getSelectorTemplate("pi")).toBe(piTemplate)
  })

  it("re-renders a subscriber when its agent's lists arrive", () => {
    const { result } = renderHook(() => useSelectorTemplate("pi"))
    expect(result.current).toBeNull()
    act(() => rememberSelectorConfigOptions("pi", CLAUDE_OPTIONS))
    expect(result.current?.configOptions).toEqual(CLAUDE_OPTIONS)
  })
})
