import {
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
} from "@/lib/keyboard-shortcuts"

/**
 * Every setting the Settings window's search can find, declared here rather
 * than read off the page: most pages are not mounted while you search, and a
 * page that is mounted may still be loading. Each entry names its text by
 * message path, so it searches in the user's language, and its place on the
 * page by anchor: the element that carries `data-settings-anchor` with that
 * value (`SettingsSection` and `SettingRow` take it as `anchor`).
 *
 * `registry.test.ts` keeps this honest: every settings section in the source
 * has an entry, every anchor here is on some element, and every message path
 * resolves. Add a section, add its entry.
 */

/** A page of the Settings window, by its nav label (`settingsNavItemsFor`). */
export type SettingsPageKey =
  | "appearance"
  | "general"
  | "collaboration"
  | "agents"
  | "model_providers"
  | "quick_messages"
  | "browser"
  | "computer_use"
  | "shortcuts"
  | "version_control"
  | "chat_channels"
  | "web_service"
  | "logs"
  | "system"

export type SettingsSearchPlatform = "macos" | "windows" | "linux"

export interface SettingsSearchEntry {
  /** Stable and unique; dotted from the page down (`general.terminal`). */
  id: string
  page: SettingsPageKey
  kind: "page" | "section" | "setting"
  /** Message path of what the entry is called. */
  title: string
  /** Message path of what it explains, if anything. */
  description?: string
  /** The section a setting sits in: another entry's id. */
  section?: string
  /** What to scroll to and highlight; none means the top of the page. */
  anchor?: string
  /** `SettingsSearch.keywords.<key>`: more words for it, in each language. */
  keywords?: string
  /** Names that are the same in every language: products, protocols. */
  terms?: readonly string[]
  /** Not in a browser session (the web build). */
  desktopOnly?: boolean
  /** Only where the page shows it at all. */
  platforms?: readonly SettingsSearchPlatform[]
}

interface EntryOptions {
  desktopOnly?: boolean
  platforms?: readonly SettingsSearchPlatform[]
  /** Look up `SettingsSearch.keywords.<this entry's key>`. */
  keywords?: boolean
  terms?: readonly string[]
}

interface SettingOptions extends EntryOptions {
  /**
   * The row carries an anchor of its own. Without one a result scrolls to the
   * section the setting is in.
   */
  anchored?: boolean
}

/** `general.terminal` → `general_terminal`: message keys cannot hold dots. */
export function keywordsKeyOf(id: string): string {
  return id.replace(/[.-]/g, "_")
}

function withOptions(
  entry: SettingsSearchEntry,
  options: EntryOptions | undefined
): SettingsSearchEntry {
  if (!options) return entry
  const { keywords, ...rest } = options
  return {
    ...entry,
    ...rest,
    ...(keywords ? { keywords: keywordsKeyOf(entry.id) } : {}),
  }
}

interface SettingsPageBuilder {
  entries: SettingsSearchEntry[]
  page(
    title: string,
    description?: string,
    options?: EntryOptions
  ): SettingsPageBuilder
  section(
    name: string,
    title: string,
    description?: string,
    options?: EntryOptions
  ): SettingsPageBuilder
  setting(
    sectionId: string,
    name: string,
    title: string,
    description?: string,
    options?: SettingOptions
  ): SettingsPageBuilder
}

/**
 * The builders for one page. Section ids are `<prefix>.<name>`, settings
 * `<section id>.<name>`, so where an entry sits is spelled by its id. A setting
 * straight on the page (no section) names the page's prefix as its section.
 */
