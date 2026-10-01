"use client"

/**
 * Whether the search dialog opens on recent sessions — the settings-page half
 * of `lib/search-recent-prefs`.
 *
 * On (the default), search with nothing typed lists the current session first
 * and the most recently active sessions below it. Off, it waits for a query.
 */

import { useTranslations } from "next-intl"
import { History } from "lucide-react"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { useShowRecentOnSearch } from "@/lib/search-recent-prefs"

export function SearchSettingsSection() {
  const t = useTranslations("SearchSettings")
  const [showRecent, setShowRecent] = useShowRecentOnSearch()

  return (
    <SettingsSection
      icon={History}
      title={t("title")}
      description={t("description")}
      htmlFor="search-show-recent"
      control={
        <Switch
          id="search-show-recent"
          checked={showRecent}
          onCheckedChange={setShowRecent}
        />
      }
    />
  )
}
