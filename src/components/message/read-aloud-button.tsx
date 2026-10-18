"use client"

import { Pause, Play, Square, Volume2 } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  useReadAloudActions,
  useReadAloudState,
  useReadAloudSupported,
} from "@/lib/read-aloud/use-read-aloud"
import { cn } from "@/lib/utils"

interface ReadAloudButtonProps {
  /** Identifies this reply to the player, so only its footer shows "playing". */
  id: string
  /** The reply's Markdown; prepared for speech by the player. */
  text: string
  /** The footer's icon-button look, shared with Copy and Fork. */
  buttonClassName: string
}

/**
 * "Read aloud" in a reply's footer: reads the reply with the system voices,
 * and while it does turns into Stop, with Pause/Resume beside it. Reading
 * another reply stops this one, so only the reply being read shows these.
 * Renders nothing where the runtime has no speech synthesis.
 *
 * Must sit inside a `TooltipProvider` (the footer's).
 */
export function ReadAloudButton({
  id,
  text,
  buttonClassName,
}: ReadAloudButtonProps) {
  const t = useTranslations("Folder.chat.messageList")
  const supported = useReadAloudSupported()
  const state = useReadAloudState()
  const actions = useReadAloudActions()

  if (!supported || !text.trim()) return null

  const active = state.currentId === id && state.status !== "idle"
  const playing = active && state.status === "playing"
  const label = active ? t("stopReading") : t("readAloud")
  const pauseLabel = playing ? t("pauseReading") : t("resumeReading")

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              actions.toggle(id, text)
            }}
            className={cn(
              buttonClassName,
              active &&
                "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            )}
            aria-label={label}
            data-read-aloud={active ? state.status : "idle"}
          >
            {active ? (
              <Square
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 fill-current",
                  playing && "motion-safe:animate-pulse"
                )}
              />
            ) : (
              <Volume2 aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      {active && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={playing ? actions.pause : actions.resume}
              className={cn(buttonClassName, "text-primary")}
              aria-label={pauseLabel}
            >
              {playing ? (
                <Pause aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <Play aria-hidden="true" className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{pauseLabel}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}
