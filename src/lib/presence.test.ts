import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./transport", () => ({
  getTransport: () => ({}),
  getShellTransport: () => ({ call: vi.fn(async () => undefined) }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
}))

import {
  HEARTBEAT_MS,
  setShownConversations,
  shownConversations,
  startPresenceReporting,
  type ClientPresence,
} from "./presence"
import { presenceFrame } from "./transport/types"

let focused = true

const last = (sent: ClientPresence[]): ClientPresence | undefined =>
  sent[sent.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused)
  setShownConversations([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("presence reporting", () => {
  it("reports at once, on changes, and on a heartbeat", () => {
    const sent: ClientPresence[] = []
    const stop = startPresenceReporting(shownConversations, (p) => sent.push(p))
    expect(sent).toEqual([
      { visible: true, focused: true, idle_secs: 0, conversation_ids: [] },
    ])

    setShownConversations([42])
    expect(last(sent)?.conversation_ids).toEqual([42])

    focused = false
    window.dispatchEvent(new Event("blur"))
    expect(last(sent)?.focused).toBe(false)

    // Nothing changed: no extra report until the heartbeat.
    const count = sent.length
    window.dispatchEvent(new Event("blur"))
    expect(sent.length).toBe(count)
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(sent.length).toBe(count + 1)
    expect(last(sent)?.idle_secs).toBe(HEARTBEAT_MS / 1000)

    stop()
    vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    expect(sent.length).toBe(count + 1)
  })

  it("reports the first touch after an idle minute right away", () => {
    const sent: ClientPresence[] = []
    const stop = startPresenceReporting(shownConversations, (p) => sent.push(p))
    vi.advanceTimersByTime(90_000)
    const before = sent.length
    window.dispatchEvent(new Event("keydown"))
    expect(sent.length).toBe(before + 1)
    expect(last(sent)?.idle_secs).toBe(0)
    // A second touch right after is only a timestamp.
    window.dispatchEvent(new Event("keydown"))
    expect(sent.length).toBe(before + 1)
    stop()
  })

  it("frames a report for the event socket", () => {
    expect(
      presenceFrame({
        visible: true,
        focused: false,
        idle_secs: 3,
        conversation_ids: [1],
      })
    ).toEqual({
      action: "presence",
      visible: true,
      focused: false,
      idle_secs: 3,
      conversation_ids: [1],
    })
  })
})
