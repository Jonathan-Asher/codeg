import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const answers = vi.hoisted(() => ({
  queue: [] as unknown[],
  calls: 0,
  /** What the backend's status announcements are handed to. */
  announce: null as ((status: unknown) => void) | null,
}))
vi.mock("./natural-api", () => ({
  ttsApi: {
    status: async () => {
      answers.calls += 1
      const next = answers.queue.shift()
      if (next instanceof Error) throw next
      return next
    },
    onStatus: async (handler: (status: unknown) => void) => {
      answers.announce = handler
      return () => {
        answers.announce = null
      }
    },
  },
}))

import {
  getNaturalStatus,
  naturalStatusAge,
  naturalVoiceReady,
  refreshNaturalStatus,
  resetNaturalStatusForTests,
  subscribeNaturalStatus,
  watchNaturalStatus,
} from "./natural-status"
import { fakeTtsStatus } from "./testing"

beforeEach(() => {
  resetNaturalStatusForTests()
  answers.queue = []
  answers.calls = 0
  answers.announce = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe("natural voice status", () => {
  it("keeps the backend's answer and tells subscribers", async () => {
    const listener = vi.fn()
    subscribeNaturalStatus(listener)
    answers.queue.push(fakeTtsStatus())
    expect(getNaturalStatus()).toBeNull()
    await refreshNaturalStatus()
    expect(getNaturalStatus()?.installed).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(naturalVoiceReady(getNaturalStatus())).toBe(true)
  })

  it("treats a failure or an unexpected answer as no natural voice", async () => {
    answers.queue.push(new Error("404"))
    expect(await refreshNaturalStatus()).toBeNull()
    answers.queue.push(null)
    expect(await refreshNaturalStatus()).toBeNull()
    answers.queue.push({ hello: "world" })
    expect(await refreshNaturalStatus()).toBeNull()
    expect(naturalVoiceReady(null)).toBe(false)
  })

  it("shares one request between callers", async () => {
    answers.queue.push(fakeTtsStatus())
    await Promise.all([refreshNaturalStatus(), refreshNaturalStatus()])
    expect(answers.calls).toBe(1)
  })

  it("follows a download every second, while it is on screen, until it ends", async () => {
    vi.useFakeTimers()
    subscribeNaturalStatus(() => {})
    const downloading = (done: number) =>
      fakeTtsStatus({
        installed: false,
        download: { state: "downloading", bytesDone: done, bytesTotal: 100 },
      })
    answers.queue.push(downloading(10), downloading(60), fakeTtsStatus())
    await refreshNaturalStatus()
    expect(answers.calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answers.calls).toBe(2)
    expect(getNaturalStatus()?.download).toEqual({
      state: "downloading",
      bytesDone: 60,
      bytesTotal: 100,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answers.calls).toBe(3)
    expect(getNaturalStatus()?.installed).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(answers.calls).toBe(3)
  })

  it("leaves a download nobody watches to the backend's announcement", async () => {
    vi.useFakeTimers()
    answers.queue.push(
      fakeTtsStatus({
        installed: false,
        download: { state: "downloading", bytesDone: 1, bytesTotal: 100 },
      })
    )
    await refreshNaturalStatus()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(answers.calls).toBe(1)
  })

  it("takes the status the backend announces after a change made in another window", async () => {
    answers.queue.push(fakeTtsStatus({ installed: false }))
    await refreshNaturalStatus()
    watchNaturalStatus()
    await Promise.resolve()
    const listener = vi.fn()
    subscribeNaturalStatus(listener)

    answers.announce?.(fakeTtsStatus())
    expect(naturalVoiceReady(getNaturalStatus())).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(naturalStatusAge()).toBeLessThan(1_000)
    // Not a status: ignored.
    answers.announce?.({ hello: "world" })
    expect(getNaturalStatus()?.installed).toBe(true)
    expect(answers.calls).toBe(1)
  })

  it("keeps an announcement over an older answer still on its way", async () => {
    let answer: (status: unknown) => void = () => {}
    answers.queue.push(new Promise((resolve) => (answer = resolve)))
    watchNaturalStatus()
    await Promise.resolve()
    const asked = refreshNaturalStatus()
    answers.announce?.(fakeTtsStatus())
    answer(fakeTtsStatus({ installed: false }))
    await asked
    expect(getNaturalStatus()?.installed).toBe(true)
  })

  it("asks again when the window comes back into focus or view", async () => {
    watchNaturalStatus()
    answers.queue.push(fakeTtsStatus({ installed: false }), fakeTtsStatus())
    window.dispatchEvent(new Event("focus"))
    await vi.waitFor(() => expect(getNaturalStatus()?.installed).toBe(false))
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    try {
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.waitFor(() => expect(getNaturalStatus()?.installed).toBe(true))
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState
    }
    expect(answers.calls).toBe(2)

    resetNaturalStatusForTests()
    window.dispatchEvent(new Event("focus"))
    await Promise.resolve()
    expect(answers.calls).toBe(2)
  })

  it("says the voice is not ready when the backend can't make it", () => {
    expect(
      naturalVoiceReady(fakeTtsStatus({ supported: false, installed: true }))
    ).toBe(false)
    expect(naturalVoiceReady(fakeTtsStatus({ installed: false }))).toBe(false)
  })
})
