import type { ComponentProps } from "react"
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ scrollToBottom: vi.fn() }))

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: h.scrollToBottom }),
}))

import {
  requestScrollToLatest,
  resetScrollToLatestIntents,
  takeScrollToLatest,
} from "@/lib/scroll-to-latest-intent"
import { ScrollToLatestOnRequest } from "./scroll-to-latest-on-request"

type Props = ComponentProps<typeof ScrollToLatestOnRequest>

const BASE: Props = {
  conversationId: 17,
  dbConversationId: 17,
  active: true,
  ready: true,
}

function mount(props: Partial<Props> = {}) {
  const view = render(<ScrollToLatestOnRequest {...BASE} {...props} />)
  return {
    update: (next: Partial<Props>) =>
      view.rerender(<ScrollToLatestOnRequest {...BASE} {...props} {...next} />),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame"] })
  h.scrollToBottom.mockClear()
  resetScrollToLatestIntents()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ScrollToLatestOnRequest", () => {
  it("leaves the scroll alone without a request (a plain tab switch)", () => {
    const { update } = mount({ active: false })
    update({ active: true })
    expect(h.scrollToBottom).not.toHaveBeenCalled()
  })

  it("jumps an open, loaded transcript to its latest message", () => {
    mount()
    act(() => requestScrollToLatest([17]))
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")

    // Once more after the rows the jump revealed are measured.
    act(() => vi.advanceTimersToNextFrame())
    expect(h.scrollToBottom).toHaveBeenCalledTimes(2)
    // Taken: a later render does not jump again.
    expect(takeScrollToLatest([17])).toBe(false)
  })

  it("waits for its tab to become the active one", () => {
    const { update } = mount({ active: false })
    act(() => requestScrollToLatest([17]))
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    update({ active: true })
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
  })

  it("waits for history that loads after the tab opens", () => {
    // A tab mounted fresh by the click: active at once, transcript not in yet.
    requestScrollToLatest([17])
    const { update } = mount({ ready: false })
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    update({ ready: true })
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
    act(() => vi.advanceTimersToNextFrame())
    expect(h.scrollToBottom).toHaveBeenCalledTimes(2)
  })

  it("finds a draft's tab by the conversation saved behind it", () => {
    mount({ conversationId: -5, dbConversationId: 17 })
    act(() => requestScrollToLatest([17]))
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
  })

  it("ignores a request for another conversation", () => {
    mount()
    act(() => requestScrollToLatest([18]))
    expect(h.scrollToBottom).not.toHaveBeenCalled()
    expect(takeScrollToLatest([18])).toBe(true)
  })
})
