import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  CompletedTurnContent,
  splitAssistantTurnParts,
} from "./completed-turn-content"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const COMPLETED_PARTS: AdaptedContentPart[] = [
  {
    type: "reasoning",
    content: "Inspecting the repository",
    isStreaming: false,
  },
  { type: "text", text: "I found the relevant component." },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    input: '{"file_path":"src/app.tsx"}',
    state: "output-available",
    output: "source",
  },
  { type: "text", text: "The fix is complete." },
]

// Expansion is remembered per `parts` array identity (so a virtualizer-
// recycled row re-mounts open), which makes a shared array a hidden channel
// between tests. Render tests take a fresh copy.
const freshCompletedParts = (): AdaptedContentPart[] => [...COMPLETED_PARTS]

describe("splitAssistantTurnParts", () => {
  it("keeps only the trailing final response outside progress", () => {
    const split = splitAssistantTurnParts(COMPLETED_PARTS)

    expect(split.progress).toEqual(COMPLETED_PARTS.slice(0, 3))
    expect(split.answer).toEqual(COMPLETED_PARTS.slice(3))
  })

  it("does not guess within a text-only answer", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "First paragraph" },
      { type: "text", text: "Second paragraph" },
    ]

    const split = splitAssistantTurnParts(parts)
    expect(split.progress).toEqual([])
    expect(split.answer).toEqual(parts)
  })
})

// The turn from the bug report (2026-10-02, 10:18 UTC): a long final report
// ending on a question, then the user's global Stop hook blocked once, and the
// agent thought briefly and replied to the hook in one line. Folding at the
// last progress item put the whole report, question included, behind the chip.
const REPORT =
  "I built changes 1–3 and tested them. Nothing is merged or deployed yet.\n\n" +
  "**What's built.** It's on the OCR-service branch `feat/ocr-fast-profile`, in 2 commits, and all 160 tests pass.\n\n" +
  "**Decision for you:** go ahead with the dev rollout?"
const HOOK_FEEDBACK =
  "Browser check outstanding. This session changed 2 file(s) that a person sees in a browser, and no browser tool was used on any of them:\n" +
  "  - case-ledger-process.html\n\n" +
  "If a browser check genuinely does not apply, say which in your final message and stop again. This will not fire twice."
const HOOK_REPLY =
  "Neither of those files changed this turn, so no browser check is needed."

const stopHookTurn = (): AdaptedContentPart[] => [
  {
    type: "reasoning",
    content: "Planning the rollout test",
    isStreaming: false,
  },
  {
    type: "tool-call",
    toolCallId: "call-tests",
    toolName: "Bash",
    input: '{"command":"pytest"}',
    state: "output-available",
    output: "160 passed",
  },
  { type: "text", text: REPORT },
  { type: "hook-feedback", event: "Stop", feedback: HOOK_FEEDBACK },
  { type: "reasoning", content: "Neither file changed", isStreaming: false },
  { type: "text", text: HOOK_REPLY },
]

describe("a reply a Stop hook reopened", () => {
  it("splits at the hook, so the answer before it stays an answer", () => {
    const parts = stopHookTurn()
    const split = splitAssistantTurnParts(parts)

    expect(split.segments).toEqual([
      { hook: null, progress: parts.slice(0, 2), answer: [parts[2]] },
      { hook: parts[3], progress: [parts[4]], answer: [parts[5]] },
    ])
    expect(split.answer).toEqual([parts[2], parts[5]])
    expect(split.progress).toEqual([parts[0], parts[1], parts[4]])
  })

  it("keeps the report, the hook marker and the reply visible when folded", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={stopHookTurn()}
        durationMs={506_000}
        completed
      />
    )

    const trigger = screen.getByRole("button", { name: "Worked for 8m 26s" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText(/Decision for you:/)).toBeInTheDocument()
    expect(
      screen.getByText(/go ahead with the dev rollout\?/)
    ).toBeInTheDocument()
    expect(screen.getByText(HOOK_REPLY)).toBeInTheDocument()

    // The marker names the hook and the first line of its feedback.
    const marker = screen.getByRole("button", {
      name: /Stop hook: Browser check outstanding\./,
    })
    expect(marker).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.queryByText(/This will not fire twice/)
    ).not.toBeInTheDocument()

    // Both stretches' work is folded: the tool card before the hook and the
    // reasoning after it.
    expect(screen.queryByRole("button", { name: /pytest/ })).toBeNull()
    expect(screen.queryByText("Neither file changed")).not.toBeInTheDocument()

    // The marker opens on the whole feedback.
    fireEvent.click(marker)
    expect(marker).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText(/This will not fire twice/)).toBeInTheDocument()
  })

  it("reads in order when the work is unfolded", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={stopHookTurn()}
        durationMs={506_000}
        completed
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Worked for 8m 26s" }))

    const text = container.textContent ?? ""
    const at = (needle: string) => {
      const index = text.indexOf(needle)
      expect(index, needle).toBeGreaterThanOrEqual(0)
      return index
    }
    expect(at("pytest")).toBeLessThan(at("Decision for you"))
    expect(at("Decision for you")).toBeLessThan(at("Stop hook"))
    expect(at("Stop hook")).toBeLessThan(at(HOOK_REPLY))
  })

  it("still shows the report when nothing before the hook was work", () => {
    // Text-only answer, hook, then work: the hook's work must not drag the
    // answer into the fold either.
    const parts = stopHookTurn().slice(2)
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={9_000} completed />
    )

    expect(
      screen.getByRole("button", { name: "Worked for 9s" })
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText(/Decision for you:/)).toBeInTheDocument()
    expect(screen.getByText(HOOK_REPLY)).toBeInTheDocument()
    expect(screen.queryByText("Neither file changed")).not.toBeInTheDocument()
  })

  it("stays expanded when the reply to the hook stopped on its work", () => {
    // The earlier stretch's answer must not make it safe to fold away the card
    // the reply finally stopped on.
    const parts: AdaptedContentPart[] = [
      ...stopHookTurn().slice(0, 4),
      {
        type: "tool-call",
        toolCallId: "call-final",
        toolName: "attempt_completion",
        input: '{"result":"Checked in the browser."}',
        state: "output-available",
        output: null,
      },
    ]
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={9_000} completed />
    )

    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull()
    expect(screen.getByText(/Decision for you:/)).toBeInTheDocument()
    expect(
      screen.getAllByText("Checked in the browser.").length
    ).toBeGreaterThan(0)
  })

  it("shows the marker inline while the turn is still running", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={stopHookTurn().slice(0, 5)}
        durationMs={null}
        completed={false}
      />
    )

    expect(screen.getByText(/Decision for you:/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Stop hook: Browser check/ })
    ).toBeInTheDocument()
    // Both stretches' work is out in the open while it runs: the reasoning
    // capsules before and after the hook.
    expect(screen.getAllByText("Thought")).toHaveLength(2)
    expect(
      screen.getByRole("button", { name: /Read|pytest|Bash/ })
    ).toBeInTheDocument()
  })
})

