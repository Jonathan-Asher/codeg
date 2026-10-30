import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  NATURAL_STATUS_CHECK_MS,
  NATURAL_STATUS_TTL_MS,
  ReadAloudPlayer,
  type ReadAloudNotice,
} from "./player"
import type { TtsStatus } from "./natural-api"
import { DEFAULT_READ_ALOUD_PREFS, type ReadAloudPrefs } from "./prefs"
import {
  FAKE_VOICES,
  FakeAudioOut,
  FakeNaturalApi,
  FakeSynth,
  FakeUtterance,
  fakeTtsStatus,
} from "./testing"

const REPLY = [
  "עדכנתי את ה-`Dockerfile` ודחפתי ל-main.",
  "",
  "```sh",
  "pnpm test",
  "```",
  "",
  "- The build passed.",
].join("\n")

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function setup(
  options: {
    prefs?: Partial<ReadAloudPrefs>
    status?: TtsStatus | null
    audio?: FakeAudioOut | null
    keyTarget?: Document
    /** How long ago the backend gave `status`, in ms (default: just now). */
    statusAge?: number
    /** What the backend says when asked again; not asked without it. */
    recheck?: () => Promise<TtsStatus | null>
  } = {}
) {
  const synth = new FakeSynth(FAKE_VOICES)
  const api = new FakeNaturalApi()
  const audio = options.audio === undefined ? new FakeAudioOut() : options.audio
  const prefs = { ...DEFAULT_READ_ALOUD_PREFS, ...options.prefs }
  let status = options.status === undefined ? fakeTtsStatus() : options.status
  let statusAge = options.statusAge ?? 0
  const recheck = options.recheck
  const refreshStatus = recheck
    ? vi.fn(async () => {
        status = await recheck()
        statusAge = 0
      })
    : undefined
  const player = new ReadAloudPlayer({
    synth,
    createUtterance: (text) => new FakeUtterance(text),
    getPrefs: () => prefs,
    keyTarget: options.keyTarget,
    natural: {
      api,
      getAudio: () => audio,
      getStatus: () => status,
      getStatusAge: () => statusAge,
      refreshStatus,
    },
  })
  const notices: ReadAloudNotice[] = []
  player.subscribeNotices((n) => notices.push(n))
  return {
    synth,
    api,
    // Null only in the test without Web Audio, which never touches it.
    audio: audio as FakeAudioOut,
    player,
    prefs,
    notices,
    refreshStatus,
    setStatus: (next: TtsStatus | null) => {
      status = next
    },
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("engine choice", () => {
  it("reads with the natural voice once its models are installed", async () => {
    const { player, api, synth } = setup()
    expect(player.speak("r1", REPLY)).toEqual({ ok: true, missingVoices: [] })
    expect(player.getState()).toEqual({ status: "playing", currentId: "r1" })
    await settle()
    // The same prepared text as the system voices get: fenced code skipped,
    // inline code kept, the list item its own paragraph.
    expect(api.spoken.map((s) => s.text)).toEqual([
      "עדכנתי את ה-Dockerfile ודחפתי ל-main.",
    ])
    expect(synth.spoken).toHaveLength(0)
  })

  it("passes the chosen speaker and the speaking rate", async () => {
    const { player, api } = setup({
      prefs: { naturalVoice: "adam", rate: 1.3 },
    })
    player.speak("r1", "Hello there.")
    await settle()
    expect(api.spoken[0]).toEqual({
      text: "Hello there.",
      voice: "adam",
      speed: 1.3,
    })
  })

  it("uses the system voices when they are chosen, even with the models installed", () => {
    const { player, api, synth } = setup({ prefs: { engine: "system" } })
    player.speak("r1", "Hello there.")
    expect(synth.spoken.map((u) => u.text)).toEqual(["Hello there."])
    expect(api.spoken).toHaveLength(0)
  })

  it("uses the system voices until the models are downloaded", () => {
    const { player, api, synth } = setup({
      status: fakeTtsStatus({ installed: false }),
    })
    player.speak("r1", "Hello there.")
    expect(synth.spoken).toHaveLength(1)
    expect(api.spoken).toHaveLength(0)
  })

  it("uses the system voices where the backend can't make the natural voice", () => {
    const { player, synth } = setup({
      status: fakeTtsStatus({
        supported: false,
        unsupportedReason: "platform",
      }),
      prefs: { engine: "natural" },
    })
    player.speak("r1", "Hello there.")
    expect(synth.spoken).toHaveLength(1)
  })

  it("tries the natural voice before the status is known only if it was chosen", async () => {
    const unknown = setup({ status: null })
    unknown.player.speak("r1", "Hello.")
    expect(unknown.synth.spoken).toHaveLength(1)

    const chosen = setup({ status: null, prefs: { engine: "natural" } })
    chosen.player.speak("r1", "Hello.")
    await settle()
    expect(chosen.api.spoken).toHaveLength(1)
    expect(chosen.synth.spoken).toHaveLength(0)
  })

  it("uses the system voices where there is no Web Audio", () => {
    const { player, synth } = setup({ audio: null })
    player.speak("r1", "Hello.")
    expect(synth.spoken).toHaveLength(1)
  })

  it("reports a reply with nothing to read", () => {
    const { player } = setup()
    expect(player.speak("r1", "```\ncode only\n```")).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(player.getState().status).toBe("idle")
  })
})

describe("a status that may be out of date", () => {
  // The models were downloaded in another window (Settings) after this one
  // last heard from the backend.
  const STALE = NATURAL_STATUS_TTL_MS + 1
  const missing = () => fakeTtsStatus({ installed: false })

  it("tries the engine for a user who chose the natural voice", async () => {
    const { player, api, synth } = setup({
      prefs: { engine: "natural" },
      status: missing(),
      statusAge: STALE,
    })
    player.speak("r1", "Hello there.")
    await settle()
    expect(api.spoken).toHaveLength(1)
    expect(synth.spoken).toHaveLength(0)
  })

  it("asks the backend before a chosen natural voice gives way to the system voices", async () => {
    const ready = setup({
      prefs: { engine: "natural" },
      status: missing(),
      statusAge: STALE,
      recheck: async () => fakeTtsStatus(),
    })
    ready.player.speak("r1", "Hello there.")
    await settle()
    expect(ready.refreshStatus).toHaveBeenCalledTimes(1)
    expect(ready.api.spoken).toHaveLength(1)
    expect(ready.synth.spoken).toHaveLength(0)

    // Still downloading: the system voices read, as Settings says, with no
    // "the natural voice stopped" notice.
    const pending = setup({
      prefs: { engine: "natural" },
      status: missing(),
      statusAge: STALE,
      recheck: async () => missing(),
    })
    pending.player.speak("r1", "Hello there.")
    await settle()
    expect(pending.api.spoken).toHaveLength(0)
    expect(pending.synth.spoken).toHaveLength(1)
    expect(pending.notices).toEqual([])
  })

  it("tries a chosen natural voice when the backend doesn't answer in time", async () => {
    vi.useFakeTimers()
    const { player, api, synth } = setup({
      prefs: { engine: "natural" },
      status: missing(),
      statusAge: STALE,
      recheck: () => new Promise(() => {}),
    })
    player.speak("r1", "Hello there.")
    await vi.advanceTimersByTimeAsync(NATURAL_STATUS_CHECK_MS - 1)
    expect(api.spoken).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(api.spoken).toHaveLength(1)
    expect(synth.spoken).toHaveLength(0)
  })

  it("with no choice, asks the backend before falling back to the system voices", async () => {
    const { player, api, synth, audio, refreshStatus } = setup({
      status: missing(),
      statusAge: STALE,
      recheck: async () => fakeTtsStatus(),
    })
    expect(player.speak("r1", "Hello there.")).toEqual({
      ok: true,
      missingVoices: [],
    })
    // The reply shows as being read while the backend is asked.
    expect(player.getState()).toEqual({ status: "playing", currentId: "r1" })
    // The audio output starts inside the click, as the natural voice needs.
    expect(audio.resumes).toBe(1)
    await settle()
    expect(refreshStatus).toHaveBeenCalledTimes(1)
    expect(api.spoken.map((s) => s.text)).toEqual(["Hello there."])
    expect(synth.spoken).toHaveLength(0)
  })

  it("with no choice, reads with the system voices once the backend confirms the models are missing", async () => {
    const { player, api, synth, audio } = setup({
      status: missing(),
      statusAge: STALE,
      recheck: async () => missing(),
    })
    player.speak("r1", "Hello there.")
    expect(synth.spoken).toHaveLength(0)
    await settle()
    expect(synth.spoken.map((u) => u.text)).toEqual(["Hello there."])
    expect(api.spoken).toHaveLength(0)
    expect(audio.suspends).toBe(1)
  })

  it("trusts a recent answer and starts at once", () => {
    const { player, synth, refreshStatus } = setup({
      status: missing(),
      statusAge: NATURAL_STATUS_TTL_MS - 1,
      recheck: async () => fakeTtsStatus(),
    })
    player.speak("r1", "Hello there.")
    expect(synth.spoken).toHaveLength(1)
    expect(refreshStatus).not.toHaveBeenCalled()
  })

  it("drops the check's answer when the reply was stopped meanwhile", async () => {
    const { player, api, synth } = setup({
      status: missing(),
      statusAge: STALE,
      recheck: async () => fakeTtsStatus(),
    })
    player.speak("r1", "Hello there.")
    player.stop()
    await settle()
    expect(api.spoken).toHaveLength(0)
    expect(synth.spoken).toHaveLength(0)
    expect(player.getState().status).toBe("idle")
  })
})

describe("natural playback", () => {
  it("plays the stream, then goes idle and lets go of the audio device", async () => {
    const { player, api, audio } = setup()
    player.speak("r1", "One sentence. Another.")
    expect(audio.resumes).toBe(1)
    await settle()
    api.respond("s1", {
      done: true,
      chunks: [FakeNaturalApi.chunk(0), FakeNaturalApi.chunk(1)],
    })
    await settle()
    expect(audio.scheduled).toHaveLength(2)
    expect(player.getState().status).toBe("playing")

    audio.finishAll()
    expect(player.getState()).toEqual({ status: "idle", currentId: null })
    expect(audio.suspends).toBe(1)
  })

  it("pauses the audio clock instead of restarting a sentence", async () => {
    const { player, audio, api } = setup()
    player.speak("r1", "One sentence.")
    await settle()
    api.respond("s1", { chunks: [FakeNaturalApi.chunk(0)] })
    await settle()

    player.pause()
    expect(player.getState().status).toBe("paused")
    expect(audio.state).toBe("suspended")
    expect(audio.scheduled[0].stopped).toBe(false)
    expect(api.cancelled).toEqual([])

    player.resume()
    expect(player.getState().status).toBe("playing")
    expect(audio.state).toBe("running")
  })

  it("toggling the reply being read stops it and cancels its synthesis", async () => {
    const { player, api, audio } = setup()
    player.toggle("r1", "One sentence.")
    await settle()
    api.respond("s1", { chunks: [FakeNaturalApi.chunk(0)] })
    await settle()
    expect(player.toggle("r1", "One sentence.")).toBeNull()
    expect(player.getState().status).toBe("idle")
    expect(api.cancelled).toEqual(["s1"])
    expect(audio.scheduled[0].stopped).toBe(true)
  })

  it("reading another reply replaces the one being read", async () => {
    const { player, api } = setup()
    player.speak("r1", "First reply.")
    await settle()
    player.speak("r2", "Second reply.")
    await settle()
    expect(api.cancelled).toEqual(["s1"])
    expect(api.spoken.map((s) => s.text)).toEqual([
      "First reply.",
      "Second reply.",
    ])
    expect(player.getState()).toEqual({ status: "playing", currentId: "r2" })
  })

  it("Escape stops natural reading", async () => {
    const { player, api } = setup({ keyTarget: document })
    player.speak("r1", "One sentence.")
    await settle()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(player.getState().status).toBe("idle")
    expect(api.cancelled).toEqual(["s1"])
  })
})

describe("fallback to the system voices", () => {
  it("reads on from the paragraph the natural voice failed on", async () => {
    const { player, api, audio, synth, notices } = setup()
    player.speak("r1", "First paragraph.\n\nSecond paragraph.\n\nThird one.")
    await settle()
    api.respond("s1", { done: true, chunks: [FakeNaturalApi.chunk(0)] })
    await settle()
    api.respond("s2", { done: true, error: "the speech engine exited" })
    await settle()
    // What was already synthesized plays first.
    expect(synth.spoken).toHaveLength(0)
    audio.finishAll()

    expect(notices).toEqual([
      { kind: "natural-fallback", message: "the speech engine exited" },
    ])
    expect(player.getState()).toEqual({ status: "playing", currentId: "r1" })
    expect(synth.finishAll()).toEqual(["Second paragraph.", "Third one."])
    expect(player.getState().status).toBe("idle")
  })

  it("hands a whole reply over when the backend refuses it", async () => {
    const { player, api, synth, notices } = setup()
    api.failSpeak = new Error("the natural voice is not downloaded")
    player.speak("r1", "Hello there.")
    await settle()
    expect(notices).toHaveLength(1)
    expect(synth.finishAll()).toEqual(["Hello there."])
  })

  it("waits for Resume when the reply was paused as it failed", async () => {
    const { player, api, synth } = setup()
    player.speak("r1", "Hello there.")
    player.pause()
    await settle()
    api.respond("s1", { done: true, error: "boom" })
    await settle()
    expect(synth.spoken).toHaveLength(0)
    expect(player.getState().status).toBe("paused")
    player.resume()
    expect(synth.finishAll()).toEqual(["Hello there."])
  })
})
