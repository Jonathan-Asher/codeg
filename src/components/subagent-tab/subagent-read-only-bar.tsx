"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, Loader2 } from "lucide-react"

/**
 * Where a session tab has its composer, a sub-agent's tab has this line: whose
 * sub-agent it is (a link back to that session, which scrolls to the Agent
 * card), its type, and that the thread is read-only.
 */
export function SubagentReadOnlyBar({
  parentTitle,
  subagentType,
  running,
  onShowParent,
}: {
  parentTitle: string | null
  subagentType: string | null
  running: boolean
  onShowParent: () => void
}) {
  const t = useTranslations("Folder.subagentTab")
  const parent = parentTitle?.trim() || t("untitledParent")
  const link = (chunks: ReactNode) => (
    <button
      type="button"
      onClick={onShowParent}
      title={t("backToParent", { parent })}
      className="max-w-[24rem] truncate rounded-sm align-bottom text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      dir="auto"
    >
      {chunks}
    </button>
  )
  return (
    <div
      data-subagent-read-only-bar=""
      className="flex h-9 shrink-0 items-center gap-2 border-t border-border/50 px-4 text-xs text-muted-foreground"
    >
      <BotIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {subagentType
          ? t.rich("bar", { parent, type: subagentType, link })
          : t.rich("barNoType", { parent, link })}
      </span>
      {running ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          {t("running")}
        </span>
      ) : null}
    </div>
  )
}
