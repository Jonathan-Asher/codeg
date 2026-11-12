import type { ReactNode } from "react"
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
  DbConversationSummary,
  LimitPause,
  LimitResetsReport,
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolResetGrant,
  PlanUsagePoolResets,
  PlanUsageReport,
  PlanUsageWindow,
  ProviderLimitResets,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  cancelLimitContinue: vi.fn(),
  continueLimitNow: vi.fn(),
  getLimitResets: vi.fn(),
  consumeLimitReset: vi.fn(),
  getPlanUsage: vi.fn(),
  usagePoolRedeemReset: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock("@/lib/api", () => ({
  cancelLimitContinue: h.cancelLimitContinue,
  continueLimitNow: h.continueLimitNow,
  getLimitResets: h.getLimitResets,
  consumeLimitReset: h.consumeLimitReset,
  getPlanUsage: h.getPlanUsage,
  usagePoolRedeemReset: h.usagePoolRedeemReset,
  subscribePlanUsageChanged: () => Promise.resolve(() => {}),
  subscribePlanUsagePoolChanged: () => Promise.resolve(() => {}),
}))

vi.mock("@/lib/platform", () => ({
  onTransportReconnect: () => null,
  openUrl: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: h.toast }))

import { resetLimitResetsCacheForTests } from "@/hooks/use-limit-resets"
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

function codexResets(available: number): ProviderLimitResets {
  return {
    provider: "codex",
    available,
    items: Array.from({ length: available }, (_, i) => ({
      id: `credit-${i}`,
      kind: "full" as const,
      label: "Full reset",
      description: null,
      count: 1,
      expires_at: Math.floor(Date.now() / 1000) + (i + 10) * 86_400,
    })),
    source: "codex_app_server",
    account: null,
    error: null,
    fetched_at: Math.floor(Date.now() / 1000),
  }
}

function listing(...providers: ProviderLimitResets[]): LimitResetsReport {
  return { providers }
}

const nowSecs = () => Math.floor(Date.now() / 1000)

function poolAccount(
  over: Partial<PlanUsagePoolAccount> = {}
): PlanUsagePoolAccount {
  return {
    name: "backup",
    enabled: true,
    status: "active",
    state: "available",
    blocked_until: null,
    serving: true,
    preferred: false,
    windows: [],
    limit_status: "allowed",
    weekly_state: "normal",
    cooling_until: null,
    in_flight: 0,
    probe_failures: 0,
    probe_error_status: null,
    refresh_failed: false,
    observed_at: nowSecs() - 60,
    ...over,
  }
}

function weeklyWindow(id: string, used: number): PlanUsageWindow {
  return {
    id,
    kind: id === "seven_day" ? "weekly" : "weekly_model",
    label: id === "seven_day" ? "7d" : "Fable",
    used_percent: used,
    resets_at: nowSecs() + 2 * 86_400,
    window_minutes: 10_080,
    observed_at: nowSecs() - 60,
  }
}

const weeklyGrant: PlanUsagePoolResetGrant = {
  id: "g-weekly",
  label: null,
  kind: "weekly",
  model: null,
  refills: ["seven_day"],
  count: 1,
  expires_at: nowSecs() + 9 * 86_400,
  usable_now: true,
  requires_limit: true,
  gives_back_weekly: false,
}

/** One of the November launch's Fable resets, as the pool lists it. */
const fableGrant: PlanUsagePoolResetGrant = {
  id: "launch-2610-fable",
  label:
    "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
  kind: "model_weekly",
  model: "Fable",
  refills: ["seven_day_fable"],
  count: 1,
  expires_at: nowSecs() + 117 * 86_400,
  usable_now: true,
  requires_limit: false,
  gives_back_weekly: true,
}

function grants(
  list: PlanUsagePoolResetGrant[],
  limitsReached: string[] = []
): PlanUsagePoolResets {
  return {
    available: list.reduce((n, g) => n + g.count, 0),
    grants: list,
    next_grant_id: list[0]?.id ?? null,
    cooldown_until: null,
    eligible: true,
    auto_redeem: false,
    checked_at: nowSecs() - 30,
    limits_reached: limitsReached,
  }
}

/** A pool whose `primary` is at its weekly limit with a weekly reset it can
 *  use (`backup` serves, with none). */
function resetsPool(over: Partial<PlanUsagePool> = {}): PlanUsagePool {
  return {
    kind: "maxpool",
    agent: "claude_code",
    version: "1.24.90",
    accounts: [
      poolAccount({
        name: "primary",
        state: "exhausted",
        serving: false,
        limit_status: "rejected",
        blocked_until: nowSecs() + 2 * 86_400,
        windows: [weeklyWindow("seven_day", 100)],
        resets: grants([weeklyGrant], ["seven_day"]),
      }),
      poolAccount(),
    ],
    current_account: "backup",
    preferred_account: null,
    routing_mode: "automatic",
    switch_threshold: 99,
    exhausted: false,
    resumes_at: null,
    observed_at: nowSecs() - 60,
    checked_at: nowSecs() - 10,
    stale: false,
    error: null,
    error_status: null,
    resets_supported: true,
    ...over,
  }
}

