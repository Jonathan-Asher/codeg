"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import {
  Bot,
  Bubbles,
  Compass,
  FileSpreadsheet,
  GitBranch,
  Globe,
  Keyboard,
  Menu,
  MessageSquareText,
  MonitorCog,
  SendHorizontal,
  Palette,
  Server,
  Settings,
  SlidersHorizontal,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { usePathname } from "next/navigation"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppToaster } from "@/components/ui/app-toaster"
import { cn } from "@/lib/utils"
import {
  detectEnvironment,
  type TransportEnvironment,
} from "@/lib/transport/detect"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { useIsMobile } from "@/hooks/use-mobile"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { SettingsSearch } from "@/components/settings/settings-search"
import {
  formatShortcutLabel,
  isShortcutRecorderArmed,
  matchShortcutEvent,
} from "@/lib/keyboard-shortcuts"
import type {
  SettingsPageKey,
  SettingsSearchEntry,
} from "@/lib/settings-search/registry"
import { revealAnchorsFor } from "@/lib/settings-search/search"
import {
  revealSettingsAnchor,
  setPendingSettingsReveal,
  takePendingSettingsReveal,
} from "@/lib/settings-search/reveal"

interface SettingsNavItem {
  href: string
  /** Also the page's key in the settings search registry. */
  labelKey: SettingsPageKey
  icon: ComponentType<{ className?: string }>
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    href: "/settings/appearance",
    labelKey: "appearance",
    icon: Palette,
  },
  {
    href: "/settings/general",
    labelKey: "general",
    icon: SlidersHorizontal,
  },
  {
    href: "/settings/collaboration",
    labelKey: "collaboration",
    icon: Bubbles,
  },
  {
    href: "/settings/agents",
    labelKey: "agents",
    icon: Bot,
  },
  {
    href: "/settings/model-providers",
    labelKey: "model_providers",
    icon: Server,
  },
  {
    href: "/settings/quick-messages",
    labelKey: "quick_messages",
    icon: MessageSquareText,
  },
  {
    href: "/settings/browser",
    labelKey: "browser",
    icon: Compass,
  },
  {
    href: "/settings/computer-use",
    labelKey: "computer_use",
    icon: MonitorCog,
  },
  {
    href: "/settings/shortcuts",
    labelKey: "shortcuts",
    icon: Keyboard,
  },
  {
    href: "/settings/version-control",
    labelKey: "version_control",
    icon: GitBranch,
  },
  {
    href: "/settings/chat-channels",
    labelKey: "chat_channels",
    icon: SendHorizontal,
  },
  {
    href: "/settings/web-service",
    labelKey: "web_service",
    icon: Globe,
  },
  {
    href: "/settings/logs",
    labelKey: "logs",
    icon: FileSpreadsheet,
  },
  {
    href: "/settings/system",
    labelKey: "system",
    icon: Settings,
  },
]

interface SettingsShellProps {
  children: ReactNode
}

/**
 * The nav for one runtime. Only one entry is runtime-bound: the Web service
 * page configures the server a web client is already talking to, and there is
 * no such server to configure from inside it.
 *
 * The Browser page is deliberately not on that list. Most of what it holds is
 * a desktop browser engine, but site rules, what a server starting in a
 * terminal does and the terminal's link menu all still decide something in a
 * browser session, and that page is the only place they can be set.
 */
export function settingsNavItemsFor(
  env: TransportEnvironment
): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter(
    (item) => !(item.labelKey === "web_service" && env === "web")
  )
}

function normalizePath(path: string): string {
  const noSuffix = path.replace(/\/index\.html$/, "").replace(/\.html$/, "")
  const noTrailingSlash = noSuffix.replace(/\/+$/, "")
  return noTrailingSlash || "/"
}

function isWindowsRuntime(): boolean {
  if (typeof navigator === "undefined") return false
  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  return platform.includes("win") || userAgent.includes("windows")
}

