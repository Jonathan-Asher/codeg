"use client"

/**
 * Read-aloud settings: which installed system voice reads Hebrew and which
 * reads English, how fast, a sample to hear the choice, and whether a reply is
 * read on its own when it finishes.
 *
 * Every value lives in this device's localStorage (`read-aloud/prefs.ts`) and
 * is written as it changes, like the notification-sound section next door:
 * voices are installed per machine, so the choice is per machine too.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AudioLines,
  Gauge,
  Languages,
  Play,
  Square,
  WandSparkles,
} from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import {
  MAX_RATE,
  MIN_RATE,
  RATE_STEP,
  saveReadAloudPrefs,
  useReadAloudPrefs,
  type ReadAloudPrefs,
} from "@/lib/read-aloud/prefs"
import {
  useReadAloudActions,
  useReadAloudState,
  useReadAloudSupported,
  useReadAloudVoices,
} from "@/lib/read-aloud/use-read-aloud"
import { pickVoice, voicesFor, type VoiceLike } from "@/lib/read-aloud/voices"

/** The Select value standing for "no pinned voice". */
const AUTOMATIC = "__automatic__"

/** The read-aloud id of the Test sample. */
export const READ_ALOUD_TEST_ID = "settings-test"

/**
 * One Hebrew and one English sentence, so Test plays both voices. Not
 * translated: it is a sample of the two voices, not a message to the user.
 */
export const READ_ALOUD_SAMPLE =
  "שלום! כך נשמע הקול העברי. And this is the English voice, at the speed you chose."

function voiceLabel(voice: VoiceLike): string {
  return `${voice.name} (${voice.lang.replace(/_/g, "-")})`
}

interface VoiceSelectProps {
  id: string
  label: string
  voices: VoiceLike[]
  allVoices: VoiceLike[]
  lang: "he" | "en"
  value: string | null
  onChange: (voiceURI: string | null) => void
}

function VoiceSelect({
  id,
  label,
  voices,
  allVoices,
  lang,
  value,
  onChange,
}: VoiceSelectProps) {
  const t = useTranslations("ReadAloudSettings")
  const automatic = pickVoice(allVoices, lang)
  // A pinned voice that has been uninstalled reads as "Automatic", which is
  // what the player falls back to.
  const selected =
    value && voices.some((voice) => voice.voiceURI === value)
      ? value
      : AUTOMATIC
  return (
    <Select
      value={selected}
      onValueChange={(next) => onChange(next === AUTOMATIC ? null : next)}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className="w-64 max-w-full bg-background text-xs"
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={AUTOMATIC}>
          {automatic
            ? t("automatic", { voice: automatic.name })
            : t("automaticNone")}
        </SelectItem>
        {voices.map((voice) => (
          <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
            {voiceLabel(voice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ReadAloudSettingsSection() {
  const t = useTranslations("ReadAloudSettings")
  const supported = useReadAloudSupported()
  const prefs = useReadAloudPrefs()
  const allVoices = useReadAloudVoices()
  const state = useReadAloudState()
  const actions = useReadAloudActions()
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const [expanded, setExpanded] = useState(false)

  const hebrewVoices = voicesFor(allVoices, "he")
  const englishVoices = voicesFor(allVoices, "en")
  const testing =
    state.currentId === READ_ALOUD_TEST_ID && state.status !== "idle"
  const save = (patch: Partial<ReadAloudPrefs>) =>
    saveReadAloudPrefs({ ...prefs, ...patch })

  const shortcut = shortcuts.read_last_reply
    ? formatShortcutLabel(shortcuts.read_last_reply, isMac)
    : null

  return (
    <SettingsSection
      icon={AudioLines}
      title={t("title")}
      description={
        <>
          {t("description")}
          <span className="mt-1 block">
            {supported
              ? shortcut
                ? t("keysHint", { shortcut })
                : t("keysHintUnbound")
              : t("unsupported")}
          </span>
        </>
      }
      collapsible
      open={expanded}
      onOpenChange={setExpanded}
    >
      {supported && (
        <SettingCard>
          <SettingRow
            icon={Languages}
            title={t("hebrewVoice")}
            description={
              allVoices.length > 0 && hebrewVoices.length === 0
                ? t("noHebrewVoice")
                : undefined
            }
            htmlFor="read-aloud-hebrew-voice"
            control={
              <VoiceSelect
                id="read-aloud-hebrew-voice"
                label={t("hebrewVoice")}
                voices={hebrewVoices}
                allVoices={allVoices}
                lang="he"
                value={prefs.hebrewVoice}
                onChange={(hebrewVoice) => save({ hebrewVoice })}
              />
            }
          />
          <SettingRow
            icon={Languages}
            title={t("englishVoice")}
            htmlFor="read-aloud-english-voice"
            control={
              <VoiceSelect
                id="read-aloud-english-voice"
                label={t("englishVoice")}
                voices={englishVoices}
                allVoices={allVoices}
                lang="en"
                value={prefs.englishVoice}
                onChange={(englishVoice) => save({ englishVoice })}
              />
            }
          />
        </SettingCard>
      )}

      {supported && (
        <SettingCard>
          <SettingRow
            icon={Gauge}
            title={t("rate")}
            control={
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("rateValue", { rate: prefs.rate.toFixed(1) })}
              </span>
            }
          >
            <div className="flex items-center gap-3">
              <Slider
                value={[prefs.rate]}
                min={MIN_RATE}
                max={MAX_RATE}
                step={RATE_STEP}
                aria-label={t("rate")}
                onValueChange={([rate]) => save({ rate })}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 bg-background"
                onClick={() =>
                  actions.toggle(READ_ALOUD_TEST_ID, READ_ALOUD_SAMPLE)
                }
              >
                {testing ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {testing ? t("stopTest") : t("test")}
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            icon={WandSparkles}
            title={t("autoRead")}
            description={t("autoReadHint")}
            htmlFor="read-aloud-auto"
            control={
              <Switch
                id="read-aloud-auto"
                checked={prefs.autoRead}
                onCheckedChange={(autoRead) => save({ autoRead })}
              />
            }
          />
        </SettingCard>
      )}
    </SettingsSection>
  )
}
