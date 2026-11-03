import { afterEach, describe, expect, it } from "vitest"

import {
  clearOutsideWriter,
  markConnectingAnyway,
  outsideWriterFor,
  reportOutsideWriter,
  stopWaitingForOutsideWriter,
  updateOutsideWriter,
  useOutsideWriterStore,
} from "./outside-writer-store"

const WORKER = { pid: 4242, startedAt: 1_793_616_490_351 }

afterEach(() => {
  useOutsideWriterStore.setState({ bySession: {} })
})

describe("outside-writer store", () => {
  it("waits for a process a refused connect named", () => {
    reportOutsideWriter("s1", WORKER)
    expect(outsideWriterFor("s1")).toEqual({
      writer: WORKER,
      phase: "waiting",
    })
    expect(outsideWriterFor("s2")).toBeUndefined()
    expect(outsideWriterFor(undefined)).toBeUndefined()
  })

  it("keeps what the user chose while the process runs on", () => {
    reportOutsideWriter("s1", WORKER)
    stopWaitingForOutsideWriter("s1")
    updateOutsideWriter("s1", { ...WORKER, status: "idle" })
    expect(outsideWriterFor("s1")).toEqual({
      writer: { ...WORKER, status: "idle" },
      phase: "stopped",
    })
  })

  it("goes back to waiting when a connect is refused again", () => {
    reportOutsideWriter("s1", WORKER)
    markConnectingAnyway("s1")
    expect(outsideWriterFor("s1")?.phase).toBe("connecting_anyway")
    reportOutsideWriter("s1", { pid: 5151, startedAt: null })
    expect(outsideWriterFor("s1")).toEqual({
      writer: { pid: 5151, startedAt: null },
      phase: "waiting",
    })
  })

  it("forgets the session once there is nothing to wait for", () => {
    reportOutsideWriter("s1", WORKER)
    reportOutsideWriter("s2", WORKER)
    clearOutsideWriter("s1")
    expect(outsideWriterFor("s1")).toBeUndefined()
    expect(outsideWriterFor("s2")?.phase).toBe("waiting")
  })

  it("does not invent an entry for a session nobody reported", () => {
    updateOutsideWriter("s1", WORKER)
    stopWaitingForOutsideWriter("s1")
    markConnectingAnyway("s1")
    clearOutsideWriter("s1")
    expect(useOutsideWriterStore.getState().bySession).toEqual({})
  })

  it("leaves the state alone when nothing changed", () => {
    reportOutsideWriter("s1", WORKER)
    const before = useOutsideWriterStore.getState().bySession
    updateOutsideWriter("s1", { ...WORKER })
    expect(useOutsideWriterStore.getState().bySession).toBe(before)
    stopWaitingForOutsideWriter("s1")
    const stopped = useOutsideWriterStore.getState().bySession
    expect(stopped).not.toBe(before)
    stopWaitingForOutsideWriter("s1")
    expect(useOutsideWriterStore.getState().bySession).toBe(stopped)
  })
})
