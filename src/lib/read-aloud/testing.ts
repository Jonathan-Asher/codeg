/**
 * A stand-in speech engine for tests. Not imported by the app.
 */

import {
  resetReadAloudPlayerForTests,
  type SynthLike,
  type UtteranceLike,
} from "./player"
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
 * it. Returns the engine and a function that takes both away again.
 */
export function installFakeSpeech(voices: VoiceLike[] = FAKE_VOICES): {
  synth: FakeSynth
  uninstall: () => void
} {
  const synth = new FakeSynth(voices)
  const target = window as unknown as Record<string, unknown>
  target.speechSynthesis = synth
  target.SpeechSynthesisUtterance = FakeUtterance
  resetReadAloudPlayerForTests()
  return {
    synth,
    uninstall: () => {
      resetReadAloudPlayerForTests()
      delete target.speechSynthesis
      delete target.SpeechSynthesisUtterance
    },
  }
}
