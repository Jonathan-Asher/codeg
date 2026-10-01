"use client"

/**
 * Critical session alerts in this window: the persistent banner, the system
 * notification and the sound.
 *
 * The backend watchdog (`src-tauri/src/acp/critical_watch.rs`) decides when a
 * critical session has sat idle (or gone silent) long enough, so this
 * component only reports. Every connected window shows the banner for each
 * alert still waiting for an acknowledgement (read on mount and after a
 * reconnect, then kept live); for each alert as it fires, exactly one window
 * of this machine — whichever claims its id first — posts the system
 * notification and plays the tone.
 *
 * Acknowledging: Open, Dismiss and Snooze on the banner; switching to the
 * session's tab; and bringing the window back to the front while that tab is
 * the active one and has an alert up. Sending a message or answering counts
 * too, but the backend sees that on its own.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { BellOff, Flag, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useTabStore } from "@/contexts/tab-context"
import {
  ackCriticalSession,
  getCriticalAlerts,
  snoozeCriticalSession,
} from "@/lib/api"
import {
  CRITICAL_ALERT_BODY_KEYS,
  CRITICAL_ALERT_EVENT,
  CRITICAL_ALERT_HEADLINE_KEYS,
  CRITICAL_ALERTS_EVENT,
  CRITICAL_SNOOZE_MINUTES,
  claimCriticalAlert,
  criticalAlertTarget,
  elapsedDuration,
  elapsedSeconds,
  postCriticalNotification,
} from "@/lib/critical-sessions"
import { playCriticalAlertSound } from "@/lib/notification-sound"
import { openNotificationTargetFromClick } from "@/lib/notification-target"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { CriticalAlert, CriticalAlertsSnapshot } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** How often the banner's "for 3 min" catches up. */
const ELAPSED_REFRESH_MS = 15_000

type Translate = ReturnType<typeof useTranslations<"CriticalSessions">>

/** The words of an alert: headline, the session's name, what happened. */
export function criticalAlertText(
  t: Translate,
  alert: CriticalAlert,
  liveTitle?: string | null,
  now: number = Date.now()
): {
  headline: string
  session: string
  title: string
  redactedTitle: string
  body: string
} {
  const headline = t(`headline.${CRITICAL_ALERT_HEADLINE_KEYS[alert.kind]}`)
  const session = liveTitle?.trim() || alert.title?.trim() || t("untitled")
  const { unit, count } = elapsedDuration(elapsedSeconds(alert.since, now))
  const elapsed = t(`duration.${unit}`, { count })
  return {
    headline,
    session,
    title: t("notificationTitle", { headline, session }),
    redactedTitle: t("notificationTitleRedacted", { headline }),
    body: t(`body.${CRITICAL_ALERT_BODY_KEYS[alert.kind]}`, { elapsed }),
  }
}

function useLiveTitle(conversationId: number): string | null | undefined {
  return useAppWorkspaceStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.title
  )
}

function CriticalAlertBanner({
  alert,
  now,
  onOpen,
  onSnooze,
  onDismiss,
}: {
  alert: CriticalAlert
  now: number
  onOpen: (alert: CriticalAlert) => void
  onSnooze: (alert: CriticalAlert) => void
  onDismiss: (alert: CriticalAlert) => void
}) {
  const t = useTranslations("CriticalSessions")
  const liveTitle = useLiveTitle(alert.conversation_id)
  const text = criticalAlertText(t, alert, liveTitle, now)
  return (
    <div
      role="alert"
      data-critical-alert={alert.conversation_id}
      data-critical-alert-kind={alert.kind}
      className="pointer-events-auto w-[480px] max-w-[calc(100vw-2rem)] rounded-lg border border-red-500/60 bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <Flag
          className="mt-0.5 h-4 w-4 shrink-0 fill-red-500 text-red-500"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpen(alert)}
            className="block max-w-full truncate text-left text-sm font-medium leading-snug hover:underline"
            title={t("open")}
          >
            {text.title}
          </button>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {text.body}
            {alert.count > 1 ? (
              <span className="ml-1">
                {t("reminder", { count: alert.count })}
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("dismiss")}
          title={t("dismiss")}
          onClick={() => onDismiss(alert)}
          className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onSnooze(alert)}
        >
          <BellOff className="h-3.5 w-3.5" aria-hidden />
          {t("snooze", { minutes: CRITICAL_SNOOZE_MINUTES })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onOpen(alert)}
        >
          {t("open")}
        </Button>
      </div>
    </div>
  )
}

