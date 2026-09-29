"use client"

/**
 * Root of the Quick Ask window: a rounded card filling a frameless,
 * transparent window, holding the connection stack a question needs and
 * nothing else from the workspace.
 *
 * It also keeps the window on the right backend. Quick Ask asks wherever the
 * user was last working — the local workspace or a remote one — so each time
 * the window is shown the desktop app says which, and the page reloads onto
 * that backend when it differs (right away when the window is empty, after
 * "New question" otherwise: an open question cannot move servers).
 */

import { useEffect } from "react"

import { AppToaster } from "@/components/ui/app-toaster"
import { AcpConnectionsProvider } from "@/contexts/acp-connections-context"
import { RemoteConnectionGate } from "@/contexts/remote-connection-context"
import {
  getQuickAskContext,
  onQuickAskShown,
  type QuickAskShownPayload,
} from "@/lib/quick-ask/desktop"
import {
  QUICK_ASK_FOCUS_INPUT_EVENT,
  currentRemoteConnectionId,
  decideBackendSwitch,
  useQuickAskWindowState,
} from "@/lib/quick-ask/window-state"
import { isDesktop } from "@/lib/transport"
import { QuickAskWindow } from "./QuickAskWindow"

function followBackend(payload: QuickAskShownPayload) {
  const { hasContent, setPendingRoute } = useQuickAskWindowState.getState()
  const decision = decideBackendSwitch({
    current: currentRemoteConnectionId(window.location.search),
    wanted: payload.remoteConnectionId,
    hasContent,
  })
  if (decision === "navigate") {
    window.location.replace(`/${payload.route}`)
    return
  }
  setPendingRoute(decision === "defer" ? payload.route : null)
}

export function QuickAskShell() {
  // The window is transparent so the card's rounded corners are its shape.
  useEffect(() => {
    if (!isDesktop()) return
    const body = document.body.style.background
    const html = document.documentElement.style.background
    document.body.style.background = "transparent"
    document.documentElement.style.background = "transparent"
    return () => {
      document.body.style.background = body
      document.documentElement.style.background = html
    }
  }, [])

  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void onQuickAskShown((payload) => {
      window.dispatchEvent(new Event(QUICK_ASK_FOCUS_INPUT_EVENT))
      followBackend(payload)
    }).then((off) => {
      if (cancelled) off()
      else unsubscribe = off
    })
    // A window built before the user moved to another workspace catches up
    // without waiting for the next show.
    void getQuickAskContext()
      .then((payload) => {
        if (!cancelled) followBackend(payload)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return (
    <div className="h-screen w-screen overflow-hidden p-0">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-background/95 text-foreground shadow-xl">
        <RemoteConnectionGate>
          <AcpConnectionsProvider>
            <QuickAskWindow />
          </AcpConnectionsProvider>
        </RemoteConnectionGate>
      </div>
      <AppToaster position="bottom-center" closeButton duration={4000} />
    </div>
  )
}
