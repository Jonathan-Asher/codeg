import { describe, expect, it } from "vitest"

import {
  compareByRecencyDesc,
  compareBySwitchOrder,
  recentSessions,
} from "./recent-sessions"
import type { DbConversationSummary } from "./types"

function conv(
  id: number,
  updatedAt: string,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `Session ${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
    pinned_at: null,
    parent_id: null,
    ...over,
  }
}

const known = new Set([1, 2])

describe("recentSessions", () => {
  it("lists the most recently active sessions first, up to the limit", () => {
    const list = [
      conv(1, "2026-09-30T09:00:00Z"),
      conv(2, "2026-09-30T11:00:00.000Z"),
      conv(3, "2026-09-30T10:00:00+00:00"),
    ]
    const ids = recentSessions(list, { knownFolderIds: known, limit: 2 }).map(
      (c) => c.id
    )
    expect(ids).toEqual([2, 3])
  })

  it("leaves out what the sidebar does not list, and the excluded session", () => {
    const list = [
      conv(1, "2026-09-30T09:00:00Z"),
      conv(2, "2026-09-30T09:00:00Z", { parent_id: 1, kind: "delegate" }),
      conv(3, "2026-09-30T09:00:00Z", { kind: "loop" }),
      conv(4, "2026-09-30T09:00:00Z", { folder_id: 9 }),
      conv(5, "2026-09-30T09:00:00Z"),
    ]
    const ids = recentSessions(list, {
      knownFolderIds: known,
      excludeId: 5,
      limit: 30,
    }).map((c) => c.id)
    expect(ids).toEqual([1])
  })

  it("narrows to one folder and one agent", () => {
    const list = [
      conv(1, "2026-09-30T09:00:00Z"),
      conv(2, "2026-09-30T09:00:00Z", { folder_id: 2 }),
      conv(3, "2026-09-30T09:00:00Z", { agent_type: "codex" }),
    ]
    const ids = recentSessions(list, {
      knownFolderIds: known,
      folderId: 1,
      agentType: "claude_code",
      limit: 30,
    }).map((c) => c.id)
    expect(ids).toEqual([1])
  })
})

describe("switcher order (empty query)", () => {
  it("puts the most recently opened first, whatever ran since", () => {
    const list = [
      // Opened second to last, then a background agent wrote to it.
      conv(1, "2026-10-26T11:35:00Z", {
        last_viewed_at: "2026-10-26T09:00:00Z",
      }),
      // Opened last, quiet since.
      conv(2, "2026-10-26T08:00:00Z", {
        last_viewed_at: "2026-10-26T10:00:00Z",
      }),
      // Never opened, but the freshest activity of all.
      conv(3, "2026-10-26T11:40:00Z", { last_viewed_at: null }),
      // The current session.
      conv(4, "2026-10-26T07:00:00Z", {
        last_viewed_at: "2026-10-26T11:00:00Z",
      }),
    ]
    const ids = recentSessions(list, {
      knownFolderIds: known,
      excludeId: 4,
      limit: 10,
    }).map((c) => c.id)
    // Shortcut + Enter goes back to 2, the session viewed before 4.
    expect(ids).toEqual([2, 1, 3])
  })

  it("orders never-opened sessions by activity, after the opened ones", () => {
    const list = [
      conv(1, "2026-10-26T09:00:00Z"),
      conv(2, "2026-10-26T11:00:00Z"),
      conv(3, "2026-10-26T08:00:00Z", {
        last_viewed_at: "2026-10-20T08:00:00Z",
      }),
    ]
    expect([...list].sort(compareBySwitchOrder).map((c) => c.id)).toEqual([
      3, 2, 1,
    ])
  })
})

describe("compareByRecencyDesc (sidebar Recent)", () => {
  it("orders by the later of the last activity and the last view", () => {
    const list = [
      conv(1, "2026-10-26T09:00:00Z", {
        last_viewed_at: "2026-10-26T11:30:00Z",
      }),
      conv(2, "2026-10-26T11:00:00Z", { last_viewed_at: null }),
      conv(3, "2026-10-26T11:45:00Z", {
        last_viewed_at: "2026-10-26T08:00:00Z",
      }),
      conv(4, "2026-10-26T10:00:00Z"),
    ]
    expect([...list].sort(compareByRecencyDesc).map((c) => c.id)).toEqual([
      3, 1, 2, 4,
    ])
  })

  it("breaks a tie on activity, then on id", () => {
    const at = "2026-10-26T10:00:00Z"
    const list = [
      conv(1, "2026-10-26T09:00:00Z", { last_viewed_at: at }),
      conv(2, at),
      conv(3, at),
    ]
    expect([...list].sort(compareByRecencyDesc).map((c) => c.id)).toEqual([
      3, 2, 1,
    ])
  })
})
