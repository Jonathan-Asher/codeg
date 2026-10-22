"use client"

/**
 * The conversation's "Running" panel: everything working for the session
 * right now, in one place at the top of the transcript, whatever started it —
 * a sub-agent the turn waits for (Claude's Agent tool), one launched into the
 * background, a codeg delegation, a background shell, monitor or workflow.
 *
 * The list is the server's (`ConversationBackground`, see
 * `acp::background_status`) — the value the sidebar's indicator reads — so
 * the two always show the same count and name the same items. What this
 * client adds is the way to each item: its card in the thread, a
 * delegation's own conversation, a background task's output and stop.
 *
 * Positioned by the overlay stack in `MessageListView`: it floats over the
 * transcript and never pushes it. Collapses to a chip like the plan panel
 * (the choice is remembered). An item that finishes says "Done" or "Failed"
 * for a few seconds, then leaves.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FileText,
  Loader2,
  PauseCircle,
  Square,
  TerminalIcon,
  Workflow,
  XIcon,
} from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { CollapsedOverlayChip } from "@/components/chat/collapsed-overlay-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useSessionViewerHost } from "@/components/message/session-viewer-host"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import { liveAsyncTasks } from "@/lib/async-tasks"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  elapsedMs,
  formatElapsed,
  runningCount,
  runningItemKey,
  runningItems,
  runningKindKey,
} from "@/lib/running-work"
import type {
  AsyncTaskRecord,
  BackgroundTaskBrief,
  ConversationBackground,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** How long a finished item stays to say how it ended. */
const FINISHED_LINGER_MS = 4000
const EXPANDED_STORAGE_KEY = "codeg:running-overlay-expanded"

export type RunningOutcome = "done" | "failed"

/** Where an item leads: its card in the thread, and for a delegation the
 *  source its own conversation opens from. */
export interface RunningItemTarget {
  toolCallId: string | null
  delegation: DelegationCardSource | null
}

interface SubAgentOverlayProps {
  /** The session's running list (`conversation-background-store`). */
  background: ConversationBackground | null | undefined
  /** The adapter's background tasks: their output files and stop control. */
  asyncTasks?: AsyncTaskRecord[]
  onStopAsyncTask?: (taskId: string) => Promise<boolean>
  /** Find an item in the thread. */
  locate?: (item: BackgroundTaskBrief) => RunningItemTarget
  /** Scroll the thread to a tool call's card. */
  onJumpToToolCall?: (toolCallId: string) => void
  /** How an item that just left the list ended, as the thread tells it. */
  outcomeOf?: (item: BackgroundTaskBrief) => RunningOutcome
  /** Collapsed when the user hasn't chosen yet. */
  defaultExpanded?: boolean
}

interface FinishedItem {
  item: BackgroundTaskBrief
  outcome: RunningOutcome
  until: number
}

function readExpanded(fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
    return stored == null ? fallback : stored === "1"
  } catch {
    return fallback
  }
}

function writeExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? "1" : "0")
  } catch {
    // Storage unavailable: the choice lasts for this view only.
  }
}

