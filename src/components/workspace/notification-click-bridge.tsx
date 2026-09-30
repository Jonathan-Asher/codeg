"use client"

import { useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  onNotificationOpenPending,
  takePendingNotificationOpens,
} from "@/lib/notification"
import {
  openNotificationTarget,
  setNotificationClickHandler,
  type NotificationTarget,
} from "@/lib/notification-target"
import { isDesktop } from "@/lib/transport"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

/** Folders, tabs and the conversation list are all in: the checks below read
 *  them, and a window rebuilt for a click is still loading them. */
function workspaceReady(): boolean {
  const workspace = useAppWorkspaceStore.getState()
  return (
    workspace.foldersHydrated &&
    !workspace.conversationsLoading &&
    useTabStore.getState().tabsHydrated
  )
}

function whenWorkspaceReady(): Promise<void> {
  if (workspaceReady()) return Promise.resolve()
  return new Promise((resolve) => {
    const offs: Array<() => void> = []
    const check = () => {
      if (!workspaceReady()) return
      for (const off of offs) off()
      resolve()
    }
    offs.push(useAppWorkspaceStore.subscribe(check))
    offs.push(useTabStore.subscribe(check))
    check()
  })
}

/** Whether a conversation still exists. The workspace's list first; on a miss
 *  it is re-read once, since a conversation created elsewhere since the last
 *  refresh is not a deleted one. A sub-agent's conversation is not in that
 *  list, but one open in a tab carries its summary. */
async function conversationExists(conversationId: number): Promise<boolean> {
  const known = () =>
    useAppWorkspaceStore
      .getState()
      .conversations.some((c) => c.id === conversationId) ||
    useTabStore.getState().childSummaries.has(conversationId)
  if (known()) return true
  try {
    await useAppWorkspaceStore.getState().refreshConversations()
  } catch {
    return false
  }
  return known()
}

/**
 * Where a click on a session's notification lands in this window: an OS
 * notification (desktop: the backend brought this window forward and parked
 * the session for it; browser: the click happened in this page) or an in-app
 * toast's title. Opens the session's tab once the workspace has loaded, or
 * says the session is gone.
 *
 * Inside `WorkbenchRouteProvider`: opening a session leaves whatever workbench
 * page (Automations, Tasks…) is on screen, as picking one from search does.
 */
export function NotificationClickBridge() {
  const t = useTranslations("Folder.chat.acpConnections")
  const route = useOptionalWorkbenchRoute()

  // Read at click time, without re-registering on every render.
  const latest = useRef({ t, openConversations: route?.openConversations })
  useEffect(() => {
    latest.current = { t, openConversations: route?.openConversations }
  }, [t, route?.openConversations])

  // Clicks open one after another, in the order they came.
  const chain = useRef<Promise<void>>(Promise.resolve())

  const open = useCallback((target: NotificationTarget) => {
    chain.current = chain.current
      .then(async () => {
        await whenWorkspaceReady()
        await openNotificationTarget(target, {
          findTab: (tabId) =>
            useTabStore.getState().tabs.find((tab) => tab.id === tabId) ?? null,
          switchTab: (tabId) => {
            latest.current.openConversations?.()
            useTabStore.getState().switchTab(tabId)
          },
          conversationExists,
          openConversation: (folderId, conversationId, agentType) => {
            latest.current.openConversations?.()
            useTabStore
              .getState()
              .openTab(folderId, conversationId, agentType, true)
          },
          onMissing: () => {
            toast.info(latest.current.t("sessionUnavailable"))
          },
        })
      })
      // Never leave the chain rejected: every later click hangs off it.
      .catch((err) => {
        console.error("[NotificationClickBridge] open failed:", err)
      })
  }, [])

  useEffect(() => setNotificationClickHandler(open), [open])

  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    const disposers: Array<() => void> = []

    const drain = async () => {
      try {
        const pending = await takePendingNotificationOpens()
        // Nothing to re-park on unmount: the window is going away.
        if (cancelled) return
        for (const target of pending) open(target)
      } catch (err) {
        console.warn("[NotificationClickBridge] take pending failed:", err)
      }
    }

    void (async () => {
      try {
        const off = await onNotificationOpenPending(() => {
          void drain()
        })
        if (cancelled) off()
        else disposers.push(off)
      } catch (err) {
        console.warn("[NotificationClickBridge] subscription failed:", err)
      }
      // After subscribing, so a click parked while the subscription was being
      // set up cannot fall between the two.
      await drain()
    })()

    return () => {
      cancelled = true
      for (const off of disposers) off()
    }
  }, [open])

  return null
}
