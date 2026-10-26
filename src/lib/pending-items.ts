/**
 * What waits on the user — the client half of `src-tauri/src/pending`.
 *
 * The backend keeps the list (every parked permission, open question and plan
 * awaiting approval, across all sessions), pushes it to every client on each
 * change, and decides when a reminder is due. Clients show the list ("Waiting
 * for you"), and for each reminder exactly one window of this machine —
 * whichever claims its id first — posts the desktop notification.
 */

import { claimOncePerMachine } from "@/lib/critical-sessions"
import { getDesktopNotificationPrefs } from "@/lib/desktop-notification-prefs"
import {
  deliverSystemNotification,
  getNotificationPermission,
} from "@/lib/notification"
import type { NotificationTarget } from "@/lib/notification-target"
import type { PendingItem } from "@/lib/types"

/** The list changed; payload: the whole snapshot. */
export const PENDING_ITEMS_EVENT = "app://pending-items"

/** A reminder is due: notify now. */
export const PENDING_REMINDER_EVENT = "app://pending-reminder"

/** Reminder schedules offered in Settings (seconds after the ask). */
export const REMINDER_STEP_PRESETS: readonly (readonly number[])[] = [
  [300, 1800, 7200],
  [600, 3600],
  [900, 3600, 14400],
  [1800, 7200],
  [3600],
]

/** "Then every" choices, in seconds; 0 stops after the last step. */
export const REMINDER_REPEAT_CHOICES = [
  0, 3600, 7200, 14400, 28800, 43200, 86400,
] as const

export interface WaitedParts {
  unit: "seconds" | "minutes" | "hours" | "days"
  count: number
}

/** How long something has waited, in its largest whole unit. */
export function waitedDuration(seconds: number): WaitedParts {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return { unit: "seconds", count: s }
  if (s < 3600) return { unit: "minutes", count: Math.floor(s / 60) }
  if (s < 86400) return { unit: "hours", count: Math.floor(s / 3600) }
  return { unit: "days", count: Math.floor(s / 86400) }
}

/** Seconds since `iso`, never negative. */
export function secondsSince(iso: string, now: number = Date.now()): number {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.round((now - at) / 1000))
}

/** The session to open for an item: its own, or its delegation root. */
export function pendingItemTarget(item: PendingItem): NotificationTarget {
  return {
    contextKey: null,
    folderId: item.folder_id,
    conversationId: item.root_conversation_id,
    agentType: item.agent_type,
  }
}

const CLAIM_PREFIX = "codeg:pending-reminder-notified:"

/** Claim the desktop notification of one reminder on this machine. */
export function claimPendingReminder(id: string): Promise<boolean> {
  return claimOncePerMachine("codeg-pending-reminder-claim", CLAIM_PREFIX, id)
}

/**
 * Post a reminder's system notification. Honours the desktop notifications'
 * master switch, permission and "hide contents" (the session's name and the
 * agent's question stay out of the notification centre), but not their
 * "when" rule: a reminder is for the moment the first notification did not
 * work. Resolves to whether one was posted.
 */
export async function postPendingReminder(
  item: PendingItem,
  text: { title: string; redactedTitle: string; line: string }
): Promise<boolean> {
  const prefs = getDesktopNotificationPrefs()
  if (!prefs.enabled) return false
  const permission = getNotificationPermission()
  if (permission !== "granted" && permission !== "managed_by_os") return false
  const question = item.text.trim()
  const body =
    prefs.hideBody || !question ? text.line : `${text.line}\n${question}`
  try {
    await deliverSystemNotification(
      prefs.hideBody ? text.redactedTitle : text.title,
      body,
      pendingItemTarget(item)
    )
    return true
  } catch {
    return false
  }
}
