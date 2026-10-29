"use client"

import { Clock, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import type { MessageTurn } from "@/lib/types"

/**
 * Under a message the user steered into the running reply: where it stands
 * until the agent has read it (see `MessageTurn.steer_state`). Nothing once
 * it is read: it is then an ordinary message of the turn.
 */
export function SteerStateCaption({
  state,
}: {
  state: MessageTurn["steer_state"]
}) {
  const t = useTranslations("LiveFeedback")
  if (!state) return null
  const label =
    state === "sending"
      ? t("steerSending")
      : state === "waiting_subagent"
        ? t("steerWaitingSubagent")
        : t("steerWaiting")
  return (
    <div
      className="mt-0.5 flex items-center justify-end gap-1 self-end text-xs text-muted-foreground"
      data-testid="steer-state"
      data-state={state}
      role="status"
    >
      {state === "sending" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <Clock className="size-3" aria-hidden />
      )}
      <span>{label}</span>
    </div>
  )
}
