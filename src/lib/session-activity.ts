import { waitingLimitPause } from "@/lib/limit-continue"
import type {
  AttentionKind,
  ConnectionStatus,
  ConversationBackground,
  ConversationTurnState,
  DbConversationSummary,
  LimitPause,
} from "@/lib/types"

/**
 * What a session is doing right now — the question "is it stuck?" needs
 * answered, and one the conversation's `status` cannot answer: that is its
 * review state (open / review / completed / cancelled), which reads the same
 * for a session that is working, one waiting for you, one idle for days and
 * one whose turn was killed.
 *
 * - `working`: a turn is in flight — one codeg sent, or one the agent runs by
 *   itself after its background work woke it (a task notification, a cron
 *   prompt), which the persisted `turn_state` never shows.
 * - `background`: the agent is idle while its background work runs — a turn
 *   held open only for background tasks (a message runs right away, see
 *   `lib/background-idle.ts`), or tasks still running after the turn ended.
 *   Known from this client's own live connection, or for any session from the
 *   server's live status (`conversation-background-store`).
 * - `needs_you`: the agent is blocked on a permission, a question or a plan
 *   approval.
 * - `idle`: nothing is running.
 * - `interrupted`: the last turn was cut off before it finished — codeg quit
 *   or crashed, or the agent process or its connection died mid-turn.
 * - `limit_paused`: the last turn stopped on the account's usage limit, and
 *   the session continues by itself once the limit resets
 *   (`lib/limit-continue.ts`).
 * - `connecting`: this client is opening the session (the agent is starting
 *   or resuming it) and it cannot take a prompt yet.
 * - `connect_failed`: this client's attempt to open the session failed; the
 *   agent cannot be reached until it is retried.
 */
export type SessionActivity =
  | "working"
  | "background"
  | "needs_you"
  | "idle"
  | "interrupted"
  | "limit_paused"
  | "connecting"
  | "connect_failed"

/** The i18n key (under `Folder.sessionActivity`) naming each state. Literal
 *  on purpose: next-intl keys are typed, and a key read out of a variable must
 *  stay a literal type. `background` takes a `{count}` of running tasks
 *  (0 = unknown); the others ignore it. */
export const SESSION_ACTIVITY_LABEL_KEYS = {
  working: "working",
  background: "background",
  needs_you: "needsYou",
  idle: "idle",
  interrupted: "interrupted",
  limit_paused: "limitPaused",
  connecting: "connecting",
  connect_failed: "connectFailed",
} as const satisfies Record<SessionActivity, string>

/** The i18n key (under `Folder.sessionActivity`) with a one-line explanation
 *  of each state. */
export const SESSION_ACTIVITY_HINT_KEYS = {
  working: "workingHint",
  background: "backgroundHint",
  needs_you: "needsYouHint",
  idle: "idleHint",
  interrupted: "interruptedHint",
  limit_paused: "limitPausedHint",
  connecting: "connectingHint",
  connect_failed: "connectFailedHint",
} as const satisfies Record<SessionActivity, string>

/** The prompt the Continue action sends to pick an interrupted turn back up.
 *  Deliberately not localized: it goes to the agent, not the user. */
export const CONTINUE_PROMPT = "continue"

export interface SessionActivityInputs {
  /** What the session is blocked on, from the attention store (every client
   *  gets it live, for every session). */
  attention?: AttentionKind | null
  /** The summary's persisted `turn_state`. `undefined` means the server
   *  predates the field (a newer desktop client talking to an older remote
   *  server); `null` means no turn. */
  turnState?: ConversationTurnState | null
  /** The summary's review `status`. Only consulted when `turnState` is
   *  unavailable, as the older server's best guess. */
  status?: string | null
  /** This client's OWN live connection status for the conversation, when it
   *  holds one (the conversation is open in a tab here). First-hand, so it
   *  wins over the persisted state, which reaches this client an event later.
   *  Leave it out for rows this client has no connection for. */
  connectionStatus?: ConnectionStatus | null
  /** Where this client's own attempt to open the session stands, when it is
   *  making one: `connecting` while the agent starts or resumes the session,
   *  `failed` when that attempt failed. Ranks above the persisted turn state —
   *  a session that cannot be reached is not "idle", whatever its last turn
   *  did — but below a turn running or blocked on the user. */
  connection?: "connecting" | "failed" | null
  /** This client's own live connection says its prompting turn is held open
   *  only for background work (the agent is idle). Only meaningful together
   *  with `connectionStatus === "prompting"`. */
  awaitingBackground?: boolean
  /** The summary's usage-limit pause (`limit_pause`). Waiting for the reset
   *  reads as `limit_paused` — below a turn running, blocked on the user, or
   *  this client's own connect state. */
  limitPause?: LimitPause | null
  /** The server's live background status for the session
   *  (`conversation-background-store`): background tasks running, the agent
   *  working out of turn, a turn held open. Absent when there is none, and
   *  always against a server that predates it — which then reads exactly as
   *  before. */
  background?: ConversationBackground | null
}

