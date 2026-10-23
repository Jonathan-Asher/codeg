"use client"

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { Check, Loader2, RefreshCw, WifiOff } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  ConnectionDisplayTracker,
  type ConnectionDisplay,
} from "@/lib/connection-display"
import { isResyncing, subscribeResync } from "@/lib/resync-coordinator"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  reconnectWebNow,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"

// One tracker per window, so the status-bar pill, the floating pill and the
// banner always agree.
let tracker: ConnectionDisplayTracker | null = null

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback)
  window.addEventListener("offline", callback)
  return () => {
    window.removeEventListener("online", callback)
    window.removeEventListener("offline", callback)
  }
}

const getOnline = () =>
  typeof navigator === "undefined" || navigator.onLine !== false

function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener("visibilitychange", callback)
  return () => document.removeEventListener("visibilitychange", callback)
}

const getVisible = () => document.visibilityState !== "hidden"
const alwaysTrue = () => true
const alwaysFalse = () => false

/** What the window says about its link right now (see `connection-display`). */
export function useConnectionDisplay(): ConnectionDisplay {
  const health = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  const syncing = useSyncExternalStore(
    subscribeResync,
    isResyncing,
    alwaysFalse
  )
  const online = useSyncExternalStore(subscribeOnline, getOnline, alwaysTrue)
  const visible = useSyncExternalStore(
    subscribeVisibility,
    getVisible,
    alwaysTrue
  )
  const [tick, setTick] = useState(0)
  tracker ??= new ConnectionDisplayTracker(performance.timeOrigin)
  const { display, nextAt } = tracker.update({
    health,
    syncing,
    online,
    visible,
  })
  useEffect(() => {
    if (nextAt === null) return
    const id = setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, nextAt - Date.now())
    )
    return () => clearTimeout(id)
  }, [nextAt, tick])
  return display
}

/** Test-only: forget the window's display state. */
export function __resetConnectionDisplayForTests(): void {
  tracker = null
}

// The workspace status bar hosts the pill; windows without one (settings,
// commit, the login screen) get it floating in a corner instead.
let statusSlots = 0
const slotListeners = new Set<() => void>()

function subscribeSlots(callback: () => void): () => void {
  slotListeners.add(callback)
  return () => {
    slotListeners.delete(callback)
  }
}

function setSlots(delta: number) {
  statusSlots += delta
  for (const listener of slotListeners) listener()
}

const getSlots = () => statusSlots
const noSlots = () => 0

function PillView({ display }: { display: ConnectionDisplay }) {
  const t = useTranslations("WebConnection")
  let icon: ReactNode
  let label: string
  switch (display.kind) {
    case "reconnecting":
      icon = <Loader2 aria-hidden className="size-3 animate-spin" />
      label = display.connecting ? t("connectingPill") : t("reconnectingPill")
      break
    case "updating":
      icon = <RefreshCw aria-hidden className="size-3 animate-spin" />
      label = t("updatingPill")
      break
    case "back-online":
      icon = <Check aria-hidden className="size-3" />
      label = t("backOnlinePill")
      break
    default:
      return null
  }
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="connection-pill"
      data-kind={display.kind}
      className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-2 py-0.5 text-xs text-muted-foreground shadow-sm"
    >
      {icon}
      {label}
    </span>
  )
}

/** The link's pill, for the status bar. */
export function ConnectionStatusPill() {
  const display = useConnectionDisplay()
  useEffect(() => {
    setSlots(1)
    return () => setSlots(-1)
  }, [])
  return <PillView display={display} />
}

/** The pill in a corner, for windows with no status bar to host it. */
export function FloatingConnectionPill() {
  const slots = useSyncExternalStore(subscribeSlots, getSlots, noSlots)
  const display = useConnectionDisplay()
  if (slots > 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50">
      <PillView display={display} />
    </div>
  )
}

function formatAge(ms: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return format.format(-seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return format.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return format.format(-hours, "hour")
  return format.format(-Math.round(hours / 24), "day")
}

/**
 * The link has stayed down in front of the user: say so over the content,
 * with how old what is shown is, and a way to retry now. Never a modal —
 * everything under it can still be read, scrolled, selected and copied.
 */
export function OfflineBanner() {
  const t = useTranslations("WebConnection")
  const locale = useLocale()
  const display = useConnectionDisplay()
  const offline = display.kind === "offline"
  // The age keeps counting while the banner is up.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!offline) return
    const id = setInterval(() => setTick((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [offline])
  if (display.kind !== "offline") return null
  const description = display.connecting
    ? t("offlineWaiting")
    : t("offlineDescription", {
        age: formatAge(display.ageMs, locale),
      })
  return (
    <div className="pointer-events-none fixed inset-x-0 top-10 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        data-testid="connection-offline-banner"
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-md border border-border bg-background/95 px-3 py-2 text-sm shadow-md"
      >
        <WifiOff
          aria-hidden
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="font-medium">{t("offlineTitle")}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {description}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => reconnectWebNow()}
        >
          {t("retry")}
        </Button>
      </div>
    </div>
  )
}
