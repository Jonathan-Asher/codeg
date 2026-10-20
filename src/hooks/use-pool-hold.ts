"use client"

import { useCallback, useEffect, useState } from "react"

import { subscribePlanUsagePoolChanged } from "@/lib/api"
import {
  poolReadingReleases,
  poolRetryDelayMs,
  type PoolHold,
} from "@/lib/pool-hold"

export interface UsePoolHoldReturn {
  /** Set while queued messages wait for the account pool (see `pool-hold`). */
  hold: PoolHold | null
  /** The backend held a message back: wait for the pool before the next. */
  holdFor: (hold: PoolHold) => void
}

/**
 * A composer surface's wait for the account pool. Set when the backend holds
 * a message back (`PoolExhaustedError`); while set, the surface's queue does
 * not flush. It lets go — and the queue tries again — when a pushed pool
 * reading shows room, when the first account's reset has passed, or after a
 * minute without news. A retry the pool still refuses is simply held again.
 */
export function usePoolHold(): UsePoolHoldReturn {
  const [hold, setHold] = useState<PoolHold | null>(null)
  const holdFor = useCallback((next: PoolHold) => setHold(next), [])

  useEffect(() => {
    if (!hold) return
    const timer = setTimeout(() => setHold(null), poolRetryDelayMs(hold))
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribePlanUsagePoolChanged((pool) => {
      if (poolReadingReleases(pool)) setHold(null)
    })
      .then((u) => {
        if (cancelled) u()
        else unsub = u
      })
      .catch(() => {
        // No pushed readings: the timer alone lets the message go.
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsub?.()
    }
  }, [hold])

  return { hold, holdFor }
}
