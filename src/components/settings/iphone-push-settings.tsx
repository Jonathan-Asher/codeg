"use client"

/**
 * "iPhone push" — codeg's own backend sends its notifications to the user's
 * iPhone through Apple's push service (APNs), signed with the team's `.p8`
 * key (`src-tauri/src/push/`). Here: the key and its ids, the devices the
 * iOS app registered, each device's preferences, and a test send that shows
 * Apple's real answer. See `docs/ios-push.md`.
 *
 * Stored by the backend that sends (per data directory), like the critical
 * session settings above it. The key goes into that backend's keychain and
 * never comes back to the page.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  BellRing,
  KeyRound,
  Send,
  Smartphone,
  Trash2,
  Upload,
} from "lucide-react"
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
  getPushSettings,
  listPushDevices,
  sendTestPush,
  unregisterPushDevice,
  updatePushDevicePrefs,
  updatePushSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  ApnsEnvironment,
  PushDelivery,
  PushDevice,
  PushDevicePrefs,
  PushSettings,
  PushSettingsView,
  TestPushResult,
} from "@/lib/types"

const DELIVERY_LABEL = {
  always: "deliveryAlways",
  away: "deliveryAway",
  off: "deliveryOff",
} as const

const DELIVERIES: readonly PushDelivery[] = ["always", "away", "off"]

const ENVIRONMENT_LABEL = {
  production: "environmentProduction",
  sandbox: "environmentSandbox",
} as const

type DeliveryPref = "turn_finished" | "needs_you"
type SwitchPref = "critical" | "errors"

const DELIVERY_PREFS = [
  { key: "turn_finished", label: "prefTurnFinished" },
  { key: "needs_you", label: "prefNeedsYou" },
] as const satisfies readonly { key: DeliveryPref; label: string }[]

const SWITCH_PREFS = [
  { key: "critical", label: "prefCritical" },
  { key: "errors", label: "prefErrors" },
] as const satisfies readonly { key: SwitchPref; label: string }[]

function formFrom(view: PushSettingsView): PushSettings {
  return {
    team_id: view.team_id,
    key_id: view.key_id,
    bundle_id: view.bundle_id,
    environment: view.environment,
    language: view.language,
  }
}

export function IphonePushSettingsSection() {
  const t = useTranslations("PushSettings")
  const locale = useLocale()
  const [view, setView] = useState<PushSettingsView | null>(null)
  const [form, setForm] = useState<PushSettings | null>(null)
  const [keyText, setKeyText] = useState("")
  const [devices, setDevices] = useState<PushDevice[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<TestPushResult[] | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadDevices = useCallback(() => {
    listPushDevices()
      .then(setDevices)
      .catch((err) => {
        console.error("[Settings] list push devices failed:", err)
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    getPushSettings()
      .then((next) => {
        if (cancelled) return
        setView(next)
        setForm(formFrom(next))
      })
      .catch((err) => {
        console.error("[Settings] load push settings failed:", err)
      })
    listPushDevices()
      .then((next) => {
        if (!cancelled) setDevices(next)
      })
      .catch((err) => {
        console.error("[Settings] list push devices failed:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(
    async (authKey?: string) => {
      if (!form) return
      setSaving(true)
      try {
        // The notifications are worded in the app's language.
        const next = await updatePushSettings(
          { ...form, language: locale },
          authKey
        )
        setView(next)
        setForm(formFrom(next))
        setKeyText("")
        toast.success(t("saved"))
      } catch (err) {
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [form, locale, t]
  )

  const chooseFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file) return
      setKeyText((await file.text()).trim())
    },
    []
  )

  const removeDevice = useCallback(
    async (device: PushDevice) => {
      try {
        await unregisterPushDevice(device.id)
        setDevices((prev) => prev.filter((d) => d.id !== device.id))
      } catch (err) {
        toast.error(t("removeFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  const setPrefs = useCallback(
    async (device: PushDevice, prefs: PushDevicePrefs) => {
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, prefs } : d))
      )
      try {
        const updated = await updatePushDevicePrefs(device.id, prefs)
        setDevices((prev) =>
          prev.map((d) => (d.id === updated.id ? updated : d))
        )
      } catch (err) {
        setDevices((prev) => prev.map((d) => (d.id === device.id ? device : d)))
        toast.error(t("prefsFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  const sendTest = useCallback(async () => {
    setTesting(true)
    setTestResults(null)
    setTestError(null)
    try {
      const results = await sendTestPush()
      setTestResults(results)
      if (results.some((r) => r.removed)) loadDevices()
    } catch (err) {
      setTestError(toErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }, [loadDevices])

  // Hidden until the stored values are known, like the other backend-stored
  // settings.
  if (!view || !form) return null

  const field = (
    key: "team_id" | "key_id" | "bundle_id",
    id: string,
    placeholder: string
  ) => (
    <Input
      id={id}
      value={form[key]}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className="h-8 bg-background font-mono text-xs"
      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
    />
  )

  return (
    <SettingsSection
      icon={Smartphone}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow
          title={t("teamId")}
          description={t("teamIdHint")}
          htmlFor="push-team-id"
        >
          {field("team_id", "push-team-id", "3L92BZK46V")}
        </SettingRow>
        <SettingRow
          title={t("keyId")}
          description={t("keyIdHint")}
          htmlFor="push-key-id"
        >
          {field("key_id", "push-key-id", "3Y8TW4TVF2")}
        </SettingRow>
        <SettingRow
          title={t("bundleId")}
          description={t("bundleIdHint")}
          htmlFor="push-bundle-id"
        >
          {field("bundle_id", "push-bundle-id", "io.ashurov.codeg")}
        </SettingRow>
        <SettingRow
          title={t("environment")}
          description={t("environmentHint")}
          control={
            <Select
              value={form.environment}
              onValueChange={(value) =>
                setForm({ ...form, environment: value as ApnsEnvironment })
              }
            >
              <SelectTrigger
                size="sm"
                className="w-36 bg-background text-xs"
                aria-label={t("environment")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(["production", "sandbox"] as const).map((env) => (
                  <SelectItem key={env} value={env}>
                    {t(ENVIRONMENT_LABEL[env])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          icon={KeyRound}
          title={t("key")}
          description={
            view.key_error
              ? t("keyReadError", { message: view.key_error })
              : view.has_key
                ? t("keyStored")
                : t("keyMissing")
          }
          htmlFor="push-key"
          control={
            view.has_key ? (
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
          <Textarea
            id="push-key"
            value={keyText}
            placeholder={t("keyPlaceholder")}
            spellCheck={false}
            rows={3}
            className="bg-background font-mono text-xs"
            onChange={(event) => setKeyText(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".p8,text/plain"
              className="hidden"
              data-testid="push-key-file"
              onChange={(event) => void chooseFile(event)}
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden />
              {t("chooseFile")}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={saving}
              onClick={() => void save(keyText.trim() ? keyText : undefined)}
            >
              {t("save")}
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          icon={BellRing}
          title={view.configured ? t("configured") : t("notConfigured")}
          description={t("serverId", { id: view.server_id })}
          control={
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={testing}
              onClick={() => void sendTest()}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              {testing ? t("sending") : t("sendTest")}
            </Button>
          }
        >
          {testError ? (
            <p role="alert" className="text-xs leading-5 text-destructive">
              {t("testError", { message: testError })}
            </p>
          ) : null}
          {testResults
            ? testResults.map((result) => (
                <p
                  key={result.device_id}
                  role={result.ok ? "status" : "alert"}
                  className={
                    result.ok
                      ? "text-xs leading-5 text-muted-foreground"
                      : "text-xs leading-5 text-destructive"
                  }
                >
                  {result.ok
                    ? t("testSent", { name: result.name })
                    : t("testFailed", {
                        name: result.name,
                        error: result.error ?? "",
                      })}
                </p>
              ))
            : null}
        </SettingRow>
      </SettingCard>

      <SettingCard className="mt-3">
        <SettingRow
          icon={Smartphone}
          title={t("devicesTitle")}
          description={devices.length === 0 ? t("devicesEmpty") : t("awayHint")}
        />
        {devices.map((device) => (
          <div key={device.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm">{device.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("deviceMeta", {
                    environment: device.environment,
                    token: device.token_hint,
                    lastSeen: new Date(device.last_seen_at).toLocaleString(
                      locale
                    ),
                  })}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={t("removeDevice", { name: device.name })}
                onClick={() => void removeDevice(device)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {t("remove")}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DELIVERY_PREFS.map(({ key, label }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span>{t(label)}</span>
                  <Select
                    value={device.prefs[key]}
                    onValueChange={(value) =>
                      void setPrefs(device, {
                        ...device.prefs,
                        [key]: value as PushDelivery,
                      })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-36 bg-background text-xs"
                      aria-label={`${device.name}: ${t(label)}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {DELIVERIES.map((delivery) => (
                        <SelectItem key={delivery} value={delivery}>
                          {t(DELIVERY_LABEL[delivery])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              {SWITCH_PREFS.map(({ key, label }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span>{t(label)}</span>
                  <Switch
                    checked={device.prefs[key]}
                    aria-label={`${device.name}: ${t(label)}`}
                    onCheckedChange={(checked) =>
                      void setPrefs(device, { ...device.prefs, [key]: checked })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </SettingCard>
    </SettingsSection>
  )
}
