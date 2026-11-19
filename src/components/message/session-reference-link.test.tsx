import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  focus: vi.fn(),
  notify: vi.fn(),
}))

vi.mock("@/lib/session-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session-link")>()
  return {
    ...actual,
    openSessionLink: (...args: unknown[]) => mocks.open(...args),
    notifySessionLink: (...args: unknown[]) => mocks.notify(...args),
  }
})
vi.mock("@/lib/conversation-focus", () => ({
  requestConversationFocus: (...args: unknown[]) => mocks.focus(...args),
}))

import { SessionReferenceLink } from "./session-reference-link"

describe("SessionReferenceLink", () => {
  beforeEach(() => {
    mocks.open.mockReset()
    mocks.focus.mockReset()
    mocks.notify.mockReset()
  })

  it("opens its whole link, server and all, on a click", () => {
    const uri = "codeg://session/319?server=0123456789abcdef"
    const parent = vi.fn()
    render(
      <div onClick={parent}>
        <SessionReferenceLink
          data={{
            refType: "session",
            id: "319",
            label: "Notes",
            uri,
            meta: null,
          }}
        />
      </div>
    )
    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("title", uri)
    expect(screen.getByRole("img", { name: "session: Notes" })).toHaveAttribute(
      "data-ref-type",
      "session"
    )

    fireEvent.click(button)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    const [opened, deps] = mocks.open.mock.calls[0]
    expect(opened).toBe(uri)
    // The click is the badge's: a message bubble's own click does not see it.
    expect(parent).not.toHaveBeenCalled()

    // What it opens here goes to the workspace's focus queue, and what it has
    // to say to the workspace's notifier.
    const target = { folderId: 4, conversationId: 319, agent: "codex" }
    deps.openHere(target)
    expect(mocks.focus).toHaveBeenCalledWith(target)
    const notice = { key: "notFound", values: { session: "319" } }
    deps.notify(notice)
    expect(mocks.notify).toHaveBeenCalledWith(notice)
  })

  it("builds the link from the id when the badge has no uri", () => {
    render(
      <SessionReferenceLink
        data={{
          refType: "session",
          id: "7",
          label: "#7",
          uri: null,
          meta: null,
        }}
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(mocks.open.mock.calls[0][0]).toBe("codeg://session/7")
  })
})
