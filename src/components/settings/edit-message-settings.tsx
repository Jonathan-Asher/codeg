"use client"

/**
 * What "Edit message" does with the version of the conversation before the
 * edit — the settings-page half of `lib/edit-message-prefs`.
 *
 * Off (the default), an edit continues the same conversation in place and the
 * original is hidden. On, the original stays in the sidebar as a conversation
 * of its own, named "… (before edit)".
 */

import { useTranslations } from "next-intl"
import { CopyPlus } from "lucide-react"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import { useKeepOriginalOnEdit } from "@/lib/edit-message-prefs"

export function EditMessageSettingsSection() {
  const t = useTranslations("EditMessageSettings")
  const [keepOriginal, setKeepOriginal] = useKeepOriginalOnEdit()

  return (
    <SettingsSection
      icon={CopyPlus}
      title={t("title")}
      description={t("description")}
      htmlFor="edit-message-keep-original"
      control={
        <Switch
          id="edit-message-keep-original"
          checked={keepOriginal}
          onCheckedChange={setKeepOriginal}
        />
      }
    />
  )
}
