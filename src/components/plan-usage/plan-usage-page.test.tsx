import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "@/lib/types"

const getPlanUsage = vi.fn<(force?: boolean) => Promise<PlanUsageReport>>()
let pushHandler: ((snapshot: PlanUsageSnapshot) => void) | null = null
let poolHandler: ((pool: PlanUsagePool | null) => void) | null = null

vi.mock("@/lib/api", () => ({
  getPlanUsage: (force?: boolean) => getPlanUsage(force),
  subscribePlanUsageChanged: (handler: (s: PlanUsageSnapshot) => void) => {
    pushHandler = handler
    return Promise.resolve(() => {
      pushHandler = null
    })
  },
  subscribePlanUsagePoolChanged: (
    handler: (p: PlanUsagePool | null) => void
  ) => {
    poolHandler = handler
    return Promise.resolve(() => {
      poolHandler = null
    })
  },
}))

vi.mock("@/lib/platform", () => ({
  onTransportReconnect: () => null,
}))

import { PlanUsagePage } from "./plan-usage-page"
import enMessages from "@/i18n/messages/en.json"

/** Real clock: every time below is relative to the moment the test runs, and
 *  each assertion allows for the few seconds a slow run can take. */
const now = () => Math.floor(Date.now() / 1000)

function limit(overrides: Partial<PlanUsageWindow>): PlanUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "5h",
    used_percent: 0,
    resets_at: null,
    window_minutes: 300,
    observed_at: null,
    ...overrides,
  }
}

function claudeSnapshot(
  overrides: Partial<PlanUsageSnapshot> = {}
): PlanUsageSnapshot {
  const at = now() - 5 * 60
  return {
    agent: "claude_code",
    windows: [
      limit({
        used_percent: 42.4,
        resets_at: now() + 2 * 3600 + 14 * 60 + 40,
        observed_at: at,
      }),
      limit({
        id: "seven_day",
        kind: "weekly",
        label: "7d",
        window_minutes: 10080,
        used_percent: 61,
        resets_at: now() + 3 * 86_400 + 4 * 3600 + 40 * 60,
        // Reported by an earlier turn than the 5-hour window above.
        observed_at: at - 3 * 3600,
      }),
      limit({
        id: "seven_day_opus",
        kind: "weekly_model",
        label: "Opus",
        window_minutes: 10080,
        used_percent: 12,
        resets_at: now() + 3 * 86_400,
        observed_at: at,
      }),
    ],
    plan_label: null,
    status: "ok",
    observed_at: at,
    source: "live",
    ...overrides,
  }
}

function codexSnapshot(
  overrides: Partial<PlanUsageSnapshot> = {}
): PlanUsageSnapshot {
  const at = now() - 20 * 60
  return {
    agent: "codex",
    windows: [
      limit({
        id: "primary",
        kind: "weekly",
        label: "7d",
        window_minutes: 10080,
        used_percent: 99,
        resets_at: now() + 86_400 + 3600 + 50 * 60,
        observed_at: at,
      }),
    ],
    plan_label: "Pro Lite",
    status: null,
    observed_at: at,
    source: "transcript",
    ...overrides,
  }
}

function poolAccount(
  overrides: Partial<PlanUsagePoolAccount> = {}
): PlanUsagePoolAccount {
  return {
    name: "alpha",
    enabled: true,
    status: "active",
    state: "available",
    blocked_until: null,
    serving: false,
    preferred: false,
    windows: [],
    limit_status: "allowed",
    weekly_state: "normal",
    cooling_until: null,
    in_flight: 0,
    probe_failures: 0,
    probe_error_status: null,
    refresh_failed: false,
    observed_at: now() - 60,
    ...overrides,
  }
}

/** Two subscriptions behind the pool: `primary` at its 5-hour limit with a
 *  failing usage probe, `backup` serving, `spare` switched off. */
