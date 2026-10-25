"use client"

import {
  LayoutGrid,
  MessageSquareText,
  Monitor,
  Moon,
  MoveHorizontal,
  RotateCcw,
  Sun,
  Type,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  useChatTextScale,
  useSessionColumnWidth,
  useThemeColor,
  useZoomLevel,
  useWelcomeQuickActions,
} from "@/hooks/use-appearance"
import {
  CHAT_TEXT_SCALE_LEVELS,
  DEFAULT_CHAT_TEXT_SCALE,
  normalizeChatTextScale,
} from "@/lib/chat-text-scale"
import {
  CUSTOM_SESSION_COLUMN_WIDTH_STEP,
  DEFAULT_SESSION_COLUMN_WIDTH,
  MAX_CUSTOM_SESSION_COLUMN_WIDTH,
  MIN_CUSTOM_SESSION_COLUMN_WIDTH,
  SESSION_COLUMN_WIDTH_PRESETS,
  isSessionColumnWidthPreset,
  sessionColumnWidthPx,
} from "@/lib/session-column-width"
import { useSessionColumnWidthLabel } from "@/hooks/use-session-column-width-label"
import { cn } from "@/lib/utils"
import {
  DEFAULT_ZOOM_LEVEL,
  THEME_COLOR_PREVIEW,
  THEME_COLORS,
  ZOOM_LEVELS,
  type ThemeColor,
  type ZoomLevel,
} from "@/lib/theme-presets"
import { PetManagerSection } from "./pet-manager-section"
import { FontSettingsSection } from "./font-settings-section"
import { WorkspaceBackgroundSection } from "./workspace-background-section"
import { CustomStyleSection } from "./custom-style-section"

type ThemeMode = "system" | "light" | "dark"

