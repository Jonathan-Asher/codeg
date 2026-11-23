"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  createPreparedPrompt,
  deletePreparedPrompt,
  listPreparedPrompts,
  markPreparedPromptSent,
  reorderPreparedPrompts,
  updatePreparedPrompt,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  PREPARED_PROMPTS_CHANGED_EVENT,
  type PreparedPrompt,
  type PreparedPromptsChange,
} from "@/lib/types"

export interface PreparedPromptList {
  /** The list, top to bottom; `null` until the first read of this
   *  conversation's list has come back. */
  prompts: PreparedPrompt[] | null
  /** Why the last read failed, while nothing newer has come back. */
  error: string | null
  reload: () => void
  /** Add at the end. Rejects with the server's reason. */
  add: (content: string) => Promise<PreparedPrompt>
  update: (id: number, content: string) => Promise<PreparedPrompt>
  /** Delete; resolves with what was deleted and where it was, for an undo. */
  remove: (id: number) => Promise<{ prompt: PreparedPrompt; index: number }>
  /** Put a deleted prompt back where it was (a new row with its text). */
  restore: (prompt: PreparedPrompt, index: number) => Promise<void>
  /** Show `next` as the order while a drag is under way; nothing is stored
   *  and no read replaces it until {@link endDrag}. */
  dragTo: (next: PreparedPrompt[]) => void
  /** The drag ended: store the order it left, if it changed. */
  endDrag: () => Promise<void>
  /** Stamp the prompt as sent now. Best effort: the send already happened. */
  markSent: (id: number) => void
}

interface ListState {
  conversationId: number | null
  prompts: PreparedPrompt[] | null
  error: string | null
}

const sameOrder = (a: PreparedPrompt[], b: PreparedPrompt[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i].id)

/**
 * One conversation's prepared prompts, kept current: read when the
 * conversation changes, re-read when any window changes them (the server's
 * `prepared-prompt://changed` nudge) and after a reconnect. Writes go to the
 * server first and are applied here from what it answers, so this window
 * shows exactly what every other window will.
 */
