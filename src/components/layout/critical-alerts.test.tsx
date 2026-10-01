import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  CriticalAlert,
  CriticalAlertsSnapshot,
  DbConversationSummary,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  getCriticalAlerts: vi.fn(),
  ackCriticalSession: vi.fn(),
  snoozeCriticalSession: vi.fn(),
  deliverSystemNotification: vi.fn(),
  playCriticalAlertSound: vi.fn(),
  openNotificationTargetFromClick: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getCriticalAlerts: h.getCriticalAlerts,
  ackCriticalSession: h.ackCriticalSession,
  snoozeCriticalSession: h.snoozeCriticalSession,
  updateConversationCritical: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async (event: string, handler: (p: unknown) => void) => {
    h.handlers.set(event, handler)
    return () => h.handlers.delete(event)
  }),
  onTransportReconnect: () => null,
  isDesktop: () => false,
}))
vi.mock("@/lib/notification", () => ({
  deliverSystemNotification: h.deliverSystemNotification,
  getNotificationPermission: () => "granted",
}))
vi.mock("@/lib/notification-sound", () => ({
  playCriticalAlertSound: h.playCriticalAlertSound,
}))
vi.mock("@/lib/notification-target", () => ({
  openNotificationTargetFromClick: h.openNotificationTargetFromClick,
}))

import { CriticalAlerts } from "./critical-alerts"
import {
  CRITICAL_ALERT_EVENT,
  CRITICAL_ALERTS_EVENT,
} from "@/lib/critical-sessions"
import { useTabStore } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const SINCE = new Date(Date.now() - 65_000).toISOString()

function alert(over: Partial<CriticalAlert> = {}): CriticalAlert {
  return {
    id: "inst-c7-e1-n1",
    conversation_id: 7,
    folder_id: 3,
    agent_type: "claude_code",
    title: "Deploy fix",
    kind: "idle",
    since: SINCE,
    count: 1,
    fired_at: new Date().toISOString(),
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
    critical: true,
    ...over,
  }
}

const snapshot = (alerts: CriticalAlert[]): CriticalAlertsSnapshot => ({
  alerts,
})

function renderAlerts() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CriticalAlerts />
    </NextIntlClientProvider>
  )
}

/** Deliver a backend event to the component's subscription. */
async function emit(event: string, payload: unknown) {
  await waitFor(() => expect(h.handlers.has(event)).toBe(true))
  await act(async () => {
    h.handlers.get(event)!(payload)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  h.handlers.clear()
  h.getCriticalAlerts.mockReset().mockResolvedValue(snapshot([]))
  h.ackCriticalSession.mockReset().mockResolvedValue(snapshot([]))
  h.snoozeCriticalSession.mockReset().mockResolvedValue(snapshot([]))
  h.deliverSystemNotification.mockReset().mockResolvedValue(undefined)
  h.playCriticalAlertSound.mockReset()
  h.openNotificationTargetFromClick.mockReset()
  useAppWorkspaceStore.setState({
    conversations: [row(), row({ id: 8, title: "Chores", critical: false })],
  })
})

afterEach(() => {
  cleanup()
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("CriticalAlerts", () => {
  it("shows the alerts waiting for an acknowledgement on mount", async () => {
    h.getCriticalAlerts.mockResolvedValue(snapshot([alert()]))
    renderAlerts()
    expect(
      // The banner's flag icon stands for the notification title's ⚑.
      await screen.findByText("Critical session waiting: Deploy fix")
    ).toBeTruthy()
    expect(
      screen.getByText(
        "The agent finished its turn 1 min ago, and nothing has happened since."
      )
    ).toBeTruthy()
  })

  it("follows the live set: a new alert appears, an acknowledged one goes", async () => {
    renderAlerts()
    await emit(CRITICAL_ALERTS_EVENT, snapshot([alert({ kind: "stalled" })]))
    expect(
      screen.getByText("Critical session may be stuck: Deploy fix")
    ).toBeTruthy()
    await emit(CRITICAL_ALERTS_EVENT, snapshot([]))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("posts one system notification per alert per machine, with the tone", async () => {
    renderAlerts()
    await emit(CRITICAL_ALERT_EVENT, alert())
    await waitFor(() =>
      expect(h.deliverSystemNotification).toHaveBeenCalledTimes(1)
    )
    expect(h.deliverSystemNotification).toHaveBeenCalledWith(
      "⚑ Critical session waiting: Deploy fix",
      "The agent finished its turn 1 min ago, and nothing has happened since.",
      {
        contextKey: null,
        folderId: 3,
        conversationId: 7,
        agentType: "claude_code",
      }
    )
    expect(h.playCriticalAlertSound).toHaveBeenCalledTimes(1)

    // Another window of this machine hears the same firing: already claimed.
    await emit(CRITICAL_ALERT_EVENT, alert())
    // The repeat is a new firing, so it notifies again; this one is silent.
    await emit(
      CRITICAL_ALERT_EVENT,
      alert({ id: "inst-c7-e1-n2", count: 2, sound: false })
    )
    await waitFor(() =>
      expect(h.deliverSystemNotification).toHaveBeenCalledTimes(2)
    )
    expect(h.playCriticalAlertSound).toHaveBeenCalledTimes(1)
  })

  it("dismiss acknowledges the session", async () => {
    h.getCriticalAlerts.mockResolvedValue(snapshot([alert()]))
    renderAlerts()
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(h.ackCriticalSession).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("open goes to the session and acknowledges it", async () => {
    h.getCriticalAlerts.mockResolvedValue(snapshot([alert()]))
    renderAlerts()
    fireEvent.click(await screen.findByRole("button", { name: "Open session" }))
    expect(h.openNotificationTargetFromClick).toHaveBeenCalledWith({
      contextKey: null,
      folderId: 3,
      conversationId: 7,
      agentType: "claude_code",
    })
    await waitFor(() => expect(h.ackCriticalSession).toHaveBeenCalledWith(7))
  })

  it("snooze holds the alert for 15 minutes", async () => {
    h.getCriticalAlerts.mockResolvedValue(snapshot([alert()]))
    renderAlerts()
    fireEvent.click(await screen.findByRole("button", { name: /Snooze/ }))
    await waitFor(() =>
      expect(h.snoozeCriticalSession).toHaveBeenCalledWith(7, 15)
    )
  })

  it("switching to a critical session's tab acknowledges it; others do not", async () => {
    useTabStore.setState({
      tabs: [
        { id: "t7", conversationId: 7 },
        { id: "t8", conversationId: 8 },
      ] as never,
      activeTabId: null,
    })
    renderAlerts()
    await waitFor(() => expect(h.getCriticalAlerts).toHaveBeenCalled())
    act(() => useTabStore.setState({ activeTabId: "t8" }))
    expect(h.ackCriticalSession).not.toHaveBeenCalled()
    act(() => useTabStore.setState({ activeTabId: "t7" }))
    await waitFor(() => expect(h.ackCriticalSession).toHaveBeenCalledWith(7))
  })
})
