import { afterEach, describe, expect, it, vi } from "vitest"

import {
  loadOutbox,
  outboxStorageKey,
  removeOutbox,
  saveOutbox,
  type StoredOutbox,
} from "./outbox-storage"

vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))

const IMAGE = {
  type: "image" as const,
  data: "A".repeat(64),
  mime_type: "image/png",
  uri: "file:///uploads/b/shot.png",
}

function outbox(): StoredOutbox {
  return {
    queue: [
      {
        id: "row-1",
        clientMessageId: "optimistic-1",
        draft: {
          blocks: [{ type: "text", text: "first" }, IMAGE],
          displayText: "first",
        },
        modeId: null,
      },
    ],
    inflight: [
      {
        clientMessageId: "optimistic-2",
        draft: {
          blocks: [{ type: "text", text: "second" }],
          displayText: "second",
        },
        modeId: "default",
        startedAt: 1,
      },
    ],
  }
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("outbox storage", () => {
  it("scopes the key by server and conversation", () => {
    expect(outboxStorageKey("conv:7")).toBe("codeg:outbox:v1:web:conv:7")
  })

  it("round-trips the queue and the messages in flight", () => {
    const key = outboxStorageKey("conv:1")
    saveOutbox(key, outbox())
    expect(loadOutbox(key)).toEqual(outbox())
  })

  it("removes the entry once nothing is left", () => {
    const key = outboxStorageKey("conv:2")
    saveOutbox(key, outbox())
    saveOutbox(key, { queue: [], inflight: [] })
    expect(localStorage.getItem(key)).toBeNull()
    expect(loadOutbox(key)).toBeNull()
  })

  it("ignores a corrupt entry rather than failing", () => {
    const key = outboxStorageKey("conv:3")
    localStorage.setItem(key, "{not json")
    expect(loadOutbox(key)).toBeNull()
    localStorage.setItem(
      key,
      JSON.stringify({ queue: [{ id: 1 }], inflight: "x" })
    )
    expect(loadOutbox(key)).toBeNull()
  })

  it("over quota, keeps the text and the uploaded image's reference", () => {
    const key = outboxStorageKey("conv:4")
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      value: string
    ) {
      // Too big while the image bytes ride along.
      if (value.includes("AAAAAAAA")) {
        throw new DOMException("full", "QuotaExceededError")
      }
      return real.call(this, k, value)
    })
    saveOutbox(key, outbox())
    const stored = loadOutbox(key)!
    const blocks = stored.queue[0].draft.blocks
    expect(blocks[0]).toEqual({ type: "text", text: "first" })
    expect(blocks[1]).toMatchObject({ type: "image", data: "", uri: IMAGE.uri })
    expect(stored.inflight[0].clientMessageId).toBe("optimistic-2")
  })

  it("removeOutbox forgets a key", () => {
    const key = outboxStorageKey("draft:t1")
    saveOutbox(key, outbox())
    removeOutbox(key)
    expect(loadOutbox(key)).toBeNull()
  })
})
