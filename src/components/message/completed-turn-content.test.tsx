import { StrictMode, type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { EMPTY_TOOL_APPROVALS } from "@/lib/activity/approval"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { ActivityLiveProvider } from "./activity/activity-live-context"
import {
  CompletedTurnContent,
  resetManualFoldMemory,
  splitAssistantTurnParts,
} from "./completed-turn-content"

// A hand-opened fold is also remembered by the reply's first tool call id, and
// the fixtures below reuse their ids from test to test.
beforeEach(() => resetManualFoldMemory())

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
// recycled row re-mounts open) and per first tool call id (so a rebuilt
// array does too), which makes a shared array a hidden channel between tests.
// Render tests take a fresh copy, and the id memory is reset before each.
const freshCompletedParts = (): AdaptedContentPart[] => [...COMPLETED_PARTS]

/**
 * Prose the agent is still writing fades in a character at a time, each its
 * own span while it does: it is found by the element that holds all of it.
 */
const writing = (text: string) => (_: string, element: Element | null) =>
  element?.textContent === text &&
  ![...element.children].some((child) => child.textContent === text)

/** The header's fold control: its label. */
const toggle = () =>
  screen.getByRole("button", { name: /^(Activity|Working)$/ })
const queryToggle = () =>
  screen.queryByRole("button", { name: /^(Activity|Working)$/ })

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

    const trigger = toggle()
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
    fireEvent.click(toggle())

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

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
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

    expect(queryToggle()).toBeNull()
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
    expect(queryToggle()).toBeNull()
    expect(
      screen.getByText(/Should I roll it out to dev\?/)
    ).toBeInTheDocument()
  })
})

describe("CompletedTurnContent with nothing left to show", () => {
  // A reply that ends on its last tool call has no trailing answer, so
  // collapsing would leave an empty bubble under a lone header.
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
    // now — but with no toggle that could hide the reply.
    expect(screen.getByText("Activity")).toBeInTheDocument()
    // The time follows the step count on the same line.
    const header = document.querySelector("div.activity-capsule")!
    expect(header.textContent).toMatch(/5s$/)
    expect(queryToggle()).toBeNull()
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

    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(queryToggle()).toBeNull()
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

    expect(document.querySelector("div.activity-capsule")!.textContent).toMatch(
      /1m 9s$/
    )
    const trigger = toggle()
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
    fireEvent.click(toggle())
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    first.unmount()

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "true")
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

    // A running reply's header says it is working, not how long it took.
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.queryByText(/1m 9s/)).not.toBeInTheDocument()
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(screen.getByText("src/app.tsx")).toBeInTheDocument()
    expect(
      screen.getByText(writing("The fix is complete."))
    ).toBeInTheDocument()
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

    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("does not replay the unfold when an open reply re-mounts", () => {
    // This component re-mounts while staying open: the detail refetch renames
    // the turn, and the virtualizer recycles scrolled-away rows. Each of those
    // would replay the 200ms unfold — the reply would look like it collapsed
    // and re-opened by itself.
    const foldBody = () =>
      document.querySelector('[data-slot="collapsible-content"]')

    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    // A real toggle DOES animate.
    fireEvent.click(toggle())
    expect(foldBody()).toHaveClass("reply-fold-enter")
    first.unmount()

    // Re-mounted already open (same `parts`, so the fold override survives).
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(foldBody()).not.toHaveClass("reply-fold-enter")
  })

  it("unfolds nothing when the failure link opens a reply that cannot fold", () => {
    // Stopped on a failed call, with no answer: its steps are on show already,
    // so opening it moves nothing.
    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "call-fail",
        toolName: "Bash",
        input: '{"command":"pnpm build"}',
        state: "output-error",
        errorText: "exit 1",
      },
    ]
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={9000} completed />
    )
    fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
    expect(
      document.querySelector('[data-slot="collapsible-content"]')
    ).not.toHaveClass("reply-fold-enter")
    vi.restoreAllMocks()
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
    fireEvent.click(toggle())
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

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
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

    expect(screen.getByText("Reply")).toBeInTheDocument()
    expect(screen.getByText("1m 9s")).toBeInTheDocument()
    expect(queryToggle()).toBeNull()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("keeps a header while the duration has not been backfilled yet", () => {
    // A reply settles before the post-turn reparse patches `duration_ms` onto
    // it. Dropping the header for that window made it blink out between
    // "Working" and "Reply · 3s"; the bare label holds the slot instead.
    renderWithIntl(
      <CompletedTurnContent
        parts={[{ type: "text", text: "Just an answer." }]}
        durationMs={null}
        completed
      />
    )

    expect(screen.getByText("Reply")).toBeInTheDocument()
    expect(screen.getByText("Just an answer.")).toBeInTheDocument()
  })

  it("stays invisible for an empty placeholder turn", () => {
    // Parsers emit blank assistant turns between tool exchanges. Heading one
    // would promote an invisible turn into a visible empty one.
    const { container } = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed />
    )

    expect(screen.queryByText("Reply")).not.toBeInTheDocument()
    expect(container.textContent).toBe("")
  })
})

