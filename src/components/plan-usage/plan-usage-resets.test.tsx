import type { ReactNode } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  LimitResetItem,
  ProviderLimitResets,
  UseLimitResetResult,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  consumeLimitReset: vi.fn(),
  continueLimitNow: vi.fn(),
  getLimitResets: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  consumeLimitReset: h.consumeLimitReset,
  continueLimitNow: h.continueLimitNow,
  getLimitResets: h.getLimitResets,
}))

const openInSystemBrowser = vi.hoisted(() => vi.fn())
vi.mock("@/lib/link-open", () => ({ openInSystemBrowser }))

import { resetLimitResetsCacheForTests } from "@/hooks/use-limit-resets"

import {
  ClaudeResetsElsewhere,
  ProviderResetsSection,
} from "./plan-usage-resets"

const R = enMessages.PlanUsage.resets
/** 2026-11-12T18:00:00Z. */
const NOW = 1_794_506_400

function item(over: Partial<LimitResetItem> = {}): LimitResetItem {
  return {
    id: "credit-soon",
    kind: "full",
    label: "Full reset",
    description: "Thanks for using Codex!",
    count: 1,
    expires_at: Date.UTC(2026, 10, 30, 12) / 1000,
    ...over,
  }
}

function codexResets(
  over: Partial<ProviderLimitResets> = {}
): ProviderLimitResets {
  return {
    provider: "codex",
    available: 2,
    items: [
      item(),
      item({ id: "credit-late", expires_at: Date.UTC(2026, 11, 1, 12) / 1000 }),
    ],
    source: "codex_app_server",
    account: "me@example.com",
    error: null,
    fetched_at: NOW,
    ...over,
  }
}

function used(over: Partial<UseLimitResetResult> = {}): UseLimitResetResult {
  return {
    provider: "codex",
    outcome: "reset",
    resets: codexResets({ available: 1, items: [item({ id: "credit-late" })] }),
    paused_conversations: [],
    continued: null,
    ...over,
  }
}

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  resetLimitResetsCacheForTests()
  h.consumeLimitReset.mockReset()
  h.continueLimitNow.mockReset().mockResolvedValue(true)
  h.getLimitResets.mockReset().mockResolvedValue({ providers: [] })
})

afterEach(() => cleanup())

