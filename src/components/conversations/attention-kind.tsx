"use client"

import {
  ClipboardCheck,
  MessageCircleQuestion,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react"
import type { AttentionKind } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * How each "waiting on you" kind looks wherever a session shows it — its
 * sidebar row, its tab: an icon and a colour of its own, none of them the
 * amber of "running", so a session blocked on the user never reads as one
 * that is merely busy.
 */
export interface AttentionKindVisual {
  icon: LucideIcon
  /** `Folder.sidebar` message key: tooltip and screen-reader text. */
  label: "attentionPermission" | "attentionQuestion" | "attentionPlanApproval"
  /** The icon's colour. */
  iconClass: string
  /** The small left-edge dot's colour. */
  dotClass: string
  /** The pill behind the icon. */
  pillClass: string
}

export const ATTENTION_KIND_VISUAL: Record<AttentionKind, AttentionKindVisual> =
  {
    permission: {
      icon: ShieldAlert,
      label: "attentionPermission",
      iconClass: "text-rose-600 dark:text-rose-400",
      dotClass: "bg-rose-500 dark:bg-rose-400",
      pillClass: "bg-rose-500/12 ring-rose-500/35 dark:bg-rose-400/15",
    },
    question: {
      icon: MessageCircleQuestion,
      label: "attentionQuestion",
      iconClass: "text-violet-600 dark:text-violet-400",
      dotClass: "bg-violet-500 dark:bg-violet-400",
      pillClass: "bg-violet-500/12 ring-violet-500/35 dark:bg-violet-400/15",
    },
    plan_approval: {
      icon: ClipboardCheck,
      label: "attentionPlanApproval",
      iconClass: "text-teal-600 dark:text-teal-400",
      dotClass: "bg-teal-500 dark:bg-teal-400",
      pillClass: "bg-teal-500/12 ring-teal-500/35 dark:bg-teal-400/15",
    },
  }

/**
 * The "needs you" mark: the kind's icon on a tinted pill. `label` is the
 * localized kind text (tooltip and screen-reader text). Static on purpose —
 * the row's left-edge dot is what pulses.
 */
export function AttentionKindBadge({
  kind,
  label,
  testId,
  className,
}: {
  kind: AttentionKind
  label: string
  testId: string
  className?: string
}) {
  const visual = ATTENTION_KIND_VISUAL[kind]
  const Icon = visual.icon
  return (
    <span
      title={label}
      data-testid={testId}
      data-attention={kind}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full p-[0.1875rem] ring-1",
        visual.pillClass,
        className
      )}
    >
      <Icon className={cn("h-3 w-3", visual.iconClass)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  )
}
