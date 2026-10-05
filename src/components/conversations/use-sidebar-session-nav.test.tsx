import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VirtualizerHandle } from "virtua"
import type { DbConversationSummary } from "@/lib/types"
import {
  SHORTCUTS_STORAGE_KEY,
  setShortcutRecorderArmed,
} from "@/lib/keyboard-shortcuts"
import {
  SESSION_CONNECT_SETTLE_MS,
  releaseSessionConnectHold,
  useSessionConnectHoldStore,
} from "@/stores/session-connect-hold-store"
import {
  buildOwnerHeaderIndex,
  buildRows,
  type SidebarRow,
} from "./sidebar-conversation-grouping"
import type { SessionNavSelection } from "./sidebar-session-nav"
import { useSidebarSessionNav } from "./use-sidebar-session-nav"

function conv(id: number, folderId: number): DbConversationSummary {
  const at = new Date(1_700_000_000_000 - id * 60_000).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: at,
    updated_at: at,
    pinned_at: null,
  }
}

/** Folders 1 and 2, three sessions each: rows are
 *  [section, folder 1, 11, 12, 13, folder 2, 21, 22, 23, section, chats-empty]. */
function rowsFixture(): SidebarRow[] {
  return buildRows({
    pinned: [],
    pinnedExpanded: true,
    orderedFolderIds: [1, 2],
    byFolder: new Map([
      [1, [conv(11, 1), conv(12, 1), conv(13, 1)]],
      [2, [conv(21, 2), conv(22, 2), conv(23, 2)]],
    ]),
    folderExpanded: {},
    folderTotalCounts: new Map(),
    foldersExpanded: true,
    chatConversations: [],
    chatsExpanded: true,
  })
}

const ROW_PX = 32

function setup(
  opts: {
    selection?: number | null
    suspended?: boolean
    scrollOffset?: number
    viewportSize?: number
  } = {}
) {
  const rows = rowsFixture()
  const selectionRef = {
    current:
      opts.selection === null
        ? null
        : ({
            id: opts.selection ?? 11,
            agentType: "claude_code",
          } as SessionNavSelection | null),
  }
  const handle = {
    scrollOffset: opts.scrollOffset ?? 0,
    viewportSize: opts.viewportSize ?? rows.length * ROW_PX,
    getItemOffset: (index: number) => index * ROW_PX,
    getItemSize: () => ROW_PX,
    scrollToIndex: vi.fn(),
  }
  const sidebar = document.createElement("div")
  document.body.append(sidebar)
  // Clicking a row makes its session the active tab's; mirror that.
  const onOpen = vi.fn((conversation: DbConversationSummary) => {
    selectionRef.current = {
      id: conversation.id,
      agentType: conversation.agent_type,
    }
  })
  const view = renderHook(() =>
    useSidebarSessionNav({
      rowsRef: { current: rows },
      selectionRef,
      ownerHeaderIndexRef: { current: buildOwnerHeaderIndex(rows) },
      virtualizerRef: {
        current: handle as unknown as VirtualizerHandle,
      },
      sidebarRef: { current: sidebar },
      isSuspended: () => opts.suspended ?? false,
      onOpen,
    })
  )
  const opened = () => onOpen.mock.calls.map(([c]) => c.id)
  return { rows, handle, onOpen, opened, unmount: view.unmount }
}

function press(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = { metaKey: true, shiftKey: true }
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function appendComposer(): HTMLElement {
  const composer = document.createElement("div")
  composer.contentEditable = "true"
  document.body.append(composer)
  return composer
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  releaseSessionConnectHold()
  setShortcutRecorderArmed(false)
  window.localStorage.clear()
  document.body.innerHTML = ""
  vi.useRealTimers()
})

