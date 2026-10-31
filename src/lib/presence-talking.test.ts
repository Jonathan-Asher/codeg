import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reportPresence = vi.fn()
const shellCall = vi.fn(async () => undefined)
let remote = false

vi.mock("./transport", () => ({
  getTransport: () => ({ reportPresence }),
  getShellTransport: () => ({ call: shellCall }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => remote,
}))

import {
  setShownConversations,
  setTalkingConversation,
  shownConversations,
  startPresenceReporting,
  talkingConversation,
  type ClientPresence,
} from "./presence"

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, "hasFocus").mockImplementation(() => true)
  setShownConversations([])
  setTalkingConversation(null)
  reportPresence.mockClear()
  shellCall.mockClear()
  remote = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const lastSocketReport = (): ClientPresence =>
  reportPresence.mock.calls[reportPresence.mock.calls.length - 1][0]

const lastLocalReport = (): ClientPresence => {
  const calls = shellCall.mock.calls as unknown as [
    string,
    { presence: ClientPresence },
  ][]
  return calls[calls.length - 1][1].presence
}

describe("presence while talking (Talk on this Mac)", () => {
  it("names only the session talked with, with talking, and goes out at once", () => {
    const sent: ClientPresence[] = []
    const stop = startPresenceReporting(shownConversations, (p) => sent.push(p))
    setShownConversations([7])
    expect(sent[sent.length - 1]).toEqual({
      visible: true,
      focused: true,
      idle_secs: 0,
      conversation_ids: [7],
    })

    setTalkingConversation(42)
    expect(talkingConversation()).toBe(42)
    expect(sent[sent.length - 1]).toEqual({
      visible: true,
      focused: true,
      idle_secs: 0,
      conversation_ids: [42],
      talking: true,
    })

    setTalkingConversation(null)
    expect(sent[sent.length - 1].talking).toBeUndefined()
    expect(sent[sent.length - 1].conversation_ids).toEqual([7])
    stop()
  })

  it("tells a remote server it is talking, never the local backend", () => {
    remote = true
    const stop = startPresenceReporting(shownConversations)
    setTalkingConversation(42)
    expect(lastSocketReport()).toMatchObject({
      conversation_ids: [42],
      talking: true,
    })
    expect(lastLocalReport()).toEqual({
      visible: true,
      focused: true,
      idle_secs: 0,
      conversation_ids: [],
    })
    stop()
  })

  it("leaves a local Talk's presence to the backend, which hears the helper", () => {
    const stop = startPresenceReporting(shownConversations)
    setTalkingConversation(5)
    expect(lastLocalReport().talking).toBeUndefined()
    expect(lastLocalReport().conversation_ids).toEqual([5])
    stop()
  })
})
