/**
 * Session links — `codeg://session/<id>?server=<instance>` — on the frontend:
 * reading them, writing them, and opening one from a transcript badge.
 *
 * A conversation id means something only on the codeg instance that issued
 * it, so a link names its instance with `server` (an opaque instance id; a
 * saved connection's name or host also works when written by hand). Links
 * this window writes name the instance its transport talks to, once
 * {@link loadInstanceIdentity} has asked it; until then, and on a server from
 * before instance ids, they go out in the old form, which means "here".
 *
 * Opening one: a badge for this window's own server (or naming none) opens in
 * place; one for another server goes to the desktop app's deep-link handler
 * (`open_deep_link`), which opens it in that server's workspace window, just
 * as a click in another app would. See `src-tauri/.../deep_link.rs`.
 */

import { resolveSessionLink, type FocusTarget } from "@/lib/deep-link"
import {
  getShellTransport,
  getTransport,
  isDesktop,
  onActiveTransportChange,
} from "@/lib/transport"

/** Who a codeg instance is (Rust `InstanceIdentity`). */
export interface InstanceIdentity {
  instanceId: string
  name: string
}

/** A parsed session link. `server` is `null` for a link that names none. */
export interface SessionLink {
  sessionRef: string
  server: string | null
}

// `codeg://session/<ref>`, `codeg:session/<ref>`, any case for the segment,
// then an optional query and fragment.
const SESSION_LINK =
  /^codeg:(?:\/\/)?\/*session\/([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i

/** Longest ref and server accepted, as the desktop handler accepts them. */
const MAX_REF_LENGTH = 256
const MAX_SERVER_CHARS = 255

/**
 * Read a session link as the desktop handler reads it, or `null` when it is
 * not one. A `server` that cannot name one (a control character, too long)
 * reads as no link: there is nothing it could open.
 */
export function parseSessionLink(uri: string): SessionLink | null {
  const match = SESSION_LINK.exec(uri.trim())
  if (!match) return null
  const rawRef = match[1].replace(/\/+$/, "")
  let sessionRef: string
  try {
    sessionRef = decodeURIComponent(rawRef).trim()
  } catch {
    sessionRef = rawRef.trim()
  }
  if (
    !sessionRef ||
    sessionRef.includes("/") ||
    sessionRef.includes("\\") ||
    sessionRef.length > MAX_REF_LENGTH
  ) {
    return null
  }
  const server = (
    new URLSearchParams(match[2] ?? "").get("server") ?? ""
  ).trim()
  if (
    [...server].length > MAX_SERVER_CHARS ||
    /[\u0000-\u001f\u007f-\u009f]/.test(server)
  ) {
    return null
  }
  return { sessionRef, server: server || null }
}

/**
 * The link to conversation `conversationId`, naming `server` — by default
 * the instance this window talks to, when it is known.
 */
export function sessionLinkUri(
  conversationId: number | string,
  server: string | null | undefined = currentInstanceId()
): string {
  const base = `codeg://session/${conversationId}`
  const value = server?.trim()
  return value ? `${base}?server=${encodeURIComponent(value)}` : base
}

// ── This window's instance ──────────────────────────────────────────────────

let identity: InstanceIdentity | null = null
let loading: Promise<InstanceIdentity | null> | null = null
let generation = 0
let watchingTransport = false

function parseIdentity(raw: unknown): InstanceIdentity | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.instanceId !== "string" || !r.instanceId.trim()) return null
  return {
    instanceId: r.instanceId.trim(),
    name: typeof r.name === "string" ? r.name : "",
  }
}

function forgetIdentity() {
  identity = null
  loading = null
  generation += 1
}

/**
 * Ask this window's backend who it is, once (again after the window binds to
 * another server). `null` when it does not say — a server from before
 * instance ids — or cannot be asked right now; a later call asks again.
 */
