import { describe, expect, it } from "vitest"
import type {
  ConnectErrorInfo,
  ConnectPendingInfo,
  ConnectionState,
} from "@/contexts/acp-connections-context"
import { readConnectionAttachInfo } from "@/hooks/use-connection-status"

function storeWith({
  conn,
  pending,
  error,
}: {
  conn?: Partial<ConnectionState>
  pending?: ConnectPendingInfo
  error?: ConnectErrorInfo
}) {
  return {
    getConnection: () => conn as ConnectionState | undefined,
    getConnectPending: () => pending,
    getConnectError: () => error,
  }
}

const PENDING: ConnectPendingInfo = {
  agentType: "claude_code",
  workingDir: "/tmp/x",
}

describe("readConnectionAttachInfo", () => {
  it("reports a connect in flight with no entry yet as starting", () => {
    expect(
      readConnectionAttachInfo(storeWith({ pending: PENDING }), "k")
    ).toEqual({
      state: "connecting",
      phase: "starting",
      startedAt: null,
      error: null,
    })
  })

  it("reports the step an attaching entry is on, with its start time", () => {
    const info = readConnectionAttachInfo(
      storeWith({
        conn: {
          status: "connecting",
          attachPhase: "resuming",
          attachStartedAt: 1_000,
        },
      }),
      "k"
    )
    expect(info).toEqual({
      state: "connecting",
      phase: "resuming",
      startedAt: 1_000,
      error: null,
    })
  })

  it("reports an attach that failed, with the session's error", () => {
    const info = readConnectionAttachInfo(
      storeWith({
        conn: {
          status: "error",
          attachPhase: "failed",
          error: "Claude Code did not finish opening the session.",
          loadError: null,
        },
      }),
      "k"
    )
    expect(info.state).toBe("failed")
    expect(info.error).toBe("Claude Code did not finish opening the session.")
  })

  it("reports a connect that failed before any entry existed", () => {
    const info = readConnectionAttachInfo(
      storeWith({
        error: {
          agentType: "claude_code",
          title: "Claude Code connection failed",
          detail: "Remote HTTP request failed: operation timed out",
          opensAgentSettings: false,
        },
      }),
      "k"
    )
    expect(info).toEqual({
      state: "failed",
      phase: null,
      startedAt: null,
      error:
        "Claude Code connection failed: Remote HTTP request failed: operation timed out",
    })
  })

  it("says nothing about an open session, or one that ended normally", () => {
    expect(
      readConnectionAttachInfo(
        storeWith({ conn: { status: "connected", attachPhase: "ready" } }),
        "k"
      ).state
    ).toBeNull()
    // Ended after it was open: a disconnect, not a failed attach.
    expect(
      readConnectionAttachInfo(
        storeWith({ conn: { status: "disconnected", attachPhase: "ready" } }),
        "k"
      ).state
    ).toBeNull()
  })

  it("lets a retry in flight win over the entry it replaces", () => {
    const info = readConnectionAttachInfo(
      storeWith({
        pending: PENDING,
        conn: { status: "error", attachPhase: "failed", attachStartedAt: 5 },
      }),
      "k"
    )
    expect(info.state).toBe("connecting")
    expect(info.phase).toBe("starting")
    // The failed entry's clock is not this attempt's.
    expect(info.startedAt).toBeNull()
  })
})
