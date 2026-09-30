/**
 * Platform layer for OS notifications: deliver one, and report what the
 * platform will actually let us do.
 *
 * This module knows nothing about agent events, preferences or throttling —
 * that is `desktop-notification.ts`, which is what feature code should call.
 * Everything here is the thin, honest wrapper over two very different
 * substrates:
 *
 *   - Tauri desktop: a backend command. There is no queryable permission (see
 *     `getNotificationPermission`), so the only truth available is whether a
 *     delivery succeeded — which is why `deliverSystemNotification` throws
 *     instead of swallowing, and why the settings panel offers a test send.
 *   - Browser: the `Notification` API, whose permission is real, three-valued,
 *     and only requestable from inside a user gesture.
 */

import {
  notificationGroupKey,
  openNotificationTargetFromClick,
  parseNotificationTarget,
  type NotificationTarget,
} from "./notification-target"
import { getShellTransport, isDesktop } from "./transport"
import type { UnsubscribeFn } from "./transport/types"

/**
 * What the platform can tell us about permission to post notifications.
 *
 * `managed_by_os` is not a euphemism for "granted". On desktop the app has no
 * way to ask: `tauri-plugin-notification`'s desktop backend hard-codes
 * `PermissionState::Granted` for both `permission_state()` and
 * `request_permission()`, and `mac-notification-sys` exposes no authorization
 * API at all. Reporting "granted" there would be inventing a fact — the user
 * may well have Codeg switched off in System Settings and we cannot see it.
 * So the desktop UI states who owns the decision and offers a test send.
 *
 * `unsupported` covers the browser case that bites real deployments: a
 * `codeg-server` reached over plain `http://` on a LAN address is not a secure
 * context, so `Notification` is simply absent.
 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported"
  | "managed_by_os"

/** The browser `Notification` constructor, or null when it isn't available. */
function browserNotification(): typeof Notification | null {
  if (typeof window === "undefined") return null
  const ctor = (window as { Notification?: typeof Notification }).Notification
  return typeof ctor === "function" ? ctor : null
}

/**
 * Current permission, without asking for it.
 *
 * Safe to call on every render: it reads a synchronous property and never
 * prompts.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (isDesktop()) return "managed_by_os"
  const ctor = browserNotification()
  if (!ctor) return "unsupported"
  const permission = ctor.permission
  return permission === "granted" || permission === "denied"
    ? permission
    : "default"
}

/**
 * Ask the browser for permission and report where that landed.
 *
 * MUST be called from inside a user gesture. That is not a style preference:
 * Safari rejects a request made outside one, and Chrome ignores requests from a
 * page that isn't visible. The previous implementation requested permission
 * lazily from the event path, gated on `document.hidden` — i.e. only ever from
 * a background page with no gesture in scope, which is precisely the state in
 * which the request cannot succeed. The prompt now originates from the button
 * in Settings, and nowhere else.
 *
 * A no-op on desktop, where there is nothing to request.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (isDesktop()) return "managed_by_os"
  const ctor = browserNotification()
  if (!ctor) return "unsupported"
  try {
    const result = await ctor.requestPermission()
    return result === "granted" || result === "denied" ? result : "default"
  } catch {
    // Older Safari hands back a callback-style API that rejects the promise
    // form; treat that as "still undecided" rather than a hard denial.
    return getNotificationPermission()
  }
}

/**
 * Post one notification, now. Throws if the platform reported a failure.
 *
 * `target` names the session the notification is about. A click on it then
 * opens that session: on desktop the backend brings the owning window forward
 * and hands it the session (see `notification.rs`); in a browser the click
 * lands in this very page. It also groups: a newer notification about the
 * same session replaces the older one.
 *
 * Callers that are on an event path should go through `notifyDesktop` instead —
 * this bypasses every preference and gate.
 */
