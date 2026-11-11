import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AskQuestionCard } from "./ask-question-card"
import enMessages from "@/i18n/messages/en.json"
import type { PendingQuestionState, QuestionAnswer } from "@/lib/types"

function renderCard(question: PendingQuestionState, onAnswer = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AskQuestionCard question={question} onAnswer={onAnswer} />
    </NextIntlClientProvider>
  )
  return onAnswer
}

/** Render with an explicit (typically async) `onAnswer`, returning the render
 *  result so a test can reach into `container` for the spinner. */
function renderWith(
  question: PendingQuestionState,
  onAnswer: (questionId: string, answer: QuestionAnswer) => void | Promise<void>
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AskQuestionCard question={question} onAnswer={onAnswer} />
    </NextIntlClientProvider>
  )
}

/** A manually-resolvable promise so a test can hold the answer round-trip
 *  "in flight" and assert the card's disabled/spinner state. */
function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const single: PendingQuestionState = {
  question_id: "q-1",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "Which approach?",
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "smaller diffs" },
        { label: "Rewrite", description: "clean slate" },
      ],
    },
  ],
}

const multi: PendingQuestionState = {
  question_id: "q-2",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qb",
      question: "Which modules?",
      header: "Scope",
      multi_select: true,
      options: [
        { label: "auth", description: "" },
        { label: "billing", description: "" },
        { label: "ui", description: "" },
      ],
    },
  ],
}

// Two single-select questions — exercises the tabbed multi-question layout.
const twoSingle: PendingQuestionState = {
  question_id: "q-two",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "First question?",
      header: "First",
      multi_select: false,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
    {
      id: "qb",
      question: "Second question?",
      header: "Second",
      multi_select: false,
      options: [
        { label: "P", description: "" },
        { label: "Q", description: "" },
      ],
    },
  ],
}

// First question is multi-select — used to assert it does NOT auto-advance.
const twoMultiFirst: PendingQuestionState = {
  question_id: "q-two-multi",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "First question?",
      header: "First",
      multi_select: true,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
    {
      id: "qb",
      question: "Second question?",
      header: "Second",
      multi_select: false,
      options: [
        { label: "P", description: "" },
        { label: "Q", description: "" },
      ],
    },
  ],
}

