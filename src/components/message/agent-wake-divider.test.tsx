import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

import { AgentWakeDivider, agentWakeFromParts } from "./agent-wake-divider"

/** A wake marker's System group, as the adapter hands it over: the caption
 *  for text-only clients, then the marker call carrying the meta. */
function wakeParts(
  triggers: Array<{ kind: string; text: string }>
): AdaptedContentPart[] {
  return [
    { type: "text", text: "Pi continued on its own, woken by …" },
    {
      type: "tool-call",
      toolCallId: "pi-wake-a3",
      toolName: "agent_wake",
      input: null,
      state: "output-available",
      meta: { "codeg.agentWake": { version: 1, triggers } },
    },
  ]
}

function renderDivider(parts: AdaptedContentPart[]) {
  const wake = agentWakeFromParts(parts)
  if (!wake) throw new Error("no wake marker")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentWakeDivider wake={wake} />
    </NextIntlClientProvider>
  )
}

describe("AgentWakeDivider", () => {
  it("says the agent carried on by itself, and why", () => {
    renderDivider(
      wakeParts([{ kind: "jobExit", text: "✅ Background job finished" }])
    )
    expect(
      screen.getByText(
        "Continued on its own · woken by a background job ending"
      )
    ).toBeInTheDocument()
    // The notice itself, verbatim, behind the toggle.
    expect(
      screen.queryByText("✅ Background job finished")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("model-notes-toggle"))
    expect(screen.getByText("✅ Background job finished")).toBeInTheDocument()
  })

  it("counts the other notices that arrived with the first", () => {
    renderDivider(
      wakeParts([
        { kind: "subagentQuestion", text: "Subagent needs a decision" },
        { kind: "subagentSettled", text: "Workflow child failed" },
      ])
    )
    expect(
      screen.getByText(
        "Continued on its own · woken by a sub-agent's question and 1 more notice"
      )
    ).toBeInTheDocument()
  })

  it("finds no marker in an ordinary system note", () => {
    expect(
      agentWakeFromParts([{ type: "text", text: "explored approach A" }])
    ).toBeNull()
  })
})
