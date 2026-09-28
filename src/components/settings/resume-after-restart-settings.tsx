"use client"

/**
 * "Resume interrupted sessions after restart" — the settings half of the
 * automatic resume (`src-tauri/src/acp/auto_resume.rs`). Stored per data
 * directory by the backend that owns the sessions, so it works the same from
 * the desktop app and from a browser pointed at a server.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RotateCw } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { getAutoResumeSettings, updateAutoResumeSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function ResumeAfterRestartSettingsSection() {
  const t = useTranslations("AutoResumeSettings")
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getAutoResumeSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.enabled)
      })
      .catch((err) => {
        console.error("[Settings] load auto-resume settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: boolean, prev: boolean) => {
      setSaving(true)
      try {
        const result = await updateAutoResumeSettings({ enabled: next })
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
      icon={RotateCw}
      title={t("title")}
      description={t("description")}
      htmlFor="resume-after-restart"
      control={
        <Switch
          id="resume-after-restart"
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