describe("a long note before the reply's last work", () => {
  const NOTE =
    "Here is where things stand. " +
    "The OCR path now runs on the fast profile and every check passes. ".repeat(
      10
    ) +
    "Should I roll it out to dev?"
  const noteTurn = (closing: string): AdaptedContentPart[] => [
    { type: "reasoning", content: "Checking", isStreaming: false },
    { type: "text", text: NOTE },
    {
      type: "tool-call",
      toolCallId: "call-lint",
      toolName: "Bash",
      input: '{"command":"pnpm lint"}',
      state: "output-available",
      output: "ok",
    },
    { type: "text", text: closing },
  ]

  it("stays visible when the reply then closes on a short line", () => {
    expect(NOTE.length).toBeGreaterThanOrEqual(600)
    const parts = noteTurn("Lint is clean too.")
    expect(
      splitAssistantTurnParts(parts, { keepLongNotes: true }).segments
    ).toEqual([
      { hook: null, progress: [parts[0]], answer: [parts[1]] },
      { hook: null, progress: [parts[2]], answer: [parts[3]] },
    ])

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={30_000} completed />
    )
    expect(
      screen.getByText(/Should I roll it out to dev\?/)
    ).toBeInTheDocument()
    expect(screen.getByText("Lint is clean too.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /pnpm lint/ })).toBeNull()
    expect(screen.queryByText("Checking")).not.toBeInTheDocument()
  })

  it("folds as before when the closing answer is itself long", () => {
    const parts = noteTurn("Final summary. ".repeat(45))
    expect(
      splitAssistantTurnParts(parts, { keepLongNotes: true }).segments
    ).toHaveLength(1)

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={30_000} completed />
    )
    expect(
      screen.queryByText(/Should I roll it out to dev\?/)
    ).not.toBeInTheDocument()
  })

  it("is left alone while the reply is still streaming", () => {
    const parts = noteTurn("Lint is clean too.")
    expect(splitAssistantTurnParts(parts).segments).toHaveLength(1)
  })

  it("does not make a reply that ends on its work foldable", () => {
    // No closing answer: the reply stays fully expanded, exactly as before.
    const parts = noteTurn("").slice(0, 3)
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={30_000} completed />
    )
    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull()
    expect(
      screen.getByText(/Should I roll it out to dev\?/)
    ).toBeInTheDocument()
  })
})

describe("CompletedTurnContent with nothing left to show", () => {
  // A reply that ends on its last tool call has no trailing answer, so
  // collapsing would leave an empty bubble under a lone "Worked for" chip.
  // Reachable on every agent (a turn stopped mid-tool-call) and by design on
  // some: Cline's `attempt_completion` card and a plan-mode turn's
  // ExitPlanMode card ARE the answer.
  const TOOL_ONLY_PARTS: AdaptedContentPart[] = [
    { type: "text", text: "Wrapping up." },
    {
      type: "tool-call",
      toolCallId: "call-final",
      toolName: "attempt_completion",
      input: '{"result":"All done."}',
      state: "output-available",
      output: null,
    },
  ]

  it("stays expanded when the reply ends on progress", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={TOOL_ONLY_PARTS}
        durationMs={5_000}
        completed
      />
    )

    // The header still reports the duration — it is the only place that does
    // now — but as a static row, with no toggle that could hide the reply.
    expect(screen.getByText("Worked for 5s")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull()
    expect(screen.getByText("Wrapping up.")).toBeInTheDocument()
    // The completion card renders the result as both its header title and its
    // body, so match on presence rather than a unique node.
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })

  it("does not treat a blank trailing text part as the answer", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={[...TOOL_ONLY_PARTS, { type: "text", text: "   \n" }]}
        durationMs={5_000}
        completed
      />
    )

    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull()
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })

  it("keeps folding it away impossible even after a send folds the thread", () => {
    // The "send folds everything above" epoch bump must not reach a reply that
    // has no answer to fall back on.
    const parts = [...TOOL_ONLY_PARTS]
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={5_000}
        completed
        foldEpoch={0}
      />
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={5_000}
          completed
          foldEpoch={1}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })
})