describe("AskQuestionCard", () => {
  it("submits a single-select choice keyed by question id", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["Incremental"] }],
      declined: false,
    })
  })

  it("disables Submit until something is selected", () => {
    renderCard(single)
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    expect(submit).not.toBeDisabled()
  })

  it("clears a single-select choice when the chosen option is clicked again", () => {
    renderCard(single)
    const submit = screen.getByRole("button", { name: "Submit" })
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(submit).not.toBeDisabled()
    // Re-clicking the already-selected option deselects it (radix won't fire
    // onValueChange for the same value, so the card handles this via onClick).
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(submit).toBeDisabled()
  })

  it("collects multiple labels in multi-select", () => {
    const onAnswer = renderCard(multi)
    fireEvent.click(screen.getByRole("checkbox", { name: "auth" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "billing" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-2", {
      answers: [{ questionId: "qb", labels: ["auth", "billing"] }],
      declined: false,
    })
  })

  it("renders radio controls for single-select and checkboxes for multi-select", () => {
    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    // Two real options + the host-injected "Other" row, all radios.
    expect(screen.getAllByRole("radio")).toHaveLength(3)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    unmount()

    renderCard(multi)
    // Three real options + "Other", all checkboxes.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4)
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
  })

  it("submits the typed Other text as the answer label", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
      target: { value: "a third way" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["a third way"] }],
      declined: false,
    })
  })

  it("single-select Other replaces a prior option choice", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    fireEvent.change(screen.getByPlaceholderText("Type your answer…"), {
      target: { value: "custom" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["custom"] }],
      declined: false,
    })
  })

  it("renders a free-text question (no options) as a bare input and submits it", () => {
    // Codex elicitation / MCP-server forms ask open questions with 0 options:
    // the input is the answer field — no "Other" toggle to click through.
    const freeText: PendingQuestionState = {
      question_id: "q-free",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qf",
          question: "What is the base URL?",
          header: "URL",
          multi_select: false,
          options: [],
        },
      ],
    }
    const onAnswer = renderCard(freeText)
    expect(screen.queryByRole("radio")).toBeNull()
    const input = screen.getByPlaceholderText("Type your answer…")
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: "https://api.example.com" } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith("q-free", {
      answers: [{ questionId: "qf", labels: ["https://api.example.com"] }],
      declined: false,
    })
  })

  it("masks the input for a secret question", () => {
    const secret: PendingQuestionState = {
      question_id: "q-secret",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qs",
          question: "Paste your API key",
          header: "Key",
          multi_select: false,
          options: [],
          is_secret: true,
        },
      ],
    }
    renderCard(secret)
    const input = screen.getByPlaceholderText("Type your answer…")
    expect(input).toHaveAttribute("type", "password")
  })

  it("skips with a declined answer", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [],
      declined: true,
    })
  })

  it("disables controls and shows a spinner while answering is in flight", () => {
    const d = deferred()
    const onAnswer = vi.fn(() => d.promise)
    const { container } = renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Incremental/ })).toBeDisabled()
    expect(container.querySelector(".animate-spin")).not.toBeNull()
    d.resolve()
  })

  it("ignores a second submit while one is already in flight", () => {
    const d = deferred()
    const onAnswer = vi.fn(() => d.promise)
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    const submit = screen.getByRole("button", { name: "Submit" })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledTimes(1)
    d.resolve()
  })

  it("surfaces a retryable error and re-enables controls when answering fails", async () => {
    // A rejecting onAnswer stands in for both a backend failure and the
    // "no connection" path (the context now throws there instead of silently
    // resolving, which would otherwise strand the card in its in-flight state).
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    // The failure surfaces inline and every control re-enables for a retry.
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Couldn't submit. Please try again.")
    const submit = screen.getByRole("button", { name: "Submit" })
    expect(submit).not.toBeDisabled()
    expect(screen.getByRole("button", { name: "Skip" })).not.toBeDisabled()
    fireEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })

  it('renders a bare "(Recommended)" label literally instead of going empty', () => {
    const onlyRecommended: PendingQuestionState = {
      question_id: "q-3",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qc",
          question: "Pick one",
          header: "Pick",
          multi_select: false,
          options: [
            { label: "(Recommended)", description: "" },
            { label: "Other path", description: "" },
          ],
        },
      ],
    }
    const onAnswer = renderCard(onlyRecommended)
    // The literal label is shown (not stripped to empty); selecting it submits
    // the verbatim label.
    fireEvent.click(screen.getByRole("radio", { name: "(Recommended)" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-3", {
      answers: [{ questionId: "qc", labels: ["(Recommended)"] }],
      declined: false,
    })
  })

  it("treats a real option labeled like the Other sentinel as a normal choice", () => {
    // The single-select RadioGroup uses index-based values, so an option whose
    // label happens to equal the internal "Other" sentinel still selects as a
    // real choice (no free-text input) and submits verbatim.
    const sentinel: PendingQuestionState = {
      question_id: "q-sentinel",
      created_at: "2026-01-01T00:00:00Z",
      questions: [
        {
          id: "qs",
          question: "Pick one",
          header: "Pick",
          multi_select: false,
          options: [
            { label: "__other__", description: "a real option" },
            { label: "Normal", description: "" },
          ],
        },
      ],
    }
    const onAnswer = renderCard(sentinel)
    fireEvent.click(screen.getByRole("radio", { name: /__other__/ }))
    // The free-text path is NOT engaged: no Other input appears.
    expect(
      screen.queryByPlaceholderText("Type your answer…")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-sentinel", {
      answers: [{ questionId: "qs", labels: ["__other__"] }],
      declined: false,
    })
  })

  it("clears the in-flight guard so a reused instance can answer the next question", async () => {
    // After a successful submit the card normally unmounts; but if the same
    // instance is reused in place for a new question_id, the re-entrancy guard
    // must not stay latched (otherwise the next Submit silently no-ops).
    const dA = deferred()
    const onAnswer = vi
      .fn()
      .mockReturnValueOnce(dA.promise)
      .mockResolvedValue(undefined)
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    // Resolve A; `run` clears the guard on the success path.
    dA.resolve()
    await dA.promise
    // The same instance is reused for a different question set (new question_id).
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={multi} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "auth" }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledTimes(2)
    expect(onAnswer).toHaveBeenLastCalledWith("q-2", {
      answers: [{ questionId: "qb", labels: ["auth"] }],
      declined: false,
    })
  })

  it("renders one tab per question when there are multiple", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")).toHaveLength(2)
  })

  it("auto-advances to the next tab after a single-select pick", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    // Picking an option on the first tab moves to the second.
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    const tabs = screen.getAllByRole("tab")
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    expect(tabs[0]).toHaveAttribute("aria-selected", "false")
    // The second tab's options are now the visible ones.
    expect(screen.getByText("P")).toBeInTheDocument()
  })

  it("does not auto-advance on a multi-select pick", () => {
    renderCard(twoMultiFirst)
    fireEvent.click(screen.getByRole("checkbox", { name: "X" }))
    // Still on the first tab so further options can be picked.
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByText("Y")).toBeInTheDocument()
  })

  it("marks a tab as confirmed once it is answered", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "data-answered",
      "false"
    )
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "data-answered",
      "true"
    )
  })

  it("advances the active tab with the Next button", () => {
    renderCard(twoSingle)
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: /Next/ }))
    const tabs = screen.getAllByRole("tab")
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
    // The last tab has no further tab, so Next is gone.
    expect(
      screen.queryByRole("button", { name: /Next/ })
    ).not.toBeInTheDocument()
  })

  it("shows a progress counter that advances as questions are answered", () => {
    renderCard(twoSingle)
    expect(screen.getByText("0/2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "X" })) // auto-advances
    expect(screen.getByText("1/2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "P" }))
    expect(screen.getByText("2/2")).toBeInTheDocument()
  })

  it("enables Submit only after every tab is answered, then submits all", () => {
    const onAnswer = renderCard(twoSingle)
    const submit = screen.getByRole("button", { name: /Submit/ })
    expect(submit).toBeDisabled()
    // Answer tab 1 (auto-advances to tab 2), then answer tab 2.
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: "P" }))
    const enabled = screen.getByRole("button", { name: /Submit/ })
    expect(enabled).not.toBeDisabled()
    fireEvent.click(enabled)
    expect(onAnswer).toHaveBeenCalledWith("q-two", {
      answers: [
        { questionId: "qa", labels: ["X"] },
        { questionId: "qb", labels: ["P"] },
      ],
      declined: false,
    })
  })

  it("resets selections when the question set is replaced in place", () => {
    // The shell renders the card without a per-question React key, so the card
    // must reset its own state when the question set changes underneath it.
    const onAnswer = vi.fn()
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled()
    // Swap in a different question set (new question_id) at the same position.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={twoSingle} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    // No stale selection carries over: the new set renders fresh and ungated.
    expect(screen.queryByText("Incremental")).not.toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled()
  })

  it("renders nothing for an empty question set", () => {
    // Defensive guard: an empty set must not render a 0/0 card whose enabled
    // Submit would post an empty affirmative answer instead of a decline.
    const { container } = renderWith({ ...single, questions: [] }, vi.fn())
    expect(container).toBeEmptyDOMElement()
  })
})

