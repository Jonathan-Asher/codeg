"use client"

/**
 * Session Details' "Usage limit" section: the per-session switch for the
 * continuation after the account's usage limit resets
 * (`lib/limit-continue.ts`). The global setting in General has to be on too.
 * Turning it off while the session is paused ends the pause (the turn is left
 * interrupted, with the manual Continue).
 */

import { useState } from "react"
import { Hourglass } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { updateConversationLimitAutoContinue } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** Flip the switch optimistically; the backend's upsert confirms it (and
 *  clears the pause it ended), a failure puts the old value back. */
export async function setConversationLimitAutoContinue(
  conversationId: number,
  enabled: boolean
): Promise<void> {
  const store = useAppWorkspaceStore.getState()
  const prev = store.conversations.find((c) => c.id === conversationId)
  store.updateConversationLocal(conversationId, {
    limit_auto_continue: enabled,
  })
  try {
    await updateConversationLimitAutoContinue(conversationId, enabled)
  } catch (err) {
    if (prev) {
      useAppWorkspaceStore.getState().updateConversationLocal(conversationId, {
        limit_auto_continue: prev.limit_auto_continue ?? true,
      })
    }
    throw err
  }
}

export function LimitContinueSessionSection({
  summary,
}: {
  summary: Pick<
    DbConversationSummary,
    "id" | "limit_auto_continue" | "parent_id"
  >
}) {
  const t = useTranslations("LimitContinueSession")
  const [saving, setSaving] = useState(false)
  // The workspace row is the live one; the summary is the fallback.
  const live = useAppWorkspaceStore((s) =>
    s.conversations.find((c) => c.id === summary.id)
  )
  const enabled = (live ?? summary).limit_auto_continue !== false

  // A delegation sub-session is driven by its parent.
  if (summary.parent_id != null) return null

  const save = (next: boolean) => {
    setSaving(true)
    setConversationLimitAutoContinue(summary.id, next)
      .catch((err) => {
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      })
      .finally(() => setSaving(false))
  }

  return (
    <section
      data-limit-continue-section
      className="min-w-0 space-y-3 border-t pt-4"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Hourglass className="h-3 w-3" aria-hidden />
        {t("heading")}
      </h3>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={`limit-continue-${summary.id}`} className="min-w-0">
          <span className="block text-sm">{t("toggle")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("toggleHint")}
          </span>
        </label>
        <Switch
          id={`limit-continue-${summary.id}`}
          checked={enabled}
          disabled={saving}
          onCheckedChange={save}
        />
      </div>
    </section>
  )
}