function pool(overrides: Partial<PlanUsagePool> = {}): PlanUsagePool {
  const fiveHour = (used: number, resetsIn: number) =>
    limit({
      used_percent: used,
      resets_at: now() + resetsIn,
      observed_at: now() - 60,
    })
  const weekly = (used: number, resetsIn: number) =>
    limit({
      id: "seven_day",
      kind: "weekly",
      label: "7d",
      window_minutes: 10080,
      used_percent: used,
      resets_at: now() + resetsIn,
      observed_at: now() - 60,
    })
  return {
    kind: "maxpool",
    agent: "claude_code",
    version: "9.9.9",
    accounts: [
      poolAccount({
        name: "primary",
        preferred: true,
        state: "exhausted",
        limit_status: "rejected",
        blocked_until: now() + 2 * 3600 + 30 * 60 + 30,
        probe_failures: 4,
        probe_error_status: 429,
        windows: [
          fiveHour(100, 2 * 3600 + 30 * 60 + 30),
          weekly(51, 3 * 86_400 + 30),
        ],
      }),
      poolAccount({
        name: "backup",
        serving: true,
        in_flight: 1,
        windows: [
          fiveHour(56, 72 * 60 + 30),
          weekly(6, 6 * 86_400 + 30),
          limit({
            id: "seven_day_orca",
            kind: "weekly_model",
            label: "Orca",
            window_minutes: 10080,
            used_percent: 30,
            resets_at: now() + 6 * 86_400,
          }),
        ],
      }),
      poolAccount({
        name: "spare",
        enabled: false,
        state: "disabled",
        windows: [fiveHour(10, 3600)],
      }),
    ],
    current_account: "backup",
    preferred_account: "primary",
    routing_mode: "preferred",
    switch_threshold: 90,
    exhausted: false,
    resumes_at: null,
    observed_at: now() - 60,
    checked_at: now() - 10,
    stale: false,
    error: null,
    error_status: null,
    ...overrides,
  }
}

function report(
  snapshots: PlanUsageSnapshot[],
  overrides: Partial<PlanUsageReport> = {}
): PlanUsageReport {
  return {
    snapshots,
    codex_sessions_dir: "/home/u/.codex/sessions",
    codex_rollouts_found: true,
    ...overrides,
  }
}

async function mount() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PlanUsagePage />
    </NextIntlClientProvider>
  )
  // Both cards render together once the first fetch lands.
  await screen.findByRole("region", { name: "Codex" })
}

const card = (name: "Claude Code" | "Codex") =>
  screen.getByRole("region", { name })

beforeEach(() => {
  getPlanUsage.mockReset()
  pushHandler = null
  poolHandler = null
})

describe("PlanUsagePage empty states", () => {
  it("explains when each provider's numbers will appear", async () => {
    getPlanUsage.mockResolvedValue(report([], { codex_rollouts_found: false }))
    await mount()

    const claude = within(card("Claude Code"))
    expect(claude.getByText("No reading yet")).toBeInTheDocument()
    expect(
      claude.getByText(/after your next Claude Code turn in codeg/)
    ).toBeInTheDocument()

    const codex = within(card("Codex"))
    expect(codex.getByText("No Codex sessions found")).toBeInTheDocument()
    expect(
      codex.getByText(/Looked in \/home\/u\/\.codex\/sessions/)
    ).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(getPlanUsage).toHaveBeenCalledWith(false)
  })

  it("tells sessions without limits apart from no sessions at all", async () => {
    getPlanUsage.mockResolvedValue(report([], { codex_rollouts_found: true }))
    await mount()
    expect(
      within(card("Codex")).getByText("No limits in recent Codex sessions")
    ).toBeInTheDocument()
  })

  it("shows the error instead of empty cards when the first load fails", async () => {
    getPlanUsage.mockRejectedValue(new Error("boom"))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PlanUsagePage />
      </NextIntlClientProvider>
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load usage: boom"
    )
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })
})

