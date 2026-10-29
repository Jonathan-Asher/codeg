"use client"

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  MessageCircleQuestionMark,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Keycap } from "@/components/chat/keycap"
import { useCardArrivalFocus, useComposerHandoff } from "@/hooks/use-card-focus"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  focusCardEntry,
  focusComposerAfterAnswer,
  focusComposerFrom,
} from "@/lib/card-focus"
import { isImeCompositionKey } from "@/lib/ime-composition"
import { cn } from "@/lib/utils"
import { splitRecommended } from "@/lib/ask-question"
import { detectTextDirection, localeDirection } from "@/lib/text-direction"
import type {
  PendingQuestionState,
  QuestionAnswer,
  QuestionSpec,
} from "@/lib/types"

interface AskQuestionCardProps {
  /** The awaiting-answer question set. The shell renders this card only when a
   *  question is pending, so the prop is always present. */
  question: PendingQuestionState
  /** Resolves the parked tool call. Returns a promise so the card can show an
   *  in-flight state and surface a retryable error if the round-trip fails. */
  onAnswer: (questionId: string, answer: QuestionAnswer) => void | Promise<void>
  /** Read-only/answered view (the in-message record): controls are disabled,
   *  the footer is dropped, and selections are seeded from `initialSelections`
   *  rather than collected. Omit it for the live, interactive card. */
  readOnly?: boolean
  /** Pre-filled selections per question id, used only in the read-only view. */
  initialSelections?: SeedSelections
  /** Header overrides (already localized) for the read-only view. */
  title?: string
  subtitle?: string
  /** Take keyboard focus when a question set arrives — never from someone
   *  typing (see `canCardTakeFocus`). A conversation that is not the one in
   *  front passes false, and takes it once it comes to the front. */
  autoFocus?: boolean
}

/** Seeded selections for the read-only view: chosen real-option labels plus any
 *  free-text "Other" answer, keyed by question id. */
type SeedSelections = Record<string, { chosen: string[]; otherText: string }>

interface QState {
  /** Selected real-option labels (verbatim). For single-select, ≤ 1. */
  chosen: string[]
  otherActive: boolean
  otherText: string
}

type Answers = Record<string, QState>

const EMPTY: QState = { chosen: [], otherActive: false, otherText: "" }

/** Where keyboard focus goes once a state change has rendered: a question's
 *  entry (its option list, or its text field when it has no options), its
 *  "Other" field, or whatever the card's entry is by then. */
type FocusRequest =
  | { index: number; part: "entry" | "other" }
  | { part: "card" }

const DIGIT = /^[1-9]$/

function initialState(
  questions: QuestionSpec[],
  seed?: SeedSelections
): Answers {
  const out: Answers = {}
  for (const q of questions) {
    const s = seed?.[q.id]
    out[q.id] = s
      ? {
          chosen: s.chosen,
          otherActive: s.otherText.trim().length > 0,
          otherText: s.otherText,
        }
      : EMPTY
  }
  return out
}

/** A question is answered once it has a real option or non-empty "Other" text. */
function isAnswered(s: QState | undefined): boolean {
  if (!s) return false
  const hasOther = s.otherActive && s.otherText.trim().length > 0
  return s.chosen.length > 0 || hasOther
}

/** The radio dot / checkbox tick of an option row. Presentational: the row
 *  itself is the radio or checkbox. */
function ChoiceMark({ multi, checked }: { multi: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input dark:bg-input/30",
        multi ? "rounded-[4px]" : "rounded-full",
        checked &&
          "border-primary bg-primary text-primary-foreground dark:bg-primary"
      )}
    >
      {checked &&
        (multi ? (
          <Check className="size-3.5" />
        ) : (
          <span className="size-2 rounded-full bg-primary-foreground" />
        ))}
    </span>
  )
}

