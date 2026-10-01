"use client"

/**
 * Session Details' "Critical session" section: mark the session critical
 * (the backend then alerts when it sits idle) and, while it is, switch its
 * stall detection ("may be stuck" when a working turn goes silent).
 */

import { useState } from "react"
import { Flag } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { setConversationCritical } from "@/lib/critical-sessions"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export function CriticalSessionSection({
  summary,
}: {
  summary: Pick<
    DbConversationSummary,
    "id" | "critical" | "critical_stall" | "parent_id"
  >
}) {
  const t = useTranslations("CriticalSessions.details")
  const [saving, setSaving] = useState(false)
  // The workspace row is the live one (optimistic writes and every client's
  // changes land there); the summary is the fallback for a row not listed.
  const live = useAppWorkspaceStore((s) =>
    s.conversations.find((c) => c.id === summary.id)
  )
  const critical = (live ?? summary).critical === true
  const stall = (live ?? summary).critical_stall !== false

  // A delegation sub-session is driven by its parent, not watched on its own.
  if (summary.parent_id != null) return null

  const save = (nextCritical: boolean, nextStall?: boolean) => {
    setSaving(true)
    setConversationCritical(summary.id, nextCritical, nextStall)
      .catch((err) => {
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      })
      .finally(() => setSaving(false))
  }

  return (
    <section
      data-critical-session-section
      className="min-w-0 space-y-3 border-t pt-4"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Flag
          className={critical ? "h-3 w-3 fill-red-500 text-red-500" : "h-3 w-3"}
          aria-hidden
        />
        {t("heading")}
      </h3>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={`critical-${summary.id}`} className="min-w-0">
          <span className="block text-sm">{t("mark")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("markHint")}
          </span>
        </label>
        <Switch
          id={`critical-${summary.id}`}
          checked={critical}
          disabled={saving}
          onCheckedChange={(next) => save(next)}
        />
      </div>
      {critical && (
        <div className="flex items-start justify-between gap-3">
          <label htmlFor={`critical-stall-${summary.id}`} className="min-w-0">
            <span className="block text-sm">{t("stall")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("stallHint")}
            </span>
          </label>
          <Switch
            id={`critical-stall-${summary.id}`}
            checked={stall}
            disabled={saving}
            onCheckedChange={(next) => save(true, next)}
          />
        </div>
      )}
    </section>
  )
}
