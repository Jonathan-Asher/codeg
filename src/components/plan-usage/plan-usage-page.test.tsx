import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  LimitResetsReport,
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolRecheckResult,
  PlanUsagePoolRedeemResult,
  PlanUsagePoolResets,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
  UseLimitResetResult,
} from "@/lib/types"

const getPlanUsage = vi.fn<(force?: boolean) => Promise<PlanUsageReport>>()
const getLimitResets = vi.fn<(force?: boolean) => Promise<LimitResetsReport>>()
const consumeLimitReset =
  vi.fn<
    (args: {
      provider: string
      id?: string | null
      conversationId?: number | null
    }) => Promise<UseLimitResetResult>
  >()
let pushHandler: ((snapshot: PlanUsageSnapshot) => void) | null = null
let poolHandler: ((pool: PlanUsagePool | null) => void) | null = null

const manage = vi.hoisted(() => {
  type Change = Promise<{ applied: string }>
  return {
    usagePoolManageInfo: vi.fn<
      () => Promise<{ available: boolean; reload: string }>
    >(() => Promise.resolve({ available: false, reload: "idle" })),
    usagePoolLoginStart: vi.fn<
      (options: {
        name?: string | null
        reconnect?: string | null
      }) => Promise<{ handle: string; url: string }>
    >(() =>
      Promise.resolve({
        handle: "h1",
        url: "https://claude.test/oauth/authorize?state=st",
      })
    ),
    usagePoolLoginFinish: vi.fn<
      (
        handle: string,
        pasted: string
      ) => Promise<{ ok: boolean; reason: null; retry: boolean }>
    >(() => Promise.resolve({ ok: true, reason: null, retry: false })),
    usagePoolLoginState: vi.fn<(handle: string) => Promise<string>>(() =>
      Promise.resolve("waiting")
    ),
    usagePoolLoginCancel: vi.fn<(handle: string) => Promise<void>>(() =>
      Promise.resolve()
    ),
    usagePoolRename: vi.fn<(name: string, newName: string) => Change>(() =>
      Promise.resolve({ applied: "restarting" })
    ),
    usagePoolSetEnabled: vi.fn<(name: string, enabled: boolean) => Change>(() =>
      Promise.resolve({ applied: "live" })
    ),
    usagePoolSetOrder: vi.fn<(names: string[] | null) => Change>(() =>
      Promise.resolve({ applied: "restarting" })
    ),
    usagePoolSetReserve: vi.fn<
      (name: string, percent: number | null, mode: string) => Change
    >(() => Promise.resolve({ applied: "live" })),
    usagePoolRemove: vi.fn<(name: string) => Change>(() =>
      Promise.resolve({ applied: "restarting" })
    ),
    usagePoolRestartNow: vi.fn<
      () => Promise<{ available: boolean; reload: string }>
    >(() => Promise.resolve({ available: true, reload: "idle" })),
    usagePoolRedeemReset:
      vi.fn<
        (args: {
          name: string
          grantId?: string | null
          conversationId?: number | null
        }) => Promise<PlanUsagePoolRedeemResult>
      >(),
    usagePoolRecheck:
      vi.fn<(name: string) => Promise<PlanUsagePoolRecheckResult>>(),
  }
})

