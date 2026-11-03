"use client"

import { create } from "zustand"

import type { OutsideWriter } from "@/lib/outside-writer"

/**
 * Where a session's wait for another process stands.
 *
 * - `waiting`: codeg waits for the process to finish, then connects.
 * - `stopped`: the user stopped waiting; codeg connects only when asked.
 * - `connecting_anyway`: the user chose to connect while the process still
 *   runs, and that connect is on its way.
 */
export type OutsideWriterPhase = "waiting" | "stopped" | "connecting_anyway"

export interface OutsideWriterEntry {
  writer: OutsideWriter
  phase: OutsideWriterPhase
}

interface OutsideWriterState {
  /** Agent session id → the process codeg did not start that runs it. */
  bySession: Record<string, OutsideWriterEntry>
}

/**
 * Sessions a process codeg did not start is running (see
 * `lib/outside-writer`). A connect the backend refused for that reason puts
 * the session here; while it is here its tab holds back every connect of its
 * own and says why; it leaves once that process has finished, or once a
 * connect went through.
 */
export const useOutsideWriterStore = create<OutsideWriterState>()(() => ({
  bySession: {},
}))

function put(sessionId: string, entry: OutsideWriterEntry | null): void {
  useOutsideWriterStore.setState((state) => {
    const bySession = { ...state.bySession }
    if (entry) bySession[sessionId] = entry
    else delete bySession[sessionId]
    return { bySession }
  })
}

/** A connect to `sessionId` was refused because `writer` runs it: wait. */
export function reportOutsideWriter(
  sessionId: string,
  writer: OutsideWriter
): void {
  put(sessionId, { writer, phase: "waiting" })
}

/** The process still runs; keep what the user chose, take its latest. */
export function updateOutsideWriter(
  sessionId: string,
  writer: OutsideWriter
): void {
  const entry = outsideWriterFor(sessionId)
  if (!entry) return
  const same =
    entry.writer.pid === writer.pid &&
    entry.writer.startedAt === writer.startedAt &&
    (entry.writer.status ?? null) === (writer.status ?? null)
  if (!same) put(sessionId, { ...entry, writer })
}

/** The user stopped waiting: no connect until they ask for one. */
export function stopWaitingForOutsideWriter(sessionId: string): void {
  const entry = outsideWriterFor(sessionId)
  if (entry && entry.phase !== "stopped") {
    put(sessionId, { ...entry, phase: "stopped" })
  }
}

/** A "Connect anyway" did not go through: the user can choose again. */
export function resumeWaitingForOutsideWriter(sessionId: string): void {
  const entry = outsideWriterFor(sessionId)
  if (entry && entry.phase !== "waiting") {
    put(sessionId, { ...entry, phase: "waiting" })
  }
}

/** The user chose to connect while the process still runs. */
export function markConnectingAnyway(sessionId: string): void {
  const entry = outsideWriterFor(sessionId)
  if (entry) put(sessionId, { ...entry, phase: "connecting_anyway" })
}

/** The process finished, or a connect went through: nothing to wait for. */
export function clearOutsideWriter(sessionId: string): void {
  if (outsideWriterFor(sessionId)) put(sessionId, null)
}

export function outsideWriterFor(
  sessionId: string | null | undefined
): OutsideWriterEntry | undefined {
  if (!sessionId) return undefined
  return useOutsideWriterStore.getState().bySession[sessionId]
}