describe("useSidebarSessionNav — stepping", () => {
  it("opens the next session down, from inside the composer", () => {
    const { opened } = setup({ selection: 11 })
    const composer = appendComposer()
    const composerKeys = vi.fn()
    composer.addEventListener("keydown", composerKeys)

    const event = press(composer, "ArrowDown")

    expect(opened()).toEqual([12])
    // The composer never sees the chord, so it cannot extend its selection.
    expect(event.defaultPrevented).toBe(true)
    expect(composerKeys).not.toHaveBeenCalled()
  })

  it("opens the previous session up", () => {
    const { opened } = setup({ selection: 21 })
    press(document.body, "ArrowUp")
    expect(opened()).toEqual([13])
  })

  it("crosses folders and stops at the last session without wrapping", () => {
    const { opened } = setup({ selection: 12 })
    for (let i = 0; i < 6; i++) press(document.body, "ArrowDown")
    expect(opened()).toEqual([13, 21, 22, 23])
  })

  it("stops at the first session without wrapping", () => {
    const { opened } = setup({ selection: 12 })
    press(document.body, "ArrowUp")
    press(document.body, "ArrowUp")
    expect(opened()).toEqual([11])
  })

  it("keeps the chord at an end, so the composer does not take it instead", () => {
    const { opened } = setup({ selection: 23 })
    const composer = appendComposer()
    const event = press(composer, "ArrowDown")
    expect(opened()).toEqual([])
    expect(event.defaultPrevented).toBe(true)
    expect(useSessionConnectHoldStore.getState().held).toBe(false)
  })

  it("enters the list at the top when no session is selected", () => {
    const { opened } = setup({ selection: null })
    press(document.body, "ArrowDown")
    expect(opened()).toEqual([11])
  })

  it("reads Ctrl+Shift as the same chord", () => {
    const { opened } = setup({ selection: 11 })
    press(document.body, "ArrowDown", { ctrlKey: true, shiftKey: true })
    expect(opened()).toEqual([12])
  })

  it("ignores the arrows without the full chord", () => {
    const { opened } = setup({ selection: 11 })
    const plain = press(document.body, "ArrowDown", {})
    const shiftOnly = press(document.body, "ArrowDown", { shiftKey: true })
    expect(opened()).toEqual([])
    expect(plain.defaultPrevented).toBe(false)
    expect(shiftOnly.defaultPrevented).toBe(false)
  })

  it("stops listening when the sidebar list unmounts", () => {
    const { opened, unmount } = setup({ selection: 11 })
    unmount()
    const event = press(document.body, "ArrowDown")
    expect(opened()).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})

describe("useSidebarSessionNav — where the chord is not ours", () => {
  it("leaves it to the built-in terminal", () => {
    const { opened } = setup({ selection: 11 })
    const region = document.createElement("div")
    region.setAttribute("data-terminal-panel-region", "true")
    const input = document.createElement("textarea")
    region.append(input)
    document.body.append(region)

    const event = press(input, "ArrowDown")
    expect(opened()).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it("leaves it alone while a dialog is open", () => {
    const { opened } = setup({ selection: 11 })
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("data-state", "open")
    const field = document.createElement("input")
    dialog.append(field)
    document.body.append(dialog)

    expect(press(field, "ArrowDown").defaultPrevented).toBe(false)
    expect(press(document.body, "ArrowDown").defaultPrevented).toBe(false)
    expect(opened()).toEqual([])
  })

  it("leaves it to an input method mid-composition", () => {
    const { opened } = setup({ selection: 11 })
    const event = press(document.body, "ArrowDown", {
      metaKey: true,
      shiftKey: true,
      isComposing: true,
    } as KeyboardEventInit)
    expect(opened()).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it("waits out a folder drag", () => {
    const { opened } = setup({ selection: 11, suspended: true })
    expect(press(document.body, "ArrowDown").defaultPrevented).toBe(false)
    expect(opened()).toEqual([])
  })

  it("lets the shortcut recorder have the key", () => {
    const { opened } = setup({ selection: 11 })
    setShortcutRecorderArmed(true)
    press(document.body, "ArrowDown")
    expect(opened()).toEqual([])
  })
})

describe("useSidebarSessionNav — rebinding", () => {
  it("follows the binding saved in Settings → Shortcuts", () => {
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ next_session: "mod+alt+j" })
    )
    const { opened } = setup({ selection: 11 })

    expect(press(document.body, "ArrowDown").defaultPrevented).toBe(false)
    press(document.body, "j", { metaKey: true, altKey: true, code: "KeyJ" })
    expect(opened()).toEqual([12])
  })
})

describe("useSidebarSessionNav — agent connection", () => {
  it("holds the connection until the steps have paused", () => {
    const { opened } = setup({ selection: 11 })
    const held = () => useSessionConnectHoldStore.getState().held

    press(document.body, "ArrowDown")
    expect(held()).toBe(true)
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS - 100)
    press(document.body, "ArrowDown")
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS - 100)
    press(document.body, "ArrowDown")
    // Each step re-arms the hold: 600 ms in, still held.
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS - 1)
    expect(held()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(held()).toBe(false)
    expect(opened()).toEqual([12, 13, 21])
  })
})

describe("useSidebarSessionNav — scrolling the row into view", () => {
  it("leaves the list where it is when the row is already in view", () => {
    const { handle } = setup({ selection: 11 })
    press(document.body, "ArrowDown")
    vi.advanceTimersByTime(20)
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
  })

  it("brings a row below the view up to the bottom edge", () => {
    // Rows 0-4 in view; 21 is row 6.
    const { handle } = setup({
      selection: 13,
      viewportSize: 5 * ROW_PX,
    })
    press(document.body, "ArrowDown")
    vi.advanceTimersByTime(20)
    expect(handle.scrollToIndex).toHaveBeenCalledWith(6, {
      align: "end",
      smooth: false,
    })
  })

  it("brings a row above the view down to just under its sticky folder header", () => {
    // Scrolled to row 4; 12 (row 3) is above the view.
    const { handle } = setup({
      selection: 13,
      scrollOffset: 4 * ROW_PX,
      viewportSize: 5 * ROW_PX,
    })
    press(document.body, "ArrowUp")
    vi.advanceTimersByTime(20)
    expect(handle.scrollToIndex).toHaveBeenCalledWith(3, {
      align: "start",
      offset: -ROW_PX,
      smooth: false,
    })
  })
})
