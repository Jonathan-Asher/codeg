import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({ updateConversationCritical: vi.fn() }))
vi.mock("@/lib/api", () => ({
  updateConversationCritical: h.updateConversationCritical,
}))

import { CriticalSessionSection } from "./critical-session-section"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

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

function renderSection(summary: DbConversationSummary) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CriticalSessionSection summary={summary} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.updateConversationCritical.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("CriticalSessionSection", () => {
  it("marks the session critical, then offers its stall detection", async () => {
    useAppWorkspaceStore.setState({ conversations: [row()] })
    renderSection(row())
    expect(screen.queryByLabelText(/may be stuck/)).toBeNull()
    fireEvent.click(screen.getByRole("switch", { name: /Mark as critical/ }))
    await waitFor(() =>
      expect(h.updateConversationCritical).toHaveBeenCalledWith(
        7,
        true,
        undefined
      )
    )
    const stall = await screen.findByRole("switch", { name: /may be stuck/ })
    expect(stall.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(stall)
    await waitFor(() =>
      expect(h.updateConversationCritical).toHaveBeenLastCalledWith(
        7,
        true,
        false
      )
    )
  })

  it("reads the live row, so a mark from another client shows", () => {
    useAppWorkspaceStore.setState({
      conversations: [row({ critical: true, critical_stall: false })],
    })
    renderSection(row())
    expect(
      screen
        .getByRole("switch", { name: /Mark as critical/ })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen
        .getByRole("switch", { name: /may be stuck/ })
        .getAttribute("aria-checked")
    ).toBe("false")
  })

  it("is not offered on a delegation sub-session", () => {
    const { container } = renderSection(row({ parent_id: 3 }))
    expect(
      container.querySelector("[data-critical-session-section]")
    ).toBeNull()
  })
})
