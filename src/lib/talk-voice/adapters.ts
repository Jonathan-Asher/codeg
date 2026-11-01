/**
 * The send pipelines of this window's conversation tabs, for Talk: a tab
 * registers how a spoken message goes out through its own composer
 * machinery (`handleSend`, the queue and outbox, steering with its
 * `NoActiveTurn` fallback, optimistic turns), so what Talk sends behaves
 * exactly like a typed message, mic marker aside.
 *
 * Keyed by the conversation's database id. A tab that unmounts (closed,
 * moved to another split group) takes its registration back; the newest
 * registration for an id wins, and releasing an older one leaves it alone.
 */

import type { RequeueOptions } from "@/hooks/use-message-queue"
import type { SendFailure } from "@/lib/send-failure"
import type { PromptDraft } from "@/lib/types"
import type { SpokenSendRoute } from "./protocol"

export interface TalkSendAdapter {
  /** The tab whose pipeline this is (its connection's context key). */
  readonly contextKey: string
  /**
   * Send what the person said: a prompt when the session is idle, into the
   * running turn when it takes a message now (native steering; a turn that
   * just ended gets it as a prompt instead), the queue otherwise. Marked
   * spoken.
   */
  sendSpoken(text: string): Promise<SpokenSendRoute>
}

const adapters = new Map<number, TalkSendAdapter>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Register `adapter` for `conversationId`; returns the release. */
export function registerTalkSendAdapter(
  conversationId: number,
  adapter: TalkSendAdapter
): () => void {
  adapters.set(conversationId, adapter)
  notify()
  return () => {
    if (adapters.get(conversationId) !== adapter) return
    adapters.delete(conversationId)
    notify()
  }
}

export function talkSendAdapter(
  conversationId: number
): TalkSendAdapter | null {
  return adapters.get(conversationId) ?? null
}

/** Told whenever a registration comes or goes. */
export function subscribeTalkSendAdapters(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** What a tab's spoken sends are made of (its own send machinery). */
export interface SpokenSenderDeps {
  /** The tab's connection now. */
  connection(): { status: string; nativeSteering: boolean } | undefined
  /** Messages can go into the running turn on this session (the
   *  live-feedback channel is up). */
  steerAvailable(): boolean
  /** The tab's `handleSend` for a spoken draft: out now, or queued. */
  send(
    draft: PromptDraft,
    opts: { clientMessageId?: string }
  ): "sent" | "queued"
  /** Into the running turn (`useSessionFeedback.steer`), marked spoken. */
  steer(text: string, clientId: string): Promise<unknown>
  /** Into the queue (spoken is added). */
  enqueue(draft: PromptDraft, opts: RequeueOptions): void
  newClientId(): string
  isNoActiveTurn(error: unknown): boolean
  failure(error: unknown): SendFailure
}

/**
 * `sendSpoken` over a tab's machinery, as the iPhone does it: idle, a prompt
 * (or the queue when the tab can't send yet); in a turn that takes a message
 * now (native steering), an insert — the turn having just ended, the same
 * words as the next prompt; otherwise the queue, until the turn ends.
 */
export function spokenSender(
  deps: SpokenSenderDeps
): (text: string) => Promise<SpokenSendRoute> {
  return async (raw) => {
    const text = raw.trim()
    if (!text) return "queued"
    const draft: PromptDraft = {
      blocks: [{ type: "text", text }],
      displayText: text,
    }
    const conn = deps.connection()
    if (conn?.status !== "prompting") {
      return deps.send(draft, {}) === "sent" ? "prompt" : "queued"
    }
    if (conn.nativeSteering && deps.steerAvailable()) {
      const clientId = deps.newClientId()
      try {
        await deps.steer(text, clientId)
        return "insert"
      } catch (error) {
        if (deps.isNoActiveTurn(error)) {
          return deps.send(draft, { clientMessageId: clientId }) === "sent"
            ? "prompt"
            : "queued"
        }
        deps.enqueue(draft, {
          clientMessageId: clientId,
          spoken: true,
          holdUntilTurnEnd: true,
          failure: deps.failure(error),
        })
        return "queued"
      }
    }
    deps.enqueue(draft, { spoken: true })
    return "queued"
  }
}
