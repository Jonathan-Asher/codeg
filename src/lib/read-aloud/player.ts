/**
 * Reads replies aloud, with the natural voice (BlueTTS, the iPhone app's
 * voice; see `natural-player.ts`) once its models are downloaded, and with the
 * system's own voices (Web Speech API) otherwise or when it fails.
 *
 * The same code runs in the desktop app (WKWebView on macOS), a browser on the
 * server build and a remote-workspace window, and in each it speaks on the
 * device the user is looking at. The system voices never leave the machine;
 * the natural voice is made by the backend of the window (the local app on the
 * desktop, the server for a browser) and played here.
 *
 * A reply the natural voice can't finish is handed to the system voices from
 * the paragraph it was on. Everything below about the engine is about the
 * system voices.
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
import { naturalApi, type NaturalApi, type TtsStatus } from "./natural-api"
import {
  createWebAudioOut,
  naturalParagraphs,
  NaturalSession,
  type AudioOut,
} from "./natural-player"
import {
  getNaturalStatus,
  naturalVoiceReady,
  refreshNaturalStatus,
} from "./natural-status"

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

/** Something the user should hear about that happened after `speak`. */
export type ReadAloudNotice = {
  kind: "natural-fallback"
  /** Why the natural voice stopped. */
  message: string
}

/** What the natural voice needs; absent where there is none. */
export interface NaturalEnv {
  api: NaturalApi
  /** The audio output, created on first use; null without Web Audio. */
  getAudio: () => AudioOut | null
  /** The backend's last known status; null before it answered. */
  getStatus: () => TtsStatus | null
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
  natural?: NaturalEnv
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
  private readonly naturalEnv?: NaturalEnv
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
  /** The reply being read with the natural voice, if it is. */
  private natural: NaturalSession | null = null
  /** The audio output a natural reply used, suspended again on Stop. */
  private naturalAudio: AudioOut | null = null
  private readonly noticeListeners = new Set<
    (notice: ReadAloudNotice) => void
  >()

