/**
 * The answer buttons of a pending item's desktop notification — what waits on
 * the user (a permission, a question, a plan) answered from Notification
 * Center, the way the iPhone's notification buttons answer it.
 *
 * The window that raises the notification builds them here: it has the item,
 * the strings and the user's "hide contents" choice. They travel with the
 * notification (`send_notification`'s `pending`), and the desktop backend
 * sends the answer a button stands for to the backend this window is bound to
 * (`src-tauri/src/commands/notification_answers.rs`). Only macOS shows them;
 * everywhere else the notification stays click-to-open.
 *
 * Each button sends what the in-app card would: a permission option's id, a
 * question option's exact label (or the typed reply), a plan's "approve".
 */

import type { useTranslations } from "next-intl"

import type {
  PendingItem,
  PendingKind,
  PendingOption,
  PendingSource,
  PermissionOptionInfo,
  QuestionSpec,
} from "@/lib/types"

/** Longest option label a button carries: an answer names the exact label,
 *  so a longer one cannot be shortened to fit (the iPhone's limit too). */
export const MAX_BUTTON_LABEL_CHARS = 60

/** Most option buttons one notification offers; a question with more is
 *  answered by typing or in the app. */
export const MAX_OPTION_BUTTONS = 6

/** The button that only opens the session (Rust `OPEN_BUTTON_ID`). */
export const OPEN_BUTTON_ID = "open"

export interface NotificationButton {
  id: string
  title: string
  /** A permission option's id, a question option's exact label; empty for
   *  a plan's approve and for "Open". */
  value: string
}

/** A pending item's notification payload (Rust `PendingNotification`). */
export interface PendingNotification {
  /** The item's id in `list_pending_items` (`<source>:<request id>`). */
  pendingId: string
  source: PendingSource
  /** The asking session's connection (a delegated sub-agent's own). */
  connectionId: string
  requestId: string
  /** A question's own id (`answers[].questionId`). */
  itemId: string | null
  buttons: NotificationButton[]
  reply: { placeholder: string } | null
}

/** What a notification needs to know about an item to answer it. */
export interface AnswerableAsk {
  /** `<source>:<request id>`, as `list_pending_items` names it. */
  id: string
  kind: PendingKind
  source: PendingSource
  connectionId: string
  requestId: string
  /** A permission's options (`id` is the option id, `kind` its ACP kind) or
   *  a question's (`id` is the full label). */
  options: readonly PendingOption[]
  question: {
    itemId: string
    multiSelect: boolean
    count: number
    secret: boolean
  } | null
}

export interface NotificationActionLabels {
  allow: string
  allowAlways: string
  deny: string
  denyAlways: string
  approve: string
  open: string
  replyPlaceholder: string
}

type PendingItemsT = ReturnType<typeof useTranslations<"PendingItems">>

/** The buttons' words, from the `PendingItems` messages. */
export function notificationActionLabels(
  t: PendingItemsT
): NotificationActionLabels {
  return {
    allow: t("notification.allow"),
    allowAlways: t("notification.allowAlways"),
    deny: t("notification.deny"),
    denyAlways: t("notification.denyAlways"),
    approve: t("notification.approve"),
    open: t("notification.open"),
    replyPlaceholder: t("notification.replyPlaceholder"),
  }
}

/** An item of the "Waiting for you" list (a reminder). */
export function askOfPendingItem(item: PendingItem): AnswerableAsk {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    connectionId: item.connection_id,
    requestId: item.request_id,
    options: item.options,
    question: item.question
      ? {
          itemId: item.question.item_id,
          multiSelect: item.question.multi_select,
          count: item.question.count,
          secret: item.question.secret ?? false,
        }
      : null,
  }
}

function readString(value: unknown, ...path: string[]): string | null {
  let at: unknown = value
  for (const key of path) {
    if (!at || typeof at !== "object") return null
    at = (at as Record<string, unknown>)[key]
  }
  return typeof at === "string" ? at : null
}

/**
 * A permission request that is really a plan to approve: Claude Code's
 * ExitPlanMode (its `exit-plan-*` options, or the tool itself) or Codex's
 * plan review. Mirrors the backend's `pending::is_plan_gate`.
 */
export function isPlanGate(
  toolCall: unknown,
  options: readonly { option_id: string }[]
): boolean {
  if (options.some((o) => o.option_id.startsWith("exit-plan-"))) return true
  if (readString(toolCall, "kind") === "switch_mode") return true
  const tool = readString(toolCall, "_meta", "claudeCode", "toolName")
  if (tool === "ExitPlanMode" || tool === "EnterPlanMode") return true
  return readString(toolCall, "toolCallId")?.startsWith("plan-review:") ?? false
}

