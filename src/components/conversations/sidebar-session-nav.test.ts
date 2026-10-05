import { afterEach, describe, expect, it } from "vitest"
import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"
import { DEFAULT_SHORTCUTS } from "@/lib/keyboard-shortcuts"
import type { SidebarSortMode } from "@/lib/sidebar-view-mode-storage"
import {
  buildRows,
  buildSidebarLayout,
  groupByFolderWithReuse,
  layoutFolderIds,
  selectRecentConversationsWithReuse,
  type SidebarRow,
} from "./sidebar-conversation-grouping"
import {
  currentSessionRow,
  isSessionNavBlocked,
  sessionNavDirection,
  sessionRowScroll,
  stepSession,
  type SessionNavAnchor,
  type SessionNavDirection,
  type SessionNavSelection,
} from "./sidebar-session-nav"

const BASE = 1_700_000_000_000
const MINUTE = 60_000

function folder(
  id: number,
  overrides: Partial<FolderDetail> = {}
): FolderDetail {
  return {
    id,
    name: `folder-${id}`,
    path: `/repo/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

function group(id: number, sortOrder: number): FolderGroupDetail {
  return { id, name: `group-${id}`, color: "inherit", sort_order: sortOrder }
}

/** `createdMin` / `updatedMin` are minutes after a fixed base. */
function conv(
  id: number,
  folderId: number,
  createdMin: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const at = new Date(BASE + createdMin * MINUTE).toISOString()
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
    ...overrides,
  }
}

/** The sidebar's rows, derived the way the list derives them. */
function sidebarRows(opts: {
  folders: FolderDetail[]
  groups?: FolderGroupDetail[]
  conversations: DbConversationSummary[]
  sortMode?: SidebarSortMode
  folderExpanded?: Record<number, boolean>
  groupExpanded?: Record<number, boolean>
  foldersExpanded?: boolean
  showRecent?: boolean
  folderSessionLimit?: number | null
  pinned?: DbConversationSummary[]
  conversationExpanded?: Set<number>
  childrenByParent?: Map<number, DbConversationSummary[]>
}): SidebarRow[] {
  const sortMode = opts.sortMode ?? "updated"
  const layout = buildSidebarLayout({
    folders: opts.folders,
    groups: opts.groups ?? [],
  })
  const unpinned = opts.conversations.filter((c) => c.pinned_at == null)
  return buildRows({
    pinned: opts.pinned ?? [],
    pinnedExpanded: true,
    orderedFolderIds: layoutFolderIds(layout),
    byFolder: groupByFolderWithReuse(unpinned, sortMode, new Map()),
    folderExpanded: opts.folderExpanded ?? {},
    folderTotalCounts: new Map(),
    foldersExpanded: opts.foldersExpanded ?? true,
    chatConversations: [],
    chatsExpanded: true,
    recentConversations: selectRecentConversationsWithReuse(
      opts.conversations,
      true,
      sortMode,
      new Set(opts.folders.map((f) => f.id)),
      []
    ),
    showRecent: opts.showRecent ?? false,
    layout,
    groupExpanded: opts.groupExpanded ?? {},
    folderSessionLimit: opts.folderSessionLimit ?? null,
    conversationExpanded: opts.conversationExpanded,
    childrenByParent: opts.childrenByParent,
  })
}

const at = (id: number): SessionNavSelection => ({
  id,
  agentType: "claude_code",
})

/**
 * Every session `direction` reaches from `start`, one step at a time, carrying
 * the anchor between steps as the sidebar does.
 */
function walk(
  rows: SidebarRow[],
  start: number | null,
  direction: SessionNavDirection
): number[] {
  const seen: number[] = []
  let selection = start === null ? null : at(start)
  let anchor: SessionNavAnchor | null = null
  for (let guard = 0; guard < 100; guard++) {
    const step = stepSession(rows, selection, direction, anchor)
    if (!step) return seen
    seen.push(step.conversation.id)
    selection = at(step.conversation.id)
    anchor = step.anchor
  }
  throw new Error("walk did not stop")
}

describe("stepSession — order", () => {
  const folders = [folder(1), folder(2)]

  it("walks down and up through every folder in the order listed", () => {
    const rows = sidebarRows({
      folders,
      conversations: [conv(11, 1, 3), conv(12, 1, 2), conv(21, 2, 1)],
    })
    expect(walk(rows, 11, 1)).toEqual([12, 21])
    expect(walk(rows, 21, -1)).toEqual([12, 11])
  })

  it("follows the sort mode, not the id order", () => {
    // conv 11 is the OLDEST session but the most recently updated one.
    const conversations = [
      conv(11, 1, 1, {
        updated_at: new Date(BASE + 90 * MINUTE).toISOString(),
      }),
      conv(12, 1, 2),
      conv(13, 1, 3),
    ]
    const byUpdated = sidebarRows({ folders, conversations })
    expect(walk(byUpdated, null, 1)).toEqual([11, 13, 12])
    const byCreated = sidebarRows({
      folders,
      conversations,
      sortMode: "created",
    })
    expect(walk(byCreated, null, 1)).toEqual([13, 12, 11])
  })

  it("follows the folder order, groups included", () => {
    // Group 7 (sort 2) sits between folder 1 (sort 1) and folder 9 (sort 3);
    // inside it, member 6 is ordered before member 5.
    const rows = sidebarRows({
      folders: [
        folder(1, { sort_order: 1 }),
        folder(9, { sort_order: 3 }),
        folder(5, { sort_order: 2, group_id: 7 }),
        folder(6, { sort_order: 1, group_id: 7 }),
      ],
      groups: [group(7, 2)],
      conversations: [
        conv(11, 1, 1),
        conv(51, 5, 1),
        conv(61, 6, 1),
        conv(91, 9, 1),
      ],
    })
    expect(walk(rows, null, 1)).toEqual([11, 61, 51, 91])
    expect(walk(rows, null, -1)).toEqual([91, 51, 61, 11])
  })

  it("puts the pinned section first", () => {
    const pinnedConv = conv(31, 2, 1, {
      pinned_at: new Date(BASE).toISOString(),
    })
    const rows = sidebarRows({
      folders,
      conversations: [conv(11, 1, 1), pinnedConv],
      pinned: [pinnedConv],
    })
    expect(walk(rows, null, 1)).toEqual([31, 11])
  })

  it("steps into an expanded parent's sub-sessions", () => {
    const child = conv(111, 1, 5, { parent_id: 11 })
    const rows = sidebarRows({
      folders,
      conversations: [conv(11, 1, 3, { child_count: 1 }), conv(12, 1, 2)],
      conversationExpanded: new Set([11]),
      childrenByParent: new Map([[11, [child]]]),
    })
    expect(walk(rows, null, 1)).toEqual([11, 111, 12])
  })
})

describe("stepSession — what is hidden is skipped", () => {
  const conversations = [
    conv(11, 1, 1),
    conv(51, 5, 2),
    conv(52, 5, 1),
    conv(91, 9, 1),
  ]
  const folders = [
    folder(1, { sort_order: 1 }),
    folder(5, { sort_order: 1, group_id: 7 }),
    folder(9, { sort_order: 3 }),
  ]
  const groups = [group(7, 2)]

  it("skips the sessions of a collapsed group", () => {
    const rows = sidebarRows({
      folders,
      groups,
      conversations,
      groupExpanded: { 7: false },
    })
    expect(walk(rows, 11, 1)).toEqual([91])
    expect(walk(rows, 91, -1)).toEqual([11])
  })

  it("skips the sessions of a collapsed folder", () => {
    const rows = sidebarRows({
      folders,
      groups,
      conversations,
      folderExpanded: { 5: false },
    })
    expect(walk(rows, 11, 1)).toEqual([91])
  })

  it("skips sessions folded behind a folder's Show more row", () => {
    const rows = sidebarRows({
      folders,
      groups,
      conversations,
      folderSessionLimit: 1,
    })
    expect(rows.some((row) => row.kind === "folder-more")).toBe(true)
    expect(walk(rows, null, 1)).toEqual([11, 51, 91])
  })

  it("has nothing to step to when the Folders section is collapsed", () => {
    const rows = sidebarRows({
      folders,
      groups,
      conversations,
      foldersExpanded: false,
    })
    expect(stepSession(rows, null, 1, null)).toBeNull()
  })

  it("enters at the top or bottom when the active session is hidden", () => {
    const rows = sidebarRows({
      folders,
      groups,
      conversations,
      groupExpanded: { 7: false },
    })
    // 52 lives in the collapsed group.
    expect(currentSessionRow(rows, at(52), null)).toBe(-1)
    expect(stepSession(rows, at(52), 1, null)?.conversation.id).toBe(11)
    expect(stepSession(rows, at(52), -1, null)?.conversation.id).toBe(91)
  })
})

describe("stepSession — ends", () => {
  const rows = sidebarRows({
    folders: [folder(1)],
    conversations: [conv(11, 1, 2), conv(12, 1, 1)],
  })

  it("stops at the last session instead of wrapping", () => {
    expect(stepSession(rows, at(12), 1, null)).toBeNull()
  })

  it("stops at the first session instead of wrapping", () => {
    expect(stepSession(rows, at(11), -1, null)).toBeNull()
  })

  it("enters at the first or last session when nothing is selected", () => {
    expect(stepSession(rows, null, 1, null)?.conversation.id).toBe(11)
    expect(stepSession(rows, null, -1, null)?.conversation.id).toBe(12)
  })

  it("has nothing to step to in an empty list", () => {
    expect(stepSession([], null, 1, null)).toBeNull()
    expect(stepSession([], at(1), -1, null)).toBeNull()
  })
})

describe("stepSession — a session listed twice (Recent)", () => {
  // Folders, then Chat, then Recent (the default section order). Recent lists
  // the same sessions again, newest first.
  const rows = sidebarRows({
    folders: [folder(1), folder(2)],
    conversations: [conv(11, 1, 4), conv(12, 1, 3), conv(21, 2, 5)],
    showRecent: true,
  })

  it("walks on into the Recent copies, as they are listed", () => {
    const listed = rows.flatMap((row) =>
      row.kind === "conversation" ? [row.conversation.id] : []
    )
    expect(listed).toEqual([11, 12, 21, 21, 11, 12])
    // Recent's 21 sits right under folder 2's 21, so it is no step of its own.
    expect(walk(rows, null, 1)).toEqual([11, 12, 21, 11, 12])
    expect(walk(rows, null, -1)).toEqual([12, 11, 21, 12, 11])
  })

  it("never spends a step on another copy of the active session", () => {
    // From folder 2's 21 the next row is Recent's copy of 21 — passed over.
    expect(stepSession(rows, at(21), 1, null)?.conversation.id).toBe(11)
  })

  it("continues from the copy the last step landed on", () => {
    const intoRecent = stepSession(rows, at(21), 1, null)
    expect(intoRecent?.anchor.recent).toBe(true)
    // Without the anchor the active session resolves to its folder row, which
    // would send the next step back up into the Folders section.
    const next = stepSession(rows, at(11), 1, intoRecent!.anchor)
    expect(next?.conversation.id).toBe(12)
    expect(next?.anchor.recent).toBe(true)
    expect(stepSession(rows, at(11), 1, null)?.conversation.id).toBe(12)
    expect(stepSession(rows, at(11), 1, null)?.anchor.recent).toBe(false)
  })

  it("ignores an anchor left by a different session", () => {
    const stale: SessionNavAnchor = {
      ...at(12),
      recent: true,
      index: rows.length - 1,
    }
    // The active session is 11 (clicked since): start from its folder row.
    expect(stepSession(rows, at(11), 1, stale)?.anchor.recent).toBe(false)
  })
})

describe("sessionNavDirection", () => {
  const key = (
    k: string,
    mods: Partial<
      Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
    >
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  })

  it("reads Cmd+Shift+Down / Up as next / previous", () => {
    expect(
      sessionNavDirection(
        key("ArrowDown", { metaKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(1)
    expect(
      sessionNavDirection(
        key("ArrowUp", { metaKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(-1)
  })

  it("reads Ctrl+Shift the same, as every mod shortcut does", () => {
    expect(
      sessionNavDirection(
        key("ArrowDown", { ctrlKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(1)
  })

  it("leaves the plain and other-modifier arrows alone", () => {
    for (const mods of [
      {},
      { shiftKey: true },
      { metaKey: true },
      { metaKey: true, shiftKey: true, altKey: true },
    ]) {
      expect(
        sessionNavDirection(key("ArrowDown", mods), DEFAULT_SHORTCUTS)
      ).toBeNull()
    }
  })

  it("follows a rebinding", () => {
    const rebound = { next_session: "mod+alt+j", prev_session: "" }
    expect(
      sessionNavDirection(
        { ...key("j", { metaKey: true, altKey: true }), code: "KeyJ" },
        rebound
      )
    ).toBe(1)
    expect(
      sessionNavDirection(
        key("ArrowUp", { metaKey: true, shiftKey: true }),
        rebound
      )
    ).toBeNull()
  })
})

describe("isSessionNavBlocked", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  function mount(html: string) {
    document.body.innerHTML = html
    return {
      sidebar: document.querySelector("[data-test-sidebar]"),
      el: (selector: string) => document.querySelector(selector),
    }
  }

  it("lets the composer and the rest of the window through", () => {
    const { sidebar, el } = mount(
      `<div data-test-sidebar></div><div contenteditable="true" id="composer"></div>`
    )
    expect(isSessionNavBlocked(el("#composer"), document, sidebar)).toBe(false)
    expect(isSessionNavBlocked(document.body, document, sidebar)).toBe(false)
  })

  it("leaves the chord to the built-in terminal", () => {
    const { sidebar, el } = mount(
      `<div data-test-sidebar></div>
       <div data-terminal-panel-region="true"><textarea id="term"></textarea></div>
       <div class="xterm"><textarea id="canvas-term"></textarea></div>`
    )
    expect(isSessionNavBlocked(el("#term"), document, sidebar)).toBe(true)
    expect(isSessionNavBlocked(el("#canvas-term"), document, sidebar)).toBe(
      true
    )
  })

  it("stays out of an open dialog, wherever focus is", () => {
    const { sidebar, el } = mount(
      `<div data-test-sidebar></div><input id="outside" />
       <div role="dialog" data-state="open"><input id="inside" /></div>`
    )
    expect(isSessionNavBlocked(el("#inside"), document, sidebar)).toBe(true)
    expect(isSessionNavBlocked(el("#outside"), document, sidebar)).toBe(true)
  })

  it("stays out of alert dialogs and open menus", () => {
    const alert = mount(
      `<div data-test-sidebar></div><div role="alertdialog" data-state="open"></div>`
    )
    expect(isSessionNavBlocked(document.body, document, alert.sidebar)).toBe(
      true
    )
    const menu = mount(
      `<div data-test-sidebar></div><div role="menu" data-state="open"></div>`
    )
    expect(isSessionNavBlocked(document.body, document, menu.sidebar)).toBe(
      true
    )
  })

  it("ignores a dialog that has closed", () => {
    const { sidebar } = mount(
      `<div data-test-sidebar></div><div role="dialog" data-state="closed"></div>`
    )
    expect(isSessionNavBlocked(document.body, document, sidebar)).toBe(false)
  })

  it("treats the drawer the sidebar lives in as the sidebar", () => {
    const { sidebar, el } = mount(
      `<div role="dialog" data-state="open">
         <div data-test-sidebar><button id="row"></button></div>
       </div>`
    )
    expect(isSessionNavBlocked(el("#row"), document, sidebar)).toBe(false)
    expect(isSessionNavBlocked(document.body, document, sidebar)).toBe(false)
  })
})

describe("sessionRowScroll", () => {
  const view = { scrollOffset: 320, viewportSize: 320, topInset: 32 }

  it("leaves a row in full view where it is", () => {
    expect(sessionRowScroll({ ...view, itemOffset: 400, itemSize: 32 })).toBe(
      null
    )
  })

  it("scrolls a row above the view to just under the sticky header", () => {
    expect(
      sessionRowScroll({ ...view, itemOffset: 288, itemSize: 32 })
    ).toEqual({ align: "start", offset: -32 })
    // Under the sticky header counts as hidden too.
    expect(
      sessionRowScroll({ ...view, itemOffset: 336, itemSize: 32 })
    ).toEqual({ align: "start", offset: -32 })
  })

  it("scrolls a row below the view up to the bottom edge", () => {
    expect(
      sessionRowScroll({ ...view, itemOffset: 620, itemSize: 32 })
    ).toEqual({ align: "end" })
  })

  it("needs no inset outside a folder", () => {
    expect(
      sessionRowScroll({ ...view, topInset: 0, itemOffset: 320, itemSize: 32 })
    ).toBe(null)
  })
})
