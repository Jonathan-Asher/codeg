import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

// Plan markdown and permission content go through Streamdown, which is heavy
// and beside the point here.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { PermissionDialog } from "./permission-dialog"
import { PlanApprovalCard } from "./plan-approval-card"
import enMessages from "@/i18n/messages/en.json"
import type { PendingPermission } from "@/contexts/acp-connections-context"
import type { PendingPlanApprovalState, PlanApprovalAnswer } from "@/lib/types"

/** A conversation scope with a composer under the card. */
function Scope({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-composer-scope="">
        {children}
        <textarea data-composer-input="" aria-label="Composer" />
      </div>
    </NextIntlClientProvider>
  )
}

const options = [
  { option_id: "always", name: "Always allow", kind: "allow_always" },
  { option_id: "once", name: "Allow", kind: "allow_once" },
  { option_id: "reject", name: "Reject", kind: "reject_once" },
]

function permission(over: Partial<PendingPermission> = {}): PendingPermission {
  return {
    request_id: "req-1",
    tool_call: { title: "ls", kind: "execute" },
    options,
    ...over,
  }
}

function renderPermission(p: PendingPermission) {
  const onRespond = vi.fn()
  render(
    <Scope>
      <PermissionDialog permission={p} onRespond={onRespond} />
    </Scope>
  )
  return onRespond
}

describe("PermissionDialog keyboard", () => {
  it("lands on the one-time approval, never the standing one, and Enter answers with it", async () => {
    const user = userEvent.setup()
    const onRespond = renderPermission(permission())
    expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onRespond).toHaveBeenCalledWith("req-1", "once")
    // The last request answered: the keyboard is back in the composer.
    expect(screen.getByLabelText("Composer")).toHaveFocus()
  })

  it("a digit answers with that option", async () => {
    const user = userEvent.setup()
    const onRespond = renderPermission(permission())
    await user.keyboard("3")
    expect(onRespond).toHaveBeenCalledWith("req-1", "reject")
  })

  it("arrows move between the options without answering", async () => {
    const user = userEvent.setup()
    const onRespond = renderPermission(permission())
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("button", { name: "Reject" })).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("button", { name: "Always allow" })).toHaveFocus()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it("Esc goes back to the composer without answering", async () => {
    const user = userEvent.setup()
    const onRespond = renderPermission(permission())
    await user.keyboard("{Escape}")
    expect(screen.getByLabelText("Composer")).toHaveFocus()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it("keeps the keyboard while more requests are queued", async () => {
    const user = userEvent.setup()
    renderPermission(permission({ queued: 2 }))
    await user.keyboard("{Enter}")
    expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus()
  })

  it("a held key answers once", () => {
    const onRespond = renderPermission(permission())
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
      key: "Enter",
      repeat: true,
    })
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
      key: "2",
      repeat: true,
    })
    expect(onRespond).not.toHaveBeenCalled()
  })

  it("on a defaultToNo ask, lands on the decline and an approval's number only moves to it", async () => {
    const user = userEvent.setup()
    const onRespond = renderPermission(
      permission({
        tool_call: {
          title: "rm -rf build",
          kind: "execute",
          _meta: { permission: { version: 1, defaultToNo: true } },
        },
        options: [
          { option_id: "reject", name: "Reject", kind: "reject_once" },
          { option_id: "once", name: "Allow", kind: "allow_once" },
        ],
      })
    )
    expect(screen.getByRole("button", { name: "Reject" })).toHaveFocus()
    await user.keyboard("2")
    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onRespond).toHaveBeenCalledWith("req-1", "once")
  })
})

function plan(): PendingPlanApprovalState {
  return {
    approval_id: "ap-1",
    tool_call_id: "call-1",
    plan_markdown: "1. Do it",
    created_at: "2026-01-01T00:00:00Z",
  }
}

function renderPlan() {
  const onAnswer = vi.fn<(id: string, a: PlanApprovalAnswer) => void>()
  render(
    <Scope>
      <PlanApprovalCard approval={plan()} onAnswer={onAnswer} />
    </Scope>
  )
  return onAnswer
}

describe("PlanApprovalCard keyboard", () => {
  it("lands on Approve, and Enter approves", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPlan()
    expect(
      screen.getByRole("button", { name: "Approve & build" })
    ).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledWith("ap-1", {
      decision: "approve",
      feedback: null,
    })
    await act(async () => {})
    expect(screen.getByLabelText("Composer")).toHaveFocus()
  })

  it("1 approves", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPlan()
    screen.getByRole("button", { name: "Request changes" }).focus()
    await user.keyboard("1")
    expect(onAnswer).toHaveBeenCalledWith("ap-1", {
      decision: "approve",
      feedback: null,
    })
  })

  it("2 opens the notes; the send key sends them, Esc closes them", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPlan()
    await user.keyboard("2")
    const notes = screen.getByPlaceholderText("What should change?")
    expect(notes).toHaveFocus()
    await user.keyboard("smaller{Escape}")
    expect(
      screen.getByRole("button", { name: "Request changes" })
    ).toHaveFocus()
    expect(onAnswer).not.toHaveBeenCalled()
    await user.keyboard("2")
    await user.keyboard(" steps{Enter}")
    expect(onAnswer).toHaveBeenCalledWith("ap-1", {
      decision: "request_changes",
      feedback: "smaller steps",
    })
  })

  it("3 only moves to Abandon; Enter there confirms", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPlan()
    await user.keyboard("3")
    expect(screen.getByRole("button", { name: "Abandon" })).toHaveFocus()
    expect(onAnswer).not.toHaveBeenCalled()
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledWith("ap-1", {
      decision: "abandon",
      feedback: null,
    })
  })

  it("Esc goes back to the composer and decides nothing", async () => {
    const user = userEvent.setup()
    const onAnswer = renderPlan()
    await user.keyboard("{Escape}")
    expect(screen.getByLabelText("Composer")).toHaveFocus()
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