describe("AskQuestionCard collapse", () => {
  it("collapses to a header-only bar and keeps the selection across the round-trip", () => {
    const onAnswer = renderCard(single)
    fireEvent.click(screen.getByRole("radio", { name: /Incremental/ }))
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    // Header-only: options and the footer are unmounted.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Submit" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    // The pick survived the collapse/expand round-trip.
    expect(screen.getByRole("radio", { name: /Incremental/ })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      answers: [{ questionId: "qa", labels: ["Incremental"] }],
      declined: false,
    })
  })

  it("keeps the header readable while collapsed", () => {
    renderCard(twoSingle)
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    // The card still says whose turn it is and how far along the set is — a
    // collapsed blocking question must not read as a dismissed one.
    expect(screen.getByText("The agent needs your input")).toBeInTheDocument()
    expect(screen.getByText("0/2")).toBeInTheDocument()
    // The tab strip goes with the body.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  it("reports the collapsed state on the toggle", () => {
    renderCard(single)
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("offers no collapse control in the read-only view", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} readOnly />
      </NextIntlClientProvider>
    )
    // The in-message record has its own expand/collapse capsule; a second
    // chevron here would fight it.
    expect(
      screen.queryByRole("button", { name: "Collapse" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Expand" })
    ).not.toBeInTheDocument()
  })

  it("re-opens when a different question set renders into the same card", () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    // A replacement set is a NEW blocking request. Left collapsed it renders
    // as the same header row the user already put away, so they would never
    // see it and the agent would sit stalled.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={multi} onAnswer={vi.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("checkbox", { name: "auth" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument()
  })

  it("re-opens itself when an answer collapsed mid-flight comes back failed", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("boom"))
    renderWith(single, onAnswer)
    fireEvent.click(screen.getByRole("radio", { name: /Rewrite/ }))
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    // Collapsing drops the footer — the error line and the retry live there,
    // so a failure while collapsed would leave a blocking question looking
    // answered.
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't submit. Please try again."
    )
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled()
  })
})

