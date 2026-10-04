"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  getPlanUsage,
  subscribePlanUsageChanged,
  subscribePlanUsagePoolChanged,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect } from "@/lib/platform"
import {
  mergeFetchedReport,
  replacePool,
  replaceSnapshot,
} from "@/lib/plan-usage"
import type { PlanUsageReport } from "@/lib/types"

export interface PlanUsageReportState {
  report: PlanUsageReport | null
  /** True until the first fetch settles. */
  loading: boolean
  /** A forced reload is in flight. */
  refreshing: boolean
  error: string | null
  /** Fetch again; `force` re-reads the Codex logs past the backend cache. */
  load: (force: boolean) => Promise<void>
}

/**
 * Every agent's latest subscription-limit reading, kept current: fetched on
 * mount through the active transport (so a remote-workspace window reads its
 * server's limits), with Claude Code readings folded in as turns push them,
 * account-pool readings as the backend polls the pool, and a refetch after
 * the transport reconnects.
 *
 * `pollMs` also refetches on that interval while the document is visible —
 * Codex readings are only picked up by a fetch, and the backend caches its log
 * scan for a minute, so polling faster than that buys nothing. Polling pauses
 * while the document is hidden and catches up as soon as it is shown again.
 */
export function usePlanUsageReport({
  pollMs,
}: { pollMs?: number } = {}): PlanUsageReportState {
  const [report, setReport] = useState<PlanUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the newest request may land: a slow mount fetch must not overwrite
  // the answer to a Refresh clicked after it.
  const requestRef = useRef(0)
  const lastLoadAtRef = useRef(0)
  const load = useCallback(async (force: boolean) => {
    const id = ++requestRef.current
    lastLoadAtRef.current = Date.now()
    if (force) setRefreshing(true)
    try {
      const next = await getPlanUsage(force)
      if (id !== requestRef.current) return
      setReport((prev) => mergeFetchedReport(prev, next))
      setError(null)
    } catch (e) {
      if (id !== requestRef.current) return
      setError(toErrorMessage(e))
    } finally {
      if (id === requestRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  // Live Claude readings, pushed as a turn reports them.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribePlanUsageChanged((snapshot) => {
      setReport((prev) => replaceSnapshot(prev, snapshot))
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  // The account pool's readings, pushed each time the backend polls it.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribePlanUsagePoolChanged((pool) => {
      setReport((prev) => replacePool(prev, pool))
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  // A push sent while the web socket was down is gone; refetch once it is
  // back rather than showing the older reading until the next turn.
  useEffect(() => {
    const off = onTransportReconnect(() => void load(false))
    return () => off?.()
  }, [load])

  useEffect(() => {
    if (!pollMs) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Counted from the last fetch of any kind, so a reconnect refetch or a
    // Refresh pushes the next poll back instead of doubling up with it.
    const schedule = () => {
      clearTimeout(timer)
      timer = undefined
      if (document.hidden) return
      const wait = Math.max(0, lastLoadAtRef.current + pollMs - Date.now())
      timer = setTimeout(() => {
        if (Date.now() - lastLoadAtRef.current >= pollMs) void load(false)
        schedule()
      }, wait)
    }
    schedule()
    document.addEventListener("visibilitychange", schedule)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [pollMs, load])

  return { report, loading, refreshing, error, load }
}
