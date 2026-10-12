import { describe, expect, it } from "vitest"

import type {
  DbConversationSummary,
  FolderDetail,
  FolderGroupDetail,
} from "@/lib/types"
import { recentSessions } from "@/lib/recent-sessions"
import {
  archivedFolderIds,
  buildRows,
  buildSidebarLayout,
  selectRecentConversationsWithReuse,
  type SidebarRow,
} from "./sidebar-conversation-grouping"

function folder(
  id: number,
  overrides: Partial<FolderDetail> = {}
): FolderDetail {
  return {
    id,
    name: `f${id}`,
    path: `/p/${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-10-01T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...overrides,
  }
}

function group(
  id: number,
  overrides: Partial<FolderGroupDetail> = {}
): FolderGroupDetail {
  return {
    id,
    name: `g${id}`,
    color: "inherit",
    sort_order: id,
    ...overrides,
  }
}

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
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
    ...overrides,
  } as DbConversationSummary
}

const NO_CHILDREN = new Map<number, number>()

describe("archivedFolderIds", () => {
  it("is empty for folders and groups from a server without the flag", () => {
    const ids = archivedFolderIds({
      folders: [folder(1), folder(2, { group_id: 7 })],
      groups: [group(7)],
      childToParent: NO_CHILDREN,
    })
    expect(ids.size).toBe(0)
  })

  it("takes a folder's own flag and its group's", () => {
    const ids = archivedFolderIds({
      folders: [
        folder(1, { archived: true }),
        folder(2, { group_id: 7 }),
        folder(3, { group_id: 8 }),
        folder(4),
      ],
      groups: [group(7, { archived: true }), group(8, { archived: false })],
      childToParent: NO_CHILDREN,
    })
    expect([...ids].sort()).toEqual([1, 2])
  })

  it("ignores a group that is not in the list, like the layout does", () => {
    const ids = archivedFolderIds({
      folders: [folder(2, { group_id: 99 })],
      groups: [],
      childToParent: NO_CHILDREN,
    })
    expect(ids.size).toBe(0)
  })

  it("makes a worktree child follow its repo, whatever its own flag says", () => {
    const ids = archivedFolderIds({
      folders: [
        folder(1, { archived: true }),
        folder(10, { parent_id: 1 }),
        folder(2),
        folder(20, { parent_id: 2, archived: true }),
      ],
      groups: [],
      childToParent: new Map([
        [10, 1],
        [20, 2],
      ]),
    })
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 10])
  })
})

describe("selectRecentConversationsWithReuse — archive filter", () => {
  const open = new Set([1, 2])
  const conversations = [
    conv(11, 1),
    conv(21, 2),
    conv(22, 2),
    conv(31, 77, { kind: "chat" }),
  ]

  it("leaves out sessions of archived folders", () => {
    const rows = selectRecentConversationsWithReuse(
      conversations,
      true,
      "updated",
      open,
      [],
      { folderIds: new Set([2]), keep: new Set<number>() }
    )
    expect(rows.map((c) => c.id)).toEqual([11, 31])
  })

  it("keeps an archived folder's session that is waiting on the user", () => {
    const rows = selectRecentConversationsWithReuse(
      conversations,
      true,
      "updated",
      open,
      [],
      { folderIds: new Set([2]), keep: new Map([[22, "permission"]]) }
    )
    expect(rows.map((c) => c.id)).toEqual([11, 22, 31])
  })

  it("is the old list without a filter", () => {
    const rows = selectRecentConversationsWithReuse(
      conversations,
      true,
      "updated",
      open,
      []
    )
    expect(rows.map((c) => c.id)).toEqual([11, 21, 22, 31])
  })
})

describe("recentSessions — archived folders", () => {
  const conversations = [conv(11, 1), conv(21, 2)]
  const known = new Set([1, 2])

  it("drops archived folders from the unscoped list", () => {
    const rows = recentSessions(conversations, {
      knownFolderIds: known,
      excludeFolderIds: new Set([2]),
      limit: 10,
    })
    expect(rows.map((c) => c.id)).toEqual([11])
  })

  it("keeps them when the list is narrowed to that folder", () => {
    const rows = recentSessions(conversations, {
      knownFolderIds: known,
      excludeFolderIds: new Set([2]),
      folderId: 2,
      limit: 10,
    })
    expect(rows.map((c) => c.id)).toEqual([21])
  })
})

describe("buildRows — the Archived section", () => {
  const byFolder = new Map<number, DbConversationSummary[]>([
    [1, [conv(11, 1)]],
    [2, [conv(21, 2)]],
    [3, [conv(31, 3)]],
  ])
  const activeLayout = buildSidebarLayout({ folders: [folder(1)], groups: [] })
  const archivedLayout = buildSidebarLayout({
    folders: [folder(2, { group_id: 7, sort_order: 1 }), folder(3)],
    groups: [group(7, { archived: true, sort_order: 2 })],
  })

  function rows(extra: Partial<Parameters<typeof buildRows>[0]>) {
    return buildRows({
      pinned: [],
      pinnedExpanded: true,
      orderedFolderIds: [1],
      byFolder,
      folderExpanded: {},
      folderTotalCounts: new Map(),
      foldersExpanded: true,
      chatConversations: [],
      chatsExpanded: true,
      layout: activeLayout,
      ...extra,
    })
  }

  function shape(list: SidebarRow[]) {
    return list.map((row) => {
      if (row.kind === "section") return `section:${row.section}`
      if (row.kind === "folder") return `folder:${row.folderId}`
      if (row.kind === "folder-group") return `group:${row.groupId}`
      if (row.kind === "conversation") return `conv:${row.conversation.id}`
      return row.kind
    })
  }

  it("emits nothing new when nothing is archived", () => {
    expect(shape(rows({}))).toEqual([
      "section:folders",
      "folder:1",
      "conv:11",
      "section:chats",
      "chats-empty",
    ])
  })

  it("adds a collapsed heading at the very bottom", () => {
    const list = rows({
      archivedLayout,
      showRecent: true,
      recentConversations: [conv(11, 1)],
      // Recent placed last by the user: Archived still comes after it.
      sectionOrder: ["chats", "folders", "recent"],
    })
    expect(shape(list).slice(-1)).toEqual(["section:archived"])
    const heading = list[list.length - 1]
    expect(heading).toMatchObject({
      kind: "section",
      section: "archived",
      expanded: false,
      // Folders, not entries: the group's member plus the loose one.
      count: 2,
    })
  })

  it("lists archived groups and folders like the Folders section when open", () => {
    const list = rows({ archivedLayout, archivedExpanded: true })
    const tail = shape(list).slice(shape(list).indexOf("section:archived"))
    expect(tail).toEqual([
      "section:archived",
      "group:7",
      "folder:2",
      "conv:21",
      "folder:3",
      "conv:31",
    ])
    // The archived folders are not in the Folders section.
    const head = shape(list).slice(0, shape(list).indexOf("section:chats"))
    expect(head).not.toContain("folder:2")
    expect(head).not.toContain("folder:3")
  })
})
