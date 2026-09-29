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
  useRef,
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
  const isQueued = (turn: QuickAskTurn) =>
    turn.role === "user" && turn.state === "queued"
  const settled = thread.filter((turn) => !isQueued(turn))
  const queued = thread.filter(isQueued)

  // A new question always brings the bottom back into view (a queued one
  // too, when it finally goes out).
  let questionSignal: string | undefined
  let replyCount = 0
  for (const turn of thread) {
    if (turn.role === "user") questionSignal = `${turn.id}:${turn.state}`
    else replyCount += 1
  }

  // The app's own stick-to-bottom thread: follows a reply as it grows unless
  // the reader scrolled up, and offers the jump-to-bottom button then.
  return (
    <MessageThread className="min-h-0 flex-1" data-testid="qa-thread">
      <FollowThread questionSignal={questionSignal} replyCount={replyCount} />
      <MessageThreadContent className="gap-3 px-4 py-3">
        {settled.map((turn) =>
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
        {/* Waiting for the reply above to end, so shown after it. */}
        {queued.map((turn) =>
          turn.role === "user" ? (
            <UserBubble key={turn.id} text={turn.text} state={turn.state} />
          ) : null
        )}
        {footer}
      </MessageThreadContent>
      <MessageThreadScrollButton className="bottom-2 size-7" />
    </MessageThread>
  )
}

/**
 * Keep the thread's end in view: always when a question goes out, and when a
 * reply settles if the reader was following it. Settling swaps the live reply
 * for the kept one, a brief layout change the stick-to-bottom tracker reads
 * as the reader scrolling away; `wasAtBottom` is read before that happens.
 */
function FollowThread({
  questionSignal,
  replyCount,
}: {
  questionSignal: string | undefined
  replyCount: number
}) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext()
  const wasAtBottom = useRef(true)
  const lastReplyCount = useRef(replyCount)

  useEffect(() => {
    if (questionSignal) void scrollToBottom("instant")
  }, [questionSignal, scrollToBottom])

  useEffect(() => {
    if (replyCount === lastReplyCount.current) return
    lastReplyCount.current = replyCount
    if (wasAtBottom.current) void scrollToBottom("instant")
  }, [replyCount, scrollToBottom])

  // Declared last: records the position the NEXT change is judged against.
  useEffect(() => {
    wasAtBottom.current = isAtBottom
  })
  return null
}