  constructor(env: PlayerEnv) {
    this.synth = env.synth
    this.createUtterance = env.createUtterance
    this.getPrefs = env.getPrefs ?? getReadAloudPrefs
    this.naturalEnv = env.natural
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

  subscribeNotices = (
    listener: (notice: ReadAloudNotice) => void
  ): (() => void) => {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  private notify(notice: ReadAloudNotice): void {
    for (const listener of this.noticeListeners) listener(notice)
  }

  /** Whether a reply read now goes to the natural voice. */
  usesNaturalVoice(prefs: ReadAloudPrefs = this.getPrefs()): boolean {
    const env = this.naturalEnv
    if (!env || prefs.engine === "system") return false
    const status = env.getStatus()
    // Not known yet: only a user who chose it explicitly gets a try (the
    // backend refuses if it can't, and the system voices take over).
    const ready = status
      ? naturalVoiceReady(status)
      : prefs.engine === "natural"
    return ready && env.getAudio() !== null
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

  /** System-voice utterances for prepared speech text, voices picked. */
  private buildQueue(
    speechText: string,
    prefs: ReadAloudPrefs
  ): { queue: QueuedSegment[]; missing: Set<string> } {
    // Voices may have arrived without an event (WebKit).
    if (this.voices.length === 0) this.refreshVoices()
    const missing = new Set<string>()
    const queue = buildSpeechSegments(speechText).map((segment) => {
      const lang = langForText(segment.script, segment.text)
      const voice = this.voiceFor(lang, prefs)
      // Only claim a voice is missing when the list has loaded at all.
      if (!voice && lang && this.voices.length > 0) {
        missing.add(normalizeLang(lang).base)
      }
      return { ...segment, lang, voice }
    })
    return { queue, missing }
  }

  /** Read `markdown` as `id`, replacing whatever is being read. */
  speak(id: string, markdown: string): SpeakResult {
    const speechText = speechTextFromMarkdown(markdown)
    const prefs = this.getPrefs()

    if (this.usesNaturalVoice(prefs)) {
      const paragraphs = naturalParagraphs(speechText)
      if (paragraphs.length === 0) return { ok: false, reason: "empty" }
      this.halt()
      this.queue = []
      this.index = 0
      this.setState({ status: "playing", currentId: id })
      this.startNatural(paragraphs, prefs)
      return { ok: true, missingVoices: [] }
    }

    const { queue, missing } = this.buildQueue(speechText, prefs)
    if (queue.length === 0) return { ok: false, reason: "empty" }

    const engineBusy = this.state.status !== "idle" || this.engineActive()
    this.halt()
    this.releaseNaturalAudio()
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
    if (this.natural) {
      // The audio clock stops; nothing is lost or repeated.
      this.natural.pause()
      this.setState({ status: "paused", currentId: this.state.currentId })
      return
    }
    // The sentence being spoken is cancelled and starts over on resume.
    this.halt()
    this.setState({ status: "paused", currentId: this.state.currentId })
  }

  resume(): void {
    if (this.state.status !== "paused") return
    this.setState({ status: "playing", currentId: this.state.currentId })
    if (this.natural) {
      this.natural.resume()
      return
    }
    this.speakNext(this.generation)
  }

  stop(): void {
    this.halt()
    this.queue = []
    this.index = 0
    this.releaseNaturalAudio()
    this.setState(IDLE_STATE)
  }

  /** Let go of the audio device while the natural voice isn't playing. */
  private releaseNaturalAudio(): void {
    if (!this.naturalAudio) return
    void this.naturalAudio.suspend().catch(() => {})
    this.naturalAudio = null
  }

  private engineActive(): boolean {
    return this.synth.speaking || this.synth.pending || this.synth.paused
  }

  /** Read `paragraphs` with the natural voice; the system voices take over
   *  from the paragraph it fails on. */
  private startNatural(paragraphs: string[], prefs: ReadAloudPrefs): void {
    const env = this.naturalEnv
    const audio = env?.getAudio()
    if (!env || !audio) return
    // Inside the click that asked for it, so a context that needs a user
    // gesture to start gets one.
    void audio.resume().catch(() => {})
    this.naturalAudio = audio
    const generation = this.generation
    this.natural = new NaturalSession({
      paragraphs,
      voice: prefs.naturalVoice,
      speed: prefs.rate,
      api: env.api,
      audio,
      onEnded: () => {
        if (generation !== this.generation) return
        this.natural = null
        this.stop()
      },
      onFailed: (rest, error) => {
        if (generation !== this.generation) return
        this.natural = null
        this.notify({
          kind: "natural-fallback",
          message: error instanceof Error ? error.message : String(error),
        })
        const { queue } = this.buildQueue(rest.join("\n"), this.getPrefs())
        if (queue.length === 0) {
          this.stop()
          return
        }
        this.queue = queue
        this.index = 0
        // Paused meanwhile: Resume starts the system voices.
        if (this.state.status === "playing") this.speakNext(this.generation)
      },
    })
  }

  /** Cancel whatever the engine is doing and forget the utterance in flight. */
  private halt(): void {
    this.generation += 1
    if (this.natural) {
      this.natural.stop()
      this.natural = null
    }
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
/** Test seam: the natural voice a new window player gets (null: none). */
let naturalEnvOverride: NaturalEnv | null | undefined

/**
 * This window's audio output for the natural voice, created on first use.
 * WebKit and Chrome only let an AudioContext start inside a user gesture, so
 * the first click or key press anywhere starts it (and parks it again when
 * nothing plays); after that, replies read automatically can be heard too.
 */
let audioOut: AudioOut | null | undefined
let audioUnlockBound = false

function getAudioOut(): AudioOut | null {
  if (audioOut === undefined) audioOut = createWebAudioOut()
  return audioOut
}

function bindAudioUnlock(player: ReadAloudPlayer): void {
  if (audioUnlockBound || typeof document === "undefined") return
  audioUnlockBound = true
  const unlock = () => {
    if (!player.usesNaturalVoice()) return
    document.removeEventListener("pointerdown", unlock, true)
    document.removeEventListener("keydown", unlock, true)
    const audio = getAudioOut()
    if (!audio || audio.state === "running") return
    void audio
      .resume()
      .then(() => {
        if (player.getState().status === "idle") return audio.suspend()
      })
      .catch(() => {})
  }
  document.addEventListener("pointerdown", unlock, true)
  document.addEventListener("keydown", unlock, true)
}

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
    natural:
      naturalEnvOverride === undefined
        ? {
            api: naturalApi,
            getAudio: getAudioOut,
            getStatus: getNaturalStatus,
          }
        : (naturalEnvOverride ?? undefined),
  })
  const player = instance
  window.addEventListener("pagehide", () => player.stop())
  if (naturalEnvOverride === undefined) {
    // The status decides the engine inside the click, so have it ready.
    void refreshNaturalStatus()
    bindAudioUnlock(player)
  }
  return instance
}

/** Test seam: the natural voice the next window player gets; `undefined`
 *  restores the real one. */
export function setNaturalEnvForTests(env: NaturalEnv | null | undefined) {
  naturalEnvOverride = env
}

/** Test seam: drop the window's player so the next call builds a fresh one. */
export function resetReadAloudPlayerForTests(): void {
  instance?.stop()
  instance = null
}
