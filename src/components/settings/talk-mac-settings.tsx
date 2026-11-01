"use client"

/**
 * "Talk on this Mac": a hands-free voice conversation with a session through
 * this Mac's microphone and speakers (the native helper `codeg-talk`, see
 * `lib/talk-voice/`). Its speech models with their sizes and download
 * progress, the global shortcut, hands-free or hold to talk, interrupting by
 * speaking, and the microphone permission.
 *
 * Desktop only, and this Mac's own: every call goes to the local backend
 * (`getShellTransport()`), a remote workspace's settings window included.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  AudioLines,
  Ear,
  Keyboard,
  Mic,
  MessageSquareQuote,
  Timer,
  Volume2,
} from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { TalkModelRow } from "@/components/talk-voice/talk-model-row"
import { useTalkModels } from "@/components/talk-voice/use-talk-models"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useIsMac } from "@/hooks/use-is-mac"
import { toErrorMessage } from "@/lib/app-error"
import { setShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import { isDesktop } from "@/lib/platform"
import {
  acceleratorFromEvent,
  formatAccelerator,
} from "@/lib/quick-ask/shortcut"
import {
  DEFAULT_TALK_SHORTCUT,
  openMicSettings,
  settled,
  talkPrefsApi,
  talkVoiceApi,
  type TalkVoicePrefs,
  type TalkVoicePrefsView,
  type TalkVoiceStatus,
} from "@/lib/talk-voice/api"
import type { TalkEchoMode, TalkPatience } from "@/lib/talk-voice/protocol"
import { cn } from "@/lib/utils"

const PATIENCE = [
  "short",
  "normal",
  "long",
] as const satisfies readonly TalkPatience[]
const PATIENCE_KEYS = {
  short: "patienceShort",
  normal: "patienceNormal",
  long: "patienceLong",
} as const satisfies Record<TalkPatience, string>

const ECHO_MODES = [
  "automatic",
  "voiceProcessing",
  "off",
] as const satisfies readonly TalkEchoMode[]
const ECHO_KEYS = {
  automatic: "echoAutomatic",
  voiceProcessing: "echoOn",
  off: "echoOff",
} as const satisfies Record<TalkEchoMode, string>

const UNSUPPORTED_KEYS = {
  disabled: "unsupportedDisabled",
  platform: "unsupportedPlatform",
  arch: "unsupportedArch",
  helperMissing: "unsupportedHelperMissing",
  protocol: "unsupportedProtocol",
  probe: "unsupportedProbe",
} as const

type UnsupportedReason = keyof typeof UNSUPPORTED_KEYS

const MIC_KEYS = {
  granted: "micGranted",
  denied: "micDenied",
  undetermined: "micUndetermined",
} as const

type MicState = keyof typeof MIC_KEYS

function prefsOf(view: TalkVoicePrefsView): TalkVoicePrefs {
  return {
    shortcutEnabled: view.shortcutEnabled,
    shortcut: view.shortcut,
    handsFree: view.handsFree,
    interruptBySpeaking: view.interruptBySpeaking,
    useWhisper: view.useWhisper,
    patience: view.patience,
    echoMode: view.echoMode,
    speakProgress: view.speakProgress,
    smartTurnActive: view.smartTurnActive,
    shareTelemetry: view.shareTelemetry,
  }
}

export function TalkMacSettingsSection() {
  const t = useTranslations("TalkMacSettings")
  const isMac = useIsMac()
  const desktop = isDesktop()
  const [status, setStatus] = useState<TalkVoiceStatus | null>(null)
  const [prefs, setPrefs] = useState<TalkVoicePrefsView | null>(null)
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [checking, setChecking] = useState(false)
  const models = useTalkModels(desktop && status?.supported === true)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void settled(() => talkVoiceApi.status())
      .then((next) => {
        if (!cancelled && next) setStatus(next)
      })
      .catch(() => {})
    void settled(() => talkPrefsApi.get())
      .then((next) => {
        if (!cancelled && next) setPrefs(next)
      })
      .catch(() => {})
    let off: (() => void) | null = null
    void settled(() =>
      talkVoiceApi.onStatus((payload) => setStatus(payload as TalkVoiceStatus))
    ).then((unsubscribe) => {
      if (typeof unsubscribe !== "function") return
      if (cancelled) unsubscribe()
      else off = unsubscribe
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [desktop])

  const save = useCallback(
    async (patch: Partial<TalkVoicePrefs>) => {
      if (!prefs) return
      const previous = prefs
      const next = { ...prefsOf(prefs), ...patch }
      setPrefs({ ...prefs, ...patch })
      setSaving(true)
      try {
        setPrefs(await talkPrefsApi.update(next))
      } catch (error) {
        setPrefs(previous)
        toast.error(t("saveFailed", { error: toErrorMessage(error) }))
      } finally {
        setSaving(false)
      }
    },
    [prefs, t]
  )

  const checkAgain = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await talkVoiceApi.status(true))
    } catch (error) {
      toast.error(t("checkFailed", { error: toErrorMessage(error) }))
    } finally {
      setChecking(false)
    }
  }, [t])

  // Recording the shortcut: the next key press with a modifier; Esc cancels.
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

  if (!desktop || !status) return null
  // Only where the platform could run it at all.
  if (status.unsupportedReason === "platform") return null

  const reason = status.unsupportedReason as UnsupportedReason | null
  const mic = (status.probe?.report?.mic ?? null) as MicState | null

  return (
    <SettingsSection
      icon={AudioLines}
      title={t("title")}
      description={t("description")}
    >
      {!status.supported && reason && (
        <SettingCard>
          <SettingRow
            icon={AlertTriangle}
            title={t("unsupportedTitle")}
            description={
              <>
                {t(UNSUPPORTED_KEYS[reason] ?? "unsupportedProbe")}
                {status.probe?.error && (
                  <span className="block opacity-80">{status.probe.error}</span>
                )}
              </>
            }
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={checking}
                onClick={() => void checkAgain()}
              >
                {t("checkAgain")}
              </Button>
            }
          />
        </SettingCard>
      )}

      {status.supported && (
        <SettingCard>
          <SettingRow
            icon={Volume2}
            title={t("modelsTitle")}
            description={t("modelsDescription")}
          >
            <div className="flex flex-col gap-2">
              {models.status?.packs.map((pack) => (
                <TalkModelRow
                  key={pack.id}
                  pack={pack}
                  busy={models.busy}
                  onDownload={() => void models.download([pack.id])}
                  onCancel={() => void models.cancel([pack.id])}
                  onDelete={() => void models.remove([pack.id])}
                />
              ))}
              {models.error && (
                <p className="text-xs text-destructive">{models.error}</p>
              )}
              {!status.voiceInstalled && (
                <p className="text-xs text-muted-foreground">
                  {t("systemVoiceHint")}
                </p>
              )}
            </div>
          </SettingRow>
        </SettingCard>
      )}

      {status.supported && prefs && (
        <SettingCard>
          <SettingRow
            icon={Keyboard}
            title={t("shortcutEnable")}
            description={t("shortcutEnableDescription")}
            htmlFor="talk-mac-shortcut-enabled"
            control={
              <Switch
                id="talk-mac-shortcut-enabled"
                checked={prefs.shortcutEnabled}
                disabled={saving}
                onCheckedChange={(shortcutEnabled) =>
                  void save({ shortcutEnabled })
                }
              />
            }
          />
          <SettingRow
            title={t("shortcut")}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || !prefs.shortcutEnabled}
                  onClick={() => setRecording((r) => !r)}
                  className={cn(
                    "h-7 min-w-24 font-mono text-xs",
                    recording && "ring-2 ring-ring"
                  )}
                  data-testid="talk-mac-shortcut"
                >
                  {recording
                    ? t("recording")
                    : formatAccelerator(prefs.shortcut, isMac)}
                </Button>
                {prefs.shortcut !== DEFAULT_TALK_SHORTCUT && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={saving || !prefs.shortcutEnabled}
                    onClick={() =>
                      void save({ shortcut: DEFAULT_TALK_SHORTCUT })
                    }
                  >
                    {t("reset")}
                  </Button>
                )}
              </div>
            }
          >
            {prefs.shortcutEnabled && !prefs.shortcutRegistered && (
              <div
                className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {t("notRegistered", {
                    shortcut: formatAccelerator(prefs.shortcut, isMac),
                  })}
                  {prefs.shortcutError && ` (${prefs.shortcutError})`}
                </span>
              </div>
            )}
          </SettingRow>
          <SettingRow
            icon={Ear}
            title={t("handsFree")}
            description={t("handsFreeDescription")}
            htmlFor="talk-mac-hands-free"
            control={
              <Switch
                id="talk-mac-hands-free"
                checked={prefs.handsFree}
                disabled={saving}
                onCheckedChange={(handsFree) => void save({ handsFree })}
              />
            }
          />
          <SettingRow
            icon={MessageSquareQuote}
            title={t("interrupt")}
            description={t("interruptDescription")}
            htmlFor="talk-mac-interrupt"
            control={
              <Switch
                id="talk-mac-interrupt"
                checked={prefs.interruptBySpeaking}
                disabled={saving}
                onCheckedChange={(interruptBySpeaking) =>
                  void save({ interruptBySpeaking })
                }
              />
            }
          />
          <SettingRow
            title={t("whisper")}
            description={t("whisperDescription")}
            htmlFor="talk-mac-whisper"
            control={
              <Switch
                id="talk-mac-whisper"
                checked={prefs.useWhisper}
                disabled={saving}
                onCheckedChange={(useWhisper) => void save({ useWhisper })}
              />
            }
          />
          <SettingRow
            icon={Timer}
            title={t("patience")}
            description={t("patienceDescription")}
            control={
              <Select
                value={prefs.patience}
                onValueChange={(value) =>
                  void save({ patience: value as TalkPatience })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-36 bg-background text-xs"
                  aria-label={t("patience")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {PATIENCE.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(PATIENCE_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            title={t("echo")}
            description={t("echoDescription")}
            control={
              <Select
                value={prefs.echoMode}
                onValueChange={(value) =>
                  void save({ echoMode: value as TalkEchoMode })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-36 bg-background text-xs"
                  aria-label={t("echo")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {ECHO_MODES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(ECHO_KEYS[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingCard>
      )}

      {/* The permission as the helper sees it. A spoken microphone and echo
          test needs an operation of its own in the helper (protocol v1 has
          none); until then the check is the permission and a re-run of the
          helper's probe. */}
      {status.supported && (
        <SettingCard>
          <SettingRow
            icon={Mic}
            title={t("micTitle")}
            description={mic ? t(MIC_KEYS[mic] ?? "micUndetermined") : null}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={checking}
                  onClick={() => void checkAgain()}
                >
                  {t("checkAgain")}
                </Button>
                {mic === "denied" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void openMicSettings().catch(() => {})}
                  >
                    {t("openMicSettings")}
                  </Button>
                )}
              </div>
            }
          />
        </SettingCard>
      )}
    </SettingsSection>
  )
}
