"use client"

/**
 * "Waiting for you (N)": a compact button in the sidebar header while
 * anything waits on the user — a permission, a question, a plan to approve,
 * in any session (a delegated sub-agent's included). It opens the list, each
 * item with how long it has waited; a click goes to the session, where the
 * card waiting for the answer sits above the composer.
 *
 * The list is the backend's (`src-tauri/src/pending`, kept in step by
 * `PendingItemsBridge`); the iPhone and the dock show the same count.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BellRing,
  ClipboardCheck,
  MessageCircleQuestion,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { openNotificationTargetFromClick } from "@/lib/notification-target"
import {
  pendingItemTarget,
  secondsSince,
  waitedDuration,
} from "@/lib/pending-items"
import type { PendingItem, PendingKind } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePendingItemsStore } from "@/stores/pending-items-store"

/** How often the ages catch up while the list is open. */
const AGE_REFRESH_MS = 30_000

const KIND_ICONS: Record<PendingKind, LucideIcon> = {
  permission: ShieldQuestion,
  question: MessageCircleQuestion,
  plan: ClipboardCheck,
}

function PendingItemRow({
  item,
  now,
  onOpen,
}: {
  item: PendingItem
  now: number
  onOpen: (item: PendingItem) => void
}) {
  const t = useTranslations("PendingItems")
  const liveTitle = useAppWorkspaceStore(
    (s) =>
      s.conversations.find((c) => c.id === item.root_conversation_id)?.title
  )
  const title = liveTitle?.trim() || item.title?.trim() || t("untitled")
  const { unit, count } = waitedDuration(secondsSince(item.asked_at, now))
  const Icon = KIND_ICONS[item.kind]
  return (
    <li>
      <button
        type="button"
        data-pending-item={item.id}
        onClick={() => onOpen(item)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <Icon
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-medium">{title}</span>
            <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
              {t("waiting", { elapsed: t(`duration.${unit}`, { count }) })}
            </span>
          </span>
          <span className="truncate text-[0.6875rem] text-muted-foreground">
            {t(`kind.${item.kind}`)} · {item.agent_label}
            {item.reminders_sent > 0 &&
              ` · ${t("reminders", { count: item.reminders_sent })}`}
          </span>
          {item.text.trim() && (
            <span className="line-clamp-2 text-[0.6875rem] text-foreground/80">
              {item.text}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

export function PendingItemsIndicator({ className }: { className?: string }) {
  const t = useTranslations("PendingItems")
  const items = usePendingItemsStore((s) => s.items)
  const count = usePendingItemsStore((s) => s.count)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [open])

  // Nothing left to show: a list left open closes with it, and does not
  // spring open again with the next item.
  if (count === 0 && open) setOpen(false)
  if (count === 0) return null

  const onOpenChange = (next: boolean) => {
    if (next) setNow(Date.now())
    setOpen(next)
  }

  const label = t("indicator", { count })
  const openItem = (item: PendingItem) => {
    setOpen(false)
    openNotificationTargetFromClick(pendingItemTarget(item))
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-pending-indicator
          className={cn(
            "h-6 shrink-0 gap-1 rounded-md px-1.5 text-xs font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300",
            className
          )}
          title={label}
          aria-label={label}
        >
          <BellRing aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="hidden @[17rem]/sidebar:inline">{label}</span>
          <span className="tabular-nums @[17rem]/sidebar:hidden">{count}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2 p-2">
        <div className="px-2 pt-1">
          <p className="text-sm font-semibold">{t("listTitle")}</p>
          <p className="text-[0.6875rem] text-muted-foreground">
            {t("listHint")}
          </p>
        </div>
        <ul className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
          {items.map((item) => (
            <PendingItemRow
              key={item.id}
              item={item}
              now={now}
              onOpen={openItem}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
