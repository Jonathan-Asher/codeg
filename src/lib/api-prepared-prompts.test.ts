import { beforeEach, describe, expect, it, vi } from "vitest"

// The calls a window makes for a conversation's prepared prompts: the command
// names and argument shapes the desktop commands (`commands/prepared_prompts`)
// take, and the JSON bodies the web handlers read, which is how a remote
// window reaches its server.
const call = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  getShellTransport: () => ({ call }),
  getServerBaseUrl: () => "http://localhost",
  isDesktop: () => true,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import {
  createPreparedPrompt,
  deletePreparedPrompt,
  listPreparedPrompts,
  markPreparedPromptSent,
  reorderPreparedPrompts,
  updatePreparedPrompt,
} from "./api"

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue(undefined)
})

describe("prepared prompt API", () => {
  it("lists a conversation's prompts", async () => {
    const listed = [{ id: 1, conversationId: 7, content: "next" }]
    call.mockResolvedValueOnce(listed)
    await expect(listPreparedPrompts(7)).resolves.toBe(listed)
    expect(call).toHaveBeenCalledWith("list_prepared_prompts", {
      conversationId: 7,
    })
  })

  it("adds one to a conversation", async () => {
    await createPreparedPrompt(7, "Run the tests")
    expect(call).toHaveBeenCalledWith("create_prepared_prompt", {
      conversationId: 7,
      content: "Run the tests",
    })
  })

  it("edits one by id", async () => {
    await updatePreparedPrompt(3, "Run them again")
    expect(call).toHaveBeenCalledWith("update_prepared_prompt", {
      id: 3,
      content: "Run them again",
    })
  })

  it("deletes one by id", async () => {
    await deletePreparedPrompt(3)
    expect(call).toHaveBeenCalledWith("delete_prepared_prompt", { id: 3 })
  })

  it("stores a conversation's order, top to bottom", async () => {
    await reorderPreparedPrompts(7, [3, 1, 2])
    expect(call).toHaveBeenCalledWith("reorder_prepared_prompts", {
      conversationId: 7,
      ids: [3, 1, 2],
    })
  })

  it("marks one as sent", async () => {
    await markPreparedPromptSent(3)
    expect(call).toHaveBeenCalledWith("mark_prepared_prompt_sent", { id: 3 })
  })
})
