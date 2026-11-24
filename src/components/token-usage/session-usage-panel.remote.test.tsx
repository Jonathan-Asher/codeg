import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { TokenUsageSessionsReport } from "@/lib/types"
import { SessionUsagePanel } from "./session-usage-panel"

// A window bound to a remote codeg server (the box window on the Mac): every
// call goes through the remote transport, so the panel shows the remote
// server's sessions and the remote server's pool. The real `@/lib/api` runs;
// only the transport underneath it is replaced.
const h = vi.hoisted(() => ({
  calls: [] as { command: string; args: unknown }[],
  answer: null as unknown,
}))

vi.mock("@/lib/transport", () => {
  const remote = {
    call: async (command: string, args: unknown) => {
      h.calls.push({ command, args })
      if (command === "token_usage_sessions") return h.answer
      throw new Error(`unexpected ${command}`)
    },
  }
  return {
    getTransport: () => remote,
    getShellTransport: () => remote,
    getActiveRemoteConnectionId: () => 7,
    getServerBaseUrl: () => "http://box.tail:3080",
    isDesktop: () => true,
    isRemoteDesktopMode: () => true,
    notifyRemoteDesktopUnauthorized: () => {},
  }
})

const boxReport: TokenUsageSessionsReport = {
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
      usage: { tokens: 1000, cost_usd: 1.5, pct: 0.08, calls: 3 },
      pool_cost_usd: 30,
      pool_pct: 1.5,
      pool_calls: 40,
      pool_metered_pct: 1,
      usd_per_pct: 20,
      usd_per_pct_measured: true,
    },
  ],
  sessions: [
    {
      conversation_id: 501,
      title: "Box session",
      agent_type: "claude_code",
      folder_label: "legalix",
      last_activity_at: "2026-11-23T10:00:00Z",
      usage: { tokens: 1000, cost_usd: 1.5, pct: 0.08, calls: 3 },
      detail: true,
      by_account: [
        {
          account: "eliamarlawoffice",
          usage: { tokens: 1000, cost_usd: 1.5, pct: 0.08, calls: 3 },
        },
      ],
      threads: [
        {
          key: "",
          main: true,
          label: null,
          agent_type: null,
          usage: { tokens: 1000, cost_usd: 1.5, pct: 0.08, calls: 3 },
          by_account: [],
        },
      ],
    },
  ],
  indexing: false,
}

describe("SessionUsagePanel in a remote window", () => {
  beforeEach(() => {
    h.calls = []
    h.answer = boxReport
    window.localStorage.clear()
  })

  it("asks the bound server for its sessions and shows them with its pool's accounts", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SessionUsagePanel
          filter={{ bucket: "day", tzOffsetMinutes: 120 }}
          refreshTick={0}
          fallback={[]}
          agentLabel={(a) => a}
          locale="en"
        />
      </NextIntlClientProvider>
    )
    const row = (await screen.findByText("Box session")).closest("li")!
    expect(within(row).getByText("$1.50")).toBeTruthy()
    expect(h.calls).toEqual([
      {
        command: "token_usage_sessions",
        args: {
          query: {
            filter: { bucket: "day", tzOffsetMinutes: 120 },
            accounts: null,
            limit: 8,
          },
        },
      },
    ])
    await user.click(screen.getByRole("switch", { name: "Accounts" }))
    expect(
      within(
        screen.getByRole("group", { name: "Accounts to count" })
      ).getByRole("button", { name: /eliamarlawoffice/ })
    ).toBeTruthy()
  })
})
