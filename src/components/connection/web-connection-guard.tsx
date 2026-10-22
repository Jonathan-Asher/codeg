"use client"

import { useEffect, useSyncExternalStore } from "react"
import { ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  FloatingConnectionPill,
  OfflineBanner,
  useConnectionDisplay,
} from "@/components/connection/connection-banner"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import { redirectToCodegLogin } from "@/lib/transport/web-auth"
import { probeTransportLiveness } from "@/lib/platform"
import { perfMark } from "@/lib/perf-marks"

/**
 * Global, single-instance guard mounted once at the root layout. Watches the
 * connection health of the window's network transport — a browser client's
 * link, or a remote-workspace window's link through the Rust proxy — and
 * tells the user about it without ever taking the window away:
 *
 * - a lost link is a pill ("Reconnecting…", then "Updating…" while the
 *   reconnect's refetches run, then "Back online"), in the status bar or, in
 *   a window without one, in a corner;
 * - a link that stays down in front of the user becomes a banner over the
 *   content: offline, how old what is shown is, Retry;
 * - only a browser session whose token was rejected gets a blocking dialog,
 *   since nothing works until the user signs in again. A remote window's
 *   rejected token is shown by its own full-window screen instead.
 *
 * Inert in a local desktop window — the store returns "connected" there.
 * The wake-time liveness probe below goes through whichever transport is
 * active, so a remote-workspace window gets the same post-sleep recovery.
 */
export function WebConnectionGuard() {
  const t = useTranslations("WebConnection")
  const state = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  const display = useConnectionDisplay()

  // Fast recovery on network restore / tab wake. Two things can be wrong when
  // the machine wakes. Either the transport already knows the link is down —
  // backoff caps at 30s, so probe right away instead of waiting it out — or
  // it does NOT know: a socket that died during sleep sits in OPEN state
  // until the OS times it out, with no close event to trigger reconnection,
  // and the event stream stays dark for minutes. `probeTransportLiveness`
  // covers both — while reconnecting it skips the remaining backoff; on a
  // seemingly-healthy socket it pings and replaces the socket if no pong
  // comes back and the server does not answer either. A healthy link only
  // ever costs one ping.
  // `pageshow` is the bfcache restore on mobile Safari, which fires no
  // `visibilitychange`. Inert on the local desktop transport (IPC never
  // sleeps).
  useEffect(() => {
    const probe = () => probeTransportLiveness()
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    window.addEventListener("online", probe)
    window.addEventListener("pageshow", probe)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", probe)
      window.removeEventListener("pageshow", probe)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  const showUnauthorized = state === "unauthorized"

  useEffect(() => {
    perfMark("ui:connection", { kind: display.kind })
  }, [display.kind])
  useEffect(() => {
    perfMark("ui:dialog", { open: showUnauthorized, unauthorized: true })
  }, [showUnauthorized])

  return (
    <>
      <FloatingConnectionPill />
      <OfflineBanner />
      {showUnauthorized && (
        <AlertDialog open onOpenChange={() => {}}>
          <AlertDialogContent
            // Forced state: block Esc/outside dismissal. The dialog is driven
            // entirely by connection health, not by user whim.
            onEscapeKeyDown={(e) => e.preventDefault()}
          >
            <AlertDialogHeader>
              <AlertDialogMedia>
                <ShieldAlert className="text-destructive" />
              </AlertDialogMedia>
              <AlertDialogTitle>{t("sessionExpiredTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("sessionExpiredDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={() => redirectToCodegLogin()}>
                {t("goToLogin")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}
