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
import { useTranslations } from "next-intl"
import { AlertCircle, Clock, CornerDownRight } from "lucide-react"

import {
  useConnectionStore,
  type LiveMessage,
} from "@/contexts/acp-connections-context"
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
}: {
  message: LiveMessage
  streaming: boolean
}) {
  const parts = useReplyParts(message, streaming)
  // Folded by default: a quick answer is about the answer, not the work.
  const [workOpen, setWorkOpen] = useState(false)
  if (parts.length === 0 && !streaming) return null
  return (
    <div className="quick-ask-reply min-w-0 text-sm" data-testid="qa-reply">
      <CompletedTurnContent
        parts={parts}
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // Follow the reply as it grows, unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
    })
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => {
      el.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [])

  // A new question always brings the bottom back into view.
  const lastUserId = [...thread].reverse().find((t) => t.role === "user")?.id
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !lastUserId) return
    stickRef.current = true
    el.scrollTop = el.scrollHeight
  }, [lastUserId])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      data-testid="qa-thread"
    >
      <div className="flex flex-col gap-3">
        {thread.map((turn) =>
          turn.role === "user" ? (
            <UserBubble key={turn.id} text={turn.text} state={turn.state} />
          ) : (
            <AssistantReply
              key={turn.id}
              message={turn.message}
              streaming={false}
            />
          )
        )}
        {streaming && <LiveReply contextKey={contextKey} />}
        {footer}
      </div>
    </div>
  )
}