export function loadInstanceIdentity(): Promise<InstanceIdentity | null> {
  if (!watchingTransport) {
    watchingTransport = true
    try {
      // A window that binds to a remote server talks to another instance.
      onActiveTransportChange(forgetIdentity)
    } catch {
      // A transport without the hook (a test double) never rebinds.
    }
  }
  if (loading) return loading
  const asked = generation
  loading = getTransport()
    .call<unknown>("get_instance_identity")
    .then((raw) => {
      const found = parseIdentity(raw)
      if (asked === generation) identity = found
      return found
    })
    .catch((err) => {
      console.debug("[session-link] get_instance_identity failed:", err)
      if (asked === generation) loading = null
      return null
    })
  return loading
}

/** This window's instance id, once {@link loadInstanceIdentity} has it. */
export function currentInstanceId(): string | null {
  return identity?.instanceId ?? null
}

/** Whether a link's `server` names `own`: by id, or by its own name. */
export function isOwnServer(
  server: string,
  own: InstanceIdentity | null
): boolean {
  if (!own) return false
  const wanted = server.trim().toLowerCase()
  return (
    wanted === own.instanceId.toLowerCase() ||
    (own.name.trim() !== "" && wanted === own.name.trim().toLowerCase())
  )
}

/** Test-only: forget the identity, or set one. */
export function __setInstanceIdentityForTests(
  next: InstanceIdentity | null
): void {
  forgetIdentity()
  identity = next
  watchingTransport = false
}

// ── Opening one ─────────────────────────────────────────────────────────────

/** What opening a link tells the user, as a `DeepLink` message and its values. */
export type SessionLinkNotice =
  | { key: "notFound"; values: { session: string } }
  | { key: "lookupFailedHere"; values: { session: string } }
  | { key: "otherServer"; values: { server: string } }

type Notifier = (notice: SessionLinkNotice) => void

let notifier: Notifier | null = null

/**
 * Register how this window tells the user why a session link opened nothing
 * (the workspace's bridge, which holds the translations). A badge has no
 * translator of its own: there can be hundreds in a transcript.
 */
export function setSessionLinkNotifier(next: Notifier): () => void {
  notifier = next
  return () => {
    if (notifier === next) notifier = null
  }
}

/** Tell the user, through the registered notifier. */
export function notifySessionLink(notice: SessionLinkNotice): void {
  if (notifier) notifier(notice)
  else console.info("[session-link]", notice.key, notice.values)
}

export interface OpenSessionLinkDeps {
  /** Open the conversation in this window. */
  openHere: (target: FocusTarget) => void
  /** Tell the user why nothing opened here. */
  notify: (notice: SessionLinkNotice) => void
}

export type OpenSessionLinkOutcome =
  | "here"
  | "elsewhere"
  | "missing"
  | "failed"
  | "invalid"

/**
 * A session badge was clicked: open its session here when it is this
 * window's server's (or names no server), or hand it to the desktop app to
 * open on the server it names.
 */
export async function openSessionLink(
  uri: string,
  deps: OpenSessionLinkDeps
): Promise<OpenSessionLinkOutcome> {
  const link = parseSessionLink(uri)
  if (!link) return "invalid"
  if (link.server && !isOwnServer(link.server, await loadInstanceIdentity())) {
    if (!isDesktop()) {
      deps.notify({ key: "otherServer", values: { server: link.server } })
      return "elsewhere"
    }
    try {
      await getShellTransport().call("open_deep_link", { url: uri })
      return "elsewhere"
    } catch (err) {
      console.warn("[session-link] open_deep_link failed:", err)
      deps.notify({ key: "otherServer", values: { server: link.server } })
      return "failed"
    }
  }
  let lookup
  try {
    lookup = await resolveSessionLink({ sessionRef: link.sessionRef })
  } catch (err) {
    console.warn("[session-link] resolve_session_link failed:", err)
    deps.notify({
      key: "lookupFailedHere",
      values: { session: link.sessionRef },
    })
    return "failed"
  }
  switch (lookup.status) {
    case "found":
      deps.openHere(lookup.target)
      return "here"
    case "unsupported":
      deps.notify({
        key: "lookupFailedHere",
        values: { session: link.sessionRef },
      })
      return "failed"
    case "missing":
      deps.notify({ key: "notFound", values: { session: link.sessionRef } })
      return "missing"
  }
}
