"use client"

import { Mic } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * Beside a user message spoken through the phone's Talk mode rather than
 * typed (see `MessageTurn.spoken`). Always shown, unlike the message's hover
 * actions it sits next to, and sized like them so the row lines up.
 */
export function SpokenMarker() {
  const t = useTranslations("Folder.chat.messageList")
  return (
    <span
      data-spoken-marker
      className="flex size-6 shrink-0 items-center justify-center self-end text-muted-foreground/70"
      title={t("spokenMessage")}
    >
      <Mic className="size-3" aria-hidden />
      <span className="sr-only">{t("spokenMessage")}</span>
    </span>
  )
}
