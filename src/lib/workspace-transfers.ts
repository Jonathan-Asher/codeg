import { useSyncExternalStore } from "react"

import { RateMeter } from "./transfer-format"
import { getShellTransport, isDesktop } from "./transport"

/**
 * Downloads from a remote workspace, as the progress UI sees them.
 *
 * A remote-desktop download is one long `invoke` that only resolves once the
 * last byte is on disk; the Rust side reports progress in between on the
 * `workspace://transfer-progress` event. This store joins the two: the API
 * layer registers a transfer (under an id it picked and passed to Rust) the
 * moment the save dialog closes, the event stream fills in the bytes, and the
 * invoke's settlement records the outcome. The toast host and the status-bar
 * indicator render from here, so every caller of `downloadWorkspaceFile` gets
 * progress without doing anything.
 *
 * Deliberately free of any `api.ts` import (which imports this module).
 */

export type TrackedTransferStatus = "running" | "done" | "error" | "cancelled"

export interface TrackedTransfer {
  id: string
  /** File name as saved (the save dialog may have renamed it). */
  name: string
  /** Absolute local path the file is being written to. */
  savePath: string | null
  loaded: number
  /** Unknown for a streamed directory ZIP (no Content-Length). */
  total: number | null
  status: TrackedTransferStatus
  error: string | null
  /** Bytes per second over the last few seconds; null until measurable. */
  rate: number | null
  startedAt: number
  finishedAt: number | null
  cancelRequested: boolean
}

/** Payload of `workspace://transfer-progress` (mirrors the Rust struct). */
export interface TransferProgressEvent {
  transferId: string
  direction: "upload" | "download"
  loaded: number
  total: number | null
  state: "running" | "done" | "cancelled" | "error"
  path?: string | null
  error?: string | null
}

export const TRANSFER_PROGRESS_EVENT = "workspace://transfer-progress"

/** A finished (done / cancelled) row lingers this long, then drops out. */
const FINISHED_RETENTION_MS = 60_000

let transfers: readonly TrackedTransfer[] = []
const listeners = new Set<() => void>()
const meters = new Map<string, RateMeter>()
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
let listening: Promise<unknown> | null = null

function emit() {
  for (const listener of listeners) listener()
}

function patch(
  id: string,
  update: (transfer: TrackedTransfer) => TrackedTransfer
): void {
  let changed = false
  transfers = transfers.map((transfer) => {
    if (transfer.id !== id) return transfer
    changed = true
    return update(transfer)
  })
  if (changed) emit()
}

function find(id: string): TrackedTransfer | undefined {
  return transfers.find((transfer) => transfer.id === id)
}

function scheduleCleanup(id: string) {
  const existing = cleanupTimers.get(id)
  if (existing) clearTimeout(existing)
  cleanupTimers.set(
    id,
    setTimeout(() => {
      cleanupTimers.delete(id)
      dismissTrackedTransfer(id)
    }, FINISHED_RETENTION_MS)
  )
}

function ensureProgressListener() {
  if (listening || !isDesktop()) return
  listening = import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<TransferProgressEvent>(TRANSFER_PROGRESS_EVENT, (event) =>
        applyTransferProgress(event.payload)
      )
    )
    .catch((err) => {
      listening = null
      console.warn("[transfers] progress listener failed:", err)
    })
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTransfersSnapshot(): readonly TrackedTransfer[] {
  return transfers
}

const EMPTY: readonly TrackedTransfer[] = []
const getServerSnapshot = () => EMPTY

/** Every tracked transfer, oldest first. */
export function useWorkspaceTransfers(): readonly TrackedTransfer[] {
  return useSyncExternalStore(
    subscribeTransfers,
    getTransfersSnapshot,
    getServerSnapshot
  )
}

/** One transfer by id (undefined once dismissed). */
export function useWorkspaceTransfer(id: string): TrackedTransfer | undefined {
  return useWorkspaceTransfers().find((transfer) => transfer.id === id)
}

/** An id in the shape the Rust side accepts (`[A-Za-z0-9_-]{1,64}`). */
export function newTransferId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `dl-${random}`
}

export function beginTrackedDownload(args: {
  id: string
  name: string
  savePath: string | null
}): void {
  ensureProgressListener()
  const now = Date.now()
  meters.set(args.id, new RateMeter())
  transfers = [
    ...transfers.filter((transfer) => transfer.id !== args.id),
    {
      id: args.id,
      name: args.name,
      savePath: args.savePath,
      loaded: 0,
      total: null,
      status: "running",
      error: null,
      rate: null,
      startedAt: now,
      finishedAt: null,
      cancelRequested: false,
    },
  ]
  emit()
}

