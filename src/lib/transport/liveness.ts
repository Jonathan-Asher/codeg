/**
 * Dead-socket detection that tells a dead link from a slow server.
 *
 * A socket the browser still reports OPEN can be dead (the machine slept, the
 * network changed under it), and the only way to know is to ping it. But a
 * pong can also be late because the server is busy — a heavily loaded box, or
 * a pong queued behind a large frame — and tearing down a live socket then
 * costs a reconnect and a full resync on a server that is already struggling.
 * So:
 *
 * - **Adaptive deadline.** The pong deadline follows the measured round trip:
 *   `clamp(3 × p95 of recent samples, floor, 30 s)`. Samples are pong delays
 *   and health-probe durations, kept across sockets so a reconnect does not
 *   forget that the server has been slow.
 * - **Probe before giving up.** A pong past its deadline triggers a cheap
 *   authenticated HTTP request (`/api/health`). If it answers, the server is
 *   alive but slow: the socket is kept and the deadline extended (at most
 *   `MAX_EXTENSIONS` times). If it fails or times out, the link is down and
 *   the socket is replaced. A probe that timed out counts as a sample of its
 *   own length, so the next socket judges a slow server more patiently
 *   instead of looping through reconnects.
 * - **Streaming.** While a turn streams on screen, silence is suspicious
 *   sooner: ping after 5 s of quiet with a 5 s floor (§5.3 of the offline
 *   plan), behind the same probe guard.
 * - **Wake.** A wake check answers within a 4 s floor; a ping still
 *   outstanding from before the sleep is replaced by a fresh one, because a
 *   write is what makes a dead connection fail fast.
 *
 * Pure: the caller feeds it clock readings and frames, and acts on what it
 * returns. Shared rules with the desktop proxy's `Heartbeat`
 * (`src-tauri/src/commands/remote_proxy.rs`).
 */

export const LIVENESS = {
  /** Silence before a ping, idle. */
  idleQuietMs: 15_000,
  /** Silence before a ping while a turn streams on screen. */
  streamQuietMs: 5_000,
  /** Pong deadline floors. */
  idleFloorMs: 10_000,
  streamFloorMs: 5_000,
  wakeFloorMs: 4_000,
  /** Pong deadline ceiling. */
  ceilingMs: 30_000,
  /** Health-probe timeout floors and ceiling. */
  probeIdleFloorMs: 8_000,
  probeStreamFloorMs: 5_000,
  probeCeilingMs: 20_000,
  /** Deadline extensions granted by successful probes, per ping. */
  maxExtensions: 2,
  /** Round-trip samples kept. */
  rttSamples: 16,
} as const

/** Rolling window of round-trip samples (ms), newest last. */
export class RttWindow {
  private samples: number[] = []

  constructor(private readonly capacity: number = LIVENESS.rttSamples) {}

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.samples.push(ms)
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  /** 95th percentile by nearest rank, or null with no samples yet. */
  p95(): number | null {
    if (this.samples.length === 0) return null
    const sorted = [...this.samples].sort((a, b) => a - b)
    const rank = Math.ceil(0.95 * sorted.length) - 1
    return sorted[Math.max(0, rank)]
  }

  get size(): number {
    return this.samples.length
  }
}

/** `clamp(3 × p95, floor, ceiling)`; the floor alone with no samples. */
export function adaptiveDeadlineMs(
  p95: number | null,
  floorMs: number,
  ceilingMs: number = LIVENESS.ceilingMs
): number {
  if (p95 === null) return floorMs
  return Math.min(Math.max(3 * p95, floorMs), Math.max(floorMs, ceilingMs))
}

export type LivenessAction = "ping" | "probe" | "dead" | "wait"

/**
 * What the health probe found. `alive`: answered 2xx. `unauthorized`: 401.
 * `unreachable`: a network error or a non-2xx. `timeout`: no answer in time.
 */
export type ProbeOutcome = "alive" | "unauthorized" | "unreachable" | "timeout"

/**
 * `extend`: the server answered — keep the socket, re-ping it (a write is
 * what makes a dead connection fail fast) and wait out the new deadline.
 * `ignored`: the ping settled while the probe ran.
 */
export type ProbeVerdict = "extend" | "dead" | "unauthorized" | "ignored"

interface PendingPing {
  sentAt: number
  dueAt: number
  /** Set while a health probe for this ping is in flight. */
  probeStartedAt: number | null
  probeTimeoutMs: number
  extensions: number
}

/** Slack past a probe's own timeout before it is given up on regardless. */
const PROBE_SAFETY_MS = 1_000

