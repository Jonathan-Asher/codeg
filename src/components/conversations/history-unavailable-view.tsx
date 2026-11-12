"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { History, Loader2, Plus } from "lucide-react"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getConversationSavedTurns } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { HistoryUnavailable, SavedTurn } from "@/lib/types"

type SavedState =
  | { phase: "loading" }
  | { phase: "loaded"; turns: SavedTurn[] }
  | { phase: "failed"; message: string }

/**
 * A session whose agent no longer has its history (the transcript file is
 * gone — Claude Code, for one, deletes sessions past an age): it cannot be
 * resumed or forked, so instead of a load error it opens read-only. It says
 * why, shows what codeg's message search kept of it — text only, labelled as
 * the partial copy it is — and offers to carry that text into a new session.
 *
 * Nothing here connects the agent: the panel holds its auto-connect back while
 * this is shown, and the action only opens a new draft with the text in its
 * composer, for the person to send when they choose.
 */
export function HistoryUnavailableView({
  conversationId,
  info,
  agentLabel,
  onStartNew,
  starting = false,
}: {
  conversationId: number
  info: HistoryUnavailable
  agentLabel: string
  /** Start a new session from the saved text; absent when this view cannot
   *  open one (no folder to open it in). */
  onStartNew?: () => void
  starting?: boolean
}) {
  const t = useTranslations("Folder.chat.historyUnavailable")
  const nothingSaved = info.saved_turns <= 0
  // Keyed by conversation: a tab re-pointed at another session (a fork, a
  // move) starts over rather than showing the previous one's text.
  const [saved, setSaved] = useState<{ id: number; state: SavedState }>(() => ({
    id: conversationId,
    state: nothingSaved ? { phase: "loaded", turns: [] } : { phase: "loading" },
  }))
  const state: SavedState =
    saved.id === conversationId
      ? saved.state
      : nothingSaved
        ? { phase: "loaded", turns: [] }
        : { phase: "loading" }

  useEffect(() => {
    if (nothingSaved) return
    let cancelled = false
    getConversationSavedTurns(conversationId).then(
      (turns) => {
        if (!cancelled) {
          setSaved({ id: conversationId, state: { phase: "loaded", turns } })
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setSaved({
            id: conversationId,
            state: { phase: "failed", message: toErrorMessage(err) },
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [conversationId, nothingSaved])

  const reason =
    info.reason === "agent_cleanup" && info.retention_days
      ? t("reasonAgentCleanup", {
          agent: agentLabel,
          days: info.retention_days,
        })
      : t("reasonMissing")

  const turns = state.phase === "loaded" ? state.turns : []

  return (
    <ScrollArea
      className="relative isolate h-full min-h-0"
      x="hidden"
      y="scroll"
    >
      <div className="mx-auto flex w-full max-w-(--session-column-max-width) flex-col gap-4 px-4 py-4">
        <section
          role="status"
          aria-labelledby={`history-unavailable-${conversationId}`}
          className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm"
        >
          <h2
            id={`history-unavailable-${conversationId}`}
            className="flex items-center gap-2 font-medium"
          >
            <History aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("title")}
          </h2>
          <p className="text-muted-foreground">{reason}</p>
          <p className="text-muted-foreground">{t("consequence")}</p>
          {onStartNew && (
            <div className="space-y-1.5 pt-1">
              <Button size="sm" onClick={onStartNew} disabled={starting}>
                {starting ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                {t("startNew")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {nothingSaved
                  ? t("startNewHintNothingSaved", { agent: agentLabel })
                  : t("startNewHint", { agent: agentLabel })}
              </p>
            </div>
          )}
        </section>

        <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("savedCopyLabel", { count: info.saved_turns })}
        </div>

        {state.phase === "loading" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("loadingSaved")}
          </p>
        ) : state.phase === "failed" ? (
          <p role="alert" className="text-xs text-destructive">
            {t("loadFailed", { message: state.message })}
          </p>
        ) : turns.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("nothingSaved")}</p>
        ) : (
          <ol aria-label={t("savedCopyAria")} className="flex flex-col gap-4">
            {turns.map((turn) => (
              <li key={turn.turn_idx}>
                <Message
                  from={turn.role === "user" ? "user" : "assistant"}
                  aria-label={
                    turn.role === "user"
                      ? t("roleUser")
                      : turn.role === "system"
                        ? t("roleSystem")
                        : agentLabel
                  }
                >
                  <MessageContent>
                    {turn.role === "user" ? (
                      <p className="whitespace-pre-wrap break-words">
                        {turn.content}
                      </p>
                    ) : (
                      <MessageResponse>{turn.content}</MessageResponse>
                    )}
                  </MessageContent>
                </Message>
              </li>
            ))}
          </ol>
        )}
      </div>
    </ScrollArea>
  )
}
