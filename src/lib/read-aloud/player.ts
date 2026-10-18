/**
 * Reads replies aloud with the system's own voices (Web Speech API).
 *
 * The same code runs in the desktop app (WKWebView on macOS), a browser on the
 * server build and a remote-workspace window, and in each it speaks on the
 * device the user is looking at. Nothing leaves the machine and nothing is
 * downloaded.
 *
 * A reply is prepared once (`speechTextFromMarkdown`), cut into sentences and
 * script runs (`buildSpeechSegments`), and fed to the engine ONE utterance at
 * a time: the first sentence starts at once, Stop drops the rest of the queue
 * without relying on the engine's own queue, and each run can carry its own
 * voice — Hebrew for Hebrew, English for English.
 *
 * Engine quirks this works around:
 * - `getVoices()` is empty until the engine has loaded its list; it is read
 *   again on `voiceschanged` and, since WebKit does not always fire that,
 *   polled briefly.
 * - Chrome cuts off an utterance after about fifteen seconds and garbage-
 *   collects an utterance nothing references, so its `end` never fires:
 *   segments are short, and the one being spoken is held here.
 * - `speak()` straight after `cancel()` is sometimes dropped (WebKit), so a
 *   reply that replaces another starts after a short pause.
 * - Native `pause()` is unreliable (Chrome on Linux and Android ignores it,
 *   and can stay stuck "paused" afterwards), so pausing cancels the current
 *   sentence and resuming starts that sentence again.
 * - An `end` that never comes is caught by a watchdog that sees the engine
 *   gone quiet.
 * - Chrome keeps speaking after the page is gone; leaving the page stops it.
 */

import {
  buildSpeechSegments,
  speechTextFromMarkdown,
  type SpeechSegment,
} from "./speech-text"
import { langForText, pickVoice, normalizeLang, type VoiceLike } from "./voices"
import { getReadAloudPrefs, type ReadAloudPrefs } from "./prefs"

export type ReadAloudStatus = "idle" | "playing" | "paused"

export interface ReadAloudState {
  status: ReadAloudStatus
  /** What is being read: a reply's id, `selection`, or a test sample. */
  currentId: string | null
}

export const IDLE_STATE: ReadAloudState = { status: "idle", currentId: null }

export type SpeakResult =
  | {
      ok: true
      /** Languages the text needs that no installed voice speaks. */
      missingVoices: string[]
    }
  | { ok: false; reason: "unsupported" | "empty" }

/** The parts of `SpeechSynthesisUtterance` the player sets. */
export interface UtteranceLike {
  text: string
  lang: string
  voice: VoiceLike | null
  rate: number
  onend: ((event: unknown) => void) | null
  onerror: ((event: { error?: string }) => void) | null
}

/** The parts of `window.speechSynthesis` the player uses. */
export interface SynthLike {
  readonly speaking: boolean
  readonly pending: boolean
  readonly paused: boolean
  speak(utterance: UtteranceLike): void
  cancel(): void
  resume(): void
  getVoices(): VoiceLike[]
  addEventListener?: (type: "voiceschanged", listener: () => void) => void
}

export interface PlayerEnv {
  synth: SynthLike
  createUtterance: (text: string) => UtteranceLike
  getPrefs?: () => ReadAloudPrefs
  now?: () => number
  /** Where Escape is listened for; omitted in tests that don't need it. */
  keyTarget?: Pick<Document, "addEventListener" | "removeEventListener">
}

/** Pause between `cancel()` and the next `speak()` when switching replies. */
export const RESTART_DELAY_MS = 80
/** How often the watchdog checks on an utterance whose `end` hasn't come. */
export const WATCHDOG_INTERVAL_MS = 500
/** How long voices are polled for when `voiceschanged` doesn't fire. */
const VOICE_POLL_MS = 250
const VOICE_POLL_TRIES = 20

interface QueuedSegment extends SpeechSegment {
  lang: string
  voice: VoiceLike | null
}

export class ReadAloudPlayer {
  private readonly synth: SynthLike
  private readonly createUtterance: (text: string) => UtteranceLike
  private readonly getPrefs: () => ReadAloudPrefs
  private readonly now: () => number
  private readonly keyTarget?: PlayerEnv["keyTarget"]

  private state: ReadAloudState = IDLE_STATE
  private readonly listeners = new Set<() => void>()

  private voices: VoiceLike[] = []
  private readonly voiceListeners = new Set<() => void>()
  private voicePoll: ReturnType<typeof setInterval> | null = null

