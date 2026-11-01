/**
 * The window ↔ helper protocol of Talk on this Mac, version 1: JSON lines
 * between the window that holds a Talk and the native helper `codeg-talk`,
 * relayed by Rust (`src-tauri/src/talk/voice`). The helper's contract is
 * `native/codeg-talk/README.md` ("Protocol (version 1)"); its fixtures
 * (`__fixtures__/protocol/`, copied from the helper) are tested against these
 * types.
 *
 * Every message has a `type`. Envelope fields are camelCase; the server's
 * records inside a message (pending permission, question and plan approval,
 * `MessageTurn`, `PendingItem`) pass through exactly as the server sends them,
 * snake_case. Both sides ignore unknown types and fields.
 */

import type {
  MessageTurn,
  PendingItem,
  PendingPlanApprovalState,
  PendingQuestionState,
  PlanApprovalDecision,
  QuestionAnswer,
  TalkSettings,
} from "@/lib/types"
import type { PendingPermission } from "@/contexts/acp-connections-context"

export const TALK_PROTOCOL_VERSION = 1

// ── Window → helper ──

/** The session as Talk drives it: the iPhone's `TalkSessionPort`. */
export interface TalkPort {
  title: string | null
  /** A message can go into the running turn now (native steering). */
  canInsertIntoTurn: boolean
  isInFlight: boolean
  /** The turn is held open only for background work. */
  awaitingBackground: boolean
  backgroundOutstanding: number
  pendingPermission: PendingPermission | null
  /** The ask_user_question card (the server's `PendingQuestionState`). */
  pendingQuestion: PendingQuestionState | null
  pendingPlanApproval: PendingPlanApprovalState | null
}

/** The live turn's main-thread text (`live-text.ts`). */
export interface TalkLive {
  turnId: string
  text: string
  streaming: boolean
}

export type TalkPatience = "short" | "normal" | "long"
export type TalkEchoMode = "automatic" | "voiceProcessing" | "off"

/** The helper's `prefs`, plus `useWhisper`, which Rust reads (the helper
 *  ignores it). */
export interface TalkWirePrefs {
  handsFree: boolean
  patience: TalkPatience
  interruptBySpeaking: boolean
  speakProgress: boolean
  smartTurnActive: boolean
  echoMode: TalkEchoMode
  shareTelemetry: boolean
  useWhisper?: boolean
}

/** Read aloud's natural voice. */
export interface TalkVoice {
  name: string | null
  speed: number
}

export interface TalkAppInfo {
  version: string
  build: string
  bundleId: string
}

export interface TalkStartMessage {
  type: "start"
  protocol: typeof TALK_PROTOCOL_VERSION
  conversationId: number
  title: string | null
  folder: string | null
  /** The server's Talk settings (`get_talk_settings`). */
  settings: TalkSettings | null
  prefs: TalkWirePrefs
  voice: TalkVoice | null
  port: TalkPort
  /** The turn in progress, or null. */
  live: TalkLive | null
  /** The server's pending items (this conversation's sub-agents'). */
  items: PendingItem[]
  app: TalkAppInfo
}

export type TalkPortMessage = { type: "port" } & Partial<TalkPort>

export type TalkControl =
  | { op: "toggleMute" }
  | { op: "softMute"; value: boolean }
  | { op: "skip" }
  | { op: "tapOrb" }
  | { op: "press"; down: boolean }
  | { op: "cancelPress" }
  | { op: "choose"; choiceId: string }
  | { op: "reportCutOff" }
  | { op: "setHandsFree"; value: boolean }
  | { op: "repeatLast" }

export type TalkControlOp = TalkControl["op"]

export type WindowMessage =
  | TalkStartMessage
  | TalkPortMessage
  | ({ type: "live" } & TalkLive)
  | { type: "turnEnded"; turnId: string; stopReason: string | null }
  | { type: "awaiting"; value: boolean }
  | { type: "bgTurns"; turns: MessageTurn[] }
  | { type: "items"; items: PendingItem[] }
  | {
      type: "res"
      id: number
      ok: boolean
      value?: unknown
      error?: string
    }
  | ({ type: "control" } & TalkControl)
  | { type: "settings"; settings: TalkSettings }
  | { type: "prefs"; prefs: Partial<TalkWirePrefs> }
  | { type: "end" }

// ── Helper → window ──

export type TalkMicPermission = "granted" | "denied" | "undetermined"

export type TalkStatus =
  | "starting"
  | "listening"
  | "hearing"
  | "thinking"
  | "working"
  | "speaking"
  | "asking"
  | "confirmingCancel"
  | "paused"
  | "ended"
  | "failed"

export interface TalkChoice {
  id: string
  label: string
}

/** What Talk is asking (the dock shows its choices as big buttons). */
export interface TalkAsk {
  id: string
  kind: string
  prompt: string
  choices: TalkChoice[]
  multiSelect: boolean
  acceptsOwnWords: boolean
  isSecret: boolean
  answerableByVoice: boolean
}

export interface TalkSpokenLine {
  id: string
  text: string
}

export type TalkMute = "none" | "soft" | "hard"
export type TalkRoute = "builtIn" | "bluetoothHFP" | "wired" | "other"

