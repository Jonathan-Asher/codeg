"use client"

/**
 * Where the agent started a run by itself.
 *
 * Pi goes idle when its reply ends, but a notice can wake it later — a
 * sub-agent asking a question or finishing, a background job ending — and it
 * then carries on with no message from the user. The parser marks the first
 * reply of such a run (`_meta["codeg.agentWake"]` on a System turn,
 * `parsers/pi/fold.rs`); this draws it as a divider between the two replies,
 * so the second does not read as an answer to the user and the first keeps its
 * own "worked for" fold. The notices that woke it are one click away.
 */

import { memo } from "react"
import { BellRing } from "lucide-react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  parseAgentWake,
  type AgentWake,
  type AgentWakeKind,
} from "@/lib/agent-run-meta"

import { ModelNotesToggle } from "./model-notes-toggle"

/** The wake marker among a System group's parts, or `null`. */
export function agentWakeFromParts(
  parts: AdaptedContentPart[]
): AgentWake | null {
  for (const part of parts) {
    if (part.type !== "tool-call") continue
    const wake = parseAgentWake(part.meta)
    if (wake) return wake
  }
  return null
}

const REASON_KEYS = {
  subagentQuestion: "wokenByQuestion",
  subagentSettled: "wokenBySettled",
  subagentAttention: "wokenByAttention",
  jobExit: "wokenByJob",
  extension: "wokenByExtension",
} as const satisfies Record<AgentWakeKind, string>

export const AgentWakeDivider = memo(function AgentWakeDivider({
  wake,
}: {
  wake: AgentWake
}) {
  const t = useTranslations("Folder.chat.messageList.agentWake")
  const first = wake.triggers[0]
  const reason = t(REASON_KEYS[first.kind])
  const extra = wake.triggers.length - 1
  const label = [
    t("continued"),
    extra > 0 ? t("andMore", { reason, count: extra }) : reason,
  ].join(" · ")
  const notes = wake.triggers
    .filter((trigger) => trigger.text.trim().length > 0)
    .map((trigger) => ({ kind: trigger.kind, text: trigger.text }))

  return (
    <div data-testid="agent-wake-divider" className="w-full space-y-1.5">
      <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
        <div aria-hidden className="h-px flex-1 bg-border" />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <BellRing aria-hidden className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{label}</span>
        </span>
        <div aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {notes.length > 0 && <ModelNotesToggle notes={notes} align="center" />}
    </div>
  )
})
