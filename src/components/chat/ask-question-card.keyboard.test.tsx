import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AskQuestionCard } from "./ask-question-card"
import enMessages from "@/i18n/messages/en.json"
import { installCompositionTracker } from "@/lib/card-focus"
import type { PendingQuestionState, QuestionAnswer } from "@/lib/types"

type OnAnswer = (id: string, answer: QuestionAnswer) => void | Promise<void>

/** A conversation scope: the card above a composer, like ConversationShell.
 *  `question: null` renders the composer alone, so a test can focus or fill
 *  it before the card arrives. */
function Scope({
  question,
  onAnswer,
  locale = "en",
  richComposer = false,
}: {
  question: PendingQuestionState | null
  onAnswer: OnAnswer
  locale?: "en" | "ar"
  richComposer?: boolean
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <div data-composer-scope="">
        {question && (
          <AskQuestionCard question={question} onAnswer={onAnswer} />
        )}
        {richComposer ? (
          <div
            className="codeg-composer-content"
            contentEditable
            suppressContentEditableWarning
            tabIndex={0}
            role="textbox"
            aria-label="Composer"
          />
        ) : (
          <textarea data-composer-input="" aria-label="Composer" />
        )}
      </div>
    </NextIntlClientProvider>
  )
}

function renderScope(
  question: PendingQuestionState | null,
  opts: { locale?: "en" | "ar"; richComposer?: boolean } = {}
) {
  const onAnswer = vi.fn<OnAnswer>()
  const view = render(
    <Scope question={question} onAnswer={onAnswer} {...opts} />
  )
  const show = (q: PendingQuestionState) =>
    view.rerender(<Scope question={q} onAnswer={onAnswer} {...opts} />)
  return { onAnswer, show, composer: () => screen.getByLabelText("Composer") }
}

/** The text of the row the list's active descendant points at. */
function highlighted(list: HTMLElement): string {
  const id = list.getAttribute("aria-activedescendant")
  return (id && document.getElementById(id)?.textContent) || ""
}

const approach: PendingQuestionState = {
  question_id: "q-approach",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "Which approach?",
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "" },
        { label: "Rewrite (Recommended)", description: "" },
        { label: "Defer", description: "" },
      ],
    },
  ],
}

const modules: PendingQuestionState = {
  question_id: "q-modules",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qm",
      question: "Which modules?",
      header: "Modules",
      multi_select: true,
      options: [
        { label: "auth", description: "" },
        { label: "billing", description: "" },
      ],
    },
  ],
}

