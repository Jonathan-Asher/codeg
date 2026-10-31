"use client"

/**
 * The Talk badge on a session's sidebar row, tab and header: the user is
 * holding a voice conversation with it from the phone (see
 * `lib/talk-mode.ts`).
 */

import { AudioLines } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export function TalkBadge({ className }: { className?: string }) {
  const t = useTranslations("Folder.sidebar")
  return (
    <span
      data-talk-badge
      className={cn("inline-flex shrink-0 items-center", className)}
      title={t("talkBadge")}
    >
      <AudioLines className="h-3 w-3 text-sky-500" aria-hidden />
      <span className="sr-only">{t("talkBadge")}</span>
    </span>
  )
}
