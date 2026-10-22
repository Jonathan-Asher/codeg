import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { resetOutboxStoresForTests, useMessageQueue } from "./use-message-queue"
import { outboxStorageKey } from "@/lib/outbox-storage"
import { nextSendFailure } from "@/lib/send-failure"
import type { PromptDraft } from "@/lib/types"

vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

const texts = (q: { draft: PromptDraft }[]) => q.map((i) => i.draft.displayText)

/** What a page reload does to the outbox: memory gone, storage kept. */
function reload() {
  resetOutboxStoresForTests()
}

afterEach(() => {
  resetOutboxStoresForTests()
  localStorage.clear()
})

describe("useMessageQueue as the conversation's outbox", () => {
  const KEY = outboxStorageKey("conv:42")

  it("keeps queued and not-sent messages across a reload, in order", () => {
    const first = renderHook(() => useMessageQueue(KEY))
    act(() => {
      first.result.current.enqueue(draft("queued"), "default")
      first.result.current.requeueFront(draft("failed"), null, {
        clientMessageId: "optimistic-f",
        failure: nextSendFailure(new TypeError("Load failed"), undefined),
      })
    })
    first.unmount()
    reload()

    const after = renderHook(() => useMessageQueue(KEY))
    expect(texts(after.result.current.queue)).toEqual(["failed", "queued"])
    const [failed, queued] = after.result.current.queue
    expect(failed.clientMessageId).toBe("optimistic-f")
    expect(failed.failure).toMatchObject({ reason: "network", autoRetry: true })
    expect(queued.modeId).toBe("default")
  })

  it("brings back a message that was on its way, at the front, to resend with its id", () => {
    const first = renderHook(() => useMessageQueue(KEY))
    act(() => {
      first.result.current.enqueue(draft("behind"), null)
      first.result.current.trackSend({
        clientMessageId: "optimistic-sent",
        draft: draft("on its way"),
        modeId: null,
      })
    })
    // The page goes away before the server answered.
    reload()

    const after = renderHook(() => useMessageQueue(KEY))
    expect(texts(after.result.current.queue)).toEqual(["on its way", "behind"])
    expect(after.result.current.queue[0]).toMatchObject({
      clientMessageId: "optimistic-sent",
      failure: { reason: "interrupted", autoRetry: true },
    })
    // Stored as queued at once: a second reload still has it, once.
    reload()
    const again = renderHook(() => useMessageQueue(KEY))
    expect(texts(again.result.current.queue)).toEqual(["on its way", "behind"])
  })

  it("forgets a message once the server answered", () => {
    const first = renderHook(() => useMessageQueue(KEY))
    act(() => {
      first.result.current.trackSend({
        clientMessageId: "optimistic-ok",
        draft: draft("delivered"),
        modeId: null,
      })
      first.result.current.settleSend("optimistic-ok")
    })
    reload()
    const after = renderHook(() => useMessageQueue(KEY))
    expect(after.result.current.queue).toEqual([])
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("does not mistake its own message in flight for an interrupted one on a remount", () => {
    const first = renderHook(() => useMessageQueue(KEY))
    act(() => {
      first.result.current.trackSend({
        clientMessageId: "optimistic-live",
        draft: draft("still going"),
        modeId: null,
      })
    })
    first.unmount()
    // Same page: the tab is shown again while the send is still running.
    const again = renderHook(() => useMessageQueue(KEY))
    expect(again.result.current.queue).toEqual([])
    act(() => first.result.current.settleSend("optimistic-live"))
    reload()
    const after = renderHook(() => useMessageQueue(KEY))
    expect(after.result.current.queue).toEqual([])
  })

  it("carries a draft tab's messages over when it becomes a conversation", () => {
    const draftKey = outboxStorageKey("draft:tab-1")
    const convKey = outboxStorageKey("conv:9")
    const hook = renderHook(({ k }) => useMessageQueue(k), {
      initialProps: { k: draftKey },
    })
    act(() => {
      hook.result.current.enqueue(draft("typed early"), null)
      hook.result.current.trackSend({
        clientMessageId: "optimistic-first",
        draft: draft("first message"),
        modeId: null,
      })
    })
    hook.rerender({ k: convKey })
    expect(texts(hook.result.current.queue)).toEqual(["typed early"])
    expect(localStorage.getItem(draftKey)).toBeNull()

    // The first message's send fails after the move: it lands in the
    // conversation's queue, where the tab now reads.
    act(() => {
      hook.result.current.settleSend("optimistic-first")
      hook.result.current.requeueFront(draft("first message"), null, {
        clientMessageId: "optimistic-first",
        failure: nextSendFailure(new TypeError("Load failed"), undefined),
      })
    })
    reload()
    const after = renderHook(() => useMessageQueue(convKey))
    expect(texts(after.result.current.queue)).toEqual([
      "first message",
      "typed early",
    ])
  })

  it("is one queue for every surface on the same key", () => {
    const a = renderHook(() => useMessageQueue(KEY))
    const b = renderHook(() => useMessageQueue(KEY))
    act(() => a.result.current.enqueue(draft("shared"), null))
    expect(texts(b.result.current.queue)).toEqual(["shared"])
    act(() => {
      b.result.current.dequeue()
    })
    expect(a.result.current.queue).toEqual([])
  })

  it("an edit is a new message: new id, no failure", () => {
    const hook = renderHook(() => useMessageQueue(KEY))
    act(() =>
      hook.result.current.enqueue(draft("old"), null, {
        clientMessageId: "optimistic-old",
        failure: nextSendFailure(
          { code: "invalid_input", message: "no" },
          undefined
        ),
      })
    )
    const id = hook.result.current.queue[0].id
    act(() => hook.result.current.updateItem(id, draft("new")))
    const item = hook.result.current.queue[0]
    expect(item.draft.displayText).toBe("new")
    expect(item.failure).toBeUndefined()
    expect(item.clientMessageId).not.toBe("optimistic-old")
  })

  it("Retry lets a held message go now", () => {
    const hook = renderHook(() => useMessageQueue(KEY))
    act(() =>
      hook.result.current.enqueue(draft("refused"), null, {
        failure: nextSendFailure(
          { code: "invalid_input", message: "no" },
          undefined
        ),
      })
    )
    const item = hook.result.current.queue[0]
    expect(item.failure?.autoRetry).toBe(false)
    act(() => hook.result.current.retry(item.id))
    expect(hook.result.current.queue[0].failure).toMatchObject({
      autoRetry: true,
      nextAttemptAt: 0,
    })
    expect(hook.result.current.queue[0].clientMessageId).toBe(
      item.clientMessageId
    )
  })

  it("without a key keeps nothing", () => {
    const hook = renderHook(() => useMessageQueue())
    act(() => hook.result.current.enqueue(draft("memory only"), null))
    expect(localStorage.length).toBe(0)
  })
})
