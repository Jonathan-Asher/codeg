import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TerminalEvent } from "@/lib/types"

// The view's job under test: which output events reach the emulator. xterm,
// the backend calls and the event subscription are stand-ins; `env.written`
// is everything the view wrote into the terminal, in order.
const env = vi.hoisted(() => ({
  written: [] as string[],
  handlers: new Map<string, (payload: unknown) => void>(),
  spawn: vi.fn(),
  snapshot: vi.fn(),
}))

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    modes = { applicationCursorKeysMode: false }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
    write(data: string) {
      env.written.push(data)
    }
  },
}))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))
vi.mock("@xterm/addon-ligatures", () => ({ LigaturesAddon: class {} }))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(
    async (event: string, handler: (payload: unknown) => void) => {
      env.handlers.set(event, handler)
      return () => env.handlers.delete(event)
    }
  ),
}))
vi.mock("@/lib/api", () => ({
  terminalSpawn: env.spawn,
  terminalSnapshot: env.snapshot,
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
  terminalKill: vi.fn(async () => {}),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useTerminalFont: () => ({
    terminalFontStack: "monospace",
    terminalFontSize: 13,
    terminalLigatures: false,
  }),
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => vi.fn(),
  isPrimaryModifier: () => false,
}))
vi.mock("@/lib/terminal/theme", () => ({ getTerminalTheme: () => ({}) }))
vi.mock("@/components/terminal/terminal-link-menu", () => ({
  TerminalLinkMenu: () => null,
  terminalLinkClickOpensMenu: () => false,
}))

import { TerminalView } from "./terminal-view"

const ID = "t1"

function output(data: string, seq?: number) {
  const event: TerminalEvent = { terminal_id: ID, data, seq }
  act(() => env.handlers.get(`terminal://output/${ID}`)?.(event))
}

function exit() {
  act(() =>
    env.handlers.get(`terminal://exit/${ID}`)?.({ terminal_id: ID, data: "" })
  )
}

/** Mount and wait until the view is past spawn/attach and writing live. */
async function mount() {
  let spawned: () => void = () => {}
  env.spawn.mockReturnValue(
    new Promise<void>((resolve) => {
      spawned = resolve
    })
  )
  render(<TerminalView terminalId={ID} workingDir="/work" isActive isVisible />)
  await vi.waitFor(() => expect(env.spawn).toHaveBeenCalled())
  await act(async () => spawned())
}

beforeEach(() => {
  env.written = []
  env.handlers.clear()
  env.spawn.mockReset()
  env.spawn.mockResolvedValue(undefined)
  env.snapshot.mockReset()
  env.snapshot.mockResolvedValue({ alive: false, data: "", seq: 0 })
})

afterEach(() => {
  cleanup()
})

describe("TerminalView output", () => {
  it("writes a chunk delivered twice only once", async () => {
    await mount()

    output("l", 1)
    output("l", 1)
    output("s", 2)
    output("s", 2)
    output("\r\n", 3)

    expect(env.written).toEqual(["l", "s", "\r\n"])
  })

  it("still writes every event that carries no seq", async () => {
    await mount()

    output("a", 0)
    output("a", 0)
    output("b")
    output("c", 1)
    output("d", 0)

    expect(env.written).toEqual(["a", "a", "b", "c", "d"])
  })

  it("counts again from 1 for the next terminal on the same id", async () => {
    await mount()
    output("old", 1)
    output("old", 2)

    exit()
    output("new", 1)

    expect(env.written[0]).toBe("old")
    expect(env.written[1]).toBe("old")
    expect(env.written[env.written.length - 1]).toBe("new")
  })

  it("skips what the snapshot painted, and live duplicates after it", async () => {
    let resolveSnapshot: (s: unknown) => void = () => {}
    env.snapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    )
    render(
      <TerminalView
        terminalId={ID}
        workingDir="/work"
        isActive
        isVisible
        attach
      />
    )
    await vi.waitFor(() =>
      expect(env.handlers.has(`terminal://output/${ID}`)).toBe(true)
    )

    // Buffered while the snapshot is in flight; 4 and 5 are in it.
    output("4", 4)
    output("5", 5)
    output("6", 6)
    output("6", 6)
    await act(async () => {
      resolveSnapshot({ alive: true, data: "SNAP", seq: 5 })
    })
    await vi.waitFor(() => expect(env.written).toContain("SNAP"))
    // Arriving after the snapshot was applied.
    output("5", 5)
    output("6", 6)
    output("7", 7)

    expect(env.written).toEqual(["SNAP", "6", "7"])
    expect(env.spawn).not.toHaveBeenCalled()
  })
})
