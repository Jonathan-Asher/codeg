import { act, cleanup, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PendingItem, PendingItemsSnapshot } from "@/lib/types"

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  listPendingItems: vi.fn(),
  deliverSystemNotification: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  listPendingItems: h.listPendingItems,
  updateConversationCritical: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async (event: string, handler: (p: unknown) => void) => {
    h.handlers.set(event, handler)
    return () => h.handlers.delete(event)
  }),
  onTransportReconnect: () => null,
  isDesktop: () => true,
}))
vi.mock("@/lib/notification", () => ({
  deliverSystemNotification: h.deliverSystemNotification,
  getNotificationPermission: () => "granted",
}))

import { PendingItemsBridge } from "./pending-items-bridge"
import {
  PENDING_ITEMS_EVENT,
  PENDING_REMINDER_EVENT,
} from "@/lib/pending-items"
import {
  resetDesktopNotificationPrefsCacheForTests,
  saveDesktopNotificationPrefs,
} from "@/lib/desktop-notification-prefs"
import { usePendingItemsStore } from "@/stores/pending-items-store"

const NOW = Date.parse("2026-10-26T12:00:00Z")

function item(over: Partial<PendingItem> = {}): PendingItem {
  return {
    id: "question:q1",
    kind: "question",
    source: "question",
    conversation_id: 7,
    root_conversation_id: 7,
    folder_id: 3,
    folder_name: "codeg",
    title: "Deploy fix",
    agent_type: "claude_code",
    agent_label: "Codex CLI",
    connection_id: "conn-7",
    request_id: "q1",
    asked_at: new Date(NOW - 30 * 60_000).toISOString(),
    text: "Which database?",
    options: [],
    question: null,
    queued: 0,
    reminders_sent: 2,
    last_reminded_at: null,
    next_reminder_at: null,
    phone_notified: true,
    ...over,
  }
}

const snapshot = (items: PendingItem[]): PendingItemsSnapshot => ({
  items,
  count: items.length,
})

function renderBridge() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PendingItemsBridge />
    </NextIntlClientProvider>
  )
}

async function emit(event: string, payload: unknown) {
  await waitFor(() => expect(h.handlers.has(event)).toBe(true))
  await act(async () => {
    h.handlers.get(event)!(payload)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  window.localStorage.clear()
  resetDesktopNotificationPrefsCacheForTests()
  h.handlers.clear()
  h.listPendingItems.mockReset().mockResolvedValue(snapshot([item()]))
  h.deliverSystemNotification.mockReset().mockResolvedValue(undefined)
  usePendingItemsStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("PendingItemsBridge", () => {
  it("loads the list, then follows the backend's events", async () => {
    renderBridge()
    await waitFor(() => expect(usePendingItemsStore.getState().count).toBe(1))
    await emit(
      PENDING_ITEMS_EVENT,
      snapshot([item(), item({ id: "question:q2" })])
    )
    expect(usePendingItemsStore.getState().count).toBe(2)
    await emit(PENDING_ITEMS_EVENT, snapshot([]))
    expect(usePendingItemsStore.getState().items).toEqual([])
  })

  it("posts each reminder once per machine, with the wait and the question", async () => {
    renderBridge()
    const reminder = { id: "question:q1#2", attempt: 2, item: item() }
    await emit(PENDING_REMINDER_EVENT, reminder)
    await waitFor(() =>
      expect(h.deliverSystemNotification).toHaveBeenCalledTimes(1)
    )
    expect(h.deliverSystemNotification).toHaveBeenCalledWith(
      "Deploy fix",
      "Codex CLI is still waiting for your answer (30 min)\nWhich database?",
      {
        contextKey: null,
        folderId: 3,
        conversationId: 7,
        agentType: "claude_code",
      }
    )
    // Another window of this machine hears the same reminder: claimed.
    await emit(PENDING_REMINDER_EVENT, reminder)
    await act(async () => {})
    expect(h.deliverSystemNotification).toHaveBeenCalledTimes(1)
  })

  it("keeps the session and the question out when contents are hidden", async () => {
    saveDesktopNotificationPrefs({
      enabled: true,
      when: "hidden",
      hideBody: true,
      events: {
        turn_complete: true,
        permission_request: true,
        question_request: true,
        error: true,
        background_task: true,
        work_task: true,
      },
    })
    renderBridge()
    await emit(PENDING_REMINDER_EVENT, {
      id: "permission:r1#1",
      attempt: 1,
      item: item({
        id: "permission:r1",
        kind: "permission",
        source: "permission",
        asked_at: new Date(NOW - 5 * 60_000).toISOString(),
      }),
    })
    await waitFor(() =>
      expect(h.deliverSystemNotification).toHaveBeenCalledTimes(1)
    )
    expect(h.deliverSystemNotification.mock.calls[0][0]).toBe(
      "A session is still waiting for you"
    )
    expect(h.deliverSystemNotification.mock.calls[0][1]).toBe(
      "Codex CLI is still waiting for your permission (5 min)"
    )
  })
})
