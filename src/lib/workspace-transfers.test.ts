import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(async () => true),
}))

vi.mock("./transport", () => ({
  // Not a desktop runtime: no Tauri event listener is attached in tests.
  isDesktop: () => false,
  getShellTransport: () => ({ call: mocks.call }),
}))

import {
  __resetWorkspaceTransfersForTests,
  applyTransferProgress,
  beginTrackedDownload,
  cancelTrackedDownload,
  completeTrackedDownload,
  dismissTrackedTransfer,
  failTrackedDownload,
  getTransfersSnapshot,
  isTransferErrorReported,
  markTransferErrorReported,
  newTransferId,
  wasCancelRequested,
} from "./workspace-transfers"

const MB = 1024 * 1024

function progress(
  loaded: number,
  total: number | null,
  state: "running" | "done" | "cancelled" | "error" = "running",
  transferId = "dl-1"
) {
  return {
    transferId,
    direction: "download" as const,
    loaded,
    total,
    state,
    path: "/Users/me/Downloads/big.mov",
    error: state === "error" ? "boom" : null,
  }
}

beforeEach(() => {
  __resetWorkspaceTransfersForTests()
  mocks.call.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("workspace transfer store", () => {
  it("tracks a download from start to done", () => {
    beginTrackedDownload({
      id: "dl-1",
      name: "big.mov",
      savePath: "/Users/me/Downloads/big.mov",
    })
    expect(getTransfersSnapshot()).toMatchObject([
      { id: "dl-1", status: "running", loaded: 0, total: null },
    ])

    applyTransferProgress(progress(0, 100 * MB), 0)
    applyTransferProgress(progress(10 * MB, 100 * MB), 1000)
    const running = getTransfersSnapshot()[0]
    expect(running.loaded).toBe(10 * MB)
    expect(running.total).toBe(100 * MB)
    expect(running.rate).toBe(10 * MB)

    completeTrackedDownload("dl-1", 100 * MB)
    expect(getTransfersSnapshot()[0]).toMatchObject({
      status: "done",
      loaded: 100 * MB,
      rate: null,
    })
  })

  it("ignores other windows' transfers, uploads and late events", () => {
    beginTrackedDownload({ id: "dl-1", name: "a.mp4", savePath: null })
    applyTransferProgress(progress(5, 10, "running", "someone-else"))
    applyTransferProgress({ ...progress(5, 10), direction: "upload" })
    expect(getTransfersSnapshot()[0].loaded).toBe(0)

    completeTrackedDownload("dl-1", 10)
    applyTransferProgress(progress(3, 10))
    expect(getTransfersSnapshot()[0]).toMatchObject({
      status: "done",
      loaded: 10,
    })
  })

  it("keeps a failure on screen with its reason", () => {
    beginTrackedDownload({ id: "dl-1", name: "a.mp4", savePath: null })
    applyTransferProgress(progress(0, null, "error"))
    expect(getTransfersSnapshot()[0]).toMatchObject({
      status: "error",
      error: "boom",
    })
    failTrackedDownload("dl-1", "")
    expect(getTransfersSnapshot()[0].error).toBe("boom")
  })

  it("asks the local Rust side to cancel, once", async () => {
    beginTrackedDownload({ id: "dl-1", name: "a.mp4", savePath: null })
    await cancelTrackedDownload("dl-1")
    expect(mocks.call).toHaveBeenCalledWith(
      "remote_cancel_workspace_transfer",
      { transferId: "dl-1" }
    )
    expect(wasCancelRequested("dl-1")).toBe(true)

    applyTransferProgress(progress(0, null, "cancelled"))
    expect(getTransfersSnapshot()[0].status).toBe("cancelled")
    // Nothing left to cancel.
    await cancelTrackedDownload("dl-1")
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it("drops a finished row after a minute, or when dismissed", () => {
    vi.useFakeTimers()
    beginTrackedDownload({ id: "dl-1", name: "a.mp4", savePath: null })
    beginTrackedDownload({ id: "dl-2", name: "b.mp4", savePath: null })
    completeTrackedDownload("dl-1", 1)
    vi.advanceTimersByTime(61_000)
    expect(getTransfersSnapshot().map((t) => t.id)).toEqual(["dl-2"])
    dismissTrackedTransfer("dl-2")
    expect(getTransfersSnapshot()).toEqual([])
  })

  it("mints ids the Rust side accepts", () => {
    const id = newTransferId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(newTransferId()).not.toBe(id)
  })

  it("tags errors the transfer UI already reported", () => {
    const plain = { code: "network_error", message: "Remote returned HTTP 500" }
    expect(isTransferErrorReported(plain)).toBe(false)
    const tagged = markTransferErrorReported(plain)
    expect(tagged).toBe(plain)
    expect(isTransferErrorReported(tagged)).toBe(true)
    expect(isTransferErrorReported(markTransferErrorReported("text"))).toBe(
      true
    )
    expect(isTransferErrorReported(null)).toBe(false)
  })
})
