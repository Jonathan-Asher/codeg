import { afterEach, describe, expect, it, vi } from "vitest"

import {
  decodePcm16,
  naturalParagraphs,
  NaturalSession,
} from "./natural-player"
import { FakeAudioOut, FakeNaturalApi } from "./testing"

/** Let pending promise callbacks (the session's awaits) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function session(
  paragraphs: string[],
  overrides: { api?: FakeNaturalApi; audio?: FakeAudioOut } = {}
) {
  const api = overrides.api ?? new FakeNaturalApi()
  const audio = overrides.audio ?? new FakeAudioOut()
  const onEnded = vi.fn()
  const onFailed = vi.fn()
  const s = new NaturalSession({
    paragraphs,
    voice: "adam",
    speed: 1.2,
    api,
    audio,
    onEnded,
    onFailed,
  })
  return { s, api, audio, onEnded, onFailed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("decodePcm16", () => {
  it("reads little-endian signed 16-bit samples", () => {
    // 0, 32767, -32768, -1, 16384
    const bytes = [0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff, 0x00, 0x40]
    const b64 = btoa(String.fromCharCode(...bytes))
    const out = Array.from(decodePcm16(b64))
    expect(out).toEqual([0, 32767 / 32768, -1, -1 / 32768, 0.5])
  })

  it("ignores a trailing odd byte", () => {
    expect(decodePcm16(btoa("\x01\x00\x02")).length).toBe(1)
  })
})

describe("naturalParagraphs", () => {
  it("is the prepared text's lines, trimmed, without blanks", () => {
    expect(naturalParagraphs("  שלום.\n\nSecond line. \n")).toEqual([
      "שלום.",
      "Second line.",
    ])
    expect(naturalParagraphs("\n \n")).toEqual([])
  })
})

describe("NaturalSession", () => {
  it("asks for one paragraph at a time and queues its chunks back to back", async () => {
    const { api, audio, onEnded } = session(["First one.", "Second one."])
    await settle()
    expect(api.spoken).toEqual([
      { text: "First one.", voice: "adam", speed: 1.2 },
    ])

    api.respond("s1", {
      chunks: [
        FakeNaturalApi.chunk(0, 44_100),
        FakeNaturalApi.chunk(1, 22_050),
      ],
    })
    await settle()
    expect(audio.scheduled.map((e) => e.when)).toEqual([0.05, 1.05])
    expect(audio.scheduled.every((e) => e.sampleRate === 44_100)).toBe(true)

    api.respond("s1", { done: true, chunks: [FakeNaturalApi.chunk(2, 4_410)] })
    await settle()
    // The next paragraph is synthesized while the first still plays.
    expect(api.spoken.map((s) => s.text)).toEqual(["First one.", "Second one."])
    api.respond("s2", { done: true, chunks: [FakeNaturalApi.chunk(0, 4_410)] })
    await settle()

    const whens = audio.scheduled.map((e) => e.when)
    expect(whens[2]).toBeCloseTo(1.55)
    // A short pause between paragraphs.
    expect(whens[3]).toBeCloseTo(1.65 + 0.25)
    expect(onEnded).not.toHaveBeenCalled()

    audio.finishAll()
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it("never schedules in the past", async () => {
    const { api, audio } = session(["One."])
    await settle()
    audio.currentTime = 10
    api.respond("s1", { chunks: [FakeNaturalApi.chunk(0)] })
    await settle()
    expect(audio.scheduled[0].when).toBeCloseTo(10.05)
  })

  it("stop drops the queued audio and cancels the synthesis in flight", async () => {
    const { s, api, audio, onEnded, onFailed } = session(["One.", "Two."])
    await settle()
    api.respond("s1", { chunks: [FakeNaturalApi.chunk(0)] })
    await settle()
    s.stop()
    expect(audio.scheduled.every((e) => e.stopped)).toBe(true)
    expect(api.cancelled).toEqual(["s1"])

    api.respond("s1", { done: true, chunks: [FakeNaturalApi.chunk(1)] })
    await settle()
    expect(api.spoken).toHaveLength(1)
    expect(onEnded).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it("a failure plays what was queued, then hands over the rest", async () => {
    const { api, audio, onFailed } = session(["One.", "Two.", "Three."])
    await settle()
    api.respond("s1", { done: true, chunks: [FakeNaturalApi.chunk(0)] })
    await settle()
    api.respond("s2", { done: true, error: "the speech engine exited" })
    await settle()
    expect(onFailed).not.toHaveBeenCalled()

    audio.finishAll()
    expect(onFailed).toHaveBeenCalledTimes(1)
    const [rest, error] = onFailed.mock.calls[0]
    expect(rest).toEqual(["Two.", "Three."])
    expect((error as Error).message).toBe("the speech engine exited")
  })

  it("a backend that refuses at once hands over everything", async () => {
    const api = new FakeNaturalApi()
    api.failSpeak = new Error("the natural voice is not downloaded")
    const { onFailed } = session(["One.", "Two."], { api })
    await settle()
    expect(onFailed).toHaveBeenCalledWith(
      ["One.", "Two."],
      expect.objectContaining({
        message: "the natural voice is not downloaded",
      })
    )
  })

  it("pause and resume suspend and resume the audio clock", async () => {
    const { s, audio } = session(["One."])
    s.pause()
    expect(audio.suspends).toBe(1)
    s.resume()
    expect(audio.resumes).toBe(1)
  })

  it("falls back when the audio output won't start (no click yet)", async () => {
    vi.useFakeTimers()
    const audio = new FakeAudioOut()
    audio.state = "suspended"
    // This context refuses to start.
    audio.resume = async () => {
      audio.resumes += 1
    }
    const { api, onFailed } = session(["One.", "Two."], { audio })
    await vi.advanceTimersByTimeAsync(0)
    api.respond("s1", { chunks: [FakeNaturalApi.chunk(0)] })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(audio.scheduled).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed.mock.calls[0][0]).toEqual(["One.", "Two."])
  })
})
