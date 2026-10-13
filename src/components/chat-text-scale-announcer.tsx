"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useChatTextScale } from "@/hooks/use-appearance"

/** One toast, updated in place while the key is held or pressed again. */
export const CHAT_TEXT_SCALE_TOAST_ID = "chat-text-scale"

/**
 * Shows the chat text size for a moment after a chat-text shortcut, also at
 * either end of the range, where the keys change nothing and the toast is the
 * only sign they were heard. Changes from Settings (which shows the value
 * itself) or from another window stay silent.
 *
 * Its own component rather than part of AppearanceProvider so the provider
 * stays free of the i18n context; a window without a toaster shows nothing.
 */
export function ChatTextScaleAnnouncer() {
  const t = useTranslations("AppearanceSettings.chatTextSize")
  const { chatTextScaleNotice } = useChatTextScale()
  // Only a new press announces; a re-render (a locale switch hands over a new
  // `t`) must not replay the last one.
  const announcedSeqRef = useRef(0)

  useEffect(() => {
    if (!chatTextScaleNotice) return
    if (chatTextScaleNotice.seq === announcedSeqRef.current) return
    announcedSeqRef.current = chatTextScaleNotice.seq
    toast(t("toast", { percent: chatTextScaleNotice.level }), {
      id: CHAT_TEXT_SCALE_TOAST_ID,
      duration: 1500,
    })
  }, [chatTextScaleNotice, t])

  return null
}