  /** Bumped by every start, pause and stop: callbacks from an older
   *  generation belong to utterances that were cancelled. */
  private generation = 0
  private queue: QueuedSegment[] = []
  private index = 0
  /** The utterance being spoken, held so Chrome can't collect it. */
  private current: UtteranceLike | null = null
  private startedAt = 0
  private quietTicks = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private escapeBound = false

  constructor(env: PlayerEnv) {
    this.synth = env.synth
    this.createUtterance = env.createUtterance
    this.getPrefs = env.getPrefs ?? getReadAloudPrefs
    this.now = env.now ?? (() => Date.now())
    this.keyTarget = env.keyTarget
    this.loadVoices()
  }

  // ── State ──

  getState = (): ReadAloudState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(next: ReadAloudState): void {
    if (
      next.status === this.state.status &&
      next.currentId === this.state.currentId
    ) {
      return
    }
    this.state = next
    if (next.status === "idle") this.unbindEscape()
    else this.bindEscape()
    for (const listener of this.listeners) listener()
  }

  isReading(id: string): boolean {
    return this.state.currentId === id && this.state.status !== "idle"
  }

  // ── Voices ──

  getVoices = (): VoiceLike[] => this.voices

  subscribeVoices = (listener: () => void): (() => void) => {
    this.voiceListeners.add(listener)
    return () => {
      this.voiceListeners.delete(listener)
    }
  }

  private refreshVoices = (): void => {
    let next: VoiceLike[] = []
    try {
      next = Array.from(this.synth.getVoices() ?? [])
    } catch {
      next = []
    }
    const same =
      next.length === this.voices.length &&
      next.every((voice, i) => voice.voiceURI === this.voices[i]?.voiceURI)
    if (next.length > 0 && this.voicePoll) {
      clearInterval(this.voicePoll)
      this.voicePoll = null
    }
    if (same) return
    this.voices = next
    for (const listener of this.voiceListeners) listener()
  }

  private loadVoices(): void {
    this.refreshVoices()
    try {
      this.synth.addEventListener?.("voiceschanged", this.refreshVoices)
    } catch {
      /* an engine without the event: the poll below covers it */
    }
    if (this.voices.length > 0) return
    let tries = 0
    this.voicePoll = setInterval(() => {
      tries += 1
      this.refreshVoices()
      if (tries >= VOICE_POLL_TRIES && this.voicePoll) {
        clearInterval(this.voicePoll)
        this.voicePoll = null
      }
    }, VOICE_POLL_MS)
  }

  /** The voice that reads `lang`, honouring the voices pinned in Settings. */
  private voiceFor(lang: string, prefs: ReadAloudPrefs): VoiceLike | null {
    if (!lang) return null
    const base = normalizeLang(lang).base
    const pinned =
      base === "he"
        ? prefs.hebrewVoice
        : base === "en"
          ? prefs.englishVoice
          : null
    return pickVoice(this.voices, base, pinned) ?? null
  }

  // ── Playback ──

  /** Start reading `markdown` as `id`, or stop when `id` is being read. */
  toggle(id: string, markdown: string): SpeakResult | null {
    if (this.isReading(id)) {
      this.stop()
      return null
    }
    return this.speak(id, markdown)
  }

