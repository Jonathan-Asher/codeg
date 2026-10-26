"use client"

/**
 * "Reminders" — how the backend keeps after a question, permission or plan
 * that waits on the user (`src-tauri/src/pending`): on or off, when to remind
 * (counted from the ask), how often after that, and quiet hours.
 *
 * Stored by the backend that owns the sessions, like the critical-session
 * settings, so the desktop app and a browser on a server edit the same
 * settings. The quiet hours are kept in the zone of the client that saved them.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BellRing, Hourglass, Moon, Repeat } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  getPendingReminderSettings,
  updatePendingReminderSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { exactDuration } from "@/lib/critical-sessions"
import {
  REMINDER_REPEAT_CHOICES,
  REMINDER_STEP_PRESETS,
} from "@/lib/pending-items"
import type { PendingReminderSettings } from "@/lib/types"

const stepsKey = (steps: readonly number[]) => steps.join(",")

/** "22:00" for 1320 minutes. */
export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  const hh = String(Math.floor(m / 60)).padStart(2, "0")
  const mm = String(m % 60).padStart(2, "0")
  return `${hh}:${mm}`
}

/** 1320 for "22:00"; `null` for anything else. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

function clientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    return ""
  }
}

export function PendingReminderSettingsSection() {
  const t = useTranslations("PendingItems.settings")
  const tItems = useTranslations("PendingItems")
  const [settings, setSettings] = useState<PendingReminderSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    getPendingReminderSettings()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err) => {
        console.error("[Settings] load reminder settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (patch: Partial<PendingReminderSettings>) => {
      if (!settings) return
      const prev = settings
      const next = { ...settings, ...patch, timezone: clientTimeZone() }
      setSettings(next)
      try {
        setSettings(await updatePendingReminderSettings(next))
      } catch (err) {
        setSettings(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      }
    },
    [settings, t]
  )

  const duration = useCallback(
    (seconds: number) => {
      const { unit, count } = exactDuration(seconds)
      return tItems(`duration.${unit}`, { count })
    },
    [tItems]
  )

  // Hidden until the stored values are known, like the other backend-stored
  // settings.
  if (!settings) return null

  const currentSteps = stepsKey(settings.steps_secs)
  const stepChoices = REMINDER_STEP_PRESETS.map(stepsKey)
  if (!stepChoices.includes(currentSteps)) stepChoices.push(currentSteps)
  const repeatChoices: number[] = [...REMINDER_REPEAT_CHOICES]
  if (!repeatChoices.includes(settings.repeat_secs)) {
    repeatChoices.push(settings.repeat_secs)
    repeatChoices.sort((a, b) => a - b)
  }
  const stepsLabel = (key: string) =>
    key
      .split(",")
      .filter(Boolean)
      .map((s) => duration(Number(s)))
      .join(", ") || t("repeatOff")

  return (
    <SettingsSection
      icon={BellRing}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          icon={BellRing}
          title={t("enabledTitle")}
          description={t("enabledHint")}
          htmlFor="pending-reminders-enabled"
          control={
            <Switch
              id="pending-reminders-enabled"
              checked={settings.enabled}
              onCheckedChange={(enabled) => void save({ enabled })}
            />
          }
        />
        {settings.enabled && (
          <>
            <SettingRow
              icon={Hourglass}
              title={t("scheduleTitle")}
              description={t("scheduleHint")}
              control={
                <Select
                  value={currentSteps}
                  onValueChange={(value) =>
                    void save({
                      steps_secs: value.split(",").filter(Boolean).map(Number),
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-44 bg-background text-xs"
                    aria-label={t("scheduleTitle")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {stepChoices.map((key) => (
                      <SelectItem key={key} value={key}>
                        {stepsLabel(key)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingRow
              icon={Repeat}
              title={t("repeatTitle")}
              description={t("repeatHint")}
              control={
                <Select
                  value={String(settings.repeat_secs)}
                  onValueChange={(value) =>
                    void save({ repeat_secs: Number(value) })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-32 bg-background text-xs"
                    aria-label={t("repeatTitle")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {repeatChoices.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {seconds === 0 ? t("repeatOff") : duration(seconds)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingRow
              icon={Moon}
              title={t("quietTitle")}
              description={t("quietHint")}
              htmlFor="pending-reminders-quiet"
              control={
                <Switch
                  id="pending-reminders-quiet"
                  checked={settings.quiet_hours}
                  onCheckedChange={(quiet_hours) => void save({ quiet_hours })}
                />
              }
            />
            {settings.quiet_hours && (
              <SettingRow
                icon={Moon}
                title={t("quietRangeTitle")}
                description={t("quietRangeHint")}
                control={
                  <div className="flex items-center gap-1.5 text-xs">
                    <Input
                      type="time"
                      aria-label={t("quietFrom")}
                      className="h-8 w-24 bg-background text-xs"
                      value={minutesToTime(settings.quiet_start_min)}
                      onChange={(e) => {
                        const minutes = timeToMinutes(e.target.value)
                        if (minutes != null) {
                          void save({ quiet_start_min: minutes })
                        }
                      }}
                    />
                    <span className="text-muted-foreground">–</span>
                    <Input
                      type="time"
                      aria-label={t("quietTo")}
                      className="h-8 w-24 bg-background text-xs"
                      value={minutesToTime(settings.quiet_end_min)}
                      onChange={(e) => {
                        const minutes = timeToMinutes(e.target.value)
                        if (minutes != null) {
                          void save({ quiet_end_min: minutes })
                        }
                      }}
                    />
                  </div>
                }
              />
            )}
          </>
        )}
      </SettingCard>
    </SettingsSection>
  )
}
