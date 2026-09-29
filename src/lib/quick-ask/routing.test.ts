import { describe, expect, it } from "vitest"

import { promptOptionsFor, routeQuickAskSend } from "./routing"

describe("routeQuickAskSend", () => {
  it("sends when the agent is idle, for every target", () => {
    for (const target of ["new", "existing", "private"] as const) {
      expect(
        routeQuickAskSend({ target, status: "connected", nativeSteering: true })
      ).toBe("send")
      expect(
        routeQuickAskSend({ target, status: null, nativeSteering: false })
      ).toBe("send")
    }
  })

  it("steers into a busy session that takes mid-turn messages", () => {
    expect(
      routeQuickAskSend({
        target: "existing",
        status: "prompting",
        nativeSteering: true,
      })
    ).toBe("steer")
    expect(
      routeQuickAskSend({
        target: "new",
        status: "prompting",
        nativeSteering: true,
      })
    ).toBe("steer")
  })

  it("queues when the busy session cannot take it now", () => {
    expect(
      routeQuickAskSend({
        target: "existing",
        status: "prompting",
        nativeSteering: false,
      })
    ).toBe("queue")
  })

  it("never steers a private question: it stays on the unrecorded path", () => {
    expect(
      routeQuickAskSend({
        target: "private",
        status: "prompting",
        nativeSteering: true,
      })
    ).toBe("queue")
  })
})

describe("promptOptionsFor", () => {
  it("links saved sessions to their conversation row", () => {
    expect(
      promptOptionsFor({ kind: "linked", folderId: 3, conversationId: 42 })
    ).toEqual({ folderId: 3, conversationId: 42 })
  })

  it("sends private questions unlinked", () => {
    expect(promptOptionsFor({ kind: "unlinked" })).toEqual({ unlinked: true })
  })
})
