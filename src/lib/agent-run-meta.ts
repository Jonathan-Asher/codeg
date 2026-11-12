/**
 * The cards codeg's Pi parser folds delegated work into
 * (`src-tauri/crates/codeg-lib/src/parsers/pi/fold.rs`), read off a tool
 * call's `_meta`. A live Pi connection sends the same cards
 * (`parsers/pi/live.rs` reshapes pi-acp's own), on the call while its turn
 * runs and as `tool_card` updates after (`live-tool-cards-context`), plus a few
 * fields only a run still going has (`activity`, `running`):
 *
 * - `codeg.subagentRun` on the `Agent` call that started a pi-subagents run:
 *   its status, its result, and one row per child;
 * - `codeg.backgroundJob` on a `bgj_run` command: how the job ended;
 * - `codeg.agentWake` on the marker opening a run the agent started by itself,
 *   because a notice arrived after it had gone idle.
 *
 * Each parser returns `null` for anything else, so a card whose `_meta` lacks
 * the key (or carries a shape it does not know) renders exactly as before.
 */

export const SUBAGENT_RUN_META_KEY = "codeg.subagentRun"
export const BACKGROUND_JOB_META_KEY = "codeg.backgroundJob"
export const AGENT_WAKE_META_KEY = "codeg.agentWake"
/** A displayed notice no card claims, live (`acp::pi_meta`): drawn as the
 *  System note history shows for it. */
export const SYSTEM_NOTE_META_KEY = "codeg.systemNote"

export type SubagentRunStatus =
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "running"
  | "pending"

/** A question a child asked its parent, and the parent's answer. */
export interface SubagentRunExchange {
  question: string
  answer: string | null
}

/** One child of a run: a workflow lane, a parallel task or a chain step. */
export interface SubagentRunChild {
  key: string
  /** What to call the child: its workflow key, else its agent. */
  label: string
  agent: string | null
  status: SubagentRunStatus | null
  task: string | null
  error: string | null
  result: string | null
  /** The child's own session, openable with `getConversation`. */
  sessionId: string | null
  model: string | null
  tokens: number | null
  turns: number | null
  exchanges: SubagentRunExchange[]
  attention: string[]
  /** Live only, while the child works: its current tool. */
  currentTool: string | null
}

/** Text the model was given that the card now shows as structure. */
export interface ModelNote {
  kind: string
  text: string
}

export interface SubagentRun {
  /** `single` / `parallel` / `chain` / `workflow`. */
  mode: string
  async: boolean
  /** `pending` = launched in the background, no outcome in the transcript. */
  status: SubagentRunStatus
  agent: string | null
  task: string | null
  durationMs: number | null
  tokens: number | null
  /** The run's own result (a workflow's return value, a child's report). */
  result: string | null
  error: string | null
  children: SubagentRunChild[]
  notes: ModelNote[]
}

export type BackgroundJobState =
  | "completed"
  | "failed"
  | "killed"
  | "unknown"
  | "pending"
  | "running"

export interface BackgroundJob {
  id: string | null
  /** `pending` = no exit recorded in the transcript; `unknown` = it ended
   *  with no exit code; `running` = live, the job is still going. */
  state: BackgroundJobState
  exitCode: number | null
  killedBy: string | null
  /** As pi-bg-jobs spells it: `58s`, `3m 52s`. */
  duration: string | null
  /** The last lines of the job's output. */
  tail: string | null
  /** The exit notice as the model read it. */
  notice: string | null
}

export type AgentWakeKind =
  | "subagentQuestion"
  | "subagentSettled"
  | "subagentAttention"
  | "jobExit"
  | "extension"

export interface AgentWake {
  triggers: Array<{ kind: AgentWakeKind; text: string }>
}

type Meta = Record<string, unknown> | null | undefined

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "paused",
  "stopped",
  "running",
  "pending",
])

function runStatus(value: unknown): SubagentRunStatus | null {
  return typeof value === "string" && RUN_STATUSES.has(value)
    ? (value as SubagentRunStatus)
    : null
}

function notes(value: unknown): ModelNote[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const note = record(item)
    const body = text(note?.text)
    return note && body
      ? [{ kind: text(note.kind) ?? "notice", text: body }]
      : []
  })
}

function child(value: unknown): SubagentRunChild | null {
  const row = record(value)
  const key = text(row?.key)
  if (!row || !key) return null
  const exchanges = Array.isArray(row.exchanges)
    ? row.exchanges.flatMap((item) => {
        const exchange = record(item)
        const question = text(exchange?.question)
        return question ? [{ question, answer: text(exchange?.answer) }] : []
      })
    : []
  const attention = Array.isArray(row.attention)
    ? row.attention.filter((a): a is string => typeof a === "string" && !!a)
    : []
  return {
    key,
    label: text(row.label) ?? key,
    agent: text(row.agent),
    status: runStatus(row.status),
    task: text(row.task),
    error: text(row.error),
    result: text(row.result),
    sessionId: text(row.sessionId),
    model: text(row.model),
    tokens: count(row.tokens),
    turns: count(row.turns),
    exchanges,
    attention,
    currentTool: text(record(row.activity)?.currentTool),
  }
}

/** The sub-agent run card on an `Agent` call, or `null`. */
export function parseSubagentRun(meta: Meta): SubagentRun | null {
  const run = record(meta?.[SUBAGENT_RUN_META_KEY])
  const status = runStatus(run?.status)
  if (!run || !status) return null
  return {
    mode: text(run.mode) ?? "single",
    async: run.async === true,
    status,
    agent: text(run.agent),
    task: text(run.task),
    durationMs: count(run.durationMs),
    tokens: count(run.tokens),
    result: text(run.result),
    error: text(run.error),
    children: Array.isArray(run.children)
      ? run.children.map(child).filter((c): c is SubagentRunChild => c !== null)
      : [],
    notes: notes(run.notes),
  }
}

const JOB_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "killed",
  "unknown",
  "pending",
  "running",
])

/** How the background job a `bgj_run` started ended, or `null`. */
export function parseBackgroundJob(meta: Meta): BackgroundJob | null {
  const job = record(meta?.[BACKGROUND_JOB_META_KEY])
  const state = job?.state
  if (!job || typeof state !== "string" || !JOB_STATES.has(state)) {
    return null
  }
  return {
    id: text(job.id),
    state: state as BackgroundJobState,
    exitCode: count(job.exitCode),
    killedBy: text(job.killedBy),
    duration: text(job.duration),
    tail: text(job.tail),
    notice: text(job.notice),
  }
}

const WAKE_KINDS: ReadonlySet<string> = new Set([
  "subagentQuestion",
  "subagentSettled",
  "subagentAttention",
  "jobExit",
  "extension",
])

/** The marker of a run the agent started by itself, or `null`. */
export function parseAgentWake(meta: Meta): AgentWake | null {
  const wake = record(meta?.[AGENT_WAKE_META_KEY])
  if (!wake || !Array.isArray(wake.triggers)) return null
  const triggers = wake.triggers.map((item) => {
    const trigger = record(item)
    const kind = trigger?.kind
    return {
      kind: (typeof kind === "string" && WAKE_KINDS.has(kind)
        ? kind
        : "extension") as AgentWakeKind,
      text: text(trigger?.text) ?? "",
    }
  })
  return triggers.length > 0 ? { triggers } : null
}

/** `7921` → `7.9K`: token counts in the rows' compact meta line. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`
  }
  const m = value / 1_000_000
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`
}

/** The first non-blank line of a block of text. */
export function firstLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}
