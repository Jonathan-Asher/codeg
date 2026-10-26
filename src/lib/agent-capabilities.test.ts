import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const STORAGE_KEY = "codeg:agent-capabilities"

// The cache reads localStorage once and keeps it at module scope, so a test
// that seeds storage needs a module that has not read it yet.
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

async function load() {
  return import("./agent-capabilities")
}

const FULL = {
  supportsFork: true,
  forkStrictPoint: true,
  forkWhileRunning: true,
}
const NONE = {
  supportsFork: false,
  forkStrictPoint: false,
  forkWhileRunning: false,
}

describe("agent capability cache: seed", () => {
  it("offers what codeg knows of an agent before any session answered", async () => {
    const caps = await load()
    expect(caps.expectedCapabilities("claude_code")).toEqual(FULL)
    expect(caps.expectedCapabilities("codex")).toEqual({
      supportsFork: true,
      forkStrictPoint: true,
      forkWhileRunning: false,
    })
    // An agent codeg knows nothing about waits for its connection.
    expect(caps.expectedCapabilities("pi")).toEqual(NONE)
    expect(caps.expectedCapabilities("some_custom_agent")).toEqual(NONE)
    expect(caps.getRememberedCapabilities("claude_code")).toBeNull()
  })

  it("returns stable references, as a useSyncExternalStore snapshot must", async () => {
    const caps = await load()
    expect(caps.expectedCapabilities("claude_code")).toBe(
      caps.expectedCapabilities("claude_code")
    )
    caps.rememberCapabilities("pi", FULL)
    expect(caps.expectedCapabilities("pi")).toBe(
      caps.expectedCapabilities("pi")
    )
  })
})

describe("agent capability cache: persist", () => {
  it("writes what a connection said and reads it back after a reload", async () => {
    const first = await load()
    expect(first.rememberCapabilities("pi", FULL)).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      pi: FULL,
    })

    vi.resetModules()
    const reloaded = await load()
    expect(reloaded.getRememberedCapabilities("pi")).toEqual(FULL)
    expect(reloaded.expectedCapabilities("pi")).toEqual(FULL)
  })

  it("ignores stored entries that are not capability records", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pi: { supportsFork: "true", forkStrictPoint: true },
        codex: [true, true, true],
        claude_code: NONE,
      })
    )
    const caps = await load()
    expect(caps.getRememberedCapabilities("pi")).toBeNull()
    expect(caps.getRememberedCapabilities("codex")).toBeNull()
    // The well-formed entry still counts.
    expect(caps.getRememberedCapabilities("claude_code")).toEqual(NONE)
  })

  it("survives unreadable storage", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    const caps = await load()
    expect(caps.expectedCapabilities("claude_code")).toEqual(FULL)
  })
})

describe("agent capability cache: reconcile", () => {
  it("does nothing when the connection says what was remembered", async () => {
    const caps = await load()
    const listener = vi.fn()
    caps.subscribeCapabilities(listener)
    expect(caps.rememberCapabilities("pi", FULL)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    const before = caps.expectedCapabilities("pi")
    expect(caps.rememberCapabilities("pi", { ...FULL })).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(caps.expectedCapabilities("pi")).toBe(before)
  })

  it("lets a connection's different answer replace the built-in one (mismatch)", async () => {
    const caps = await load()
    // An adapter build without `session/fork`: the next session of the agent
    // must not offer what this one could not do.
    expect(caps.rememberCapabilities("claude_code", NONE)).toBe(true)
    expect(caps.expectedCapabilities("claude_code")).toEqual(NONE)
    // ...and a later answer that it can again puts the buttons back.
    expect(caps.rememberCapabilities("claude_code", FULL)).toBe(true)
    expect(caps.expectedCapabilities("claude_code")).toEqual(FULL)
  })

  it("keeps each agent's answer to itself", async () => {
    const caps = await load()
    caps.rememberCapabilities("pi", FULL)
    expect(caps.expectedCapabilities("codex")).toEqual({
      supportsFork: true,
      forkStrictPoint: true,
      forkWhileRunning: false,
    })
    expect(caps.expectedCapabilities("opencode")).toEqual(NONE)
  })

  it("re-renders a reader when an answer for its agent comes in", async () => {
    const caps = await load()
    const { result } = renderHook(() => caps.useExpectedCapabilities("pi"))
    expect(result.current).toEqual(NONE)
    act(() => {
      caps.rememberCapabilities("pi", FULL)
    })
    expect(result.current).toEqual(FULL)
  })
})
