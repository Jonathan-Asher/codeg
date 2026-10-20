"use client"

/**
 * Read-aloud settings: the engine (the natural voice, the same one the iPhone
 * app speaks with, or this device's system voices), the natural voice's
 * download, which system voice reads Hebrew and which reads English, how fast,
 * a sample to hear the choice, and whether a reply is read on its own when it
 * finishes. Each system voice is listed with its tier (Premium, Enhanced,
 * Natural, Basic), better tiers first, and on a Mac a language read by a basic
 * voice says where to download a better one.
 *
 * The choices live in this device's localStorage (`read-aloud/prefs.ts`) and
 * are written as they change, like the notification-sound section next door.
 * The natural voice's models live with the backend that makes the voice: this
 * Mac in the desktop app, the server in a browser — which the download row
 * says, with what it costs there.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AudioLines,
  Download,
  Gauge,
  Languages,
  Play,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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
import { toErrorMessage } from "@/lib/app-error"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import {
  naturalVoiceHost,
  ttsApi,
  type NaturalVoiceHost,
  type TtsStatus,
} from "@/lib/read-aloud/natural-api"
import {
  naturalVoiceReady,
  setNaturalStatus,
  useNaturalStatus,
} from "@/lib/read-aloud/natural-status"
import {
  MAX_RATE,
  MIN_RATE,
  RATE_STEP,
  saveReadAloudPrefs,
  useReadAloudPrefs,
  type ReadAloudEngine,
  type ReadAloudPrefs,
} from "@/lib/read-aloud/prefs"
import {
  useReadAloudActions,
  useReadAloudState,
  useReadAloudSupported,
  useReadAloudVoices,
} from "@/lib/read-aloud/use-read-aloud"
import {
  pickVoice,
  voicesByTier,
  voiceTier,
  type VoiceLike,
  type VoiceTier,
} from "@/lib/read-aloud/voices"
import { formatBytes } from "@/lib/transfer-format"

/** The Select value standing for "no pinned voice". */
const AUTOMATIC = "__automatic__"

/** The message key naming each voice tier. */
const TIER_LABEL = {
  premium: "tierPremium",
  enhanced: "tierEnhanced",
  natural: "tierNatural",
  basic: "tierBasic",
} as const satisfies Record<VoiceTier, string>

/**
 * The voice the better-voice hint names for each language: what macOS offers
 * in that language, at the tier worth downloading.
 */
const BETTER_VOICE = {
  he: { voice: "Carmit", tier: "enhanced" },
  en: { voice: "Ava", tier: "premium" },
} as const satisfies Record<"he" | "en", { voice: string; tier: VoiceTier }>

/** The read-aloud id of the Test sample. */
export const READ_ALOUD_TEST_ID = "settings-test"

/**
 * One Hebrew and one English sentence, so Test plays both voices. Not
 * translated: it is a sample of the two voices, not a message to the user.
 */
export const READ_ALOUD_SAMPLE =
  "שלום! כך נשמע הקול העברי. And this is the English voice, at the speed you chose."

/** Messages for the reasons a backend can't make the natural voice. */
const UNSUPPORTED_LABEL = {
  platform: {
    local: "naturalUnsupportedPlatformLocal",
    server: "naturalUnsupportedPlatformServer",
  },
  sidecarMissing: {
    local: "naturalUnsupportedBuild",
    server: "naturalUnsupportedBuild",
  },
  disabled: {
    local: "naturalUnsupportedDisabled",
    server: "naturalUnsupportedDisabled",
  },
} as const satisfies Record<string, Record<NaturalVoiceHost, string>>

/** "Ava (Premium)" → "Ava": the tier is shown on its own beside the name. */
function voiceName(voice: VoiceLike): string {
  return voice.name.replace(/\s*\((premium|enhanced)\)\s*$/i, "")
}

function voiceLabel(voice: VoiceLike): string {
  return `${voiceName(voice)} (${voice.lang.replace(/_/g, "-")})`
}

/** `noa` → `Noa`. */
function speakerName(voice: string): string {
  return voice.charAt(0).toUpperCase() + voice.slice(1)
}