  /** Read `markdown` as `id`, replacing whatever is being read. */
  speak(id: string, markdown: string): SpeakResult {
    const segments = buildSpeechSegments(speechTextFromMarkdown(markdown))
    if (segments.length === 0) return { ok: false, reason: "empty" }

    // Voices may have arrived without an event (WebKit).
    if (this.voices.length === 0) this.refreshVoices()
    const prefs = this.getPrefs()
    const missing = new Set<string>()
    const queue = segments.map((segment) => {
      const lang = langForText(segment.script, segment.text)
      const voice = this.voiceFor(lang, prefs)
      // Only claim a voice is missing when the list has loaded at all.
      if (!voice && lang && this.voices.length > 0) {
        missing.add(normalizeLang(lang).base)
      }
      return { ...segment, lang, voice }
    })

    const engineBusy = this.state.status !== "idle" || this.engineActive()
    this.halt()
    this.queue = queue
    this.index = 0
    this.setState({ status: "playing", currentId: id })
    const generation = this.generation
    if (engineBusy) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null
        this.speakNext(generation)
      }, RESTART_DELAY_MS)
    } else {
      // Synchronously, inside the click that asked for it: some engines only
      // let a user gesture start speech.
      this.speakNext(generation)
    }
    return { ok: true, missingVoices: [...missing] }
  }

  pause(): void {
    if (this.state.status !== "playing") return
    // The sentence being spoken is cancelled and starts over on resume.
    this.halt()
    this.setState({ status: "paused", currentId: this.state.currentId })
  }

  resume(): void {
    if (this.state.status !== "paused") return
    this.setState({ status: "playing", currentId: this.state.currentId })
    this.speakNext(this.generation)
  }

  stop(): void {
    this.halt()
    this.queue = []
    this.index = 0
    this.setState(IDLE_STATE)
  }

  private engineActive(): boolean {
    return this.synth.speaking || this.synth.pending || this.synth.paused
  }

  /** Cancel whatever the engine is doing and forget the utterance in flight. */
  private halt(): void {
    this.generation += 1
    this.current = null
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    this.stopWatchdog()
    if (this.engineActive()) {
      this.synth.cancel()
      // Chrome can stay "paused" after a cancel, and then queues every later
      // utterance silently.
      if (this.synth.paused) this.synth.resume()
    }
  }

  private speakNext(generation: number): void {
    if (generation !== this.generation || this.state.status !== "playing") {
      return
    }
    const segment = this.queue[this.index]
    if (!segment) {
      this.stop()
      return
    }
    const utterance = this.createUtterance(segment.text)
    // The voice's own tag where there is a voice (`he_IL` on Android → he-IL).
    if (segment.lang) {
      utterance.lang = (segment.voice?.lang ?? segment.lang).replace(/_/g, "-")
    }
    if (segment.voice) utterance.voice = segment.voice
    utterance.rate = this.getPrefs().rate
    utterance.onend = () => this.advance(generation, utterance)
    // A failed sentence is skipped rather than ending the reply.
    utterance.onerror = () => this.advance(generation, utterance)
    this.current = utterance
    this.startedAt = this.now()
    this.quietTicks = 0
    this.synth.speak(utterance)
    this.startWatchdog(generation)
  }

  private advance(generation: number, utterance: UtteranceLike): void {
    if (generation !== this.generation || utterance !== this.current) return
    this.current = null
    this.index += 1
    this.speakNext(generation)
  }

  private startWatchdog(generation: number): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      const utterance = this.current
      if (!utterance || generation !== this.generation) return
      if (this.synth.speaking || this.synth.pending) {
        this.quietTicks = 0
        return
      }
      this.quietTicks += 1
      // Generous on purpose: an engine that misreports `speaking` must not
      // have its sentences cut short.
      const rate = utterance.rate > 0 ? utterance.rate : 1
      const expected = 1500 + (utterance.text.length * 60) / rate
      if (this.quietTicks >= 3 && this.now() - this.startedAt > expected) {
        this.advance(generation, utterance)
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  // ── Escape ──

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return
    if (event.isComposing) return
    this.stop()
  }

  private bindEscape(): void {
    if (this.escapeBound || !this.keyTarget) return
    this.escapeBound = true
    // Bubble phase, and only when nothing else claimed the key: Escape that
    // closes a dialog or a menu is theirs.
    this.keyTarget.addEventListener("keydown", this.onKeyDown)
  }

  private unbindEscape(): void {
    if (!this.escapeBound || !this.keyTarget) return
    this.escapeBound = false
    this.keyTarget.removeEventListener("keydown", this.onKeyDown)
  }
}

// ── The window's player ──

/** Whether this runtime can speak at all. */
export function isReadAloudSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    window.speechSynthesis !== null &&
    typeof window.SpeechSynthesisUtterance === "function"
  )
}

let instance: ReadAloudPlayer | null = null

/** This window's player, or null where speech synthesis is unavailable. */
export function getReadAloudPlayer(): ReadAloudPlayer | null {
  if (instance) return instance
  if (!isReadAloudSupported()) return null
  const synth = window.speechSynthesis
  instance = new ReadAloudPlayer({
    synth: synth as unknown as SynthLike,
    createUtterance: (text) =>
      new window.SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    keyTarget: document,
  })
  const player = instance
  window.addEventListener("pagehide", () => player.stop())
  return instance
}

/** Test seam: drop the window's player so the next call builds a fresh one. */
export function resetReadAloudPlayerForTests(): void {
  instance?.stop()
  instance = null
}
