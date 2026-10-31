"use client"

/**
 * The Talk dock, above the composer of the conversation this window talks
 * with on this Mac: an orb with the microphone and speech levels, captions
 * for the person and the agent, the choices when Talk asks something, "You
 * cut me off", Mute / Skip / End, and hands-free or hold to talk.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Mic, MicOff, PhoneOff, SkipForward } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  useTalkLevels,
  useTalkUi,
  useTalkVoice,
  type TalkSession,
} from "@/contexts/talk-voice-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  openMicSettings,
  talkPrefsApi,
  type TalkVoicePrefs,
} from "@/lib/talk-voice/api"
import type { TalkStatus, TalkUiState } from "@/lib/talk-voice/protocol"
import { cn } from "@/lib/utils"

const STATUS_KEYS = {
  starting: "statusStarting",
  listening: "statusListening",
  hearing: "statusHearing",
  thinking: "statusThinking",
  working: "statusWorking",
  speaking: "statusSpeaking",
  asking: "statusAsking",
  confirmingCancel: "statusConfirmingCancel",
  paused: "statusPaused",
  ended: "statusEnded",
  failed: "statusFailed",
} as const satisfies Record<TalkStatus, string>

/** The line being said, else the last one said. */
function agentCaption(ui: TalkUiState | null): string {
  if (!ui || ui.spoken.length === 0) return ""
  const playing = ui.current
    ? ui.spoken.find((line) => line.id === ui.current)
    : undefined
  return (playing ?? ui.spoken[ui.spoken.length - 1]).text
}

function TalkOrb({
  ui,
  holdToTalk,
  onTap,
  onPress,
}: {
  ui: TalkUiState | null
  holdToTalk: boolean
  onTap(): void
  onPress(down: boolean): void
}) {
  const t = useTranslations("TalkVoice")
  const levels = useTalkLevels()
  const level = Math.max(levels?.in ?? 0, levels?.out ?? 0)
  const status = ui?.status ?? "starting"
  const muted = ui != null && ui.mute !== "none"
  const tone = muted
    ? "bg-muted-foreground/40"
    : status === "speaking"
      ? "bg-sky-500"
      : status === "listening" || status === "hearing"
        ? "bg-emerald-500"
        : status === "failed"
          ? "bg-destructive"
          : "bg-amber-500"
  return (
    <button
      type="button"
      aria-label={holdToTalk ? t("holdToTalk") : t("orbLabel")}
      className="relative flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={holdToTalk ? undefined : onTap}
      onPointerDown={holdToTalk ? () => onPress(true) : undefined}
      onPointerUp={holdToTalk ? () => onPress(false) : undefined}
      onPointerLeave={holdToTalk ? () => onPress(false) : undefined}
      data-testid="talk-orb"
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full opacity-30 transition-transform duration-75",
          tone
        )}
        style={{ transform: `scale(${1 + Math.min(1, level) * 0.45})` }}
      />
      <span
        className={cn(
          "relative flex size-8 items-center justify-center rounded-full text-white",
          tone
        )}
      >
        {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </span>
    </button>
  )
}

export function TalkDock({
  conversationId,
}: {
  conversationId: number | null
}) {
  const talk = useTalkVoice()
  const session = talk.session
  if (!session || conversationId == null) return null
  if (session.conversationId !== conversationId) return null
  return <TalkDockView session={session} />
}

