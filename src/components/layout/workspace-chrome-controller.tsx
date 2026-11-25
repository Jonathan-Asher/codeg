"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { openSettingsWindow } from "@/lib/api"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
  type WorkspacePane,
} from "@/contexts/workspace-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  useSearchDialog,
  useSearchDialogSetter,
} from "@/contexts/search-dialog-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  isConversationDeleted,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { popClosedTab } from "@/lib/closed-tab-stack"
import { useArrangedTabs } from "@/hooks/use-arranged-tabs"
import { shownTabs } from "@/lib/tab-arrangement"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import { stepConversationTab, tabStepPreviewId } from "@/stores/tab-step-store"
import {
  matchShortcutEvent,
  numberedTabIndexFromEvent,
  pickNumberedTabId,
} from "@/lib/keyboard-shortcuts"
import {
  CLOSE_SHORTCUT_EVENT,
  closeShortcutOrigin,
  tabShortcutTarget,
  workspacePaneOf,
  type CloseShortcutPayload,
} from "@/lib/menu-close-shortcut"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { closeCurrentWindow } from "@/lib/platform"
import { getShellTransport, isDesktop } from "@/lib/transport"
import { SearchCommandDialog } from "@/components/conversations/search-command-dialog"
import { useVisibleConversationTabs } from "@/stores/tab-store"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { armQuickSwitchTypeahead } from "@/lib/quick-switch-typeahead"
import { markQuickSwitchKey } from "@/lib/quick-switch-perf"
import {
  isQuickSwitchReplaceMode,
  setQuickSwitchReplaceMode,
} from "@/lib/quick-switch-mode"

/** The search dialog, bound to the shared open-state. */
function SearchDialogHost() {
  const { open, setOpen } = useSearchDialog()
  return <SearchCommandDialog open={open} onOpenChange={setOpen} />
}

/**
 * Headless owner of the workspace's global keyboard shortcuts and the two
 * dialogs the shortcuts summon (search, remote directory browser). These used
 * to live in the full-width `FolderTitleBar`; with the desktop title bar removed
 * (its buttons relocated into per-column edge clusters), this component keeps
 * the shortcuts + dialogs alive on BOTH desktop and mobile, independent of any
 * visible bar. Renders no visible chrome — only the dialogs.
 */