export function SettingsShell({ children }: SettingsShellProps) {
  const t = useTranslations("SettingsShell")
  const pathname = usePathname()
  const router = useRouter()
  const normalizedPathname = normalizePath(pathname)
  const isMobile = useIsMobile()
  const isMac = useIsMac()
  const [navOpen, setNavOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { shortcuts } = useShortcutSettings()
  const searchShortcut = shortcuts.search_settings

  useEffect(() => {
    document.title = `${t("title")} - codeg`
  }, [t])

  // A search result on another page: once that page is the one showing, go
  // to the setting (see `settings-search/reveal`).
  useEffect(() => {
    const anchors = takePendingSettingsReveal(normalizedPathname)
    if (!anchors) return
    return revealSettingsAnchor(anchors)
  }, [normalizedPathname])

  const cancelRevealRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRevealRef.current?.(), [])

  /** Open `href`, then scroll to the first of `reveal` that shows there. */
  const navigateTo = useCallback(
    (href: string, reveal: readonly string[] = []) => {
      if (typeof window === "undefined") return

      const target = normalizePath(href)
      const current = normalizePath(window.location.pathname)
      if (current === target) {
        setNavOpen(false)
        cancelRevealRef.current?.()
        cancelRevealRef.current = revealSettingsAnchor(reveal)
        return
      }
      if (reveal.length > 0) setPendingSettingsReveal(target, reveal)

      // Preserve current query string so the active remote workspace context
      // (`?remoteConnectionId=N`) carries over to sub-pages — without this,
      // navigating from /settings/appearance to /settings/agents drops the
      // remote id and the next page falls back to the local Tauri backend.
      const search = window.location.search
      const fullTarget = search ? `${target}${search}` : target

      if (isWindowsRuntime()) {
        window.location.assign(fullTarget)
        return
      }

      router.push(fullTarget)
      setNavOpen(false)
    },
    [router, setNavOpen]
  )

  const environment = detectEnvironment()
  const filteredNavItems = settingsNavItemsFor(environment)

  const openSearchResult = useCallback(
    (entry: SettingsSearchEntry) => {
      const item = filteredNavItems.find((nav) => nav.labelKey === entry.page)
      if (item) navigateTo(item.href, revealAnchorsFor(entry))
    },
    [filteredNavItems, navigateTo]
  )

  // ⌘F / Ctrl+F (Settings → Shortcuts → Search settings) puts the caret in the
  // search box, over the browser's find in the web build. On a phone the nav
  // is a drawer: open it first, then focus once the box has mounted.
  useEffect(() => {
    if (!searchShortcut) return
    let frame: number | null = null
    const focusSearch = (triesLeft: number) => {
      const input = searchInputRef.current
      if (input) {
        input.focus()
        input.select()
        return
      }
      if (triesLeft > 0) {
        frame = requestAnimationFrame(() => focusSearch(triesLeft - 1))
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (isShortcutRecorderArmed()) return
      if (!matchShortcutEvent(event, searchShortcut)) return
      event.preventDefault()
      if (isMobile) setNavOpen(true)
      focusSearch(30)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [isMobile, searchShortcut])

  const navContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsSearch
        pages={filteredNavItems.map((item) => item.labelKey)}
        desktop={environment === "tauri"}
        inputRef={searchInputRef}
        shortcutLabel={
          searchShortcut && !isMobile
            ? formatShortcutLabel(searchShortcut, isMac)
            : undefined
        }
        onPick={openSearchResult}
      >
        <div className="px-2 pb-2 text-2xs font-medium text-muted-foreground">
          {t("preferences")}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <nav className="space-y-1">
            {filteredNavItems.map((item) => {
              const Icon = item.icon
              const translationKey = `nav.${item.labelKey}` as const
              const active =
                normalizedPathname === item.href ||
                normalizedPathname.startsWith(`${item.href}/`)
              return (
                <Button
                  key={item.href}
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  className={cn("w-full justify-start px-2")}
                  type="button"
                  onClick={() => navigateTo(item.href)}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    <Icon className="h-3.5 w-3.5" />
                    {t(translationKey)}
                  </span>
                </Button>
              )
            })}
          </nav>
        </ScrollArea>
      </SettingsSearch>
    </div>
  )

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar
        left={
          isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setNavOpen(true)}
            >
              <Menu className="h-4 w-4" />
            </Button>
          ) : undefined
        }
        center={
          <div className="text-sm font-bold tracking-tight">{t("title")}</div>
        }
      />

      <div className="flex-1 min-h-0 flex">
        {/* Desktop sidebar */}
        {!isMobile && (
          <aside className="flex min-h-0 w-56 shrink-0 flex-col border-e px-2 py-3">
            {navContent}
          </aside>
        )}

        {/* Mobile navigation Drawer. Opts back into press-outside-to-close,
            against the app-wide drawer default: it is navigation, and tapping
            the page it partially covers is how you put it away on a phone. */}
        {isMobile && (
          <Drawer
            open={navOpen}
            onOpenChange={setNavOpen}
            swipeDirection="left"
            disablePointerDismissal={false}
          >
            {/* rem so the nav grows with the zoom level like its own labels do,
                but capped against the viewport: 16.25rem at 150% is 390px, wider
                than the phone this drawer is for. */}
            <DrawerContent
              showCloseButton={false}
              className="w-[min(16.25rem,85vw)] p-3"
            >
              <DrawerTitle className="sr-only">{t("title")}</DrawerTitle>
              {navContent}
            </DrawerContent>
          </Drawer>
        )}

        <section className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {children}
        </section>
      </div>
      <AppToaster position="bottom-right" closeButton duration={4000} />
    </div>
  )
}
