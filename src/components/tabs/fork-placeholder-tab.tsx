"use client"

import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * Where a fork into a new conversation is about to open: an inactive-looking
 * tab with a spinner and "Forking…", standing right after the tab the fork was
 * taken from until the forked conversation's tab takes its place (see
 * `stores/fork-placeholder-store`). Not a tab of the strip — no click, no
 * drag, no menu, and it never takes focus.
 */
export function ForkPlaceholderTab({
  adjacentActive,
}: {
  /** As `TabItem`'s: a neighbour of the active tab insets its baseline. */
  adjacentActive?: "before" | "after"
}) {
  const t = useTranslations("Folder.tabs")
  return (
    <div
      data-fork-placeholder
      data-adjacent-active={adjacentActive}
      className="browser-tab-item min-w-28 shrink grow-0 basis-48"
    >
      <span aria-hidden className="browser-tab-seat" />
      <div
        role="tab"
        aria-selected={false}
        aria-disabled
        aria-busy
        title={t("forking")}
        className="browser-tab-content ws-strip-line relative isolate flex h-full w-full min-w-0 cursor-progress select-none items-center gap-1.5 overflow-hidden rounded-t-lg px-2 pb-1.5 text-xs text-muted-foreground"
      >
        <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" />
        <span className="browser-tab-label min-w-0 flex-1 overflow-hidden whitespace-nowrap [font-style:oblique]">
          {t("forking")}
        </span>
      </div>
    </div>
  )
}
