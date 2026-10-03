"use client"

/**
 * "Dictation clean-up and translation". A client that transcribes speech on
 * its own (the codeg iOS app dictates Hebrew with an on-device Whisper) sends
 * the transcript to `refine_dictation`; the backend cleans it up and/or
 * translates it with the provider picked here (`src-tauri/src/dictation_refine/`).
 * See `docs/dictation-refine.md`.
 *
 * Stored by the backend the client talks to. Provider keys go into that
 * backend's keychain and never come back to the page: only "a key is saved".
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRound, Languages, Play, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  getDictationRefineSettings,
  refineDictation,
  updateDictationRefineSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  DictationRefineProviderId,
  DictationRefineSettings,
  DictationRefineSettingsView,
  RefineDictationResult,
} from "@/lib/types"

const PROVIDER_LABEL = {
  groq: "providerGroq",
  cerebras: "providerCerebras",
  openai: "providerOpenai",
  anthropic: "providerAnthropic",
  google: "providerGoogle",
  custom: "providerCustom",
} as const satisfies Record<DictationRefineProviderId, string>

/** A dictation with the filler and false start clean-up is meant to remove. */
export const DICTATION_TEST_SAMPLE =
  "אה… תשמע, בעצם, אני צריך לשלוח, אני צריך לשלוח את המסמך ללקוח עד מחר בבוקר."

/** Picking another provider drops the model override: model ids rarely
 *  carry across providers (the backend does the same). */
export function withProvider(
  form: DictationRefineSettings,
  provider: DictationRefineProviderId
): DictationRefineSettings {
  return provider === form.provider ? form : { ...form, provider, model: "" }
}

function formFrom(view: DictationRefineSettingsView): DictationRefineSettings {
  return {
    provider: view.provider,
    model: view.model,
    endpoint: view.endpoint,
    targetLanguage: view.targetLanguage,
    refine: view.refine,
    translate: view.translate,
    instructions: view.instructions,
  }
}

function sameForm(a: DictationRefineSettings, b: DictationRefineSettings) {
  return (Object.keys(a) as (keyof DictationRefineSettings)[]).every(
    (key) => a[key] === b[key]
  )
}