export function AskQuestionCard({
  question,
  onAnswer,
  readOnly = false,
  initialSelections,
  title,
  subtitle,
  autoFocus = true,
}: AskQuestionCardProps) {
  const t = useTranslations("Folder.chat.askQuestion")
  const dir = localeDirection(useLocale())
  const isMac = useIsMac()
  const ime = useImeGuard()
  const uid = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const questions = question.questions
  const [state, setState] = useState<Answers>(() =>
    initialState(questions, initialSelections)
  )
  // Active tab in the multi-question layout.
  const [activeId, setActiveId] = useState(() => questions[0]?.id ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  // Synchronous guard against a double-submit before `submitting` re-renders.
  const inFlight = useRef(false)
  // Tracks which question set the above state belongs to. If the card is reused
  // for a different set (a new question_id) without remounting, reset so stale
  // selections never carry over — the component stays correct on its own rather
  // than relying on the caller to supply a fresh React key.
  const [renderedId, setRenderedId] = useState(question.question_id)

  // Panel-presence state (live card only): shrink the card to its header row
  // so a long set stops squeezing the message list, while the question stays
  // pending and visible. Reset alongside the rest whenever a different set
  // renders into this instance — see the swap guard below.
  const [collapsed, setCollapsed] = useState(false)

  // The keyboard highlight per question: the row ↑/↓ moves and Enter picks —
  // an option index, or `options.length` for the "Other" row. Unset until the
  // keyboard moves it; `highlightOf` supplies where it starts.
  const [highlight, setHighlight] = useState<Record<string, number>>({})
  // The question whose option list holds DOM focus. Only there does the
  // highlighted row show, so a mouse user never sees a stray ring.
  const [focusedList, setFocusedList] = useState<string | null>(null)
  const focusRequest = useRef<FocusRequest | null>(null)

  // How many questions are answered — drives the progress bar, the counter, and
  // the submit gate (every question must be answered).
  const answeredCount = useMemo(
    () => questions.filter((q) => isAnswered(state[q.id])).length,
    [questions, state]
  )
  const complete = answeredCount === questions.length

  // Reserve one stable content height for the whole set so switching between a
  // few-option tab and a many-option tab never resizes the card. Sized to the
  // tallest question (its option count plus the always-present "Other" row),
  // capped to the viewport; a taller-than-estimated tab scrolls internally.
  const maxRows = useMemo(
    () => questions.reduce((m, q) => Math.max(m, q.options.length + 1), 1),
    [questions]
  )
  const bodyHeight = `min(${maxRows * 4 + 1}rem, 50svh)`

  if (question.question_id !== renderedId) {
    setRenderedId(question.question_id)
    setState(initialState(questions, initialSelections))
    setActiveId(questions[0]?.id ?? "")
    setSubmitting(false)
    setError(false)
    setHighlight({})
    // Collapsed too, and this one is not housekeeping. A replacement set is a
    // NEW blocking request; left collapsed it renders as the same header row
    // the user already dismissed from view — identical title, and an
    // identically-sized set even shows the same counter — so they can miss it
    // entirely and leave the agent stalled.
    setCollapsed(false)
    // `inFlight` is intentionally not reset here — refs must not be written
    // during render. `run` clears it whenever the round-trip resolves (both the
    // success and failure paths), so it is already idle by the time a replacement
    // question set renders into this same instance.
  }

  // Keyboard: the card takes focus when a set arrives (never from someone
  // typing), and ↑ in an empty composer brings it back here.
  useCardArrivalFocus(
    rootRef,
    readOnly ? null : question.question_id,
    autoFocus
  )
  useComposerHandoff(rootRef, !readOnly)

  const listId = (index: number) => `${uid}-q${index}`
  const labelId = (index: number) => `${uid}-q${index}-label`
  const rowId = (index: number, row: number) => `${uid}-q${index}-row${row}`
  const fieldId = (index: number) => `${uid}-q${index}-field`
  const hintId = `${uid}-keys`
  const entryId = (index: number) =>
    questions[index]?.options.length === 0 ? fieldId(index) : listId(index)

  const focusElement = (el: HTMLElement) => {
    el.focus()
    // A field is entered at its end (typing on the "Other" row has already
    // put the first character in it).
    if (el instanceof HTMLInputElement) {
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }
  const applyFocus = (req: FocusRequest): boolean => {
    if (req.part === "card") return focusCardEntry(rootRef.current)
    const el = document.getElementById(
      req.part === "other" ? fieldId(req.index) : entryId(req.index)
    )
    if (!el) return false
    focusElement(el)
    return true
  }
  // Focus now when the target is on screen. Otherwise the request waits: for
  // this card's next render (a control coming back from disabled), or for the
  // element itself to mount — a tab panel mounts a render after the tab
  // switch, inside Radix's presence, so only its own ref sees it arrive.
  const requestFocus = (req: FocusRequest) => {
    if (!applyFocus(req)) focusRequest.current = req
  }
  const claimFocus =
    (index: number, part: "entry" | "other") => (el: HTMLElement | null) => {
      const req = focusRequest.current
      if (!el || !req || req.part === "card") return
      if (req.part !== part || req.index !== index) return
      focusRequest.current = null
      focusElement(el)
    }
  useLayoutEffect(() => {
    const req = focusRequest.current
    if (req && applyFocus(req)) focusRequest.current = null
  })

  const select = (q: QuestionSpec, label: string) => {
    setState((prev) => {
      const s = prev[q.id] ?? EMPTY
      if (q.multi_select) {
        const has = s.chosen.includes(label)
        return {
          ...prev,
          [q.id]: {
            ...s,
            chosen: has
              ? s.chosen.filter((l) => l !== label)
              : [...s.chosen, label],
          },
        }
      }
      // Single-select: picking a real option clears "Other".
      return { ...prev, [q.id]: { ...s, chosen: [label], otherActive: false } }
    })
    // A single-select pick advances to the next question so a multi-question set
    // reads as a guided sequence. Multi-select must not jump (you may pick
    // several); toggling "Other" must not jump (you still need to type).
    if (!q.multi_select) {
      const idx = questions.findIndex((x) => x.id === q.id)
      const next = questions[idx + 1]
      if (next) setActiveId(next.id)
    }
  }

  const toggleOther = (q: QuestionSpec) => {
    setState((prev) => {
      const s = prev[q.id] ?? EMPTY
      const nextActive = !s.otherActive
      return {
        ...prev,
        [q.id]: {
          ...s,
          otherActive: nextActive,
          // Single-select: turning on "Other" clears real options.
          chosen: q.multi_select ? s.chosen : nextActive ? [] : s.chosen,
        },
      }
    })
  }

  const setOtherText = (q: QuestionSpec, text: string) => {
    setState((prev) => {
      const s = prev[q.id] ?? EMPTY
      return { ...prev, [q.id]: { ...s, otherActive: true, otherText: text } }
    })
  }

  // Single-select: re-clicking the chosen option clears it.
  const clearChosen = (q: QuestionSpec) => {
    setState((prev) => {
      const s = prev[q.id] ?? EMPTY
      return { ...prev, [q.id]: { ...s, chosen: [] } }
    })
  }

  // Keyboard edits compute the next answers synchronously — not through a
  // functional update — so "continue" reads the answer it was just given.
  const stateOf = (q: QuestionSpec): QState => state[q.id] ?? EMPTY
  const commit = (q: QuestionSpec, next: QState): Answers => {
    const all = { ...state, [q.id]: next }
    setState(all)
    return all
  }

  // Run an answer/skip round-trip, holding the card in an in-flight state until
  // it resolves. On success the backend's `question_resolved` clears
  // `pendingAskQuestion`, which unmounts this card — so we intentionally stay
  // disabled rather than flash the controls back on. On failure we re-enable and
  // surface a retryable error instead of swallowing it.
  const run = async (answer: QuestionAnswer) => {
    if (inFlight.current) return
    inFlight.current = true
    // The keyboard goes back to the composer once the answer lands, and stays
    // in the card for the retry if it fails — never left on the page body by
    // the controls going inert.
    const hadFocus = rootRef.current?.contains(document.activeElement) ?? false
    const returnFocus = focusComposerAfterAnswer(rootRef.current)
    setSubmitting(true)
    setError(false)
    try {
      await onAnswer(question.question_id, answer)
      // Clear the re-entrancy guard on success too (symmetric with the catch).
      // The card normally unmounts here, but if this instance is reused for the
      // next question the guard must not stay latched. `submitting` stays true so
      // the controls don't flash back on before the unmount/replacement.
      inFlight.current = false
      returnFocus()
    } catch {
      setError(true)
      setSubmitting(false)
      inFlight.current = false
      // Collapsing mid-flight hides the footer, and with it the retry and the
      // error line — a failed answer to a still-blocking question would be
      // silent. Come back out so the failure is where the user can see it.
      setCollapsed(false)
      if (hadFocus) focusRequest.current = { part: "card" }
    }
  }

  const submit = (answers: Answers = state) => {
    const payload = questions.map((q) => {
      const s = answers[q.id]
      const labels = [...(s?.chosen ?? [])]
      if (s?.otherActive && s.otherText.trim()) labels.push(s.otherText.trim())
      return { questionId: q.id, labels }
    })
    void run({ answers: payload, declined: false })
  }

  const skip = () => void run({ answers: [], declined: true })

  const isMulti = questions.length > 1
  // The read-only/answered view passes an empty subtitle; with no second line the
  // header row centers the icon, title and count instead of top-aligning them.
  const resolvedSubtitle = subtitle ?? t("subtitle")
  const activeIndex = questions.findIndex((q) => q.id === activeId)
  const nextId =
    activeIndex >= 0 && activeIndex < questions.length - 1
      ? questions[activeIndex + 1].id
      : null

  // Every control is inert while a live answer is in flight (`submitting`) and in
  // the read-only/answered view (`readOnly`). Tabs stay navigable in both.
  const locked = submitting || readOnly

  // Where the keyboard highlight of a question starts: its answer, else the
  // recommended option, else the first.
  const highlightOf = (q: QuestionSpec): number => {
    const set = highlight[q.id]
    if (set !== undefined && set <= q.options.length) return set
    const s = stateOf(q)
    if (s.otherActive) return q.options.length
    const chosen = q.options.findIndex((o) => s.chosen.includes(o.label))
    if (chosen >= 0) return chosen
    return Math.max(
      q.options.findIndex((o) => splitRecommended(o.label).recommended),
      0
    )
  }
  const moveHighlight = (q: QuestionSpec, row: number) =>
    setHighlight((prev) => ({ ...prev, [q.id]: row }))

  const goTo = (index: number) => {
    const q = questions[index]
    if (!q) return
    setCollapsed(false)
    setActiveId(q.id)
    requestFocus({ index, part: "entry" })
  }

  // "Continue": on to the next unanswered question, wrapping round to an
  // earlier one, and submit once none is left. With nowhere else to go (an
  // empty field on the only open question) it stays put.
  const continueFrom = (index: number, answers: Answers) => {
    const open = (i: number) => !isAnswered(answers[questions[i].id])
    const order = questions.map((_, i) => i)
    const next =
      order.find((i) => i > index && open(i)) ?? order.find((i) => open(i))
    if (next === undefined) submit(answers)
    else if (next !== index) goTo(next)
  }

  // ⌘/Ctrl+Enter: submit when everything is answered, else go to the first
  // question still open.
  const submitOrJump = () => {
    if (complete) {
      submit()
      return
    }
    const first = questions.findIndex((q) => !isAnswered(state[q.id]))
    if (first >= 0) goTo(first)
  }

  // A click keeps the existing mouse behaviour (a single-select pick advances
  // to the next tab, re-clicking the choice clears it) and brings the keyboard
  // along, so the next key works where the click was.
  const onRowClick = (q: QuestionSpec, index: number, row: number) => {
    if (locked) return
    moveHighlight(q, row)
    const s = stateOf(q)
    if (row === q.options.length) {
      toggleOther(q)
      requestFocus({ index, part: s.otherActive ? "entry" : "other" })
      return
    }
    const label = q.options[row].label
    if (!q.multi_select && s.chosen.includes(label)) {
      clearChosen(q)
    } else {
      select(q, label)
      if (!q.multi_select && index < questions.length - 1) {
        requestFocus({ index: index + 1, part: "entry" })
        return
      }
    }
    requestFocus({ index, part: "entry" })
  }

  // Enter, Space or a digit on a row. Single-select picks it and continues.
  // Multi-select toggles it (Space, digit) or continues (Enter — ticking the
  // row first when nothing is ticked yet, since a bare Enter on a row means
  // "this one"). The "Other" row opens its field instead.
  const activateRow = (
    q: QuestionSpec,
    index: number,
    row: number,
    key: "enter" | "space" | "digit"
  ) => {
    const s = stateOf(q)
    if (row === q.options.length) {
      if (q.multi_select && key !== "enter" && s.otherActive) {
        commit(q, { ...s, otherActive: false })
        return
      }
      if (!s.otherActive) {
        commit(q, {
          ...s,
          otherActive: true,
          chosen: q.multi_select ? s.chosen : [],
        })
      }
      requestFocus({ index, part: "other" })
      return
    }
    const label = q.options[row].label
    if (!q.multi_select) {
      continueFrom(
        index,
        commit(q, { ...s, chosen: [label], otherActive: false })
      )
      return
    }
    const toggled = {
      ...s,
      chosen: s.chosen.includes(label)
        ? s.chosen.filter((l) => l !== label)
        : [...s.chosen, label],
    }
    if (key !== "enter") commit(q, toggled)
    else continueFrom(index, isAnswered(s) ? state : commit(q, toggled))
  }

  const onListKeyDown = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    q: QuestionSpec,
    index: number
  ) => {
    if (locked || e.defaultPrevented || isImeCompositionKey(e)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const rows = q.options.length + 1
    const hl = highlightOf(q)
    const { key } = e
    // A held key repeats; one press must never answer this question and then
    // the next.
    if (e.repeat && (key === "Enter" || key === " " || DIGIT.test(key))) {
      e.preventDefault()
      return
    }
    // Between questions, at the ends the key keeps its native meaning (Tab
    // moves on to the footer).
    const stepQuestion = (delta: number) => {
      const to = index + delta
      if (!isMulti || to < 0 || to >= questions.length) return
      e.preventDefault()
      goTo(to)
    }
    switch (key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault()
        moveHighlight(q, (hl + (key === "ArrowDown" ? 1 : rows - 1)) % rows)
        return
      case "Home":
      case "End":
        e.preventDefault()
        moveHighlight(q, key === "Home" ? 0 : rows - 1)
        return
      case "Enter":
        if (e.shiftKey) return
        e.preventDefault()
        activateRow(q, index, hl, "enter")
        return
      case " ":
        e.preventDefault()
        activateRow(q, index, hl, "space")
        return
      case "Tab":
        stepQuestion(e.shiftKey ? -1 : 1)
        return
      case "ArrowLeft":
      case "ArrowRight":
        // The tabs read in the UI's direction: in RTL the next one is left.
        stepQuestion((key === "ArrowRight") === (dir === "ltr") ? 1 : -1)
        return
      case "Backspace":
        if (!isAnswered(stateOf(q))) stepQuestion(-1)
        return
    }
    if (DIGIT.test(key) && Number(key) <= rows) {
      e.preventDefault()
      moveHighlight(q, Number(key) - 1)
      activateRow(q, index, Number(key) - 1, "digit")
      return
    }
    // Typing on the "Other" row starts its answer with that character.
    if (hl === q.options.length && [...key].length === 1 && key !== " ") {
      e.preventDefault()
      const s = stateOf(q)
      commit(q, {
        ...s,
        otherActive: true,
        otherText: s.otherText + key,
        chosen: q.multi_select ? s.chosen : [],
      })
      requestFocus({ index, part: "other" })
    }
  }

  // The "Other" field, or the whole answer of a question with no options.
  const onFieldKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement>,
    q: QuestionSpec,
    index: number
  ) => {
    if (locked || ime.isComposing(e)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const free = q.options.length === 0
    if (e.key === "Enter") {
      // Single-line: Shift+Enter has no newline to add.
      e.preventDefault()
      if (!e.shiftKey && !e.repeat) continueFrom(index, state)
      return
    }
    if (!free && (e.key === "Escape" || (e.key === "ArrowUp" && !e.shiftKey))) {
      // Back to the options, on the "Other" row; left empty, "Other" closes.
      e.preventDefault()
      const s = stateOf(q)
      if (s.otherText === "") commit(q, { ...s, otherActive: false })
      moveHighlight(q, q.options.length)
      requestFocus({ index, part: "entry" })
      return
    }
    // A question that is only a field steps between questions like the
    // option lists do: Tab/Shift+Tab, and Backspace once it is empty.
    if (!free || !isMulti) return
    const to =
      e.key === "Tab"
        ? index + (e.shiftKey ? -1 : 1)
        : e.key === "Backspace" && e.currentTarget.value === ""
          ? index - 1
          : -1
    if (to >= 0 && to < questions.length) {
      e.preventDefault()
      goTo(to)
    }
  }

  const onCardKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (readOnly || e.defaultPrevented || ime.isComposing(e)) return
    if (e.key === "Escape") {
      // Back to the composer. Esc never declines: skipping takes the button.
      if (focusComposerFrom(rootRef.current)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault()
      if (!locked && !e.repeat) submitOrJump()
    }
  }

  // A selectable option card: the accent comes from our own selection state, and
  // the keyboard highlight adds a ring. The read-only view keeps the selection
  // crisp (no opacity dim) so the answer stands out.
  const cardClass = (selected: boolean, highlighted: boolean) =>
    cn(
      "flex w-full select-none items-start gap-2.5 rounded-lg border p-2.5 text-start font-normal outline-none transition-colors",
      selected ? "border-primary bg-primary/10" : "border-border/60",
      highlighted && "ring-2 ring-ring/50",
      highlighted && !selected && "bg-muted/40",
      submitting && "cursor-not-allowed opacity-60",
      readOnly && !submitting && "cursor-default",
      !submitting && !readOnly && "cursor-pointer",
      !selected && !submitting && !readOnly && "hover:bg-muted/40"
    )

  const optionBody = (
    text: string,
    recommended: boolean,
    description?: string
  ) => (
    <span className="min-w-0 flex-1">
      <span
        dir={detectTextDirection(text)}
        className="flex flex-wrap items-center gap-1.5 text-sm font-medium"
      >
        {text}
        {recommended && (
          <Badge variant="secondary" className="text-3xs">
            {t("recommended")}
          </Badge>
        )}
      </span>
      {description && (
        <span
          dir={detectTextDirection(description)}
          className="mt-0.5 block text-xs text-muted-foreground"
        >
          {description}
        </span>
      )}
    </span>
  )

  // The options + free-text "Other" block for one question, reused by the
  // single-question layout and each tab panel.
  const renderOptions = (q: QuestionSpec, index: number) => {
    const s = state[q.id]
    // Secret questions (codex marks API keys etc. with `is_secret`) mask the
    // typed answer.
    const inputType = q.is_secret ? "password" : "text"
    const inputClass =
      "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-60"
    const field = (label: string, entry: boolean) => (
      <input
        id={fieldId(index)}
        ref={claimFocus(index, entry ? "entry" : "other")}
        data-card-entry={entry && !readOnly ? "" : undefined}
        type={inputType}
        aria-label={label}
        aria-describedby={readOnly ? undefined : hintId}
        disabled={locked}
        value={s?.otherText ?? ""}
        dir={detectTextDirection(s?.otherText)}
        onChange={(e) => setOtherText(q, e.target.value)}
        {...ime.props}
        onKeyDown={(e) => onFieldKeyDown(e, q, index)}
        placeholder={t("otherPlaceholder")}
        className={inputClass}
      />
    )

    // Free-text question (no options — codex elicitation and MCP-server forms
    // ask open questions this way): the text input IS the answer field, always
    // visible, with no "Other" toggle to click through first. Typing marks the
    // question answered (`setOtherText` activates the free-text state).
    if (q.options.length === 0) return field(q.question, true)

    const hl = highlightOf(q)
    const ringed = focusedList === q.id && !locked
    const row = (i: number, selected: boolean, content: ReactNode) => (
      <button
        key={i}
        type="button"
        id={rowId(index, i)}
        role={q.multi_select ? "checkbox" : "radio"}
        aria-checked={selected}
        tabIndex={-1}
        disabled={locked}
        // The list keeps DOM focus (it owns the keys); the click hands it there.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onRowClick(q, index, i)}
        className={cardClass(selected, ringed && i === hl)}
      >
        <ChoiceMark multi={q.multi_select} checked={selected} />
        {content}
        {!readOnly && i < 9 && (
          <Keycap className="ms-auto mt-0.5">{i + 1}</Keycap>
        )}
      </button>
    )

    return (
      <div className="space-y-1.5">
        {/* One tab stop for the whole list: the highlighted row is its active
            descendant, so ↑/↓ move a highlight rather than DOM focus. */}
        <div
          id={listId(index)}
          ref={claimFocus(index, "entry")}
          data-card-entry={readOnly ? undefined : ""}
          role={q.multi_select ? "group" : "radiogroup"}
          aria-labelledby={labelId(index)}
          aria-describedby={readOnly ? undefined : hintId}
          aria-activedescendant={locked ? undefined : rowId(index, hl)}
          aria-disabled={locked || undefined}
          tabIndex={readOnly ? undefined : 0}
          onKeyDown={readOnly ? undefined : (e) => onListKeyDown(e, q, index)}
          onFocus={() => setFocusedList(q.id)}
          onBlur={() => setFocusedList(null)}
          className="space-y-1.5 outline-none"
        >
          {q.options.map((opt, i) => {
            const { text, recommended } = splitRecommended(opt.label)
            return row(
              i,
              s?.chosen.includes(opt.label) ?? false,
              optionBody(text, recommended, opt.description)
            )
          })}
          {row(
            q.options.length,
            s?.otherActive ?? false,
            <span className="text-sm font-medium">{t("other")}</span>
          )}
        </div>
        {s?.otherActive && field(t("other"), false)}
      </div>
    )
  }

  const questionHeading = (q: QuestionSpec, index: number) => (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="shrink-0 text-3xs">
        {q.multi_select ? t("multiSelect") : t("singleSelect")}
      </Badge>
      <p
        id={labelId(index)}
        dir={detectTextDirection(q.question)}
        className="text-sm text-foreground/90"
      >
        {q.question}
      </p>
    </div>
  )

  // Defensive: the backend mints a non-empty set and ConversationShell also
  // guards the mount, but never render an empty card — it would show 0/0 and a
  // Submit that posts an empty affirmative answer rather than a decline.
  if (questions.length === 0) return null

  // What Enter does from the options: submit outright, or continue to the next
  // open question (⌘/Ctrl+Enter submits from anywhere once all are answered).
  const enterSubmits = !isMulti || complete

  return (
    // Capped to the viewport (header + footer pinned, body scrolls) so a tall set
    // never covers the whole message list and always keeps Submit/Skip reachable.
    // Collapsed, only the header row is left, so the message list gets the space
    // back outright.
    // `overflow-hidden` clips the full-bleed progress bar to the rounded corners.
    <div
      ref={rootRef}
      role="group"
      aria-label={title ?? t("title")}
      onKeyDown={onCardKeyDown}
      className={cn(
        "mb-2 flex max-h-[88svh] flex-col overflow-hidden rounded-xl border border-primary/30 bg-card ws-msg-card",
        readOnly ? "shadow-sm" : "shadow-lg"
      )}
    >
      {isMulti && !collapsed && (
        <Progress
          value={(answeredCount / questions.length) * 100}
          aria-label={t("title")}
          aria-valuetext={`${answeredCount}/${questions.length}`}
          className="h-1 shrink-0 rounded-none"
        />
      )}

      <div
        className={cn("flex min-h-0 flex-col gap-3 p-3", collapsed && "p-2")}
      >
        {/* Header. Collapsed, this row IS the card, so it centers on the single
            line rather than top-aligning against a subtitle that is gone. */}
        <div
          className={cn(
            "flex shrink-0 gap-2.5",
            resolvedSubtitle && !collapsed ? "items-start" : "items-center"
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
            <MessageCircleQuestionMark className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{title ?? t("title")}</p>
            {resolvedSubtitle && !collapsed && (
              <p className="text-xs text-muted-foreground">
                {resolvedSubtitle}
              </p>
            )}
          </div>
          {isMulti && (
            <span className="shrink-0 self-center text-xs tabular-nums text-muted-foreground">
              {`${answeredCount}/${questions.length}`}
            </span>
          )}
          {/* Live card only: the read-only/answered record has its own
              expand/collapse capsule (`AskQuestionResultCard`), so a second
              chevron here would fight it. Collapsed, it is where the keyboard
              enters the card. */}
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 self-center"
              data-card-entry={collapsed ? "" : undefined}
              aria-label={collapsed ? t("expand") : t("collapse")}
              aria-expanded={!collapsed}
              title={collapsed ? t("expand") : t("collapse")}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          )}
        </div>

        {!readOnly && (
          <p id={hintId} className="sr-only">
            {t("keyboardHint")}
          </p>
        )}

        {!collapsed &&
          (isMulti ? (
            <Tabs
              value={activeId}
              onValueChange={setActiveId}
              dir={dir}
              className="flex min-h-0 flex-col gap-2"
            >
              <TabsList className="w-full shrink-0">
                {questions.map((q, i) => {
                  const done = isAnswered(state[q.id])
                  return (
                    <TabsTrigger
                      key={q.id}
                      value={q.id}
                      disabled={submitting}
                      data-answered={done ? "true" : "false"}
                      onFocus={() => setFocusedList(null)}
                      // ↓ or Enter on a tab goes into its question.
                      onKeyDown={
                        readOnly
                          ? undefined
                          : (e) => {
                              if (
                                e.key === "ArrowDown" ||
                                (e.key === "Enter" &&
                                  !e.metaKey &&
                                  !e.ctrlKey &&
                                  !e.altKey)
                              ) {
                                e.preventDefault()
                                goTo(i)
                              }
                            }
                      }
                      className="min-w-0 gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[answered=true]:text-primary"
                    >
                      {done ? (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-3xs leading-none">
                          {i + 1}
                        </span>
                      )}
                      <span className="truncate">{q.header}</span>
                    </TabsTrigger>
                  )
                })}
              </TabsList>
              {questions.map((q, i) => (
                <TabsContent
                  key={q.id}
                  value={q.id}
                  style={{ height: bodyHeight }}
                  className="mt-0 flex-none space-y-2.5 overflow-y-auto pr-1"
                >
                  {questionHeading(q, i)}
                  {renderOptions(q, i)}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div className="min-h-0 space-y-2.5 overflow-y-auto pr-1">
              {questions.map((q, i) => (
                <div key={q.id} className="space-y-2.5">
                  {questionHeading(q, i)}
                  {renderOptions(q, i)}
                </div>
              ))}
            </div>
          ))}

        {/* Footer — dropped in the read-only/answered view and while collapsed */}
        {!readOnly && !collapsed && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={skip}
              disabled={submitting}
            >
              {t("skip")}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {error && (
                <span role="alert" className="text-xs text-destructive">
                  {t("submitError")}
                </span>
              )}
              {isMulti && nextId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveId(nextId)}
                  disabled={submitting}
                >
                  {t("next")}
                  <ChevronRight className="ml-1 size-3.5" />
                  {!enterSubmits && <Keycap>↵</Keycap>}
                </Button>
              )}
              <Button
                size="sm"
                disabled={!complete || submitting}
                onClick={() => submit()}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              >
                {submitting && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                {t("submit")}
                {isMulti && (
                  <span className="ml-1 tabular-nums">{`(${answeredCount})`}</span>
                )}
                <Keycap className="ms-1">
                  {enterSubmits ? "↵" : `${isMac ? "⌘" : "Ctrl"}↵`}
                </Keycap>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
