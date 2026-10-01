/**
 * Critical sessions — the client half.
 *
 * The user marks a session critical; the backend watchdog
 * (`src-tauri/src/acp/critical_watch.rs`) alerts when it sits idle (its turn
 * ended, it waits on the user, it was interrupted) for the idle threshold, or
 * when a working turn goes silent for the stall threshold, and repeats until
 * the user acts or acknowledges. Every connected client hears the alert;
 * this module holds what they share: the event names, the i18n keys per alert
 * kind, the optimistic mark/unmark, and the per-machine claim that keeps
 * several windows from posting the same system notification.
 */

import { updateConversationCritical } from "@/lib/api"
import {
  deliverSystemNotification,
  getNotificationPermission,
} from "@/lib/notification"
import { getDesktopNotificationPrefs } from "@/lib/desktop-notification-prefs"
import type { NotificationTarget } from "@/lib/notification-target"
import type { CriticalAlert, CriticalAlertKind } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** Fired once per alert (first and every repeat): notify now. */
export const CRITICAL_ALERT_EVENT = "app://critical-session-alert"

/** The alerts waiting for an acknowledgement changed (the banner). */
export const CRITICAL_ALERTS_EVENT = "app://critical-session-alerts"

/** Headline per alert kind, under `CriticalSessions.headline`. Literal on
 *  purpose: next-intl keys are typed. */
export const CRITICAL_ALERT_HEADLINE_KEYS = {
  idle: "idle",
  needs_you: "needsYou",
  interrupted: "interrupted",
  stalled: "stalled",
  background_stalled: "stalled",
} as const satisfies Record<CriticalAlertKind, string>

/** One line on what happened, under `CriticalSessions.body`; takes
 *  `{elapsed}`. */
export const CRITICAL_ALERT_BODY_KEYS = {
  idle: "idle",
  needs_you: "needsYou",
  interrupted: "interrupted",
  stalled: "stalled",
  background_stalled: "backgroundStalled",
} as const satisfies Record<CriticalAlertKind, string>

/** Choices offered in Settings, in seconds. A stored value outside them (set
 *  through the API) is shown as an extra choice. */
export const CRITICAL_IDLE_CHOICES = [30, 60, 120, 300, 600, 900] as const
export const CRITICAL_REPEAT_CHOICES = [
  0, 60, 120, 300, 600, 900, 1800,
] as const
export const CRITICAL_STALL_CHOICES = [120, 300, 600, 900, 1800] as const

/** How long the banner's Snooze holds an alert. */
export const CRITICAL_SNOOZE_MINUTES = 15

export interface DurationParts {
  unit: "seconds" | "minutes" | "hours"
  count: number
}

/** A setting's exact duration in its largest whole unit: 30 s, 5 min, 1 h —
 *  and 90 s rather than a rounded "1 min". */
export function exactDuration(seconds: number): DurationParts {
  const s = Math.max(0, Math.round(seconds))
  if (s >= 3600 && s % 3600 === 0) return { unit: "hours", count: s / 3600 }
  if (s >= 60 && s % 60 === 0) return { unit: "minutes", count: s / 60 }
  return { unit: "seconds", count: s }
}

/** How long ago, rounded down to its largest unit: 45 s, 3 min, 2 h. */
export function elapsedDuration(seconds: number): DurationParts {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return { unit: "seconds", count: s }
  if (s < 3600) return { unit: "minutes", count: Math.floor(s / 60) }
  return { unit: "hours", count: Math.floor(s / 3600) }
}

/** Seconds from `since` to `now`, never negative. */
export function elapsedSeconds(since: string, now: number = Date.now()) {
  const at = Date.parse(since)
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.round((now - at) / 1000))
}

/**
 * Mark or unmark a conversation critical, optimistically: the row (and with
 * it the flag on its sidebar row and tab) changes at once, and goes back if
 * the backend refuses. The backend's upsert echo then carries the stored
 * values to every client.
 */
export async function setConversationCritical(
  conversationId: number,
  critical: boolean,
  stall?: boolean
): Promise<void> {
  const store = useAppWorkspaceStore.getState()
  const prev = store.conversations.find((c) => c.id === conversationId)
  store.updateConversationLocal(
    conversationId,
    stall === undefined ? { critical } : { critical, critical_stall: stall }
  )
  try {
    await updateConversationCritical(conversationId, critical, stall)
  } catch (err) {
    if (prev) {
      useAppWorkspaceStore.getState().updateConversationLocal(conversationId, {
        critical: prev.critical ?? false,
        critical_stall: prev.critical_stall ?? true,
      })
    }
    throw err
  }
}

const CLAIM_PREFIX = "codeg:critical-alert-notified:"
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000

function claimInStorage(alertId: string): boolean {
  try {
    const storage = window.localStorage
    const key = CLAIM_PREFIX + alertId
    if (storage.getItem(key) != null) return false
    const now = Date.now()
    storage.setItem(key, String(now))
    // Old claims are dead weight: an alert id never comes back.
    for (let i = storage.length - 1; i >= 0; i -= 1) {
      const k = storage.key(i)
      if (!k || !k.startsWith(CLAIM_PREFIX) || k === key) continue
      const at = Number(storage.getItem(k))
      if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) storage.removeItem(k)
    }
    return true
  } catch {
    // No storage to coordinate through: better a duplicate than nothing.
    return true
  }
}

/**
 * Claim the system notification for one alert on this machine. Every window
 * connected to the backend hears the alert; the first to claim its id posts
 * the notification and plays the sound, the others only show the banner. The
 * windows of the desktop app share an origin, so the claim goes through
 * `localStorage`, serialized by a Web Lock where the engine has them.
 */
export async function claimCriticalAlert(alertId: string): Promise<boolean> {
  if (typeof window === "undefined") return false
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (locks && typeof locks.request === "function") {
    try {
      return await locks.request("codeg-critical-alert-claim", () =>
        claimInStorage(alertId)
      )
    } catch {
      return claimInStorage(alertId)
    }
  }
  return claimInStorage(alertId)
}

/** The session an alert is about, as a notification click target. */
export function criticalAlertTarget(alert: CriticalAlert): NotificationTarget {
  return {
    contextKey: null,
    folderId: alert.folder_id,
    conversationId: alert.conversation_id,
    agentType: alert.agent_type,
  }
}

/**
 * Post the system notification for an alert. Honours the desktop
 * notifications' master switch, permission and "hide contents", but not their
 * "when" rule or per-event switches: a critical alert is the one the user
 * asked to be interrupted for. Resolves to whether one was posted.
 */
export async function postCriticalNotification(
  alert: CriticalAlert,
  text: { title: string; redactedTitle: string; body: string }
): Promise<boolean> {
  const prefs = getDesktopNotificationPrefs()
  if (!prefs.enabled) return false
  const permission = getNotificationPermission()
  if (permission !== "granted" && permission !== "managed_by_os") return false
  try {
    await deliverSystemNotification(
      prefs.hideBody ? text.redactedTitle : text.title,
      text.body,
      criticalAlertTarget(alert)
    )
    return true
  } catch {
    return false
  }
}