describe("ProviderResetsSection", () => {
  it("shows how many resets are left and until when, one row per kind", () => {
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
      />
    )
    expect(screen.getByText(R.title)).toBeInTheDocument()
    expect(screen.getByTestId("limit-resets-available")).toHaveTextContent(
      "2 resets available · first expires Nov 30"
    )
    expect(screen.getByText("For me@example.com")).toBeInTheDocument()
    // Codex's two identical credits fold into one row.
    const rows = screen.getAllByRole("listitem")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("Full reset×2")
    expect(rows[0]).toHaveTextContent("Expires Nov 30")
    expect(screen.getByTestId("limit-reset-use")).toBeEnabled()
  })

  it("asks first, and a cancel uses nothing", () => {
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
      />
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    const dialog = screen.getByTestId("limit-reset-confirm")
    expect(dialog).toHaveTextContent(R.confirm.title)
    expect(dialog).toHaveTextContent(
      "Use 1 of 2 resets? This refills all your usage limits now. It can't be undone."
    )
    expect(dialog).toHaveTextContent("Full reset")
    fireEvent.click(within(dialog).getByText(R.confirm.cancel))
    expect(screen.queryByTestId("limit-reset-confirm")).toBeNull()
    expect(h.consumeLimitReset).not.toHaveBeenCalled()
  })

  it("uses the reset that expires first, shows it going, then what came of it", async () => {
    const answer = deferred<UseLimitResetResult>()
    h.consumeLimitReset.mockReturnValue(answer.promise)
    const onUsed = vi.fn()
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
        onUsed={onUsed}
      />
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))

    expect(h.consumeLimitReset).toHaveBeenCalledWith({
      provider: "codex",
      id: "credit-soon",
      conversationId: undefined,
    })
    const button = screen.getByTestId("limit-reset-use")
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(R.using)

    await act(async () => answer.resolve(used()))
    const status = await screen.findByRole("status")
    expect(status).toHaveAttribute("data-tone", "success")
    expect(status).toHaveTextContent(`${R.outcome.reset} 1 reset left.`)
    expect(onUsed).toHaveBeenCalledWith(used())
    expect(screen.getByTestId("limit-reset-use")).toHaveTextContent(R.use)
  })

  it("says plainly when nothing was used, or when the answer never came", async () => {
    h.consumeLimitReset.mockResolvedValueOnce(
      used({ outcome: "nothing_to_reset", resets: null })
    )
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
      />
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))
    const nothing = await screen.findByRole("status")
    expect(nothing).toHaveAttribute("data-tone", "info")
    expect(nothing).toHaveTextContent(R.outcome.nothingToReset)

    h.consumeLimitReset.mockResolvedValueOnce(
      used({ outcome: "unconfirmed", resets: null })
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning")
    )
    expect(screen.getByRole("status")).toHaveTextContent(R.outcome.unconfirmed)
  })

  it("maps a failed use to its words", async () => {
    h.consumeLimitReset.mockRejectedValue({
      code: "invalid_input",
      message: "A reset is already being used for this account.",
      i18n_key: "resets.error.busy",
    })
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
      />
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))
    const status = await screen.findByRole("status")
    expect(status).toHaveAttribute("data-tone", "error")
    expect(status).toHaveTextContent(R.error.busy)
  })

  it("offers to continue the sessions paused at the limit once a reset lands", async () => {
    h.consumeLimitReset.mockResolvedValue(
      used({ paused_conversations: [5, 6] })
    )
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets()}
        loading={false}
        now={NOW}
      />
    )
    fireEvent.click(screen.getByTestId("limit-reset-use"))
    fireEvent.click(screen.getByTestId("limit-reset-confirm-use"))
    expect(
      await screen.findByText(
        "2 sessions paused at the limit can continue now."
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("limit-reset-continue-paused"))
    expect(
      await screen.findByText("Continuing 2 sessions.")
    ).toBeInTheDocument()
    expect(h.continueLimitNow).toHaveBeenCalledWith(5)
    expect(h.continueLimitNow).toHaveBeenCalledWith(6)
  })

  it("points Claude's own resets to its apps: claude.ai and /limit-reset", () => {
    openInSystemBrowser.mockReset().mockResolvedValue(undefined)
    wrap(<ClaudeResetsElsewhere />)
    expect(screen.getByText(R.claude.elsewhere)).toBeInTheDocument()
    expect(screen.getByText("/limit-reset").tagName).toBe("CODE")
    expect(screen.queryByTestId("limit-reset-use")).toBeNull()
    fireEvent.click(screen.getByTestId("claude-resets-open"))
    expect(openInSystemBrowser).toHaveBeenCalledWith(
      "https://claude.ai/settings/usage"
    )
    expect(h.getLimitResets).not.toHaveBeenCalled()
    expect(h.consumeLimitReset).not.toHaveBeenCalled()
  })

  it("says nothing for an agent that isn't installed, and waits quietly", () => {
    const { container, rerender } = wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets({
          available: 0,
          items: [],
          error: { code: "not_installed", message: "x" },
        })}
        loading={false}
        now={NOW}
      />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ProviderResetsSection agent="codex" resets={null} loading now={NOW} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText(R.checking)).toBeInTheDocument()
  })

  it("lists none without an error when the provider has none", () => {
    wrap(
      <ProviderResetsSection
        agent="codex"
        resets={codexResets({ available: 0, items: [] })}
        loading={false}
        now={NOW}
      />
    )
    expect(screen.getByTestId("limit-resets-available")).toHaveTextContent(
      R.none
    )
    expect(screen.queryByRole("listitem")).toBeNull()
  })
})
