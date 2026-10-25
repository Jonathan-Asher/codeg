"use client"

import { useContext } from "react"
import { AppearanceContext } from "@/components/appearance-provider"
import { DEFAULT_CHAT_TEXT_SCALE } from "@/lib/chat-text-scale"
import { resolveFontStack } from "@/lib/font-presets"
import { DEFAULT_SESSION_COLUMN_WIDTH } from "@/lib/session-column-width"

export function useAppearance() {
  const ctx = useContext(AppearanceContext)
  if (!ctx) {
    throw new Error("useAppearance must be used within AppearanceProvider")
  }
  return ctx
}

/** 语义化包装：只关心主题色的调用点用这个 */
export function useThemeColor() {
  const { themeColor, setThemeColor } = useAppearance()
  return { themeColor, setThemeColor }
}

/** 语义化包装：只关心缩放档位的调用点用这个 */
export function useZoomLevel() {
  const { zoomLevel, setZoomLevel } = useAppearance()
  return { zoomLevel, setZoomLevel }
}

const noopSetChatTextScale = () => {}

/**
 * Conversation text size (Settings → Appearance → Chat text size). Tolerates a
 * missing provider (100%, read-only): conversation surfaces read it only to
 * re-fit to a size the CSS already applies, and some render on their own.
 */
export function useChatTextScale() {
  const ctx = useContext(AppearanceContext)
  return {
    chatTextScale: ctx?.chatTextScale ?? DEFAULT_CHAT_TEXT_SCALE,
    setChatTextScale: ctx?.setChatTextScale ?? noopSetChatTextScale,
    chatTextScaleNotice: ctx?.chatTextScaleNotice ?? null,
  }
}

const noopSetSessionColumnWidth = () => {}

/**
 * Max width of the conversation column (Settings → Appearance → Session
 * width). Tolerates a missing provider (Standard, read-only), like the chat
 * text size: the CSS variable carries the width either way.
 */
export function useSessionColumnWidth() {
  const ctx = useContext(AppearanceContext)
  return {
    sessionColumnWidth: ctx?.sessionColumnWidth ?? DEFAULT_SESSION_COLUMN_WIDTH,
    setSessionColumnWidth:
      ctx?.setSessionColumnWidth ?? noopSetSessionColumnWidth,
    sessionColumnWidthNotice: ctx?.sessionColumnWidthNotice ?? null,
  }
}

/** 语义化包装：新会话欢迎页「模式选择区域」显示开关 */
export function useWelcomeQuickActions() {
  const { showWelcomeQuickActions, setShowWelcomeQuickActions } =
    useAppearance()
  return { showWelcomeQuickActions, setShowWelcomeQuickActions }
}

/** 界面字体（普通组件）。stack 已解析，可直接用于 style 或 CSS 变量。 */
export function useUiFont() {
  const { uiFont, setUiFont } = useAppearance()
  return {
    uiFont,
    setUiFont,
    uiFontStack: resolveFontStack(uiFont.id, uiFont.custom, "sans"),
  }
}

/** 编辑器字体（Monaco）：含字号、连字与自动换行。stack 已解析。 */
export function useEditorFont() {
  const {
    editorFont,
    setEditorFont,
    editorFontSize,
    setEditorFontSize,
    editorLigatures,
    setEditorLigatures,
    editorWordWrap,
    setEditorWordWrap,
  } = useAppearance()
  return {
    editorFont,
    setEditorFont,
    editorFontStack: resolveFontStack(editorFont.id, editorFont.custom, "mono"),
    editorFontSize,
    setEditorFontSize,
    editorLigatures,
    setEditorLigatures,
    editorWordWrap,
    setEditorWordWrap,
  }
}

/** 终端字体（xterm）：含字号与连字。stack 已解析。 */
export function useTerminalFont() {
  const {
    terminalFont,
    setTerminalFont,
    terminalFontSize,
    setTerminalFontSize,
    terminalLigatures,
    setTerminalLigatures,
  } = useAppearance()
  return {
    terminalFont,
    setTerminalFont,
    terminalFontStack: resolveFontStack(
      terminalFont.id,
      terminalFont.custom,
      "mono"
    ),
    terminalFontSize,
    setTerminalFontSize,
    terminalLigatures,
    setTerminalLigatures,
  }
}

/**
 * 自定义样式：主题 token 覆盖 + 自由 CSS + 逃生舱状态。
 *
 * `activeTokenOverrides` 是当前明暗模式下真正生效的那一组（已把「未启用 / 已停用」
 * 折叠进去），供 Monaco 之类需要跟随实际取值的消费方直接使用，避免各处重复推导。
 */
export function useCustomStyle() {
  const {
    isDarkMode,
    customTheme,
    setCustomThemeToken,
    replaceCustomTheme,
    customThemeEnabled,
    setCustomThemeEnabled,
    customCss,
    setCustomCss,
    customCssEnabled,
    setCustomCssEnabled,
    customStyleSuspended,
    setCustomStyleSuspended,
    safeStyleRequested,
  } = useAppearance()

  const suppressed = safeStyleRequested || customStyleSuspended
  const activeTokenOverrides =
    suppressed || !customThemeEnabled
      ? {}
      : isDarkMode
        ? customTheme.dark
        : customTheme.light

  return {
    isDarkMode,
    customTheme,
    setCustomThemeToken,
    replaceCustomTheme,
    customThemeEnabled,
    setCustomThemeEnabled,
    customCss,
    setCustomCss,
    customCssEnabled,
    setCustomCssEnabled,
    customStyleSuspended,
    setCustomStyleSuspended,
    safeStyleRequested,
    /** 自定义样式当前是否被整体停用（快捷键停用 或 ?safeStyle=1 打开）。 */
    customStyleSuppressed: suppressed,
    activeTokenOverrides,
  }
}

/** Workspace 背景图片：启用开关、遮罩/模糊/填充/面板不透明度配置、以及已解析的
 * 图片 blob URL（异步从磁盘加载）。供外观设置面板与 workspace 布局共同消费。 */
export function useWorkspaceBackground() {
  const {
    workspaceBgEnabled,
    setWorkspaceBgEnabled,
    workspaceBgMaskOpacity,
    setWorkspaceBgMaskOpacity,
    workspaceBgImageBlur,
    setWorkspaceBgImageBlur,
    workspaceBgPanelOpacity,
    setWorkspaceBgPanelOpacity,
    workspaceBgFillMode,
    setWorkspaceBgFillMode,
    workspaceBgImageUrl,
    setWorkspaceBackgroundImage,
    downloadMarketWorkspaceBackground,
    removeWorkspaceBackground,
    workspaceBgSourceUrl,
  } = useAppearance()
  return {
    workspaceBgEnabled,
    setWorkspaceBgEnabled,
    workspaceBgMaskOpacity,
    setWorkspaceBgMaskOpacity,
    workspaceBgImageBlur,
    setWorkspaceBgImageBlur,
    workspaceBgPanelOpacity,
    setWorkspaceBgPanelOpacity,
    workspaceBgFillMode,
    setWorkspaceBgFillMode,
    workspaceBgImageUrl,
    setWorkspaceBackgroundImage,
    downloadMarketWorkspaceBackground,
    removeWorkspaceBackground,
    workspaceBgSourceUrl,
  }
}
