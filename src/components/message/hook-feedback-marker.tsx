"use client"

import { memo, useState } from "react"
import { ChevronRightIcon, CornerDownRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { AdaptedHookFeedbackPart } from "@/lib/adapters/ai-elements-adapter"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"

/** The first non-blank line of a hook's feedback: what the marker shows. */
export function hookFeedbackHeadline(feedback: string): string {
  for (const line of feedback.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ""
}

/**
 * Where a hook kept the agent from stopping: "Stop hook: <first line of its
 * feedback>", expandable to the whole feedback. It sits between the answer the
 * agent had finished and its reply to the hook, so the reader can tell the
 * two apart and see why the turn went on.
 */
export const HookFeedbackMarker = memo(function HookFeedbackMarker({
  part,
}: {
  part: AdaptedHookFeedbackPart
}) {
  const t = useTranslations("Folder.chat.messageList")
  const [open, setOpen] = useState(false)
  const headline = hookFeedbackHeadline(part.feedback)
  const label = t("hookFeedback", { event: part.event })

  return (
    <Collapsible className="w-full" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={headline.length === 0}
        title={headline || undefined}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <CornerDownRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 opacity-60"
        />
        <span className="shrink-0 font-medium">
          {headline ? `${label}:` : label}
        </span>
        {headline && <span className="min-w-0 truncate">{headline}</span>}
        {headline && (
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-90"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full outline-none">
        <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {part.feedback}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
