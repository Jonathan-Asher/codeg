"use client"

import type { ReactNode } from "react"
import type { ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"

type ConversationStatusDotSize = "xs" | "sm" | "md"

/** Live work the review status can't show: the agent running a turn of its
 *  own (`working`), or idle while background tasks run (`background`). */
export type ConversationStatusDotActivity = "working" | "background"

interface ConversationStatusDotProps {
  status?: ConversationStatus | null
  size?: ConversationStatusDotSize
  className?: string
  title?: string
  children?: ReactNode
  /** Overlay live activity on the review-status dot: `working` paints it the
   *  running colour and pulses it, `background` keeps the status colour and
   *  adds a slow-pulsing sky ring — quieter, like the sidebar's background
   *  glyph. */
  activity?: ConversationStatusDotActivity | null
}

const SIZE_CLASS: Record<ConversationStatusDotSize, string> = {
  xs: "h-1 w-1",
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
}

const FALLBACK_COLOR = "bg-gray-400 dark:bg-gray-500"

export function ConversationStatusDot({
  status,
  size = "md",
  className,
  title,
  children,
  activity,
}: ConversationStatusDotProps) {
  const shown = activity === "working" ? "in_progress" : status
  const colorClass = (shown && STATUS_COLORS[shown]) || FALLBACK_COLOR
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        SIZE_CLASS[size],
        colorClass,
        activity === "working" && "animate-pulse",
        activity === "background" &&
          "animate-pulse ring-[1.5px] ring-sky-500/80 ring-offset-1 ring-offset-background dark:ring-sky-400/80",
        className
      )}
      title={title}
      aria-hidden={title ? undefined : true}
      data-activity={activity ?? undefined}
    >
      {children}
    </span>
  )
}