function onPage(page: SettingsPageKey, prefix: string): SettingsPageBuilder {
  const entries: SettingsSearchEntry[] = []
  const anchors = new Map<string, string | undefined>()
  const builder: SettingsPageBuilder = {
    entries,
    page(title, description, options) {
      entries.push(
        withOptions(
          { id: prefix, page, kind: "page", title, description },
          options
        )
      )
      anchors.set(prefix, undefined)
      return builder
    },
    section(name, title, description, options) {
      const id = `${prefix}.${name}`
      entries.push(
        withOptions(
          { id, page, kind: "section", title, description, anchor: id },
          options
        )
      )
      anchors.set(id, id)
      return builder
    },
    setting(sectionId, name, title, description, options) {
      const id = `${sectionId}.${name}`
      const { anchored, ...rest } = options ?? {}
      const anchor = anchored ? id : anchors.get(sectionId)
      entries.push(
        withOptions(
          {
            id,
            page,
            kind: "setting",
            title,
            description,
            ...(sectionId === prefix ? {} : { section: sectionId }),
            ...(anchor ? { anchor } : {}),
          },
          rest
        )
      )
      return builder
    },
  }
  return builder
}

/** The anchor of one action's row on the Shortcuts page. */
export function settingsAnchorForShortcut(id: ShortcutActionId): string {
  return `shortcuts.list.${id}`
}

const AGENT_NAMES = [
  "Claude Code",
  "Codex",
  "Gemini",
  "OpenCode",
  "Cline",
  "Cursor",
  "Kiro",
  "Qoder",
  "Trae",
  "Kimi",
  "DeepSeek",
  "MiniMax",
  "CodeBuddy",
  "Grok",
  "Pi",
  "OpenClaw",
  "Antigravity",
  "MCP",
] as const

const appearance = onPage("appearance", "appearance")
  .page("SettingsShell.nav.appearance", undefined, { keywords: true })
  .section(
    "theme",
    "AppearanceSettings.sectionTitle",
    "AppearanceSettings.sectionDescription",
    { keywords: true }
  )
  .setting(
    "appearance.theme",
    "mode",
    "AppearanceSettings.themeMode",
    undefined,
    { keywords: true }
  )
  .section(
    "theme-color",
    "AppearanceSettings.themeColor.sectionTitle",
    "AppearanceSettings.themeColor.sectionDescription",
    { keywords: true }
  )
  .section(
    "custom-style",
    "AppearanceSettings.customStyle.sectionTitle",
    "AppearanceSettings.customStyle.sectionDescription",
    { terms: ["CSS", "shadcn"] }
  )
  .setting(
    "appearance.custom-style",
    "colors",
    "AppearanceSettings.customStyle.enableTheme"
  )
  .setting(
    "appearance.custom-style",
    "radius",
    "AppearanceSettings.customStyle.radius",
    "AppearanceSettings.customStyle.radiusHint"
  )
  .setting(
    "appearance.custom-style",
    "css",
    "AppearanceSettings.customStyle.enableCss",
    "AppearanceSettings.customStyle.cssRisk"
  )
  .section(
    "zoom",
    "AppearanceSettings.zoomLevel.sectionTitle",
    "AppearanceSettings.zoomLevel.sectionDescription",
    { keywords: true }
  )
  .section(
    "chat-text-size",
    "AppearanceSettings.chatTextSize.sectionTitle",
    "AppearanceSettings.chatTextSize.sectionDescription",
    { keywords: true }
  )
  .section(
    "session-width",
    "AppearanceSettings.sessionWidth.sectionTitle",
    "AppearanceSettings.sessionWidth.sectionDescription"
  )
  .setting(
    "appearance.session-width",
    "custom",
    "AppearanceSettings.sessionWidth.customWidth"
  )
  .section(
    "fonts",
    "AppearanceSettings.fonts.sectionTitle",
    "AppearanceSettings.fonts.sectionDescription",
    { keywords: true }
  )
  .setting("appearance.fonts", "size", "AppearanceSettings.fonts.fontSize")
  .setting(
    "appearance.fonts",
    "ligatures",
    "AppearanceSettings.fonts.ligatures"
  )
  .setting("appearance.fonts", "word-wrap", "AppearanceSettings.fonts.wordWrap")
  .section(
    "background",
    "AppearanceSettings.workspaceBackground.sectionTitle",
    "AppearanceSettings.workspaceBackground.sectionDescription",
    { keywords: true }
  )
  .setting(
    "appearance.background",
    "mask",
    "AppearanceSettings.workspaceBackground.maskOpacity",
    "AppearanceSettings.workspaceBackground.maskOpacityHint"
  )
  .setting(
    "appearance.background",
    "blur",
    "AppearanceSettings.workspaceBackground.imageBlur"
  )
  .setting(
    "appearance.background",
    "panel-opacity",
    "AppearanceSettings.workspaceBackground.panelOpacity",
    "AppearanceSettings.workspaceBackground.panelOpacityHint"
  )
  .section(
    "welcome-panel",
    "AppearanceSettings.welcomePanel.sectionTitle",
    "AppearanceSettings.welcomePanel.sectionDescription"
  )
  .setting(
    "appearance.welcome-panel",
    "quick-actions",
    "AppearanceSettings.welcomePanel.showQuickActions"
  )
  .section(
    "chat-animations",
    "AppearanceSettings.chatAnimations.sectionTitle",
    "AppearanceSettings.chatAnimations.sectionDescription",
    { keywords: true }
  )
  .section(
    "chat-html",
    "HtmlCodePreview.settingsTitle",
    "HtmlCodePreview.settingsDescription",
    { terms: ["HTML", "CSS"] }
  )
  .section(
    "chat-width",
    "AppearanceSettings.chatWidth.sectionTitle",
    "AppearanceSettings.chatWidth.sectionDescription"
  )
  .section("pets", "Pet.manager.title", "Pet.manager.description", {
    desktopOnly: true,
  })

