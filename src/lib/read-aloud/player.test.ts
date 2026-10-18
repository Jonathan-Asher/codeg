import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  RESTART_DELAY_MS,
  ReadAloudPlayer,
  getReadAloudPlayer,
  isReadAloudSupported,
} from "./player"
import { DEFAULT_READ_ALOUD_PREFS, type ReadAloudPrefs } from "./prefs"
import {
  FakeSynth,
  FakeUtterance,
  fakeVoice as voice,
  installFakeSpeech,
} from "./testing"
import type { VoiceLike } from "./voices"

const CARMIT = voice("Carmit", "he-IL")
const SAMANTHA = voice("Samantha", "en-US")
const DANIEL = voice("Daniel", "en-GB")
const VOICES = [SAMANTHA, DANIEL, CARMIT]

const REPLY = [
  "שלום! הרצתי את `pnpm test` והכל עבר.",
  "",
  "```ts",
  "const skipped = true",
  "```",
  "",
  "- Everything is green.",
].join("\n")

function setup(
  options: {
    voices?: VoiceLike[]
    prefs?: Partial<ReadAloudPrefs>
    keyTarget?: Document
  } = {}
) {
  const synth = new FakeSynth(options.voices ?? VOICES)
  const prefs = { ...DEFAULT_READ_ALOUD_PREFS, ...options.prefs }
  let now = 0
  const player = new ReadAloudPlayer({
    synth,
    createUtterance: (text) => new FakeUtterance(text),
    getPrefs: () => prefs,
    now: () => now,
    keyTarget: options.keyTarget,
  })
  return {
    synth,
    player,
    advance: (ms: number) => {
      now += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("ReadAloudPlayer queue", () => {
  it("speaks one utterance at a time, sentence by sentence, run by run", () => {
    const { synth, player } = setup()
    const result = player.speak("r1", REPLY)
    expect(result).toEqual({ ok: true, missingVoices: [] })
    // Started synchronously, inside the click that asked for it.
    expect(synth.spoken).toHaveLength(1)
    expect(player.getState()).toEqual({ status: "playing", currentId: "r1" })

    const spoken = synth.finishAll()
    expect(spoken).toEqual([
      "שלום!",
      "הרצתי את",
      "pnpm test",
      "והכל עבר.",
      "Everything is green.",
    ])
    expect(synth.spoken.map((u) => [u.lang, u.voice?.name])).toEqual([
      ["he-IL", "Carmit"],
      ["he-IL", "Carmit"],
      ["en-US", "Samantha"],
      ["he-IL", "Carmit"],
      ["en-US", "Samantha"],
    ])
    expect(player.getState().status).toBe("idle")
  })

  it("never speaks the code", () => {
    const { synth, player } = setup()
    player.speak("r1", REPLY)
    expect(synth.finishAll().join(" ")).not.toContain("skipped")
  })

  it("uses the voices pinned in Settings and the rate", () => {
    const other = voice("Other Hebrew", "he-IL")
    const { synth, player } = setup({
      voices: [...VOICES, other],
      prefs: {
        hebrewVoice: other.voiceURI,
        englishVoice: DANIEL.voiceURI,
        rate: 1.4,
      },
    })
    player.speak("r1", "שלום world")
    synth.finishAll()
    expect(synth.spoken.map((u) => [u.voice?.name, u.lang, u.rate])).toEqual([
      ["Other Hebrew", "he-IL", 1.4],
      ["Daniel", "en-GB", 1.4],
    ])
  })

  it("reports a missing Hebrew voice and still sends the Hebrew with its language", () => {
    const { synth, player } = setup({ voices: [SAMANTHA] })
    expect(player.speak("r1", "שלום world")).toEqual({
      ok: true,
      missingVoices: ["he"],
    })
    expect(synth.spoken[0].lang).toBe("he-IL")
    expect(synth.spoken[0].voice).toBeNull()
  })

  it("does not claim a voice is missing before the list has loaded", () => {
    const { player } = setup({ voices: [] })
    expect(player.speak("r1", "שלום")).toEqual({ ok: true, missingVoices: [] })
  })

  it("says there is nothing to read for a reply that is only code", () => {
    const { synth, player } = setup()
    expect(player.speak("r1", "```\nconst a = 1\n```")).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(synth.spoken).toHaveLength(0)
    expect(player.getState().status).toBe("idle")
  })
})

describe("ReadAloudPlayer controls", () => {
  it("Stop cancels the utterance and drops the rest of the queue", () => {
    const { synth, player } = setup()
    player.speak("r1", REPLY)
    synth.finish()
    expect(synth.spoken).toHaveLength(2)

    player.stop()
    expect(synth.cancels).toBe(1)
    expect(player.getState()).toEqual({ status: "idle", currentId: null })
    // A late `end` from the cancelled utterance does not resume the queue.
    synth.spoken[1].onend?.({})
    expect(synth.spoken).toHaveLength(2)
    expect(synth.current).toBeNull()
  })

  it("toggles the same reply off and replaces a different one", () => {
    const { synth, player, advance } = setup()
    player.toggle("r1", "First reply. It has two sentences.")
    expect(player.isReading("r1")).toBe(true)

    player.toggle("r2", "Second reply.")
    expect(player.getState().currentId).toBe("r2")
    expect(synth.cancels).toBe(1)
    // Starts after a short pause: WebKit drops a speak() right after cancel().
    expect(synth.spoken).toHaveLength(1)
    advance(RESTART_DELAY_MS)
    expect(synth.spoken.map((u) => u.text)).toEqual([
      "First reply.",
      "Second reply.",
    ])

    expect(player.toggle("r2", "Second reply.")).toBeNull()
    expect(player.getState().status).toBe("idle")
    // Nothing of the first reply comes back.
    advance(5_000)
    expect(synth.spoken).toHaveLength(2)
  })

  it("pauses by cancelling the sentence and resumes from its start", () => {
    const { synth, player } = setup()
    player.speak("r1", "One. Two. Three.")
    synth.finish()
    expect(synth.current?.text).toBe("Two.")

    player.pause()
    expect(player.getState()).toEqual({ status: "paused", currentId: "r1" })
    expect(synth.current).toBeNull()
    expect(player.isReading("r1")).toBe(true)

    player.resume()
    expect(player.getState().status).toBe("playing")
    expect(synth.finishAll()).toEqual(["Two.", "Three."])
    expect(player.getState().status).toBe("idle")
  })

  it("ignores pause while idle and resume while playing", () => {
    const { synth, player } = setup()
    player.pause()
    expect(player.getState().status).toBe("idle")
    player.speak("r1", "One. Two.")
    player.resume()
    expect(synth.spoken).toHaveLength(1)
  })

  it("skips a sentence the engine fails on", () => {
    const { synth, player } = setup()
    player.speak("r1", "One. Two.")
    synth.current?.onerror?.({ error: "synthesis-failed" })
    expect(synth.spoken.map((u) => u.text)).toEqual(["One.", "Two."])
  })

  it("notifies subscribers on every change of state", () => {
    const { synth, player } = setup()
    const seen: string[] = []
    player.subscribe(() => {
      const { status, currentId } = player.getState()
      seen.push(`${status}:${currentId}`)
    })
    player.speak("r1", "One.")
    player.pause()
    player.resume()
    synth.finishAll()
    expect(seen).toEqual(["playing:r1", "paused:r1", "playing:r1", "idle:null"])
  })
})

describe("ReadAloudPlayer engine quirks", () => {
  it("moves on when an utterance's end never arrives and the engine is quiet", () => {
    const { synth, player, advance } = setup()
    player.speak("r1", "One. Two.")
    // The engine went quiet without firing `end` (Chrome's lost utterance).
    synth.speaking = false
    advance(1_000)
    expect(synth.spoken).toHaveLength(1)
    advance(3_000)
    expect(synth.spoken.map((u) => u.text)).toEqual(["One.", "Two."])
  })

  it("leaves an utterance alone while the engine is still speaking", () => {
    const { synth, player, advance } = setup()
    player.speak("r1", "One. Two.")
    advance(60_000)
    expect(synth.spoken).toHaveLength(1)
  })

  it("takes voices that load late, from the event or a later read", () => {
    const { synth, player } = setup({ voices: [] })
    const listener = vi.fn()
    player.subscribeVoices(listener)
    expect(player.getVoices()).toEqual([])

    synth.setVoices(VOICES)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(player.getVoices().map((v) => v.name)).toEqual([
      "Samantha",
      "Daniel",
      "Carmit",
    ])
  })

  it("polls for voices when the engine never fires voiceschanged", () => {
    const { synth, player, advance } = setup({ voices: [] })
    synth.voices = VOICES
    advance(300)
    expect(player.getVoices()).toHaveLength(3)
  })

  it("un-sticks an engine left paused before speaking", () => {
    const { synth, player } = setup()
    synth.paused = true
    player.speak("r1", "One.")
    expect(synth.paused).toBe(false)
  })
})

describe("ReadAloudPlayer Escape", () => {
  it("stops on Escape unless another handler took the key", () => {
    const { player } = setup({ keyTarget: document })
    player.speak("r1", "One. Two.")

    const claimed = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    })
    claimed.preventDefault()
    document.dispatchEvent(claimed)
    expect(player.getState().status).toBe("playing")

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(player.getState().status).toBe("idle")
  })

  it("only listens while something is being read", () => {
    const add = vi.spyOn(document, "addEventListener")
    const remove = vi.spyOn(document, "removeEventListener")
    const { synth, player } = setup({ keyTarget: document })
    expect(add).not.toHaveBeenCalledWith("keydown", expect.any(Function))
    player.speak("r1", "One.")
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function))
    synth.finishAll()
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function))
    add.mockRestore()
    remove.mockRestore()
  })
})

describe("getReadAloudPlayer", () => {
  it("is null where the runtime has no speech synthesis", () => {
    // jsdom has none, like a WebView without the Web Speech API.
    expect(isReadAloudSupported()).toBe(false)
    expect(getReadAloudPlayer()).toBeNull()
  })

  it("is one player per window where the engine exists, stopped on pagehide", () => {
    const { synth, uninstall } = installFakeSpeech()
    try {
      const player = getReadAloudPlayer()
      expect(player).not.toBeNull()
      expect(getReadAloudPlayer()).toBe(player)
      player?.speak("r1", "One. Two.")
      expect(synth.spoken[0]).toBeInstanceOf(FakeUtterance)
      window.dispatchEvent(new Event("pagehide"))
      expect(player?.getState().status).toBe("idle")
      expect(synth.cancels).toBe(1)
    } finally {
      uninstall()
    }
  })
})