/**
 * Derive a session's activity from the live signals codeg already keeps:
 * the attention store (blocked on the user), the connection status (a turn
 * streaming on this client), and the turn state the backend persists at every
 * turn's edges (which also carries "interrupted" across a restart).
 */
export function deriveSessionActivity({
  attention,
  turnState,
  status,
  connectionStatus,
  connection,
  awaitingBackground,
  limitPause,
  background,
}: SessionActivityInputs): SessionActivity {
  // Blocked on the user outranks everything: the session IS mid-turn, but the
  // thing to know is that it can't continue without you — that includes a
  // background sub-agent asking for a permission while the turn is held.
  if (attention) return "needs_you"
  // Streaming here and now — or, when the turn is only held open for
  // background work, idle with that work running.
  if (connectionStatus === "prompting") {
    return awaitingBackground ? "background" : "working"
  }
  // This client cannot reach the agent right now — it is opening the session,
  // or failed to. "Idle — send a message" would invite a send that has nowhere
  // to go yet.
  if (connection === "failed") return "connect_failed"
  if (connection === "connecting") return "connecting"
  // The agent is running a turn of its own — its background work woke it.
  // No turn codeg sent is in flight, so neither the persisted turn state nor
  // this client's connection knows; the server's live status does.
  if (background?.out_of_turn) return "working"
  // A live connection sitting idle is first-hand proof that no turn is running,
  // so a persisted `running` that hasn't caught up yet doesn't count. It says
  // nothing about an interruption, though: a session resumed after one stays
  // interrupted until a turn is actually sent.
  const liveAndIdle = connectionStatus === "connected"
  // The turn is held open only for background work (the server says so; this
  // client either has no connection to it or its own hasn't caught up).
  if (background?.held_open && !liveAndIdle) return "background"
  const tasksRunning = (background?.task_count ?? 0) > 0
  if (turnState !== "running" && waitingLimitPause({ limit_pause: limitPause }))
    return "limit_paused"
  if (turnState === "interrupted") return "interrupted"
  if (turnState === "running") {
    if (!liveAndIdle) return "working"
    return tasksRunning ? "background" : "idle"
  }
  if (turnState === undefined && status === "in_progress" && !liveAndIdle) {
    // Server predates `turn_state`: fall back to what the sidebar always read.
    return "working"
  }
  // The turn ended, the work it started didn't.
  if (tasksRunning) return "background"
  return "idle"
}

/** A summary's activity from its own fields — no live connection known.
 *  `background` is the live store's value for the row, never the summary's
 *  own fetch-time `background` field, which goes stale the moment it lands. */
export function summaryActivity(
  summary: Pick<DbConversationSummary, "turn_state" | "status"> &
    Partial<Pick<DbConversationSummary, "limit_pause">>,
  attention?: AttentionKind | null,
  background?: ConversationBackground | null
): SessionActivity {
  return deriveSessionActivity({
    attention,
    turnState: summary.turn_state,
    status: summary.status,
    limitPause: summary.limit_pause,
    background,
  })
}

/** Whether the session has work in progress — a turn running (codeg's or one
 *  the agent started by itself) or background tasks — ignoring whether it is
 *  currently blocked on the user. What the sidebar's "running" counts count. */
export function isSessionRunning(
  summary: Pick<DbConversationSummary, "turn_state" | "status">,
  background?: ConversationBackground | null
): boolean {
  const activity = summaryActivity(summary, null, background)
  return activity === "working" || activity === "background"
}

/** Whether the conversation's latest turn is running, ignoring whether it is
 *  currently blocked on the user. */
export function isTurnRunning(
  summary: Pick<DbConversationSummary, "turn_state" | "status">
): boolean {
  return summaryActivity(summary) === "working"
}

/** How many background tasks to name for a session: this client's own
 *  held-turn count when it has one (first-hand), else the server's. `0`
 *  means "running, count unknown". */
export function backgroundTaskTotal(
  heldBackgroundTasks: number | null | undefined,
  background: ConversationBackground | null | undefined
): number {
  return Math.max(heldBackgroundTasks ?? 0, background?.task_count ?? 0)
}
