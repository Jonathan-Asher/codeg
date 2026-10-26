import { describe, expect, it } from "vitest"

import {
  askOfPendingItem,
  askOfPermissionRequest,
  askOfQuestionRequest,
  isPlanGate,
  MAX_BUTTON_LABEL_CHARS,
  MAX_OPTION_BUTTONS,
  pendingNotificationFor,
  withoutContents,
  type AnswerableAsk,
  type NotificationActionLabels,
} from "./notification-actions"
import type { PendingItem, PermissionOptionInfo } from "./types"

const LABELS: NotificationActionLabels = {
  allow: "Allow",
  allowAlways: "Always allow",
  deny: "Deny",
  denyAlways: "Always deny",
  approve: "Approve",
  open: "Open",
  replyPlaceholder: "Type your answer…",
}

const OPEN = { id: "open", title: "Open", value: "" }

function permissionOption(
  option_id: string,
  kind: string,
  name = option_id
): PermissionOptionInfo {
  return { option_id, name, kind }
}

function question(
  labels: string[],
  over: Partial<NonNullable<AnswerableAsk["question"]>> = {}
): AnswerableAsk {
  return {
    id: "question:q1",
    kind: "question",
    source: "question",
    connectionId: "conn",
    requestId: "q1",
    options: labels.map((label) => ({ id: label, label })),
    question: {
      itemId: "q1-0",
      multiSelect: false,
      count: 1,
      secret: false,
      ...over,
    },
  }
}

const titles = (ask: AnswerableAsk) =>
  pendingNotificationFor(ask, LABELS).buttons.map((b) => b.title)

describe("pendingNotificationFor: permissions", () => {
  it("offers Allow and Deny, each sending its own option", () => {
    const ask = askOfPermissionRequest(
      "conn-child",
      "r1",
      [
        permissionOption("yes", "allow_once", "Yes"),
        permissionOption("no", "reject_once", "No"),
      ],
      { toolCallId: "t1", title: "rm -rf build" }
    )
    expect(pendingNotificationFor(ask, LABELS)).toEqual({
      pendingId: "permission:r1",
      source: "permission",
      connectionId: "conn-child",
      requestId: "r1",
      itemId: null,
      buttons: [
        { id: "b0", title: "Allow", value: "yes" },
        { id: "b1", title: "Deny", value: "no" },
        OPEN,
      ],
      reply: null,
    })
  })

  it("adds the always variants only when the request has them", () => {
    const ask = askOfPermissionRequest(
      "c",
      "r",
      [
        permissionOption("no-always", "reject_always"),
        permissionOption("yes-always", "allow_always"),
        permissionOption("yes", "allow_once"),
        permissionOption("no", "reject_once"),
      ],
      null
    )
    const pending = pendingNotificationFor(ask, LABELS)
    expect(pending.buttons).toEqual([
      { id: "b0", title: "Allow", value: "yes" },
      { id: "b1", title: "Always allow", value: "yes-always" },
      { id: "b2", title: "Deny", value: "no" },
      { id: "b3", title: "Always deny", value: "no-always" },
      OPEN,
    ])
  })

  it("offers nothing for options it cannot name", () => {
    const ask = askOfPermissionRequest(
      "c",
      "r",
      [permissionOption("x", "something_else")],
      null
    )
    expect(pendingNotificationFor(ask, LABELS).buttons).toEqual([])
  })
})

describe("pendingNotificationFor: plans", () => {
  it("approves Claude Code's plan with the mode the card leads with", () => {
    const ask = askOfPermissionRequest(
      "c",
      "r",
      [
        permissionOption("exit-plan-auto", "allow_always", "Yes, auto"),
        permissionOption("exit-plan-manual", "allow_once", "Yes, manual"),
        permissionOption("exit-plan-no", "reject_once", "No"),
      ],
      null
    )
    expect(ask.kind).toBe("plan")
    expect(pendingNotificationFor(ask, LABELS).buttons).toEqual([
      { id: "b0", title: "Approve", value: "exit-plan-auto" },
      OPEN,
    ])
  })

  it("approves a plan review with its allow option", () => {
    const ask = askOfPermissionRequest(
      "c",
      "r",
      [
        permissionOption("approve", "allow_once"),
        permissionOption("reject", "reject_once"),
      ],
      { toolCallId: "plan-review:item-1" }
    )
    expect(pendingNotificationFor(ask, LABELS).buttons).toEqual([
      { id: "b0", title: "Approve", value: "approve" },
      OPEN,
    ])
  })

  it("offers no Approve when the plan card cannot approve", () => {
    const ask = askOfPermissionRequest(
      "c",
      "r",
      [permissionOption("exit-plan-no", "reject_once")],
      null
    )
    expect(pendingNotificationFor(ask, LABELS).buttons).toEqual([])
  })

  it("approves a plan approval", () => {
    const ask: AnswerableAsk = {
      id: "plan_approval:a1",
      kind: "plan",
      source: "plan_approval",
      connectionId: "c",
      requestId: "a1",
      options: [],
      question: null,
    }
    expect(pendingNotificationFor(ask, LABELS).buttons).toEqual([
      { id: "b0", title: "Approve", value: "approve" },
      OPEN,
    ])
  })
})