/** The engine a reply is read with now, given the choice and the models. */
export function effectiveEngine(
  prefs: ReadAloudPrefs,
  status: TtsStatus | null | undefined
): ReadAloudEngine {
  if (prefs.engine) return prefs.engine
  return naturalVoiceReady(status ?? null) ? "natural" : "system"
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
            ? t("automatic", {
                voice: `${voiceName(automatic)} · ${t(TIER_LABEL[voiceTier(automatic)])}`,
              })
            : t("automaticNone")}
        </SelectItem>
        {voices.map((voice) => (
          <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
            {voiceLabel(voice)}
            <span className="text-muted-foreground">
              {" · "}
              {t(TIER_LABEL[voiceTier(voice)])}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

interface NaturalVoiceRowsProps {
  status: TtsStatus | null | undefined
  prefs: ReadAloudPrefs
  save: (patch: Partial<ReadAloudPrefs>) => void
}

/**
 * The natural voice's download and speaker. Nothing is downloaded until the
 * Download button is pressed; the row says where the models go and what they
 * cost there before it is.
 */
function NaturalVoiceRows({ status, prefs, save }: NaturalVoiceRowsProps) {
  const t = useTranslations("ReadAloudSettings")
  const host = naturalVoiceHost()
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<TtsStatus>) => {
    setBusy(true)
    try {
      setNaturalStatus(await action())
    } catch (error) {
      toast.error(t("naturalActionFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setBusy(false)
    }
  }

  if (status === undefined) {
    return (
      <SettingRow
        icon={Sparkles}
        title={t("naturalVoice")}
        description={t("naturalChecking")}
      />
    )
  }
  if (status === null) {
    return (
      <SettingRow
        icon={Sparkles}
        title={t("naturalVoice")}
        description={t("naturalUnavailable")}
      />
    )
  }
  if (!status.supported) {
    const reason = status.unsupportedReason ?? "platform"
    const known =
      reason in UNSUPPORTED_LABEL
        ? UNSUPPORTED_LABEL[reason as keyof typeof UNSUPPORTED_LABEL][host]
        : null
    return (
      <SettingRow
        icon={Sparkles}
        title={t("naturalVoice")}
        description={
          known ? t(known) : t("naturalUnsupportedOther", { reason })
        }
      />
    )
  }

  const size = formatBytes(status.packBytes)
  const download = status.download

  if (status.installed) {
    const voices = status.voices
    const voice =
      prefs.naturalVoice && voices.includes(prefs.naturalVoice)
        ? prefs.naturalVoice
        : status.defaultVoice
    return (
      <>
        <SettingRow
          icon={Sparkles}
          title={t("naturalSpeaker")}
          htmlFor="read-aloud-natural-voice"
          control={
            <Select
              value={voice}
              onValueChange={(naturalVoice) => save({ naturalVoice })}
            >
              <SelectTrigger
                id="read-aloud-natural-voice"
                size="sm"
                className="w-40 bg-background text-xs"
                aria-label={t("naturalSpeaker")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {voices.map((name) => (
                  <SelectItem key={name} value={name}>
                    {speakerName(name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          icon={Download}
          title={t("naturalVoice")}
          description={t(
            host === "local"
              ? "naturalInstalledLocal"
              : "naturalInstalledServer",
            { size }
          )}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="bg-background"
              disabled={busy}
              onClick={() => void run(ttsApi.deleteModels)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("naturalDelete")}
            </Button>
          }
        />
      </>
    )
  }

  if (download.state === "downloading") {
    const percent =
      download.bytesTotal > 0
        ? Math.round((download.bytesDone / download.bytesTotal) * 100)
        : 0
    return (
      <SettingRow
        icon={Download}
        title={t("naturalVoice")}
        description={t("naturalDownloading", {
          done: formatBytes(download.bytesDone),
          total: formatBytes(download.bytesTotal),
        })}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-background"
            disabled={busy}
            onClick={() => void run(ttsApi.cancelDownload)}
          >
            {t("naturalCancel")}
          </Button>
        }
      >
        <Progress value={percent} aria-label={t("naturalVoice")} />
      </SettingRow>
    )
  }

  const hint = t(
    host === "local" ? "naturalDownloadHintLocal" : "naturalDownloadHintServer",
    { size }
  )
  return (
    <SettingRow
      icon={Download}
      title={t("naturalVoice")}
      description={
        download.state === "failed" ? (
          <>
            <span className="block text-destructive">
              {t("naturalDownloadFailed", { message: download.message })}
            </span>
            {hint}
          </>
        ) : (
          hint
        )
      }
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="bg-background"
          disabled={busy}
          onClick={() => void run(ttsApi.downloadModels)}
        >
          <Download className="h-3.5 w-3.5" />
          {download.state === "failed"
            ? t("naturalRetry")
            : t("naturalDownload", { size })}
        </Button>
      }
    />
  )
}

export function ReadAloudSettingsSection() {
  const t = useTranslations("ReadAloudSettings")
  const supported = useReadAloudSupported()
  const prefs = useReadAloudPrefs()
  const allVoices = useReadAloudVoices()
  const state = useReadAloudState()
  const actions = useReadAloudActions()
  const naturalStatus = useNaturalStatus()
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const [expanded, setExpanded] = useState(false)

  const engine = effectiveEngine(prefs, naturalStatus)
  const hebrewVoices = voicesByTier(allVoices, "he")
  const englishVoices = voicesByTier(allVoices, "en")
  // Where the voice that reads a language is a compact or basic one, say how
  // to get a better one. The steps are the Mac's, so only there.
  const betterVoiceHint = (lang: "he" | "en", pinned: string | null) => {
    const chosen = pickVoice(allVoices, lang, pinned)
    if (!isMac || !chosen || voiceTier(chosen) !== "basic") return undefined
    const example = BETTER_VOICE[lang]
    return t("betterVoiceHint", {
      voice: example.voice,
      tier: t(TIER_LABEL[example.tier]),
    })
  }
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
            icon={Sparkles}
            title={t("engine")}
            description={
              engine === "natural" && !naturalVoiceReady(naturalStatus ?? null)
                ? t("engineNaturalPending")
                : undefined
            }
            htmlFor="read-aloud-engine"
            control={
              <Select
                value={engine}
                onValueChange={(next) =>
                  save({ engine: next as ReadAloudEngine })
                }
              >
                <SelectTrigger
                  id="read-aloud-engine"
                  size="sm"
                  className="w-64 max-w-full bg-background text-xs"
                  aria-label={t("engine")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="natural">{t("engineNatural")}</SelectItem>
                  <SelectItem value="system">{t("engineSystem")}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          {engine === "natural" && (
            <NaturalVoiceRows
              status={naturalStatus}
              prefs={prefs}
              save={save}
            />
          )}
        </SettingCard>
      )}

      {supported && engine === "system" && (
        <SettingCard>
          <SettingRow
            icon={Languages}
            title={t("hebrewVoice")}
            description={
              allVoices.length > 0 && hebrewVoices.length === 0
                ? t("noHebrewVoice")
                : betterVoiceHint("he", prefs.hebrewVoice)
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
            description={betterVoiceHint("en", prefs.englishVoice)}
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
