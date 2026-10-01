import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  updateConversationCritical: vi.fn(),
  deliverSystemNotification: vi.fn(),
  permission: "granted" as string,
  prefs: { enabled: true, hideBody: false },
}))

vi.mock("@/lib/api", () => ({
  updateConversationCritical: h.updateConversationCritical,
}))
vi.mock("@/lib/notification", () => ({
  deliverSystemNotification: h.deliverSystemNotification,
  getNotificationPermission: () => h.permission,
}))
vi.mock("@/lib/desktop-notification-prefs", () => ({
  getDesktopNotificationPrefs: () => h.prefs,
}))

import {
  claimCriticalAlert,
  criticalAlertTarget,
  elapsedDuration,
  elapsedSeconds,
  exactDuration,
  postCriticalNotification,
  setConversationCritical,
} from "./critical-sessions"
import type { CriticalAlert, DbConversationSummary } from "./types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

function alert(over: Partial<CriticalAlert> = {}): CriticalAlert {
  return {
    id: "inst-c7-e1-n1",
    conversation_id: 7,
    folder_id: 3,
    agent_type: "claude_code",
    title: "Deploy fix",
    kind: "idle",
    since: "2026-10-01T10:00:00.000Z",
    count: 1,
    fired_at: "2026-10-01T10:01:00.000Z",
    sound: true,
    ...over,
  }
}

function row(over: Partial<DbConversationSummary> = {}): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:30:00.000Z",
    pinned_at: null,
    ...over,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  h.updateConversationCritical.mockReset()
  h.deliverSystemNotification.mockReset()
  h.permission = "granted"
  h.prefs = { enabled: true, hideBody: false }
})

afterEach(() => {
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("durations", () => {
  it("shows a setting in its largest whole unit", () => {
    expect(exactDuration(30)).toEqual({ unit: "seconds", count: 30 })
    expect(exactDuration(60)).toEqual({ unit: "minutes", count: 1 })
    expect(exactDuration(90)).toEqual({ unit: "seconds", count: 90 })
    expect(exactDuration(1800)).toEqual({ unit: "minutes", count: 30 })
    expect(exactDuration(7200)).toEqual({ unit: "hours", count: 2 })
  })

  it("rounds an elapsed time down", () => {
    expect(elapsedDuration(45)).toEqual({ unit: "seconds", count: 45 })
    expect(elapsedDuration(61)).toEqual({ unit: "minutes", count: 1 })
    expect(elapsedDuration(3599)).toEqual({ unit: "minutes", count: 59 })
    expect(elapsedDuration(7300)).toEqual({ unit: "hours", count: 2 })
  })

  it("measures from the alert's since, never negative", () => {
    const since = "2026-10-01T10:00:00.000Z"
    expect(elapsedSeconds(since, Date.parse(since) + 65_000)).toBe(65)
    expect(elapsedSeconds(since, Date.parse(since) - 5_000)).toBe(0)
    expect(elapsedSeconds("not a date")).toBe(0)
  })
})

describe("claimCriticalAlert", () => {
  it("lets one window per machine take an alert", async () => {
    expect(await claimCriticalAlert("a-1")).toBe(true)
    expect(await claimCriticalAlert("a-1")).toBe(false)
    // A repeat is a new firing with a new id.
    expect(await claimCriticalAlert("a-2")).toBe(true)
  })

  it("drops claims older than a day", async () => {
    window.localStorage.setItem(
      "codeg:critical-alert-notified:old",
      String(Date.now() - 2 * 24 * 60 * 60 * 1000)
    )
    await claimCriticalAlert("fresh")
    expect(
      window.localStorage.getItem("codeg:critical-alert-notified:old")
    ).toBeNull()
  })
})

describe("setConversationCritical", () => {
  it("flips the row at once and calls the backend", async () => {
    useAppWorkspaceStore.setState({ conversations: [row()] })
    h.updateConversationCritical.mockResolvedValue(undefined)
    const pending = setConversationCritical(7, true)
    expect(useAppWorkspaceStore.getState().conversations[0].critical).toBe(true)
    await pending
    expect(h.updateConversationCritical).toHaveBeenCalledWith(
      7,
      true,
      undefined
    )
    // A view preference: the row's activity time does not move.
    expect(useAppWorkspaceStore.getState().conversations[0].updated_at).toBe(
      "2026-10-01T09:30:00.000Z"
    )
  })

  it("puts the row back when the backend refuses", async () => {
    useAppWorkspaceStore.setState({
      conversations: [row({ critical: true, critical_stall: true })],
    })
    h.updateConversationCritical.mockRejectedValue(new Error("nope"))
    await expect(setConversationCritical(7, true, false)).rejects.toThrow(
      "nope"
    )
    const back = useAppWorkspaceStore.getState().conversations[0]
    expect(back.critical).toBe(true)
    expect(back.critical_stall).toBe(true)
  })
})

describe("postCriticalNotification", () => {
  const text = {
    title: "⚑ Critical session waiting: Deploy fix",
    redactedTitle: "⚑ Critical session waiting",
    body: "The agent finished its turn 1 min ago.",
  }

  it("posts with the click-to-open target of the session", async () => {
    h.deliverSystemNotification.mockResolvedValue(undefined)
    expect(await postCriticalNotification(alert(), text)).toBe(true)
    expect(h.deliverSystemNotification).toHaveBeenCalledWith(
      text.title,
      text.body,
      criticalAlertTarget(alert())
    )
    expect(criticalAlertTarget(alert())).toEqual({
      contextKey: null,
      folderId: 3,
      conversationId: 7,
      agentType: "claude_code",
    })
  })

  it("hides the session title when contents are hidden", async () => {
    h.prefs = { enabled: true, hideBody: true }
    await postCriticalNotification(alert(), text)
    expect(h.deliverSystemNotification.mock.calls[0][0]).toBe(
      text.redactedTitle
    )
  })

  it("respects the master switch and the permission", async () => {
    h.prefs = { enabled: false, hideBody: false }
    expect(await postCriticalNotification(alert(), text)).toBe(false)
    h.prefs = { enabled: true, hideBody: false }
    h.permission = "denied"
    expect(await postCriticalNotification(alert(), text)).toBe(false)
    h.permission = "managed_by_os"
    h.deliverSystemNotification.mockResolvedValue(undefined)
    expect(await postCriticalNotification(alert(), text)).toBe(true)
    expect(h.deliverSystemNotification).toHaveBeenCalledTimes(1)
  })
})