function planReport(pool: PlanUsagePool | null): PlanUsageReport {
  return {
    snapshots: [],
    codex_sessions_dir: null,
    codex_rollouts_found: false,
    ...(pool ? { pool } : {}),
  }
}

beforeEach(() => {
  resetLimitResetsCacheForTests()
  h.cancelLimitContinue.mockReset().mockResolvedValue(true)
  h.continueLimitNow.mockReset().mockResolvedValue(true)
  h.getLimitResets.mockReset().mockResolvedValue(listing())
  h.consumeLimitReset.mockReset()
  h.getPlanUsage.mockReset().mockResolvedValue(planReport(null))
  h.usagePoolRedeemReset.mockReset()
  for (const fn of Object.values(h.toast)) fn.mockReset()
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

describe("LimitPausedBanner with a usage-limit reset", () => {
  it("offers Use a reset and continue, asks first, and continues the session", async () => {
    h.getLimitResets.mockResolvedValue(listing(codexResets(2)))
    h.consumeLimitReset.mockResolvedValue({
      provider: "codex",
      outcome: "reset",
      resets: codexResets(1),
      paused_conversations: [],
      continued: 7,
    })
    wrap(
      <LimitPausedBanner conversationId={7} pause={pause()} agentType="codex" />
    )
    const button = await screen.findByTestId("limit-use-reset")
    expect(button).toHaveTextContent(L.useReset)
    expect(button).toHaveAttribute(
      "title",
      "Use one of your 2 usage-limit resets to refill the limit now and continue"
    )

    fireEvent.click(button)
    const dialog = screen.getByTestId("limit-reset-confirm")
    expect(dialog).toHaveTextContent(
      "Use 1 of 2 resets? This refills all your usage limits now. It can't be undone."
    )
    expect(h.consumeLimitReset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))

    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(L.resetContinued)
    )
    expect(h.consumeLimitReset).toHaveBeenCalledWith({
      provider: "codex",
      id: "credit-0",
      conversationId: 7,
    })
  })

  it("reports what came of it when the session didn't continue", async () => {
    h.getLimitResets.mockResolvedValue(listing(codexResets(1)))
    h.consumeLimitReset.mockResolvedValue({
      provider: "codex",
      outcome: "already_used",
      resets: codexResets(0),
      paused_conversations: [],
      continued: null,
    })
    wrap(
      <LimitPausedBanner conversationId={7} pause={pause()} agentType="codex" />
    )
    fireEvent.click(await screen.findByTestId("limit-use-reset"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))
    await waitFor(() =>
      expect(h.toast.info).toHaveBeenCalledWith(
        enMessages.PlanUsage.resets.outcome.alreadyUsed
      )
    )
    // The listing read after the attempt has none left: the offer goes.
    await waitFor(() =>
      expect(screen.queryByTestId("limit-use-reset")).toBeNull()
    )
  })

  it("offers nothing without a usable reset, for a pool pause, or another agent", async () => {
    h.getLimitResets.mockResolvedValue(listing(codexResets(0)))
    wrap(
      <LimitPausedBanner conversationId={7} pause={pause()} agentType="codex" />
    )
    await waitFor(() => expect(h.getLimitResets).toHaveBeenCalled())
    expect(screen.queryByTestId("limit-use-reset")).toBeNull()
    cleanup()

    resetLimitResetsCacheForTests()
    h.getLimitResets.mockClear().mockResolvedValue(listing(codexResets(2)))
    wrap(
      <>
        <LimitPausedBanner
          conversationId={7}
          pause={pause()}
          reason="pool_capacity"
          agentType="codex"
        />
        <LimitPausedBanner
          conversationId={8}
          pause={pause()}
          agentType="gemini"
        />
        <LimitPausedBanner
          conversationId={9}
          pause={pause({ state: "claimed" })}
          agentType="codex"
        />
      </>
    )
    expect(screen.getAllByTestId("limit-paused-banner")).toHaveLength(3)
    expect(screen.queryByTestId("limit-use-reset")).toBeNull()
    // Nothing even asked for the listing.
    expect(h.getLimitResets).not.toHaveBeenCalled()
  })
})