export function AppearanceSettings() {
  const t = useTranslations("AppearanceSettings")
  const { theme, resolvedTheme, setTheme } = useTheme()
  const { themeColor, setThemeColor } = useThemeColor()
  const { zoomLevel, setZoomLevel } = useZoomLevel()
  const { chatTextScale, setChatTextScale } = useChatTextScale()
  const { sessionColumnWidth, setSessionColumnWidth } = useSessionColumnWidth()
  const sessionWidthLabel = useSessionColumnWidthLabel()
  const sessionWidthPx = sessionColumnWidthPx(sessionColumnWidth)
  const sessionWidthSize = (px: number | null) =>
    px === null
      ? t("sessionWidth.fillsPanel")
      : t("sessionWidth.presetWidth", { px })
  const { showWelcomeQuickActions, setShowWelcomeQuickActions } =
    useWelcomeQuickActions()

  const resolvedThemeLabel =
    resolvedTheme === "dark"
      ? t("resolvedTheme.dark")
      : resolvedTheme === "light"
        ? t("resolvedTheme.light")
        : t("resolvedTheme.unknown")

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        {/* ===== Theme Mode ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("sectionTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("sectionDescription")}
          </p>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("themeMode")}
            </label>
            <Select
              value={theme ?? "system"}
              onValueChange={(value) => {
                setTheme(value as ThemeMode)
                if (
                  typeof window !== "undefined" &&
                  "__TAURI_INTERNALS__" in window
                ) {
                  import("@/lib/tauri").then((t) =>
                    t.updateAppearanceMode(value).catch(() => {})
                  )
                }
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="system">
                  <span className="inline-flex items-center gap-2">
                    <Monitor className="h-3.5 w-3.5" />
                    {t("system")}
                  </span>
                </SelectItem>
                <SelectItem value="light">
                  <span className="inline-flex items-center gap-2">
                    <Sun className="h-3.5 w-3.5" />
                    {t("light")}
                  </span>
                </SelectItem>
                <SelectItem value="dark">
                  <span className="inline-flex items-center gap-2">
                    <Moon className="h-3.5 w-3.5" />
                    {t("dark")}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p
              className="text-2xs text-muted-foreground"
              suppressHydrationWarning
            >
              {t("currentTheme", { theme: resolvedThemeLabel })}
            </p>
          </div>
        </section>

        {/* ===== Theme Color ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span
              className="size-4 rounded-full border"
              style={{ backgroundColor: THEME_COLOR_PREVIEW[themeColor] }}
              aria-hidden
            />
            <h2 className="text-sm font-semibold">
              {t("themeColor.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("themeColor.sectionDescription")}
          </p>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {THEME_COLORS.map((color) => {
              const isActive = themeColor === color
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setThemeColor(color as ThemeColor)}
                  aria-pressed={isActive}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    isActive && "border-primary ring-2 ring-primary/30"
                  )}
                >
                  <span
                    className="size-4 shrink-0 rounded-full border"
                    style={{ backgroundColor: THEME_COLOR_PREVIEW[color] }}
                    aria-hidden
                  />
                  <span className="truncate">
                    {t(`themeColor.options.${color}`)}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="text-2xs text-muted-foreground">
            {t("themeColor.current", {
              color: t(`themeColor.options.${themeColor}`),
            })}
          </p>
        </section>

        {/* ===== Custom style (token overrides + free-form CSS) ===== */}
        <CustomStyleSection />

        {/* ===== Zoom Level ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Type className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("zoomLevel.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("zoomLevel.sectionDescription")}
          </p>

          <div className="space-y-2">
            <Select
              value={String(zoomLevel)}
              onValueChange={(value) =>
                setZoomLevel(parseInt(value, 10) as ZoomLevel)
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("zoomLevel.placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                {ZOOM_LEVELS.map((z) => (
                  <SelectItem key={z} value={String(z)}>
                    {z}%
                    {z === DEFAULT_ZOOM_LEVEL
                      ? ` (${t("zoomLevel.default")})`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {t("zoomLevel.current", { zoom: zoomLevel })}
            </p>
          </div>
        </section>

        {/* ===== Chat text size ===== */}
        <section
          className="rounded-xl border bg-card p-4 space-y-4"
          data-testid="chat-text-size-section"
        >
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("chatTextSize.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("chatTextSize.sectionDescription")}
          </p>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={String(chatTextScale)}
                onValueChange={(value) =>
                  setChatTextScale(normalizeChatTextScale(parseInt(value, 10)))
                }
              >
                <SelectTrigger
                  className="w-56"
                  aria-label={t("chatTextSize.sectionTitle")}
                >
                  <SelectValue placeholder={t("chatTextSize.placeholder")} />
                </SelectTrigger>
                <SelectContent align="start">
                  {CHAT_TEXT_SCALE_LEVELS.map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      {level}%
                      {level === DEFAULT_CHAT_TEXT_SCALE
                        ? ` (${t("chatTextSize.default")})`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setChatTextScale(DEFAULT_CHAT_TEXT_SCALE)}
                disabled={chatTextScale === DEFAULT_CHAT_TEXT_SCALE}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("chatTextSize.reset")}
              </Button>
            </div>
            <p className="text-2xs text-muted-foreground">
              {t("chatTextSize.current", { percent: chatTextScale })}
            </p>
          </div>
        </section>

        {/* ===== Session width ===== */}
        <section
          className="rounded-xl border bg-card p-4 space-y-4"
          data-testid="session-width-section"
        >
          <div className="flex items-center gap-2">
            <MoveHorizontal className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("sessionWidth.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("sessionWidth.sectionDescription")}
          </p>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Select
                value={
                  typeof sessionColumnWidth === "number"
                    ? "custom"
                    : sessionColumnWidth
                }
                onValueChange={(value) => {
                  if (isSessionColumnWidthPreset(value)) {
                    setSessionColumnWidth(value)
                  }
                }}
              >
                <SelectTrigger
                  className="w-64"
                  aria-label={t("sessionWidth.sectionTitle")}
                >
                  <SelectValue placeholder={t("sessionWidth.placeholder")} />
                </SelectTrigger>
                <SelectContent align="start">
                  {SESSION_COLUMN_WIDTH_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {sessionWidthLabel(preset)}
                      {` · ${sessionWidthSize(sessionColumnWidthPx(preset))}`}
                      {preset === DEFAULT_SESSION_COLUMN_WIDTH
                        ? ` (${t("sessionWidth.default")})`
                        : ""}
                    </SelectItem>
                  ))}
                  {/* Only a custom width reached with the slider shows here;
                      the slider is how to pick one. */}
                  {typeof sessionColumnWidth === "number" && (
                    <SelectItem value="custom">
                      {sessionWidthLabel(sessionColumnWidth)}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setSessionColumnWidth(DEFAULT_SESSION_COLUMN_WIDTH)
                }
                disabled={sessionColumnWidth === DEFAULT_SESSION_COLUMN_WIDTH}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("sessionWidth.reset")}
              </Button>
            </div>

            <div className="max-w-md space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t("sessionWidth.customWidth")}
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {sessionWidthSize(sessionWidthPx)}
                </span>
              </div>
              {/* Full has no px width; it sits past the slider's top end. */}
              <Slider
                value={[sessionWidthPx ?? MAX_CUSTOM_SESSION_COLUMN_WIDTH]}
                min={MIN_CUSTOM_SESSION_COLUMN_WIDTH}
                max={MAX_CUSTOM_SESSION_COLUMN_WIDTH}
                step={CUSTOM_SESSION_COLUMN_WIDTH_STEP}
                onValueChange={([px]) => setSessionColumnWidth(px)}
                aria-label={t("sessionWidth.customWidth")}
              />
              <p className="text-2xs text-muted-foreground leading-4">
                {t("sessionWidth.customHint", {
                  min: MIN_CUSTOM_SESSION_COLUMN_WIDTH,
                  max: MAX_CUSTOM_SESSION_COLUMN_WIDTH,
                })}
              </p>
            </div>
          </div>
        </section>

        {/* ===== Fonts ===== */}
        <FontSettingsSection />

        {/* ===== Workspace background ===== */}
        <WorkspaceBackgroundSection />

        {/* ===== New conversation — mode selection area ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("welcomePanel.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("welcomePanel.sectionDescription")}
          </p>

          <label className="flex items-center gap-2">
            <Switch
              checked={showWelcomeQuickActions}
              onCheckedChange={setShowWelcomeQuickActions}
            />
            <span className="text-xs text-muted-foreground">
              {t("welcomePanel.showQuickActions")}
            </span>
          </label>
        </section>

        {/* ===== Desktop Pet ===== */}
        <PetManagerSection />
      </div>
    </ScrollArea>
  )
}
