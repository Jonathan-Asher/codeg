"use client"

/**
 * The red flag on a critical session's sidebar row and tab: the backend
 * alerts when that session sits idle (see `lib/critical-sessions.ts`).
 */

import { Flag } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export function CriticalFlag({ className }: { className?: string }) {
  const t = useTranslations("Folder.sidebar")
  return (
    <span
      data-critical-flag
      className={cn("inline-flex shrink-0 items-center", className)}
      title={t("criticalBadge")}
    >
      <Flag className="h-3 w-3 fill-red-500 text-red-500" aria-hidden />
      <span className="sr-only">{t("criticalBadge")}</span>
    </span>
  )
}