export function CriticalAlerts() {
  const t = useTranslations("CriticalSessions")
  const [alerts, setAlerts] = useState<CriticalAlert[]>([])
  const [now, setNow] = useState(() => Date.now())
  const alertsRef = useRef<CriticalAlert[]>([])
  const tRef = useRef(t)

  useEffect(() => {
    tRef.current = t
  }, [t])

  const applySnapshot = useCallback((snapshot: CriticalAlertsSnapshot) => {
    alertsRef.current = snapshot.alerts
    setAlerts(snapshot.alerts)
    setNow(Date.now())
  }, [])

  const ack = useCallback(
    (conversationId: number) => {
      ackCriticalSession(conversationId)
        .then(applySnapshot)
        .catch((err) => {
          console.error("[critical] ack failed:", err)
        })
    },
    [applySnapshot]
  )

  // The set waiting for an acknowledgement: on mount, live, and again after a
  // reconnect (events fired while disconnected are gone). Plus each alert as
  // it fires, for the notification and the tone.
  useEffect(() => {
    let disposed = false
    const disposers: Array<() => void> = []
    const load = () => {
      getCriticalAlerts()
        .then((snapshot) => {
          if (!disposed) applySnapshot(snapshot)
        })
        .catch((err) => {
          console.error("[critical] load alerts failed:", err)
        })
    }
    const keep = (dispose: () => void) => {
      if (disposed) dispose()
      else disposers.push(dispose)
    }
    load()
    subscribe<CriticalAlertsSnapshot>(CRITICAL_ALERTS_EVENT, (snapshot) =>
      applySnapshot(snapshot)
    )
      .then(keep)
      .catch((err) => console.error("[critical] subscribe failed:", err))
    subscribe<CriticalAlert>(CRITICAL_ALERT_EVENT, (alert) => {
      void (async () => {
        if (!(await claimCriticalAlert(alert.id))) return
        const live = useAppWorkspaceStore
          .getState()
          .conversations.find((c) => c.id === alert.conversation_id)?.title
        const text = criticalAlertText(tRef.current, alert, live)
        if (alert.sound) playCriticalAlertSound()
        await postCriticalNotification(alert, text)
      })()
    })
      .then(keep)
      .catch((err) => console.error("[critical] subscribe failed:", err))
    const offReconnect = onTransportReconnect(load)
    return () => {
      disposed = true
      disposers.forEach((dispose) => dispose())
      offReconnect?.()
    }
  }, [applySnapshot])

  // Switching to a critical session's tab acknowledges its idle stretch,
  // alert or not yet. Only switches after mount count: a window restoring its
  // last tab on start-up is not the user looking at it.
  useEffect(() => {
    let prev = useTabStore.getState().activeTabId
    return useTabStore.subscribe((state) => {
      const activeTabId = state.activeTabId
      if (activeTabId === prev) return
      prev = activeTabId
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return
      }
      const conversationId = state.tabs.find(
        (tab) => tab.id === activeTabId
      )?.conversationId
      if (conversationId == null) return
      const critical = useAppWorkspaceStore
        .getState()
        .conversations.find((c) => c.id === conversationId)?.critical
      if (critical) ack(conversationId)
    })
  }, [ack])

  // Coming back to the window with an alerted session's tab in front.
  useEffect(() => {
    const onFocus = () => {
      const { activeTabId, tabs } = useTabStore.getState()
      const conversationId = tabs.find(
        (tab) => tab.id === activeTabId
      )?.conversationId
      if (
        conversationId != null &&
        alertsRef.current.some((a) => a.conversation_id === conversationId)
      ) {
        ack(conversationId)
      }
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [ack])

  // Keep "for N min" current while a banner is up.
  useEffect(() => {
    if (alerts.length === 0) return
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [alerts.length])

  const open = useCallback(
    (alert: CriticalAlert) => {
      openNotificationTargetFromClick(criticalAlertTarget(alert))
      ack(alert.conversation_id)
    },
    [ack]
  )

  const snooze = useCallback(
    (alert: CriticalAlert) => {
      snoozeCriticalSession(alert.conversation_id, CRITICAL_SNOOZE_MINUTES)
        .then(applySnapshot)
        .catch((err) => {
          console.error("[critical] snooze failed:", err)
        })
    },
    [applySnapshot]
  )

  const dismiss = useCallback(
    (alert: CriticalAlert) => ack(alert.conversation_id),
    [ack]
  )

  if (alerts.length === 0) return null
  return (
    <div
      data-critical-alerts
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex flex-col items-center gap-2 px-4"
    >
      {alerts.map((alert) => (
        <CriticalAlertBanner
          key={alert.conversation_id}
          alert={alert}
          now={now}
          onOpen={open}
          onSnooze={snooze}
          onDismiss={dismiss}
        />
      ))}
    </div>
  )
}