const general = onPage("general", "general")
  .page("SettingsShell.nav.general", "GeneralSettings.sectionDescription")
  .section("terminal", "GeneralSettings.terminalTitle", undefined, {
    keywords: true,
    terms: ["zsh", "bash", "fish", "PowerShell", "cmd"],
  })
  .setting(
    "general.terminal",
    "custom-path",
    "GeneralSettings.terminalShellCustomPath",
    "GeneralSettings.terminalShellCustomHint",
    { anchored: true }
  )
  .section(
    "colorize",
    "GeneralSettings.colorizeCommandOutput",
    "GeneralSettings.colorizeCommandOutputDescription",
    { terms: ["ANSI"] }
  )
  .section(
    "rendering",
    "GeneralSettings.disableHardwareAcceleration",
    "GeneralSettings.renderingDescription",
    { desktopOnly: true, platforms: ["windows", "linux"], keywords: true }
  )
  .section(
    "edit-message",
    "EditMessageSettings.title",
    "EditMessageSettings.description"
  )
  .section(
    "mention-panel",
    "MentionPanelSettings.title",
    "MentionPanelSettings.description",
    { keywords: true }
  )
  .section("search", "SearchSettings.title", "SearchSettings.description")
  .section(
    "close-behavior",
    "CloseBehaviorSettings.title",
    "CloseBehaviorSettings.description",
    { desktopOnly: true, keywords: true }
  )
  .section(
    "windowless",
    "WindowlessSettings.title",
    "WindowlessSettings.description",
    { desktopOnly: true, platforms: ["macos"] }
  )
  .section(
    "quick-ask",
    "QuickAskSettings.title",
    "QuickAskSettings.description",
    {
      desktopOnly: true,
    }
  )
  .setting(
    "general.quick-ask",
    "enable",
    "QuickAskSettings.enable",
    "QuickAskSettings.enableDescription",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "general.quick-ask",
    "shortcut",
    "QuickAskSettings.shortcut",
    "QuickAskSettings.shortcutDescription",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "general.quick-ask",
    "hide-on-blur",
    "QuickAskSettings.hideOnBlur",
    "QuickAskSettings.hideOnBlurDescription",
    { anchored: true, desktopOnly: true }
  )
  .section(
    "auto-resume",
    "AutoResumeSettings.title",
    "AutoResumeSettings.description",
    { keywords: true }
  )
  .setting(
    "general.auto-resume",
    "background",
    "AutoResumeSettings.backgroundTitle",
    "AutoResumeSettings.backgroundDescription",
    { anchored: true }
  )
  .section(
    "limit-continue",
    "LimitContinueSettings.title",
    "LimitContinueSettings.description",
    { keywords: true }
  )
  .section(
    "prompt-suggestions",
    "PromptSuggestionSettings.title",
    "PromptSuggestionSettings.description"
  )
  .section(
    "desktop-notifications",
    "DesktopNotificationSettings.title",
    "DesktopNotificationSettings.description",
    { keywords: true }
  )
  .setting(
    "general.desktop-notifications",
    "permission",
    "DesktopNotificationSettings.permissionTitle",
    undefined,
    { anchored: true }
  )
  .setting(
    "general.desktop-notifications",
    "when",
    "DesktopNotificationSettings.whenTitle",
    "DesktopNotificationSettings.whenHint",
    { anchored: true }
  )
  .setting(
    "general.desktop-notifications",
    "hide-body",
    "DesktopNotificationSettings.hideBody",
    "DesktopNotificationSettings.hideBodyHint",
    { anchored: true }
  )
  .setting(
    "general.desktop-notifications",
    "events",
    "DesktopNotificationSettings.eventsTitle",
    "DesktopNotificationSettings.eventsHint",
    { anchored: true }
  )
  .section(
    "window-attention",
    "WindowAttentionSettings.title",
    "WindowAttentionSettings.descriptionMac",
    { desktopOnly: true, keywords: true }
  )
  .section(
    "sounds",
    "NotificationSoundSettings.title",
    "NotificationSoundSettings.description",
    { keywords: true }
  )
  .setting(
    "general.sounds",
    "volume",
    "NotificationSoundSettings.volume",
    undefined,
    { anchored: true }
  )
  .setting(
    "general.sounds",
    "unfocused",
    "NotificationSoundSettings.onlyWhenUnfocused",
    "NotificationSoundSettings.onlyWhenUnfocusedHint",
    { anchored: true }
  )
  .setting(
    "general.sounds",
    "events",
    "NotificationSoundSettings.eventsTitle",
    "NotificationSoundSettings.eventsHint",
    { anchored: true }
  )
  .section(
    "read-aloud",
    "ReadAloudSettings.title",
    "ReadAloudSettings.description",
    {
      keywords: true,
    }
  )
  .setting(
    "general.read-aloud",
    "voice",
    "ReadAloudSettings.engine",
    undefined,
    { anchored: true }
  )
  .setting(
    "general.read-aloud",
    "natural",
    "ReadAloudSettings.naturalVoice",
    undefined,
    { desktopOnly: true }
  )
  .setting(
    "general.read-aloud",
    "hebrew",
    "ReadAloudSettings.hebrewVoice",
    undefined,
    { anchored: true }
  )
  .setting(
    "general.read-aloud",
    "english",
    "ReadAloudSettings.englishVoice",
    undefined,
    { anchored: true }
  )
  .setting("general.read-aloud", "rate", "ReadAloudSettings.rate", undefined, {
    anchored: true,
  })
  .setting(
    "general.read-aloud",
    "auto-read",
    "ReadAloudSettings.autoRead",
    "ReadAloudSettings.autoReadHint",
    { anchored: true }
  )
  .section(
    "reminders",
    "PendingItems.settings.title",
    "PendingItems.settings.description"
  )
  .setting(
    "general.reminders",
    "enabled",
    "PendingItems.settings.enabledTitle",
    "PendingItems.settings.enabledHint",
    { anchored: true }
  )
  .setting(
    "general.reminders",
    "schedule",
    "PendingItems.settings.scheduleTitle",
    "PendingItems.settings.scheduleHint",
    { anchored: true }
  )
  .setting(
    "general.reminders",
    "repeat",
    "PendingItems.settings.repeatTitle",
    "PendingItems.settings.repeatHint",
    { anchored: true }
  )
  .setting(
    "general.reminders",
    "quiet",
    "PendingItems.settings.quietTitle",
    "PendingItems.settings.quietHint",
    { anchored: true }
  )
  .section(
    "critical",
    "CriticalSessions.settings.title",
    "CriticalSessions.settings.description"
  )
  .setting(
    "general.critical",
    "idle",
    "CriticalSessions.settings.idleTitle",
    "CriticalSessions.settings.idleHint",
    { anchored: true }
  )
  .setting(
    "general.critical",
    "repeat",
    "CriticalSessions.settings.repeatTitle",
    "CriticalSessions.settings.repeatHint",
    { anchored: true }
  )
  .setting(
    "general.critical",
    "stall",
    "CriticalSessions.settings.stallTitle",
    "CriticalSessions.settings.stallHint",
    { anchored: true }
  )
  .setting(
    "general.critical",
    "sound",
    "CriticalSessions.settings.soundTitle",
    "CriticalSessions.settings.soundHint",
    { anchored: true }
  )
  .setting(
    "general.critical",
    "channel",
    "CriticalSessions.settings.channelTitle",
    "CriticalSessions.settings.channelHint",
    { anchored: true }
  )
  .section("iphone-push", "PushSettings.title", "PushSettings.description", {
    keywords: true,
    terms: ["APNs", "iOS", "iPhone", ".p8"],
  })
  .setting(
    "general.iphone-push",
    "devices",
    "PushSettings.devicesTitle",
    undefined,
    {
      anchored: true,
    }
  )
  .section(
    "dictation",
    "DictationRefineSettings.title",
    "DictationRefineSettings.description",
    {
      keywords: true,
      terms: ["Groq", "Cerebras", "OpenAI", "Anthropic", "Google"],
    }
  )
  .setting(
    "general.dictation",
    "provider",
    "DictationRefineSettings.provider",
    "DictationRefineSettings.providerHint",
    { anchored: true }
  )
  .setting(
    "general.dictation",
    "api-key",
    "DictationRefineSettings.apiKey",
    undefined,
    { anchored: true }
  )
  .setting(
    "general.dictation",
    "translate",
    "DictationRefineSettings.translate",
    "DictationRefineSettings.translateHint",
    { anchored: true }
  )
  .section("talk", "TalkSettings.title", "TalkSettings.description", {
    keywords: true,
  })
  .setting(
    "general.talk",
    "language",
    "TalkSettings.languageTitle",
    "TalkSettings.languageHint",
    { anchored: true }
  )
  .setting(
    "general.talk",
    "address",
    "TalkSettings.addressTitle",
    "TalkSettings.addressHint",
    { anchored: true }
  )
  .section("talk-mac", "TalkMacSettings.title", "TalkMacSettings.description", {
    desktopOnly: true,
    platforms: ["macos"],
    keywords: true,
  })
  .setting(
    "general.talk-mac",
    "shortcut",
    "TalkMacSettings.shortcutEnable",
    "TalkMacSettings.shortcutEnableDescription",
    { anchored: true, desktopOnly: true, platforms: ["macos"] }
  )
  .setting(
    "general.talk-mac",
    "hands-free",
    "TalkMacSettings.handsFree",
    "TalkMacSettings.handsFreeDescription",
    { anchored: true, desktopOnly: true, platforms: ["macos"] }
  )
  .setting(
    "general.talk-mac",
    "whisper",
    "TalkMacSettings.whisper",
    "TalkMacSettings.whisperDescription",
    { anchored: true, desktopOnly: true, platforms: ["macos"] }
  )
  .setting(
    "general.talk-mac",
    "echo",
    "TalkMacSettings.echo",
    "TalkMacSettings.echoDescription",
    { anchored: true, desktopOnly: true, platforms: ["macos"] }
  )

