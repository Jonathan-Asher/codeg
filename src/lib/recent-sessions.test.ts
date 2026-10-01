import { describe, expect, it } from "vitest"

import { recentSessions } from "./recent-sessions"
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