export function DictationRefineSettingsSection() {
  const t = useTranslations("DictationRefineSettings")
  const [view, setView] = useState<DictationRefineSettingsView | null>(null)
  const [form, setForm] = useState<DictationRefineSettings | null>(null)
  const [keyText, setKeyText] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RefineDictationResult | null>(
    null
  )
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getDictationRefineSettings()
      .then((next) => {
        if (cancelled) return
        setView(next)
        setForm(formFrom(next))
      })
      .catch((err) => {
        console.error("[Settings] load dictation settings failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** `apiKey`: omit to keep the stored key, "" to remove it. */
  const persist = useCallback(
    async (apiKey?: string) => {
      if (!form) return
      setSaving(true)
      try {
        const next = await updateDictationRefineSettings(
          apiKey === undefined ? form : { ...form, apiKey }
        )
        setView(next)
        setForm(formFrom(next))
        setKeyText("")
      } finally {
        setSaving(false)
      }
    },
    [form]
  )

  const save = useCallback(
    async (apiKey?: string) => {
      try {
        await persist(apiKey)
        toast.success(t("saved"))
      } catch (err) {
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      }
    },
    [persist, t]
  )

  const typedKey = keyText.trim()
  const dirty = !!view && !!form && !sameForm(form, formFrom(view))

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      // Test what is on screen: unsaved edits and a typed key go first.
      if (dirty || typedKey) await persist(typedKey || undefined)
      setTestResult(
        await refineDictation({
          text: DICTATION_TEST_SAMPLE,
          sourceLanguage: "Hebrew",
        })
      )
    } catch (err) {
      setTestError(toErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }, [dirty, persist, typedKey])

  // Hidden until the stored values are known, like the other backend-stored
  // settings.
  if (!view || !form) return null

  const selected = view.providers.find((p) => p.id === form.provider)
  const hasKey = selected?.hasKey ?? false
  const isGoogle = form.provider === "google"
  const isCustom = form.provider === "custom"

  const keyDescription = view.keyError
    ? t("keyReadError", { message: view.keyError })
    : hasKey
      ? t("keySaved")
      : isCustom
        ? t("keyOptional")
        : t("keyMissing")

  return (
    <SettingsSection
      icon={Languages}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          title={t("provider")}
          description={t("providerHint")}
          control={
            <Select
              value={form.provider}
              onValueChange={(value) =>
                setForm(withProvider(form, value as DictationRefineProviderId))
              }
            >
              <SelectTrigger
                size="sm"
                className="w-56 bg-background text-xs"
                aria-label={t("provider")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {view.providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {t(PROVIDER_LABEL[provider.id])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {isCustom ? (
          <SettingRow
            title={t("endpoint")}
            description={t("endpointHint")}
            htmlFor="dictation-endpoint"
          >
            <Input
              id="dictation-endpoint"
              value={form.endpoint}
              placeholder="https://example.com/v1"
              autoComplete="off"
              spellCheck={false}
              className="h-8 bg-background font-mono text-xs"
              onChange={(event) =>
                setForm({ ...form, endpoint: event.target.value })
              }
            />
          </SettingRow>
        ) : null}
        {isGoogle ? null : (
          <SettingRow
            title={t("model")}
            description={
              selected?.defaultModel
                ? t("modelHint", { model: selected.defaultModel })
                : t("modelRequired")
            }
            htmlFor="dictation-model"
          >
            <Input
              id="dictation-model"
              value={form.model}
              placeholder={selected?.defaultModel ?? ""}
              autoComplete="off"
              spellCheck={false}
              className="h-8 bg-background font-mono text-xs"
              onChange={(event) =>
                setForm({ ...form, model: event.target.value })
              }
            />
          </SettingRow>
        )}
        <SettingRow
          icon={KeyRound}
          title={t("apiKey")}
          description={keyDescription}
          htmlFor="dictation-api-key"
          control={
            hasKey ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={saving}
                onClick={() => void save("")}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {t("removeKey")}
              </Button>
            ) : null
          }
        >
          <Input
            id="dictation-api-key"
            type="password"
            value={keyText}
            placeholder={
              hasKey ? t("keyPlaceholderSaved") : t("keyPlaceholder")
            }
            autoComplete="off"
            spellCheck={false}
            className="h-8 bg-background font-mono text-xs"
            onChange={(event) => setKeyText(event.target.value)}
          />
        </SettingRow>
      </SettingCard>

      <SettingCard className="mt-3">
        <SettingRow
          title={t("refine")}
          description={isGoogle ? t("googleCannotRefine") : t("refineHint")}
          control={
            <Switch
              checked={form.refine}
              aria-label={t("refine")}
              onCheckedChange={(checked) =>
                setForm({ ...form, refine: checked })
              }
            />
          }
        />
        <SettingRow
          title={t("translate")}
          description={t("translateHint")}
          control={
            <Switch
              checked={form.translate}
              aria-label={t("translate")}
              onCheckedChange={(checked) =>
                setForm({ ...form, translate: checked })
              }
            />
          }
        />
        <SettingRow
          title={t("targetLanguage")}
          description={t("targetLanguageHint")}
          htmlFor="dictation-target-language"
          control={
            <Input
              id="dictation-target-language"
              value={form.targetLanguage}
              placeholder="English"
              autoComplete="off"
              className="h-8 w-40 bg-background text-xs"
              onChange={(event) =>
                setForm({ ...form, targetLanguage: event.target.value })
              }
            />
          }
        />
        <SettingRow
          title={t("instructions")}
          description={t("instructionsHint")}
          htmlFor="dictation-instructions"
        >
          <Textarea
            id="dictation-instructions"
            value={form.instructions}
            placeholder={t("instructionsPlaceholder")}
            rows={3}
            className="bg-background text-xs"
            onChange={(event) =>
              setForm({ ...form, instructions: event.target.value })
            }
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="xs"
              disabled={saving}
              onClick={() => void save(typedKey || undefined)}
            >
              {t("save")}
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          icon={Play}
          title={view.configured ? t("configured") : t("notConfigured")}
          description={t("testHint")}
          control={
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={testing || saving}
              onClick={() => void runTest()}
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {testing ? t("testing") : t("test")}
            </Button>
          }
        >
          {testError ? (
            <p role="alert" className="text-xs leading-5 text-destructive">
              {t("testError", { message: testError })}
            </p>
          ) : null}
          {testResult ? (
            <div role="status" className="flex flex-col gap-1 text-xs">
              <p dir="auto" className="leading-5">
                {testResult.text}
              </p>
              <p className="text-muted-foreground">
                {t("testMeta", {
                  provider: testResult.provider,
                  model: testResult.model,
                  ms: testResult.elapsedMs,
                })}
              </p>
            </div>
          ) : null}
        </SettingRow>
      </SettingCard>
    </SettingsSection>
  )
}
