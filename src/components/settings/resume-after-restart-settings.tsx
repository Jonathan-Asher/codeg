"use client"

/**
 * "Resume interrupted sessions after restart" — the settings half of the
 * automatic resume (`src-tauri/crates/codeg-lib/src/acp/auto_resume.rs`) —
 * and under it "Also resume sessions whose background work was stopped": a
 * session whose turn had ended while sub-agents, background shells or
 * monitors it started still ran. Stored per data directory by the backend
 * that owns the sessions, so it works the same from the desktop app and from a
 * browser pointed at a server.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RotateCw } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { getAutoResumeSettings, updateAutoResumeSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { AutoResumeSettings } from "@/lib/types"

/** The stored settings, with a server that predates the background switch
 *  read as it behaves: it never resumes those sessions. */
function normalized(
  settings: AutoResumeSettings
): Required<AutoResumeSettings> {
  return {
    enabled: settings.enabled,
    background: settings.background ?? false,
  }
}

export function ResumeAfterRestartSettingsSection() {
  const t = useTranslations("AutoResumeSettings")
  const [settings, setSettings] = useState<Required<AutoResumeSettings> | null>(
    null
  )
  // Whether the server knows the background switch at all: an older one
  // drops it, so there is nothing to offer.
  const [backgroundSupported, setBackgroundSupported] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getAutoResumeSettings()
      .then((stored) => {
        if (cancelled) return
        setSettings(normalized(stored))
        setBackgroundSupported(typeof stored.background === "boolean")
      })
      .catch((err) => {
        console.error("[Settings] load auto-resume settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (
      next: Required<AutoResumeSettings>,
      prev: Required<AutoResumeSettings>
    ) => {
      setSaving(true)
      try {
        const result = await updateAutoResumeSettings(next)
        setSettings(normalized(result))
      } catch (err) {
        setSettings(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until the stored value is known: a switch shown in a guessed
  // position invites the user to "confirm" a state they never chose.
  if (settings === null) return null

  const change = (patch: Partial<AutoResumeSettings>) => {
    const prev = settings
    const next = { ...settings, ...patch }
    setSettings(next)
    void save(next, prev)
  }

  return (
    <SettingsSection
      icon={RotateCw}
      title={t("title")}
      description={t("description")}
      htmlFor="resume-after-restart"
      control={
        <Switch
          id="resume-after-restart"
          checked={settings.enabled}
          disabled={saving}
          onCheckedChange={(enabled) => change({ enabled })}
        />
      }
    >
      {/* Gated by the switch above: it only means something while that one
          is on. */}
      {settings.enabled && backgroundSupported ? (
        <SettingCard>
          <SettingRow
            title={t("backgroundTitle")}
            description={t("backgroundDescription")}
            htmlFor="resume-after-restart-background"
            control={
              <Switch
                id="resume-after-restart-background"
                checked={settings.background}
                disabled={saving}
                onCheckedChange={(background) => change({ background })}
              />
            }
          />
        </SettingCard>
      ) : null}
    </SettingsSection>
  )
}