export class LivenessMonitor {
  private lastInboundAt: number
  private ping: PendingPing | null = null
  private streaming = false
  readonly rtt = new RttWindow()

  constructor(now: number) {
    this.lastInboundAt = now
  }

  /** A fresh socket: restart the clock, keep the round-trip history. */
  reset(now: number): void {
    this.lastInboundAt = now
    this.ping = null
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming
  }

  isStreaming(): boolean {
    return this.streaming
  }

  /** Current pong deadline for a ping sent now. */
  deadlineMs(floorMs: number = this.floorMs()): number {
    return adaptiveDeadlineMs(this.rtt.p95(), floorMs)
  }

  probeTimeoutMs(): number {
    const floor = this.streaming
      ? LIVENESS.probeStreamFloorMs
      : LIVENESS.probeIdleFloorMs
    return adaptiveDeadlineMs(this.rtt.p95(), floor, LIVENESS.probeCeilingMs)
  }

  pingOutstanding(): boolean {
    return this.ping !== null
  }

  probeInFlight(): boolean {
    return this.ping?.probeStartedAt != null
  }

  /**
   * Any inbound frame proves the link alive and settles the ping. `isPong`:
   * the frame answers our ping, so its delay is a round-trip sample.
   */
  onInbound(now: number, isPong: boolean): void {
    if (this.ping && isPong) this.rtt.add(now - this.ping.sentAt)
    this.lastInboundAt = now
    this.ping = null
  }

  /** When `onCheck` should next be consulted. */
  nextCheckAt(): number {
    const ping = this.ping
    if (!ping) return this.lastInboundAt + this.quietMs()
    if (ping.probeStartedAt !== null) {
      return ping.probeStartedAt + ping.probeTimeoutMs + PROBE_SAFETY_MS
    }
    return ping.dueAt
  }

  onCheck(now: number): LivenessAction {
    const ping = this.ping
    if (ping) {
      if (ping.probeStartedAt !== null) {
        // The probe has its own timeout; this only catches one that never
        // settled at all.
        const giveUpAt =
          ping.probeStartedAt + ping.probeTimeoutMs + PROBE_SAFETY_MS
        return now >= giveUpAt ? "dead" : "wait"
      }
      if (now < ping.dueAt) return "wait"
      if (ping.extensions >= LIVENESS.maxExtensions) return "dead"
      ping.probeStartedAt = now
      ping.probeTimeoutMs = this.probeTimeoutMs()
      return "probe"
    }
    if (now - this.lastInboundAt >= this.quietMs()) {
      this.ping = this.newPing(now, this.floorMs())
      return "ping"
    }
    return "wait"
  }

  /**
   * The health probe for the outstanding ping settled after `elapsedMs`.
   * Alive: keep the socket and extend the deadline. Anything else: the link
   * is down.
   */
  onProbeResult(
    now: number,
    outcome: ProbeOutcome,
    elapsedMs: number
  ): ProbeVerdict {
    const ping = this.ping
    if (!ping || ping.probeStartedAt === null) return "ignored"
    ping.probeStartedAt = null
    if (outcome === "unauthorized") return "unauthorized"
    if (outcome === "alive" || outcome === "timeout") this.rtt.add(elapsedMs)
    if (outcome !== "alive") return "dead"
    ping.extensions += 1
    ping.dueAt = now + this.deadlineMs()
    return "extend"
  }

  /**
   * Wake check (page shown again, network back, lid opened): the link must
   * answer within the wake deadline. Returns whether a ping must go out — a
   * ping outstanding from before a sleep is replaced, since a write is what
   * makes a dead connection fail fast; a recent one just has its deadline
   * pulled in.
   */
  onWake(now: number): boolean {
    const deadline = this.deadlineMs(LIVENESS.wakeFloorMs)
    const ping = this.ping
    // A probe in flight is already deciding, within its own timeout.
    if (ping?.probeStartedAt != null) return false
    if (ping && now - ping.sentAt < deadline) {
      ping.dueAt = Math.min(ping.dueAt, now + deadline)
      return false
    }
    this.ping = this.newPing(now, LIVENESS.wakeFloorMs)
    return true
  }

  private newPing(now: number, floorMs: number): PendingPing {
    return {
      sentAt: now,
      dueAt: now + this.deadlineMs(floorMs),
      probeStartedAt: null,
      probeTimeoutMs: 0,
      extensions: 0,
    }
  }

  private quietMs(): number {
    return this.streaming ? LIVENESS.streamQuietMs : LIVENESS.idleQuietMs
  }

  private floorMs(): number {
    return this.streaming ? LIVENESS.streamFloorMs : LIVENESS.idleFloorMs
  }
}
