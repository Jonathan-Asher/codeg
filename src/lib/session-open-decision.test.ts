import { describe, expect, it } from "vitest"

import {
  RECENT_SEND_WINDOW_MS,
  canReplaceTab,
  decideSessionOpen,
  intentFromModifiers,
  isJustLooking,
  type CurrentTabState,
  type SessionOpenInput,
} from "./session-open-decision"

const NOW = 1_800_000_000_000

/** A tab he is only looking at: every condition met. */
function looking(over: Partial<CurrentTabState> = {}): CurrentTabState {
  return {
    tabId: "front",
    kind: "conversation",
    anchored: false,
    composerHasContent: false,
    queued: false,
    working: false,
    waitingOnUser: false,
    lastSentAt: null,
    sameScope: true,
    ...over,
  }
}

function decide(over: Partial<SessionOpenInput> = {}) {
  return decideSessionOpen({
    openTabId: null,
    current: looking(),
    intent: "auto",
    mode: "smart",
    now: NOW,
    ...over,
  })
}

describe("isJustLooking", () => {
  it("holds for an idle session tab with nothing in it", () => {
    expect(isJustLooking(looking(), NOW)).toBe(true)
  })

  it("holds for an empty new-session draft", () => {
    expect(isJustLooking(looking({ kind: "draft" }), NOW)).toBe(true)
  })

  it.each<[string, Partial<CurrentTabState>]>([
    ["a draft with text", { kind: "draft", composerHasContent: true }],
    ["a sub-agent's thread (not a session tab)", { kind: "subagent" }],
    ["a pinned tab", { anchored: true }],
    ["a running turn", { working: true }],
    ["a permission, question or plan waiting", { waitingOnUser: true }],
    ["text or an attachment in the composer", { composerHasContent: true }],
    ["messages in the queue", { queued: true }],
    [
      "another folder's slot while tabs follow the folder",
      { sameScope: false },
    ],
  ])("fails for %s", (_, over) => {
    expect(isJustLooking(looking(over), NOW)).toBe(false)
  })

  it("fails while his last message from the tab is under ten minutes old", () => {
    expect(isJustLooking(looking({ lastSentAt: NOW - 60_000 }), NOW)).toBe(
      false
    )
    expect(
      isJustLooking(
        looking({ lastSentAt: NOW - RECENT_SEND_WINDOW_MS + 1 }),
        NOW
      )
    ).toBe(false)
  })

  it("holds again once ten minutes have passed since he sent", () => {
    expect(
      isJustLooking(looking({ lastSentAt: NOW - RECENT_SEND_WINDOW_MS }), NOW)
    ).toBe(true)
  })
})

describe("decideSessionOpen", () => {
  it("switches to the tab already holding the session, whatever was asked", () => {
    for (const intent of ["auto", "new_tab", "replace"] as const) {
      expect(decide({ openTabId: "held", intent })).toEqual({
        action: "switch",
        tabId: "held",
      })
    }
  })

  it("loads the session into the tab in front when he is only looking at it", () => {
    expect(decide()).toEqual({ action: "replace", tabId: "front" })
  })

  it("opens as before when the tab in front is busy", () => {
    expect(decide({ current: looking({ working: true }) })).toEqual({
      action: "default",
    })
    expect(decide({ current: looking({ anchored: true }) })).toEqual({
      action: "default",
    })
  })

  it("opens as before with no conversation tab in front", () => {
    expect(decide({ current: null })).toEqual({ action: "default" })
  })

  it("keeps the old behaviour under the setting Always a new tab", () => {
    expect(decide({ mode: "new_tab" })).toEqual({ action: "default" })
  })

  it("replaces the tab in front under the setting Replace, even mid-turn", () => {
    expect(
      decide({ mode: "replace", current: looking({ working: true }) })
    ).toEqual({ action: "replace", tabId: "front" })
  })

  it("opens a fresh kept tab on an explicit new tab", () => {
    expect(decide({ intent: "new_tab" })).toEqual({ action: "new_tab" })
    expect(decide({ intent: "new_tab", mode: "replace" })).toEqual({
      action: "new_tab",
    })
  })

  it("replaces on an explicit this-tab over the setting, a running turn included", () => {
    expect(
      decide({
        intent: "replace",
        mode: "new_tab",
        current: looking({ working: true, waitingOnUser: true }),
      })
    ).toEqual({ action: "replace", tabId: "front" })
  })

  it("never replaces a pinned tab: an explicit this-tab opens a new one", () => {
    expect(
      decide({ intent: "replace", current: looking({ anchored: true }) })
    ).toEqual({ action: "new_tab" })
  })

  it("never drops a draft or a queue: an explicit this-tab opens a new one", () => {
    for (const over of [
      { kind: "draft" as const, composerHasContent: true },
      { composerHasContent: true },
      { queued: true },
    ]) {
      expect(decide({ intent: "replace", current: looking(over) })).toEqual({
        action: "new_tab",
      })
    }
  })

  it("replaces a sub-agent's thread only when asked to", () => {
    const current = looking({ kind: "subagent" })
    expect(decide({ current })).toEqual({ action: "default" })
    expect(decide({ current, intent: "replace" })).toEqual({
      action: "replace",
      tabId: "front",
    })
  })

  it("has no tab to replace with none in front", () => {
    expect(decide({ intent: "replace", current: null })).toEqual({
      action: "default",
    })
  })
})

describe("canReplaceTab", () => {
  it("refuses another folder's slot while tabs follow the folder", () => {
    expect(canReplaceTab(looking({ sameScope: false }))).toBe(false)
  })
})

describe("intentFromModifiers", () => {
  const none = { metaKey: false, ctrlKey: false, altKey: false }
  it("reads ⌘ / Ctrl as a new tab and ⌥ / Alt as this tab", () => {
    expect(intentFromModifiers(none)).toBe("auto")
    expect(intentFromModifiers({ ...none, metaKey: true })).toBe("new_tab")
    expect(intentFromModifiers({ ...none, ctrlKey: true })).toBe("new_tab")
    expect(intentFromModifiers({ ...none, altKey: true })).toBe("replace")
  })
})
