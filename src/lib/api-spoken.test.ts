import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Talk's `spoken` flag (`docs/talk-mode.md` §4) rides on `acp_prompt` and
 * `submit_session_feedback` only when true: a typed message carries no field
 * at all, so older servers see exactly what they always did.
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

import { acpPrompt, submitSessionFeedback } from "@/lib/api"

const blocks = [{ type: "text" as const, text: "תבדוק למה הבילד נופל" }]

describe("spoken messages", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.call.mockResolvedValue({ duplicate: false })
  })

  it("marks a spoken prompt and leaves a typed one as it was", async () => {
    await acpPrompt("conn-1", blocks, 3, 42, "optimistic-1", true)
    expect(mocks.call).toHaveBeenLastCalledWith("acp_prompt", {
      connectionId: "conn-1",
      blocks,
      folderId: 3,
      conversationId: 42,
      clientMessageId: "optimistic-1",
      spoken: true,
    })
    await acpPrompt("conn-1", blocks, 3, 42, "optimistic-2")
    const typed = mocks.call.mock.calls[1][1] as Record<string, unknown>
    expect("spoken" in typed).toBe(false)
  })

  it("marks a spoken insert into the running turn", async () => {
    mocks.call.mockResolvedValue({ id: "n1", text: "x", status: "delivered" })
    await submitSessionFeedback("conn-1", "רגע, תעצור", null, "c1", true)
    expect(mocks.call).toHaveBeenLastCalledWith("submit_session_feedback", {
      connectionId: "conn-1",
      text: "רגע, תעצור",
      clientId: "c1",
      blocks: null,
      spoken: true,
    })
    await submitSessionFeedback("conn-1", "typed", null, "c2")
    const typed = mocks.call.mock.calls[1][1] as Record<string, unknown>
    expect("spoken" in typed).toBe(false)
  })
})