const collaboration = onPage("collaboration", "collaboration")
  .page(
    "SettingsShell.nav.collaboration",
    "CollaborationSettings.sectionDescription"
  )
  .section(
    "delegation",
    "AcpAgentSettings.multiAgent.title",
    "AcpAgentSettings.multiAgent.description",
    { keywords: true }
  )
  .setting(
    "collaboration.delegation",
    "enable",
    "AcpAgentSettings.multiAgent.enable",
    "AcpAgentSettings.multiAgent.enableHint",
    { anchored: true }
  )
  .setting(
    "collaboration.delegation",
    "depth",
    "AcpAgentSettings.multiAgent.depthLimit",
    undefined,
    { anchored: true }
  )
  .section(
    "tools",
    "AgentToolsSettings.title",
    "AgentToolsSettings.description",
    { terms: ["MCP"] }
  )

const agents = onPage("agents", "agents").page(
  "SettingsShell.nav.agents",
  "AcpAgentSettings.description",
  { keywords: true, terms: AGENT_NAMES }
)

const modelProviders = onPage("model_providers", "model-providers").page(
  "SettingsShell.nav.model_providers",
  "ModelProviderSettings.sectionDescription",
  { keywords: true, terms: ["OpenAI", "Anthropic", "OpenRouter", "Baseten"] }
)

