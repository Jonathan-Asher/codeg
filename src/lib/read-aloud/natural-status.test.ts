import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const answers = vi.hoisted(() => ({ queue: [] as unknown[], calls: 0 }))
vi.mock("./natural-api", () => ({
  ttsApi: {
    status: async () => {
      answers.calls += 1
      const next = answers.queue.shift()
      if (next instanceof Error) throw next
      return next
    },
  },
}))

import {
  getNaturalStatus,
  naturalVoiceReady,
  refreshNaturalStatus,
  resetNaturalStatusForTests,
  subscribeNaturalStatus,
} from "./natural-status"
import { fakeTtsStatus } from "./testing"

beforeEach(() => {
  resetNaturalStatusForTests()
  answers.queue = []
  answers.calls = 0
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

  it("follows a download every second until it ends", async () => {
    vi.useFakeTimers()
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

  it("says the voice is not ready when the backend can't make it", () => {
    expect(
      naturalVoiceReady(fakeTtsStatus({ supported: false, installed: true }))
    ).toBe(false)
    expect(naturalVoiceReady(fakeTtsStatus({ installed: false }))).toBe(false)
  })
})
