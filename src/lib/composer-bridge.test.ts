import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getComposerBridge,
  registerComposerBridge,
  resetComposerBridgesForTests,
  textPromptDraft,
  useComposerBridge,
  type ComposerBridge,
} from "./composer-bridge"

function fakeBridge(overrides: Partial<ComposerBridge> = {}): ComposerBridge {
  return {
    sendRoute: "send",
    isReplying: false,
    send: vi.fn(() => "send" as const),
    insert: vi.fn(() => true),
    ...overrides,
  }
}

afterEach(() => resetComposerBridgesForTests())

describe("composer bridge registry", () => {
  it("hands out what was published under a key, and nothing for others", () => {
    const bridge = fakeBridge()
    registerComposerBridge("tab-a", bridge)
    expect(getComposerBridge("tab-a")).toBe(bridge)
    expect(getComposerBridge("tab-b")).toBeNull()
    expect(getComposerBridge(null)).toBeNull()
  })

  it("lets a composer take back only its own bridge", () => {
    const first = fakeBridge()
    const second = fakeBridge({ sendRoute: "enqueue" })
    const disposeFirst = registerComposerBridge("tab-a", first)
    // A remount whose new copy published before the old one let go.
    registerComposerBridge("tab-a", second)
    disposeFirst()
    expect(getComposerBridge("tab-a")).toBe(second)
  })

  it("keeps a hook current as composers come, change and go", () => {
    const { result } = renderHook(() => useComposerBridge("tab-a"))
    expect(result.current).toBeNull()

    let dispose = () => {}
    const idle = fakeBridge()
    act(() => {
      dispose = registerComposerBridge("tab-a", idle)
    })
    expect(result.current).toBe(idle)

    const busy = fakeBridge({ sendRoute: "enqueue", isReplying: true })
    act(() => {
      dispose()
      dispose = registerComposerBridge("tab-a", busy)
    })
    expect(result.current?.sendRoute).toBe("enqueue")

    act(() => dispose())
    expect(result.current).toBeNull()
  })

  it("builds the draft a typed message would be, trimmed", () => {
    expect(textPromptDraft("  line one\nline two \n")).toEqual({
      blocks: [{ type: "text", text: "line one\nline two" }],
      displayText: "line one\nline two",
    })
  })
})