const quickMessages = onPage("quick_messages", "quick-messages").page(
  "SettingsShell.nav.quick_messages",
  "QuickMessagesSettings.description",
  { keywords: true }
)

const browser = onPage("browser", "browser")
  .page("SettingsShell.nav.browser", "BrowserSettings.description")
  .setting(
    "browser",
    "links",
    "BrowserSettings.defaultTargetTitle",
    "BrowserSettings.defaultTargetHint",
    { anchored: true, desktopOnly: true, keywords: true }
  )
  .setting(
    "browser",
    "rules",
    "BrowserSettings.rulesTitle",
    "BrowserSettings.rulesHint",
    { anchored: true }
  )
  .setting(
    "browser",
    "agent-grant",
    "BrowserSettings.agentGrantTitle",
    "BrowserSettings.agentGrantHint",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "eval",
    "BrowserSettings.evalApprovalTitle",
    "BrowserSettings.evalApprovalHint",
    { anchored: true, desktopOnly: true, terms: ["JavaScript"] }
  )
  .setting(
    "browser",
    "local-servers",
    "BrowserSettings.serviceOpenTitle",
    "BrowserSettings.serviceOpenHint",
    { anchored: true, terms: ["localhost"] }
  )
  .setting(
    "browser",
    "terminal-menu",
    "BrowserSettings.terminalMenuTitle",
    "BrowserSettings.terminalMenuHint",
    { anchored: true }
  )
  .setting(
    "browser",
    "html-preview",
    "BrowserSettings.htmlPreviewTitle",
    "BrowserSettings.htmlPreviewHint",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "devtools",
    "BrowserSettings.devtoolsTitle",
    "BrowserSettings.devtoolsHint",
    { anchored: true, desktopOnly: true, terms: ["DevTools"] }
  )
  .setting(
    "browser",
    "surface",
    "BrowserSettings.surfaceTitle",
    "BrowserSettings.surfaceHint",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "suspend",
    "BrowserSettings.suspendTitle",
    "BrowserSettings.suspendHint",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "proxy",
    "BrowserSettings.proxyTitle",
    "BrowserSettings.proxyHint",
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "downloads",
    "BrowserSettings.downloadsTitle",
    undefined,
    { anchored: true, desktopOnly: true }
  )
  .setting(
    "browser",
    "clear",
    "BrowserSettings.clearTitle",
    "BrowserSettings.clearHint",
    { anchored: true, desktopOnly: true, keywords: true }
  )
  .setting(
    "browser",
    "profiles",
    "BrowserSettings.profilesTitle",
    "BrowserSettings.profilesHint",
    { anchored: true, desktopOnly: true }
  )

