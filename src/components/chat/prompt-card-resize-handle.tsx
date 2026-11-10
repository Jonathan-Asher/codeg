"use client"

import { useTranslations } from "next-intl"

import type { PromptCardResizeHandleProps } from "@/hooks/use-prompt-card-resize"
import { cn } from "@/lib/utils"

/**
 * The resize handle along a docked card's edge (see `usePromptCardResize`): a
 * full-width ~10px strip with a row-resize cursor, absolutely placed so it
 * takes no room, and a small centred grip that shows on hover, focus and drag
 * — the same quiet line `GroupSplitHandle` draws between split groups. A
 * focusable window splitter: ↑/↓ resize (Shift for a bigger step), Home and
 * End go to the least and the most, a double-click goes back to the automatic
 * height. The card it sits in is `relative`.
 */
export function PromptCardResizeHandle({
  kind,
  edge,
  dragging,
  valueMin,
  valueMax,
  valueNow,
  ...handlers
}: PromptCardResizeHandleProps) {
  const t = useTranslations("Folder.chat.promptCardResize")
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t(kind)}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      title={t("hint")}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      {...handlers}
      className={cn(
        "group/resize-handle absolute inset-x-0 z-10 flex h-2.5 cursor-row-resize touch-none select-none items-center justify-center outline-none",
        edge === "top" ? "top-0" : "bottom-0"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-[3px] w-8 rounded-full bg-border opacity-0 transition-[opacity,background-color] duration-150 ease-out motion-reduce:transition-none",
          dragging
            ? "bg-foreground/60 opacity-100"
            : "group-hover/resize-handle:bg-foreground/40 group-hover/resize-handle:opacity-100 group-focus-visible/resize-handle:bg-foreground/40 group-focus-visible/resize-handle:opacity-100 group-focus-visible/resize-handle:ring-2 group-focus-visible/resize-handle:ring-ring/50"
        )}
      />
    </div>
  )
}
