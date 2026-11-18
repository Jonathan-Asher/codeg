"use client"

import { useTranslations } from "next-intl"
import { BotIcon, ChevronRight, Loader2 } from "lucide-react"

import type { TabItem } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { showSubagentParent } from "./show-subagent-parent"

/**
 * The title bar over a sub-agent's tab, where a session tab has its own:
 * the session it belongs to (a link back to its Agent card), then what the
 * sub-agent was asked to do and its type.
 */
export function SubagentTabHeader({ tab }: { tab: TabItem }) {
  const t = useTranslations("Folder.subagentTab")
  const target = tab.subagent
  const parentTitle = useAppWorkspaceStore((s) =>
    target
      ? (s.conversations.find((c) => c.id === target.parentConversationId)
          ?.title ?? null)
      : null
  )
  if (!target) return null
  const parent = parentTitle?.trim() || t("untitledParent")
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <button
          type="button"
          onClick={() => showSubagentParent(target, tab.folderId)}
          title={t("backToParent", { parent })}
          className="min-w-0 max-w-[40%] shrink truncate text-muted-foreground hover:text-foreground"
          dir="auto"
        >
          {parent}
        </button>
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
        />
        <BotIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span
          className="min-w-0 max-w-max flex-1 truncate text-foreground/90"
          title={tab.title}
          dir="auto"
        >
          {tab.title || t("fallbackTitle")}
        </span>
        {target.subagentType ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
            {target.subagentType}
          </span>
        ) : null}
        {tab.status === "in_progress" ? (
          <Loader2
            aria-label={t("running")}
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        ) : null}
      </div>
    </div>
  )
}
