import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("use-stick-to-bottom", () => {
  const Content = ({
    children,
    className,
  }: {
    children?: ReactNode
    className?: string
  }) => (
    <div data-testid="thread-content" className={className}>
      {children}
    </div>
  )
  const StickToBottom = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    { Content }
  )
  return { StickToBottom, useStickToBottomContext: () => ({}) }
})

import { MessageThreadContent } from "./message-thread"

describe("MessageThreadContent and the chat text size", () => {
  // Every transcript (workspace tabs and split panes, canvas cards, the live
  // and sub-agent drawers, Quick Ask) renders its rows inside this element, so
  // it carries the scope the chat text size applies through.
  it("marks the transcript's rows as chat text", () => {
    render(
      <MessageThreadContent className="gap-3 px-4 py-3">
        <p>reply</p>
      </MessageThreadContent>
    )
    const content = screen.getByTestId("thread-content")
    expect(content).toHaveClass("chat-text-scope")
    // A caller's classes still merge in.
    expect(content).toHaveClass("gap-3")
    expect(content).toContainElement(screen.getByText("reply"))
  })
})
