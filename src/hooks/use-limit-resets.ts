"use client"

import { useCallback, useEffect, useState } from "react"
import { getLimitResets } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { LimitResetsReport, ProviderLimitResets } from "@/lib/types"

/** How long a listing is reused by every screen that shows one. The backend
 *  keeps its own for a minute; this only folds the page and a paused
 *  session's banner into one request. */
const SHARED_TTL_MS = 30_000

let shared: { report: LimitResetsReport; at: number } | null = null
let inflight: Promise<LimitResetsReport> | null = null
const listeners = new Set<(report: LimitResetsReport) => void>()

function publish(report: LimitResetsReport) {
  shared = { report, at: Date.now() }
  for (const listener of listeners) listener(report)
}

function fetchShared(force: boolean): Promise<LimitResetsReport> {
  if (!force && shared && Date.now() - shared.at < SHARED_TTL_MS) {
    return Promise.resolve(shared.report)
  }
  if (!force && inflight) return inflight
  const request = getLimitResets(force)
    .then((report) => {
      publish(report)
      return report
    })
    .finally(() => {
      if (inflight === request) inflight = null
    })
  inflight = request
  return request
}

/** Fold a provider's listing read after a reset was used into what every
 *  screen shows. */
export function publishProviderResets(resets: ProviderLimitResets) {
  const providers = shared?.report.providers ?? []
  publish({
    providers: [
      ...providers.filter((p) => p.provider !== resets.provider),
      resets,
    ],
  })
}

/** Tests only: forget the shared listing. */
export function resetLimitResetsCacheForTests() {
  shared = null
  inflight = null
}

export interface LimitResetsState {
  report: LimitResetsReport | null
  /** True until the first fetch settles. */
  loading: boolean
  /** A forced reload is in flight. */
  refreshing: boolean
  error: string | null
  /** Fetch again; `force` asks the providers past both caches. */
  load: (force: boolean) => Promise<void>
}

/**
 * Every provider's usage-limit resets, shared by the screens that show them
 * (Subscription usage, a paused session's banner): fetched once, reused for
 * half a minute, and updated everywhere when a reset is used.
 */
export function useLimitResets({
  enabled = true,
}: { enabled?: boolean } = {}): LimitResetsState {
  const [report, setReport] = useState<LimitResetsReport | null>(
    () => shared?.report ?? null
  )
  const [loading, setLoading] = useState(() => enabled && shared == null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listeners.add(setReport)
    return () => {
      listeners.delete(setReport)
    }
  }, [])

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true)
    try {
      setReport(await fetchShared(force))
      setError(null)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setLoading(false)
      if (force) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) void load(false)
  }, [enabled, load])

  return { report, loading, refreshing, error, load }
}
