/**
 * What is running for a session right now, as one list: the server's
 * `ConversationBackground` (see `acp::background_status`), which names every
 * background task, codeg delegation and sub-agent the running turn waits for.
 * The sidebar's indicator and the conversation's "Running" panel both read
 * it, so they always show the same count and the same items. The helpers
 * here are what the panel adds on top: where in the thread an item's card
 * is, and how long it has run.
 */

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { BackgroundTaskBrief, ConversationBackground } from "@/lib/types"

/** The i18n key (under `Folder.sessionActivity`) naming each kind — shared by
 *  the sidebar tooltip and the panel, so both call an item the same thing. A
 *  kind this client doesn't know reads as a plain "Task". */
export const RUNNING_KIND_KEYS = {
  subagent: "taskKind.subagent",
  agent: "taskKind.agent",
  delegation: "taskKind.delegation",
  shell: "taskKind.shell",
  monitor: "taskKind.monitor",
  workflow: "taskKind.workflow",
  task: "taskKind.task",
} as const

export function runningKindKey(kind: string) {
  return (
    RUNNING_KIND_KEYS[kind as keyof typeof RUNNING_KIND_KEYS] ??
    RUNNING_KIND_KEYS.task
  )
}

const EMPTY: BackgroundTaskBrief[] = []

/** The listed items (at most a handful; `runningCount` has them all). */
export function runningItems(
  background: ConversationBackground | null | undefined
): BackgroundTaskBrief[] {
  return background?.tasks ?? EMPTY
}

export function runningCount(
  background: ConversationBackground | null | undefined
): number {
  return background?.task_count ?? 0
}

/** One item's identity across updates: ids come from different agents'
 *  namespaces, so the kind keeps them apart (as the server does). */
export function runningItemKey(item: BackgroundTaskBrief): string {
  return `${item.kind}:${item.id}`
}

/** "0:42", "12:05", "1:02:03" — a clock reads the same in every locale. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`
}

/** Milliseconds since the server first listed `item`, or `null` when it
 *  didn't say (an older server). */
export function elapsedMs(
  item: BackgroundTaskBrief,
  now: number
): number | null {
  if (!item.started_at) return null
  const at = Date.parse(item.started_at)
  return Number.isFinite(at) ? Math.max(0, now - at) : null
}

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

/** Every tool call in `parts`, nested containers included. */
function* toolCalls(
  parts: readonly AdaptedContentPart[]
): Generator<ToolCallPart> {
  for (const part of parts) {
    if (part.type === "tool-call") {
      yield part
    } else if (part.type === "tool-group" || part.type === "goal-run") {
      yield* toolCalls(part.items)
    } else if (
      part.type === "background-task-group" ||
      part.type === "delegation-status-group"
    ) {
      yield* toolCalls(part.polls)
    }
  }
}

export function partsContainToolCall(
  parts: readonly AdaptedContentPart[],
  toolCallId: string
): boolean {
  for (const call of toolCalls(parts)) {
    if (call.toolCallId === toolCallId) return true
  }
  return false
}

/** The tool call in `parts` with this id. */
export function findToolCall(
  parts: readonly AdaptedContentPart[],
  toolCallId: string
): ToolCallPart | null {
  for (const call of toolCalls(parts)) {
    if (call.toolCallId === toolCallId) return call
  }
  return null
}

/** The first tool call whose result names `id`: how a background task the
 *  server knows only by the agent's own id (a sub-agent's `agentId`, a
 *  shell's `backgroundTaskId`) finds the call that launched it — the launch
 *  acknowledgement quotes the id. */
export function findToolCallMentioning(
  parts: readonly AdaptedContentPart[],
  id: string
): string | null {
  if (id.length < 4) return null
  for (const call of toolCalls(parts)) {
    if (
      call.toolCallId &&
      typeof call.output === "string" &&
      call.output.includes(id)
    ) {
      return call.toolCallId
    }
  }
  return null
}

/** Scroll the card of `toolCallId` (rendered by the content-parts renderer
 *  with `data-tool-call-id`, or inside a group carrying it in
 *  `data-tool-call-ids`) into view under `root`, and mark it for a moment.
 *  The card may not be mounted yet — the virtual list renders it once the
 *  row has been scrolled to — so this looks for a few frames. */
export function revealToolCallCard(
  root: ParentNode | null,
  toolCallId: string,
  { frames = 40, highlightMs = 1600 } = {}
): void {
  if (!root || typeof requestAnimationFrame === "undefined") return
  const id =
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(toolCallId)
      : toolCallId.replace(/["\\]/g, "\\$&")
  const selector = `[data-tool-call-id="${id}"], [data-tool-call-ids~="${id}"]`
  let left = frames
  const look = () => {
    const el = root.querySelector<HTMLElement>(selector)
    if (el) {
      el.scrollIntoView?.({ block: "center" })
      el.dataset.jumpHighlight = "true"
      setTimeout(() => {
        delete el.dataset.jumpHighlight
      }, highlightMs)
      return
    }
    left -= 1
    if (left > 0) requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
}