const twoQuestions: PendingQuestionState = {
  question_id: "q-two",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "q1",
      question: "First question?",
      header: "First",
      multi_select: false,
      options: [
        { label: "X", description: "" },
        { label: "Y", description: "" },
      ],
    },
    {
      id: "q2",
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

const answered = (
  ...answers: { questionId: string; labels: string[] }[]
): QuestionAnswer => ({ answers, declined: false })

afterEach(() => {
  document.documentElement.dir = ""
})

describe("AskQuestionCard keyboard: focus", () => {
  it("takes focus on arrival, on the recommended option", () => {
    renderScope(approach)
    const list = screen.getByRole("radiogroup", { name: "Which approach?" })
    expect(list).toHaveFocus()
    expect(highlighted(list)).toContain("Rewrite")
  })

  it("starts on the first option when none is recommended", () => {
    renderScope(twoQuestions)
    const list = screen.getByRole("radiogroup", { name: "First question?" })
    expect(list).toHaveFocus()
    expect(highlighted(list)).toBe("X1")
  })

  it("takes focus from an empty composer", () => {
    const { show, composer } = renderScope(null)
    composer().focus()
    show(approach)
    expect(screen.getByRole("radiogroup")).toHaveFocus()
  })

  it("never takes focus from a composer with text in it", async () => {
    const user = userEvent.setup()
    const { show, composer } = renderScope(null)
    await user.click(composer())
    await user.keyboard("half a thought")
    show(approach)
    expect(composer()).toHaveFocus()
    // …and the typing carries on into the composer.
    await user.keyboard(" more")
    expect(composer()).toHaveValue("half a thought more")
  })

  it("never takes focus from the rich composer while it holds text", () => {
    const { show, composer } = renderScope(null, { richComposer: true })
    composer().textContent = "draft"
    composer().focus()
    show(approach)
    expect(composer()).toHaveFocus()
  })

  it("never takes focus in the middle of an IME composition", () => {
    // In the app the always-mounted cards install the tracker before anyone
    // types; here the composition starts before the first card mounts.
    installCompositionTracker()
    const { show, composer } = renderScope(null)
    composer().focus()
    fireEvent.compositionStart(composer())
    show(approach)
    expect(composer()).toHaveFocus()
    fireEvent.compositionEnd(composer())
  })

  it("never takes focus from a field outside its conversation", () => {
    const onAnswer = vi.fn<OnAnswer>()
    const ui = (q: PendingQuestionState | null) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <input aria-label="Search" />
        <div data-composer-scope="">
          {q && <AskQuestionCard question={q} onAnswer={onAnswer} />}
        </div>
      </NextIntlClientProvider>
    )
    const view = render(ui(null))
    screen.getByLabelText("Search").focus()
    view.rerender(ui(approach))
    expect(screen.getByLabelText("Search")).toHaveFocus()
  })

  it("↑ in an empty composer moves into the card", async () => {
    const user = userEvent.setup()
    const { composer } = renderScope(approach)
    await user.click(composer())
    await user.keyboard("{ArrowUp}")
    expect(screen.getByRole("radiogroup")).toHaveFocus()
  })

  it("↑ in a composer with text stays in the composer", async () => {
    const user = userEvent.setup()
    const { composer } = renderScope(approach)
    await user.click(composer())
    await user.keyboard("draft{ArrowUp}")
    expect(composer()).toHaveFocus()
  })

  it("Esc goes back to the composer and never declines", async () => {
    const user = userEvent.setup()
    const { onAnswer, composer } = renderScope(approach)
    await user.keyboard("{Escape}")
    expect(composer()).toHaveFocus()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("hands the keyboard back to the composer once the answer lands", async () => {
    const user = userEvent.setup()
    const { onAnswer, composer } = renderScope(approach)
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(composer()).toHaveFocus()
  })
})

describe("AskQuestionCard keyboard: options", () => {
  it("↑/↓ move the highlight and wrap; Home/End jump to the ends", async () => {
    const user = userEvent.setup()
    renderScope(twoQuestions)
    const list = screen.getByRole("radiogroup", { name: "First question?" })
    await user.keyboard("{ArrowDown}")
    expect(highlighted(list)).toBe("Y2")
    await user.keyboard("{ArrowDown}")
    expect(highlighted(list)).toBe("Other3")
    await user.keyboard("{ArrowDown}")
    expect(highlighted(list)).toBe("X1")
    await user.keyboard("{ArrowUp}")
    expect(highlighted(list)).toBe("Other3")
    await user.keyboard("{Home}")
    expect(highlighted(list)).toBe("X1")
    await user.keyboard("{End}")
    expect(highlighted(list)).toBe("Other3")
  })

  it("Enter picks the highlighted option and, on the only question, submits", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(approach)
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-approach",
      answered({ questionId: "qa", labels: ["Defer"] })
    )
  })

  it("a digit picks that option", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(approach)
    await user.keyboard("1")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-approach",
      answered({ questionId: "qa", labels: ["Incremental"] })
    )
  })

  it("a held Enter answers once", () => {
    const { onAnswer } = renderScope(approach)
    const list = screen.getByRole("radiogroup")
    fireEvent.keyDown(list, { key: "Enter", repeat: true })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("multi-select: Space toggles, Enter continues with what is ticked", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(modules)
    const list = screen.getByRole("group", { name: "Which modules?" })
    await user.keyboard(" ")
    expect(screen.getByRole("checkbox", { name: "auth" })).toBeChecked()
    await user.keyboard("{ArrowDown} ")
    expect(screen.getByRole("checkbox", { name: "billing" })).toBeChecked()
    await user.keyboard(" ")
    expect(screen.getByRole("checkbox", { name: "billing" })).not.toBeChecked()
    expect(onAnswer).not.toHaveBeenCalled()
    expect(list).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-modules",
      answered({ questionId: "qm", labels: ["auth"] })
    )
  })

  it("multi-select: Enter with nothing ticked takes the highlighted option", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(modules)
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-modules",
      answered({ questionId: "qm", labels: ["billing"] })
    )
  })

  it("typing on the Other row starts the answer there; Enter submits it", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(approach)
    await user.keyboard("{End}")
    await user.keyboard("a third way")
    const field = screen.getByPlaceholderText("Type your answer…")
    expect(field).toHaveFocus()
    expect(field).toHaveValue("a third way")
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-approach",
      answered({ questionId: "qa", labels: ["a third way"] })
    )
  })

  it("Enter on the Other row opens its field; ↑ and Esc go back to the options", async () => {
    const user = userEvent.setup()
    renderScope(approach)
    const list = screen.getByRole("radiogroup")
    await user.keyboard("{End}{Enter}")
    expect(screen.getByPlaceholderText("Type your answer…")).toHaveFocus()
    await user.keyboard("x{ArrowUp}")
    expect(list).toHaveFocus()
    expect(highlighted(list)).toBe("Other4")
    await user.keyboard("{Enter}")
    expect(screen.getByPlaceholderText("Type your answer…")).toHaveValue("x")
    await user.keyboard("{Escape}")
    expect(list).toHaveFocus()
  })

  it("an IME composition's Enter never continues or submits", () => {
    const { onAnswer } = renderScope(approach)
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "End" })
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "Enter" })
    const field = screen.getByPlaceholderText("Type your answer…")
    fireEvent.change(field, { target: { value: "nihao" } })
    fireEvent.keyDown(field, { key: "Enter", isComposing: true })
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 })
    fireEvent.keyDown(field, { key: "Enter", metaKey: true, keyCode: 229 })
    expect(onAnswer).not.toHaveBeenCalled()
    expect(field).toHaveFocus()
  })
})

