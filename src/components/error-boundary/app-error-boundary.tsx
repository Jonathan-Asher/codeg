"use client"

// Error boundaries that keep the app shell alive.
//
// With no boundary anywhere, one throw during render — or in an effect —
// anywhere in the tree unmounted the whole window into Next's "Application
// error: a client-side exception has occurred". Seen in a remote-workspace
// window right after its server restarted. Boundaries now sit at the page
// root and around the workspace's regions, so a failing region is replaced
// by a small panel (or, for a widget, by nothing) while the rest of the
// window — the connection dialog, the sidebar, the other tabs — keeps
// working.
//
// While the window's link to its server is down, the panel says so instead
// of offering a reload that could not load anything, and it retries the
// region by itself once the link is back: what failed was most likely the
// outage. Every catch is reported to the backend's log
// (`lib/client-error-report.ts`).

import {
  Component,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react"
import { usePathname } from "next/navigation"
import { AlertTriangle, Loader2, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { reportBoundaryError } from "@/lib/client-error-report"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import { cn } from "@/lib/utils"

/**
 * - `page`: fills the window (the root of a route).
 * - `region`: fills its region (the workspace's main area, a settings page).
 * - `silent`: renders nothing (a status widget, a toast host, a bridge) and
 *   tries again by itself a few times.
 */
export type ErrorBoundaryVariant = "page" | "region" | "silent"

interface AppErrorBoundaryProps {
  /** Names the boundary in the log. */
  scope: string
  variant?: ErrorBoundaryVariant
  /** A change of this value clears a caught error (the route, typically). */
  resetKey?: unknown
  children?: ReactNode
}

interface AppErrorBoundaryState {
  error: unknown
  hasError: boolean
}

/** Retries of a `silent` boundary, and the waits before them. */
export const SILENT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000] as const

/** Next's own control flow (`redirect()`, `notFound()`) must pass through. */
function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") ||
      digest.startsWith("NEXT_NOT_FOUND") ||
      digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"))
  )
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null, hasError: false }
  /**
   * Timed retries used so far (`silent` only). Never reset: a widget that
   * keeps failing gets `SILENT_RETRY_DELAYS_MS.length` more chances, not a
   * retry loop. A reconnect or a `resetKey` change still retries it.
   */
  private silentRetries = 0

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error, hasError: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isNextControlFlow(error)) return
    reportBoundaryError(this.props.scope, error, info.componentStack)
  }

  componentDidUpdate(prev: AppErrorBoundaryProps) {
    if (this.state.hasError && !Object.is(prev.resetKey, this.props.resetKey)) {
      this.reset()
    }
  }

  reset = () => {
    this.setState({ error: null, hasError: false })
  }

  private retrySilently = () => {
    this.silentRetries++
    this.reset()
  }

  render() {
    if (!this.state.hasError) return this.props.children
    if (isNextControlFlow(this.state.error)) throw this.state.error
    const variant = this.props.variant ?? "region"
    return (
      <FallbackSafety>
        <BoundaryFallback
          variant={variant}
          onRetry={this.reset}
          onSilentRetry={this.retrySilently}
          silentRetries={this.silentRetries}
        />
      </FallbackSafety>
    )
  }
}

/** An `AppErrorBoundary` cleared on every route change. */
export function RouteErrorBoundary({
  scope,
  variant = "page",
  children,
}: {
  scope: string
  variant?: ErrorBoundaryVariant
  children?: ReactNode
}) {
  const pathname = usePathname()
  return (
    <AppErrorBoundary scope={scope} variant={variant} resetKey={pathname}>
      {children}
    </AppErrorBoundary>
  )
}

function useLinkDown(): boolean {
  const health = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  return health === "reconnecting" || health === "connecting"
}

function BoundaryFallback({
  variant,
  onRetry,
  onSilentRetry,
  silentRetries,
}: {
  variant: ErrorBoundaryVariant
  onRetry: () => void
  onSilentRetry: () => void
  silentRetries: number
}) {
  const linkDown = useLinkDown()

  // The link came back after being down: render the children again.
  const sawLinkDown = useRef(linkDown)
  useEffect(() => {
    if (linkDown) {
      sawLinkDown.current = true
      return
    }
    if (sawLinkDown.current) {
      sawLinkDown.current = false
      onRetry()
    }
  }, [linkDown, onRetry])

  // A widget has no panel to retry from: it tries again on its own, a few
  // times, further apart each time.
  useEffect(() => {
    if (variant !== "silent") return
    const delay = SILENT_RETRY_DELAYS_MS[silentRetries]
    if (delay === undefined) return
    const id = setTimeout(onSilentRetry, delay)
    return () => clearTimeout(id)
  }, [variant, silentRetries, onSilentRetry])

  if (variant === "silent") return null
  return (
    <FallbackPanel variant={variant} linkDown={linkDown} onRetry={onRetry} />
  )
}

function FallbackPanel({
  variant,
  linkDown,
  onRetry,
}: {
  variant: Exclude<ErrorBoundaryVariant, "silent">
  linkDown: boolean
  onRetry: () => void
}) {
  const t = useTranslations("AppErrorBoundary")
  return (
    <div
      role="alert"
      data-error-boundary={variant}
      className={cn(
        "flex w-full items-center justify-center bg-background p-6 text-foreground",
        variant === "page" ? "min-h-screen" : "h-full min-h-40"
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {linkDown ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
        )}
        <div className="text-sm font-medium">
          {linkDown ? t("reconnectingTitle") : t("title")}
        </div>
        <p className="text-xs text-muted-foreground">
          {linkDown ? t("reconnectingBody") : t("body")}
        </p>
        {!linkDown && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("retry")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.location.reload()}
            >
              {t("reload")}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Last line under a fallback that cannot render itself (no intl provider
 * above it, say): plain English, no hooks, never throws.
 */
class FallbackSafety extends Component<
  { children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportBoundaryError("fallback", error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" style={{ padding: 24, fontSize: 13 }}>
        Something went wrong in this part of codeg.{" "}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
