import { describe, expect, it } from "vitest"
import type { AttentionKind, ConversationStatus } from "@/lib/types"
import {
  arrangeTabs,
  folderAccentColor,
  tabStatusBand,
} from "./tab-arrangement"

function tab(
  id: string,
  folderId: number,
  status?: ConversationStatus,
  conversationId: number | null = Number(id.replace(/\D/g, "")) || null
) {
  return { id, folderId, conversationId, status }
}

const none = new Map<number, AttentionKind>()

describe("arrangeTabs", () => {
  const tabs = [
    tab("t1", 1, "completed"),
    tab("t2", 2, "in_progress"),
    tab("t3", 1, "pending_review"),
    tab("t4", 3, "in_progress"),
    tab("t5", 2, "pending_review"),
  ]

  it("leaves manual mode untouched (same array, no groups)", () => {
    const r = arrangeTabs(tabs, "manual", none)
    expect(r.ordered).toBe(tabs)
    expect(r.runs).toBeNull()
  })

  it("groups by folder in first-appearance order, keeping manual order inside", () => {
    const r = arrangeTabs(tabs, "folder", none)
    expect(r.runs?.map((run) => run.key)).toEqual([
      "folder-1",
      "folder-2",
      "folder-3",
    ])
    expect(r.ordered.map((t) => t.id)).toEqual(["t1", "t3", "t2", "t5", "t4"])
    // Same objects — the strip's reorder list keys on identity.
    expect(r.ordered[0]).toBe(tabs[0])
  })

  it("sorts by status: waiting on you, your reply, running, then the rest", () => {
    const attention = new Map<number, AttentionKind>([[4, "permission"]])
    const r = arrangeTabs(tabs, "status", attention)
    expect(r.runs?.map((run) => run.key)).toEqual([
      "status-needs_you",
      "status-awaiting_reply",
      "status-running",
      "status-other",
    ])
    expect(r.ordered.map((t) => t.id)).toEqual(["t4", "t3", "t5", "t2", "t1"])
  })

  it("skips empty status bands", () => {
    const r = arrangeTabs([tab("t1", 1, "completed")], "status", none)
    expect(r.runs?.map((run) => run.key)).toEqual(["status-other"])
  })
})

describe("tabStatusBand", () => {
  it("puts a blocked session first whatever its status says", () => {
    const attention = new Map<number, AttentionKind>([[7, "question"]])
    expect(tabStatusBand(tab("t7", 1, "in_progress"), attention)).toBe(
      "needs_you"
    )
  })

  it("files a draft (no conversation yet) under other", () => {
    expect(tabStatusBand(tab("draft", 1, undefined, null), none)).toBe("other")
  })
})

describe("folderAccentColor", () => {
  it("uses the folder's own color when it has one", () => {
    expect(folderAccentColor(5, "violet")).toBe("violet")
    expect(folderAccentColor(5, "#22c55e")).toBe("green") // legacy hex
  })

  it("picks a stable color for an uncolored folder", () => {
    expect(folderAccentColor(1, null)).toBe(folderAccentColor(1, "inherit"))
    expect(folderAccentColor(1, null)).not.toBe(folderAccentColor(2, null))
  })
})
