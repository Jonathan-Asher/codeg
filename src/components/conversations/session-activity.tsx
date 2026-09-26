"use client"

import {
  CircleDot,
  CirclePause,
  Loader2,
  Play,
  ShieldAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"
import type {
  AttentionKind,
  ConnectionStatus,
  DbConversationSummary,
} from "@/lib/types"
import {
  deriveSessionActivity,
  SESSION_ACTIVITY_HINT_KEYS,
  SESSION_ACTIVITY_LABEL_KEYS,
  type SessionActivity,
} from "@/lib/session-activity"
import { continueInterruptedSession } from "@/lib/session-continue"
import { useConversationAttention } from "@/stores/conversation-attention-store"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/** The sidebar's wording for each "waiting on you" kind — reused so the
 *  Session Details view names the block exactly as the row's badge does. */
const ATTENTION_HINT_KEYS = {
  permission: "attentionPermission",
  question: "attentionQuestion",
  plan_approval: "attentionPlanApproval",
} as const satisfies Record<AttentionKind, string>

/** The glyph for each activity, in the colours the sidebar already uses for
 *  them (amber = running, rose = blocked on you). */
export function SessionActivityIcon({
  activity,
  className,
}: {
  activity: SessionActivity
  className?: string
}) {
  const base = cn("h-3.5 w-3.5 shrink-0", className)
  switch (activity) {
    case "working":
      return (
        <Loader2
          aria-hidden
          className={cn(
            base,
            "animate-spin text-amber-600 dark:text-amber-400"
          )}
        />
      )
    case "needs_you":
      return (
        <ShieldAlert
          aria-hidden
          className={cn(base, "text-rose-600 dark:text-rose-400")}
        />
      )
    case "interrupted":
      return (
        <CirclePause
          aria-hidden
          className={cn(base, "text-orange-600 dark:text-orange-400")}
        />
      )
    case "idle":
      return (
        <CircleDot
          aria-hidden
          className={cn(base, "text-muted-foreground/70")}
        />
      )
  }
}

interface SessionActivityRowProps {
  summary: DbConversationSummary
  /** This client's own live connection status for the conversation, when it
   *  holds one — see `deriveSessionActivity`. */
  connectionStatus?: ConnectionStatus | null
}

/**
 * The Session Details "Activity" line: what the session is doing right now,
 * why, and — for an interrupted turn — a one-click Continue. Reads the
 * attention store itself so every surface that shows a summary gets the same
 * answer the sidebar row does.
 */
export function SessionActivityRow({
  summary,
  connectionStatus,
}: SessionActivityRowProps) {
  const t = useTranslations("Folder.sessionActivity")
  const tSidebar = useTranslations("Folder.sidebar")
  const attention = useConversationAttention(summary.id)
  const activity = deriveSessionActivity({
    attention,
    turnState: summary.turn_state,
    status: summary.status,
    connectionStatus,
  })
  const hint =
    activity === "needs_you" && attention
      ? tSidebar(ATTENTION_HINT_KEYS[attention])
      : t(SESSION_ACTIVITY_HINT_KEYS[activity])

  return (
    <div
      className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2"
      data-testid="session-activity"
      data-activity={activity}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <SessionActivityIcon activity={activity} className="mt-0.5" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium leading-snug">
            {t(SESSION_ACTIVITY_LABEL_KEYS[activity])}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
        </div>
      </div>
      {activity === "interrupted" && (
        <Button
          size="xs"
          variant="outline"
          title={t("continueTitle")}
          onClick={() => continueInterruptedSession(summary)}
        >
          <Play aria-hidden />
          {t("continue")}
        </Button>
      )}
    </div>
  )
}
