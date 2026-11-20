import { describe, expect, it } from "vitest"

import de from "@/i18n/messages/de.json"
import en from "@/i18n/messages/en.json"
import ja from "@/i18n/messages/ja.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import type { SettingsPageKey } from "@/lib/settings-search/registry"
import {
  buildSettingsSearchIndex,
  messageText,
  normalizeSearchText,
  revealAnchorsFor,
  searchSettings,
  type SettingsSearchScope,
} from "@/lib/settings-search/search"
import { settingsNavItemsFor } from "@/components/settings/settings-shell"

type Messages = Record<string, unknown>

function scope(over: Partial<SettingsSearchScope> = {}): SettingsSearchScope {
  return {
    pages: new Set<SettingsPageKey>(
      settingsNavItemsFor("tauri").map((item) => item.labelKey)
    ),
    desktop: true,
    platform: "macos",
    ...over,
  }
}

function ids(messages: unknown, query: string, s = scope()): string[] {
  return searchSettings(
    buildSettingsSearchIndex(messages as Messages, s),
    query
  ).map((doc) => doc.entry.id)
}

describe("settings search", () => {
  it("finds a setting by its own label, not just its page", () => {
    expect(ids(en, "hide notification contents")[0]).toBe(
      "general.desktop-notifications.hide-body"
    )
    expect(ids(en, "window zoom")[0]).toBe("appearance.zoom")
  })

  it("finds one by a synonym", () => {
    expect(ids(en, "dark mode").slice(0, 2)).toContain("appearance.theme")
    expect(ids(en, "wallpaper")).toContain("appearance.background")
    expect(ids(en, "hotkeys")[0]).toBe("shortcuts")
  })

  it("finds one by its description", () => {
    // "Close Button Behavior" says what the close button does underneath.
    expect(ids(en, "close button")).toContain("general.close-behavior")
  })

  it("lists every shortcut action under the Shortcuts page", () => {
    const [first] = searchSettings(
      buildSettingsSearchIndex(en as Messages, scope()),
      "open search"
    )
    expect(first.entry.id).toBe("shortcuts.list.toggle_search")
    expect(first.pageLabel).toBe("Shortcuts")
    expect(first.sectionTitle).toBe("Shortcuts")
  })

  it("searches in the user's language", () => {
    expect(ids(zhCN, "深色模式").slice(0, 2)).toContain("appearance.theme")
    expect(ids(zhCN, "快捷键")).toContain("shortcuts")
    expect(ids(ja, "ショートカット")).toContain("shortcuts")
    // Diacritics and case do not matter.
    expect(ids(de, "SCHRIFTGRÖSSE")).toEqual(ids(de, "schriftgrösse"))
    expect(ids(de, "schriftgröße")).toContain("appearance.chat-text-size")
    expect(ids(de, "schriftgroße")).toContain("appearance.chat-text-size")
  })

  it("needs every word to match", () => {
    expect(ids(en, "zoom nonsenseword")).toEqual([])
    expect(ids(en, "   ")).toEqual([])
  })

  it("leaves desktop-only settings out of a browser session", () => {
    const web = scope({
      desktop: false,
      pages: new Set(settingsNavItemsFor("web").map((item) => item.labelKey)),
    })
    expect(ids(en, "close button behavior")).toContain("general.close-behavior")
    expect(ids(en, "close button behavior", web)).not.toContain(
      "general.close-behavior"
    )
    // A page the web nav does not have is not offered either.
    expect(ids(en, "web service", web)).not.toContain("web-service")
    expect(ids(en, "web service")).toContain("web-service")
  })

  it("keeps platform-only settings to their platform", () => {
    expect(ids(en, "hardware acceleration")).not.toContain("general.rendering")
    expect(
      ids(en, "hardware acceleration", scope({ platform: "windows" }))
    ).toContain("general.rendering")
    // Unknown yet (the first frame): nothing is hidden for it.
    expect(
      ids(en, "hardware acceleration", scope({ platform: "unknown" }))
    ).toContain("general.rendering")
  })

  it("leads a setting to its row, then its section", () => {
    const index = buildSettingsSearchIndex(en as Messages, scope())
    const row = index.find(
      (doc) => doc.entry.id === "general.quick-ask.hide-on-blur"
    )
    expect(row && revealAnchorsFor(row.entry)).toEqual([
      "general.quick-ask.hide-on-blur",
      "general.quick-ask",
    ])
    const inSection = index.find(
      (doc) => doc.entry.id === "appearance.fonts.ligatures"
    )
    expect(inSection && revealAnchorsFor(inSection.entry)).toEqual([
      "appearance.fonts",
    ])
    const page = index.find((doc) => doc.entry.id === "agents")
    expect(page && revealAnchorsFor(page.entry)).toEqual([])
  })
})

describe("messageText", () => {
  it("drops placeholders and tags but keeps the words", () => {
    const messages = {
      a: { b: "Downloaded: {size} on this <b>Mac</b>" },
      plural: "{count, plural, one {# override} other {# overrides}} saved",
    }
    expect(messageText(messages, "a.b")).toBe("Downloaded: on this Mac")
    expect(messageText(messages, "plural")).toBe("saved")
    expect(messageText(messages, "a.missing")).toBeNull()
    expect(messageText(messages, "a")).toBeNull()
  })

  it("normalizes width, case and accents", () => {
    expect(normalizeSearchText("Désactiver ＧＩＴ")).toBe("desactiver git")
  })
})
