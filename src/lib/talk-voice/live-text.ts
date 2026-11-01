/**
 * What Talk hears of the turn in progress: the iPhone's `mainThreadText`
 * (codeg-ios `LiveTurn.swift`) over the tab's `liveMessage`, and the turn ids
 * and ends the helper's controller expects (`live`, `turnEnded`).
 *
 * - Text the agent wrote itself (no `parentToolUseId`) is joined in order;
 *   where a tool ran or a message of the person's came in (a steering block),
 *   a paragraph break ("\n\n") goes in. Reasoning, the plan and sub-agent
 *   text are left out. While a turn streams the text only grows at the end,
 *   so the helper keeps a cursor into it.
 * - A turn's id is `<conversationId>:<serial>`; the serial rises when the
 *   connection's status enters `prompting`. A turn whose status leaves
 *   `prompting` without a `turn_complete` (a dropped socket, a reconnect)
 *   gets {@link GRACE_MS} to come back as the same turn before it is told as
 *   ended (`stopReason` null, or `error`).
 */

import type {
  ConnectionState,
  LiveContentBlock,
} from "@/contexts/acp-connections-context"
import type { TalkLive, WindowMessage } from "./protocol"

/** How long a turn that left `prompting` without `turn_complete` may take
 *  to come back as the same turn. */
export const GRACE_MS = 1500

/** The agent's own words so far, paragraph breaks where it paused. */
export function mainThreadText(content: readonly LiveContentBlock[]): string {
  let out = ""
  let pendingBreak = false
  for (const block of content) {
    switch (block.type) {
      case "text": {
        if (block.parentToolUseId) continue
        if (!block.text) continue
        if (pendingBreak && out) out += "\n\n"
        pendingBreak = false
        out += block.text
        break
      }
      case "tool_call":
      case "steering":
        pendingBreak = true
        break
      case "thinking":
      case "plan":
        break
    }
  }
  if (pendingBreak && out) out += "\n\n"
  return out
}

export interface TalkTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: TalkTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Follows one conversation's turns and tells the helper about them: the live
 * text when it changed, and each turn's end once, after its final text.
 */
export class LiveTurnTracker {
  private serial = 0
  private prompting = false
  private turnId: string | null = null
  private endedTurnId: string | null = null
  private lastLive: TalkLive | null = null
  private grace: unknown = null
  private conn: ConnectionState | undefined

  constructor(
    private readonly conversationId: number,
    private readonly emit: (message: WindowMessage) => void,
    private readonly timers: TalkTimers = realTimers,
    private readonly graceMs: number = GRACE_MS
  ) {}

  /** The turn in progress as `start` carries it (null when idle); the
   *  tracker follows from here. */
  prime(conn: ConnectionState | undefined): TalkLive | null {
    this.conn = conn
    if (conn?.status !== "prompting") return null
    this.beginTurn()
    this.prompting = true
    const live: TalkLive = {
      turnId: this.turnId as string,
      text: mainThreadText(conn.liveMessage?.content ?? []),
      streaming: true,
    }
    this.lastLive = live
    return live
  }

  /** The id of the turn in progress or last seen. */
  get currentTurnId(): string | null {
    return this.turnId
  }

  /** The connection changed. */
  update(conn: ConnectionState | undefined): void {
    this.conn = conn
    const prompting = conn?.status === "prompting"
    if (prompting && !this.prompting) {
      const comingBack =
        this.grace !== null &&
        this.turnId !== null &&
        this.endedTurnId !== this.turnId
      this.cancelGrace()
      if (!comingBack) this.beginTurn()
      this.prompting = true
    } else if (!prompting && this.prompting) {
      this.prompting = false
      // `turn_complete` (with the stop reason) normally follows at once.
      if (this.turnId !== null && this.endedTurnId !== this.turnId) {
        this.startGrace()
      }
    }
    if (this.turnId !== null && this.endedTurnId !== this.turnId) {
      // Still streaming while it may come back.
      this.sendLive(true)
    }
  }

  /** The agent's `turn_complete`, with its stop reason. */
  turnComplete(stopReason: string | null): void {
    this.prompting = false
    this.finish(stopReason)
  }

  dispose(): void {
    this.cancelGrace()
  }

  private beginTurn(): void {
    this.serial += 1
    this.turnId = `${this.conversationId}:${this.serial}`
    this.lastLive = null
  }

  private finish(stopReason: string | null): void {
    if (this.turnId === null || this.endedTurnId === this.turnId) return
    this.cancelGrace()
    this.sendLive(false)
    this.endedTurnId = this.turnId
    this.emit({ type: "turnEnded", turnId: this.turnId, stopReason })
  }

  private startGrace(): void {
    this.cancelGrace()
    this.grace = this.timers.setTimeout(() => {
      this.grace = null
      if (this.prompting) return
      this.finish(this.conn?.error ? "error" : null)
    }, this.graceMs)
  }

  private cancelGrace(): void {
    if (this.grace === null) return
    this.timers.clearTimeout(this.grace)
    this.grace = null
  }

  private sendLive(streaming: boolean): void {
    if (this.turnId === null) return
    const text = mainThreadText(this.conn?.liveMessage?.content ?? [])
    const live: TalkLive = { turnId: this.turnId, text, streaming }
    const last = this.lastLive
    if (
      last &&
      last.turnId === live.turnId &&
      last.text === live.text &&
      last.streaming === live.streaming
    ) {
      return
    }
    // Nothing said yet: wait for the first words (the end still says so).
    if (!last && streaming && text === "") return
    this.lastLive = live
    this.emit({ type: "live", ...live })
  }
}
