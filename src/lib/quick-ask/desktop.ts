"use client"

/**
 * The Quick Ask commands that belong to the desktop app on THIS machine — the
 * shortcut settings, the window itself, and "Open in codeg". They always go
 * through the local shell transport, never the window's own one: a Quick Ask
 * (or settings) window bound to a remote workspace sends its API calls to the
 * remote server, but the shortcut and the windows live here.
 */

import { getShellTransport, isDesktop } from "@/lib/transport"
import type { UnsubscribeFn } from "@/lib/transport/types"

/** Mirror of Rust `QuickAskSettingsView`. */
export interface QuickAskSettingsView {
  enabled: boolean
  shortcut: string
  hide_on_blur: boolean
  /** The shortcut is registered with the OS right now. */
  registered: boolean
  /** Why registration failed (typically: another app owns the combination). */
  registration_error: string | null
}

export interface QuickAskSettingsInput {
  enabled: boolean
  shortcut: string
  hideOnBlur: boolean
}

/** Payload of `quick-ask://shown`: the backend the window should be on. */
export interface QuickAskShownPayload {
  remoteConnectionId: number | null
  route: string
}

export interface QuickAskFocusRequest {
  folderId: number
  conversationId: number
  agent: string
}

export const QUICK_ASK_SHOWN_EVENT = "quick-ask://shown"
export const QUICK_ASK_FOCUS_PENDING_EVENT = "quick-ask://focus-pending"

export function getQuickAskSettings(): Promise<QuickAskSettingsView> {
  return getShellTransport().call("get_quick_ask_settings")
}

export function updateQuickAskSettings(
  input: QuickAskSettingsInput
): Promise<QuickAskSettingsView> {
  return getShellTransport().call("update_quick_ask_settings", {
    enabled: input.enabled,
    shortcut: input.shortcut,
    hideOnBlur: input.hideOnBlur,
  })
}

export function toggleQuickAskWindow(): Promise<void> {
  return getShellTransport().call("toggle_quick_ask_window")
}

/** Esc / the close button. Hands focus back to the previous app (macOS). */
export async function hideQuickAskWindow(): Promise<void> {
  if (!isDesktop()) return
  await getShellTransport().call("hide_quick_ask_window")
}

export function getQuickAskContext(): Promise<QuickAskShownPayload> {
  return getShellTransport().call("quick_ask_context")
}

/** Bring the question's workspace forward and open the conversation there. */
export function openQuickAskConversation(args: {
  remoteConnectionId: number | null
  folderId: number
  conversationId: number
  agent: string
}): Promise<void> {
  return getShellTransport().call("quick_ask_open_conversation", {
    remoteConnectionId: args.remoteConnectionId,
    folderId: args.folderId,
    conversationId: args.conversationId,
    agent: args.agent,
  })
}

/** For a workspace window: take the conversations Quick Ask handed to it. */
export function takePendingQuickAskFocus(): Promise<QuickAskFocusRequest[]> {
  return getShellTransport().call("quick_ask_take_pending_focus")
}

export function onQuickAskShown(
  handler: (payload: QuickAskShownPayload) => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe(QUICK_ASK_SHOWN_EVENT, handler)
}

export function onQuickAskFocusPending(
  handler: () => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe(QUICK_ASK_FOCUS_PENDING_EVENT, () =>
    handler()
  )
}