describe("AskQuestionCard keyboard: several questions", () => {
  it("Enter continues to the next question, then submits on the last", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(twoQuestions)
    await user.keyboard("{Enter}")
    const second = screen.getByRole("radiogroup", { name: "Second question?" })
    expect(second).toHaveFocus()
    expect(onAnswer).not.toHaveBeenCalled()
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-two",
      answered(
        { questionId: "q1", labels: ["X"] },
        { questionId: "q2", labels: ["Q"] }
      )
    )
  })

  it("on the last question, Enter jumps to the first one still open", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(twoQuestions)
    await user.keyboard("{Tab}")
    expect(
      screen.getByRole("radiogroup", { name: "Second question?" })
    ).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onAnswer).not.toHaveBeenCalled()
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it("Tab/Shift+Tab and ←/→ move between questions", async () => {
    const user = userEvent.setup()
    renderScope(twoQuestions)
    await user.keyboard("{ArrowRight}")
    expect(
      screen.getByRole("radiogroup", { name: "Second question?" })
    ).toHaveFocus()
    await user.keyboard("{Shift>}{Tab}{/Shift}")
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
    await user.keyboard("{Tab}{ArrowLeft}")
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
  })

  it("mirrors ←/→ in a right-to-left UI", async () => {
    const user = userEvent.setup()
    renderScope(twoQuestions, { locale: "ar" })
    await user.keyboard("{ArrowLeft}")
    expect(
      screen.getByRole("radiogroup", { name: "Second question?" })
    ).toHaveFocus()
    await user.keyboard("{ArrowRight}")
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
  })

  it("Backspace on an unanswered question goes back one", async () => {
    const user = userEvent.setup()
    renderScope(twoQuestions)
    await user.keyboard("{Enter}{Backspace}")
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
  })

  it("⌘/Ctrl+Enter jumps to an open question, then submits once all are answered", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(twoQuestions)
    await user.keyboard("{Tab}{Control>}{Enter}{/Control}")
    expect(onAnswer).not.toHaveBeenCalled()
    expect(
      screen.getByRole("radiogroup", { name: "First question?" })
    ).toHaveFocus()
    // Answer the first; the second is answered with the mouse, which never
    // submits by itself. ⌘↵ from a tab then sends both.
    await user.keyboard("2")
    fireEvent.click(screen.getByRole("radio", { name: "P" }))
    expect(onAnswer).not.toHaveBeenCalled()
    screen.getAllByRole("tab")[0].focus()
    await user.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onAnswer).toHaveBeenCalledWith(
      "q-two",
      answered(
        { questionId: "q1", labels: ["Y"] },
        { questionId: "q2", labels: ["P"] }
      )
    )
  })

  it("Enter never declines, even from the tabs", async () => {
    const user = userEvent.setup()
    const { onAnswer } = renderScope(twoQuestions)
    screen.getAllByRole("tab")[1].focus()
    await user.keyboard("{Enter}")
    expect(
      screen.getByRole("radiogroup", { name: "Second question?" })
    ).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe("AskQuestionCard keyboard: read-only view", () => {
  it("offers no keyboard entry and keeps its tabs navigable", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AskQuestionCard
          question={twoQuestions}
          onAnswer={vi.fn()}
          readOnly
          initialSelections={{
            q1: { chosen: ["X"], otherText: "" },
            q2: { chosen: ["Q"], otherText: "" },
          }}
        />
      </NextIntlClientProvider>
    )
    expect(document.body).toHaveFocus()
    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("tabindex")
    const tabs = screen.getAllByRole("tab")
    tabs[0].focus()
    await user.keyboard("{ArrowRight}")
    expect(tabs[1]).toHaveFocus()
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
  })
})