vi.mock("@/lib/api", () => ({
  ...manage,
  getPlanUsage: (force?: boolean) => getPlanUsage(force),
  getLimitResets: (force?: boolean) => getLimitResets(force),
  consumeLimitReset: (args: {
    provider: string
    id?: string | null
    conversationId?: number | null
  }) => consumeLimitReset(args),
  continueLimitNow: () => Promise.resolve(true),
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
  openUrl: vi.fn(),
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock("sonner", () => ({ toast }))

import { resetLimitResetsCacheForTests } from "@/hooks/use-limit-resets"
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
  resetLimitResetsCacheForTests()
  getLimitResets.mockReset().mockResolvedValue({ providers: [] })
  consumeLimitReset.mockReset()
  pushHandler = null
  poolHandler = null
  for (const fn of Object.values(manage)) fn.mockClear()
  for (const fn of Object.values(toast)) fn.mockClear()
  manage.usagePoolManageInfo.mockImplementation(() =>
    Promise.resolve({ available: false, reload: "idle" })
  )
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
    // The pool prefers it: it heads the order.
    expect(accountRow("primary")).toHaveAttribute("data-position", "1")
    expect(primary.getByText("Exhausted")).toBeInTheDocument()
    expect(primary.getByText(/^At limit until /)).toBeInTheDocument()
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
    expect(within(accountRow("spare")).getByText("Paused")).toBeInTheDocument()

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

describe("PlanUsagePage account pool management", () => {
  const accountRow = (name: string) =>
    card("Claude Code").querySelector<HTMLElement>(`[data-account="${name}"]`)!

  async function mountManaged(reload = "idle") {
    manage.usagePoolManageInfo.mockImplementation(() =>
      Promise.resolve({ available: true, reload })
    )
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()], { pool: pool() }))
    await mount()
    await screen.findByRole("button", { name: "Add account" })
  }

  async function openActions(name: string) {
    const user = userEvent.setup()
    await user.click(
      within(accountRow(name)).getByRole("button", {
        name: `Actions for ${name}`,
      })
    )
    return user
  }

  it("offers nothing where the host has no pool to manage", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()], { pool: pool() }))
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(manage.usagePoolManageInfo).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Add account" })).toBeNull()
    expect(
      within(accountRow("backup")).queryByRole("button", {
        name: "Actions for backup",
      })
    ).toBeNull()
  })

  it("adds an account: a name, the link, then the pasted address", async () => {
    await mountManaged()
    fireEvent.click(screen.getByRole("button", { name: "Add account" }))
    fireEvent.change(
      screen.getByPlaceholderText("Defaults to the account email"),
      {
        target: { value: "work" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await screen.findByText("https://claude.test/oauth/authorize?state=st")
    expect(manage.usagePoolLoginStart).toHaveBeenCalledWith({ name: "work" })

    fireEvent.change(
      screen.getByPlaceholderText("http://localhost:…/callback?code=…"),
      { target: { value: "http://localhost:1/callback?code=c&state=st" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(manage.usagePoolLoginFinish).toHaveBeenCalledWith(
      "h1",
      "http://localhost:1/callback?code=c&state=st"
    )
    // The report is read again for the new account.
    expect(getPlanUsage).toHaveBeenCalledWith(true)
  })

  it("signs a failed account in again from its menu", async () => {
    await mountManaged()
    const user = await openActions("primary")
    await user.click(screen.getByRole("menuitem", { name: "Sign in again" }))
    await screen.findByText("Sign primary in again")
    expect(manage.usagePoolLoginStart).toHaveBeenCalledWith({
      reconnect: "primary",
    })
  })

  it("removes an account only after the confirmation", async () => {
    await mountManaged()
    const user = await openActions("spare")
    await user.click(screen.getByRole("menuitem", { name: "Remove" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Remove spare from the pool?")
    expect(manage.usagePoolRemove).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Remove" }))
    expect(manage.usagePoolRemove).toHaveBeenCalledWith("spare")
  })

  it("renames an account through the pool's own tools", async () => {
    await mountManaged()
    const user = await openActions("backup")
    await user.click(screen.getByRole("menuitem", { name: "Rename" }))
    const input = await screen.findByDisplayValue("backup")
    fireEvent.change(input, { target: { value: "personal" } })
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(manage.usagePoolRename).toHaveBeenCalledWith("backup", "personal")
  })

  it("orders the accounts from the top and moves them with buttons, keys and the menu", async () => {
    await mountManaged()
    const list = card("Claude Code").querySelector(
      '[data-slot="pool-accounts"]'
    )!
    const names = () =>
      Array.from(list.querySelectorAll<HTMLElement>("[data-account]")).map(
        (r) => r.dataset.account
      )
    // The pool prefers primary: the order starts there.
    expect(
      card("Claude Code").querySelector('[data-slot="pool-routing"]')
    ).toHaveTextContent(
      "Order: new requests go to the first account that can take them, from the top"
    )
    expect(names()).toEqual(["primary", "backup", "spare"])
    expect(accountRow("primary")).toHaveAttribute("data-position", "1")
    expect(
      within(accountRow("primary")).getByRole("button", {
        name: "Move primary up",
      })
    ).toBeDisabled()

    const user = userEvent.setup()
    await user.click(
      within(accountRow("backup")).getByRole("button", {
        name: "Move backup up",
      })
    )
    expect(manage.usagePoolSetOrder).toHaveBeenLastCalledWith([
      "backup",
      "primary",
      "spare",
    ])
    expect(names()).toEqual(["backup", "primary", "spare"])

    // The handle moves its account with the arrow keys and keeps the focus.
    const handle = within(accountRow("spare")).getByRole("button", {
      name: "Reorder spare: drag, or use the arrow keys",
    })
    handle.focus()
    await user.keyboard("{ArrowUp}")
    expect(manage.usagePoolSetOrder).toHaveBeenLastCalledWith([
      "backup",
      "spare",
      "primary",
    ])
    expect(names()).toEqual(["backup", "spare", "primary"])
    expect(handle).toHaveFocus()

    await openActions("primary")
    await user.click(screen.getByRole("menuitem", { name: "Move to top" }))
    expect(manage.usagePoolSetOrder).toHaveBeenLastCalledWith([
      "primary",
      "backup",
      "spare",
    ])
  })

  it("goes back to automatic balancing from the first account's menu", async () => {
    await mountManaged()
    const user = await openActions("primary")
    expect(screen.queryByRole("menuitem", { name: "Move to top" })).toBeNull()
    await user.click(
      screen.getByRole("menuitem", { name: "Use automatic routing" })
    )
    expect(manage.usagePoolSetOrder).toHaveBeenCalledWith(null)
  })

  it("lists an automatic pool without an order until one is set", async () => {
    manage.usagePoolManageInfo.mockImplementation(() =>
      Promise.resolve({ available: true, reload: "idle" })
    )
    const automatic = pool({
      routing_mode: "automatic",
      preferred_account: null,
    })
    automatic.accounts = automatic.accounts.map((a) => ({
      ...a,
      preferred: false,
    }))
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot()], { pool: automatic })
    )
    await mount()
    await screen.findByRole("button", { name: "Add account" })
    expect(
      card("Claude Code").querySelector('[data-slot="pool-routing"]')
    ).toHaveTextContent("Routing: automatic")
    expect(accountRow("primary")).not.toHaveAttribute("data-position")
    const user = await openActions("spare")
    await user.click(screen.getByRole("menuitem", { name: "Move to top" }))
    expect(manage.usagePoolSetOrder).toHaveBeenCalledWith([
      "spare",
      "primary",
      "backup",
    ])
  })

  it("pauses and resumes an account from its row", async () => {
    await mountManaged()
    expect(accountRow("spare")).toHaveAttribute("data-state", "disabled")
    expect(within(accountRow("spare")).getByText("Paused")).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(
      within(accountRow("backup")).getByRole("button", { name: "Pause" })
    )
    expect(manage.usagePoolSetEnabled).toHaveBeenCalledWith("backup", false)
    await user.click(
      within(accountRow("spare")).getByRole("button", { name: "Resume" })
    )
    expect(manage.usagePoolSetEnabled).toHaveBeenCalledWith("spare", true)
  })

  it("keeps a reserve: a preset that is never used by default, a custom one, none", async () => {
    await mountManaged()
    const user = userEvent.setup()
    await user.click(
      within(accountRow("backup")).getByRole("button", { name: "No reserve" })
    )
    let dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Reserve for backup")
    expect(within(dialog).getByRole("radio", { name: "None" })).toBeChecked()
    await user.click(within(dialog).getByRole("radio", { name: "10%" }))
    expect(
      within(dialog).getByRole("radio", { name: /Never use it/ })
    ).toBeChecked()
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(manage.usagePoolSetReserve).toHaveBeenLastCalledWith(
      "backup",
      10,
      "fixed"
    )

    await user.click(
      within(accountRow("primary")).getByRole("button", { name: "No reserve" })
    )
    dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("radio", { name: "Custom" }))
    const custom = within(dialog).getByRole("spinbutton", {
      name: "Custom reserve, in percent",
    })
    await user.type(custom, "150")
    expect(
      within(dialog).getByText("Enter a whole percent from 1 to 99.")
    ).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled()
    await user.clear(custom)
    await user.type(custom, "7")
    await user.click(
      within(dialog).getByRole("radio", { name: /Release it near the reset/ })
    )
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(manage.usagePoolSetReserve).toHaveBeenLastCalledWith(
      "primary",
      7,
      "dynamic"
    )
  })

  it("shows a reserve on the bars, the hold it causes, and clears it", async () => {
    manage.usagePoolManageInfo.mockImplementation(() =>
      Promise.resolve({ available: true, reload: "idle" })
    )
    const reserved = pool()
    reserved.accounts = reserved.accounts.map((a) =>
      a.name === "backup"
        ? {
            ...a,
            state: "reserved" as const,
            blocked_until: now() + 72 * 60 + 30,
            reserve: { percent: 15, mode: "dynamic" as const },
          }
        : a
    )
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot()], { pool: reserved })
    )
    await mount()
    await screen.findByRole("button", { name: "Add account" })
    const backup = accountRow("backup")
    expect(backup).toHaveAttribute("data-state", "reserved")
    expect(within(backup).getByText("Reserve reached")).toHaveAttribute(
      "title",
      "Its 15% reserve is reached. New requests go to the next account until the window resets."
    )
    expect(within(backup).getByText(/^Back in 1h 1[23]m$/)).toBeInTheDocument()
    const lines = Array.from(
      backup.querySelectorAll<HTMLElement>('[data-slot="reserve-line"]')
    )
    // On the 5-hour and weekly bars; not on the model's own window.
    expect(
      lines.map((l) => l.closest("[data-window]")?.getAttribute("data-window"))
    ).toEqual(["five_hour", "seven_day"])
    expect(lines[0].style.left).toBe("85%")

    const user = userEvent.setup()
    await user.click(
      within(backup).getByRole("button", {
        name: "Reserve 15%, released near the reset",
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("radio", { name: "15%" })).toBeChecked()
    expect(
      within(dialog).getByRole("radio", { name: /Release it near the reset/ })
    ).toBeChecked()
    await user.click(within(dialog).getByRole("radio", { name: "None" }))
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(manage.usagePoolSetReserve).toHaveBeenLastCalledWith(
      "backup",
      null,
      "dynamic"
    )
  })

  it("says until when an exhausted account is at its limit", async () => {
    await mountManaged()
    expect(
      within(accountRow("primary")).getByText(/^At limit until /)
    ).toBeInTheDocument()
  })

  it("truncates a long account name and keeps it whole in a tooltip", async () => {
    manage.usagePoolManageInfo.mockImplementation(() =>
      Promise.resolve({ available: true, reload: "idle" })
    )
    const email = "someone.with.a.really.long.address@example-company.co.il"
    const named = pool()
    named.accounts = named.accounts.map((a) =>
      a.name === "spare" ? { ...a, name: email } : a
    )
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()], { pool: named }))
    await mount()
    await screen.findByRole("button", { name: "Add account" })
    const name = within(accountRow(email)).getByText(email)
    expect(name).toHaveAttribute("title", email)
    expect(name).toHaveClass("truncate", "min-w-0")
    expect(card("Claude Code").querySelectorAll("[data-account]")).toHaveLength(
      3
    )
    expect(
      within(accountRow(email)).getByRole("button", {
        name: `Actions for ${email}`,
      })
    ).toBeInTheDocument()
  })

  it("says when a change waits for the pool to restart", async () => {
    await mountManaged("waiting")
    const notice = await screen.findByRole("status", {
      name: (_, el) => el.getAttribute("data-slot") === "pool-reload-notice",
    })
    expect(notice).toHaveTextContent("applies when the pool restarts")
    fireEvent.click(within(notice).getByRole("button", { name: "Restart now" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(manage.usagePoolRestartNow).toHaveBeenCalledTimes(1)
  })
})

describe("PlanUsagePage usage-limit resets", () => {
  const codexResets = (available: number) => ({
    provider: "codex" as const,
    available,
    items: Array.from({ length: available }, (_, i) => ({
      id: `credit-${i}`,
      kind: "full" as const,
      label: "Full reset",
      description: null,
      count: 1,
      expires_at: now() + (10 + i) * 86_400,
    })),
    source: "codex_app_server" as const,
    account: "me@example.com",
    error: null,
    fetched_at: now(),
  })

  it("shows Codex's resets on its card, points the subscription card to its usage page, and a used one re-reads the bars", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot(), codexSnapshot()]))
    getLimitResets.mockResolvedValue({ providers: [codexResets(2)] })
    consumeLimitReset.mockResolvedValue({
      provider: "codex",
      outcome: "reset",
      resets: codexResets(1),
      paused_conversations: [],
      continued: null,
    })
    await mount()

    const codex = card("Codex")
    const resets = await within(codex).findByText(/2 resets available/)
    expect(resets).toHaveTextContent(/first expires/)
    expect(
      within(card("Claude Code")).getByText(
        enMessages.PlanUsage.resets.claude.elsewhere
      )
    ).toBeInTheDocument()
    expect(
      within(card("Claude Code")).getByTestId("claude-resets-open")
    ).toHaveTextContent(enMessages.PlanUsage.resets.claude.open)
    expect(getLimitResets).toHaveBeenCalledWith(false)

    getPlanUsage.mockClear()
    fireEvent.click(within(codex).getByRole("button", { name: "Use reset" }))
    fireEvent.click(await screen.findByTestId("limit-reset-confirm-use"))
    expect(
      await within(codex).findByText(
        /Reset used: your limits are refilled\. 1 reset left\./
      )
    ).toBeInTheDocument()
    expect(consumeLimitReset).toHaveBeenCalledWith({
      provider: "codex",
      id: "credit-0",
      conversationId: undefined,
    })
    // The bars are read again past the cache, and the count follows.
    expect(getPlanUsage).toHaveBeenCalledWith(true)
    expect(within(codex).getByText(/1 reset available/)).toBeInTheDocument()
  })

  it("says when the Codex reading came from Codex itself", async () => {
    getPlanUsage.mockResolvedValue(
      report([claudeSnapshot(), codexSnapshot({ source: "live" })])
    )
    await mount()
    const codex = within(card("Codex"))
    expect(
      codex.getByText(enMessages.PlanUsage.source.codexLive)
    ).toBeInTheDocument()
    expect(codex.queryByText(/newest Codex session log/)).toBeNull()
  })

  it("asks the providers again on Refresh", async () => {
    getPlanUsage.mockResolvedValue(report([claudeSnapshot(), codexSnapshot()]))
    await mount()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getLimitResets).toHaveBeenCalledWith(true)
  })
})

