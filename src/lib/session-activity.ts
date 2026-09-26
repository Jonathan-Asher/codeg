import type {
  AttentionKind,
  ConnectionStatus,
  ConversationTurnState,
  DbConversationSummary,
} from "@/lib/types"

/**
 * What a session is doing right now — the question "is it stuck?" needs
 * answered, and one the conversation's `status` cannot answer: that is its
 * review state (open / review / completed / cancelled), which reads the same
 * for a session that is working, one waiting for you, one idle for days and
 * one whose turn was killed.
 *
 * - `working`: a turn is in flight.
 * - `needs_you`: the agent is blocked on a permission, a question or a plan
 *   approval.
 * - `idle`: nothing is running.
 * - `interrupted`: the last turn was cut off before it finished — codeg quit
 *   or crashed, or the agent process or its connection died mid-turn.
 */
export type SessionActivity = "working" | "needs_you" | "idle" | "interrupted"

/** The i18n key (under `Folder.sessionActivity`) naming each state. Literal
 *  on purpose: next-intl keys are typed, and a key read out of a variable must
 *  stay a literal type. */
export const SESSION_ACTIVITY_LABEL_KEYS = {
  working: "working",
  needs_you: "needsYou",
  idle: "idle",
  interrupted: "interrupted",
} as const satisfies Record<SessionActivity, string>

/** The i18n key (under `Folder.sessionActivity`) with a one-line explanation
 *  of each state. */
export const SESSION_ACTIVITY_HINT_KEYS = {
  working: "workingHint",
  needs_you: "needsYouHint",
  idle: "idleHint",
  interrupted: "interruptedHint",
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
}: SessionActivityInputs): SessionActivity {
  // Blocked on the user outranks everything: the session IS mid-turn, but the
  // thing to know is that it can't continue without you.
  if (attention) return "needs_you"
  // Streaming here and now.
  if (connectionStatus === "prompting") return "working"
  // A live connection sitting idle is first-hand proof that no turn is running,
  // so a persisted `running` that hasn't caught up yet doesn't count. It says
  // nothing about an interruption, though: a session resumed after one stays
  // interrupted until a turn is actually sent.
  const liveAndIdle = connectionStatus === "connected"
  if (turnState === "interrupted") return "interrupted"
  if (turnState === "running") return liveAndIdle ? "idle" : "working"
  if (turnState === undefined && status === "in_progress" && !liveAndIdle) {
    // Server predates `turn_state`: fall back to what the sidebar always read.
    return "working"
  }
  return "idle"
}

/** A summary's activity from its own fields — no live connection known. */
export function summaryActivity(
  summary: Pick<DbConversationSummary, "turn_state" | "status">,
  attention?: AttentionKind | null
): SessionActivity {
  return deriveSessionActivity({
    attention,
    turnState: summary.turn_state,
    status: summary.status,
  })
}

/** Whether the conversation's latest turn is running, ignoring whether it is
 *  currently blocked on the user. What the sidebar's per-folder "running"
 *  count counts. */
export function isTurnRunning(
  summary: Pick<DbConversationSummary, "turn_state" | "status">
): boolean {
  return summaryActivity(summary) === "working"
}
