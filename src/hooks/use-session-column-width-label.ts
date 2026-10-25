"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import type { SessionColumnWidth } from "@/lib/session-column-width"

/**
 * The name of a session width as Settings, the conversation ⋯ menu and the
 * cycle toast show it: "Wide", "Full width", "Custom (1100 px)".
 */
export function useSessionColumnWidthLabel() {
  const t = useTranslations("AppearanceSettings.sessionWidth")
  return useCallback(
    (width: SessionColumnWidth): string => {
      if (typeof width === "number") return t("customValue", { px: width })
      switch (width) {
        case "standard":
          return t("presets.standard")
        case "wide":
          return t("presets.wide")
        case "extra-wide":
          return t("presets.extraWide")
        case "full":
          return t("presets.full")
      }
    },
    [t]
  )
}
