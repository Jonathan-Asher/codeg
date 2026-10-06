import { describe, expect, it, vi } from "vitest"

import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import type { AttachHandlers } from "./types"
import { WebEventStream, type AttachTransportHost } from "./web-event-stream"

function host(): AttachTransportHost & { sent: object[] } {
  const sent: object[] = []
  return {
    sent,
    isWsOpen: () => true,
    sendFrame: (frame) => {
      sent.push(frame)
      return true
    },
    onWsReady: () => () => {},
  }
}

function handlers(order: string[]): AttachHandlers {
  return {
    onSnapshot: vi.fn(() => order.push("snapshot")),
    onReplay: vi.fn(() => order.push("replay")),
    onEvent: vi.fn(() => order.push("event")),
    onDetached: vi.fn(() => order.push("detached")),
    onFrameCut: vi.fn(() => order.push("cut")),
  }
}

describe("WebEventStream frame_cut", () => {
  it("reports a shrunk frame after applying it", () => {
    const stream = new WebEventStream(host())
    const order: string[] = []
    const h = handlers(order)
    const sub = stream.attach("conn-1", {}, h)

    stream.handleServerFrame({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "conn-1",
      snapshot: {} as LiveSessionSnapshot,
      event_seq: 4,
      frame_cut: true,
    })
    stream.handleServerFrame({
      type: "event",
      subscription_id: sub.subscriptionId,
      envelope: { seq: 5 } as EventEnvelope,
      frame_cut: true,
    })

    expect(order).toEqual(["snapshot", "cut", "event", "cut"])
  })

  it("stays quiet for a frame sent whole", () => {
    const stream = new WebEventStream(host())
    const order: string[] = []
    const h = handlers(order)
    const sub = stream.attach("conn-1", {}, h)

    stream.handleServerFrame({
      type: "event",
      subscription_id: sub.subscriptionId,
      envelope: { seq: 1 } as EventEnvelope,
    })

    expect(order).toEqual(["event"])
    expect(h.onFrameCut).not.toHaveBeenCalled()
  })

  it("tolerates handlers that do not listen for it", () => {
    const stream = new WebEventStream(host())
    const onEvent = vi.fn()
    const sub = stream.attach(
      "conn-1",
      {},
      {
        onSnapshot: vi.fn(),
        onReplay: vi.fn(),
        onEvent,
        onDetached: vi.fn(),
      }
    )

    expect(() =>
      stream.handleServerFrame({
        type: "event",
        subscription_id: sub.subscriptionId,
        envelope: { seq: 1 } as EventEnvelope,
        frame_cut: true,
      })
    ).not.toThrow()
    expect(onEvent).toHaveBeenCalledTimes(1)
  })
})
