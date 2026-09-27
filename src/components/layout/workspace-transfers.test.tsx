import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => {}),
  dismiss: vi.fn(),
  reveal: vi.fn(async () => {}),
  open: vi.fn(async () => {}),
  isDesktop: vi.fn(() => true),
}))

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () =>
    (key: string, params?: Record<string, unknown>): string =>
      params ? `${key}(${JSON.stringify(params)})` : key,
}))
vi.mock("sonner", () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: mocks.isDesktop,
  revealLocalItemInDir: mocks.reveal,
  openLocalPath: mocks.open,
}))
vi.mock("@/lib/workspace-transfers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workspace-transfers")>()
  return {
    ...actual,
    cancelTrackedDownload: mocks.cancel,
    dismissTrackedTransfer: mocks.dismiss,
  }
})

import type { TrackedTransfer } from "@/lib/workspace-transfers"
import { TransferCard } from "./workspace-transfers"

const MB = 1024 * 1024
const GB = 1024 * MB

function transfer(overrides: Partial<TrackedTransfer>): TrackedTransfer {
  return {
    id: "dl-1",
    name: "talk.mov",
    savePath: "/Users/me/Downloads/talk.mov",
    loaded: 0,
    total: null,
    status: "running",
    error: null,
    rate: null,
    startedAt: 0,
    finishedAt: null,
    cancelRequested: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDesktop.mockReturnValue(true)
})
afterEach(() => cleanup())

describe("TransferCard", () => {
  it("shows name, percentage, bytes, speed and time left while running", () => {
    render(
      <TransferCard
        transfer={transfer({ loaded: 1.5 * GB, total: 3 * GB, rate: 10 * MB })}
      />
    )
    expect(screen.getByText("talk.mov")).toBeTruthy()
    expect(screen.getByText("50%")).toBeTruthy()
    const line = screen.getByText(/progress\(/)
    expect(line.textContent).toContain('"loaded":"1.5 GB"')
    expect(line.textContent).toContain('"total":"3.0 GB"')
    expect(line.textContent).toContain("10.0 MB/s")
    // 1.5 GB at 10 MB/s ≈ 154 s → "3 min".
    expect(line.textContent).toContain('timeLeft({"time":"3 min"})')
    expect(screen.getByRole("progressbar")).toBeTruthy()
  })

  it("cancels on request and says so", () => {
    const { rerender } = render(
      <TransferCard transfer={transfer({ loaded: 10, total: 100 })} />
    )
    fireEvent.click(screen.getByText("cancel"))
    expect(mocks.cancel).toHaveBeenCalledWith("dl-1")
    rerender(
      <TransferCard
        transfer={transfer({ loaded: 10, total: 100, cancelRequested: true })}
      />
    )
    expect(screen.getByText("cancelling")).toBeTruthy()
  })

  it("reads 'starting' before the first byte, and bytes-only without a total", () => {
    const { rerender } = render(<TransferCard transfer={transfer({})} />)
    expect(screen.getByText(/preparing/)).toBeTruthy()
    rerender(<TransferCard transfer={transfer({ loaded: 2 * MB })} />)
    expect(screen.getByText(/progressNoTotal/).textContent).toContain("2.0 MB")
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it("offers Show and Open for a finished download on this machine", () => {
    render(
      <TransferCard
        transfer={transfer({ status: "done", loaded: 3 * GB, total: 3 * GB })}
      />
    )
    expect(screen.getByText("done")).toBeTruthy()
    expect(screen.getByText(/3\.0 GB/).textContent).toContain(
      "/Users/me/Downloads/talk.mov"
    )
    fireEvent.click(screen.getByText(/^showIn/))
    expect(mocks.reveal).toHaveBeenCalledWith("/Users/me/Downloads/talk.mov")
    fireEvent.click(screen.getByText("open"))
    expect(mocks.open).toHaveBeenCalledWith("/Users/me/Downloads/talk.mov")
    expect(screen.queryByText("cancel")).toBeNull()
  })

  it("keeps the reason of a failure visible", () => {
    const onClose = vi.fn()
    render(
      <TransferCard
        transfer={transfer({
          status: "error",
          error: "Remote download stalled: no data received",
        })}
        onClose={onClose}
      />
    )
    expect(screen.getByText("failed")).toBeTruthy()
    expect(
      screen.getByText("Remote download stalled: no data received")
    ).toBeTruthy()
    fireEvent.click(screen.getByLabelText("dismiss"))
    expect(onClose).toHaveBeenCalled()
  })
})