describe("AskQuestionCard keeps the question in view", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The question line of the question asking `text`, and its body. */
  function heading(text: string): HTMLElement {
    const el = screen
      .getByText(text)
      .closest<HTMLElement>("[data-question-heading]")
    expect(el).not.toBeNull()
    return el!
  }
  function bodyOf(el: HTMLElement): HTMLElement {
    const body = el.closest<HTMLElement>("[data-question-body]")
    expect(body).not.toBeNull()
    return body!
  }

  /** Lay out what jsdom cannot: a body of `body` px holding a question line
   *  of `line` px. */
  function layout(body: HTMLElement, line: number, height: number) {
    Object.defineProperty(body, "clientHeight", {
      configurable: true,
      value: height,
    })
    const el = body.querySelector("[data-question-heading]")!
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      value: line,
    })
  }

  /** The arguments of the last call `spy` got on `el`. */
  function lastCallOn(
    spy: { mock: { calls: unknown[][]; contexts: unknown[] } },
    el: Element
  ): unknown[] | undefined {
    return spy.mock.calls[spy.mock.contexts.lastIndexOf(el)]
  }

  it("pins the question line at the top of its body, tabs or not", () => {
    renderCard(twoSingle)
    const tabbed = heading("First question?")
    expect(tabbed).toHaveClass("sticky", "top-0", "z-10")
    expect(bodyOf(tabbed)).toBe(screen.getByRole("tabpanel"))
    expect(bodyOf(tabbed).firstElementChild).toBe(tabbed)

    renderCard(single)
    const alone = heading("Which approach?")
    expect(alone).toHaveClass("sticky", "top-0", "z-10")
    expect(bodyOf(alone)).toHaveClass("overflow-y-auto")
  })

  it("backs the line and draws its divider only once something scrolls under it", () => {
    renderCard(twoSingle)
    const line = heading("First question?")
    const body = bodyOf(line)
    expect(body).toHaveClass("group/question-body")
    expect(line).toHaveClass(
      "group-data-[stuck]/question-body:bg-card",
      "group-data-[stuck]/question-body:shadow-[0_1px_0_var(--border)]"
    )
    expect(body).not.toHaveAttribute("data-stuck")
    body.scrollTop = 40
    fireEvent.scroll(body)
    expect(body).toHaveAttribute("data-stuck")
    body.scrollTop = 0
    fireEvent.scroll(body)
    expect(body).not.toHaveAttribute("data-stuck")
  })

  it("lets a question taller than half its body scroll away instead", () => {
    renderCard(twoSingle)
    const line = heading("First question?")
    const body = bodyOf(line)
    expect(line).toHaveClass("group-data-[unpinned]/question-body:static")
    layout(body, 120, 200)
    body.scrollTop = 40
    fireEvent.scroll(body)
    expect(body).toHaveAttribute("data-unpinned")
    expect(body).not.toHaveAttribute("data-stuck")
    layout(body, 30, 200)
    fireEvent.scroll(body)
    expect(body).not.toHaveAttribute("data-unpinned")
    expect(body).toHaveAttribute("data-stuck")
  })

  it("brings a question in at its top, however its tab opens", () => {
    renderCard(twoSingle)
    const [firstTab, secondTab] = screen.getAllByRole("tab")
    fireEvent.click(screen.getByRole("button", { name: /Next/ }))
    const second = screen.getByRole("tabpanel")
    expect(second).toHaveTextContent("Second question?")
    // The browser puts a hidden panel's scroll back when it shows again.
    second.scrollTop = 120
    second.setAttribute("data-stuck", "")
    fireEvent.mouseDown(firstTab)
    expect(screen.getByRole("tabpanel")).toHaveTextContent("First question?")
    fireEvent.mouseDown(secondTab)
    expect(screen.getByRole("tabpanel")).toBe(second)
    expect(second.scrollTop).toBe(0)
    expect(second).not.toHaveAttribute("data-stuck")

    // Auto-advance from a pick does the same.
    second.scrollTop = 120
    fireEvent.mouseDown(firstTab)
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    expect(screen.getByRole("tabpanel")).toBe(second)
    expect(second.scrollTop).toBe(0)
  })

  it("moves focus into the next question without scrolling it", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    renderCard(twoSingle)
    fireEvent.click(screen.getByRole("radio", { name: "X" }))
    const list = screen.getByRole("radiogroup", { name: "Second question?" })
    expect(list).toHaveFocus()
    expect(lastCallOn(focus, list)).toEqual([{ preventScroll: true }])
    expect(bodyOf(list).scrollTop).toBe(0)
  })

  it("takes focus on arrival without scrolling", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    renderCard(single)
    const list = screen.getByRole("radiogroup", { name: "Which approach?" })
    expect(list).toHaveFocus()
    expect(lastCallOn(focus, list)).toEqual([{ preventScroll: true }])
  })

  it("brings a replacement set in at its top, even one reusing an id", () => {
    const onAnswer = vi.fn()
    const view = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard question={single} onAnswer={onAnswer} />
      </NextIntlClientProvider>
    )
    const body = bodyOf(screen.getByRole("radiogroup"))
    body.scrollTop = 80
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={{ ...single, question_id: "q-1-again" }}
          onAnswer={onAnswer}
        />
      </NextIntlClientProvider>
    )
    expect(bodyOf(screen.getByRole("radiogroup"))).toBe(body)
    expect(body.scrollTop).toBe(0)
  })

  it("brings the Other field into view, clear of the question line", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    renderCard(single)
    const body = bodyOf(screen.getByRole("radiogroup"))
    layout(body, 30, 240)
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    const field = screen.getByPlaceholderText("Type your answer…")
    expect(field).toHaveFocus()
    expect(lastCallOn(focus, field)).toEqual([{ preventScroll: true }])
    expect(lastCallOn(scroll, field)).toEqual([{ block: "nearest" }])
    expect(body.style.scrollPaddingTop).toBe("30px")
  })

  it("keeps a growing answer in view while it is typed", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    renderCard(single)
    const body = bodyOf(screen.getByRole("radiogroup"))
    layout(body, 30, 240)
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    const field = screen.getByPlaceholderText("Type your answer…")
    // Two lines now: taller than it was, still well inside the body.
    Object.defineProperty(field, "offsetHeight", {
      configurable: true,
      value: 54,
    })
    body.style.scrollPaddingTop = ""
    scroll.mockClear()
    fireEvent.change(field, { target: { value: "first\nsecond" } })
    expect(scroll.mock.contexts).toEqual([field])
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" })
    expect(body.style.scrollPaddingTop).toBe("30px")
  })

  it("leaves an answer taller than the room under the question to the caret", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
    renderCard(single)
    const body = bodyOf(screen.getByRole("radiogroup"))
    // 90px under a 30px question line, for a 134px answer.
    layout(body, 30, 120)
    fireEvent.click(screen.getByRole("radio", { name: "Other" }))
    const field = screen.getByPlaceholderText("Type your answer…")
    Object.defineProperty(field, "offsetHeight", {
      configurable: true,
      value: 134,
    })
    scroll.mockClear()
    fireEvent.change(field, { target: { value: "1\n2\n3\n4\n5\n6" } })
    expect(field).toHaveValue("1\n2\n3\n4\n5\n6")
    expect(scroll).not.toHaveBeenCalled()
  })

  it("lets a long question scroll away from the moment it is entered", () => {
    // Laid out before anything scrolls: a 120px question over a 200px body.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-question-heading") ? 120 : 0
      }
    )
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: Element) {
        return this.hasAttribute("data-question-body") ? 200 : 0
      }
    )
    renderCard(twoSingle)
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-unpinned")
    fireEvent.click(screen.getByRole("button", { name: /Next/ }))
    const second = screen.getByRole("tabpanel")
    expect(second).toHaveTextContent("Second question?")
    expect(second).toHaveAttribute("data-unpinned")
    expect(second).not.toHaveAttribute("data-stuck")
  })
})