describe("PlanUsagePage readings", () => {
  it("labels each window with used, left and its reset", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot(), codexSnapshot()]))
    await mount()

    const claude = card("Claude Code")
    const rows = within(claude).getAllByRole("listitem")
    expect(rows.map((r) => r.getAttribute("data-window"))).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ])

    const session = within(rows[0])
    expect(session.getByText("5-hour session")).toBeInTheDocument()
    expect(session.getByText("42% used")).toBeInTheDocument()
    expect(session.getByText("58% left")).toBeInTheDocument()
    expect(session.getByText(/^Resets in 2h 1[34]m · /)).toBeInTheDocument()
    expect(
      session.getByRole("progressbar", { name: "5-hour session" })
    ).toHaveAttribute("aria-valuenow", "42")

    const weekly = within(rows[1])
    expect(weekly.getByText("Weekly")).toBeInTheDocument()
    expect(weekly.getByText(/^Resets in 3d 4h · /)).toBeInTheDocument()
    // Carried over from an earlier turn, and it says so.
    expect(weekly.getByText(/^As of 3h/)).toBeInTheDocument()
    expect(within(rows[0]).queryByText(/^As of/)).not.toBeInTheDocument()

    expect(within(rows[2]).getByText("Weekly · Opus")).toBeInTheDocument()

    expect(within(claude).getByText(/^Updated 5m ago · /)).toBeInTheDocument()
    expect(
      within(claude).getByText(/From Claude Code turns in codeg/)
    ).toBeInTheDocument()
    // `ok` is not worth a badge.
    expect(within(claude).queryByText("Limit reached")).not.toBeInTheDocument()

    const codex = within(card("Codex"))
    expect(codex.getByText("Pro Lite")).toBeInTheDocument()
    expect(codex.getByText("99% used")).toBeInTheDocument()
    expect(codex.getByText("1% left")).toBeInTheDocument()
    expect(codex.getByText(/^Resets in 1d 1h · /)).toBeInTheDocument()
    expect(codex.getByText(/newest Codex session log/)).toBeInTheDocument()
    expect(codex.queryByText("Stale")).not.toBeInTheDocument()
  })

  it("marks old readings stale and windows that reset since", async () => {
    const old = now() - 3 * 3600
    getPlanUsage.mockResolvedValue(
      report([
        claudeSnapshot({
          source: "saved",
          observed_at: old,
          status: "limited",
          windows: [
            limit({
              used_percent: 100,
              resets_at: now() - 2 * 3600,
              observed_at: old,
            }),
          ],
        }),
        codexSnapshot({ observed_at: old }),
      ])
    )
    await mount()

    const claude = within(card("Claude Code"))
    expect(claude.getByText("Stale")).toBeInTheDocument()
    expect(
      claude.getByText("Last reading saved before codeg restarted")
    ).toBeInTheDocument()
    expect(
      claude.getByText("Reset 2h ago — no newer reading yet")
    ).toBeInTheDocument()
    // A stale "limit reached" is no longer news.
    expect(claude.queryByText("Limit reached")).not.toBeInTheDocument()
    expect(within(card("Codex")).getByText("Stale")).toBeInTheDocument()
  })

  it("shows the provider's status while the reading is fresh", async () => {
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot({ status: "limited" })])
    )
    await mount()
    expect(
      within(card("Claude Code")).getByText("Limit reached")
    ).toBeInTheDocument()
  })
})

describe("PlanUsagePage updates", () => {
  it("re-reads the logs on Refresh", async () => {
    getPlanUsage.mockResolvedValueOnce(report([]))
    await mount()
    getPlanUsage.mockResolvedValueOnce(report([codexSnapshot()]))

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    expect(
      await within(card("Codex")).findByText("99% used")
    ).toBeInTheDocument()
    expect(getPlanUsage).toHaveBeenLastCalledWith(true)
  })

  it("takes a live Claude reading without a refetch", async () => {
    getPlanUsage.mockResolvedValue(report([]))
    await mount()
    expect(pushHandler).not.toBeNull()

    act(() => {
      pushHandler?.(
        claudeSnapshot({
          windows: [limit({ used_percent: 7, observed_at: now() })],
          observed_at: now(),
        })
      )
    })

    const claude = within(card("Claude Code"))
    expect(claude.getByText("7% used")).toBeInTheDocument()
    expect(
      claude.getByText("Updated just now", { exact: false })
    ).toBeInTheDocument()
    expect(claude.getByText("Reset time unknown")).toBeInTheDocument()
    expect(getPlanUsage).toHaveBeenCalledTimes(1)
  })
})

