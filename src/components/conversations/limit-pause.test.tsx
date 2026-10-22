import type { ReactNode } from "react"
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
import type { DbConversationSummary, LimitPause } from "@/lib/types"

const h = vi.hoisted(() => ({
  cancelLimitContinue: vi.fn(),
  continueLimitNow: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  cancelLimitContinue: h.cancelLimitContinue,
  continueLimitNow: h.continueLimitNow,
}))

import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

import { LimitPauseHeaderBadge, LimitPausedBanner } from "./limit-pause"
import { SessionActivityRow } from "./session-activity"

const L = enMessages.Folder.sessionActivity
const IN_3H_12M = 3 * 3_600_000 + 12 * 60_000

function pause(over: Partial<LimitPause> = {}): LimitPause {
  return {
    resets_at: new Date(Date.now() + IN_3H_12M).toISOString(),
    state: "scheduled",
    attempts: 0,
    ...over,
  }
}

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Refactor",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: "sess-7",
    message_count: 4,
    child_count: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:30:00.000Z",
    pinned_at: null,
    turn_state: null,
    limit_pause: pause(),
    ...over,
  }
}

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.cancelLimitContinue.mockReset().mockResolvedValue(true)
  h.continueLimitNow.mockReset().mockResolvedValue(true)
})

afterEach(() => cleanup())

describe("LimitPausedBanner", () => {
  it("says when the session continues, and offers both ways out", async () => {
    wrap(<LimitPausedBanner conversationId={7} pause={pause()} />)
    const banner = screen.getByTestId("limit-paused-banner")
    expect(banner).toHaveTextContent(L.limitBannerTitle)
    // "Continues automatically when it resets at 22:00 (in 3h 12m)."
    expect(banner).toHaveTextContent(/resets at .+\(in 3h 1[12]m\)/)

    fireEvent.click(screen.getByTestId("limit-cancel-auto-continue"))
    expect(h.cancelLimitContinue).toHaveBeenCalledWith(7)
    // One action at a time while the first is on its way.
    expect(screen.getByTestId("limit-continue-now")).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByTestId("limit-continue-now")).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId("limit-continue-now"))
    expect(h.continueLimitNow).toHaveBeenCalledWith(7)
  })

  it("has nothing left to choose once the continuation is going out", () => {
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause({ state: "claimed" })}
      />
    )
    const banner = screen.getByTestId("limit-paused-banner")
    expect(banner).toHaveTextContent(L.limitBannerClaimed)
    expect(screen.queryByTestId("limit-cancel-auto-continue")).toBeNull()
    expect(screen.queryByTestId("limit-continue-now")).toBeNull()
  })
})

describe("SessionActivityRow while paused on the usage limit", () => {
  it("shows the paused state with the reset time and the actions", () => {
    wrap(<SessionActivityRow summary={summary()} />)
    const row = screen.getByTestId("session-activity")
    expect(row).toHaveAttribute("data-activity", "limit_paused")
    expect(row).toHaveTextContent(/Paused — limit resets at .+\(in 3h 1[12]m\)/)
    expect(screen.getByTestId("session-activity-hint")).toHaveTextContent(
      L.limitPausedHint
    )
    fireEvent.click(screen.getByTestId("limit-continue-now"))
    expect(h.continueLimitNow).toHaveBeenCalledWith(7)
  })

  it("reads working once the continuation runs", () => {
    wrap(
      <SessionActivityRow
        summary={summary({
          turn_state: "running",
          limit_pause: pause({ state: "continuing", attempts: 1 }),
        })}
      />
    )
    expect(screen.getByTestId("session-activity")).toHaveAttribute(
      "data-activity",
      "working"
    )
    expect(screen.queryByTestId("limit-continue-now")).toBeNull()
  })
})

describe("a pause on the account pool", () => {
  const pool = { limit_reason: "pool_capacity" as const }

  it("names the pool in the composer banner", () => {
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause()}
        reason="pool_capacity"
      />
    )
    const banner = screen.getByTestId("limit-paused-banner")
    expect(banner).toHaveAttribute("data-limit-reason", "pool_capacity")
    expect(banner).toHaveTextContent(L.limitPoolBannerTitle)
    expect(banner).toHaveTextContent(/resets at .+\(in 3h 1[12]m\)/)
    expect(screen.getByTestId("limit-continue-now")).toBeInTheDocument()
  })

  it("says when it continues on the activity line", () => {
    wrap(<SessionActivityRow summary={summary(pool)} />)
    const row = screen.getByTestId("session-activity")
    expect(row).toHaveAttribute("data-activity", "limit_paused")
    expect(row).toHaveTextContent(/Paused by usage limits — continues at \S+/)
    expect(screen.getByTestId("session-activity-hint")).toHaveTextContent(
      L.limitPoolPausedHint
    )
    expect(screen.getByTestId("limit-cancel-auto-continue")).toBeInTheDocument()
  })

  it("says it stopped once the continuations gave up", () => {
    wrap(
      <SessionActivityRow
        summary={summary({
          ...pool,
          turn_state: "interrupted",
          limit_pause: null,
        })}
      />
    )
    const row = screen.getByTestId("session-activity")
    expect(row).toHaveAttribute("data-activity", "interrupted")
    expect(row).toHaveTextContent(L.limitStopped)
    expect(screen.getByTestId("session-activity-hint")).toHaveTextContent(
      L.limitStoppedHint
    )
    // The manual Continue stays.
    expect(screen.getByText(L.continue)).toBeInTheDocument()
  })
})

describe("LimitPauseHeaderBadge", () => {
  afterEach(() => {
    // Unmount first, so the reset is not an update to a mounted badge.
    cleanup()
    useAppWorkspaceStore.setState({ conversations: [] })
  })

  it("shows a pool pause in the session header", () => {
    useAppWorkspaceStore.setState({
      conversations: [summary({ limit_reason: "pool_capacity" })],
    })
    wrap(<LimitPauseHeaderBadge conversationId={7} />)
    const badge = screen.getByTestId("header-limit-paused")
    expect(badge).toHaveAttribute("data-limit-reason", "pool_capacity")
    expect(badge).toHaveTextContent(/Paused by usage limits — continues at \S+/)
    expect(badge).toHaveAttribute("title", L.limitPoolPausedHint)
  })

  it("shows the account's own limit in its words", () => {
    useAppWorkspaceStore.setState({ conversations: [summary()] })
    wrap(<LimitPauseHeaderBadge conversationId={7} />)
    expect(screen.getByTestId("header-limit-paused")).toHaveTextContent(
      /Paused until the usage limit resets at \S+/
    )
  })

  it("says the session stopped once nothing continues by itself", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        summary({
          limit_reason: "pool_capacity",
          turn_state: "interrupted",
          limit_pause: null,
        }),
      ],
    })
    wrap(<LimitPauseHeaderBadge conversationId={7} />)
    expect(screen.queryByTestId("header-limit-paused")).toBeNull()
    expect(screen.getByTestId("header-limit-stopped")).toHaveTextContent(
      L.limitStopped
    )
  })

  it("shows nothing while the continuation runs, or with no pause", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        summary({
          limit_reason: "pool_capacity",
          turn_state: "running",
          limit_pause: pause({ state: "continuing", attempts: 1 }),
        }),
        summary({ id: 8, limit_pause: null }),
      ],
    })
    const { container } = wrap(
      <>
        <LimitPauseHeaderBadge conversationId={7} />
        <LimitPauseHeaderBadge conversationId={8} />
      </>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
