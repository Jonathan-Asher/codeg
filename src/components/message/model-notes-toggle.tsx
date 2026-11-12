"use client"

/**
 * "What the model saw": the raw text a card replaced.
 *
 * When codeg folds an agent's notices into a card (a sub-agent run, a
 * background job, the start of a run the agent began by itself), the card
 * shows them as structure — a status, a row, an answer — and drops the text,
 * which was written for the model: run ids, file paths, tool-call syntax. That
 * text is still what the model acted on, so it stays one click away, verbatim,
 * collapsed by default.
 */

import { memo, useState } from "react"
import { ChevronRightIcon, Info } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import type { ModelNote } from "@/lib/agent-run-meta"
import { detectTextDirection } from "@/lib/text-direction"
import { cn } from "@/lib/utils"

type NoteLabelKey =
  | "noteLaunch"
  | "noteQuestion"
  | "noteChild"
  | "noteResult"
  | "noteAttention"
  | "noteJobExit"
  | "noteNotice"

function noteLabelKey(kind: string): NoteLabelKey {
  switch (kind) {
    case "launch":
      return "noteLaunch"
    case "question":
    case "subagentQuestion":
      return "noteQuestion"
    case "child":
      return "noteChild"
    case "result":
    case "subagentSettled":
      return "noteResult"
    case "attention":
    case "subagentAttention":
      return "noteAttention"
    case "jobExit":
      return "noteJobExit"
    default:
      return "noteNotice"
  }
}

export const ModelNotesToggle = memo(function ModelNotesToggle({
  notes,
  className,
  align = "start",
}: {
  notes: ModelNote[]
  className?: string
  /** Where the toggle sits; the text it opens always takes the full width. */
  align?: "start" | "center"
}) {
  const t = useTranslations("Folder.chat.contentParts.agentRun")
  const [open, setOpen] = useState(false)
  if (notes.length === 0) return null

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("w-full", className)}
    >
      <div className={cn("flex", align === "center" && "justify-center")}>
        <CollapsibleTrigger
          data-testid="model-notes-toggle"
          className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Info aria-hidden className="size-3.5 shrink-0" />
          {t("modelNotes")}
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-90"
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="w-full outline-none">
        <div className="mt-2 space-y-2">
          {notes.map((note, i) => (
            <div
              key={i}
              className="rounded-md border border-foreground/10 bg-muted/40 px-3 py-2"
            >
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t(noteLabelKey(note.kind))}
              </div>
              <div
                dir={detectTextDirection(note.text)}
                className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground"
              >
                {note.text}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
