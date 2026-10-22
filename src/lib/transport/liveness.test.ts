import { describe, expect, it } from "vitest"
import {
  LIVENESS,
  LivenessMonitor,
  RttWindow,
  adaptiveDeadlineMs,
} from "./liveness"

const s = (n: number) => n * 1_000

/** A fresh monitor driven to its first ping; returns when it went out. */
function pinged(monitor: LivenessMonitor, t0: number): number {
  const sent = monitor.nextCheckAt()
  expect(sent).toBeGreaterThanOrEqual(t0)
  expect(monitor.onCheck(sent)).toBe("ping")
  return sent
}

describe("RttWindow / adaptiveDeadlineMs", () => {
  it("reports the nearest-rank 95th percentile over the newest samples", () => {
    const window = new RttWindow()
    expect(window.p95()).toBeNull()
    for (let ms = 10; ms <= 200; ms += 10) window.add(ms)
    // 16 kept (50..200); rank ceil(0.95 × 16) = 16 → the largest.
    expect(window.size).toBe(LIVENESS.rttSamples)
    expect(window.p95()).toBe(200)
    window.add(Number.NaN)
    window.add(-1)
    expect(window.size).toBe(LIVENESS.rttSamples)
  })

  it("clamps 3 × p95 between the floor and the 30 s ceiling", () => {
    expect(adaptiveDeadlineMs(null, s(10))).toBe(s(10))
    expect(adaptiveDeadlineMs(200, s(10))).toBe(s(10))
    expect(adaptiveDeadlineMs(s(5), s(10))).toBe(s(15))
    expect(adaptiveDeadlineMs(s(20), s(10))).toBe(s(30))
  })
})

describe("LivenessMonitor", () => {
  it("pings after 15 s of quiet and probes the server once the pong is 10 s late", () => {
    const m = new LivenessMonitor(0)
    expect(m.nextCheckAt()).toBe(s(15))
    expect(m.onCheck(s(1))).toBe("wait")
    const sent = pinged(m, 0)
    expect(m.nextCheckAt()).toBe(sent + s(10))
    expect(m.onCheck(sent + s(9))).toBe("wait")
    expect(m.onCheck(sent + s(10))).toBe("probe")
    expect(m.probeInFlight()).toBe(true)
    expect(m.onProbeResult(sent + s(11), "unreachable", s(1))).toBe("dead")
  })

  it("keeps a socket whose server answers, and learns from the late pong", () => {
    const m = new LivenessMonitor(0)
    const sent = pinged(m, 0)
    expect(m.onCheck(sent + s(10))).toBe("probe")
    expect(m.onProbeResult(sent + s(10) + 40, "alive", 40)).toBe("extend")
    expect(m.nextCheckAt()).toBe(sent + s(20) + 40)
    // The pong lands 14 s after the ping.
    m.onInbound(sent + s(14), true)
    expect(m.pingOutstanding()).toBe(false)
    const next = pinged(m, sent + s(14))
    // 3 × 14 s, capped at the ceiling.
    expect(m.nextCheckAt()).toBe(next + s(30))
  })

  it("gives up after the last extension", () => {
    const m = new LivenessMonitor(0)
    pinged(m, 0)
    for (let i = 0; i < LIVENESS.maxExtensions; i++) {
      const due = m.nextCheckAt()
      expect(m.onCheck(due)).toBe("probe")
      expect(m.onProbeResult(due, "alive", 0)).toBe("extend")
    }
    expect(m.onCheck(m.nextCheckAt())).toBe("dead")
  })

  it("counts a timed-out probe, so the next socket is more patient", () => {
    const m = new LivenessMonitor(0)
    const sent = pinged(m, 0)
    expect(m.onCheck(sent + s(10))).toBe("probe")
    expect(m.onProbeResult(sent + s(18), "timeout", s(8))).toBe("dead")
    m.reset(s(60))
    const next = pinged(m, s(60))
    expect(m.nextCheckAt()).toBe(next + s(24))
    expect(m.probeTimeoutMs()).toBe(LIVENESS.probeCeilingMs)
  })

  it("reports unauthorized, and ignores a probe a frame already settled", () => {
    const m = new LivenessMonitor(0)
    let sent = pinged(m, 0)
    expect(m.onCheck(sent + s(10))).toBe("probe")
    expect(m.onProbeResult(sent + s(11), "unauthorized", s(1))).toBe(
      "unauthorized"
    )
    m.reset(s(100))
    sent = pinged(m, s(100))
    expect(m.onCheck(sent + s(10))).toBe("probe")
    m.onInbound(sent + s(11), false)
    expect(m.onProbeResult(sent + s(12), "unreachable", s(2))).toBe("ignored")
    // Only a pong is a round-trip sample.
    expect(m.rtt.p95()).toBeNull()
  })

  it("watches closer while a turn streams on screen", () => {
    const m = new LivenessMonitor(0)
    m.setStreaming(true)
    expect(m.nextCheckAt()).toBe(s(5))
    const sent = pinged(m, 0)
    expect(m.nextCheckAt()).toBe(sent + s(5))
    expect(m.onCheck(sent + s(5))).toBe("probe")
    expect(m.probeTimeoutMs()).toBe(LIVENESS.probeStreamFloorMs)
  })

  it("on wake pings at once under a 4 s deadline, pulls in a recent ping, replaces a stale one", () => {
    const m = new LivenessMonitor(0)
    expect(m.onWake(s(3))).toBe(true)
    expect(m.nextCheckAt()).toBe(s(7))

    const m2 = new LivenessMonitor(0)
    const sent = pinged(m2, 0)
    expect(m2.onWake(sent + s(1))).toBe(false)
    expect(m2.nextCheckAt()).toBe(sent + s(5))

    const m3 = new LivenessMonitor(0)
    const old = pinged(m3, 0)
    // Sent before a sleep: a fresh ping, since a write makes a dead socket fail.
    expect(m3.onWake(old + s(9))).toBe(true)
    expect(m3.nextCheckAt()).toBe(old + s(13))
    expect(m3.onCheck(old + s(13))).toBe("probe")
    // A probe in flight is left to decide.
    expect(m3.onWake(old + s(14))).toBe(false)
  })
})
