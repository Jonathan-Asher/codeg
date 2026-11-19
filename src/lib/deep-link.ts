import { isUnsupportedCommandError } from "@/lib/harness/errors"
import { parseItemRef } from "@/lib/harness/item-ref"
import {
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"
import type { AgentType } from "@/lib/types"

/** A conversation of this window's backend, ready to open in a tab. */
export interface FocusTarget {
  folderId: number
  conversationId: number
  agent: AgentType
}

/** Why a link opened nothing (Rust `LinkNotice`). */
export type DeepLinkNoticeReason =
  | "not_found"
  | "unknown_server"
  | "server_unavailable"

/**
 * What a `codeg://` link left for this window (Rust `PendingLink`):
 *
 * - `focus` — a conversation the backend looked up already (a link for the
 *   local workspace);
 * - `session` — for a remote workspace window: a session to look up on its
 *   own server, which the local backend cannot see. `serverName` is the
 *   connection's name, for the notice when the server has no such session;
 * - `notice` — nothing to open, and why.
 */
export type PendingDeepLink =
  | ({ kind: "focus" } & FocusTarget)
  | {
      kind: "session"
      sessionRef: string
      folderId: number | null
      agent: AgentType | null
      serverName: string
    }
  | {
      kind: "notice"
      reason: DeepLinkNoticeReason
      server: string | null
      sessionRef: string | null
    }

const NOTICE_REASONS: ReadonlySet<string> = new Set<DeepLinkNoticeReason>([
  "not_found",
  "unknown_server",
  "server_unavailable",
])

function asId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/** A conversation target that crossed a process boundary, or `null`. */
export function parseFocusTarget(raw: unknown): FocusTarget | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const folderId = asId(r.folderId)
  const conversationId = asId(r.conversationId)
  const agent = asText(r.agent)
  if (folderId == null || conversationId == null || agent == null) return null
  return { folderId, conversationId, agent: agent as AgentType }
}

/**
 * Read what the backend handed over. Anything half-formed is `null`: it is
 * better to open nothing than tab NaN. A payload with no `kind` is a target,
 * the shape the backend used before links could name a server.
 */
export function parsePendingDeepLink(raw: unknown): PendingDeepLink | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  switch (r.kind ?? "focus") {
    case "focus": {
      const target = parseFocusTarget(r)
      return target ? { kind: "focus", ...target } : null
    }
    case "session": {
      const sessionRef = asText(r.sessionRef)
      if (sessionRef == null) return null
      return {
        kind: "session",
        sessionRef,
        folderId: asId(r.folderId),
        agent: asText(r.agent) as AgentType | null,
        serverName: typeof r.serverName === "string" ? r.serverName : "",
      }
    }
    case "notice": {
      if (typeof r.reason !== "string" || !NOTICE_REASONS.has(r.reason)) {
        return null
      }
      return {
        kind: "notice",
        reason: r.reason as DeepLinkNoticeReason,
        server: asText(r.server),
        sessionRef: asText(r.sessionRef),
      }
    }
    default:
      return null
  }
}

/**
 * Drain the deep link the desktop app handed this window.
 *
 * `workspace://focus-conversation` reaches only webviews that have already
 * subscribed, so a cold-start `codeg://session/<id>` — resolved in Rust while
 * the window is still loading — would otherwise be dropped. The backend parks
 * what the link comes to, one slot per window; this takes this window's (once)
 * when `PetFocusBridge` is ready.
 *
 * Always through the local shell, never the window's own transport: a remote
 * workspace window's transport targets a `codeg-server`, but the slot is in
 * the desktop app, which a link for that server sent here. Desktop only;
 * `null` for everything else, including failures — a missing deep link is the
 * overwhelmingly common case, not an error.
 */
export async function takePendingDeepLink(): Promise<PendingDeepLink | null> {
  if (!isDesktop()) return null
  try {
    const raw = await getShellTransport().call<unknown>(
      "take_pending_deep_link"
    )
    return parsePendingDeepLink(raw)
  } catch (err) {
    console.warn("[deep-link] take_pending_deep_link failed:", err)
    return null
  }
}

/** What {@link resolveSessionLink} found. */
export type SessionLookup =
  | { status: "found"; target: FocusTarget }
  | { status: "missing" }
  /** The server is from before session links could be looked up. */
  | { status: "unsupported" }

/**
 * Look a session up on this window's own backend — the remote server in a
 * remote workspace window, the local app otherwise — by its ref (codeg's
 * conversation id, or an agent's session id), checking the folder and agent
 * when given. Throws when the backend could not be asked.
 */
export async function resolveSessionLink(args: {
  sessionRef: string
  folderId?: number | null
  agent?: string | null
}): Promise<SessionLookup> {
  let raw: unknown
  try {
    raw = await getTransport().call<unknown>("resolve_session_link", {
      sessionRef: args.sessionRef,
      folderId: args.folderId ?? null,
      agent: args.agent ?? null,
    })
  } catch (err) {
    if (isUnsupportedCommandError(err)) return { status: "unsupported" }
    throw err
  }
  const target = parseFocusTarget(raw)
  return target ? { status: "found", target } : { status: "missing" }
}

/**
 * Claim the Harness link the desktop app was opened (or re-activated) with —
 * `codeg://harness/install?ref=<publisher>/<name>` — as the item's address.
 *
 * The backend parks it in a slot of its own, beside the conversation one: the
 * two are told apart by where they wait, not by their shape, and this one is
 * validated as an item address rather than a conversation target. Otherwise it
 * is the same handover as {@link takePendingDeepLink}: an atomic take, from
 * the local desktop workspace only (a link opens the item on this computer, so
 * a remote workspace window never claims one), and `null` for everything else.
 *
 * A backend that has no such command is `null` as well, and worth no more than
 * a debug line: it is a build from before the command existed, not a failure.
 */
export async function takePendingHarnessLink(): Promise<string | null> {
  if (!isDesktop() || isRemoteDesktopMode()) return null
  try {
    const ref = await getTransport().call<unknown>("take_pending_harness_link")
    // The backend checked it already; it is checked again because it goes on
    // to the Harness page, and nothing that reaches it is taken on trust.
    return parseItemRef(ref)?.ref ?? null
  } catch (err) {
    if (isUnsupportedCommandError(err)) {
      console.debug("[deep-link] take_pending_harness_link is not available")
      return null
    }
    console.warn("[deep-link] take_pending_harness_link failed:", err)
    return null
  }
}