const computerUse = onPage("computer_use", "computer-use")
  .page(
    "SettingsShell.nav.computer_use",
    "ComputerUse.settings.pageDescription",
    { keywords: true }
  )
  .section(
    "enable",
    "ComputerUse.settings.switch.label",
    "ComputerUse.settings.switch.hint"
  )
  .section(
    "driver",
    "ComputerUse.settings.driver.title",
    "ComputerUse.settings.driver.description",
    { desktopOnly: true, terms: ["cua-driver"] }
  )
  .section(
    "permissions",
    "ComputerUse.settings.permissions.title",
    "ComputerUse.settings.permissions.description",
    { desktopOnly: true, platforms: ["macos"], keywords: true }
  )
  .section(
    "sharing",
    "ComputerUse.settings.title",
    "ComputerUse.settings.description"
  )
  .setting(
    "computer-use.sharing",
    "ttl",
    "ComputerUse.settings.ttl.label",
    "ComputerUse.settings.ttl.hint",
    { anchored: true }
  )
  .setting(
    "computer-use.sharing",
    "strip",
    "ComputerUse.settings.strip.label",
    "ComputerUse.settings.strip.hint",
    { anchored: true }
  )
  .setting(
    "computer-use.sharing",
    "launch",
    "ComputerUse.settings.launch.label",
    "ComputerUse.settings.launch.hint",
    { anchored: true }
  )
  .setting(
    "computer-use.sharing",
    "clipboard",
    "ComputerUse.settings.clipboard.label",
    "ComputerUse.settings.clipboard.hint",
    { anchored: true }
  )
  .setting(
    "computer-use.sharing",
    "blocklist",
    "ComputerUse.settings.blocklist.label",
    "ComputerUse.settings.blocklist.hint",
    { anchored: true }
  )
  .setting(
    "computer-use.sharing",
    "stop-key",
    "ComputerUse.settings.stopKey.label",
    "ComputerUse.settings.stopKey.hint",
    { anchored: true }
  )