describe("CompletedTurnContent", () => {
  it("collapses completed progress by default and keeps the answer visible", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed
      />
    )

    const trigger = screen.getByRole("button", { name: "Worked for 1m 9s" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
    expect(
      screen.queryByText("I found the relevant component.")
    ).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
  })

  it("re-mounts expanded after the virtualizer recycled the row", () => {
    // Scrolling a turn past the overscan buffer unmounts it; coming back must
    // not re-hide work the reader had opened. Same `parts` reference across
    // both mounts — that is what survives the recycle in the real thread.
    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    fireEvent.click(screen.getByRole("button", { name: "Worked for 1m 9s" }))
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    first.unmount()

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )

    expect(
      screen.getByRole("button", { name: "Worked for 1m 9s" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("leaves running progress expanded under a live header", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed={false}
      />
    )

    expect(screen.queryByText("Worked for 1m 9s")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Working..." })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Read src\/app\.tsx/ })
    ).toBeInTheDocument()
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
  })

  it("does not fold the round when the reply finishes", () => {
    // The regression this guards: fold state used to be keyed on the `parts`
    // array, which the stream settling replaces — so a reply folded itself up
    // the instant it finished. The host owns the round positionally now, so a
    // re-adapted (new array) settled reply must stay exactly as open as it was.
    const live = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={live}
        durationMs={null}
        completed={false}
        currentRound
        roundOpen
        foldEpoch={0}
      />
    )
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()

    // Settling re-adapts the turn: same content, brand-new array.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={freshCompletedParts()}
          durationMs={69_000}
          completed
          currentRound
          roundOpen
          foldEpoch={0}
        />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByRole("button", { name: "Worked for 1m 9s" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("does not replay the unfold when an open reply re-mounts", () => {
    // This component re-mounts constantly while staying open: the row key flips
    // `streaming-…` → `persisted-…` the instant a reply settles, the detail
    // refetch renames the turn, and the virtualizer recycles scrolled-away
    // rows. Each of those would replay the 200ms unfold — the reply would look
    // like it collapsed and re-opened by itself.
    const foldBody = () =>
      document.querySelector('[data-slot="collapsible-content"]')

    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    // A real toggle DOES animate.
    fireEvent.click(screen.getByRole("button", { name: "Worked for 1m 9s" }))
    expect(foldBody()).toHaveClass("reply-fold-enter")
    first.unmount()

    // Re-mounted already open (same `parts`, so the fold override survives).
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    expect(
      screen.getByRole("button", { name: "Worked for 1m 9s" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(foldBody()).not.toHaveClass("reply-fold-enter")
  })

  it("folds a hand-opened reply when a send bumps the epoch", () => {
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={69_000}
        completed
        foldEpoch={3}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Worked for 1m 9s" }))
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={69_000}
          completed
          foldEpoch={4}
        />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByRole("button", { name: "Worked for 1m 9s" })
    ).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.queryByText("I found the relevant component.")
    ).not.toBeInTheDocument()
  })

  it("shows a static duration header on a reply with nothing to fold", () => {
    // The reply's footer no longer carries a duration chip, so a plain prose
    // answer would otherwise lose its elapsed time entirely.
    renderWithIntl(
      <CompletedTurnContent
        parts={[{ type: "text", text: "Just an answer." }]}
        durationMs={69_000}
        completed
      />
    )

    expect(screen.getByText("Worked for 1m 9s")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Worked for/ })).toBeNull()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("keeps a header while the duration has not been backfilled yet", () => {
    // A reply settles before the post-turn reparse patches `duration_ms` onto
    // it. Dropping the header for that window made it blink out between
    // "Working..." and "Worked for 3s"; the settled-no-duration label holds
    // the slot instead.
    renderWithIntl(
      <CompletedTurnContent
        parts={[{ type: "text", text: "Just an answer." }]}
        durationMs={null}
        completed
      />
    )

    expect(screen.getByText("Finished working")).toBeInTheDocument()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("stays invisible for an empty placeholder turn", () => {
    // Parsers emit blank assistant turns between tool exchanges. Heading one
    // would promote an invisible turn into a visible empty one.
    const { container } = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed />
    )

    expect(screen.queryByText("Finished working")).not.toBeInTheDocument()
    expect(container.textContent).toBe("")
  })
})