function TalkDockView({ session }: { session: TalkSession }) {
  const t = useTranslations("TalkVoice")
  const { control, endTalk } = useTalkVoice()
  const ui = useTalkUi()
  const status: TalkStatus =
    session.phase === "starting" ? "starting" : (ui?.status ?? "starting")
  const handsFree = ui?.handsFree ?? true
  const muted = ui != null && ui.mute !== "none"
  const heard = ui?.heard ?? ""
  const said = agentCaption(ui)

  const setHandsFree = useCallback(
    async (value: boolean) => {
      control({ op: "setHandsFree", value })
      try {
        const prefs = await talkPrefsApi.get()
        const next: TalkVoicePrefs = { ...prefs, handsFree: value }
        await talkPrefsApi.update(next)
      } catch (error) {
        toast.error(t("saveFailed", { error: toErrorMessage(error) }))
      }
    },
    [control, t]
  )

  return (
    <div
      className="mb-2 flex flex-col gap-2 rounded-xl border bg-card/80 p-3 shadow-sm"
      data-testid="talk-dock"
      dir="auto"
    >
      <div className="flex items-center gap-3">
        <TalkOrb
          ui={ui}
          holdToTalk={!handsFree}
          onTap={() => control({ op: "tapOrb" })}
          onPress={(down) => control({ op: "press", down })}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span data-testid="talk-status">{t(STATUS_KEYS[status])}</span>
            {ui?.mute === "soft" && (
              <span className="text-xs font-normal text-muted-foreground">
                {t("softMuted")}
              </span>
            )}
          </div>
          {(ui?.backgroundOutstanding ?? 0) > 0 && (
            <div className="text-xs text-muted-foreground">
              {t("backgroundWork", { count: ui?.backgroundOutstanding ?? 0 })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div
            className="mr-1 flex overflow-hidden rounded-md border text-xs"
            role="group"
            aria-label={t("modeLabel")}
          >
            <button
              type="button"
              className={cn(
                "px-2 py-1",
                handsFree ? "bg-accent text-accent-foreground" : ""
              )}
              aria-pressed={handsFree}
              onClick={() => void setHandsFree(true)}
            >
              {t("handsFree")}
            </button>
            <button
              type="button"
              className={cn(
                "border-l px-2 py-1",
                !handsFree ? "bg-accent text-accent-foreground" : ""
              )}
              aria-pressed={!handsFree}
              onClick={() => void setHandsFree(false)}
            >
              {t("holdToTalk")}
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => control({ op: "toggleMute" })}
          >
            {muted ? (
              <Mic className="size-3.5" />
            ) : (
              <MicOff className="size-3.5" />
            )}
            {muted ? t("unmute") : t("mute")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={status !== "speaking"}
            onClick={() => control({ op: "skip" })}
          >
            <SkipForward className="size-3.5" />
            {t("skip")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void endTalk()}
          >
            <PhoneOff className="size-3.5" />
            {t("end")}
          </Button>
        </div>
      </div>

      {(heard || said) && (
        <div className="flex flex-col gap-1 text-sm">
          {heard && (
            <p
              className={cn(
                "line-clamp-2",
                ui?.heardFinal ? "" : "text-muted-foreground"
              )}
              data-testid="talk-heard"
            >
              <span className="font-medium">{t("you")}: </span>
              {heard}
            </p>
          )}
          {said && (
            <p className="line-clamp-3" data-testid="talk-said">
              <span className="font-medium">{t("agent")}: </span>
              {said}
            </p>
          )}
        </div>
      )}

      {ui?.ask && ui.ask.choices.length > 0 && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t("choicesLabel")}
        >
          {ui.ask.choices.map((choice) => (
            <Button
              key={choice.id}
              type="button"
              variant="secondary"
              className="h-9 min-w-24"
              onClick={() => control({ op: "choose", choiceId: choice.id })}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}

      {ui?.canReportCutOff && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => control({ op: "reportCutOff" })}
          >
            {t("cutOff")}
          </Button>
        </div>
      )}

      {(ui?.mic === "denied" || ui?.error) && (
        <div
          className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex flex-1 flex-col gap-1">
            <span>{ui?.error ?? t("micDenied")}</span>
            {ui?.mic === "denied" && (
              <button
                type="button"
                className="self-start underline"
                onClick={() => void openMicSettings().catch(() => {})}
              >
                {t("openMicSettings")}
              </button>
            )}
          </div>
        </div>
      )}

      {ui?.suggestHeadphones && (
        <p className="text-xs text-muted-foreground">
          {t("suggestHeadphones")}
        </p>
      )}
      {ui && !ui.naturalVoice && (
        <p className="text-xs text-muted-foreground">{t("systemVoice")}</p>
      )}
    </div>
  )
}
