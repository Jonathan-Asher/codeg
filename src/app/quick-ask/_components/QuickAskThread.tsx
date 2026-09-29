"use client"

/**
 * The question-and-answer thread of the Quick Ask window, drawn with the app's
 * own message renderer (`CompletedTurnContent` over `ContentPartsRenderer`) in
 * a compact column. A reply's tool calls and reasoning sit folded under its
 * "Worked for …" header; the answer text stays in view.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { useTranslations } from "next-intl"
import { AlertCircle, Clock, CornerDownRight } from "lucide-react"

import {
  useConnectionStore,
  type LiveMessage,
} from "@/contexts/acp-connections-context"
import {
  MessageThread,
  MessageThreadContent,
  MessageThreadScrollButton,
} from "@/components/ai-elements/message-thread"
import { CompletedTurnContent } from "@/components/message/completed-turn-content"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"
import { cn } from "@/lib/utils"
import type {
  QuickAskTurn,
  QuickAskUserTurnState,
} from "../_hooks/use-quick-ask-session"

/** The reply's content parts, every assistant round merged into one. */
export function useReplyParts(
  message: LiveMessage | null,
  streaming: boolean
): AdaptedContentPart[] {
  const sharedT = useTranslations("Folder.chat.shared")
  const pageHandoffName = usePageHandoffName()
  const adapterText = useMemo(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
      pageHandoffName,
    }),
    [sharedT, pageHandoffName]
  )
  return useMemo(() => {
    if (!message) return []
    const built = buildStreamingTurnsFromLiveMessage(0, message)
    const parts: AdaptedContentPart[] = []
    for (const turn of built.turns) {
      // A message steered into the reply is already shown as the user's own
      // bubble in the thread.
      if (turn.role === "user") continue
      const adapted = adaptMessageTurn(
        turn,
        adapterText,
        streaming,
        built.inProgressToolCallIds
      )
      parts.push(...adapted.content)
    }
    return parts
  }, [message, streaming, adapterText])
}

const AssistantReply = memo(function AssistantReply({
  message,
  streaming,
  durationMs = null,
}: {
  message: LiveMessage
  streaming: boolean
  durationMs?: number | null
}) {
  const parts = useReplyParts(message, streaming)
  // Folded by default: a quick answer is about the answer, not the work.
  const [workOpen, setWorkOpen] = useState(false)
  if (parts.length === 0 && !streaming) return null
  return (
    <div className="quick-ask-reply min-w-0 text-sm" data-testid="qa-reply">
      <CompletedTurnContent
        parts={parts}
        durationMs={durationMs}
        completed={!streaming}
        currentRound
        roundOpen={workOpen}
        onRoundOpenChange={setWorkOpen}
      />
    </div>
  )
})

/** The reply being written right now, read straight from the connection. */
function LiveReply({ contextKey }: { contextKey: string }) {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeKey(contextKey, cb),
    [store, contextKey]
  )
  const getSnapshot = useCallback(
    () => store.getConnection(contextKey)?.liveMessage ?? null,
    [store, contextKey]
  )
  const message = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!message) return null
  return <AssistantReply message={message} streaming />
}

const STATE_LABEL_KEYS = {
  queued: "status.queued",
  steered: "status.steered",
  failed: "status.failed",
} as const satisfies Record<Exclude<QuickAskUserTurnState, "sent">, string>

function UserBubble({
  text,
  state,
}: {
  text: string
  state: QuickAskUserTurnState
}) {
  const t = useTranslations("QuickAsk")
  return (
    <div className="flex flex-col items-end gap-1" data-testid="qa-question">
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-1.5 text-sm",
          state === "queued" && "opacity-60",
          state === "failed" && "ring-1 ring-destructive/50"
        )}
      >
        {text}
      </div>
      {state !== "sent" && (
        <div
          className={cn(
            "flex items-center gap-1 text-[11px] text-muted-foreground",
            state === "failed" && "text-destructive"
          )}
        >
          {state === "queued" && <Clock className="size-3" />}
          {state === "steered" && <CornerDownRight className="size-3" />}
          {state === "failed" && <AlertCircle className="size-3" />}
          {t(STATE_LABEL_KEYS[state])}
        </div>
      )}
    </div>
  )
}

export function QuickAskThread({
  contextKey,
  thread,
  streaming,
  footer,
}: {
  /** The connection the live reply streams from. */
  contextKey: string
  thread: QuickAskTurn[]
  /** A reply is being written (render it live under the thread). */
  streaming: boolean
  footer?: React.ReactNode
}) {
  // A new question always brings the bottom back into view.
  let lastUserId: string | undefined
  for (const turn of thread) if (turn.role === "user") lastUserId = turn.id

  // The app's own stick-to-bottom thread: follows a reply as it grows unless
  // the reader scrolled up, and offers the jump-to-bottom button then.
  return (
    <MessageThread className="min-h-0 flex-1" data-testid="qa-thread">
      <ScrollToBottomOn signal={lastUserId} />
      <MessageThreadContent className="gap-3 px-4 py-3">
        {thread.map((turn) =>
          turn.role === "user" ? (
            <UserBubble key={turn.id} text={turn.text} state={turn.state} />
          ) : (
            <AssistantReply
              key={turn.id}
              message={turn.message}
              durationMs={turn.durationMs}
              streaming={false}
            />
          )
        )}
        {streaming && <LiveReply contextKey={contextKey} />}
        {footer}
      </MessageThreadContent>
      <MessageThreadScrollButton className="bottom-2 size-7" />
    </MessageThread>
  )
}

/** Scroll to the bottom whenever `signal` changes (a new question). */
function ScrollToBottomOn({ signal }: { signal: string | undefined }) {
  const { scrollToBottom } = useStickToBottomContext()
  useEffect(() => {
    if (signal) void scrollToBottom("instant")
  }, [signal, scrollToBottom])
  return null
}
