import { describe, expect, it } from "vitest"

import type { ConnectionState } from "@/contexts/acp-connections-context"
import { portChanges, portSnapshot } from "./port-snapshot"

const permission = {
  request_id: "perm-7",
  tool_call: { title: "rm -rf build" },
  options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
  queued: 0,
}

const question = {
  question_id: "q-3",
  questions: [],
  created_at: "2026-11-01T09:32:10Z",
}

function conn(extra: Partial<ConnectionState>): ConnectionState {
  return {
    status: "connected",
    nativeSteering: false,
    awaitingBackground: false,
    backgroundOutstanding: 0,
    pendingPermission: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    ...extra,
  } as ConnectionState
}

describe("portSnapshot", () => {
  it("is an idle session without a connection", () => {
    expect(portSnapshot(undefined, "Fix the build")).toEqual({
      title: "Fix the build",
      canInsertIntoTurn: false,
      isInFlight: false,
      awaitingBackground: false,
      backgroundOutstanding: 0,
      pendingPermission: null,
      pendingQuestion: null,
      pendingPlanApproval: null,
    })
  })

  it("passes the cards through as the server sends them", () => {
    const port = portSnapshot(
      conn({
        status: "prompting",
        nativeSteering: true,
        awaitingBackground: true,
        backgroundOutstanding: 2,
        pendingPermission: permission as ConnectionState["pendingPermission"],
        pendingAskQuestion:
          question as unknown as ConnectionState["pendingAskQuestion"],
      }),
      null
    )
    expect(port).toMatchObject({
      canInsertIntoTurn: true,
      isInFlight: true,
      awaitingBackground: true,
      backgroundOutstanding: 2,
      pendingPermission: permission,
      pendingQuestion: question,
    })
  })

  it("inserts into a turn only with native steering", () => {
    const port = portSnapshot(conn({ status: "prompting" }), null)
    expect(port.isInFlight).toBe(true)
    expect(port.canInsertIntoTurn).toBe(false)
  })
})

describe("portChanges", () => {
  const idle = portSnapshot(undefined, "Fix")

  it("is everything the first time, and nothing when nothing changed", () => {
    expect(portChanges(null, idle)).toEqual(idle)
    expect(portChanges(idle, { ...idle })).toBeNull()
  })

  it("sends a card that went away as null", () => {
    const asking = { ...idle, pendingPermission: permission } as typeof idle
    expect(portChanges(idle, asking)).toEqual({ pendingPermission: permission })
    expect(portChanges(asking, idle)).toEqual({ pendingPermission: null })
  })

  it("sends a card again when its content changed", () => {
    const one = { ...idle, pendingPermission: permission } as typeof idle
    const queued = {
      ...idle,
      pendingPermission: { ...permission, queued: 2 },
    } as typeof idle
    expect(portChanges(one, queued)).toEqual({
      pendingPermission: { ...permission, queued: 2 },
    })
    // A copy of the same card is no change.
    const copy = {
      ...idle,
      pendingPermission: { ...permission },
    } as typeof idle
    expect(portChanges(one, copy)).toBeNull()
  })

  it("names only the fields that changed", () => {
    expect(
      portChanges(idle, {
        ...idle,
        isInFlight: true,
        canInsertIntoTurn: true,
        title: "Fix the flaky build",
      })
    ).toEqual({
      isInFlight: true,
      canInsertIntoTurn: true,
      title: "Fix the flaky build",
    })
  })
})
