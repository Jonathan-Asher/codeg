"use client"

/**
 * Quick Ask: the global shortcut that opens the floating question window.
 *
 * Desktop-only, but shown in remote workspace windows too: the shortcut and
 * the window belong to the app on THIS machine, whichever window edits them.
 * That is why every call here goes to the local shell (`@/lib/quick-ask/
 * desktop` uses `getShellTransport()`), never through a remote window's own
 * transport.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Keyboard, MessageCircleQuestion } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useIsMac } from "@/hooks/use-is-mac"
import { toErrorMessage } from "@/lib/app-error"
import { setShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import { isDesktop } from "@/lib/platform"
import {
  getQuickAskSettings,
  toggleQuickAskWindow,
  updateQuickAskSettings,
  type QuickAskSettingsView,
} from "@/lib/quick-ask/desktop"
import {
  acceleratorFromEvent,
  DEFAULT_QUICK_ASK_SHORTCUT,
  formatAccelerator,
} from "@/lib/quick-ask/shortcut"
import { cn } from "@/lib/utils"

export function QuickAskSettingsSection() {
  const t = useTranslations("QuickAskSettings")
  const isMac = useIsMac()
  const supported = isDesktop()

  const [settings, setSettings] = useState<QuickAskSettingsView | null>(null)
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      try {
        const next = await getQuickAskSettings()
        if (!cancelled && next) setSettings(next)
      } catch (err) {
        console.error("[Settings] load Quick Ask failed:", err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  const save = useCallback(
    async (patch: Partial<QuickAskSettingsView>) => {
      if (!settings) return
      const next = { ...settings, ...patch }
      setSettings(next)
      setSaving(true)
      try {
        setSettings(
          await updateQuickAskSettings({
            enabled: next.enabled,
            shortcut: next.shortcut,
            hideOnBlur: next.hide_on_blur,
          })
        )
      } catch (err) {
        setSettings(settings)
        toast.error(t("saveFailed", { error: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [settings, t]
  )

  // Recording: the next key press with a modifier becomes the shortcut; Esc
  // cancels. Capture phase + the shared "recorder armed" flag keep the app's
  // own shortcuts (zoom, ⌘K…) from firing while the user presses keys.
  useEffect(() => {
    if (!recording) return
    setShortcutRecorderArmed(true)
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === "Escape") {
        setRecording(false)
        return
      }
      const accelerator = acceleratorFromEvent(event)
      if (!accelerator) return
      setRecording(false)
      void save({ shortcut: accelerator })
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      setShortcutRecorderArmed(false)
    }
  }, [recording, save])

  if (!supported || settings === null) return null

  const failed = settings.enabled && !settings.registered
  const isDefault = settings.shortcut === DEFAULT_QUICK_ASK_SHORTCUT

  return (
    <SettingsSection
      icon={MessageCircleQuestion}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          icon={Keyboard}
          title={t("enable")}
          description={t("enableDescription")}
          htmlFor="quick-ask-enabled"
          control={
            <Switch
              id="quick-ask-enabled"
              checked={settings.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => void save({ enabled })}
            />
          }
        />
        <SettingRow
          title={t("shortcut")}
          description={t("shortcutDescription")}
          control={
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || !settings.enabled}
                onClick={() => setRecording((r) => !r)}
                className={cn(
                  "h-7 min-w-24 font-mono text-xs",
                  recording && "ring-2 ring-ring"
                )}
                data-testid="quick-ask-shortcut"
              >
                {recording
                  ? t("recording")
                  : formatAccelerator(settings.shortcut, isMac)}
              </Button>
              {!isDefault && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={saving || !settings.enabled}
                  onClick={() =>
                    void save({ shortcut: DEFAULT_QUICK_ASK_SHORTCUT })
                  }
                >
                  {t("reset")}
                </Button>
              )}
            </div>
          }
        >
          {failed && (
            <div
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
              role="alert"
              data-testid="quick-ask-registration-error"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="flex flex-col gap-0.5">
                <span>
                  {t("notRegistered", {
                    shortcut: formatAccelerator(settings.shortcut, isMac),
                  })}
                </span>
                {settings.registration_error && (
                  <span className="opacity-80">
                    {t("registrationDetail", {
                      error: settings.registration_error,
                    })}
                  </span>
                )}
              </div>
            </div>
          )}
        </SettingRow>
        <SettingRow
          title={t("hideOnBlur")}
          description={t("hideOnBlurDescription")}
          htmlFor="quick-ask-hide-on-blur"
          control={
            <Switch
              id="quick-ask-hide-on-blur"
              checked={settings.hide_on_blur}
              disabled={saving}
              onCheckedChange={(hideOnBlur) =>
                void save({ hide_on_blur: hideOnBlur })
              }
            />
          }
        />
        <SettingRow
          title={t("open")}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void toggleQuickAskWindow().catch(() => {})}
            >
              {t("openButton")}
            </Button>
          }
        />
      </SettingCard>
    </SettingsSection>
  )
}
