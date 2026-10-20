/**
 * Plays the natural voice: asks the backend for a paragraph at a time,
 * receives it sentence by sentence as 16-bit PCM, and queues every chunk on
 * one Web Audio clock, so speech starts with the first sentence and runs on
 * without gaps while the rest is synthesized ahead of it.
 *
 * A paragraph is the unit of fallback: if the engine fails, whatever audio is
 * already queued plays out and the system voices read on from the paragraph
 * that failed. Pause suspends the audio clock (no sentence restarts), Stop
 * drops the queue and cancels the synthesis in flight.
 */

import { POLL_WAIT_MS, type NaturalApi, type TtsChunk } from "./natural-api"

/** The part of Web Audio the player uses; tests pass a fake. */
export interface AudioOut {
  readonly currentTime: number
  /** "running" once audio can be heard; WebKit adds "interrupted". */
  readonly state: string
  resume(): Promise<void>
  suspend(): Promise<void>
  /** Play mono samples from `when` (on the `currentTime` clock). */
  schedule(
    samples: Float32Array,
    sampleRate: number,
    when: number,
    onEnded: () => void
  ): { stop(): void }
}

/** Headroom before the first chunk, so it never starts in the past. */
const START_LEAD_S = 0.05
/** The pause between paragraphs. */
const PARAGRAPH_GAP_S = 0.25
/** How long a context that won't start may keep the reply silent. */
const AUDIO_START_TIMEOUT_MS = 1_500

/** Base64 16-bit little-endian PCM → floats in [-1, 1). */
export function decodePcm16(base64: string): Float32Array {
  const bin = atob(base64)
  const out = new Float32Array(bin.length >> 1)
  for (let i = 0; i < out.length; i += 1) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
    if (v >= 0x8000) v -= 0x10000
    out[i] = v / 32768
  }
  return out
}

/** Paragraphs of prepared speech text (one per line). */
export function naturalParagraphs(speechText: string): string[] {
  return speechText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

type AudioContextCtor = new () => AudioContext

/** Web Audio where the runtime has it, else null. */
export function createWebAudioOut(): AudioOut | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  return {
    get currentTime() {
      return ctx.currentTime
    },
    get state() {
      return ctx.state as string
    },
    resume: () => ctx.resume(),
    suspend: () => ctx.suspend(),
    schedule(samples, sampleRate, when, onEnded) {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate)
      buffer.getChannelData(0).set(samples)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.onended = () => onEnded()
      source.start(when)
      return {
        stop() {
          source.onended = null
          try {
            source.stop()
          } catch {
            /* never started, or already ended */
          }
          source.disconnect()
        },
      }
    },
  }
}

export interface NaturalSessionOptions {
  paragraphs: string[]
  voice: string | null
  speed: number
  api: NaturalApi
  audio: AudioOut
  /** Every queued chunk has played. */
  onEnded: () => void
  /** The engine failed; `rest` are the paragraphs still to read. */
  onFailed: (rest: string[], error: unknown) => void
}

/** One reply read with the natural voice. */
export class NaturalSession {
  private stopped = false
  private paused = false
  private readonly sources = new Set<{ stop(): void }>()
  private nextAt = 0
  private streamId: string | null = null
  private synthesisDone = false
  private failure: { rest: string[]; error: unknown } | null = null
  private audioChecked = false

  constructor(private readonly options: NaturalSessionOptions) {
    void this.run()
  }

  /** Audio queued and not yet played, in seconds of the audio clock. */
  get queuedSeconds(): number {
    return Math.max(0, this.nextAt - this.options.audio.currentTime)
  }

  pause(): void {
    if (this.stopped) return
    this.paused = true
    void this.options.audio.suspend().catch(() => {})
  }

  resume(): void {
    if (this.stopped) return
    this.paused = false
    void this.options.audio.resume().catch(() => {})
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const source of this.sources) source.stop()
    this.sources.clear()
    const id = this.streamId
    this.streamId = null
    if (id) void this.options.api.cancel(id).catch(() => {})
  }

  private async run(): Promise<void> {
    const { paragraphs, api, voice, speed } = this.options
    for (let i = 0; i < paragraphs.length; i += 1) {
      if (this.stopped) return
      let played = 0
      try {
        const { streamId } = await api.speak(paragraphs[i], voice, speed)
        if (this.stopped) {
          void api.cancel(streamId).catch(() => {})
          return
        }
        this.streamId = streamId
        for (;;) {
          const result = await api.poll(streamId, POLL_WAIT_MS)
          if (this.stopped) return
          for (const chunk of result.chunks) {
            if (!this.audioChecked) await this.ensureAudioRuns()
            if (this.stopped) return
            if (this.enqueue(chunk, i > 0 && played === 0)) played += 1
          }
          if (result.done) {
            if (result.error) throw new Error(result.error)
            break
          }
        }
        this.streamId = null
      } catch (error) {
        if (this.stopped) return
        this.streamId = null
        this.failure = { rest: paragraphs.slice(i), error }
        break
      }
    }
    this.synthesisDone = true
    this.finishIfDrained()
  }

  /**
   * A context that is not running yet (the page has had no click) gets a
   * moment to start; if it won't, the reply goes to the system voices
   * rather than playing silently.
   */
  private async ensureAudioRuns(): Promise<void> {
    this.audioChecked = true
    const { audio } = this.options
    if (audio.state === "running" || this.paused) return
    await Promise.race([
      audio.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, AUDIO_START_TIMEOUT_MS)),
    ])
    if (audio.state !== "running" && !this.paused) {
      throw new Error("audio output is blocked until the page is clicked")
    }
  }

  private enqueue(chunk: TtsChunk, paragraphStart: boolean): boolean {
    const samples = decodePcm16(chunk.pcm)
    if (samples.length === 0 || chunk.sampleRate <= 0) return false
    const { audio } = this.options
    const at = Math.max(
      audio.currentTime + START_LEAD_S,
      this.nextAt + (paragraphStart ? PARAGRAPH_GAP_S : 0)
    )
    const handle = audio.schedule(samples, chunk.sampleRate, at, () => {
      this.sources.delete(handle)
      this.finishIfDrained()
    })
    this.sources.add(handle)
    this.nextAt = at + samples.length / chunk.sampleRate
    return true
  }

  private finishIfDrained(): void {
    if (this.stopped || !this.synthesisDone || this.sources.size > 0) return
    this.stopped = true
    if (this.failure) {
      this.options.onFailed(this.failure.rest, this.failure.error)
    } else {
      this.options.onEnded()
    }
  }
}
