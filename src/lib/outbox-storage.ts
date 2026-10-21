/**
 * Local copy of a conversation's unsent messages: the queue above its
 * composer (including messages marked "Not sent") and the messages on their
 * way to the server that it has not acknowledged yet.
 *
 * Written on every change, so a reload, a closed window or a restarted app
 * gives them back: the queue as it was, and every message that was still in
 * flight at the front of the queue, to be sent again with the same id (the
 * server tells a repeat apart from a new message by that id).
 *
 * Kept per server and conversation. In the desktop app the main window and a
 * remote workspace window share one localStorage, so the scope names the
 * server; a browser's localStorage is already per server (its origin).
 */

import type { PromptDraft } from "@/lib/types"
import type { SendFailure } from "@/lib/send-failure"
import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"

const STORAGE_PREFIX = "codeg:outbox:v1"

/** One message that was sent and not acknowledged yet. */
export interface InFlightMessage {
  clientMessageId: string
  draft: PromptDraft
  modeId: string | null
  /** When the send started (ms). */
  startedAt: number
}

/** The persisted form of a queued message (mirror of `QueuedMessage`). */
export interface StoredQueuedMessage {
  id: string
  clientMessageId: string
  draft: PromptDraft
  modeId: string | null
  adoptSendTimeMode?: boolean
  holdUntilTurnEnd?: boolean
  failure?: SendFailure
}

export interface StoredOutbox {
  queue: StoredQueuedMessage[]
  inflight: InFlightMessage[]
}

/** Which server this window talks to, for the storage key. */
export function outboxServerScope(): string {
  if (typeof window === "undefined") return "none"
  if (isDesktop()) {
    const remote = getActiveRemoteConnectionId()
    return remote == null ? "local" : `remote:${remote}`
  }
  return "web"
}

/** Storage key for a conversation (`conv:<id>`) or an unbound draft tab
 *  (`draft:<tabId>`). */
export function outboxStorageKey(conversationKey: string): string {
  return `${STORAGE_PREFIX}:${outboxServerScope()}:${conversationKey}`
}

function isDraft(value: unknown): value is PromptDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Partial<PromptDraft>
  return Array.isArray(draft.blocks) && typeof draft.displayText === "string"
}

function sanitize(raw: unknown): StoredOutbox | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Partial<StoredOutbox>
  const queue = Array.isArray(value.queue)
    ? value.queue.filter(
        (item): item is StoredQueuedMessage =>
          !!item &&
          typeof item.id === "string" &&
          typeof item.clientMessageId === "string" &&
          isDraft(item.draft)
      )
    : []
  const inflight = Array.isArray(value.inflight)
    ? value.inflight.filter(
        (item): item is InFlightMessage =>
          !!item &&
          typeof item.clientMessageId === "string" &&
          isDraft(item.draft)
      )
    : []
  return { queue, inflight }
}

export function loadOutbox(key: string): StoredOutbox | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = sanitize(JSON.parse(raw))
    if (!parsed || (parsed.queue.length === 0 && parsed.inflight.length === 0))
      return null
    return parsed
  } catch {
    return null
  }
}

/** A draft without the inline bytes of images the server already holds (an
 *  uploaded image keeps its `uri`, which the server reads back), for when the
 *  full copy does not fit. */
function withoutUploadedImageBytes(draft: PromptDraft): PromptDraft {
  return {
    ...draft,
    blocks: draft.blocks.map((block) =>
      block.type === "image" && block.uri ? { ...block, data: "" } : block
    ),
  }
}

function slimmed(outbox: StoredOutbox): StoredOutbox {
  return {
    queue: outbox.queue.map((item) => ({
      ...item,
      draft: withoutUploadedImageBytes(item.draft),
    })),
    inflight: outbox.inflight.map((item) => ({
      ...item,
      draft: withoutUploadedImageBytes(item.draft),
    })),
  }
}

/** A draft reduced to what always fits: its text, and the images the server
 *  holds by reference. Images that exist only in this window are lost here;
 *  that is the last resort when storage is full, not the usual path. */
function textOnly(outbox: StoredOutbox): StoredOutbox {
  const strip = (draft: PromptDraft): PromptDraft => ({
    ...draft,
    blocks: draft.blocks
      .filter((block) => block.type !== "image" || !!block.uri)
      .map((block) =>
        block.type === "image" ? { ...block, data: "" } : block
      ),
  })
  return {
    queue: outbox.queue.map((item) => ({ ...item, draft: strip(item.draft) })),
    inflight: outbox.inflight.map((item) => ({
      ...item,
      draft: strip(item.draft),
    })),
  }
}

export function saveOutbox(key: string, outbox: StoredOutbox): void {
  if (typeof window === "undefined") return
  try {
    if (outbox.queue.length === 0 && outbox.inflight.length === 0) {
      window.localStorage.removeItem(key)
      return
    }
  } catch {
    return
  }
  for (const candidate of [outbox, slimmed(outbox), textOnly(outbox)]) {
    try {
      window.localStorage.setItem(key, JSON.stringify(candidate))
      return
    } catch {
      // Over quota: try a smaller copy.
    }
  }
  console.warn("[outbox] could not store the unsent messages", key)
}

export function removeOutbox(key: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing more to do.
  }
}
