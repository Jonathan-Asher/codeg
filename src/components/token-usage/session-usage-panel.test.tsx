import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type {
  TokenUsageConversationItem,
  TokenUsageFilter,
  TokenUsageSessionsQuery,
  TokenUsageSessionsReport,
  TokenUsageSlice,
} from "@/lib/types"
import {
  ACCOUNTS_OFF_STORAGE_KEY,
  SPLIT_STORAGE_KEY,
  SessionUsagePanel,
  accountColors,
  formatPct,
} from "./session-usage-panel"

const h = vi.hoisted(() => ({
  sessions: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  tokenUsageSessions: h.sessions,
}))

const slice = (
  tokens: number,
  cost: number | null,
  pct: number | null,
  calls = 1
): TokenUsageSlice => ({ tokens, cost_usd: cost, pct, calls })

function report(
  over: Partial<TokenUsageSessionsReport> = {}
): TokenUsageSessionsReport {
  return {
    pool: {
      configured: true,
      reachable: true,
      error: null,
      last_pulled_at: "2026-11-23T10:00:00Z",
      records_since: "2026-11-23T08:00:00Z",
    },
    accounts: [
      {
        account: "eliamarlawoffice",
        kind: "claude",
        usage: slice(600_000, 12, 0.6, 30),
        pool_cost_usd: 40,
        pool_pct: 2,
        pool_calls: 90,
        pool_metered_pct: 2,
        usd_per_pct: 20,
        usd_per_pct_measured: true,
      },
      {
        account: "jonathanashur@gmail.com",
        kind: "claude",
        usage: slice(300_000, 6, 0.3, 10),
        pool_cost_usd: 6,
        pool_pct: 0.3,
        pool_calls: 10,
        pool_metered_pct: 0,
        usd_per_pct: 19.8,
        usd_per_pct_measured: false,
      },
      {
        account: "__none__",
        kind: "none",
        usage: slice(1_000, 0.01, null, 1),
        pool_cost_usd: 0,
        pool_pct: 0,
        pool_calls: 0,
        pool_metered_pct: 0,
        usd_per_pct: null,
        usd_per_pct_measured: false,
      },
    ],
    sessions: [
      {
        conversation_id: 11,
        title: "Upstream merge",
        agent_type: "claude_code",
        folder_label: "codeg",
        last_activity_at: "2026-11-23T10:00:00Z",
        usage: slice(901_000, 18.01, 0.9, 41),
        detail: true,
        by_account: [
          { account: "eliamarlawoffice", usage: slice(600_000, 12, 0.6, 30) },
          {
            account: "jonathanashur@gmail.com",
            usage: slice(300_000, 6, 0.3, 10),
          },
          { account: "__none__", usage: slice(1_000, 0.01, null, 1) },
        ],
        threads: [
          {
            key: "",
            main: true,
            label: null,
            agent_type: null,
            usage: slice(201_000, 4.01, 0.2, 11),
            by_account: [
              {
                account: "eliamarlawoffice",
                usage: slice(200_000, 4, 0.2, 10),
              },
              { account: "__none__", usage: slice(1_000, 0.01, null, 1) },
            ],
          },
          {
            key: "a05be7d5c73c9828a",
            main: false,
            label: "Review the diff",
            agent_type: "general-purpose",
            usage: slice(400_000, 8, 0.4, 20),
            by_account: [
              {
                account: "eliamarlawoffice",
                usage: slice(400_000, 8, 0.4, 20),
              },
            ],
          },
          {
            key: "bbbbbbbbbbbbbbbb",
            main: false,
            label: null,
            agent_type: "Explore",
            usage: slice(300_000, 6, 0.3, 10),
            by_account: [
              {
                account: "jonathanashur@gmail.com",
                usage: slice(300_000, 6, 0.3, 10),
              },
            ],
          },
        ],
      },
      {
        conversation_id: 12,
        title: "Codex refactor",
        agent_type: "codex",
        folder_label: "codeg",
        last_activity_at: "2026-11-23T09:00:00Z",
        usage: slice(500_000, null, null, 0),
        detail: false,
        by_account: [],
        threads: [],
      },
      {
        conversation_id: 13,
        title: "Pi notes",
        agent_type: "pi",
        folder_label: null,
        last_activity_at: "2026-11-23T08:30:00Z",
        usage: slice(200_000, null, null, 0),
        detail: false,
        by_account: [],
        threads: [],
      },
    ],
    indexing: false,
    ...over,
  }
}

const filter: TokenUsageFilter = {
  start: "2026-11-23T00:00:00.000Z",
  end: "2026-11-24T00:00:00.000Z",
  folderIds: null,
  agentTypes: null,
  models: null,
  bucket: "hour",
  tzOffsetMinutes: 0,
}