const shortcutsPage = onPage("shortcuts", "shortcuts")
  .page("SettingsShell.nav.shortcuts", undefined, { keywords: true })
  .section(
    "list",
    "ShortcutSettings.sectionTitle",
    "ShortcutSettings.recordInstruction"
  )
for (const definition of SHORTCUT_DEFINITIONS) {
  shortcutsPage.setting(
    "shortcuts.list",
    definition.id,
    `ShortcutSettings.actions.${definition.id}.title`,
    `ShortcutSettings.actions.${definition.id}.description`,
    { anchored: true }
  )
}

const versionControl = onPage("version_control", "version-control")
  .page(
    "SettingsShell.nav.version_control",
    "VersionControlSettings.sectionDescription"
  )
  .section(
    "git",
    "VersionControlSettings.gitTitle",
    "VersionControlSettings.gitDescription",
    { terms: ["Git"] }
  )
  .section(
    "github",
    "VersionControlSettings.githubTitle",
    "VersionControlSettings.githubDescription",
    { terms: ["GitHub"] }
  )
  .section(
    "gitlab",
    "VersionControlSettings.gitlabTitle",
    "VersionControlSettings.gitlabDescription",
    { terms: ["GitLab"] }
  )
  .section(
    "gitea",
    "VersionControlSettings.giteaTitle",
    "VersionControlSettings.giteaDescription",
    { terms: ["Gitea", "Forgejo"] }
  )
  .section(
    "cnb",
    "VersionControlSettings.cnbTitle",
    "VersionControlSettings.cnbDescription",
    { terms: ["CNB"] }
  )
  .section(
    "accounts",
    "VersionControlSettings.gitAccount.sectionTitle",
    "VersionControlSettings.gitAccount.sectionDescription",
    { keywords: true }
  )

const chatChannels = onPage("chat_channels", "chat-channels")
  .page(
    "SettingsShell.nav.chat_channels",
    "ChatChannelSettings.sectionDescription",
    { keywords: true, terms: ["Telegram", "Lark", "Feishu", "DingTalk"] }
  )
  .section("list", "ChatChannelSettings.tabs.channels")

