"use client"

/**
 * Keeps this window's "Waiting for you" list in step with the backend
 * (`src-tauri/src/pending`) and posts the reminders' desktop notifications.
 *
 * Mounted once per window, always (the sidebar that shows the list may be
 * collapsed). The backend decides when a reminder is due — never about the
 * session someone is looking at — so this only reports: every window hears
 * each reminder, and the first of this machine to claim its id posts it.
 * In a browser the app badge (where the browser has one) shows the count;
 * the desktop app's dock badge is set by the backend.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { syncPendingNotifications } from "@/lib/notification"
import { notificationActionLabels } from "@/lib/notification-actions"
import { isDesktop, onTransportReconnect, subscribe } from "@/lib/platform"
import {
  claimPendingReminder,
  createPendingNotificationSync,
  PENDING_ITEMS_EVENT,
  PENDING_REMINDER_EVENT,
  postPendingReminder,
  secondsSince,
  waitedDuration,
} from "@/lib/pending-items"
import type {
  PendingItem,
  PendingItemsSnapshot,
  PendingReminder,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  applyLivePendingItems,
  refreshPendingItems,
  usePendingItemsStore,
} from "@/stores/pending-items-store"

type Translate = ReturnType<typeof useTranslations<"PendingItems">>

/** A reminder's words: the session, and how long the agent has waited. */
export function pendingReminderText(
  t: Translate,
  item: PendingItem,
  liveTitle?: string | null,
  now: number = Date.now()
): { title: string; redactedTitle: string; line: string } {
  const { unit, count } = waitedDuration(secondsSince(item.asked_at, now))
  const elapsed = t(`duration.${unit}`, { count })
  return {
    title: liveTitle?.trim() || item.title?.trim() || t("untitled"),
    redactedTitle: t("notificationRedacted"),
    line: t(`reminder.${item.kind}`, { agent: item.agent_label, elapsed }),
  }
}

interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function PendingItemsBridge() {
  const t = useTranslations("PendingItems")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    let disposed = false
    const disposers: Array<() => void> = []
    const keep = (dispose: () => void) => {
      if (disposed) dispose()
      else disposers.push(dispose)
    }
    // Notifications about items that cleared (answered on the phone or in
    // another window, cancelled) are withdrawn, buttons and all.
    const observe = createPendingNotificationSync((live, gone) => {
      syncPendingNotifications(live, gone).catch(() => {
        // A shell without the command: nothing to withdraw.
      })
    })
    const refresh = async () => {
      const snapshot = await refreshPendingItems()
      if (snapshot && !disposed) observe(snapshot.items)
    }
    void refresh()
    subscribe<PendingItemsSnapshot>(PENDING_ITEMS_EVENT, (snapshot) => {
      applyLivePendingItems(snapshot)
      observe(snapshot.items)
    })
      .then(keep)
      .catch((err) => console.error("[pending] subscribe failed:", err))
    subscribe<PendingReminder>(PENDING_REMINDER_EVENT, (reminder) => {
      void (async () => {
        if (!(await claimPendingReminder(reminder.id))) return
        const live = useAppWorkspaceStore
          .getState()
          .conversations.find(
            (c) => c.id === reminder.item.root_conversation_id
          )?.title
        await postPendingReminder(
          reminder.item,
          pendingReminderText(tRef.current, reminder.item, live),
          notificationActionLabels(tRef.current)
        )
      })()
    })
      .then(keep)
      .catch((err) => console.error("[pending] subscribe failed:", err))
    const offReconnect = onTransportReconnect(() => refresh(), {
      priority: "status",
      key: "pending-items",
    })
    return () => {
      disposed = true
      disposers.forEach((dispose) => dispose())
      offReconnect?.()
    }
  }, [])

  // The browser's app badge (an installed web app); the desktop's is the
  // backend's.
  const count = usePendingItemsStore((s) => s.count)
  useEffect(() => {
    if (isDesktop() || typeof navigator === "undefined") return
    const badging = navigator as Navigator & BadgingNavigator
    const done =
      count > 0 ? badging.setAppBadge?.(count) : badging.clearAppBadge?.()
    done?.catch(() => {
      // Not an installed app, or the user turned badges off.
    })
  }, [count])

  return null
}
