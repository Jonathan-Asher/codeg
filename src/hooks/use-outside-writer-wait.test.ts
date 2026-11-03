import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  acpOutsideWriterStatus: vi.fn(),
}))

import { acpOutsideWriterStatus, type AcpOutsideWriterStatus } from "@/lib/api"
import {
  OUTSIDE_WRITER_POLL_MAX_MS,
  OUTSIDE_WRITER_POLL_MS,
} from "@/lib/outside-writer"
import {
  outsideWriterFor,
  reportOutsideWriter,
  useOutsideWriterStore,
} from "@/stores/outside-writer-store"
import { useOutsideWriterWait } from "./use-outside-writer-wait"

const status = vi.mocked(acpOutsideWriterStatus)
const WORKER = { pid: 4242, startedAt: 1_793_616_490_351 }

function running(len: number): AcpOutsideWriterStatus {
  return { writer: WORKER, transcript: { len, modifiedMs: len } }
}

function finished(len: number): AcpOutsideWriterStatus {
  return { writer: null, transcript: { len, modifiedMs: len } }
}

/** Let the pending ask settle, then move the clock to the next one. */
async function nextAsk(ms = OUTSIDE_WRITER_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  status.mockReset()
  reportOutsideWriter("s1", WORKER)
})

afterEach(() => {
  vi.useRealTimers()
  useOutsideWriterStore.setState({ bySession: {} })
})

describe("useOutsideWriterWait", () => {
  it("keeps asking while the process runs, and lets the tab connect once it is gone", async () => {
    status
      .mockResolvedValueOnce(running(10))
      .mockResolvedValueOnce(running(10))
      .mockResolvedValueOnce(finished(10))
    renderHook(() =>
      useOutsideWriterWait({
        agentType: "claude_code",
        sessionId: "s1",
        enabled: true,
      })
    )
    await nextAsk(0)
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenLastCalledWith("claude_code", "s1")
    expect(outsideWriterFor("s1")?.phase).toBe("waiting")

    await nextAsk()
    expect(status).toHaveBeenCalledTimes(2)
    expect(outsideWriterFor("s1")).toBeDefined()

    await nextAsk()
    expect(status).toHaveBeenCalledTimes(3)
    // Gone from the store: the connect hold lifts, and the tab connects.
    expect(outsideWriterFor("s1")).toBeUndefined()

    await nextAsk()
    await nextAsk()
    expect(status).toHaveBeenCalledTimes(3)
  })

  it("re-reads the transcript each time the other process wrote to it", async () => {
    status
      .mockResolvedValueOnce(running(10))
      .mockResolvedValueOnce(running(10))
      .mockResolvedValueOnce(running(25))
      .mockResolvedValueOnce(finished(40))
    const onTranscriptChanged = vi.fn()
    renderHook(() =>
      useOutsideWriterWait({
        agentType: "claude_code",
        sessionId: "s1",
        enabled: true,
        onTranscriptChanged,
      })
    )
    await nextAsk(0)
    await nextAsk()
    expect(onTranscriptChanged).not.toHaveBeenCalled()
    await nextAsk()
    expect(onTranscriptChanged).toHaveBeenCalledTimes(1)
    // Its last turns as well, before the tab connects.
    await nextAsk()
    expect(onTranscriptChanged).toHaveBeenCalledTimes(2)
    expect(outsideWriterFor("s1")).toBeUndefined()
  })

  it("takes the process's latest details while it runs on", async () => {
    status.mockResolvedValue({
      writer: { ...WORKER, status: "idle" },
      transcript: null,
    })
    renderHook(() =>
      useOutsideWriterWait({
        agentType: "claude_code",
        sessionId: "s1",
        enabled: true,
      })
    )
    await nextAsk(0)
    expect(outsideWriterFor("s1")?.writer.status).toBe("idle")
  })

  it("asks nothing for a session the user is not waiting on", async () => {
    status.mockResolvedValue(finished(10))
    const { rerender } = renderHook(
      ({ enabled }) =>
        useOutsideWriterWait({
          agentType: "claude_code",
          sessionId: "s1",
          enabled,
        }),
      { initialProps: { enabled: false } }
    )
    await nextAsk(0)
    await nextAsk()
    expect(status).not.toHaveBeenCalled()
    expect(outsideWriterFor("s1")).toBeDefined()

    // Waiting again (the tab came back to the front): it asks at once.
    rerender({ enabled: true })
    await nextAsk(0)
    expect(status).toHaveBeenCalledTimes(1)
    expect(outsideWriterFor("s1")).toBeUndefined()
  })

  it("stops asking when the user stops waiting", async () => {
    status.mockResolvedValue(running(10))
    const { rerender } = renderHook(
      ({ enabled }) =>
        useOutsideWriterWait({
          agentType: "claude_code",
          sessionId: "s1",
          enabled,
        }),
      { initialProps: { enabled: true } }
    )
    await nextAsk(0)
    expect(status).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    await nextAsk()
    await nextAsk()
    expect(status).toHaveBeenCalledTimes(1)
  })

  it("spaces out asks that fail, and keeps the wait", async () => {
    status.mockRejectedValue(new Error("link down"))
    renderHook(() =>
      useOutsideWriterWait({
        agentType: "claude_code",
        sessionId: "s1",
        enabled: true,
      })
    )
    await nextAsk(0)
    expect(status).toHaveBeenCalledTimes(1)
    await nextAsk(OUTSIDE_WRITER_POLL_MS)
    expect(status).toHaveBeenCalledTimes(1)
    await nextAsk(OUTSIDE_WRITER_POLL_MS)
    expect(status).toHaveBeenCalledTimes(2)
    await nextAsk(OUTSIDE_WRITER_POLL_MAX_MS)
    expect(status).toHaveBeenCalledTimes(3)
    expect(outsideWriterFor("s1")?.phase).toBe("waiting")
  })
})