describe("PlanUsagePage account pool resets", () => {
  const accountRow = (name: string) =>
    card("Claude Code").querySelector<HTMLElement>(`[data-account="${name}"]`)!

  function resets(
    overrides: Partial<PlanUsagePoolResets> = {}
  ): PlanUsagePoolResets {
    return {
      available: 2,
      grants: [
        {
          id: "g-weekly",
          label: null,
          kind: "weekly",
          model: null,
          refills: ["seven_day"],
          count: 2,
          expires_at: now() + 9 * 86_400,
          usable_now: true,
          requires_limit: true,
          gives_back_weekly: false,
        },
      ],
      next_grant_id: "g-weekly",
      cooldown_until: null,
      eligible: true,
      auto_redeem: false,
      checked_at: now() - 30,
      limits_reached: [],
      ...overrides,
    }
  }

  /** The November launch's Fable resets as the pool lists them: each
   *  refills only Fable's own weekly limit and gives back what Fable used of
   *  the general one. */
  function fableResets(count: number): PlanUsagePoolResets {
    const ids = [
      "launch-2610-fable",
      "launch-2610-fable-12mo",
      "launch-2610-fable-6mo",
    ]
    return resets({
      available: count,
      grants: ids.slice(0, count).map((id) => ({
        id,
        label:
          "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
        kind: "model_weekly",
        model: "Fable",
        refills: ["seven_day_fable"],
        count: 1,
        expires_at: now() + 117 * 86_400,
        usable_now: true,
        requires_limit: false,
        gives_back_weekly: true,
      })),
      next_grant_id: ids[0],
    })
  }

  /** `primary` at its limit with two weekly resets, `backup` serving with
   *  one that only works at a limit, and three accounts held for a while. */
  function resetsPool(overrides: Partial<PlanUsagePool> = {}): PlanUsagePool {
    const base = pool()
    const held = (name: string, state: PlanUsagePoolAccount["state"]) =>
      poolAccount({
        name,
        state,
        blocked_until: now() + 3600,
        cooling_until: state === "cooling_down" ? now() + 3600 : null,
      })
    return {
      ...base,
      resets_supported: true,
      accounts: [
        {
          ...base.accounts[0],
          resets: resets({ limits_reached: ["five_hour"] }),
        },
        {
          ...base.accounts[1],
          resets: resets({
            available: 1,
            grants: [
              {
                id: "g-full",
                label: "One full limit reset",
                kind: "full",
                model: null,
                refills: ["five_hour", "seven_day"],
                count: 1,
                expires_at: now() + 20 * 86_400,
                usable_now: true,
                requires_limit: true,
                gives_back_weekly: false,
              },
            ],
            next_grant_id: null,
          }),
        },
        base.accounts[2],
        held("cool", "cooling_down"),
        held("keep", "reserved"),
        held("near", "at_threshold"),
      ],
      ...overrides,
    }
  }

  async function mountWith(p: PlanUsagePool) {
    manage.usagePoolManageInfo.mockImplementation(() =>
      Promise.resolve({ available: true, reload: "idle" })
    )
    getPlanUsage.mockResolvedValue(report([claudeSnapshot()], { pool: p }))
    await mount()
    await screen.findByRole("button", { name: "Add account" })
  }

  it("shows each account's resets; Use reset asks first, uses it through the pool, and reads the pool again", async () => {
    manage.usagePoolRedeemReset.mockResolvedValue({
      account: "primary",
      outcome: "reset",
      pool: null,
      continued: null,
    })
    await mountWith(resetsPool())
    const primary = accountRow("primary")
    const line = primary.querySelector('[data-slot="pool-resets"]')!
    expect(line).toHaveTextContent(
      /^2 weekly resets · each refills your weekly limit · expires \w{3} \d{1,2}/
    )
    // Backup's only reset works at a limit, and backup is serving.
    expect(
      within(accountRow("backup")).getByTestId("pool-resets-available")
    ).toHaveTextContent(
      /^1 full reset · refills your 5-hour and weekly limits · expires .+ · Usable once you reach a limit$/
    )
    expect(
      within(accountRow("backup")).queryByTestId("pool-reset-use")
    ).toBeNull()

    const calls = getPlanUsage.mock.calls.length
    fireEvent.click(within(primary).getByTestId("pool-reset-use"))
    expect(screen.getByTestId("pool-reset-confirm")).toHaveTextContent(
      "Use 1 reset on primary? It refills the weekly limit now and can't be undone."
    )
    expect(manage.usagePoolRedeemReset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Reset used on primary: its limits are refilled."
      )
    )
    expect(manage.usagePoolRedeemReset).toHaveBeenCalledWith({
      name: "primary",
      grantId: "g-weekly",
      conversationId: undefined,
    })
    await vi.waitFor(() =>
      expect(getPlanUsage.mock.calls.length).toBeGreaterThan(calls)
    )
  })

  it("says why an account's reset can't be used yet, and maps a refusal to its words", async () => {
    const p = resetsPool()
    p.accounts[0] = {
      ...p.accounts[0],
      resets: resets({ cooldown_until: now() + 3 * 86_400 }),
    }
    await mountWith(p)
    expect(
      accountRow("primary").querySelector('[data-slot="pool-resets"]')
    ).toHaveTextContent(
      /2 weekly resets · each refills your weekly limit · expires .+ · next one usable/
    )
    expect(
      within(accountRow("primary")).queryByTestId("pool-reset-use")
    ).toBeNull()
  })

  it("names a Fable reset's limit on the row and in the confirmation", async () => {
    manage.usagePoolRedeemReset.mockResolvedValue({
      account: "backup",
      outcome: "reset",
      pool: null,
      continued: null,
    })
    const p = resetsPool()
    p.accounts[1] = { ...p.accounts[1], resets: fableResets(1) }
    await mountWith(p)
    const backup = accountRow("backup")
    expect(
      within(backup).getByTestId("pool-resets-available")
    ).toHaveTextContent(
      /^1 Fable reset · refills only your Fable weekly limit · expires \w{3} \d{1,2}(, \d{4})?$/
    )
    fireEvent.click(within(backup).getByTestId("pool-reset-use"))
    expect(screen.getByTestId("pool-reset-confirm-body")).toHaveTextContent(
      "Use 1 Fable reset on backup? It refills only the weekly limit for Fable models, not your general weekly limit, and can't be undone."
    )
    expect(screen.queryByTestId("pool-reset-confirm-note")).toBeNull()
    const calls = getPlanUsage.mock.calls.length
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Reset used on backup: its limits are refilled."
      )
    )
    expect(manage.usagePoolRedeemReset).toHaveBeenCalledWith({
      name: "backup",
      grantId: "launch-2610-fable",
      conversationId: undefined,
    })
    await vi.waitFor(() =>
      expect(getPlanUsage.mock.calls.length).toBeGreaterThan(calls)
    )
  })

  it("holds back a Fable reset on an account at its general weekly limit, and says why", async () => {
    const p = resetsPool()
    p.accounts[1] = {
      ...p.accounts[1],
      state: "exhausted",
      resets: { ...fableResets(3), limits_reached: ["seven_day"] },
    }
    await mountWith(p)
    const backup = accountRow("backup")
    expect(
      within(backup).getByTestId("pool-resets-available")
    ).toHaveTextContent(
      /^3 Fable resets · each refills only your Fable weekly limit · expires .+ · won't help now: the account is at its general weekly limit, which this doesn't refill$/
    )
    const use = within(backup).getByTestId("pool-reset-use")
    expect(use).toBeDisabled()
    expect(use).toHaveAttribute(
      "title",
      "won't help now: the account is at its general weekly limit, which this doesn't refill"
    )
    fireEvent.click(use)
    expect(screen.queryByTestId("pool-reset-confirm")).toBeNull()
    expect(manage.usagePoolRedeemReset).not.toHaveBeenCalled()
  })

  it("lets a Fable reset give back Fable's own use at the general weekly limit, saying that's all it frees", async () => {
    const p = resetsPool()
    const windows = p.accounts[1].windows.map((w) =>
      w.id === "seven_day" ? { ...w, used_percent: 100 } : w
    )
    p.accounts[1] = {
      ...p.accounts[1],
      state: "exhausted",
      windows: [
        ...windows,
        {
          ...windows[1],
          id: "seven_day_fable",
          kind: "weekly_model",
          label: "Fable",
          used_percent: 35,
        },
      ],
      resets: { ...fableResets(1), limits_reached: ["seven_day"] },
    }
    await mountWith(p)
    const backup = accountRow("backup")
    expect(
      within(backup).getByTestId("pool-resets-available")
    ).toHaveTextContent(
      /· at the general weekly limit it frees up only what Fable used this week$/
    )
    fireEvent.click(within(backup).getByTestId("pool-reset-use"))
    expect(screen.getByTestId("pool-reset-confirm-note")).toHaveTextContent(
      "This account is at its general weekly limit: this reset frees up only what Fable models used of it this week."
    )
  })

  it("shows a reset whose limit isn't known, with nothing to use it", async () => {
    const p = resetsPool()
    p.accounts[1] = {
      ...p.accounts[1],
      resets: resets({
        available: 1,
        grants: [
          {
            ...resets().grants[0],
            id: "g-unknown",
            kind: "other",
            refills: [],
            count: 1,
            requires_limit: false,
          },
        ],
        next_grant_id: null,
      }),
    }
    await mountWith(p)
    const backup = accountRow("backup")
    expect(
      within(backup).getByTestId("pool-resets-available")
    ).toHaveTextContent(
      /^1 reset · what it refills isn't known · expires \w{3} \d{1,2}(, \d{4})?$/
    )
    expect(within(backup).queryByTestId("pool-reset-use")).toBeNull()
  })

  it("offers Recheck now beside a cooling-down, reserved or over-threshold account, and nowhere else", async () => {
    manage.usagePoolRecheck.mockResolvedValue({
      account: "cool",
      read: true,
      lifted: true,
      pool: null,
    })
    await mountWith(resetsPool())
    for (const name of ["cool", "keep", "near"]) {
      expect(
        within(accountRow(name)).getByTestId("pool-recheck")
      ).toHaveTextContent("Recheck now")
    }
    for (const name of ["primary", "backup", "spare"]) {
      expect(within(accountRow(name)).queryByTestId("pool-recheck")).toBeNull()
    }
    fireEvent.click(within(accountRow("cool")).getByTestId("pool-recheck"))
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("cool is usable again.")
    )
    expect(manage.usagePoolRecheck).toHaveBeenCalledWith("cool")
    expect(manage.usagePoolRedeemReset).not.toHaveBeenCalled()
  })

  it("shows neither resets nor Recheck when the pool lacks the routes", async () => {
    const p = resetsPool({ resets_supported: false })
    p.accounts[0] = {
      ...p.accounts[0],
      resets: resets({ at_wall: true, recommended: true }),
    }
    await mountWith(p)
    const claude = card("Claude Code")
    expect(claude.querySelector('[data-slot="pool-resets"]')).toBeNull()
    expect(within(claude).queryByTestId("pool-recheck")).toBeNull()
    expect(within(claude).queryByTestId("pool-reset-use")).toBeNull()
    expect(
      claude.querySelector('[data-slot="pool-reset-recommended"]')
    ).toBeNull()
  })

  it("highlights each account the pool would use a reset on, and uses it after the same confirmation", async () => {
    manage.usagePoolRedeemReset.mockResolvedValue({
      account: "primary",
      outcome: "reset",
      pool: null,
      continued: null,
    })
    const p = resetsPool()
    p.accounts[0] = {
      ...p.accounts[0],
      resets: resets({
        limits_reached: ["seven_day"],
        at_wall: true,
        wall: ["general"],
        weekly_utilization: 1,
        recommended: true,
        recommended_grant_id: "g-weekly",
        advice: "at the general weekly limit; renews in 3d",
      }),
    }
    await mountWith(p)
    const claude = card("Claude Code")
    const highlight = claude.querySelector<HTMLElement>(
      '[data-slot="pool-reset-recommended"]'
    )!
    // At the top of the card, above the accounts.
    expect(
      highlight.compareDocumentPosition(
        claude.querySelector('[data-slot="pool-accounts"]')!
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    const lines = within(highlight).getAllByTestId(
      "pool-reset-recommended-text"
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent(
      "Reset available: primary is at its limit"
    )
    expect(lines[0]).toHaveAttribute(
      "title",
      "at the general weekly limit; renews in 3d"
    )

    fireEvent.click(within(highlight).getByTestId("pool-reset-recommended-use"))
    expect(screen.getByTestId("pool-reset-confirm-body")).toHaveTextContent(
      "Use 1 reset on primary? It refills the weekly limit now and can't be undone."
    )
    expect(screen.queryByTestId("pool-reset-confirm-renews")).toBeNull()
    expect(manage.usagePoolRedeemReset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Reset used on primary: its limits are refilled."
      )
    )
    expect(manage.usagePoolRedeemReset).toHaveBeenCalledTimes(1)
    expect(manage.usagePoolRedeemReset.mock.calls[0][0]).toEqual({
      name: "primary",
      grantId: "g-weekly",
      conversationId: undefined,
    })
  })

  it("highlights nothing the pool's reading can't use: a grant it doesn't hold, or a limit that renews soon", async () => {
    const p = resetsPool()
    p.accounts[0] = {
      ...p.accounts[0],
      resets: resets({ at_wall: true, recommended: true, renews_soon: true }),
    }
    p.accounts[1] = {
      ...p.accounts[1],
      state: "exhausted",
      resets: resets({
        at_wall: true,
        recommended: true,
        recommended_grant_id: "g-gone",
      }),
    }
    await mountWith(p)
    expect(
      card("Claude Code").querySelector('[data-slot="pool-reset-recommended"]')
    ).toBeNull()
  })

  it("says when a limit renews by itself, and uses its reset only after a warning, going ahead anyway", async () => {
    manage.usagePoolRedeemReset.mockResolvedValue({
      account: "primary",
      outcome: "reset",
      pool: null,
      continued: null,
    })
    const p = resetsPool({ reset_claim_guard_secs: 43_200 })
    p.accounts[0] = {
      ...p.accounts[0],
      resets: resets({
        limits_reached: ["seven_day"],
        at_wall: true,
        wall: ["general"],
        weekly_renews_at: now() + 5 * 3600 + 20 * 60 + 30,
        renews_soon: true,
        recommended: true,
        advice: "weekly renews in 5h; not worth a reset",
      }),
    }
    await mountWith(p)
    const primary = accountRow("primary")
    const renews = within(primary).getByTestId("pool-renews-soon")
    expect(renews).toHaveTextContent(
      "Its limit renews by itself in 5h 20m, so a reset now is mostly wasted."
    )
    expect(renews).toHaveAttribute(
      "title",
      "weekly renews in 5h; not worth a reset"
    )
    // Never highlighted while its limit renews by itself soon.
    expect(
      card("Claude Code").querySelector('[data-slot="pool-reset-recommended"]')
    ).toBeNull()

    fireEvent.click(within(primary).getByTestId("pool-reset-use"))
    const confirm = screen.getByTestId("pool-reset-confirm")
    expect(confirm).toHaveAttribute("data-renews-soon", "true")
    expect(screen.getByTestId("pool-reset-confirm-body")).toHaveTextContent(
      "Use 1 reset on primary? It refills the weekly limit now and can't be undone."
    )
    expect(screen.getByTestId("pool-reset-confirm-renews")).toHaveTextContent(
      /^Its limit renews by itself at .+ \(in 5h 20m\) anyway, so a reset now is mostly wasted\. The pool holds resets back within 12 hours of an account's own renewal; this one goes ahead only because you ask\.$/
    )
    const use = screen.getByTestId("pool-reset-confirm-use")
    expect(use).toHaveTextContent("Use reset anyway")
    expect(manage.usagePoolRedeemReset).not.toHaveBeenCalled()
    fireEvent.click(use)
    await vi.waitFor(() =>
      expect(manage.usagePoolRedeemReset).toHaveBeenCalledWith({
        name: "primary",
        grantId: "g-weekly",
        conversationId: undefined,
        force: true,
      })
    )
  })

  it("says when an account's limit renews by itself if the pool holds its reset back", async () => {
    manage.usagePoolRedeemReset.mockRejectedValue({
      code: "invalid_input",
      message: "This account's limit renews by itself within 12 h.",
      i18n_key: "pool.resets.error.renewsSoon",
      i18n_params: {
        reason: "renews_soon",
        renews_at: String(now() + 3 * 3600),
      },
    })
    await mountWith(resetsPool())
    fireEvent.click(within(accountRow("primary")).getByTestId("pool-reset-use"))
    expect(screen.queryByTestId("pool-reset-confirm-renews")).toBeNull()
    fireEvent.click(screen.getByTestId("pool-reset-confirm-use"))
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^This account's limit renews by itself at .+, so the pool held the reset back\.$/
        )
      )
    )
    expect(manage.usagePoolRedeemReset.mock.calls[0][0]).not.toHaveProperty(
      "force"
    )
  })
})
