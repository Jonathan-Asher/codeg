/**
 * One owner for everything a window refetches after its link comes back.
 *
 * Whatever the server broadcast while the socket was down is gone, so every
 * view whose state is event-driven refetches once the transport reconnects
 * (`onTransportReconnect` in `platform.ts`). Fired all at once, that was about
 * fourteen requests plus the open transcript, landing together on a server
 * that may have just restarted. The coordinator runs them as one pass instead:
 *
 * - by priority: the session on screen first, then the sidebar lists, then
 *   status (attention, agents), then the rest;
 * - at most `MAX_CONCURRENT` at a time;
 * - tasks sharing a key run once per pass, and a task whose key is still in
 *   flight from an earlier pass is joined rather than repeated;
 * - a new reconnect replaces the pass: what had not started is dropped (the
 *   new pass runs it), what is in flight finishes.
 *
 * While a pass runs the window is "syncing": the connection pill shows
 * "Updating…", and speculative work (session pre-connects) waits.
 * `getResyncGeneration()` counts passes, so a view that was hidden during one
 * (a kept-alive background tab) can catch up when it is shown again.
 */

import { perfMark } from "./perf-marks"
import type { Transport, UnsubscribeFn } from "./transport/types"

export type ResyncPriority = "visible" | "lists" | "status" | "rest"

const RANK: Record<ResyncPriority, number> = {
  visible: 0,
  lists: 1,
  status: 2,
  rest: 3,
}

const MAX_CONCURRENT = 2

export interface ResyncTaskOptions {
  priority?: ResyncPriority
  /** Tasks with the same key run once per pass. Default: unique. */
  key?: string
}

interface Task {
  id: number
  key: string
  priority: ResyncPriority
  run: () => unknown
}

interface Pass {
  generation: number
  queue: Task[]
  running: number
  startedAt: number
}

let nextTaskId = 1
const tasks = new Map<number, Task>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const boundTransports = new WeakSet<Transport>()
let pass: Pass | null = null
let generation = 0

function notify() {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error("[resync] listener threw:", err)
    }
  }
}

function runTask(task: Task): Promise<void> {
  const existing = inFlight.get(task.key)
  if (existing) return existing
  let result: unknown
  try {
    result = task.run()
  } catch (err) {
    console.error(`[resync] task ${task.key} threw:`, err)
  }
  const settled = Promise.resolve(result).then(
    () => undefined,
    (err: unknown) => {
      console.error(`[resync] task ${task.key} failed:`, err)
    }
  )
  inFlight.set(task.key, settled)
  void settled.finally(() => {
    if (inFlight.get(task.key) === settled) inFlight.delete(task.key)
  })
  return settled
}

function pump(current: Pass) {
  while (current.running < MAX_CONCURRENT && current.queue.length > 0) {
    const task = current.queue.shift()!
    current.running++
    void runTask(task).finally(() => {
      if (pass !== current) return
      current.running--
      pump(current)
    })
  }
  if (pass === current && current.running === 0 && current.queue.length === 0) {
    pass = null
    perfMark("resync:pass:end", {
      generation: current.generation,
      ms: Date.now() - current.startedAt,
    })
    notify()
  }
}

/** Start a pass over every registered task (a reconnect landed). */
export function startResyncPass(): void {
  generation++
  const seen = new Set<string>()
  const queue = [...tasks.values()]
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.id - b.id)
    .filter((task) => {
      if (seen.has(task.key)) return false
      seen.add(task.key)
      return true
    })
  const next: Pass = {
    generation,
    queue,
    running: 0,
    startedAt: Date.now(),
  }
  pass = next
  perfMark("resync:pass:start", { generation, tasks: queue.length })
  notify()
  pump(next)
}

/**
 * Register a task for every reconnect of `transport`. Returns null when the
 * transport has no reconnect lifecycle (local IPC): nothing to recover.
 */
export function registerResyncTask(
  transport: Transport,
  run: () => unknown,
  options?: ResyncTaskOptions
): UnsubscribeFn | null {
  if (typeof transport.onReconnect !== "function") return null
  if (!boundTransports.has(transport)) {
    boundTransports.add(transport)
    transport.onReconnect(startResyncPass)
  }
  const id = nextTaskId++
  tasks.set(id, {
    id,
    key: options?.key ?? `task-${id}`,
    priority: options?.priority ?? "rest",
    run,
  })
  return () => {
    tasks.delete(id)
  }
}

/** True while a reconnect's refetch pass is running. */
export function isResyncing(): boolean {
  return pass !== null
}

/** When the running pass started, or null. */
export function resyncStartedAt(): number | null {
  return pass?.startedAt ?? null
}

/** Passes started so far in this window. */
export function getResyncGeneration(): number {
  return generation
}

export function subscribeResync(listener: () => void): UnsubscribeFn {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: forget every task, pass and binding. */
export function __resetResyncForTests(): void {
  tasks.clear()
  inFlight.clear()
  listeners.clear()
  pass = null
  generation = 0
  nextTaskId = 1
}