describe("LimitPausedBanner with a pool account's reset", () => {
  it("offers Use a reset and continue on the account it frees, asks first, and continues the session", async () => {
    h.getPlanUsage.mockResolvedValue(planReport(resetsPool()))
    h.usagePoolRedeemReset.mockResolvedValue({
      account: "primary",
      outcome: "reset",
      pool: null,
      continued: 7,
    })
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause()}
        reason="pool_capacity"
        agentType="claude_code"
      />
    )
    const button = await screen.findByTestId("limit-use-reset")
    expect(button).toHaveTextContent(L.useReset)
    expect(button).toHaveAttribute("data-reset-account", "primary")
    expect(button).toHaveAttribute(
      "title",
      "Use one of primary's usage-limit resets to refill its limit now and continue"
    )

    fireEvent.click(button)
    expect(screen.getByTestId("pool-reset-confirm")).toHaveTextContent(
      "Use 1 reset on primary? It refills the weekly limit now and can't be undone."
    )
    expect(h.usagePoolRedeemReset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))

    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        "Reset used on primary. The session continues now."
      )
    )
    expect(h.usagePoolRedeemReset).toHaveBeenCalledWith({
      name: "primary",
      grantId: "g-weekly",
      conversationId: 7,
    })
  })

  it("offers it on the account's own limit pause too, and says what came of it when the session didn't continue", async () => {
    h.getPlanUsage.mockResolvedValue(planReport(resetsPool()))
    h.usagePoolRedeemReset.mockResolvedValue({
      account: "primary",
      outcome: "unconfirmed",
      pool: null,
      continued: null,
    })
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause()}
        agentType="claude_code"
      />
    )
    fireEvent.click(await screen.findByTestId("limit-use-reset"))
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))
    await waitFor(() =>
      expect(h.toast.warning).toHaveBeenCalledWith(
        "Couldn't confirm the reset on primary went through. Recheck it before trying again."
      )
    )
  })

  it("offers nothing without the pool's reset routes, without a usable grant, or once the continuation is going out", async () => {
    const noGrant = resetsPool()
    noGrant.accounts[0] = { ...noGrant.accounts[0], resets: null }
    for (const pool of [
      resetsPool({ resets_supported: false }),
      resetsPool({ stale: true }),
      noGrant,
      null,
    ]) {
      h.getPlanUsage.mockResolvedValue(planReport(pool))
      wrap(
        <LimitPausedBanner
          conversationId={7}
          pause={pause()}
          reason="pool_capacity"
          agentType="claude_code"
        />
      )
      await waitFor(() => expect(h.getPlanUsage).toHaveBeenCalled())
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.queryByTestId("limit-use-reset")).toBeNull()
      cleanup()
      h.getPlanUsage.mockClear()
    }
    h.getPlanUsage.mockResolvedValue(planReport(resetsPool()))
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause({ state: "claimed" })}
        agentType="claude_code"
      />
    )
    expect(screen.queryByTestId("limit-use-reset")).toBeNull()
    expect(h.getPlanUsage).not.toHaveBeenCalled()
  })
})

describe("LimitPausedBanner and a Fable reset", () => {
  async function bannerFor(pool: PlanUsagePool, model: string | null) {
    useAppWorkspaceStore.setState({
      conversations: [summary({ id: 7, model })],
    })
    h.getPlanUsage.mockResolvedValue(planReport(pool))
    wrap(
      <LimitPausedBanner
        conversationId={7}
        pause={pause()}
        reason="pool_capacity"
        agentType="claude_code"
      />
    )
    await waitFor(() => expect(h.getPlanUsage).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
  }

  afterEach(() => {
    cleanup()
    useAppWorkspaceStore.setState({ conversations: [] })
  })

  it("never offers it for the general weekly limit, even with an account that holds one", async () => {
    // As on 2026-11-12: the account at its general weekly limit holds a
    // Fable reset, another account with headroom holds more.
    await bannerFor(
      resetsPool({
        accounts: [
          poolAccount({
            name: "walled",
            state: "exhausted",
            serving: false,
            windows: [weeklyWindow("seven_day", 100)],
            resets: grants([fableGrant], ["seven_day"]),
          }),
          poolAccount({
            name: "spare",
            windows: [weeklyWindow("seven_day", 37)],
            resets: grants([{ ...fableGrant, id: "launch-2610-fable-6mo" }]),
          }),
        ],
      }),
      "claude-fable-5-1"
    )
    expect(screen.queryByTestId("limit-use-reset")).toBeNull()
  })

  it("offers it to a Fable session the Fable limit stopped, saying it refills only that limit", async () => {
    const pool = resetsPool({
      accounts: [
        poolAccount({
          name: "fable-walled",
          state: "available",
          windows: [
            weeklyWindow("seven_day", 40),
            weeklyWindow("seven_day_fable", 100),
          ],
          resets: grants([fableGrant], ["seven_day_fable"]),
        }),
      ],
    })
    await bannerFor(pool, "claude-fable-5-1")
    const button = await screen.findByTestId("limit-use-reset")
    expect(button).toHaveAttribute("data-reset-account", "fable-walled")
    fireEvent.click(button)
    expect(screen.getByTestId("pool-reset-confirm-body")).toHaveTextContent(
      "Use 1 Fable reset on fable-walled? It refills only the weekly limit for Fable models, not your general weekly limit, and can't be undone."
    )
    cleanup()

    // An Opus session isn't held by Fable's limit: nothing to offer.
    h.getPlanUsage.mockClear()
    await bannerFor(pool, "claude-opus-5-5")
    expect(screen.queryByTestId("limit-use-reset")).toBeNull()
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
