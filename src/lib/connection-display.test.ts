import { describe, expect, it } from "vitest"
import {
  BACK_ONLINE_MS,
  ConnectionDisplayTracker,
  OFFLINE_AFTER_MS,
  PILL_DELAY_MS,
  UPDATING_AFTER_MS,
  type ConnectionDisplayInputs,
} from "./connection-display"

const up: ConnectionDisplayInputs = {
  health: "connected",
  syncing: false,
  online: true,
  visible: true,
}
const down: ConnectionDisplayInputs = { ...up, health: "reconnecting" }

describe("ConnectionDisplayTracker", () => {
  it("shows nothing for a blip, the pill after a second, the banner after ten", () => {
    const tracker = new ConnectionDisplayTracker(0)
    expect(tracker.update(up, 1_000).display.kind).toBe("none")
    const blip = tracker.update(down, 5_000)
    expect(blip.display.kind).toBe("none")
    expect(blip.nextAt).toBe(5_000 + PILL_DELAY_MS)
    expect(tracker.update(down, 5_000 + PILL_DELAY_MS).display.kind).toBe(
      "reconnecting"
    )
    const offline = tracker.update(down, 5_000 + OFFLINE_AFTER_MS).display
    expect(offline).toEqual({
      kind: "offline",
      connecting: false,
      since: 5_000,
      ageMs: OFFLINE_AFTER_MS,
    })
  })

  it("is offline at once when the OS reports no network", () => {
    const tracker = new ConnectionDisplayTracker(0)
    tracker.update(up, 0)
    expect(tracker.update({ ...down, online: false }, 100).display.kind).toBe(
      "offline"
    )
  })

  it("counts only visible down time: a page coming back from an absence gets the pill, not the banner", () => {
    const tracker = new ConnectionDisplayTracker(0)
    tracker.update(up, 0)
    // Down while hidden for ten minutes (a sleep, a long absence).
    expect(
      tracker.update({ ...down, visible: false }, 1_000).display.kind
    ).toBe("none")
    const shown = 601_000
    expect(tracker.update(down, shown).display.kind).toBe("none")
    expect(tracker.update(down, shown + PILL_DELAY_MS).display.kind).toBe(
      "reconnecting"
    )
    // Reconnected within seconds: the refetches run quietly under the pill.
    expect(
      tracker.update({ ...up, syncing: true }, shown + 3_000).display.kind
    ).toBe("updating")
    const done = tracker.update(up, shown + 4_000)
    expect(done.display.kind).toBe("back-online")
    expect(done.nextAt).toBe(shown + 4_000 + BACK_ONLINE_MS)
    expect(
      tracker.update(up, shown + 4_000 + BACK_ONLINE_MS).display.kind
    ).toBe("none")
  })

  it("says updating only for a slow resync when nothing was shown before", () => {
    const tracker = new ConnectionDisplayTracker(0)
    tracker.update(up, 0)
    const quick = tracker.update({ ...up, syncing: true }, 1_000)
    expect(quick.display.kind).toBe("none")
    expect(quick.nextAt).toBe(1_000 + UPDATING_AFTER_MS)
    expect(tracker.update(up, 1_200).display.kind).toBe("none")
    tracker.update({ ...up, syncing: true }, 2_000)
    expect(
      tracker.update({ ...up, syncing: true }, 2_000 + UPDATING_AFTER_MS)
        .display.kind
    ).toBe("updating")
    expect(tracker.update(up, 3_000).display.kind).toBe("back-online")
  })

  it("leaves a rejected token to its dialog", () => {
    const tracker = new ConnectionDisplayTracker(0)
    tracker.update(down, 0)
    tracker.update(down, OFFLINE_AFTER_MS)
    expect(
      tracker.update({ ...up, health: "unauthorized" }, OFFLINE_AFTER_MS + 1)
        .display.kind
    ).toBe("none")
  })

  it("names a link that never came up as connecting", () => {
    const tracker = new ConnectionDisplayTracker(0)
    const connecting = { ...up, health: "connecting" as const }
    tracker.update(connecting, 0)
    expect(tracker.update(connecting, PILL_DELAY_MS).display).toEqual({
      kind: "reconnecting",
      connecting: true,
    })
  })
})