const webService = onPage("web_service", "web-service")
  .page(
    "SettingsShell.nav.web_service",
    "WebServiceSettings.sectionDescription",
    { keywords: true }
  )
  .setting("web-service", "port", "WebServiceSettings.port")
  .setting(
    "web-service",
    "auto-start",
    "WebServiceSettings.autoStart",
    "WebServiceSettings.autoStartHint"
  )
  .setting(
    "web-service",
    "token",
    "WebServiceSettings.tokenLabel",
    "WebServiceSettings.tokenHint"
  )
  .setting("web-service", "bind-host", "WebServiceSettings.bindHost")

const logs = onPage("logs", "logs")
  .page("SettingsShell.nav.logs", "LogsSettings.sectionDescription", {
    keywords: true,
  })
  .section(
    "capture",
    "LogsSettings.captureTitle",
    "LogsSettings.captureDescription"
  )
  .setting(
    "logs.capture",
    "targets",
    "LogsSettings.targetsTitle",
    "LogsSettings.targetsDescription"
  )
  .section(
    "viewer",
    "LogsSettings.viewerTitle",
    "LogsSettings.viewerDescription"
  )
  .section(
    "crash-reports",
    "LogsSettings.crashReportsTitle",
    "LogsSettings.crashReportsDescription",
    { terms: ["iPhone", "iOS"] }
  )
  .section("files", "LogsSettings.filesTitle", "LogsSettings.filesDescription")

const system = onPage("system", "system")
  .page("SettingsShell.nav.system", "SystemSettings.sectionDescription")
  .section(
    "update",
    "SystemSettings.versionTitle",
    "SystemSettings.updateDescription",
    { keywords: true }
  )
  .section(
    "autostart",
    "SystemSettings.autostartTitle",
    "SystemSettings.autostartDescription",
    { desktopOnly: true, keywords: true }
  )
  .section(
    "startup-workspace",
    "StartupWorkspaceSettings.title",
    "StartupWorkspaceSettings.description",
    { desktopOnly: true }
  )
  .section(
    "cli",
    "SystemSettings.cliAccessTitle",
    "SystemSettings.cliAccessDescription",
    { terms: ["CLI", "codeg-cli"] }
  )
  .section(
    "proxy",
    "SystemSettings.proxyTitle",
    "SystemSettings.proxyDescription",
    { terms: ["HTTP", "HTTPS", "SOCKS"] }
  )
  .setting(
    "system.proxy",
    "bypass",
    "SystemSettings.proxyBypass",
    "SystemSettings.proxyBypassHint"
  )
  .section(
    "language",
    "SystemSettings.languageTitle",
    "SystemSettings.languageDescription",
    {
      keywords: true,
      terms: [
        "English",
        "中文",
        "日本語",
        "한국어",
        "Español",
        "Deutsch",
        "Français",
        "Português",
        "العربية",
      ],
    }
  )
  .section(
    "data",
    "SystemSettings.dataTitle",
    "SystemSettings.dataDescription",
    {
      keywords: true,
    }
  )

/** In the order the nav lists the pages, each page top to bottom. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...appearance.entries,
  ...general.entries,
  ...collaboration.entries,
  ...agents.entries,
  ...modelProviders.entries,
  ...quickMessages.entries,
  ...browser.entries,
  ...computerUse.entries,
  ...shortcutsPage.entries,
  ...versionControl.entries,
  ...chatChannels.entries,
  ...webService.entries,
  ...logs.entries,
  ...system.entries,
]

const ENTRY_BY_ID = new Map(
  SETTINGS_SEARCH_ENTRIES.map((entry) => [entry.id, entry])
)

export function settingsSearchEntry(
  id: string
): SettingsSearchEntry | undefined {
  return ENTRY_BY_ID.get(id)
}
