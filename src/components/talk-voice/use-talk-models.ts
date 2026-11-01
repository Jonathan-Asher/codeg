"use client"

/**
 * Talk's speech models on this Mac, as the settings and the setup dialog show
 * them: the status (refreshed every second while a pack downloads, and on
 * the backend's change event), and download / cancel / delete per pack.
 */

import { useCallback, useEffect, useState } from "react"

import {
  settled,
  talkModelsApi,
  type TalkModelsStatus,
} from "@/lib/talk-voice/api"

const POLL_MS = 1000

export interface TalkModels {
  status: TalkModelsStatus | null
  busy: boolean
  error: string | null
  download(packs?: string[]): Promise<void>
  cancel(packs?: string[]): Promise<void>
  remove(packs?: string[]): Promise<void>
}

export function useTalkModels(enabled = true): TalkModels {
  const [status, setStatus] = useState<TalkModelsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let off: (() => void) | null = null
    void settled(() => talkModelsApi.status())
      .then((next) => {
        if (!cancelled && next) setStatus(next)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    void settled(() =>
      talkModelsApi.onChange((payload) => {
        if (!cancelled) setStatus(payload as TalkModelsStatus)
      })
    ).then((unsubscribe) => {
      if (typeof unsubscribe !== "function") return
      if (cancelled) unsubscribe()
      else off = unsubscribe
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [enabled])

  const downloading =
    status?.packs.some((pack) => pack.download.state === "downloading") ?? false
  useEffect(() => {
    if (!enabled || !downloading) return
    const timer = window.setInterval(() => {
      void settled(() => talkModelsApi.status())
        .then((next) => {
          if (next) setStatus(next)
        })
        .catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, downloading])

  const run = useCallback(async (action: () => Promise<TalkModelsStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    status,
    busy,
    error,
    download: (packs) => run(() => talkModelsApi.download(packs)),
    cancel: (packs) => run(() => talkModelsApi.cancel(packs)),
    remove: (packs) => run(() => talkModelsApi.delete(packs)),
  }
}
