"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  TOGGLE_GUARD_MS,
  type ActionGate,
  type PendingAction,
  type PendingActionKind,
} from "@/lib/pending-actions"
import { randomUUID } from "@/lib/utils"

/** How a queued action ended. */
export type PendingActionOutcome =
  | { status: "ran"; result: unknown }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" }
  | { status: "dropped"; reason: "unsupported" | "unreachable" }

export interface UsePendingActionsOptions<P> {
  /** Whether the head of the queue can run now (see `actionGate`). Only the
   *  head is asked: the queue runs in order. */
  gate: (action: PendingAction<P>) => ActionGate
  /** Run one action; the next waits until it settles. */
  run: (action: PendingAction<P>) => Promise<unknown>
  /** The head turned out to be something this session cannot do: it was
   *  dropped, and this says so. */
  onUnsupported: (action: PendingAction<P>) => void
}

export interface UsePendingActionsReturn<P> {
  /** Waiting, oldest first. The one running is no longer here. */
  queue: readonly PendingAction<P>[]
  /** The action taken off the queue and running right now. */
  running: PendingAction<P> | null
  /** The controls with an action waiting (see `PendingAction.target`). */
  pendingTargets: ReadonlySet<string>
  /**
   * Whether the head can run now, or one is running: messages queued after it
   * hold until it is done (the send queue's flush reads this).
   */
  holdsSends: boolean
  /** Queue an action. Resolves once it ran, or was cancelled or dropped. */
  enqueue: (
    kind: PendingActionKind,
    target: string,
    payload: P,
    after: readonly string[]
  ) => Promise<PendingActionOutcome>
  /**
   * A click on a control: queue its action, or — when one is already waiting
   * for that control — take it back. A second click that is really the same
   * double click is ignored.
   */
  toggle: (
    kind: PendingActionKind,
    target: string,
    payload: P,
    after: readonly string[]
  ) => void
  /** Take back the action waiting for `target`. False when none was. */
  cancel: (target: string) => boolean
  /** Take back the most recently queued action (Esc). */
  cancelLast: () => boolean
  /** Drop everything waiting: the session cannot be reached. */
  dropAll: () => PendingAction<P>[]
}

/**
 * The queue behind `lib/pending-actions`: holds the actions taken before the
 * session was ready, runs the head whenever `gate` says it can, one at a time,
 * and settles each with how it ended.
 */
export function usePendingActions<P>({
  gate,
  run,
  onUnsupported,
}: UsePendingActionsOptions<P>): UsePendingActionsReturn<P> {
  const [queue, setQueue] = useState<readonly PendingAction<P>[]>([])
  const [running, setRunning] = useState<PendingAction<P> | null>(null)
  // The synchronous truth, for clicks and timers that land between renders.
  const queueRef = useRef<readonly PendingAction<P>[]>([])
  const runningRef = useRef<PendingAction<P> | null>(null)
  const settlersRef = useRef(
    new Map<string, (outcome: PendingActionOutcome) => void>()
  )
  const gateRef = useRef(gate)
  const runRef = useRef(run)
  const onUnsupportedRef = useRef(onUnsupported)
  useEffect(() => {
    gateRef.current = gate
    runRef.current = run
    onUnsupportedRef.current = onUnsupported
  }, [gate, run, onUnsupported])

  const commit = useCallback((next: readonly PendingAction<P>[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  const settle = useCallback((id: string, outcome: PendingActionOutcome) => {
    const settler = settlersRef.current.get(id)
    if (!settler) return
    settlersRef.current.delete(id)
    settler(outcome)
  }, [])

  const enqueue = useCallback(
    (
      kind: PendingActionKind,
      target: string,
      payload: P,
      after: readonly string[]
    ) => {
      const action: PendingAction<P> = {
        id: randomUUID(),
        kind,
        target,
        payload,
        after: [...after],
        queuedAt: Date.now(),
      }
      // One waiting action per control: a repeat replaces nothing, it is the
      // same request.
      const existing = queueRef.current.find((item) => item.target === target)
      if (existing) {
        return new Promise<PendingActionOutcome>((resolve) => {
          const previous = settlersRef.current.get(existing.id)
          settlersRef.current.set(existing.id, (outcome) => {
            previous?.(outcome)
            resolve(outcome)
          })
        })
      }
      const done = new Promise<PendingActionOutcome>((resolve) => {
        settlersRef.current.set(action.id, resolve)
      })
      commit([...queueRef.current, action])
      return done
    },
    [commit]
  )

  const cancel = useCallback(
    (target: string) => {
      const item = queueRef.current.find((action) => action.target === target)
      if (!item) return false
      commit(queueRef.current.filter((action) => action.id !== item.id))
      settle(item.id, { status: "cancelled" })
      return true
    },
    [commit, settle]
  )

  const toggle = useCallback(
    (
      kind: PendingActionKind,
      target: string,
      payload: P,
      after: readonly string[]
    ) => {
      const existing = queueRef.current.find((item) => item.target === target)
      if (existing) {
        if (Date.now() - existing.queuedAt < TOGGLE_GUARD_MS) return
        cancel(target)
        return
      }
      void enqueue(kind, target, payload, after)
    },
    [cancel, enqueue]
  )

  const cancelLast = useCallback(() => {
    const last = queueRef.current[queueRef.current.length - 1]
    return last ? cancel(last.target) : false
  }, [cancel])

  const dropAll = useCallback(() => {
    const dropped = queueRef.current
    if (dropped.length === 0) return []
    commit([])
    for (const action of dropped) {
      settle(action.id, { status: "dropped", reason: "unreachable" })
    }
    return [...dropped]
  }, [commit, settle])

  const head = queue[0] ?? null
  const headGate: ActionGate | null = head ? gate(head) : null

  useEffect(() => {
    if (!head || running) return
    if (headGate === "unsupported") {
      commit(queueRef.current.filter((action) => action.id !== head.id))
      settle(head.id, { status: "dropped", reason: "unsupported" })
      onUnsupportedRef.current(head)
      return
    }
    if (headGate !== "run") return
    // The next macrotask, like the send queue's flush: a commit in flight
    // (a turn ending, a status landing) settles first, and the gate is asked
    // again with what it left.
    const timer = setTimeout(() => {
      const current = queueRef.current[0]
      if (!current || current.id !== head.id || runningRef.current) return
      if (gateRef.current(current) !== "run") return
      runningRef.current = current
      setRunning(current)
      commit(queueRef.current.slice(1))
      void (async () => {
        let outcome: PendingActionOutcome
        try {
          outcome = { status: "ran", result: await runRef.current(current) }
        } catch (error) {
          outcome = { status: "failed", error }
        }
        runningRef.current = null
        setRunning(null)
        settle(current.id, outcome)
      })()
    }, 0)
    return () => clearTimeout(timer)
  }, [head, headGate, running, commit, settle])

  // A view that goes away takes its waiting actions with it: nobody is left
  // to run them for, and an editor waiting on one must not hang.
  useEffect(() => {
    const settlers = settlersRef.current
    return () => {
      for (const resolve of settlers.values()) resolve({ status: "cancelled" })
      settlers.clear()
    }
  }, [])

  const pendingTargets = useMemo(
    () => new Set(queue.map((action) => action.target)),
    [queue]
  )

  return {
    queue,
    running,
    pendingTargets,
    holdsSends: running !== null || headGate === "run",
    enqueue,
    toggle,
    cancel,
    cancelLast,
    dropAll,
  }
}
