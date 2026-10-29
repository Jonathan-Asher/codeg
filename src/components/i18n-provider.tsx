"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl"
import { getFallbackMessages, getMessagesForLocale } from "@/i18n/messages"
import {
  fromIntlLocale,
  getSystemLocaleCandidates,
  LANGUAGE_COOKIE_KEY,
  LANGUAGE_MODE_COOKIE_KEY,
  LANGUAGE_SETTINGS_STORAGE_KEY,
  normalizeLanguageSettings,
  resolveAppLocale,
  toIntlLocale,
  type IntlLocale,
} from "@/lib/i18n"
import { getSystemLanguageSettings } from "@/lib/api"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { localeDirection } from "@/lib/text-direction"
import { AppBootLoading } from "@/components/layout/app-boot-loading"
import type { AppLocale, SystemLanguageSettings } from "@/lib/types"

interface AppI18nContextValue {
  appLocale: AppLocale
  languageSettings: SystemLanguageSettings
  languageSettingsLoaded: boolean
  setLanguageSettings: (settings: SystemLanguageSettings) => void
}

const AppI18nContext = createContext<AppI18nContextValue | null>(null)
const LANGUAGE_SETTINGS_UPDATED_EVENT = "app://language-settings-updated"
/** Background retries of a failed startup load, and the waits before them. */
export const STARTUP_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

function subscribeSystemLocale(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {}

  window.addEventListener("languagechange", onStoreChange)
  return () => {
    window.removeEventListener("languagechange", onStoreChange)
  }
}

function getSystemLocaleSnapshot(): string {
  return getSystemLocaleCandidates().join("|")
}

function getSystemLocaleServerSnapshot(): string {
  return ""
}

function persistLanguageSettings(settings: SystemLanguageSettings) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(
      LANGUAGE_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings)
    )
  } catch {
    // Ignore write failures (e.g. disabled storage).
  }
}