/** Fold one progress event into its transfer. Events for ids this window
 *  didn't start (another window's download, an upload) are ignored, and a
 *  settled transfer ignores late events. */
export function applyTransferProgress(
  event: TransferProgressEvent,
  now: number = Date.now()
): void {
  if (event.direction !== "download") return
  const current = find(event.transferId)
  if (!current || current.status !== "running") return
  switch (event.state) {
    case "running": {
      const meter = meters.get(current.id)
      meter?.push(now, event.loaded)
      patch(current.id, (transfer) => ({
        ...transfer,
        loaded: event.loaded,
        total: event.total ?? transfer.total,
        rate: meter?.rate() ?? transfer.rate,
      }))
      return
    }
    case "done":
      completeTrackedDownload(current.id, event.loaded)
      return
    case "cancelled":
      markTrackedDownloadCancelled(current.id)
      return
    case "error":
      failTrackedDownload(current.id, event.error ?? "")
      return
  }
}

export function completeTrackedDownload(id: string, bytes?: number): void {
  meters.delete(id)
  patch(id, (transfer) => {
    const loaded = bytes ?? transfer.loaded
    return {
      ...transfer,
      status: "done",
      loaded,
      total: transfer.total ?? loaded,
      rate: null,
      finishedAt: Date.now(),
    }
  })
  scheduleCleanup(id)
}

export function failTrackedDownload(id: string, message: string): void {
  meters.delete(id)
  patch(id, (transfer) => ({
    ...transfer,
    status: "error",
    error: message || transfer.error,
    rate: null,
    finishedAt: Date.now(),
  }))
}

export function markTrackedDownloadCancelled(id: string): void {
  meters.delete(id)
  patch(id, (transfer) => ({
    ...transfer,
    status: "cancelled",
    rate: null,
    finishedAt: Date.now(),
  }))
  scheduleCleanup(id)
}

const TRANSFER_ERROR_REPORTED = Symbol.for("codeg.transferErrorReported")

/** Tag a download error the transfer UI has already put on screen, so the
 *  caller that awaited the download doesn't toast it a second time. */
export function markTransferErrorReported(err: unknown): unknown {
  const tagged =
    err !== null && typeof err === "object" ? err : new Error(String(err))
  try {
    Object.defineProperty(tagged, TRANSFER_ERROR_REPORTED, { value: true })
  } catch {
    // A frozen error object just won't carry the tag; the caller then toasts
    // it too, which is a duplicate rather than a silent failure.
  }
  return tagged
}

/** True when a download failure is already shown by the transfer UI. */
export function isTransferErrorReported(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as Record<symbol, unknown>)[TRANSFER_ERROR_REPORTED] === true
  )
}

export function wasCancelRequested(id: string): boolean {
  return find(id)?.cancelRequested === true
}

/** Ask Rust to stop a running download. The invoke then rejects and the API
 *  layer records the cancellation; the partial file is removed on the Rust
 *  side. */
export async function cancelTrackedDownload(id: string): Promise<void> {
  const current = find(id)
  if (!current || current.status !== "running") return
  patch(id, (transfer) => ({ ...transfer, cancelRequested: true }))
  try {
    // The shell transport: in a remote-workspace window the download runs in
    // THIS app's Rust process, not on the remote server.
    await getShellTransport().call<boolean>(
      "remote_cancel_workspace_transfer",
      { transferId: id }
    )
  } catch (err) {
    console.warn("[transfers] cancel failed:", err)
    patch(id, (transfer) => ({ ...transfer, cancelRequested: false }))
  }
}

/** Remove a row (the user closed it, or a finished one aged out). */
export function dismissTrackedTransfer(id: string): void {
  const timer = cleanupTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    cleanupTimers.delete(id)
  }
  meters.delete(id)
  const next = transfers.filter((transfer) => transfer.id !== id)
  if (next.length === transfers.length) return
  transfers = next
  emit()
}

/**
 * Test-only: forget every transfer and timer.
 * @internal
 */
export function __resetWorkspaceTransfersForTests(): void {
  if (process.env.NODE_ENV !== "test") return
  for (const timer of cleanupTimers.values()) clearTimeout(timer)
  cleanupTimers.clear()
  meters.clear()
  transfers = []
  listening = null
  emit()
}