export async function deliverSystemNotification(
  title: string,
  body: string,
  target?: NotificationTarget | null
): Promise<void> {
  if (isDesktop()) {
    // Deliberately the SHELL transport, not `getTransport()`. In a
    // remote-desktop window `getTransport()` is the remote HTTP transport, and
    // `send_notification` is a `tauri-runtime`-only command that the
    // `codeg-server` binary never registers — so every notification in those
    // windows was being posted to a machine the user isn't sitting at, failed,
    // and got swallowed by the caller's `.catch()`. A notification belongs to
    // the screen in front of the user, which is always the local shell.
    await getShellTransport().call(
      "send_notification",
      target ? { title, body, target } : { title, body }
    )
    return
  }

  const ctor = browserNotification()
  if (!ctor) throw new Error("Notifications are not available in this context")
  // Never request permission from here: this runs on the event path, where a
  // request cannot succeed (see `requestNotificationPermission`). An
  // un-granted browser is simply a platform that won't deliver.
  if (ctor.permission !== "granted") {
    throw new Error("Notification permission has not been granted")
  }
  const tag = target ? notificationGroupKey(target) : null
  if (!target || !tag) {
    new ctor(title, { body })
    return
  }
  // `renotify` so a replacement still alerts; not in every DOM typing, and
  // ignored by the browsers that lack it.
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    tag,
    renotify: true,
  }
  const notification = new ctor(title, options)
  notification.onclick = () => {
    try {
      window.focus()
    } catch {
      // A browser may refuse; the tab still opens behind it.
    }
    notification.close?.()
    openNotificationTargetFromClick(target)
  }
}

/** Poke from the desktop backend: a notification click left a session for
 *  this window in {@link takePendingNotificationOpens}. */
export const NOTIFICATION_OPEN_PENDING_EVENT = "notification://open-pending"

/**
 * Take the sessions notification clicks handed to this window. Desktop only,
 * and over the shell transport: the clicks, and the window they target,
 * belong to this machine even when the window drives a remote workspace.
 */
export async function takePendingNotificationOpens(): Promise<
  NotificationTarget[]
> {
  if (!isDesktop()) return []
  const raw = await getShellTransport().call<unknown>(
    "notification_take_pending_open"
  )
  if (!Array.isArray(raw)) return []
  return raw
    .map(parseNotificationTarget)
    .filter((target): target is NotificationTarget => target !== null)
}

/** Subscribe to {@link NOTIFICATION_OPEN_PENDING_EVENT} (desktop only). */
export function onNotificationOpenPending(
  handler: () => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe(NOTIFICATION_OPEN_PENDING_EVENT, () =>
    handler()
  )
}

/**
 * Which app the OS files our notifications under.
 *
 * On macOS this is not a formality. `NSUserNotification` has no concept of an
 * unbundled process, so the backend claims a bundle id and the OS attributes
 * the notification — and its permission, icon and System Settings page — to
 * THAT app. When `bundleId` differs from `requestedBundleId` the switches the
 * user can see under "codeg" govern nothing.
 */
export interface NotificationIdentity {
  /** Bundle id notifications are actually delivered under. */
  bundleId: string
  /** Bundle id we asked for — this app's own identifier. */
  requestedBundleId: string
  /** Delivery fell back to another app's identity. */
  degraded: boolean
}

/**
 * Read the delivering identity, or `null` where there is nothing trustworthy
 * to report — a browser (it posts as itself), and every desktop platform but
 * macOS (only macOS impersonates another app to deliver; see the Rust
 * `resolve_notification_identity` for why Windows is excluded rather than
 * guessed at).
 *
 * The first call is what establishes the identity, so this is a write as much
 * as a read; see the Rust `notification_identity` for why calling it from a
 * settings panel is safe.
 */
export async function getNotificationIdentity(): Promise<NotificationIdentity | null> {
  if (!isDesktop()) return null
  // Same shell-transport reasoning as delivery: the notification, and the
  // identity it is filed under, belong to the machine in front of the user.
  return await getShellTransport().call<NotificationIdentity | null>(
    "notification_identity"
  )
}

/**
 * Open the OS pane that owns notification permission for this app.
 *
 * Desktop only — a browser's per-site permission lives in the browser's own UI,
 * which no page may open on its own. Throws when the desktop environment has no
 * such pane (some Linux setups), so the caller can say so rather than leave the
 * user staring at a button that did nothing.
 *
 * Routed through the shell transport for the same reason delivery is: the
 * settings the user wants are on the machine in front of them, not on a remote
 * workspace host.
 */
export async function openSystemNotificationSettings(): Promise<void> {
  if (!isDesktop()) {
    throw new Error(
      "System notification settings are only reachable on desktop"
    )
  }
  await getShellTransport().call("open_system_notification_settings")
}