/** A clock that ticks once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

export const SubAgentOverlay = memo(function SubAgentOverlay({
  background,
  asyncTasks,
  onStopAsyncTask,
  locate,
  onJumpToToolCall,
  outcomeOf,
  defaultExpanded = false,
}: SubAgentOverlayProps) {
  const t = useTranslations("Folder.chat.subAgentOverlay")
  const [expanded, setExpanded] = useState(() => readExpanded(defaultExpanded))
  const items = runningItems(background)
  const count = runningCount(background)

  // Items that left the list since the last reading say how they ended for
  // a moment. Only a shrinking count means something finished — an item can
  // also drop off the listed few when more start.
  const [finished, setFinished] = useState<FinishedItem[]>([])
  const previous = useRef({ items, count })
  useEffect(() => {
    const before = previous.current
    previous.current = { items, count }
    const live = new Set(items.map(runningItemKey))
    const gone =
      count < before.count
        ? before.items.filter((item) => !live.has(runningItemKey(item)))
        : []
    const until = Date.now() + FINISHED_LINGER_MS
    // The list itself is the server's; this only remembers what just left.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFinished((current) => {
      const kept = current.filter((f) => !live.has(runningItemKey(f.item)))
      if (gone.length === 0 && kept.length === current.length) return current
      return [
        ...kept,
        ...gone.map((item) => ({
          item,
          outcome: outcomeOf?.(item) ?? "done",
          until,
        })),
      ]
    })
  }, [items, count, outcomeOf])
  useEffect(() => {
    if (finished.length === 0) return
    const next = Math.min(...finished.map((f) => f.until))
    const timer = setTimeout(
      () =>
        setFinished((current) => current.filter((f) => f.until > Date.now())),
      Math.max(0, next - Date.now()) + 50
    )
    return () => clearTimeout(timer)
  }, [finished])

  const now = useNow(expanded && items.length > 0)
  const toggle = useCallback((next: boolean) => {
    setExpanded(next)
    writeExpanded(next)
  }, [])

  if (count === 0 && items.length === 0 && finished.length === 0) {
    return null
  }

  if (!expanded) {
    return (
      <div data-testid="running-overlay" data-count={count}>
        <CollapsedOverlayChip
          icon={
            count > 0 ? (
              <span className="text-[0.625rem] font-semibold tabular-nums">
                {count}
              </span>
            ) : (
              <BotIcon className="size-3" />
            )
          }
          summary={t("collapsedSummary", { count })}
          onClick={() => toggle(true)}
        />
      </div>
    )
  }

  const unlisted = count - items.length
  return (
    <div
      data-testid="running-overlay"
      data-count={count}
      className="pointer-events-none flex max-w-[min(22rem,calc(100%-2rem))]"
    >
      <div className="pointer-events-auto w-72 max-w-full rounded-xl border bg-card/60 shadow-lg backdrop-blur transition-colors hover:bg-card/95 supports-[backdrop-filter]:bg-card/50 supports-[backdrop-filter]:hover:bg-card/85">
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <BotIcon className="h-4 w-4 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{t("title")}</span>
            <Badge variant="secondary" className="h-5">
              {count}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("collapseAria")}
            onClick={() => toggle(false)}
          >
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </div>
        <ul className="max-h-80 space-y-1 overflow-y-auto p-1.5">
          {items.map((item) => (
            <RunningRow
              key={runningItemKey(item)}
              item={item}
              now={now}
              asyncTask={asyncTasks?.find((task) => task.task_id === item.id)}
              onStopAsyncTask={onStopAsyncTask}
              locate={locate}
              onJumpToToolCall={onJumpToToolCall}
            />
          ))}
          {finished.map((f) => (
            <RunningRow
              key={`done-${runningItemKey(f.item)}`}
              item={f.item}
              now={now}
              outcome={f.outcome}
              locate={locate}
              onJumpToToolCall={onJumpToToolCall}
            />
          ))}
          {unlisted > 0 && (
            <li className="px-2 py-0.5 text-2xs text-muted-foreground">
              {t("more", { count: unlisted })}
            </li>
          )}
        </ul>
      </div>
    </div>
  )
})

const KIND_ICONS: Record<string, typeof TerminalIcon> = {
  subagent: BotIcon,
  agent: BotIcon,
  shell: TerminalIcon,
  monitor: Activity,
  workflow: Workflow,
}

const RunningRow = memo(function RunningRow({
  item,
  now,
  outcome,
  asyncTask,
  onStopAsyncTask,
  locate,
  onJumpToToolCall,
}: {
  item: BackgroundTaskBrief
  now: number
  /** Set once the item has finished. */
  outcome?: RunningOutcome
  asyncTask?: AsyncTaskRecord
  onStopAsyncTask?: (taskId: string) => Promise<boolean>
  locate?: (item: BackgroundTaskBrief) => RunningItemTarget
  onJumpToToolCall?: (toolCallId: string) => void
}) {
  const t = useTranslations("Folder.chat.subAgentOverlay")
  const tKind = useTranslations("Folder.sessionActivity")
  const viewerHost = useSessionViewerHost()
  const paused = asyncTask?.state === "paused"
  const kindLabel =
    item.kind === "delegation" && item.agent_type
      ? `${tKind(runningKindKey(item.kind))} · ${getAgentLabel(item.agent_type)}`
      : tKind(runningKindKey(item.kind))
  const elapsed = outcome ? null : elapsedMs(item, now)
  const Icon = KIND_ICONS[item.kind] ?? Activity
  const status: "running" | "paused" | RunningOutcome =
    outcome ?? (paused ? "paused" : "running")

  // Resolved on click, not per render: the thread changes with every token.
  const open = () => {
    const target = locate?.(item)
    if (!target) return
    if (item.kind === "delegation" && target.delegation && viewerHost) {
      viewerHost.open({ kind: "delegation", source: target.delegation })
      return
    }
    if (target.toolCallId) onJumpToToolCall?.(target.toolCallId)
  }
  const openable =
    Boolean(locate) && (Boolean(onJumpToToolCall) || item.kind === "delegation")

  return (
    <li
      data-testid="running-item"
      data-kind={item.kind}
      data-status={status}
      data-item-id={item.id}
      className={cn(
        "flex items-center gap-1 rounded-lg border bg-transparent",
        outcome && "opacity-70"
      )}
    >
      <button
        type="button"
        disabled={!openable}
        onClick={open}
        title={item.kind === "delegation" ? t("openTranscript") : t("openCard")}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-start transition-colors enabled:hover:bg-muted/60"
      >
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground">
          {item.kind === "delegation" && item.agent_type ? (
            <AgentIcon agentType={item.agent_type} className="size-3.5" />
          ) : (
            <Icon aria-hidden="true" className="size-3" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            {item.label || kindLabel}
          </span>
          <span className="flex items-center gap-1 text-2xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {item.label ? kindLabel : null}
            </span>
            <StatusMark status={status} />
            {elapsed != null && (
              <span className="ms-auto shrink-0 tabular-nums">
                {formatElapsed(elapsed)}
              </span>
            )}
          </span>
        </span>
      </button>
      {asyncTask && !outcome && liveAsyncTasks([asyncTask]).length > 0 && (
        <AsyncTaskControls task={asyncTask} onStop={onStopAsyncTask} />
      )}
    </li>
  )
})

function StatusMark({
  status,
}: {
  status: "running" | "paused" | RunningOutcome
}) {
  const t = useTranslations("Folder.chat.subAgentOverlay.status")
  const [Icon, tone, spin] =
    status === "running"
      ? [Loader2, "text-primary", true]
      : status === "paused"
        ? [PauseCircle, "text-muted-foreground", false]
        : status === "done"
          ? [CheckIcon, "text-green-600", false]
          : [XIcon, "text-destructive", false]
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Icon
        aria-hidden="true"
        className={cn("size-3", tone, spin && "animate-spin")}
      />
      {t(status)}
    </span>
  )
}

/** A background task's output file and stop, as the adapter offers them. */
function AsyncTaskControls({
  task,
  onStop,
}: {
  task: AsyncTaskRecord
  onStop?: (taskId: string) => Promise<boolean>
}) {
  const t = useTranslations("Folder.chat.asyncTasks")
  const { openFilePreview } = useWorkspaceActions()
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    if (!onStop || stopping) return
    setStopping(true)
    try {
      await onStop(task.task_id)
    } finally {
      // The row leaves when the task's terminal state arrives; a declined
      // stop must leave the button usable.
      setStopping(false)
    }
  }
  return (
    <span className="flex shrink-0 items-center pe-1">
      {task.output_file_path && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("openOutput")}
          title={t("openOutput")}
          onClick={() => void openFilePreview(task.output_file_path!)}
        >
          <FileText aria-hidden="true" className="size-3" />
        </Button>
      )}
      {task.can_stop && onStop && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("stop")}
          title={t("stop")}
          disabled={stopping}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => void stop()}
        >
          {stopping ? (
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <Square aria-hidden="true" className="size-3" />
          )}
        </Button>
      )}
    </span>
  )
}
