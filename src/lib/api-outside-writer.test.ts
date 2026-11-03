import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * "Connect anyway" rides on `acp_connect` only when the user chose it: an
 * ordinary connect carries no field at all, so older servers see exactly
 * what they always did. The wait asks `acp_outside_writer_status`.
 */

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: vi.fn() }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { acpConnect, acpOutsideWriterStatus } from "@/lib/api"

describe("outside-writer transport", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.call.mockResolvedValue("conn-1")
  })

  it("asks to connect anyway only when the user chose it", async () => {
    await acpConnect("claude_code", "/work", "s1", null, null, false, true)
    expect(mocks.call).toHaveBeenLastCalledWith(
      "acp_connect",
      {
        agentType: "claude_code",
        workingDir: "/work",
        sessionId: "s1",
        preferredModeId: null,
        preferredConfigValues: null,
        allowOutsideWriter: true,
      },
      expect.anything()
    )

    await acpConnect("claude_code", "/work", "s1")
    const args = mocks.call.mock.lastCall?.[1] as Record<string, unknown>
    expect(args).not.toHaveProperty("allowOutsideWriter")
    expect(args).not.toHaveProperty("ephemeral")
  })

  it("asks whether another process still runs the session", async () => {
    mocks.call.mockResolvedValue({ writer: null, transcript: null })
    await expect(acpOutsideWriterStatus("claude_code", "s1")).resolves.toEqual({
      writer: null,
      transcript: null,
    })
    expect(mocks.call).toHaveBeenLastCalledWith("acp_outside_writer_status", {
      agentType: "claude_code",
      sessionId: "s1",
    })
  })
})