export function usePreparedPrompts(
  conversationId: number | null
): PreparedPromptList {
  const [state, setState] = useState<ListState>({
    conversationId: null,
    prompts: null,
    error: null,
  })
  // Reads answer in any order; only the newest one is applied.
  const readSeqRef = useRef(0)
  // While a drag is under way the shown order is the drag's; a read that lands
  // then is held back and done again once the drag is over.
  const draggingRef = useRef(false)
  const staleAfterDragRef = useRef(false)
  const dragStartRef = useRef<PreparedPrompt[] | null>(null)
  const conversationRef = useRef(conversationId)
  useEffect(() => {
    conversationRef.current = conversationId
  }, [conversationId])

  const reload = useCallback(() => {
    if (conversationId == null) return
    if (draggingRef.current) {
      staleAfterDragRef.current = true
      return
    }
    const seq = ++readSeqRef.current
    listPreparedPrompts(conversationId).then(
      (prompts) => {
        if (seq !== readSeqRef.current) return
        if (draggingRef.current) {
          staleAfterDragRef.current = true
          return
        }
        setState({ conversationId, prompts, error: null })
      },
      (err: unknown) => {
        if (seq !== readSeqRef.current) return
        setState((prev) => ({
          conversationId,
          prompts: prev.conversationId === conversationId ? prev.prompts : null,
          error: toErrorMessage(err),
        }))
      }
    )
  }, [conversationId])

  useEffect(() => {
    // Initial read of this conversation's list; it resolves asynchronously.
    reload()
  }, [reload])

  // Live: another window (or this one) changed this conversation's list.
  useEffect(() => {
    if (conversationId == null) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribe<PreparedPromptsChange>(
      PREPARED_PROMPTS_CHANGED_EVENT,
      (change) => {
        if (change?.conversationId === conversationId) reload()
      }
    )
      .then((dispose) => {
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
        // A change stored between the first read and the subscription being
        // in place reached neither: read once more now that it is.
        reload()
      })
      .catch((err: unknown) => {
        console.warn("[PreparedPrompts] subscribe failed:", err)
      })
    const offReconnect = onTransportReconnect(() => reload())
    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [conversationId, reload])

  // What the server answered, applied to the list it belongs to (the user may
  // have switched to another conversation while the write was on its way).
  const applyTo = useCallback(
    (
      forConversation: number,
      change: (prompts: PreparedPrompt[]) => PreparedPrompt[]
    ) => {
      setState((prev) =>
        prev.conversationId === forConversation && prev.prompts
          ? { ...prev, prompts: change(prev.prompts) }
          : prev
      )
    },
    []
  )

  const add = useCallback(
    async (content: string) => {
      if (conversationId == null) throw new Error("No conversation")
      const created = await createPreparedPrompt(conversationId, content)
      applyTo(conversationId, (prompts) =>
        prompts.some((p) => p.id === created.id)
          ? prompts
          : [...prompts, created]
      )
      return created
    },
    [conversationId, applyTo]
  )

  const update = useCallback(
    async (id: number, content: string) => {
      const updated = await updatePreparedPrompt(id, content)
      applyTo(updated.conversationId, (prompts) =>
        prompts.map((p) => (p.id === id ? updated : p))
      )
      return updated
    },
    [applyTo]
  )

  const remove = useCallback(
    async (id: number) => {
      const current = state.prompts ?? []
      const index = current.findIndex((p) => p.id === id)
      const prompt = current[index]
      if (!prompt) throw new Error(`Prepared prompt ${id} is not listed`)
      await deletePreparedPrompt(id)
      applyTo(prompt.conversationId, (prompts) =>
        prompts.filter((p) => p.id !== id)
      )
      return { prompt, index }
    },
    [state.prompts, applyTo]
  )

  const restore = useCallback(async (prompt: PreparedPrompt, index: number) => {
    const created = await createPreparedPrompt(
      prompt.conversationId,
      prompt.content
    )
    // Back in its old place: the new row goes where the deleted one was.
    const listed = await listPreparedPrompts(prompt.conversationId)
    const ids = listed.map((p) => p.id).filter((id) => id !== created.id)
    ids.splice(Math.min(index, ids.length), 0, created.id)
    const ordered = await reorderPreparedPrompts(prompt.conversationId, ids)
    if (conversationRef.current === prompt.conversationId) {
      readSeqRef.current++
      setState({
        conversationId: prompt.conversationId,
        prompts: ordered,
        error: null,
      })
    }
  }, [])

  const dragTo = useCallback(
    (next: PreparedPrompt[]) => {
      if (!draggingRef.current) {
        draggingRef.current = true
        dragStartRef.current = state.prompts
      }
      setState((prev) => ({ ...prev, prompts: next }))
    },
    [state.prompts]
  )

  const endDrag = useCallback(async () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const start = dragStartRef.current
    dragStartRef.current = null
    const shown = state.prompts
    const forConversation = state.conversationId
    const readAgain = staleAfterDragRef.current
    staleAfterDragRef.current = false
    if (forConversation == null || !shown || !start) return
    if (sameOrder(shown, start)) {
      if (readAgain) reload()
      return
    }
    try {
      const stored = await reorderPreparedPrompts(
        forConversation,
        shown.map((p) => p.id)
      )
      if (conversationRef.current === forConversation) {
        readSeqRef.current++
        setState({
          conversationId: forConversation,
          prompts: stored,
          error: null,
        })
      }
    } catch (err) {
      // Show what is really stored rather than an order that was not kept.
      reload()
      throw err
    }
  }, [state.prompts, state.conversationId, reload])

  const markSent = useCallback(
    (id: number) => {
      markPreparedPromptSent(id).then(
        (sent) =>
          applyTo(sent.conversationId, (prompts) =>
            prompts.map((p) => (p.id === id ? sent : p))
          ),
        (err: unknown) =>
          console.warn("[PreparedPrompts] marking as sent failed:", err)
      )
    },
    [applyTo]
  )

  // A different conversation's list (or none yet) reads as not loaded, so the
  // previous one never shows under the new conversation.
  const current = state.conversationId === conversationId
  return {
    prompts: current ? state.prompts : null,
    error: current ? state.error : null,
    reload,
    add,
    update,
    remove,
    restore,
    dragTo,
    endDrag,
    markSent,
  }
}
