/**
 * A stand-in speech engine for tests. Not imported by the app.
 */

import {
  resetReadAloudPlayerForTests,
  setNaturalEnvForTests,
  type NaturalEnv,
  type SynthLike,
  type UtteranceLike,
} from "./player"
import type { NaturalApi, TtsPollResult, TtsStatus } from "./natural-api"
import type { AudioOut } from "./natural-player"
import type { VoiceLike } from "./voices"

export class FakeUtterance implements UtteranceLike {
  lang = ""
  voice: VoiceLike | null = null
  rate = 1
  onend: ((event: unknown) => void) | null = null
  onerror: ((event: { error?: string }) => void) | null = null
  constructor(public text: string) {}
}

/**
 * A speech engine that speaks nothing: it records each utterance and lets the
 * test decide when one ends. `cancel()` reports an "interrupted" error on the
 * utterance it drops, synchronously — what Chrome does — so a stale callback
 * reaching the player is part of every test that cancels.
 */
export class FakeSynth implements SynthLike {
  speaking = false
  pending = false
  paused = false
  spoken: FakeUtterance[] = []
  current: FakeUtterance | null = null
  cancels = 0
  voices: VoiceLike[]
  private voiceListeners: Array<() => void> = []

  constructor(voices: VoiceLike[]) {
    this.voices = voices
  }

  speak(utterance: UtteranceLike) {
    const u = utterance as FakeUtterance
    this.spoken.push(u)
    this.current = u
    this.speaking = true
  }

  cancel() {
    this.cancels += 1
    const u = this.current
    this.current = null
    this.speaking = false
    u?.onerror?.({ error: "interrupted" })
  }

  resume() {
    this.paused = false
  }

  getVoices() {
    return this.voices
  }

  addEventListener(_type: "voiceschanged", listener: () => void) {
    this.voiceListeners.push(listener)
  }

  /** The current utterance finishes. */
  finish() {
    const u = this.current
    this.current = null
    this.speaking = false
    u?.onend?.({})
  }

  /** Finish utterances until the engine is idle; returns their texts. */
  finishAll(): string[] {
    const texts: string[] = []
    for (let guard = 0; this.current && guard < 100; guard += 1) {
      texts.push(this.current.text)
      this.finish()
    }
    return texts
  }

  setVoices(voices: VoiceLike[]) {
    this.voices = voices
    for (const listener of this.voiceListeners) listener()
  }
}

export function fakeVoice(name: string, lang: string): VoiceLike {
  return {
    name,
    lang,
    voiceURI: `uri:${name}`,
    default: false,
    localService: true,
  }
}

export const FAKE_VOICES: VoiceLike[] = [
  fakeVoice("Samantha", "en-US"),
  fakeVoice("Daniel", "en-GB"),
  fakeVoice("Carmit", "he-IL"),
]

/**
 * Give `window` a speech engine (jsdom has none) and a fresh player that uses
 * it. Returns the engine and a function that takes both away again. The
 * player gets `natural` as its natural voice, or none.
 */
export function installFakeSpeech(
  voices: VoiceLike[] = FAKE_VOICES,
  natural: NaturalEnv | null = null
): {
  synth: FakeSynth
  uninstall: () => void
} {
  const synth = new FakeSynth(voices)
  const target = window as unknown as Record<string, unknown>
  target.speechSynthesis = synth
  target.SpeechSynthesisUtterance = FakeUtterance
  setNaturalEnvForTests(natural)
  resetReadAloudPlayerForTests()
  return {
    synth,
    uninstall: () => {
      resetReadAloudPlayerForTests()
      setNaturalEnvForTests(undefined)
      delete target.speechSynthesis
      delete target.SpeechSynthesisUtterance
    },
  }
}

// ── The natural voice ──

/** A status with the models downloaded (or not). */
export function fakeTtsStatus(patch: Partial<TtsStatus> = {}): TtsStatus {
  return {
    supported: true,
    unsupportedReason: null,
    installed: true,
    download: { state: "idle" },
    packBytes: 575_644_743,
    bytesOnDisk: 575_644_743,
    modelsDir: "/data/tts/bluetts-2.5",
    voices: ["noa", "adam", "daniel", "lily"],
    defaultVoice: "noa",
    engineRunning: false,
    engineLoaded: false,
    ...patch,
  }
}

/** Base64 of 16-bit PCM holding `samples` samples of silence. */
export function silentPcm(samples: number): string {
  return btoa("\0".repeat(samples * 2))
}

/**
 * A backend that answers like the natural voice's: each `speak` becomes a
 * stream; the test pushes poll answers with `respond`.
 */
export class FakeNaturalApi implements NaturalApi {
  spoken: Array<{ text: string; voice: string | null; speed: number }> = []
  cancelled: string[] = []
  /** Make the next `speak` fail with this error. */
  failSpeak: Error | null = null
  private polls = new Map<string, Array<(r: TtsPollResult) => void>>()
  private queued = new Map<string, TtsPollResult[]>()

  async speak(text: string, voice: string | null, speed: number) {
    if (this.failSpeak) {
      const e = this.failSpeak
      this.failSpeak = null
      throw e
    }
    this.spoken.push({ text, voice, speed })
    return { streamId: `s${this.spoken.length}` }
  }

  poll(streamId: string): Promise<TtsPollResult> {
    const queued = this.queued.get(streamId)
    if (queued?.length) return Promise.resolve(queued.shift()!)
    return new Promise((resolve) => {
      const waiting = this.polls.get(streamId) ?? []
      waiting.push(resolve)
      this.polls.set(streamId, waiting)
    })
  }

  async cancel(streamId: string) {
    this.cancelled.push(streamId)
  }

  /** Answer the stream's next (or pending) poll. */
  respond(streamId: string, result: Partial<TtsPollResult>): void {
    const full: TtsPollResult = {
      chunks: [],
      done: false,
      error: null,
      stats: null,
      ...result,
    }
    const waiting = this.polls.get(streamId)
    const resolve = waiting?.shift()
    if (resolve) resolve(full)
    else this.queued.set(streamId, [...(this.queued.get(streamId) ?? []), full])
  }

  /** One chunk of `samples` silent samples at 44.1 kHz. */
  static chunk(index: number, samples = 4410) {
    return { index, sampleRate: 44_100, pcm: silentPcm(samples) }
  }
}

/** Web Audio that plays nothing: the test decides when buffers end. */
export class FakeAudioOut implements AudioOut {
  currentTime = 0
  state = "running"
  resumes = 0
  suspends = 0
  scheduled: Array<{
    samples: number
    sampleRate: number
    when: number
    ended: () => void
    stopped: boolean
  }> = []

  async resume() {
    this.resumes += 1
    this.state = "running"
  }

  async suspend() {
    this.suspends += 1
    this.state = "suspended"
  }

  schedule(
    samples: Float32Array,
    sampleRate: number,
    when: number,
    onEnded: () => void
  ) {
    const entry = {
      samples: samples.length,
      sampleRate,
      when,
      ended: onEnded,
      stopped: false,
    }
    this.scheduled.push(entry)
    return {
      stop: () => {
        entry.stopped = true
      },
    }
  }

  /** Every buffer scheduled so far finishes playing. */
  finishAll(): void {
    for (const entry of this.scheduled.splice(0)) {
      if (!entry.stopped) entry.ended()
    }
  }
}