export function WorkspaceChromeController() {
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const { toggle } = useSidebarContext()
  const { toggle: toggleAuxPanel } = useAuxPanelContext()
  const { toggle: toggleTerminal } = useTerminalContext()
  const { openNewConversationTab, openTab, switchTab, closeTab } =
    useTabActions()
  const tabs = useVisibleConversationTabs()
  const activeTabId = useTabStore((s) => s.activeTabId)
  // Tab switching walks the strip as displayed: grouped or sorted, with
  // collapsed groups folded away (`shownTabs`), not the manual order behind it.
  const { arranged: navArranged, shown: navTabs } = useArrangedTabs(
    tabs,
    activeTabId
  )
  // Tab-close/navigation shortcuts used to live in the visible tab strips.
  // Mobile no longer mounts those strips, so this always-mounted controller now
  // owns them too (see the keydown handler below).
  const { mode, activePane, filesMaximized, conversationMaximized } =
    useWorkspaceView()
  const { activeFileTabId, fileTabs } = useWorkspaceFileTabs()
  const {
    closeFileTab,
    closeAllFileTabs,
    switchFileTab,
    openFilePreview,
    openBrowserTab,
    setActivePane,
  } = useWorkspaceActions()
  const { openConversations } = useWorkbenchRoute()
  const { shortcuts } = useShortcutSettings()
  // Search open-state is shared (see search-dialog-context): the trigger lives
  // in the sidebar, but this always-mounted controller owns the dialog and the
  // ⌘K shortcut so search works even when the sidebar is collapsed. Only the
  // setter here: opening must not re-render this controller (the dialog host
  // below is the one place that reads the state).
  const setSearchOpen = useSearchDialogSetter()
  const [browserOpen, setBrowserOpen] = useState(false)

  // One dialog on every platform: it owns directory selection *and* the
  // follow-up step that links other folders into the new workspace, so the
  // native picker can't be a separate path that skips half the flow.
  const handleOpenFolder = useCallback(() => setBrowserOpen(true), [])

  const handleOpenSettings = useCallback(() => {
    openSettingsWindow().catch((err) => {
      console.error("[WorkspaceChromeController] failed to open settings:", err)
    })
  }, [])

  // Close the current tab of the strip that belongs to `pane`: a conversation
  // (or new-chat) tab, or a file / built-in browser tab in the file pane.
  // False when there is none. Closing the last tab leaves whatever closing it
  // with the mouse leaves; the window stays.
  const closeCurrentTab = useCallback(
    (pane: WorkspacePane): boolean => {
      const target = tabShortcutTarget(
        mode,
        pane,
        filesMaximized,
        conversationMaximized
      )
      if (target.conversation) {
        if (!activeTabId) return false
        closeTab(activeTabId)
        return true
      }
      if (target.files) {
        if (!activeFileTabId) return false
        closeFileTab(activeFileTabId)
        return true
      }
      return false
    },
    [
      activeFileTabId,
      activeTabId,
      closeFileTab,
      closeTab,
      conversationMaximized,
      filesMaximized,
      mode,
    ]
  )

  // ⌘W the macOS app menu caught (see `menu-close-shortcut`): pressed where
  // the listener below cannot hear it — inside an iframe, a browser page, an
  // HTML document view — or let through by it (close-tab bound elsewhere).
  // The first kind is routed as if it had been pressed at the element that
  // stands for that spot, the rest to the active pane. ⌘W closes one tab and
  // never the window: with no tab there, nothing happens (closing the window
  // is the close_window shortcut, Shift+⌘W by default).
  const handleMenuClose = useCallback(
    (payload: CloseShortcutPayload) => {
      const origin = closeShortcutOrigin(payload.surfaceTabId)
      // A surface this document does not show: nothing here is safe to close.
      if (origin.kind === "unknown") return
      let pane = activePane
      const pressedIn =
        origin.kind === "element" ? workspacePaneOf(origin.element) : null
      if (pressedIn) {
        pane = pressedIn
        // What a click there would have done (see the pane handlers in the
        // workspace layout): a page gives the workspace no pointer or focus
        // event of its own. It also routes the next ⌘W, which arrives with
        // no view holding the keyboard once this page has closed. Never into
        // a column the other one is maximized over.
        const covered =
          pressedIn === "files" ? conversationMaximized : filesMaximized
        if (mode === "fusion" && !covered) {
          setActivePane(pressedIn)
        }
      }
      closeCurrentTab(pane)
    },
    [
      activePane,
      closeCurrentTab,
      conversationMaximized,
      filesMaximized,
      mode,
      setActivePane,
    ]
  )
  const handleMenuCloseRef = useRef(handleMenuClose)
  useEffect(() => {
    handleMenuCloseRef.current = handleMenuClose
  }, [handleMenuClose])
  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let unsubscribe: (() => void) | null = null
    // This app's own backend — the menu is local even in a window whose
    // workspace is on a remote server.
    getShellTransport()
      .subscribe<CloseShortcutPayload>(CLOSE_SHORTCUT_EVENT, (payload) => {
        if (payload.window !== getCurrentWindowLabel()) return
        handleMenuCloseRef.current(payload)
      })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch((err) => {
        console.error("[WorkspaceChromeController] ⌘W listener failed:", err)
      })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchShortcutEvent(e, shortcuts.toggle_search)) {
        e.preventDefault()
        markQuickSwitchKey()
        // ⌘K then Enter is one gesture: keys that follow belong to the
        // switcher even if they beat its search box to focus.
        armQuickSwitchTypeahead()
        // Over the "switch this tab" switcher it goes back to the plain one
        // rather than closing it.
        const fromReplace = isQuickSwitchReplaceMode()
        setQuickSwitchReplaceMode(false)
        setSearchOpen((prev) => (prev && fromReplace ? true : !prev))
        return
      }
      if (matchShortcutEvent(e, shortcuts.switch_session_in_tab)) {
        e.preventDefault()
        markQuickSwitchKey()
        armQuickSwitchTypeahead()
        // The same switcher, where Enter replaces the session in front.
        // Pressed again over it, it closes; over the plain one, it turns it
        // into this mode.
        const wasReplace = isQuickSwitchReplaceMode()
        setQuickSwitchReplaceMode(true)
        setSearchOpen((prev) => !(prev && wasReplace))
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_sidebar)) {
        e.preventDefault()
        toggle()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_terminal)) {
        e.preventDefault()
        toggleTerminal()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_aux_panel)) {
        // The aux panel hosts the Session Details tab, so it's usable in chat
        // mode too; only suppress the toggle when there's nothing to show.
        if (!activeFolder && !isChatMode) return
        e.preventDefault()
        toggleAuxPanel()
        return
      }
      if (matchShortcutEvent(e, shortcuts.new_conversation)) {
        if (!activeFolder) return
        e.preventDefault()
        // Return to the conversation workspace if a route (e.g. Automations) was
        // covering the content region, else the new tab opens unseen.
        openConversations()
        openNewConversationTab(activeFolder.id, activeFolder.path)
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_folder)) {
        e.preventDefault()
        void handleOpenFolder()
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_settings)) {
        e.preventDefault()
        handleOpenSettings()
        return
      }

      // Tab navigation + close. These once lived in the visible tab strips,
      // which mobile no longer mounts; owning them here keeps mod+w / mod+tab /
      // mod+shift+tab working at every width — and, crucially, keeps
      // preventDefault firing so mod+w never falls through to closing the OS
      // window. Routing mirrors the old split: conversation pane vs files pane.
      const { conversation: conversationPaneActive, files: filesPaneActive } =
        tabShortcutTarget(
          mode,
          activePane,
          filesMaximized,
          conversationMaximized
        )

      const isNextTab = matchShortcutEvent(e, shortcuts.next_tab)
      const isPrevTab = matchShortcutEvent(e, shortcuts.prev_tab)
      if (isNextTab || isPrevTab) {
        if (!conversationPaneActive) return
        // A press moves the strip's highlight first and the switch follows
        // (see `stepConversationTab`), so the next press steps on from the
        // highlighted tab, which can be ahead of the active one.
        const fromId = tabStepPreviewId() ?? activeTabId
        if (navTabs.length < 2 || !fromId) return
        // The strip keeps the tab it highlights in view next to a folded
        // group's label, so the walk does too.
        const walk =
          fromId === activeTabId
            ? navTabs
            : shownTabs(
                navArranged,
                useTabArrangeStore.getState().collapsedRuns,
                fromId
              )
        const currentIndex = walk.findIndex((tab) => tab.id === fromId)
        if (currentIndex === -1) return
        e.preventDefault()
        const offset = isNextTab ? 1 : -1
        const nextIndex = (currentIndex + offset + walk.length) % walk.length
        stepConversationTab(
          walk[nextIndex].id,
          e,
          (event) =>
            matchShortcutEvent(event, shortcuts.next_tab) ||
            matchShortcutEvent(event, shortcuts.prev_tab)
        )
        return
      }

      const numberedIndex = numberedTabIndexFromEvent(e, shortcuts)
      if (numberedIndex !== null) {
        // A Ctrl chord belongs to a focused terminal — with the defaults it is
        // a control code, and Ctrl+6 is the Ctrl+^ that switches vim's
        // alternate file — so decline there, the same way the zoom listener
        // declines Ctrl+-/Ctrl+= (see appearance-provider). This covers a
        // remapped Ctrl binding too, which is the behaviour we want. Cmd
        // carries no shell meaning, so on macOS the jump keeps working over a
        // focused terminal.
        if (
          e.ctrlKey &&
          !e.metaKey &&
          e.target instanceof Element &&
          e.target.closest('[data-terminal-panel-region="true"]')
        ) {
          return
        }
        if (conversationPaneActive) {
          const tabId = pickNumberedTabId(
            navTabs.map((tab) => tab.id),
            numberedIndex
          )
          if (!tabId) return
          e.preventDefault()
          switchTab(tabId)
          return
        }
        if (filesPaneActive) {
          const tabId = pickNumberedTabId(
            fileTabs.map((tab) => tab.id),
            numberedIndex
          )
          if (!tabId) return
          e.preventDefault()
          switchFileTab(tabId)
          return
        }
        return
      }

      if (
        filesPaneActive &&
        matchShortcutEvent(e, shortcuts.close_all_file_tabs)
      ) {
        e.preventDefault()
        closeAllFileTabs()
        return
      }

      if (matchShortcutEvent(e, shortcuts.close_window)) {
        // The same close as the window's own close button (for the main
        // window that runs its close-behavior preference; a remote workspace
        // window simply closes). Only the focused window sees the key, so
        // another window is never taken down. A browser tab can't close
        // itself, so the web build leaves the key alone.
        if (!isDesktop()) return
        e.preventDefault()
        void closeCurrentWindow()
        return
      }

      if (matchShortcutEvent(e, shortcuts.close_current_tab)) {
        // Always claimed, even with no tab to close: a key the page leaves
        // alone goes on to the native menu, and closing a tab must never
        // become closing the window.
        e.preventDefault()
        closeCurrentTab(activePane)
        return
      }

      if (matchShortcutEvent(e, shortcuts.reopen_last_closed_tab)) {
        e.preventDefault()
        // Every entry carries the slot it was closed from, and each opener
        // puts the tab back there (clamped to the strip) rather than at the
        // end.
        while (true) {
          const closed = popClosedTab()
          if (!closed) return
          if (closed.kind === "file") {
            void openFilePreview(closed.path, {
              folderId: closed.folderId ?? undefined,
              index: closed.index,
            })
            return
          }
          if (closed.kind === "browser") {
            // Back at the page it was showing; a tab already on that page is
            // activated instead (the usual one-tab-per-URL rule).
            openBrowserTab(closed.url, {
              folderId: closed.folderId ?? undefined,
              index: closed.index,
              profile: closed.profile,
              // Said only when it was remote: otherwise the address decides,
              // as it does when the tab comes back after a restart.
              ...(closed.remote === true ? { remote: true } : {}),
              ...(closed.device ? { device: closed.device } : {}),
            })
            return
          }
          if (closed.kind === "subagent") {
            // Its session deleted since: nothing to read the thread from.
            if (isConversationDeleted(closed.target.parentConversationId)) {
              continue
            }
            openConversations()
            useTabStore.getState().openSubagentTab(closed.target, {
              pin: closed.isPinned,
              title: closed.title,
              index: closed.index,
              folderId: closed.folderId,
            })
            return
          }
          if (closed.conversationId != null) {
            // A deletion seen at any point wins. `applyConversationRemove`
            // purges what is on the stack when it runs, but a tab that was
            // still open then gets recorded afterwards, when the user closes
            // it by hand — that entry can only be caught here.
            if (isConversationDeleted(closed.conversationId)) continue
            openConversations()
            openTab(
              closed.folderId,
              closed.conversationId,
              closed.agentType,
              closed.isPinned,
              closed.title,
              { index: closed.index }
            )
            return
          }
          const folder = useAppWorkspaceStore
            .getState()
            .getFolder(closed.folderId)
          const workingDir = closed.workingDir ?? folder?.path
          if (!workingDir) continue
          openConversations()
          openNewConversationTab(closed.folderId, workingDir, {
            index: closed.index,
          })
          return
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [
    activeFolder,
    handleOpenFolder,
    handleOpenSettings,
    openConversations,
    openNewConversationTab,
    openTab,
    openFilePreview,
    openBrowserTab,
    setSearchOpen,
    shortcuts,
    toggle,
    toggleAuxPanel,
    toggleTerminal,
    isChatMode,
    tabs,
    navTabs,
    navArranged,
    activeTabId,
    switchTab,
    closeCurrentTab,
    mode,
    activePane,
    filesMaximized,
    conversationMaximized,
    fileTabs,
    closeAllFileTabs,
    switchFileTab,
  ])

  return (
    <>
      <SearchDialogHost />
      <WorkspaceFolderDialog open={browserOpen} onOpenChange={setBrowserOpen} />
    </>
  )
}