const fallback: TokenUsageConversationItem[] = [
  {
    conversation_id: 99,
    title: "From the report",
    agent_type: "claude_code",
    folder_label: null,
    total_tokens: 1234,
    turn_count: 3,
    last_activity_at: "2026-11-23T10:00:00Z",
  },
]

const agentLabel = (a: string) =>
  ({ claude_code: "Claude Code", codex: "Codex", pi: "Pi" })[a] ?? a

function panel() {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionUsagePanel
        filter={filter}
        refreshTick={0}
        fallback={fallback}
        agentLabel={agentLabel}
        locale="en"
      />
    </NextIntlClientProvider>
  )
}

const lastQuery = (): TokenUsageSessionsQuery =>
  h.sessions.mock.calls[
    h.sessions.mock.calls.length - 1
  ]?.[0] as TokenUsageSessionsQuery

describe("SessionUsagePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    h.sessions.mockResolvedValue(report())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("expands a Claude session into its main thread and each sub-agent", async () => {
    const user = userEvent.setup()
    render(panel())
    const row = (await screen.findByText("Upstream merge")).closest("li")!
    expect(within(row).getByText("Claude Code · 2 sub-agents")).toBeTruthy()
    expect(within(row).getByText("$18.01")).toBeTruthy()
    expect(within(row).getByText("0.90%")).toBeTruthy()
    expect(screen.queryByText("Main thread")).toBeNull()

    const toggle = within(row).getByRole("button", {
      name: "Show the threads of Upstream merge",
    })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    await user.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    const threads = within(row).getAllByRole("listitem")
    expect(threads.map((t) => t.getAttribute("data-thread"))).toEqual([
      "main",
      "a05be7d5c73c9828a",
      "bbbbbbbbbbbbbbbb",
    ])
    expect(within(threads[0]).getByText("Main thread")).toBeTruthy()
    expect(within(threads[1]).getByText("Review the diff")).toBeTruthy()
    expect(within(threads[1]).getByText("general-purpose")).toBeTruthy()
    expect(within(threads[1]).getByText("$8.00")).toBeTruthy()
    // No description: labelled by its type.
    expect(within(threads[2]).getAllByText("Explore").length).toBeGreaterThan(0)

    await user.click(
      within(row).getByRole("button", {
        name: "Hide the threads of Upstream merge",
      })
    )
    expect(screen.queryByText("Main thread")).toBeNull()
  })

  it("does not offer to expand a Claude session that never delegated", async () => {
    const base = report()
    const solo = {
      ...base.sessions[0],
      conversation_id: 21,
      title: "Solo session",
      threads: [base.sessions[0].threads[0]],
    }
    h.sessions.mockResolvedValue(report({ sessions: [solo] }))
    render(panel())
    const row = (await screen.findByText("Solo session")).closest("li")!
    expect(within(row).queryByRole("button")).toBeNull()
    expect(within(row).getByText("Claude Code")).toBeTruthy()
    expect(within(row).getByText("$18.01")).toBeTruthy()
  })

  it("shows Codex and Pi sessions as totals only: no threads, no price, no share", async () => {
    render(panel())
    for (const title of ["Codex refactor", "Pi notes"]) {
      const row = (await screen.findByText(title)).closest("li")!
      expect(within(row).queryByRole("button")).toBeNull()
      expect(within(row).queryByText(/\$/)).toBeNull()
      expect(within(row).queryByText(/%/)).toBeNull()
    }
    expect(
      within(screen.getByText("Codex refactor").closest("li")!).getByText(
        "500K"
      )
    ).toBeTruthy()
  })

  it("the account switch shows each row's split and legend, and is remembered", async () => {
    const user = userEvent.setup()
    const { unmount } = render(panel())
    await screen.findByText("Upstream merge")
    expect(
      screen.queryByRole("group", { name: "Accounts to count" })
    ).toBeNull()
    expect(screen.queryAllByRole("img")).toHaveLength(0)

    await user.click(screen.getByRole("switch", { name: "Accounts" }))
    const chips = within(
      screen.getByRole("group", { name: "Accounts to count" })
    ).getAllByRole("button")
    expect(chips.map((c) => c.getAttribute("data-account"))).toEqual([
      "eliamarlawoffice",
      "jonathanashur@gmail.com",
      "__none__",
    ])
    expect(chips[0].textContent).toContain("0.60% · $12.00")
    expect(chips[2].textContent).toContain("No pool record")
    // A split bar for the Claude row, none for Codex or Pi.
    const bar = within(
      screen.getByText("Upstream merge").closest("li")!
    ).getByRole("img")
    expect(bar.getAttribute("aria-label")).toContain(
      "eliamarlawoffice · 67% · 0.60% of the week · $12.00"
    )
    expect(
      within(screen.getByText("Codex refactor").closest("li")!).queryByRole(
        "img"
      )
    ).toBeNull()
    expect(window.localStorage.getItem(SPLIT_STORAGE_KEY)).toBe("true")

    unmount()
    render(panel())
    await screen.findByText("Upstream merge")
    expect(
      screen
        .getByRole("switch", { name: "Accounts" })
        .getAttribute("aria-checked")
    ).toBe("true")
  })

  it("an account chip switched off asks for the other accounts only, and stays off", async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(SPLIT_STORAGE_KEY, "true")
    const { unmount } = render(panel())
    const group = await screen.findByRole("group", {
      name: "Accounts to count",
    })
    expect(lastQuery().accounts).toBeNull()

    const chip = within(group).getByRole("button", { name: /eliamarlawoffice/ })
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    await user.click(chip)
    expect(chip.getAttribute("aria-pressed")).toBe("false")
    await waitFor(() =>
      expect(lastQuery().accounts).toEqual([
        "jonathanashur@gmail.com",
        "__none__",
      ])
    )
    expect(
      JSON.parse(window.localStorage.getItem(ACCOUNTS_OFF_STORAGE_KEY)!)
    ).toEqual(["eliamarlawoffice"])

    unmount()
    h.sessions.mockClear()
    render(panel())
    const again = await screen.findByRole("group", {
      name: "Accounts to count",
    })
    expect(
      within(again)
        .getByRole("button", { name: /eliamarlawoffice/ })
        .getAttribute("aria-pressed")
    ).toBe("false")
    await waitFor(() =>
      expect(lastQuery().accounts).toEqual([
        "jonathanashur@gmail.com",
        "__none__",
      ])
    )
  })

  it("off chips only apply while the split is shown", async () => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, "false")
    window.localStorage.setItem(
      ACCOUNTS_OFF_STORAGE_KEY,
      JSON.stringify(["eliamarlawoffice"])
    )
    render(panel())
    await screen.findByText("Upstream merge")
    await waitFor(() => expect(h.sessions).toHaveBeenCalled())
    expect(h.sessions.mock.calls.every((c) => c[0].accounts === null)).toBe(
      true
    )
  })

  it("hides the switch when the server has no pool and no account data", async () => {
    h.sessions.mockResolvedValue(
      report({
        pool: {
          configured: false,
          reachable: false,
          error: null,
          last_pulled_at: null,
          records_since: null,
        },
        accounts: [report().accounts[2]],
      })
    )
    render(panel())
    await screen.findByText("Upstream merge")
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("keeps working when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    const user = userEvent.setup()
    render(panel())
    await screen.findByText("Upstream merge")
    await user.click(screen.getByRole("switch", { name: "Accounts" }))
    expect(
      screen.getByRole("group", { name: "Accounts to count" })
    ).toBeTruthy()
  })

  it("falls back to the report's own list on a server without the session route", async () => {
    h.sessions.mockRejectedValue(new Error("not found"))
    render(panel())
    expect(await screen.findByText("From the report")).toBeTruthy()
  })

  it("asks again while the server is still reading sessions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      h.sessions
        .mockResolvedValueOnce(report({ indexing: true }))
        .mockResolvedValue(report())
      render(panel())
      expect(
        await screen.findByText("Still reading recent Claude sessions…")
      ).toBeTruthy()
      await vi.advanceTimersByTimeAsync(4_100)
      await waitFor(() => expect(h.sessions).toHaveBeenCalledTimes(2))
      await waitFor(() =>
        expect(
          screen.queryByText("Still reading recent Claude sessions…")
        ).toBeNull()
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("account colours and percentages", () => {
  it("each account keeps its slot by name, whatever the order or the filter", () => {
    const accounts = report().accounts
    const a = accountColors(accounts)
    const b = accountColors([...accounts].reverse())
    expect(a.get("eliamarlawoffice")).toBe("var(--tu-acct-1)")
    expect(a.get("jonathanashur@gmail.com")).toBe("var(--tu-acct-2)")
    expect(a.get("__none__")).toBe("var(--tu-acct-none)")
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it("formats shares of a weekly limit", () => {
    expect(formatPct(0)).toBe("0%")
    expect(formatPct(0.004)).toBe("<0.01%")
    expect(formatPct(0.4242)).toBe("0.42%")
    expect(formatPct(12.345)).toBe("12.3%")
  })
})
