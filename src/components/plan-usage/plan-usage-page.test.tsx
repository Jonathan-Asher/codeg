import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "@/lib/types"

const getPlanUsage = vi.fn<(force?: boolean) => Promise<PlanUsageReport>>()
let pushHandler: ((snapshot: PlanUsageSnapshot) => void) | null = null

vi.mock("@/lib/api", () => ({
  getPlanUsage: (force?: boolean) => getPlanUsage(force),
  subscribePlanUsageChanged: (handler: (s: PlanUsageSnapshot) => void) => {
    pushHandler = handler
    return Promise.resolve(() => {
      pushHandler = null
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
