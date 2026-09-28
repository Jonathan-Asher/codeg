/**
 * The resume-after-restart toast: raised from the batch a client reads on
 * connect or from the live status event, lists each session with where it
 * stands, and offers Stop while resumes are still waiting. A client that
 * connects after every resume settled shows nothing, and a closed toast stays
 * closed for its batch.
 */
import type { ReactElement } from "react"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AutoResumeItem, AutoResumeStatus } from "@/lib/types"

const getStatus = vi.fn<() => Promise<AutoResumeStatus>>()
const stop = vi.fn<() => Promise<AutoResumeStatus>>()
const custom = vi.fn()
const dismiss = vi.fn()
const toastError = vi.fn()
const openTab = vi.fn()
let emit: ((status: AutoResumeStatus) => void) | null = null

vi.mock("@/lib/api", () => ({
  getAutoResumeStatus: () => getStatus(),
  stopAutoResume: () => stop(),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: async (
      _event: string,
      handler: (status: AutoResumeStatus) => void
    ) => {
      emit = handler
      return () => {
        emit = null
      }
    },
  }),
}))
vi.mock("sonner", () => ({
  toast: {
    custom: (...args: unknown[]) => custom(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: { getState: () => ({ openTab }) },
}))

import { AUTO_RESUME_TOAST_ID, AutoResumeToasts } from "./auto-resume-toasts"

const L = enMessages.AutoResume

function item(
  conversation_id: number,
  title: string | null,
  state: AutoResumeItem["state"],
  error: string | null = null
): AutoResumeItem {
  return {
    conversation_id,
    folder_id: 7,
    agent_type: "claude_code",
    title,
    state,
    error,
  }
}

function batch(
  items: AutoResumeItem[],
  extra: Partial<AutoResumeStatus> = {}
): AutoResumeStatus {
  return {
    started_at: "2026-09-28T10:00:00Z",
    items,
    stopped: false,
    ...extra,
  }
}

const EMPTY: AutoResumeStatus = { started_at: null, items: [], stopped: false }

function withIntl(node: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

/** Mount the raiser and let its initial load and subscription settle. */
async function mount() {
  render(withIntl(<AutoResumeToasts />))
  await act(async () => {})
}

/** Render the body of the latest raised toast, as sonner would. */
function renderLatestToast() {
  const call = custom.mock.calls[custom.mock.calls.length - 1]
  if (!call) throw new Error("no toast raised")
  const [body, options] = call as [
    (id: string) => ReactElement,
    { id: string; duration: number },
  ]
  const view = render(withIntl(body(options.id)))
  return { view, options }
}

beforeEach(() => {
  getStatus.mockReset()
  stop.mockReset()
  custom.mockReset()
  dismiss.mockReset()
  toastError.mockReset()
  openTab.mockReset()
  emit = null
})
afterEach(() => cleanup())

describe("AutoResumeToasts", () => {
  it("raises the batch a client reads on connect, with Stop while resumes wait", async () => {
    getStatus.mockResolvedValue(
      batch([
        item(1, "Refactor the parser", "resuming"),
        item(2, "Write the migration", "pending"),
        item(3, null, "pending"),
      ])
    )
    await mount()

    expect(custom).toHaveBeenCalledTimes(1)
    const { options } = renderLatestToast()
    expect(options).toEqual({ id: AUTO_RESUME_TOAST_ID, duration: Infinity })
    expect(
      screen.getByText("Resuming 3 sessions interrupted by the restart")
    ).toBeInTheDocument()
    const rows = document.querySelectorAll<HTMLElement>(
      "[data-auto-resume-item]"
    )
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText("Refactor the parser")).toBeInTheDocument()
    expect(within(rows[0]).getByText(L.stateResuming)).toBeInTheDocument()
    expect(within(rows[1]).getByText(L.statePending)).toBeInTheDocument()
    expect(within(rows[2]).getByText(L.untitled)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: L.stop })).toBeInTheDocument()
  })

  it("stops the pending resumes and shows the stopped batch", async () => {
    const user = userEvent.setup()
    getStatus.mockResolvedValue(
      batch([item(1, "a", "resuming"), item(2, "b", "pending")])
    )
    stop.mockResolvedValue(
      batch([item(1, "a", "resuming"), item(2, "b", "stopped")], {
        stopped: true,
      })
    )
    await mount()
    renderLatestToast()

    await user.click(screen.getByRole("button", { name: L.stop }))
    expect(stop).toHaveBeenCalledTimes(1)

    cleanup()
    const { options } = renderLatestToast()
    expect(options.id).toBe(AUTO_RESUME_TOAST_ID)
    expect(screen.getByText(L.stoppedTitle)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: L.stop })).toBeNull()
    expect(screen.getByText(L.stateStopped)).toBeInTheDocument()
  })

  it("follows the live status event and lets the settled toast expire", async () => {
    getStatus.mockResolvedValue(EMPTY)
    await mount()
    expect(custom).not.toHaveBeenCalled()

    await act(async () => {
      emit?.(batch([item(1, "a", "pending"), item(2, "b", "pending")]))
    })
    expect(custom).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit?.(
        batch([
          item(1, "a", "resumed"),
          item(2, "b", "failed", "the agent could not reopen the session"),
        ])
      )
    })
    const { options } = renderLatestToast()
    expect(options.duration).toBeLessThan(Infinity)
    expect(screen.getByText(L.settledTitle)).toBeInTheDocument()
    expect(screen.getByText(L.stateResumed)).toBeInTheDocument()
    const failed = screen.getByText(L.stateFailed)
    expect(failed.getAttribute("title")).toContain(
      "the agent could not reopen the session"
    )
    expect(screen.queryByRole("button", { name: L.stop })).toBeNull()
  })

  it("shows nothing to a client that connects after every resume settled", async () => {
    getStatus.mockResolvedValue(
      batch([item(1, "a", "resumed"), item(2, "b", "skipped")])
    )
    await mount()
    expect(custom).not.toHaveBeenCalled()
  })

  it("keeps a closed toast closed for its batch", async () => {
    const user = userEvent.setup()
    getStatus.mockResolvedValue(batch([item(1, "a", "pending")]))
    await mount()
    renderLatestToast()

    await user.click(screen.getByRole("button", { name: L.dismiss }))
    expect(dismiss).toHaveBeenCalledWith(AUTO_RESUME_TOAST_ID)

    await act(async () => {
      emit?.(batch([item(1, "a", "resuming")]))
    })
    expect(custom).toHaveBeenCalledTimes(1)
  })

  it("opens a session from its row", async () => {
    const user = userEvent.setup()
    getStatus.mockResolvedValue(batch([item(4, "Open me", "resumed")]))
    getStatus.mockResolvedValueOnce(batch([item(4, "Open me", "pending")]))
    await mount()
    renderLatestToast()

    await user.click(screen.getByRole("button", { name: "Open me" }))
    expect(openTab).toHaveBeenCalledWith(7, 4, "claude_code", true)
  })
})