/** A `permission_request` event, for its first notification. */
export function askOfPermissionRequest(
  connectionId: string,
  requestId: string,
  options: readonly PermissionOptionInfo[],
  toolCall: unknown
): AnswerableAsk {
  return {
    id: `permission:${requestId}`,
    kind: isPlanGate(toolCall, options) ? "plan" : "permission",
    source: "permission",
    connectionId,
    requestId,
    options: options.map((o) => ({
      id: o.option_id,
      label: o.name,
      kind: o.kind,
    })),
    question: null,
  }
}

/** A `question_request` event, for its first notification. */
export function askOfQuestionRequest(
  connectionId: string,
  questionId: string,
  questions: readonly QuestionSpec[]
): AnswerableAsk {
  const first = questions[0]
  return {
    id: `question:${questionId}`,
    kind: "question",
    source: "question",
    connectionId,
    requestId: questionId,
    options: (first?.options ?? []).map((o) => ({
      id: o.label,
      label: o.label,
    })),
    question: first
      ? {
          itemId: first.id,
          multiSelect: first.multi_select,
          count: questions.length,
          secret: first.is_secret ?? false,
        }
      : null,
  }
}

const PERMISSION_BUTTONS = [
  ["allow_once", "allow"],
  ["allow_always", "allowAlways"],
  ["reject_once", "deny"],
  ["reject_always", "denyAlways"],
] as const

/** The option a plan's "Approve" sends: Claude Code's plan card leads with
 *  the mode to continue in, else the plain allow (the iPhone's APPROVE). */
function planApproveOption(options: readonly PendingOption[]) {
  const allows = options.filter((o) => o.kind?.startsWith("allow"))
  if (options.some((o) => o.id.startsWith("exit-plan-"))) return allows[0]
  return options.find((o) => o.kind === "allow_once") ?? allows[0]
}

function labelFits(label: string): boolean {
  return label.trim().length > 0 && [...label].length <= MAX_BUTTON_LABEL_CHARS
}

/**
 * The buttons and reply that answer `ask`, as the in-app card would:
 *
 * - a permission: Allow / Deny, plus Always allow / Always deny when the
 *   request offers them, each sending that option;
 * - a plan: Approve, when the card can approve it;
 * - one single-choice question: a button per option (when they all fit), and
 *   a typed reply — the card always takes a free-text answer — unless the
 *   answer is a secret;
 * - several questions, or a multiple-choice one: none, the click opens it.
 *
 * "Open" follows whenever there is anything to answer with. The buttons are
 * the item's own words; {@link withoutContents} drops them when the user
 * hides notification contents.
 */
export function pendingNotificationFor(
  ask: AnswerableAsk,
  labels: NotificationActionLabels
): PendingNotification {
  const buttons: NotificationButton[] = []
  const add = (title: string, value: string) =>
    buttons.push({ id: `b${buttons.length}`, title, value })
  let reply: PendingNotification["reply"] = null

  if (ask.source === "plan_approval") {
    add(labels.approve, "approve")
  } else if (ask.source === "permission" && ask.kind === "plan") {
    const approve = planApproveOption(ask.options)
    if (approve) add(labels.approve, approve.id)
  } else if (ask.source === "permission") {
    for (const [kind, label] of PERMISSION_BUTTONS) {
      const option = ask.options.find((o) => o.kind === kind)
      if (option) add(labels[label], option.id)
    }
  } else if (
    ask.question &&
    ask.question.count === 1 &&
    !ask.question.multiSelect
  ) {
    const choices = ask.options.map((o) => o.id)
    if (choices.length <= MAX_OPTION_BUTTONS && choices.every(labelFits)) {
      for (const choice of choices) add(choice, choice)
    }
    if (!ask.question.secret) {
      reply = { placeholder: labels.replyPlaceholder }
    }
  }

  if (buttons.length > 0 || reply) {
    buttons.push({ id: OPEN_BUTTON_ID, title: labels.open, value: "" })
  }
  return {
    pendingId: ask.id,
    source: ask.source,
    connectionId: ask.connectionId,
    requestId: ask.requestId,
    itemId: ask.question?.itemId ?? null,
    buttons,
    reply,
  }
}

/**
 * The same notification with notification contents hidden: no option
 * labels, nothing to type — the click opens the session. It still names the
 * item, so it is withdrawn once the item clears.
 */
export function withoutContents(
  pending: PendingNotification
): PendingNotification {
  return { ...pending, buttons: [], reply: null }
}
