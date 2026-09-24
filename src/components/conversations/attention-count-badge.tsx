"use client"

import { BellRing } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Folder / group header chip: how many sessions under it are blocked waiting
 * on the user (permission, question, plan approval). Rose, and with a bell, so
 * it never reads as the amber "running" count beside it. Zero renders nothing
 * — like the running chip, it exists to flag what a collapsed header hides.
 */
export function AttentionCountBadge({
  count,
  label,
}: {
  count: number
  /** Localized "N sessions waiting for you" — tooltip and screen-reader text. */
  label: string
}) {
  if (count <= 0) return null
  return (
    <span
      title={label}
      data-testid="attention-count-badge"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-[0.125rem]",
        "h-[0.9375rem] min-w-[1rem] rounded-[0.3125rem] px-[0.25rem]",
        "text-[0.625rem] font-semibold leading-none tabular-nums",
        "bg-rose-500/12 text-rose-700",
        "dark:bg-rose-400/15 dark:text-rose-300"
      )}
    >
      <BellRing className="h-[0.5625rem] w-[0.5625rem]" aria-hidden />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
