"use client"

/**
 * "Critical sessions" — how the backend watchdog alerts on sessions marked
 * critical (`src-tauri/src/acp/critical_watch.rs`): how long idle before the
 * first alert, how often it repeats, how long a silent turn runs before
 * "may be stuck", the tone, and the chat channels.
 *
 * Stored by the backend that runs the watchdog (per data directory), so the
 * desktop app and a browser on a server edit the same settings — the ones of
 * the machine whose sessions they show.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Flag,
  Hourglass,
  MessageSquare,
  Repeat,
  TimerOff,
  Volume2,
} from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  getCriticalSessionSettings,
  listChatChannels,
  updateCriticalSessionSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  CRITICAL_IDLE_CHOICES,
  CRITICAL_REPEAT_CHOICES,
  CRITICAL_STALL_CHOICES,
  exactDuration,
} from "@/lib/critical-sessions"
import type { CriticalSessionSettings } from "@/lib/types"

type DurationField = "idle_secs" | "repeat_secs" | "stall_secs"

/** The offered choices, plus the stored value when it is not one of them. */
function choicesWith(choices: readonly number[], current: number): number[] {
  return choices.includes(current)
    ? [...choices]
    : [...choices, current].sort((a, b) => a - b)
}

export function CriticalSessionSettingsSection() {
  const t = useTranslations("CriticalSessions.settings")
  const tCritical = useTranslations("CriticalSessions")
  const [settings, setSettings] = useState<CriticalSessionSettings | null>(null)
  const [hasChannels, setHasChannels] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCriticalSessionSettings()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err) => {
        console.error("[Settings] load critical session settings failed:", err)
      })
    listChatChannels()
      .then((channels) => {
        if (!cancelled) setHasChannels(channels.length > 0)
      })
      .catch(() => {
        // No channels to offer; the switch stays hidden.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: CriticalSessionSettings, prev: CriticalSessionSettings) => {
      setSettings(next)
      try {
        setSettings(await updateCriticalSessionSettings(next))
      } catch (err) {
        setSettings(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  const durationLabel = useCallback(
    (seconds: number) => {
      if (seconds === 0) return t("repeatOff")
      const { unit, count } = exactDuration(seconds)
      return tCritical(`duration.${unit}`, { count })
    },
    [t, tCritical]
  )

  // Hidden until the stored values are known, like the other backend-stored
  // settings: a control in a guessed position invites a false "confirm".
  if (!settings) return null

  const durationSelect = (
    field: DurationField,
    choices: readonly number[],
    label: string
  ) => (
    <Select
      value={String(settings[field])}
      onValueChange={(value) =>
        void save({ ...settings, [field]: Number(value) }, settings)
      }
    >
      <SelectTrigger
        size="sm"
        className="w-32 bg-background text-xs"
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {choicesWith(choices, settings[field]).map((seconds) => (
          <SelectItem key={seconds} value={String(seconds)}>
            {durationLabel(seconds)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <SettingsSection
      icon={Flag}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          icon={Hourglass}
          title={t("idleTitle")}
          description={t("idleHint")}
          control={durationSelect(
            "idle_secs",
            CRITICAL_IDLE_CHOICES,
            t("idleTitle")
          )}
        />
        <SettingRow
          icon={Repeat}
          title={t("repeatTitle")}
          description={t("repeatHint")}
          control={durationSelect(
            "repeat_secs",
            CRITICAL_REPEAT_CHOICES,
            t("repeatTitle")
          )}
        />
        <SettingRow
          icon={TimerOff}
          title={t("stallTitle")}
          description={t("stallHint")}
          control={durationSelect(
            "stall_secs",
            CRITICAL_STALL_CHOICES,
            t("stallTitle")
          )}
        />
        <SettingRow
          icon={Volume2}
          title={t("soundTitle")}
          description={t("soundHint")}
          htmlFor="critical-session-sound"
          control={
            <Switch
              id="critical-session-sound"
              checked={settings.sound}
              onCheckedChange={(sound) =>
                void save({ ...settings, sound }, settings)
              }
            />
          }
        />
        {hasChannels && (
          <SettingRow
            icon={MessageSquare}
            title={t("channelTitle")}
            description={t("channelHint")}
            htmlFor="critical-session-channel"
            control={
              <Switch
                id="critical-session-channel"
                checked={settings.send_to_channel}
                onCheckedChange={(send_to_channel) =>
                  void save({ ...settings, send_to_channel }, settings)
                }
              />
            }
          />
        )}
      </SettingCard>
    </SettingsSection>
  )
}
