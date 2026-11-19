import type {
  DbConversationSummary,
  MessageTurn,
  SessionStats,
} from "@/lib/types"
import type { ConversationRuntimeSession } from "@/contexts/conversation-runtime-context"

/** The slice of an open tab needed to locate its active runtime session. */
export interface ActiveSessionTabRef {
  conversationId: number | null
  /** Virtual (negative) runtime key a new conversation streams under before it
   *  reconciles to its persisted `conversationId`. */
  runtimeConversationId?: number
  /** The live status the tab strip shows — decorated from the workspace list,
   *  or from the child-summary cache for a sub-agent's conversation, which the
   *  list doesn't hold. Both follow the backend's status events. */
  status?: string
}

export interface ActiveSessionDetails {
  summary: DbConversationSummary | null
  stats: SessionStats | null
  model: string | null
}

/**
 * Inputs read while projecting metadata. Do not subscribe to this shape:
 * `detail` and `localTurns` still own the transcript, including in a persistent
 * consumer's previous React hook snapshot.
 */
export type RuntimeSessionForDetails = Pick<
  ConversationRuntimeSession,
  "detail" | "sessionStats" | "localTurns"
>

/** The "model" Claude Code stamps on the replies it writes itself (a local
 *  command such as `/model`, an API error notice): no model wrote those. */
const SYNTHETIC_MODEL = "<synthetic>"

/**
 * Pick the conversation's model from its turns. Only assistant turns carry a
 * `model`, and a conversation can switch models mid-session, so the most recent
 * turn with a model is the best "current model" signal. Returns `null` when no
 * turn records one (e.g. before the first assistant reply).
 *
 * This is the reliable source: the row's `model` column follows the session
 * (see the backend's `session_model`), but only as of the last transcript
 * read or selector change.
 */
export function pickModelFromTurns(turns: MessageTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const model = turns[i]?.model?.trim()
    if (model && model !== SYNTHETIC_MODEL) return model
  }
  return null
}

/**
 * The model a session runs on, for every view that names it: the newest reply
 * that names one (live turns first, then the loaded history), else what the
 * live connection's model selector holds, else the stored column (in the
 * order `summaries` lists them). The stored column alone is what the
 * session STARTED on for rows written before the backend kept it in step.
 */
export function resolveSessionModel({
  liveTurns,
  historyTurns,
  liveModel,
  summaries,
}: {
  liveTurns?: MessageTurn[] | null
  historyTurns?: MessageTurn[] | null
  liveModel?: string | null
  summaries?: (DbConversationSummary | null | undefined)[]
}): string | null {
  return (
    pickModelFromTurns(liveTurns ?? []) ??
    pickModelFromTurns(historyTurns ?? []) ??
    (liveModel?.trim() || null) ??
    summaries?.map((summary) => summary?.model?.trim()).find(Boolean) ??
    null
  )
}

/**
 * The summary fields the backend keeps moving while a conversation is open —
 * its turn edges and streaming heartbeat (`turn_state`, `updated_at`) and a
 * status set from any client — all broadcast to the workspace list as they
 * happen. A detail summary is a snapshot from when the detail loaded, so a
 * view that prefers it for everything else takes these from the live row, or
 * "Updated" and the activity would freeze at load time.
 */
export function withLiveSummaryFields(
  loaded: DbConversationSummary,
  live: DbConversationSummary | null | undefined
): DbConversationSummary {
  if (!live || live.id !== loaded.id) return loaded
  return {
    ...loaded,
    status: live.status,
    updated_at: live.updated_at,
    turn_state: live.turn_state,
    // Marked or unmarked critical from any client (or this one, optimistically).
    critical: live.critical,
    critical_stall: live.critical_stall,
    // Paused on the usage limit, continued, or the switch flipped anywhere.
    limit_pause: live.limit_pause,
    limit_auto_continue: live.limit_auto_continue,
  }
}

/**
 * Project before subscribing, so a metadata consumer's current and previous
 * snapshots contain only the values it displays, never a session or turn array.
 * Its `model` is the one the turns name (live turns first, then the loaded
 * history), or `null`: the rest of `resolveSessionModel`'s order — the live
 * selector, then the stored columns — is applied when the snapshot is resolved
 * (`resolveActiveSessionDetailsFromSnapshot`).
 */
