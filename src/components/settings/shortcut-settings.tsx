"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Keyboard, RotateCcw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  DEFAULT_SHORTCUTS,
  INPUT_SHORTCUT_IDS,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
  type ShortcutShadow,
  analyzeShortcutAssignment,
  formatShortcutLabel,
  setShortcutRecorderArmed,
  shortcutContextOf,
  shortcutFromKeyboardEvent,
  shortcutShadowsOf,
} from "@/lib/keyboard-shortcuts"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

/** `ListFormat` is newer than the TypeScript lib this project targets. */
type ListFormatConstructor = new (
  locale: string,
  options: { type: "conjunction" }
) => { format: (items: string[]) => string }

/** "A, B and C" in the user's language, or a plain comma list without Intl. */
function formatNameList(names: string[], locale: string): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor })
    .ListFormat
  if (!ListFormat) return names.join(", ")
  try {
    return new ListFormat(locale, { type: "conjunction" }).format(names)
  } catch {
    return names.join(", ")
  }
}

/** A recorded chord that other actions already hold, waiting on the user. */
interface PendingTakeover {
  actionId: ShortcutActionId
  shortcut: string
  clashes: ShortcutActionId[]
}

export function ShortcutSettings() {
  const t = useTranslations("ShortcutSettings")
  const locale = useLocale()
  const { shortcuts, updateShortcut, takeOverShortcut, resetShortcuts } =
    useShortcutSettings()
  const isMac = useIsMac()
  const [recordingAction, setRecordingAction] =
    useState<ShortcutActionId | null>(null)
  const [pending, setPending] = useState<PendingTakeover | null>(null)
  const actionTitle = useCallback(
    (id: ShortcutActionId) => t(`actions.${id}.title`),
    [t]
  )
  const listNames = useCallback(
    (names: string[]) => formatNameList(names, locale),
    [locale]
  )
  // "While the terminal has focus, ⌘T runs “New Terminal” instead." Said from
  // the side of `actionId`: the chord does something else there, or it takes
  // the chord from another action there.
  const describeShadow = useCallback(
    (actionId: ShortcutActionId, shadow: ShortcutShadow, shortcut: string) => {
      const values = {
        focus: t(`focus.${shadow.focus}`),
        shortcut: formatShortcutLabel(shortcut, isMac),
      }
      return shadow.loser === actionId
        ? t("shadowedBy", { ...values, action: actionTitle(shadow.winner) })
        : t("shadows", { ...values, action: actionTitle(shadow.loser) })
    },
    [actionTitle, isMac, t]
  )
  const actionDescription = useCallback(
    (id: ShortcutActionId) => t(`actions.${id}.description`),
    [t]
  )

  const isDefault = useMemo(
    () =>
      SHORTCUT_DEFINITIONS.every(
        (definition) =>
          shortcuts[definition.id] === DEFAULT_SHORTCUTS[definition.id]
      ),
    [shortcuts]
  )

  useEffect(() => {
    setShortcutRecorderArmed(Boolean(recordingAction))
    return () => setShortcutRecorderArmed(false)
  }, [recordingAction])

  useEffect(() => {
    if (!recordingAction) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        setRecordingAction(null)
        return
      }

      const allowNoModifier = INPUT_SHORTCUT_IDS.has(recordingAction)
      const shortcut = shortcutFromKeyboardEvent(event, allowNoModifier)
      if (!shortcut) return

      // Matcher semantics, not string equality: two different strings can fire
      // on the same event (`mod+=` and `mod++` are one chord). A binding that
      // only reaches the press through a tolerance yields to the one that
      // spells it, so `mod+=` and `mod+shift+=` coexist. Context decides the
      // rest: a terminal action and a workspace action share a chord, since the
      // terminal's takes it only while the terminal has focus.
      const { clashes, shadows } = analyzeShortcutAssignment(
        recordingAction,
        shortcut,
        shortcuts
      )

      if (clashes.length > 0) {
        setPending({ actionId: recordingAction, shortcut, clashes })
        setRecordingAction(null)
        return
      }

      if (updateShortcut(recordingAction, shortcut)) {
        toast.success(t("toasts.updated"), {
          description:
            shadows.length > 0
              ? shadows
                  .map((shadow) =>
                    describeShadow(recordingAction, shadow, shortcut)
                  )
                  .join(" ")
              : undefined,
        })
      } else {
        toast.error(t("toasts.invalid"))
      }

      setRecordingAction(null)
    }

    window.addEventListener("keydown", onKeyDown, true)

    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [describeShadow, recordingAction, shortcuts, t, updateShortcut])

  const confirmTakeover = useCallback(() => {
    if (!pending) return
    const { actionId, shortcut, clashes } = pending
    setPending(null)
    if (!takeOverShortcut(actionId, shortcut, clashes)) {
      toast.error(t("toasts.invalid"))
      return
    }
    toast.success(
      t("toasts.takenOver", {
        shortcut: formatShortcutLabel(shortcut, isMac),
        action: actionTitle(actionId),
        others: listNames(clashes.map(actionTitle)),
      })
    )
  }, [actionTitle, isMac, listNames, pending, t, takeOverShortcut])

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">{t("sectionTitle")}</h2>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetShortcuts()
                setRecordingAction(null)
                setPending(null)
                toast.success(t("toasts.reset"))
              }}
              disabled={isDefault}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("resetDefault")}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("recordInstruction")}
          </p>

          <div className="space-y-2">
            {SHORTCUT_DEFINITIONS.map((definition) => {
              const isRecording = recordingAction === definition.id
              const prompt =
                pending?.actionId === definition.id ? pending : null
              // Only the losing side says it: the chord does not do this
              // action there. The winner works wherever it listens.
              const shadowNotes = shortcutShadowsOf(definition.id, shortcuts)
                .filter((shadow) => shadow.loser === definition.id)
                .map((shadow) =>
                  describeShadow(
                    definition.id,
                    shadow,
                    shortcuts[definition.id]
                  )
                )

              return (
                <div
                  key={definition.id}
                  className="rounded-lg border px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span className="min-w-0 truncate">
                          {actionTitle(definition.id)}
                        </span>
                        <span className="shrink-0 rounded-sm bg-muted px-1.5 text-2xs font-normal text-muted-foreground">
                          {t(`contexts.${shortcutContextOf(definition.id)}`)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {actionDescription(definition.id)}
                      </p>
                      {shadowNotes.map((note) => (
                        <p
                          key={note}
                          className="text-2xs leading-4 text-muted-foreground/80"
                        >
                          {note}
                        </p>
                      ))}
                    </div>
                    <Button
                      variant={isRecording ? "default" : "secondary"}
                      size="sm"
                      className="font-mono min-w-36 justify-center"
                      onClick={() => {
                        setPending(null)
                        setRecordingAction((previous) =>
                          previous === definition.id ? null : definition.id
                        )
                      }}
                    >
                      {isRecording
                        ? t("recording")
                        : shortcuts[definition.id]
                          ? formatShortcutLabel(shortcuts[definition.id], isMac)
                          : t("unassigned")}
                    </Button>
                  </div>
                  {prompt && (
                    <div
                      role="alert"
                      className="mt-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return
                        event.preventDefault()
                        event.stopPropagation()
                        setPending(null)
                      }}
                    >
                      <p className="text-xs leading-5">
                        {t("conflict.message", {
                          shortcut: formatShortcutLabel(prompt.shortcut, isMac),
                          actions: listNames(
                            prompt.clashes.map(
                              (id) =>
                                `${actionTitle(id)} (${t(`contexts.${shortcutContextOf(id)}`)})`
                            )
                          ),
                        })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" autoFocus onClick={confirmTakeover}>
                          {t("conflict.takeOver", {
                            action: actionTitle(prompt.actionId),
                          })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPending(null)}
                        >
                          {t("conflict.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}
