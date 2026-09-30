import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ routeId: "conversations", setRoute }),
}))

import { StatusBarPlanUsage } from "./status-bar-plan-usage"
import enMessages from "@/i18n/messages/en.json"

/** The fixed clock the fake timers start from, in epoch seconds. */
const NOW = 1_790_769_600

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

function claude(overrides: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  const at = NOW - 3 * 60
  return {
    agent: "claude_code",
    windows: [
      limit({
        used_percent: 35,
        resets_at: NOW + 2 * 3600 + 56 * 60 + 30,
        observed_at: at,
      }),
      limit({
        id: "seven_day",
        kind: "weekly",
        label: "7d",
        window_minutes: 10080,
        used_percent: 21,
        resets_at: NOW + 3 * 86_400,
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

function codex(overrides: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  const at = NOW - 20 * 60
  return {
    agent: "codex",
    windows: [
      limit({
        id: "primary",
        used_percent: 40,
        resets_at: NOW + 3600,
        observed_at: at,
      }),
      limit({
        id: "secondary",
        kind: "weekly",
        label: "7d",
        window_minutes: 10080,
        used_percent: 99,
        resets_at: NOW + 86_400 + 3600,
        observed_at: at,
      }),
    ],
    plan_label: "Plus",
    status: null,
    observed_at: at,
    source: "transcript",
    ...overrides,
  }
}

function report(snapshots: PlanUsageSnapshot[]): PlanUsageReport {
  return {
    snapshots,
    codex_sessions_dir: "/home/u/.codex/sessions",
    codex_rollouts_found: true,
  }
}

/** Let the mount fetch (a resolved promise) land. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount(props: { compact?: boolean } = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <StatusBarPlanUsage {...props} />
    </NextIntlClientProvider>
  )
  await flush()
}

const trigger = () => screen.getAllByRole("button")[0]
const preview = () =>
  document.querySelector<HTMLElement>('[data-slot="plan-usage-inline-preview"]')
const entry = (agent: string) =>
  preview()?.querySelector<HTMLElement>(`[data-agent="${agent}"]`) ?? null
const bubble = () =>
  document.querySelector<HTMLElement>('[data-slot="hover-card-content"]')

async function hover() {
  fireEvent.pointerEnter(trigger(), { pointerType: "mouse" })
  await flush(400)
}

let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  getPlanUsage.mockReset()
  setRoute.mockReset()
  pushHandler = null
  hidden = false
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
})

afterEach(() => {
  vi.useRealTimers()
  // Back to jsdom's own getter on the prototype.
  delete (document as { hidden?: boolean }).hidden
})

describe("StatusBarPlanUsage inline preview", () => {
  it("shows each provider's tightest window as percent used", async () => {
    getPlanUsage.mockResolvedValue(report([claude(), codex()]))
    await mount()

    expect(preview()).toHaveTextContent("Claude 35%·Codex 99%")
    expect(entry("claude_code")).toHaveAttribute("data-level", "normal")
    expect(entry("codex")).toHaveAttribute("data-level", "critical")
    expect(trigger()).toHaveAccessibleName("Limits: Claude 35%, Codex 99%")
    expect(getPlanUsage).toHaveBeenCalledWith(false)
  })

  it("tints amber from 75% and red from 90% or once the limit is reached", async () => {
    getPlanUsage.mockResolvedValue(
      report([
        claude({
          windows: [limit({ used_percent: 75, resets_at: NOW + 3600 })],
        }),
        codex({
          status: "limited",
          windows: [limit({ id: "primary", used_percent: 60 })],
        }),
      ])
    )
    await mount()

    const amber = entry("claude_code")!
    expect(amber).toHaveAttribute("data-level", "high")
    expect(within(amber).getByText("75%")).toHaveClass("text-amber-600")

    const red = entry("codex")!
    expect(red).toHaveAttribute("data-level", "critical")
    expect(within(red).getByText("60%")).toHaveClass("text-destructive")
  })

  it("dims a stale reading", async () => {
    getPlanUsage.mockResolvedValue(
      report([claude(), codex({ observed_at: NOW - 2 * 3600 })])
    )
    await mount()

    expect(entry("claude_code")).not.toHaveAttribute("data-stale")
    const stale = entry("codex")!
    expect(stale).toHaveAttribute("data-stale", "true")
    expect(stale).toHaveClass("italic")
    expect(trigger()).toHaveAccessibleName(
      "Limits: Claude 35%, Codex 99% (stale)"
    )
  })

  it("leaves out a provider with no reading", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()

    expect(preview()).toHaveTextContent(/^Claude 35%$/)
    expect(entry("codex")).toBeNull()
  })

  it("keeps the plain Limits label with no reading at all", async () => {
    getPlanUsage.mockResolvedValue(report([]))
    await mount()

    expect(preview()).toBeNull()
    expect(trigger()).toHaveTextContent(/^Limits$/)
    expect(trigger()).toHaveAccessibleName("Limits")
  })

  it("shows only the single highest percentage in the compact bar", async () => {
    getPlanUsage.mockResolvedValue(report([claude(), codex()]))
    await mount({ compact: true })

    expect(preview()).toHaveTextContent(/^99%$/)
    expect(entry("claude_code")).toBeNull()
    expect(entry("codex")).toHaveAttribute("data-level", "critical")
    expect(trigger()).toHaveAccessibleName("Limits: Codex 99%")
  })

  it("keeps the bare gauge in the compact bar with no reading", async () => {
    getPlanUsage.mockResolvedValue(report([]))
    await mount({ compact: true })

    expect(preview()).toBeNull()
    expect(trigger().textContent).toBe("")
    expect(trigger()).toHaveAccessibleName(
      "View Claude Code and Codex subscription limits"
    )
  })

  it("opens the full page on click", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()
    fireEvent.click(trigger())
    expect(setRoute).toHaveBeenCalledWith("planUsage")
  })
})

describe("StatusBarPlanUsage hover preview", () => {
  it("lists every window with used, left, reset and the reading age", async () => {
    getPlanUsage.mockResolvedValue(report([claude(), codex()]))
    await mount()
    expect(bubble()).toBeNull()
    await hover()

    const card = within(bubble()!)
    const claudeCard = card.getByRole("region", { name: "Claude Code" })
    expect(within(claudeCard).getByText("Updated 3m ago")).toBeInTheDocument()
    const rows = within(claudeCard).getAllByRole("listitem")
    expect(rows.map((r) => r.getAttribute("data-window"))).toEqual([
      "five_hour",
      "seven_day",
    ])
    const session = within(rows[0])
    expect(session.getByText("5-hour session")).toBeInTheDocument()
    expect(session.getByText("35% used")).toBeInTheDocument()
    expect(session.getByText("65% left")).toBeInTheDocument()
    expect(session.getByText("Resets in 2h 56m")).toBeInTheDocument()
    expect(
      session.getByRole("progressbar", { name: "5-hour session" })
    ).toHaveAttribute("aria-valuenow", "35")

    const codexCard = card.getByRole("region", { name: "Codex" })
    expect(within(codexCard).getByText("Updated 20m ago")).toBeInTheDocument()
    expect(within(codexCard).getByText("99% used")).toBeInTheDocument()
    expect(within(codexCard).queryByText("Stale")).toBeNull()
  })

  it("flags a stale reading and explains a provider with none", async () => {
    getPlanUsage.mockResolvedValue(
      report([codex({ observed_at: NOW - 2 * 3600 })])
    )
    await mount()
    await hover()

    const card = within(bubble()!)
    const codexCard = card.getByRole("region", { name: "Codex" })
    expect(within(codexCard).getByText("Stale")).toBeInTheDocument()
    expect(within(codexCard).getByText("Updated 2h ago")).toBeInTheDocument()
    const claudeCard = card.getByRole("region", { name: "Claude Code" })
    expect(within(claudeCard).getByText("No reading yet")).toBeInTheDocument()
  })

  it("opens the full page from its link and closes", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()
    await hover()

    fireEvent.click(
      within(bubble()!).getByRole("button", { name: "Open full view" })
    )
    expect(setRoute).toHaveBeenCalledWith("planUsage")
    await flush(400)
    expect(bubble()).toBeNull()
  })

  it("opens on keyboard focus but not on a click's focus", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()

    fireEvent.focus(trigger())
    await flush(400)
    expect(bubble()).toBeNull()

    // jsdom never matches `:focus-visible`; stand in for a Tab keypress.
    const original = Element.prototype.matches
    const matches = vi
      .spyOn(Element.prototype, "matches")
      .mockImplementation(function (this: Element, selector: string) {
        return selector === ":focus-visible" || original.call(this, selector)
      })
    try {
      fireEvent.focus(trigger())
      await flush(400)
    } finally {
      matches.mockRestore()
    }
    expect(bubble()).not.toBeNull()
  })
})

describe("StatusBarPlanUsage live updates", () => {
  it("takes Claude readings as they are pushed", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()
    expect(preview()).toHaveTextContent("Claude 35%")

    act(() => {
      pushHandler?.(
        claude({
          observed_at: NOW,
          windows: [limit({ used_percent: 91, resets_at: NOW + 3600 })],
        })
      )
    })
    expect(preview()).toHaveTextContent("Claude 91%")
    expect(entry("claude_code")).toHaveAttribute("data-level", "critical")
  })

  it("refetches every minute while visible and pauses while hidden", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()
    expect(getPlanUsage).toHaveBeenCalledTimes(1)

    await flush(59_000)
    expect(getPlanUsage).toHaveBeenCalledTimes(1)
    getPlanUsage.mockResolvedValue(report([claude(), codex()]))
    await flush(1_000)
    expect(getPlanUsage).toHaveBeenCalledTimes(2)
    expect(preview()).toHaveTextContent("Codex 99%")

    hidden = true
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush(5 * 60_000)
    expect(getPlanUsage).toHaveBeenCalledTimes(2)

    // Shown again long after the last fetch: catch up at once.
    hidden = false
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush()
    expect(getPlanUsage).toHaveBeenCalledTimes(3)
    expect(getPlanUsage).toHaveBeenLastCalledWith(false)
  })

  it("moves the relative times on every minute", async () => {
    getPlanUsage.mockResolvedValue(report([claude()]))
    await mount()
    await hover()
    const claudeCard = within(bubble()!).getByRole("region", {
      name: "Claude Code",
    })
    expect(within(claudeCard).getByText("Resets in 2h 56m")).toBeInTheDocument()

    await flush(60_000)
    expect(within(claudeCard).getByText("Resets in 2h 55m")).toBeInTheDocument()
    expect(within(claudeCard).getByText("Updated 4m ago")).toBeInTheDocument()
  })
})
