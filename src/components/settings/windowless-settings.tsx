"use client"

/**
 * "Run without a window" — the settings half of windowless mode
 * (`src-tauri/crates/codeg-lib/src/windowless.rs`): the macOS app keeps every
 * service running with no window at all, for an always-on Mac that other
 * devices reach through the web service.
 *
 * Whichever codeg the transport reaches answers, so a remote workspace shows
 * the switch of the machine it is connected to — which is how a Mac nobody
 * sits at gets switched. Hidden where the backend says it does nothing
 * (codeg-server, Windows, Linux) or does not know the setting at all.
 *
 * The switch takes effect the next time that codeg starts; the notes under it
 * say when the running one differs, and why.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MonitorOff } from "lucide-react"
import { toast } from "sonner"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { getWindowlessSettings, updateWindowlessSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { WindowlessSettingsView } from "@/lib/types"

export function WindowlessSettingsSection() {
  const t = useTranslations("WindowlessSettings")
  const [view, setView] = useState<WindowlessSettingsView | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getWindowlessSettings()
      .then((settings) => {
        if (!cancelled) setView(settings)
      })
      .catch((err) => {
        // An older backend without the setting: nothing to offer.
        console.error("[Settings] load windowless settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (enabled: boolean, prev: WindowlessSettingsView) => {
      setSaving(true)
      try {
        setView(await updateWindowlessSettings(enabled))
      } catch (err) {
        setView(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until the stored value is known: a switch shown in a guessed
  // position invites the user to "confirm" a state they never chose.
  if (view === null || !view.supported) return null

  const notes: string[] = []
  if (view.source === "flag") {
    notes.push(t("setByFlag"))
  } else if (view.source === "env") {
    notes.push(t(view.active ? "setByEnvOn" : "setByEnvOff"))
  } else if (view.enabled && !view.active) {
    notes.push(t("pendingOn"))
  } else if (!view.enabled && view.active) {
    notes.push(t("pendingOff"))
  } else if (view.active) {
    notes.push(t("activeNow"))
  }

  return (
    <SettingsSection
      icon={MonitorOff}
      title={t("title")}
      description={t("description")}
      htmlFor="run-without-window"
      control={
        <Switch
          id="run-without-window"
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={(enabled) => {
            const prev = view
            setView({ ...view, enabled })
            void save(enabled, prev)
          }}
        />
      }
    >
      {notes.length > 0 || (view.enabled && !view.web_service_auto_start) ? (
        <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {view.enabled && !view.web_service_auto_start ? (
            <p className="text-destructive" role="alert">
              {t("webServiceOff")}
            </p>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}