describe("CompletedTurnContent: the turning mark while the agent works", () => {
  const RUNNING_PARTS = (): AdaptedContentPart[] => [
    { type: "text", text: "Checking the component." },
    {
      type: "tool-call",
      toolCallId: "call-run",
      toolName: "Read",
      input: '{"file_path":"src/app.tsx"}',
      state: "input-available",
    },
  ]
  const marks = (container: HTMLElement) =>
    container.querySelectorAll('[data-marker="working"]')
  const onRail = (container: HTMLElement) =>
    container.querySelector('.activity-timeline > [data-marker="working"]')
  /** The row that folds the open steps, at their foot. */
  const fold = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '.activity-timeline > [data-marker="foot"] > button'
    )

  it("hangs it off the rail while the timeline ends the reply", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={RUNNING_PARTS()}
        durationMs={null}
        completed={false}
      />
    )

    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)
    // Last on the rail, so the steps that join go in above it.
    expect(mark).not.toBeNull()
    expect(mark!.parentElement!.lastElementChild).toBe(mark)
    expect(mark).toHaveAttribute("aria-hidden", "true")
    // One plain element turns: every frame restyles it and its children, and
    // an SVG's turn would lay the page out too, for as long as it streams.
    const turning = mark!.querySelector(".animate-spin")
    expect(turning?.tagName).toBe("SPAN")
    expect(turning?.childElementCount).toBe(0)
    // A single ring: no fold row while the agent works.
    expect(fold(container)).toBeNull()
  })

  it("hangs it under the prose being written after the last step, on the rail", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={null}
        completed={false}
      />
    )

    // Until the reply ends there is no telling an aside from its closing
    // words: the prose is a step, the last on the rail, with the one ring
    // under it — not an answer under the steps with the ring turning above
    // the words being written.
    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)!
    expect(screen.getAllByText(writing("The fix is complete."))).toHaveLength(1)
    const prose = screen
      .getByText(writing("The fix is complete."))
      .closest(".activity-timeline > li")
    expect(prose).toHaveAttribute("data-marker", "dot")
    expect(prose!.nextElementSibling).toBe(mark)
  })

  it("keeps the next step's row under that prose, where it was written", () => {
    // The call that follows goes in under the prose, above the ring; the
    // prose's row stays the same element.
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={null} completed={false} />
    )
    const prose = screen
      .getByText(writing("The fix is complete."))
      .closest(".activity-timeline > li")!

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[
            ...parts,
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "Read",
              input: '{"file_path":"src/next.tsx"}',
              state: "input-available",
            },
          ]}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )

    expect(
      screen
        .getByText(writing("The fix is complete."))
        .closest(".activity-timeline > li")
    ).toBe(prose)
    const next = screen
      .getByText("src/next.tsx")
      .closest(".activity-timeline > li")!
    expect(prose.nextElementSibling).toBe(next)
    expect(next.nextElementSibling).toBe(onRail(view.container))
  })

  it("keeps the prose under the header, the mark under it, while the reply is folded", () => {
    // Folded there is no rail to put it on: the words being written stay in
    // view as the answer does.
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={null}
        completed={false}
      />
    )

    fireEvent.click(toggle())

    const prose = screen.getByText(writing("The fix is complete."))
    expect(prose.closest(".activity-timeline")).toBeNull()
    expect(marks(container)).toHaveLength(1)
    expect(onRail(container)).toBeNull()
    expect(
      prose.compareDocumentPosition(marks(container)[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("keeps a thought's row while what it says first is still short", () => {
    // Steps without an id of their own are keyed by an anchor hashed from the
    // reply's opening words, which change while those are still few.
    const thinking = (content: string): AdaptedContentPart[] => [
      { type: "reasoning", content, isStreaming: true },
    ]
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={thinking("Look")}
        durationMs={null}
        completed={false}
      />
    )
    const row = view.container.querySelector("li[data-step-key^='thought']")
    expect(row).not.toBeNull()
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={thinking("Looking at the repository layout first")}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )
    expect(view.container.querySelector("li[data-step-key^='thought']")).toBe(
      row
    )
  })

  it("hangs it on a rail from the header while the reply has nothing in it yet", () => {
    // The pending reply's shape too (`parts` empty): the reply's list stands
    // under the header with its foot alone, the ring where the first step
    // will go, the rail running down to it from the header.
    const { container } = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
    )

    expect(marks(container)).toHaveLength(1)
    const mark = onRail(container)!
    expect(mark).not.toBeNull()
    expect(mark.parentElement).toHaveAttribute("data-headed")
    expect(mark.parentElement!.children).toHaveLength(1)
    // No header toggle: there is nothing to fold yet.
    expect(queryToggle()).toBeNull()
  })

  it("hangs a reply's first words on that rail, the mark under them", () => {
    // Words with no step before them are a step while they are written, as
    // the words after a step are: the list that stood under the header takes
    // them in above its ring.
    const view = renderWithIntl(
      <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
    )
    const list = view.container.querySelector(".activity-timeline")!
    const mark = onRail(view.container)!

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[{ type: "text", text: "Let me look." }]}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )
    expect(view.container.querySelector(".activity-timeline")).toBe(list)
    expect(marks(view.container)).toHaveLength(1)
    expect(onRail(view.container)).toBe(mark)
    expect(screen.getAllByText(writing("Let me look."))).toHaveLength(1)
    const words = screen
      .getByText(writing("Let me look."))
      .closest(".activity-timeline > li")
    expect(words).toHaveAttribute("data-marker", "dot")
    expect(list.firstElementChild).toBe(words)
    expect(words!.nextElementSibling).toBe(mark)
    expect(list).not.toHaveAttribute("aria-hidden")
    // Still nothing to fold, and words are no step to count.
    expect(queryToggle()).toBeNull()
    expect(view.container.querySelector(".activity-capsule")).toHaveTextContent(
      /^Working$/
    )
  })

  it("grows the rail down to the first words of the reply that takes the pending reply's place", () => {
    // The pending reply stood as that list, its ring alone. The reply in its
    // place mounts with its first words, and they join the list as words
    // that came later would; a reply that mounts on its own (opened
    // mid-stream) draws its rail as it stands. In Strict Mode, as in
    // development: the effects run over again once the reply has taken the
    // pending reply's place.
    const thread = (pending: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="chat-motion-scope">
          {pending ? (
            <CompletedTurnContent
              key="pending"
              parts={[]}
              completed={false}
              pending
            />
          ) : (
            <CompletedTurnContent
              key="reply"
              parts={[{ type: "text", text: "Let me look." }]}
              durationMs={null}
              completed={false}
            />
          )}
        </div>
      </NextIntlClientProvider>
    )
    const words = () =>
      screen
        .getByText(writing("Let me look."))
        .closest(".activity-timeline > li")
    const view = render(thread(true), { wrapper: StrictMode })
    view.rerender(thread(false))
    expect(words()).toHaveAttribute("data-rail-enter")
    view.unmount()

    render(thread(false), { wrapper: StrictMode })
    expect(words()).not.toHaveAttribute("data-rail-enter")
  })

  it("keeps those words where they were written as the first step joins under them", () => {
    const words: AdaptedContentPart = { type: "text", text: "Let me look." }
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={[words]}
        durationMs={null}
        completed={false}
      />
    )
    const row = screen
      .getByText(writing("Let me look."))
      .closest(".activity-timeline > li")!

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={[
            words,
            {
              type: "tool-call",
              toolCallId: "call-first",
              toolName: "Read",
              input: '{"file_path":"src/next.tsx"}',
              state: "input-available",
            },
          ]}
          durationMs={null}
          completed={false}
        />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByText("Let me look.").closest(".activity-timeline > li")
    ).toBe(row)
    const next = screen
      .getByText("src/next.tsx")
      .closest(".activity-timeline > li")!
    expect(row.nextElementSibling).toBe(next)
    expect(next.nextElementSibling).toBe(onRail(view.container))
    // Now there is a step to fold.
    expect(toggle()).toHaveAttribute("aria-expanded", "true")
  })

  it("lifts a reply of words alone off the rail once it is done", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "Just an answer." },
    ]
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={null}
        completed={false}
        currentRound
        roundOpen
      />
    )
    expect(
      screen.getByText(writing("Just an answer.")).closest(".activity-timeline")
    ).not.toBeNull()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={3_000}
          completed
          currentRound
          roundOpen
        />
      </NextIntlClientProvider>
    )
    // Under its header as the answer, once, with no rail left over.
    expect(marks(view.container)).toHaveLength(0)
    expect(view.container.querySelector(".activity-timeline")).toBeNull()
    expect(screen.getAllByText("Just an answer.")).toHaveLength(1)
    expect(screen.getByText("Reply")).toBeInTheDocument()
    expect(queryToggle()).toBeNull()
  })

  it("moves it under the header when the reader folds the reply", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={RUNNING_PARTS()}
        durationMs={null}
        completed={false}
      />
    )

    fireEvent.click(toggle())

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(marks(container)).toHaveLength(1)
    expect(onRail(container)).toBeNull()
  })

  it("never turns two marks while the folding steps slide shut", () => {
    // jsdom runs no animations: report the fold's exit, which keeps the steps
    // mounted until it ends — the mark under the reply is there by then.
    const computed = window.getComputedStyle
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) =>
        element.classList.contains("reply-fold-body") &&
        element.getAttribute("data-state") === "closed"
          ? ({
              animationName: "reply-fold-close",
              animationDuration: "0.16s",
              animationDelay: "0s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
      )
    try {
      const { container } = renderWithIntl(
        <CompletedTurnContent
          parts={RUNNING_PARTS()}
          durationMs={null}
          completed={false}
        />
      )
      fireEvent.click(toggle())
      // Still sliding shut, its steps in view...
      expect(container.querySelector(".activity-timeline > li")).not.toBeNull()
      // ...with one turning mark, under the reply.
      expect(marks(container)).toHaveLength(1)
      expect(onRail(container)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it("shows the prose being written once while the folding steps slide shut", () => {
    // The steps stay mounted until the fold's exit ends; the words being
    // written leave the rail at once for their place under the header, not
    // drawn in both for the length of the slide.
    const computed = window.getComputedStyle
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) =>
        element.classList.contains("reply-fold-body") &&
        element.getAttribute("data-state") === "closed"
          ? ({
              animationName: "reply-fold-close",
              animationDuration: "0.16s",
              animationDelay: "0s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
      )
    try {
      const { container } = renderWithIntl(
        <CompletedTurnContent
          parts={freshCompletedParts()}
          durationMs={null}
          completed={false}
        />
      )
      fireEvent.click(toggle())
      expect(container.querySelector(".activity-timeline > li")).not.toBeNull()
      expect(screen.getAllByText(writing("The fix is complete."))).toHaveLength(
        1
      )
      expect(
        screen
          .getByText(writing("The fix is complete."))
          .closest(".activity-timeline")
      ).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    ["a permission request about one of its calls", "call-run"],
    ["a question or a plan to approve", null],
  ])("leaves it out while the agent waits on %s", (_, awaitingToolCallId) => {
    const { container } = renderWithIntl(
      <ActivityLiveProvider
        value={{
          awaitingToolCallId,
          awaitingUser: true,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent
          parts={RUNNING_PARTS()}
          durationMs={null}
          completed={false}
        />
      </ActivityLiveProvider>
    )

    expect(marks(container)).toHaveLength(0)
    // Nothing at work: the steps end on the row that folds them.
    expect(fold(container)).not.toBeNull()
  })

  it("stands no list in a reply with nothing in it while the agent waits on the user", () => {
    // The list stands for the turning ring alone; with nothing turning it
    // would be a rail to nothing.
    const { container } = renderWithIntl(
      <ActivityLiveProvider
        value={{
          awaitingToolCallId: null,
          awaitingUser: true,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent parts={[]} durationMs={null} completed={false} />
      </ActivityLiveProvider>
    )

    expect(marks(container)).toHaveLength(0)
    expect(container.querySelector(".activity-timeline")).toBeNull()
  })

  it("leaves a reply's first words on the rail while the agent waits on the user, nothing under them", () => {
    // No ring, and no row to fold steps it does not have.
    const { container } = renderWithIntl(
      <ActivityLiveProvider
        value={{
          awaitingToolCallId: null,
          awaitingUser: true,
          approvals: EMPTY_TOOL_APPROVALS,
        }}
      >
        <CompletedTurnContent
          parts={[{ type: "text", text: "Let me look." }]}
          durationMs={null}
          completed={false}
        />
      </ActivityLiveProvider>
    )

    expect(marks(container)).toHaveLength(0)
    expect(fold(container)).toBeNull()
    const words = screen
      .getByText(writing("Let me look."))
      .closest(".activity-timeline > li")
    expect(words).toHaveAttribute("data-marker", "dot")
    expect([...words!.parentElement!.children]).toEqual([words])
  })

  it("stops once the reply is done, the ring giving way to the fold row", () => {
    const parts = freshCompletedParts()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={null}
        completed={false}
        currentRound
        roundOpen
      />
    )
    expect(onRail(view.container)).not.toBeNull()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={4_000}
          completed
          currentRound
          roundOpen
        />
      </NextIntlClientProvider>
    )
    expect(marks(view.container)).toHaveLength(0)
    const row = fold(view.container)!
    expect(row).toHaveAccessibleName("Collapse 1 step · 4s")
    expect(row.querySelector("svg.lucide-chevron-up")).toBeTruthy()
    // The closing prose, a step while it was written, is lifted out under
    // the steps as the answer — once, not left on the rail as well.
    expect(screen.getAllByText("The fix is complete.")).toHaveLength(1)
    const answer = screen.getByText("The fix is complete.")
    expect(answer.closest(".activity-timeline")).toBeNull()
    expect(
      row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

// The turn from the 2026-10-06 report: the agent drew a logo placement, read
// the PNGs back, ran a few more commands and summed up. When the next message
// went out, the reply folded and every drawing went with it — the data was all
// there, the reader just stopped seeing it.
const IMAGE = (name: string) => ({
  name,
  data: "iVBORw0KGgo=",
  mime_type: "image/png",
  uri: null,
})
const drawingTurn = (): AdaptedContentPart[] => [
  { type: "reasoning", content: "Planning the drawing", isStreaming: false },
  {
    type: "tool-call",
    toolCallId: "toolu_render",
    toolName: "Bash",
    input: '{"command":"python3 draw.py"}',
    state: "output-available",
    output: "wrote placement.png",
  },
  {
    type: "generated-image",
    revisedPrompt: null,
    image: IMAGE("placement.png"),
    status: null,
    label: "Read placement.png",
  },
  {
    type: "tool-call",
    toolCallId: "toolu_check",
    toolName: "Bash",
    input: '{"command":"ls -la out"}',
    state: "output-available",
    output: "placement.png",
  },
  { type: "text", text: "The logo sits 24 px from the top-left corner." },
]

describe("images in a folded reply", () => {
  it("stay visible when the reply folds", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
      />
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    // The work is folded…
    expect(screen.queryByText(/python3 draw\.py/)).not.toBeInTheDocument()
    // …the drawing and the answer are not.
    expect(screen.getByAltText("placement.png")).toBeInTheDocument()
    expect(screen.getByText("Read placement.png")).toBeInTheDocument()
    expect(
      screen.getByText("The logo sits 24 px from the top-left corner.")
    ).toBeInTheDocument()
  })

  it("stay visible when a send folds the reply the reader was looking at", () => {
    const parts = drawingTurn()
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={parts}
        durationMs={149_000}
        completed
        foldEpoch={1}
      />
    )
    fireEvent.click(toggle())
    expect(screen.getAllByAltText("placement.png")).toHaveLength(1)

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CompletedTurnContent
          parts={parts}
          durationMs={149_000}
          completed
          foldEpoch={2}
        />
      </NextIntlClientProvider>
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByAltText("placement.png")).toBeInTheDocument()
  })

  it("render once, in place, when the reply is opened", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
      />
    )
    fireEvent.click(toggle())

    expect(screen.getAllByAltText("placement.png")).toHaveLength(1)
  })

  it("leave a reply that ends on its work as it was", () => {
    const [, render, image, check] = drawingTurn()
    renderWithIntl(
      <CompletedTurnContent
        parts={[render!, image!, check!]}
        durationMs={9_000}
        completed
      />
    )
    // Never folded: the image shows once, where it is.
    expect(screen.getAllByAltText("placement.png")).toHaveLength(1)
    expect(screen.getByText(/python3 draw\.py/)).toBeInTheDocument()
  })
})

describe("a reply the reader opened", () => {
  it("stays open when the thread rebuilds its parts", () => {
    // The next reply finishing refetches the conversation, and every settled
    // turn above comes back as a new `parts` array. Keyed on the array alone,
    // the reader's expansion was dropped and the reply snapped shut under them.
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
        foldEpoch={5}
      />
    )
    fireEvent.click(toggle())
    view.unmount()

    renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
        foldEpoch={5}
      />
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText(/python3 draw\.py/)).toBeInTheDocument()
  })

  it("still folds on the next send, keeping its images", () => {
    const view = renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
        foldEpoch={5}
      />
    )
    fireEvent.click(toggle())
    view.unmount()

    renderWithIntl(
      <CompletedTurnContent
        parts={drawingTurn()}
        durationMs={149_000}
        completed
        foldEpoch={6}
      />
    )

    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByAltText("placement.png")).toBeInTheDocument()
  })
})

describe("CompletedTurnContent: a sub-agent the provider stopped", () => {
  // Synthesized in the shape Claude Code hands back; not from any session.
  const BLOCKED =
    "API Error: 400 This request was blocked as it seems to violate the provider's terms of service on example misuse. To learn more, visit https://example.com/legal/terms."
  const P = enMessages.Folder.chat.providerError
  const stopped = P.subagentStopped.replace("{reason}", P.reason.policy_block)

  const turnWithAgent = (output: string): AdaptedContentPart[] => [
    { type: "text", text: "I'll have a sub-agent map the repository." },
    {
      type: "tool-call",
      toolCallId: "call-agent",
      toolName: "Agent",
      input: '{"subagent_type":"Explore","description":"Map the repository"}',
      state: "output-available",
      output,
    },
    { type: "text", text: "The sub-agent could not finish." },
  ]

  it("shows its stopped state under a shut fold, not only on the folded card", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={turnWithAgent(BLOCKED)}
        durationMs={12_000}
        completed
      />
    )
    expect(toggle()).toHaveAttribute("aria-expanded", "false")
    const surfaced = container.querySelector("[data-provider-error]")
    expect(surfaced).not.toBeNull()
    expect(surfaced).toHaveTextContent(stopped)
    // The provider's own message stays behind Details.
    expect(screen.queryByText(BLOCKED)).not.toBeInTheDocument()
  })

  it("leaves it to the card once the fold is opened", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={turnWithAgent(BLOCKED)}
        durationMs={12_000}
        completed
      />
    )
    fireEvent.click(toggle())
    expect(container.querySelectorAll("[data-provider-error]")).toHaveLength(1)
    expect(screen.getAllByText(stopped)).toHaveLength(1)
  })

  it("surfaces nothing for a sub-agent that finished normally", () => {
    const { container } = renderWithIntl(
      <CompletedTurnContent
        parts={turnWithAgent("Mapped 12 files.")}
        durationMs={12_000}
        completed
      />
    )
    expect(container.querySelector("[data-provider-error]")).toBeNull()
  })
})