function persistLanguageCookies(
  settings: SystemLanguageSettings,
  appLocale: AppLocale
) {
  if (typeof document === "undefined") return

  const maxAge = 60 * 60 * 24 * 365
  document.cookie = `${LANGUAGE_MODE_COOKIE_KEY}=${settings.mode}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
  document.cookie = `${LANGUAGE_COOKIE_KEY}=${toIntlLocale(appLocale)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

export function useAppI18n() {
  const context = useContext(AppI18nContext)
  if (!context) {
    throw new Error("useAppI18n must be used within AppI18nProvider")
  }
  return context
}

interface AppI18nProviderProps {
  children: React.ReactNode
  initialLocale?: IntlLocale
  initialMessages?: AbstractIntlMessages
}

export function AppI18nProvider({
  children,
  initialLocale = "en",
  initialMessages,
}: AppI18nProviderProps) {
  const initialAppLocale = fromIntlLocale(initialLocale)
  const [languageSettings, setLanguageSettingsState] =
    useState<SystemLanguageSettings>({
      mode: "manual",
      language: initialAppLocale,
    })
  const [languageSettingsLoaded, setLanguageSettingsLoaded] = useState(false)
  const [messages, setMessages] = useState<AbstractIntlMessages>(
    initialMessages ?? getFallbackMessages()
  )
  const [messagesLocale, setMessagesLocale] = useState<AppLocale>(
    initialMessages ? initialAppLocale : "en"
  )

  const systemLocaleSnapshot = useSyncExternalStore(
    subscribeSystemLocale,
    getSystemLocaleSnapshot,
    getSystemLocaleServerSnapshot
  )
  const systemLocaleCandidates = useMemo(
    () => (systemLocaleSnapshot ? systemLocaleSnapshot.split("|") : []),
    [systemLocaleSnapshot]
  )

  const setLanguageSettings = useCallback(
    (settings: SystemLanguageSettings) => {
      const normalized = normalizeLanguageSettings(settings)
      setLanguageSettingsState(normalized)
      persistLanguageSettings(normalized)
    },
    []
  )

  useEffect(() => {
    if (typeof window === "undefined") return

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_SETTINGS_STORAGE_KEY || !event.newValue) return

      try {
        const next = normalizeLanguageSettings(
          JSON.parse(event.newValue) as SystemLanguageSettings
        )
        setLanguageSettingsState(next)
      } catch {
        // Ignore malformed storage payloads.
      }
    }

    window.addEventListener("storage", onStorage)

    let unlisten: (() => void) | null = null
    let cancelled = false

    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SystemLanguageSettings>(
          LANGUAGE_SETTINGS_UPDATED_EVENT,
          (event) => {
            if (cancelled) return
            setLanguageSettings(event.payload)
          }
        )
      )
      .then((dispose) => {
        if (cancelled) {
          disposeTauriListener(dispose, "I18nProvider.languageSettings")
          return
        }
        unlisten = dispose
      })
      .catch(() => {
        // Ignore when running in non-tauri environment.
      })

    return () => {
      cancelled = true
      window.removeEventListener("storage", onStorage)
      disposeTauriListener(unlisten, "I18nProvider.languageSettings")
    }
  }, [setLanguageSettings])

  // The saved language. A failed load (the server restarting, a browser
  // tab opened while it was down) must not hold the window on the boot
  // screen: it renders at once with the locale it started with, and the
  // load is retried in the background until it answers.
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const load = (attempt: number) => {
      getSystemLanguageSettings()
        .then((settings) => {
          if (cancelled) return
          setLanguageSettings(settings)
        })
        .catch((err) => {
          if (cancelled) return
          console.warn("[i18n] load language settings failed:", err)
          const delay = STARTUP_RETRY_DELAYS_MS[attempt]
          if (delay !== undefined) {
            retryTimer = setTimeout(() => load(attempt + 1), delay)
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLanguageSettingsLoaded(true)
          }
        })
    }
    load(0)

    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [setLanguageSettings])

  const appLocale = useMemo(
    () => resolveAppLocale(languageSettings, systemLocaleCandidates),
    [languageSettings, systemLocaleCandidates]
  )

  useEffect(() => {
    if (!languageSettingsLoaded) return
    persistLanguageCookies(languageSettings, appLocale)
  }, [appLocale, languageSettings, languageSettingsLoaded])

  // Push the resolved locale to the system tray menu (Tauri only). The
  // tray was built once at app startup with whatever was persisted then,
  // so without this it would stay stale after a language change.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("__TAURI_INTERNALS__" in window)) return
    void import("@/lib/tauri")
      .then((t) => t.setTrayLocale(appLocale))
      .catch(() => {
        // Tray refresh is best-effort: the tray may not be installed
        // (Linux without a status-bar host), and a stale label is a
        // smaller problem than crashing the i18n provider.
      })
  }, [appLocale])

  // The locale's messages are a chunk the page loads on demand — from the
  // server, in a browser. When that fails the window renders with the
  // messages it already has (instead of staying on the boot screen for good)
  // and the load is retried a few times, further apart each time.
  const [messagesFailedFor, setMessagesFailedFor] = useState<AppLocale | null>(
    null
  )
  const [messagesAttempt, setMessagesAttempt] = useState(0)
  useEffect(() => {
    if (appLocale === messagesLocale) {
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    getMessagesForLocale(appLocale)
      .then((nextMessages) => {
        if (!cancelled) {
          setMessages(nextMessages)
          setMessagesLocale(appLocale)
          setMessagesFailedFor(null)
          setMessagesAttempt(0)
        }
      })
      .catch((err) => {
        if (cancelled) return
        console.warn("[i18n] load locale messages failed:", err)
        setMessagesFailedFor(appLocale)
        const delay = STARTUP_RETRY_DELAYS_MS[messagesAttempt]
        if (delay !== undefined) {
          retryTimer = setTimeout(() => setMessagesAttempt((n) => n + 1), delay)
        }
      })

    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [appLocale, messagesLocale, messagesAttempt])

  const localeReady =
    appLocale === messagesLocale || messagesFailedFor === appLocale
  const appReady = languageSettingsLoaded && localeReady
  const activeIntlLocale = toIntlLocale(messagesLocale)

  useEffect(() => {
    document.documentElement.lang = activeIntlLocale
    document.documentElement.dir = localeDirection(activeIntlLocale)
  }, [activeIntlLocale])

  const contextValue = useMemo<AppI18nContextValue>(
    () => ({
      appLocale,
      languageSettings,
      languageSettingsLoaded,
      setLanguageSettings,
    }),
    [appLocale, languageSettings, languageSettingsLoaded, setLanguageSettings]
  )

  return (
    <AppI18nContext.Provider value={contextValue}>
      <NextIntlClientProvider locale={activeIntlLocale} messages={messages}>
        {appReady ? children : <AppBootLoading />}
      </NextIntlClientProvider>
    </AppI18nContext.Provider>
  )
}
