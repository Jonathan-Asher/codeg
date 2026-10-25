"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useSessionColumnWidth } from "@/hooks/use-appearance"
import { useSessionColumnWidthLabel } from "@/hooks/use-session-column-width-label"

/** One toast, updated in place on repeated presses. */
export const SESSION_COLUMN_WIDTH_TOAST_ID = "session-column-width"

/**
 * Names the new session width for a moment after the cycle shortcut, which
 * otherwise changes the layout with nothing on screen to say what it chose.
 * Changes from Settings or the ⋯ menu (which show the value themselves) and
 * from another window stay silent. Kept out of AppearanceProvider so the
 * provider stays free of the i18n context, like the chat text size's.
 */
export function SessionColumnWidthAnnouncer() {
  const t = useTranslations("AppearanceSettings.sessionWidth")
  const label = useSessionColumnWidthLabel()
  const { sessionColumnWidthNotice } = useSessionColumnWidth()
  const announcedSeqRef = useRef(0)

  useEffect(() => {
    if (!sessionColumnWidthNotice) return
    if (sessionColumnWidthNotice.seq === announcedSeqRef.current) return
    announcedSeqRef.current = sessionColumnWidthNotice.seq
    toast(t("toast", { label: label(sessionColumnWidthNotice.width) }), {
      id: SESSION_COLUMN_WIDTH_TOAST_ID,
      duration: 1500,
    })
  }, [sessionColumnWidthNotice, t, label])

  return null
}