describe("AskQuestionCard and the chat text size", () => {
  // The question is the agent's own text, read like the transcript: the card
  // carries the chat text scope itself, so it grows wherever it is docked (the
  // composer, the live drawer, Quick Ask) and not only inside a thread.
  it("puts the whole card in a chat text scope", () => {
    renderCard(single)
    const card = screen.getByRole("group", {
      name: "The agent needs your input",
    })
    expect(card).toHaveClass("chat-text-scope")
    expect(card).toContainElement(screen.getByText("Which approach?"))
    expect(card).toContainElement(screen.getByRole("button", { name: "Skip" }))
  })

  it("reserves the tabs' height in chat text units, so it grows with the rows", () => {
    renderCard(twoSingle)
    const height = screen.getByRole("tabpanel").style.height
    // Three rows (two options and "Other") of padding plus chat-sized text,
    // capped at half the viewport less what the card's chrome grows by.
    expect(height).toBe(
      "min(calc(3 * (var(--spacing) * 7 + var(--chat-rem, 1rem) * 2.25) + var(--chat-rem, 1rem)), calc(50svh - (var(--chat-rem, 1rem) - var(--chat-text-unit, 1rem)) * 4))"
    )
  })

  it("lets its labelled controls grow with their text", () => {
    renderCard(twoSingle)
    // Fixed-height pills and buttons would clip a large chat text size. The
    // badge keeps `leading-none` through the class merge, or it is taller than
    // 20px at 100%.
    const badge = screen.getByText("Single")
    expect(badge).toHaveClass("h-auto", "min-h-5", "leading-none", "text-3xs")
    expect(badge).not.toHaveClass("h-5")
    for (const name of ["Skip", "Next"]) {
      const button = screen.getByRole("button", { name: new RegExp(name) })
      expect(button).toHaveClass("h-auto", "min-h-8")
      expect(button).not.toHaveClass("h-8")
    }
  })
})
