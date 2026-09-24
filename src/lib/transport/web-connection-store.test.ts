import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionHealth } from "./types"

// A stand-in for a remote-workspace window's transport, and for the module
// state that says whether the window is bound to one.
const env = vi.hoisted(() => {
  function makeSource(initial: ConnectionHealth) {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      listeners,
      setState(next: ConnectionHealth) {
        state = next
        for (const listener of listeners) listener()
      },
      getConnectionSnapshot: () => state,
      subscribeConnection(callback: () => void) {
        listeners.add(callback)
        return () => {
          listeners.delete(callback)
        }
      },
      reconnectNow: vi.fn(),
      markUnauthorized: vi.fn(),
    }
  }
  const changeListeners = new Set<() => void>()
  let remote: ReturnType<typeof makeSource> | null = null
  return {
    makeSource,
    changeListeners,
    remote: () => remote,
    bind(next: ReturnType<typeof makeSource> | null) {
      remote = next
      for (const listener of changeListeners) listener()
    },
  }
})

vi.mock("./detect", () => ({ detectEnvironment: () => "tauri" }))
vi.mock("./index", () => ({
  isRemoteDesktopMode: () => env.remote() !== null,
  getTransport: () => env.remote(),
  getShellTransport: () => {
    throw new Error("a local desktop window has no network link")
  },
  onActiveTransportChange: (callback: () => void) => {
    env.changeListeners.add(callback)
    return () => {
      env.changeListeners.delete(callback)
    }
  },
}))

import {
  getWebConnectionSnapshot,
  reconnectWebNow,
  subscribeWebConnection,
} from "./web-connection-store"

beforeEach(() => {
  env.bind(null)
  env.changeListeners.clear()
})

describe("connection store in a desktop window", () => {
  it("stays dormant in a local window", () => {
    expect(getWebConnectionSnapshot()).toBe("connected")
    expect(() => reconnectWebNow()).not.toThrow()
  })

  it("follows a remote link bound after the dialog subscribed", () => {
    // The dialog mounts at the root, before the gate binds the window to its
    // remote server — it must pick the remote link up when that happens.
    const changed = vi.fn()
    const unsubscribe = subscribeWebConnection(changed)
    const remote = env.makeSource("connecting")

    env.bind(remote)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(getWebConnectionSnapshot()).toBe("connecting")

    remote.setState("connected")
    expect(changed).toHaveBeenCalledTimes(2)

    reconnectWebNow()
    expect(remote.reconnectNow).toHaveBeenCalledTimes(1)

    env.bind(null)
    expect(getWebConnectionSnapshot()).toBe("connected")
    expect(remote.listeners.size).toBe(0)

    unsubscribe()
    expect(env.changeListeners.size).toBe(0)
  })

  it("stands down for a remote window's rejected token (the gate shows it)", () => {
    env.bind(env.makeSource("unauthorized"))
    expect(getWebConnectionSnapshot()).toBe("connected")
  })
})
