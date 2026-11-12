"use client"

/**
 * "Claude prompt suggestions" — whether Claude Code predicts the next prompt
 * after each turn, shown as ghost text in the empty composer (backend
 * `acp::prompt_suggestions`). Each prediction is one more request with the
 * session's whole context, so it can be turned off. Stored per data directory
 * by the backend that runs the sessions, and read when a session connects:
 * a running session keeps what it started with until its next connect.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Lightbulb } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  getPromptSuggestionSettings,
  getPromptSuggestionStats,
  updatePromptSuggestionSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PromptSuggestionStats } from "@/lib/types"

export function PromptSuggestionSettingsSection() {
  const t = useTranslations("PromptSuggestionSettings")
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [stats, setStats] = useState<PromptSuggestionStats | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPromptSuggestionSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.enabled)
      })
      .catch((err) => {
        console.error("[Settings] load prompt suggestion settings failed:", err)
      })
    getPromptSuggestionStats()
      .then((next) => {
        if (!cancelled) setStats(next)
      })
      .catch(() => {
        // An older server has no counters; the section works without them.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: boolean, prev: boolean) => {
      setSaving(true)
      try {
        const result = await updatePromptSuggestionSettings({ enabled: next })
        setEnabled(result.enabled)
      } catch (err) {
        setEnabled(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until the stored value is known: a switch shown in a guessed
  // position invites the user to "confirm" a state they never chose.
  if (enabled === null) return null

  return (
    <SettingsSection
      icon={Lightbulb}
      title={t("title")}
      description={t("description")}
      htmlFor="prompt-suggestions"
      control={
        <Switch
          id="prompt-suggestions"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => {
            const prev = enabled
            setEnabled(next)
            void save(next, prev)
          }}
        />
      }
    >
      <p className="text-xs text-muted-foreground">{t("appliesNextConnect")}</p>
      {stats && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="prompt-suggestion-stats"
        >
          {t("stats", {
            received: stats.received,
            shown: stats.shown,
            accepted: stats.accepted,
          })}
        </p>
      )}
    </SettingsSection>
  )
}
