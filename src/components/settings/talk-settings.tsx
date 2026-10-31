"use client"

/**
 * "Talk mode" — how the agent answers in the phone's Talk mode, a hands-free
 * voice conversation with one session held from the codeg iOS app (see
 * `lib/talk-mode.ts`): the language of its replies, and how it addresses the
 * user in Hebrew.
 *
 * Global, and stored by the backend the phone talks to, so the desktop app
 * and a browser on a server edit the same settings. A change reaches every
 * session with its next message.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AudioLines, Languages, UserRound } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getTalkSettings, updateTalkSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  TALK_ADDRESSES,
  TALK_ADDRESS_LABEL_KEYS,
  TALK_LANGUAGES,
  TALK_LANGUAGE_LABEL_KEYS,
} from "@/lib/talk-mode"
import type { TalkAddress, TalkLanguage, TalkSettings } from "@/lib/types"

export function TalkSettingsSection() {
  const t = useTranslations("TalkSettings")
  const [settings, setSettings] = useState<TalkSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    getTalkSettings()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err) => {
        console.error("[Settings] load talk settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (next: TalkSettings, prev: TalkSettings) => {
      setSettings(next)
      try {
        setSettings(await updateTalkSettings(next))
      } catch (err) {
        setSettings(prev)
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  // Hidden until the stored values are known, like the other backend-stored
  // settings: a control in a guessed position invites a false "confirm".
  if (!settings) return null

  return (
    <SettingsSection
      icon={AudioLines}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          icon={Languages}
          title={t("languageTitle")}
          description={t("languageHint")}
          control={
            <Select
              value={settings.language}
              onValueChange={(value) =>
                void save(
                  { ...settings, language: value as TalkLanguage },
                  settings
                )
              }
            >
              <SelectTrigger
                size="sm"
                className="w-48 bg-background text-xs"
                aria-label={t("languageTitle")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {TALK_LANGUAGES.map((language) => (
                  <SelectItem key={language} value={language}>
                    {t(TALK_LANGUAGE_LABEL_KEYS[language])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          icon={UserRound}
          title={t("addressTitle")}
          description={t("addressHint")}
          control={
            <Select
              value={settings.address}
              onValueChange={(value) =>
                void save(
                  { ...settings, address: value as TalkAddress },
                  settings
                )
              }
            >
              <SelectTrigger
                size="sm"
                className="w-48 bg-background text-xs"
                aria-label={t("addressTitle")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {TALK_ADDRESSES.map((address) => (
                  <SelectItem key={address} value={address}>
                    {t(TALK_ADDRESS_LABEL_KEYS[address])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingCard>
    </SettingsSection>
  )
}
