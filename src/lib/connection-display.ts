import type { ConnectionHealth } from "./transport/types"

/**
 * What the window says about its link — never as a modal (a rejected token
 * excepted, which keeps its dialog), and never by taking content away:
 *
 * - `reconnecting`: the link has been down for a second or more, under ten
 *   seconds of the page being visible — a pill in the status bar;
 * - `offline`: down ten seconds or more while visible, or the OS reports no
 *   network — a banner over the content saying what is shown and how old it
 *   is, with Retry;
 * - `updating`: back, and the reconnect's refetch pass has been running for
 *   half a second or more — the pill again;
 * - `back-online`: the pill for two seconds after any of the above.
 *
 * Down time is counted only while the page is visible, so a window that comes
 * back after a sleep or a long absence first shows the pill alone and
 * resyncs quietly; the banner is for a link that stays down in front of the
 * user. Pure: the hook feeds it inputs and the clock, and re-renders at
 * `nextAt`.
 */
export type ConnectionDisplay =
  | { kind: "none" }
  | { kind: "reconnecting"; connecting: boolean }
  | {
      kind: "offline"
      connecting: boolean
      /** When the link went down, and how long ago that is. */
      since: number
      ageMs: number
    }
  | { kind: "updating" }
  | { kind: "back-online" }

export interface ConnectionDisplayInputs {
  health: ConnectionHealth
  /** A reconnect's refetch pass is running (see `resync-coordinator`). */
  syncing: boolean
  /** `navigator.onLine`: false only when the OS knows there is no network. */
  online: boolean
  visible: boolean
}

export const PILL_DELAY_MS = 1_000
export const OFFLINE_AFTER_MS = 10_000
export const UPDATING_AFTER_MS = 500
export const BACK_ONLINE_MS = 2_000

export class ConnectionDisplayTracker {
  /** When the link went down (what is on screen is as old as this). */
  private downAt: number
  private wasDown = false
  /** When the current visible stretch of down time began. */
  private visibleDownSince: number | null = null
  private syncingSince: number | null = null
  /** This outage showed something, so its end says "Back online". */
  private shown = false
  private backOnlineUntil = 0

  constructor(now: number) {
    this.downAt = now
  }

  update(
    input: ConnectionDisplayInputs,
    now: number = Date.now()
  ): { display: ConnectionDisplay; nextAt: number | null } {
    const down =
      input.health === "reconnecting" || input.health === "connecting"
    const connecting = input.health === "connecting"

    if (!down) {
      this.visibleDownSince = null
    } else if (!input.visible) {
      this.visibleDownSince = null
    } else if (this.visibleDownSince === null) {
      this.visibleDownSince = now
    }
    if (down && !this.wasDown) this.downAt = now
    this.wasDown = down

    if (input.health === "unauthorized") {
      this.shown = false
      return { display: { kind: "none" }, nextAt: null }
    }

    if (down) {
      const visibleFor =
        this.visibleDownSince === null ? 0 : now - this.visibleDownSince
      if (!input.online || visibleFor >= OFFLINE_AFTER_MS) {
        this.shown = true
        return {
          display: {
            kind: "offline",
            connecting,
            since: this.downAt,
            ageMs: now - this.downAt,
          },
          nextAt: null,
        }
      }
      if (this.visibleDownSince !== null && visibleFor >= PILL_DELAY_MS) {
        this.shown = true
        return {
          display: { kind: "reconnecting", connecting },
          nextAt: this.visibleDownSince + OFFLINE_AFTER_MS,
        }
      }
      return {
        display: { kind: "none" },
        nextAt:
          this.visibleDownSince === null
            ? null
            : this.visibleDownSince + PILL_DELAY_MS,
      }
    }

    if (input.syncing) {
      if (this.syncingSince === null) this.syncingSince = now
      // Straight on from the reconnecting pill; otherwise only once slow.
      if (this.shown || now - this.syncingSince >= UPDATING_AFTER_MS) {
        this.shown = true
        return { display: { kind: "updating" }, nextAt: null }
      }
      return {
        display: { kind: "none" },
        nextAt: this.syncingSince + UPDATING_AFTER_MS,
      }
    }
    this.syncingSince = null

    if (this.shown) {
      this.shown = false
      this.backOnlineUntil = now + BACK_ONLINE_MS
    }
    if (now < this.backOnlineUntil) {
      return { display: { kind: "back-online" }, nextAt: this.backOnlineUntil }
    }
    return { display: { kind: "none" }, nextAt: null }
  }
}
