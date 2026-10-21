"use client"

/**
 * Settings → Agents → Claude Code: plan mode.
 *
 * - "Don't ask for permission while planning": codeg answers the shell, MCP
 *   and other requests a planning session raises (allow once). The plan
 *   approval, questions, file edits, removals and the user's own `ask` rules
 *   always show their card.
 * - "After approving a plan, continue in": which option leads the plan card
 *   and is its primary button.
 *
 * Saves on change; a failed save restores the previous value.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getClaudePlanSettings, updateClaudePlanSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  ClaudeAfterPlanMode,
  ClaudePlanningPrompts,
  ClaudePlanSettings,
} from "@/lib/types"

const PLANNING_OPTIONS = [
  ["when_elevated", "planningWhenElevated"],
  ["always", "planningAlways"],
  ["off", "planningOff"],
] as const satisfies readonly (readonly [ClaudePlanningPrompts, string])[]

const AFTER_OPTIONS = [
  ["pre_plan", "afterPrePlan"],
  ["bypass", "afterBypass"],
  ["auto", "afterAuto"],
  ["ask", "afterAsk"],
] as const satisfies readonly (readonly [ClaudeAfterPlanMode, string])[]

export function ClaudeCodePlanSettingsPanel() {
  const t = useTranslations("AcpAgentSettings.claudePlan")
  const [settings, setSettings] = useState<ClaudePlanSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getClaudePlanSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded)
      })
      .catch((err) => {
        console.error("[Settings] load Claude plan settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: ClaudePlanSettings, prev: ClaudePlanSettings) => {
      setSettings(next)
      setSaving(true)
      try {
        setSettings(await updateClaudePlanSettings(next))
      } catch (err) {
        setSettings(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  // Hidden until loaded: a picker showing a guessed value invites the user to
  // "confirm" a choice they never made.
  if (settings === null) return null

  return (
    <div
      data-slot="claude-code-plan"
      className="space-y-3 rounded-md border bg-muted/10 p-3"
    >
      <p className="text-xs font-medium">{t("title")}</p>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label
            htmlFor="claude-plan-while-planning"
            className="text-xs font-medium"
          >
            {t("whilePlanningLabel")}
          </label>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {t("whilePlanningHint")}
          </p>
        </div>
        <Select
          value={settings.while_planning}
          disabled={saving}
          onValueChange={(value) =>
            void save(
              {
                ...settings,
                while_planning: value as ClaudePlanningPrompts,
              },
              settings
            )
          }
        >
          <SelectTrigger
            id="claude-plan-while-planning"
            size="sm"
            className="w-56 shrink-0 bg-background text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {PLANNING_OPTIONS.map(([value, key]) => (
              <SelectItem key={value} value={value}>
                {t(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label
            htmlFor="claude-plan-after-approval"
            className="text-xs font-medium"
          >
            {t("afterApprovalLabel")}
          </label>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {t("afterApprovalHint")}
          </p>
        </div>
        <Select
          value={settings.after_approval}
          disabled={saving}
          onValueChange={(value) =>
            void save(
              {
                ...settings,
                after_approval: value as ClaudeAfterPlanMode,
              },
              settings
            )
          }
        >
          <SelectTrigger
            id="claude-plan-after-approval"
            size="sm"
            className="w-56 shrink-0 bg-background text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {AFTER_OPTIONS.map(([value, key]) => (
              <SelectItem key={value} value={value}>
                {t(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
