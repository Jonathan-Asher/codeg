import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { SubagentReadOnlyBar } from "./subagent-read-only-bar"

function renderBar(props: Partial<Parameters<typeof SubagentReadOnlyBar>[0]>) {
  const onShowParent = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SubagentReadOnlyBar
        parentTitle="Fix the login bug"
        subagentType="Explore"
        running={false}
        onShowParent={onShowParent}
        {...props}
      />
    </NextIntlClientProvider>
  )
  const bar = view.container.querySelector("[data-subagent-read-only-bar]")
  if (!bar) throw new Error("no bar")
  return { bar: bar as HTMLElement, onShowParent }
}

describe("a sub-agent tab's read-only bar", () => {
  it("says whose sub-agent it is, its type, and that it is read-only", () => {
    const { bar } = renderBar({})
    expect(bar.textContent).toContain(
      "Sub-agent of Fix the login bug · Explore · read-only"
    )
    expect(bar.querySelector("textarea, [contenteditable]")).toBeNull()
  })

  it("links back to the parent session", () => {
    const { onShowParent } = renderBar({})
    fireEvent.click(screen.getByRole("button", { name: "Fix the login bug" }))
    expect(onShowParent).toHaveBeenCalledTimes(1)
  })

  it("leaves out a type it does not know", () => {
    const { bar } = renderBar({ subagentType: null })
    expect(bar.textContent).toContain(
      "Sub-agent of Fix the login bug · read-only"
    )
  })

  it("names an untitled session generically", () => {
    const { bar } = renderBar({ parentTitle: "  " })
    expect(bar.textContent).toContain("Sub-agent of its session")
  })

  it("says so while the sub-agent works", () => {
    expect(renderBar({ running: true }).bar.textContent).toContain("Running")
  })
})
