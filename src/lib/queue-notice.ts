import type { PoolHold } from "@/lib/pool-hold"
import type { ConnectionStatus, LimitPause } from "@/lib/types"

/**
 * Why a composer's queued messages are not going out, if anything says so.
 *
 * - `limit`: the session is paused on a usage limit and continues by itself
 *   at `resetsAt`; the queue waits for that, and goes out after it.
 * - `pool`: every Claude subscription behind the account pool is at its limit
 *   — a send was held back (`held`), or the session itself waits for the pool
 *   (`pool_wait`, or a connect that failed on it and retries by itself). The
 *   queue goes out on its own once an account frees up.
 * - `not_sent`: the connection failed or is gone, so nothing would ever go
 *   out without a new connection. The surface offers Retry, and the queue
 *   flushes by itself as soon as a connection is back.
 *
 * `null` when the queue is empty or simply waiting its turn (a reply in
 * progress, a session still opening).
 */
export type QueueNoticeKind =
  | { kind: "limit"; resetsAt: string }
  | { kind: "pool"; resumesAt: number | null }
  | { kind: "not_sent" }
  | null

export interface QueueNoticeInput {
  queueLength: number
  /** A send this surface made was held back for the pool. */
  held: PoolHold | null
  /** The connection's own wait for the pool (`UseConnectionReturn.poolWait`). */
  connPoolWait: PoolHold | null
  /** The connection's status as the composer sees it (`null`: no connection
   *  and none on its way). */
  status: ConnectionStatus | null
  /** The session's usage-limit pause while it waits (`waitingLimitPause`):
   *  the queue holds until the continuation. */
  limitPause?: Pick<LimitPause, "resets_at"> | null
}

export function queueNoticeFor(input: QueueNoticeInput): QueueNoticeKind {
  if (input.queueLength === 0) return null
  if (input.limitPause) {
    return { kind: "limit", resetsAt: input.limitPause.resets_at }
  }
  const pool = input.held ?? input.connPoolWait
  if (pool) return { kind: "pool", resumesAt: pool.resumesAt }
  if (
    input.status === null ||
    input.status === "error" ||
    input.status === "disconnected"
  ) {
    return { kind: "not_sent" }
  }
  return null
}