export function projectRuntimeSessionDetails(
  session: RuntimeSessionForDetails | null | undefined
): ActiveSessionDetails {
  return {
    summary: session?.detail?.summary ?? null,
    stats: session?.sessionStats ?? session?.detail?.session_stats ?? null,
    model: resolveSessionModel({
      liveTurns: session?.localTurns,
      historyTurns: session?.detail?.turns,
    }),
  }
}

/**
 * `summary` with the columns that change while a conversation is open taken
 * from where they are kept current. The loaded detail's summary is a snapshot
 * of when the transcript was fetched, and nothing refreshes it as turns start
 * and end (a completed turn deliberately never refetches), so its `status` —
 * and its `title`, once renamed or auto-titled — would stay what they were
 * when the conversation was opened, and so would the live fields
 * `withLiveSummaryFields` names. The workspace list and the tab follow the
 * backend's status/upsert events. Returns `summary` itself when nothing
 * differs, so a caller comparing by identity sees no change.
 */
function withLiveColumns(
  summary: DbConversationSummary | null,
  listed: DbConversationSummary | null,
  tabStatus: string | undefined
): DbConversationSummary | null {
  if (summary == null) return null
  const live = listed != null && listed.id === summary.id ? listed : null
  const next: DbConversationSummary = {
    ...withLiveSummaryFields(summary, live),
    status: tabStatus ?? live?.status ?? summary.status,
    title: live?.title ?? summary.title,
  }
  const keys = Object.keys(next) as (keyof DbConversationSummary)[]
  return keys.some((key) => next[key] !== summary[key]) ? next : summary
}

/**
 * Resolve the active conversation tab's summary + live token usage the same way
 * the tab view renders them.
 *
 * A brand-new conversation streams under its virtual `runtimeConversationId`,
 * not the persisted `conversationId`, and its live usage lives on the runtime
 * session's `sessionStats` (its `detail` lags or is absent until a cold load
 * runs). So we key the runtime lookup on `runtimeConversationId ?? conversationId`,
 * read stats from `sessionStats` (falling back to the loaded `detail`), and fall
 * back to the workspace summary so the Session Details dialog can still open
 * before `detail` has loaded. Its status and title are the live ones (see
 * `withLiveColumns`).
 */
export function resolveActiveSessionDetails(
  tab: ActiveSessionTabRef | null,
  getSession: (id: number) => RuntimeSessionForDetails | null,
  conversations: DbConversationSummary[],
  // What the tab's live connection has selected (`readLiveSessionModel`): the
  // model until the transcript has a reply naming one.
  liveModel: string | null = null
): ActiveSessionDetails {
  const runtimeId = tab?.runtimeConversationId ?? tab?.conversationId ?? null
  const runtimeSession = runtimeId != null ? getSession(runtimeId) : null
  return resolveActiveSessionDetailsFromSnapshot(
    tab,
    projectRuntimeSessionDetails(runtimeSession),
    conversations,
    liveModel
  )
}

/** Apply live workspace/tab columns after the store's metadata projection. */
export function resolveActiveSessionDetailsFromSnapshot(
  tab: ActiveSessionTabRef | null,
  snapshot: ActiveSessionDetails,
  conversations: DbConversationSummary[],
  // What the tab's live connection has selected (`readLiveSessionModel`): the
  // model until the transcript has a reply naming one.
  liveModel: string | null = null
): ActiveSessionDetails {
  const listed =
    tab?.conversationId != null
      ? (conversations.find((c) => c.id === tab.conversationId) ?? null)
      : null
  const summary = withLiveColumns(
    snapshot.summary ?? listed,
    listed,
    tab?.status
  )
  // The turns' model, else the live selector, else the stored column — the
  // listed row first: upserts keep it current (a selector change, a
  // transcript read elsewhere); the loaded summary is a snapshot.
  const model =
    snapshot.model ??
    resolveSessionModel({
      liveModel,
      summaries: [listed, snapshot.summary, summary],
    })
  return { summary, stats: snapshot.stats, model }
}
