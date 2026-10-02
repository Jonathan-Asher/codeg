"use client"

/**
 * "Continue automatically when the usage limit resets" — the settings half of
 * the continuation after the account's usage limit
 * (`src-tauri/src/acp/limit_continue.rs`). Stored per data directory by the
 * backend that owns the sessions, so it works the same from the desktop app
 * and from a browser pointed at a server. Turning it off ends every pause
 * waiting for its reset.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Hourglass } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  getLimitContinueSettings,
  updateLimitContinueSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function LimitContinueSettingsSection() {
  const t = useTranslations("LimitContinueSettings")
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getLimitContinueSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.enabled)
      })
      .catch((err) => {
        console.error("[Settings] load usage-limit settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: boolean, prev: boolean) => {
      setSaving(true)
      try {
        const result = await updateLimitContinueSettings({ enabled: next })
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
      icon={Hourglass}
      title={t("title")}
      description={t("description")}
      htmlFor="limit-continue"
      control={
        <Switch
          id="limit-continue"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => {
            const prev = enabled
            setEnabled(next)
            void save(next, prev)
          }}
        />
      }
    />
  )
}