describe("pendingNotificationFor: questions", () => {
  it("offers each option of a single-choice question, and a reply", () => {
    const pending = pendingNotificationFor(
      question(["Postgres (Recommended)", "SQLite"]),
      LABELS
    )
    expect(pending).toEqual({
      pendingId: "question:q1",
      source: "question",
      connectionId: "conn",
      requestId: "q1",
      itemId: "q1-0",
      buttons: [
        {
          id: "b0",
          title: "Postgres (Recommended)",
          value: "Postgres (Recommended)",
        },
        { id: "b1", title: "SQLite", value: "SQLite" },
        OPEN,
      ],
      reply: { placeholder: "Type your answer…" },
    })
  })

  it("takes a typed answer to an open question", () => {
    const pending = pendingNotificationFor(question([]), LABELS)
    expect(pending.buttons).toEqual([OPEN])
    expect(pending.reply).toEqual({ placeholder: "Type your answer…" })
  })

  it("never asks for a secret as text", () => {
    const pending = pendingNotificationFor(
      question(["Use the saved key", "Skip"], { secret: true }),
      LABELS
    )
    expect(pending.reply).toBeNull()
    expect(pending.buttons.map((b) => b.value)).toEqual([
      "Use the saved key",
      "Skip",
      "",
    ])
    expect(
      pendingNotificationFor(question([], { secret: true }), LABELS).buttons
    ).toEqual([])
  })

  it("only opens a multiple-choice question or a set of several", () => {
    for (const ask of [
      question(["A", "B"], { multiSelect: true }),
      question(["A", "B"], { count: 2 }),
      { ...question(["A", "B"]), question: null },
    ]) {
      const pending = pendingNotificationFor(ask, LABELS)
      expect(pending.buttons).toEqual([])
      expect(pending.reply).toBeNull()
    }
  })

  it("keeps the options off when one does not fit a button whole", () => {
    const fits = "x".repeat(MAX_BUTTON_LABEL_CHARS)
    expect(titles(question([fits, "B"]))).toEqual([fits, "B", "Open"])
    // Characters, not UTF-16 units.
    const emoji = "🚀".repeat(MAX_BUTTON_LABEL_CHARS)
    expect(titles(question([emoji, "B"]))).toEqual([emoji, "B", "Open"])
    const pending = pendingNotificationFor(question([`${fits}y`, "B"]), LABELS)
    expect(pending.buttons).toEqual([OPEN])
    expect(pending.reply).not.toBeNull()
  })

  it("keeps the options off past the most a notification offers", () => {
    const many = Array.from({ length: MAX_OPTION_BUTTONS + 1 }, (_, i) =>
      String(i)
    )
    expect(titles(question(many))).toEqual(["Open"])
    expect(titles(question(many.slice(1)))).toHaveLength(MAX_OPTION_BUTTONS + 1)
  })
})

describe("withoutContents", () => {
  it("drops the buttons and the reply, and keeps the item", () => {
    const full = pendingNotificationFor(question(["A", "B"]), LABELS)
    expect(withoutContents(full)).toEqual({
      ...full,
      buttons: [],
      reply: null,
    })
  })
})

describe("asks", () => {
  it("reads a pending item", () => {
    const item = {
      id: "question:q9",
      kind: "question",
      source: "question",
      connection_id: "conn-sub",
      request_id: "q9",
      options: [{ id: "A long label", label: "A long…" }],
      question: {
        item_id: "q9-0",
        header: "H",
        multi_select: false,
        count: 1,
        secret: true,
      },
    } as PendingItem
    expect(askOfPendingItem(item)).toEqual({
      id: "question:q9",
      kind: "question",
      source: "question",
      connectionId: "conn-sub",
      requestId: "q9",
      options: [{ id: "A long label", label: "A long…" }],
      question: { itemId: "q9-0", multiSelect: false, count: 1, secret: true },
    })
    // The answer carries the full label, not the shortened one.
    expect(
      pendingNotificationFor(askOfPendingItem(item), LABELS).buttons[0]
    ).toEqual({ id: "b0", title: "A long label", value: "A long label" })
  })

  it("reads a question request", () => {
    expect(
      askOfQuestionRequest("c", "q1", [
        {
          id: "q1-0",
          question: "Which?",
          header: "Pick",
          multi_select: false,
          options: [{ label: "A", description: "" }],
          is_secret: true,
        },
        {
          id: "q1-1",
          question: "And?",
          header: "More",
          multi_select: true,
          options: [],
        },
      ])
    ).toEqual({
      id: "question:q1",
      kind: "question",
      source: "question",
      connectionId: "c",
      requestId: "q1",
      options: [{ id: "A", label: "A" }],
      question: { itemId: "q1-0", multiSelect: false, count: 2, secret: true },
    })
  })

  it("tells a plan gate from a permission like the backend", () => {
    expect(isPlanGate(null, [{ option_id: "exit-plan-x" }])).toBe(true)
    expect(isPlanGate({ kind: "switch_mode" }, [])).toBe(true)
    expect(
      isPlanGate({ _meta: { claudeCode: { toolName: "ExitPlanMode" } } }, [])
    ).toBe(true)
    expect(isPlanGate({ toolCallId: "plan-review:1" }, [])).toBe(true)
    expect(isPlanGate({ kind: "execute", toolCallId: "t1" }, [])).toBe(false)
    expect(isPlanGate(undefined, [{ option_id: "allow" }])).toBe(false)
  })
})