/** What the dock shows. */
export interface TalkUiState {
  type: "state"
  status: TalkStatus
  pauseReason: string | null
  error: string | null
  title: string | null
  /** What the person is saying (live), or last said (final). */
  heard: string
  heardFinal: boolean
  /** The last units spoken (at most 20), and the one playing. */
  spoken: TalkSpokenLine[]
  current: string | null
  ask: TalkAsk | null
  mute: TalkMute
  handsFree: boolean
  backgroundOutstanding: number
  awaitingBackground: boolean
  fastMode: boolean
  naturalVoice: boolean
  canReportCutOff: boolean
  route: TalkRoute
  echo: "voiceProcessing" | "none"
  speaksHebrew: boolean
  mic: TalkMicPermission
  /** Speakers without echo cancellation: talking over the reply can't
   *  interrupt it. */
  suggestHeadphones: boolean
}

export interface TalkHello {
  type: "hello"
  protocol: number
  version: string
  mic: TalkMicPermission
}

export interface TalkLevel {
  type: "level"
  in: number
  out: number
}

/** A pending item of a sub-agent, as a request names it. */
export interface TalkItemRef {
  itemId: string
  connectionId: string
  requestId: string
  conversationId: number
}

export type TalkRequestBody =
  | { op: "sendSpoken"; text: string }
  | { op: "respondPermission"; requestId: string; optionId: string }
  | { op: "answerQuestion"; questionId: string; answer: QuestionAnswer }
  | { op: "declineQuestion"; questionId: string }
  | {
      op: "answerPlanApproval"
      approvalId: string
      decision: PlanApprovalDecision
      feedback: string | null
    }
  | { op: "setTalkMode"; enabled: boolean }
  | { op: "fetchSettings" }
  | { op: "respondItem"; item: TalkItemRef; optionId: string }
  | { op: "answerItem"; item: TalkItemRef; answer: QuestionAnswer }
  | {
      op: "answerItemPlan"
      item: TalkItemRef
      decision: PlanApprovalDecision
      feedback: string | null
    }
  | { op: "uploadReport"; report: Record<string, unknown> }

export type TalkRequestOp = TalkRequestBody["op"]

export type TalkRequest = { type: "req"; id: number } & TalkRequestBody

/** Where a spoken message went (`sendSpoken`'s answer). */
export type SpokenSendRoute = "prompt" | "insert" | "queued"

export interface TalkFlags {
  type: "flags"
  /** Keep the event stream attached while the session is idle. */
  keepsStreamAttached: boolean
  /** Presence `talking`. */
  isTalking: boolean
  /** Keep the session open. */
  holdSession: boolean
}

/** `reason`: the helper's `ended`, `failed`, `replaced`; Rust's `crashed`,
 *  `stopped`, `windowClosed`. */
export interface TalkEnded {
  type: "ended"
  reason: string
  error?: string | null
}

export type HelperMessage =
  | TalkHello
  | TalkUiState
  | TalkLevel
  | TalkRequest
  | { type: "cmd"; op: "cancel" }
  | TalkFlags
  | TalkEnded
  | { type: "error"; message: string }

/** What Rust delivers for the window that holds a Talk
 *  (`talk-voice://message`). */
export interface TalkVoiceEnvelope {
  talkId: number
  message: unknown
}

const REQUEST_OPS: ReadonlySet<string> = new Set<TalkRequestOp>([
  "sendSpoken",
  "respondPermission",
  "answerQuestion",
  "declineQuestion",
  "answerPlanApproval",
  "setTalkMode",
  "fetchSettings",
  "respondItem",
  "answerItem",
  "answerItemPlan",
  "uploadReport",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The helper's message, when it is one this window understands; null for an
 * unknown type or a message missing what its type needs (it is ignored, as
 * the protocol asks).
 */
export function parseHelperMessage(value: unknown): HelperMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null
  switch (value.type) {
    case "hello":
      return typeof value.protocol === "number"
        ? (value as unknown as TalkHello)
        : null
    case "state":
      return typeof value.status === "string"
        ? (value as unknown as TalkUiState)
        : null
    case "level":
      return typeof value.in === "number" && typeof value.out === "number"
        ? (value as unknown as TalkLevel)
        : null
    case "req":
      return typeof value.id === "number" &&
        typeof value.op === "string" &&
        REQUEST_OPS.has(value.op)
        ? (value as unknown as TalkRequest)
        : null
    case "cmd":
      return value.op === "cancel" ? { type: "cmd", op: "cancel" } : null
    case "flags":
      return {
        type: "flags",
        keepsStreamAttached: value.keepsStreamAttached === true,
        isTalking: value.isTalking === true,
        holdSession: value.holdSession === true,
      }
    case "ended":
      return {
        type: "ended",
        reason: typeof value.reason === "string" ? value.reason : "ended",
        error: typeof value.error === "string" ? value.error : null,
      }
    case "error":
      return {
        type: "error",
        message: typeof value.message === "string" ? value.message : "",
      }
    default:
      return null
  }
}

/** The envelope Rust delivered, when it is one. */
export function parseEnvelope(value: unknown): TalkVoiceEnvelope | null {
  if (!isRecord(value) || typeof value.talkId !== "number") return null
  return { talkId: value.talkId, message: value.message }
}

/** A `control` message. */
export function controlMessage(control: TalkControl): WindowMessage {
  return { type: "control", ...control }
}

/** The answer to request `id`. */
export function responseMessage(
  id: number,
  result: { ok: true; value: unknown } | { ok: false; error: string }
): WindowMessage {
  return result.ok
    ? { type: "res", id, ok: true, value: result.value }
    : { type: "res", id, ok: false, error: result.error }
}