describe("PlanUsagePage account pool", () => {
  const accountRow = (name: string) =>
    card("Claude Code").querySelector<HTMLElement>(`[data-account="${name}"]`)!

  it("lists every account, with which serves and why any is held back", async () => {
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot({ status: "limited" })], { pool: pool() })
    )
    await mount()
    const claude = card("Claude Code")
    expect(claude).toHaveAttribute("data-pool", "maxpool")
    expect(within(claude).getByText("Account pool")).toBeInTheDocument()

    const summary = claude.querySelector('[data-slot="pool-summary"]')!
    expect(summary).toHaveTextContent(
      /^3 accounts · backup serving · next reset in 1h 1[23]m$/
    )

    const rows = Array.from(
      claude.querySelectorAll<HTMLElement>("[data-account]")
    )
    expect(rows.map((r) => r.dataset.account)).toEqual([
      "primary",
      "backup",
      "spare",
    ])

    const primary = within(accountRow("primary"))
    expect(primary.getByText("Preferred")).toBeInTheDocument()
    expect(primary.getByText("Exhausted")).toBeInTheDocument()
    expect(primary.getByText(/^Back in 2h 3[01]m$/)).toBeInTheDocument()
    // Its usage check is failing, but its reading is a minute old.
    expect(
      accountRow("primary").querySelector('[data-slot="probe-failing"]')
    ).toBeNull()
    expect(primary.getByText("100% used")).toBeInTheDocument()
    expect(
      accountRow("primary").querySelector('[data-window="five_hour"]')
    ).toHaveAttribute("data-level", "critical")

    const backup = within(accountRow("backup"))
    expect(accountRow("backup")).toHaveAttribute("data-serving", "true")
    expect(backup.getByText("Serving")).toBeInTheDocument()
    expect(backup.queryByText("Exhausted")).not.toBeInTheDocument()
    expect(backup.getByText("56% used")).toBeInTheDocument()
    expect(backup.getByText(/^Resets in 1h 1[23]m$/)).toBeInTheDocument()
    expect(backup.getByText("Weekly · Orca")).toBeInTheDocument()
    expect(
      accountRow("backup").querySelector('[data-window="five_hour"]')
    ).toHaveAttribute("data-level", "normal")

    // Switched off, still listed.
    expect(accountRow("spare")).toHaveAttribute("data-state", "disabled")
    expect(
      within(accountRow("spare")).getByText("Disabled")
    ).toBeInTheDocument()

    // The agent's own reading is folded away and its badge is not shown.
    const live = claude.querySelector<HTMLDetailsElement>(
      '[data-slot="live-reading"]'
    )!
    expect(live.open).toBe(false)
    expect(
      within(live).getByText("Last reading the agent reported")
    ).toBeInTheDocument()
    expect(within(claude).queryByText("Limit reached")).not.toBeInTheDocument()
    expect(screen.getByText(/never the accounts' sign-ins/)).toBeInTheDocument()
  })

  it("warns of a failing usage check once an account's reading is stale", async () => {
    const failing = pool()
    // Failing, last read over 14 minutes ago.
    failing.accounts[0] = {
      ...failing.accounts[0],
      observed_at: now() - 14 * 60 - 20,
    }
    // Failing, never read.
    failing.accounts[1] = {
      ...failing.accounts[1],
      probe_failures: 2,
      probe_error_status: 429,
      observed_at: null,
    }
    // Stale, but its usage check isn't failing.
    failing.accounts[2] = {
      ...failing.accounts[2],
      observed_at: now() - 3600,
    }
    getPlanUsage.mockResolvedValue(report([], { pool: failing }))
    await mount()
    const warning = (name: string) =>
      accountRow(name).querySelector('[data-slot="probe-failing"]')
    expect(warning("primary")).toHaveTextContent(
      /^Usage last updated 1[45]m ago — usage check failing \(HTTP 429\)$/
    )
    expect(warning("backup")).toHaveTextContent(
      "Usage check failing (HTTP 429) — numbers may be out of date"
    )
    expect(warning("spare")).toBeNull()
  })

  it("tints an account past the switch threshold", async () => {
    const near = pool()
    near.accounts[1] = {
      ...near.accounts[1],
      state: "at_threshold",
      blocked_until: now() + 3600,
      windows: [limit({ used_percent: 93, resets_at: now() + 3600 })],
    }
    getPlanUsage.mockResolvedValue(report([], { pool: near }))
    await mount()
    const backup = accountRow("backup")
    expect(within(backup).getByText("Over threshold")).toHaveAttribute(
      "title",
      expect.stringContaining("90% switch threshold")
    )
    expect(backup.querySelector('[data-window="five_hour"]')).toHaveAttribute(
      "data-level",
      "high"
    )
  })

  it("says when every account is out and when the first frees up", async () => {
    getPlanUsage.mockResolvedValue(
      report([], {
        pool: pool({ exhausted: true, resumes_at: now() + 45 * 60 + 30 }),
      })
    )
    await mount()
    expect(
      card("Claude Code").querySelector('[data-slot="pool-exhausted"]')
    ).toHaveTextContent(
      /^Every account is at its limit\. The first frees up in 4[45]m\.$/
    )
  })

  it("keeps the last reading when the pool stops answering", async () => {
    getPlanUsage.mockResolvedValue(
      report([], {
        pool: pool({ stale: true, error: "timeout", checked_at: now() }),
      })
    )
    await mount()
    const claude = card("Claude Code")
    expect(within(claude).getByText("Stale")).toBeInTheDocument()
    expect(claude.querySelector('[data-slot="pool-stale"]')).toHaveTextContent(
      /^The pool isn't answering \(timed out\)\./
    )
    expect(claude.querySelectorAll("[data-account]")).toHaveLength(3)
  })

  it("falls back to the agent's reading when the pool never answered", async () => {
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot()], {
        pool: pool({
          accounts: [],
          stale: true,
          error: "unauthorized",
          error_status: 401,
        }),
      })
    )
    await mount()
    const claude = card("Claude Code")
    expect(claude).not.toHaveAttribute("data-pool")
    expect(
      claude.querySelector('[data-slot="pool-unanswered"]')
    ).toHaveTextContent("isn't answering (key refused)")
    expect(within(claude).getByText("42% used")).toBeInTheDocument()
  })

  it("shows the old view when there is no pool", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()]))
    await mount()
    const claude = card("Claude Code")
    expect(claude).not.toHaveAttribute("data-pool")
    expect(claude.querySelector("[data-account]")).toBeNull()
    expect(within(claude).queryByText("Account pool")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/never the accounts' sign-ins/)
    ).not.toBeInTheDocument()
  })

  it("takes pushed pool readings, and drops the pool when it goes away", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()]))
    await mount()
    expect(poolHandler).not.toBeNull()

    act(() => {
      poolHandler?.(pool())
    })
    expect(card("Claude Code")).toHaveAttribute("data-pool", "maxpool")
    expect(accountRow("backup")).toBeInTheDocument()

    act(() => {
      poolHandler?.(null)
    })
    expect(card("Claude Code")).not.toHaveAttribute("data-pool")
    expect(
      within(card("Claude Code")).getByText("42% used")
    ).toBeInTheDocument()
  })
})
