"use client"

import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"

import {
  isTurnAnswerPart,
  splitTrailingAnswerParts,
  type AdaptedContentPart,
  type AdaptedHookFeedbackPart,
} from "@/lib/adapters/ai-elements-adapter"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/instant-collapsible"
import { buildActivity, hasVisibleAnswer } from "@/lib/activity/build-activity"
import { disclosureKeysFor } from "@/lib/activity/group"
import { ActivityParts, ContentPartsRenderer } from "./content-parts-renderer"
import { ActivityHeader } from "./activity/activity-header"
import { useActivityLive } from "./activity/activity-live-context"
import { openDisclosures } from "./activity/disclosure-store"
import { useFoldBack } from "./activity/fold-back"
import { WorkingMark } from "./activity/rail-icon"
import type { ActivityModel } from "@/lib/activity/types"
import { HookFeedbackMarker } from "./hook-feedback-marker"
import { ReplyMotion } from "./reply-motion"

/**
 * One stretch of a reply between boundaries: the work the fold hides, then the
 * answer that stays visible under it. `hook` is the Stop-hook feedback that
 * opened the stretch; `null` for the first one and for a stretch cut off by a
 * kept-visible note (see `LONG_NOTE_CHARS`).
 */
export interface AssistantTurnSegment {
  hook: AdaptedHookFeedbackPart | null
  progress: AdaptedContentPart[]
  answer: AdaptedContentPart[]
}

export interface SplitAssistantTurnParts {
  /** Every progress part of the reply, in order: what the fold hides. */
  progress: AdaptedContentPart[]
  /** Every part that stays visible with the fold shut, in order. */
  answer: AdaptedContentPart[]
  /** The same parts in render order, cut at each boundary. */
  segments: AssistantTurnSegment[]
}

/**
 * A note before the reply's last work is kept visible when it is at least this
 * long and the reply's closing answer is shorter. Long prose in the middle of
 * a turn is a report, not a status line ("Now running the tests."), and when
 * the turn then closes on a line or two, that report is very likely what the
 * reader needed: an agent that wraps up, hits one more check, and signs off
 * briefly would otherwise have its whole report, question included, folded
 * away under the header. Showing a mid-turn report the reader did not need
 * costs a scroll; hiding a question costs a turn that sits idle.
 */
export const LONG_NOTE_CHARS = 600

function visibleTextLength(parts: AdaptedContentPart[]): number {
  let length = 0
  for (const part of parts) {
    if (part.type === "text") length += part.text.trim().length
  }
  return length
}

/**
 * Cut one stretch at its last progress item, and keep a long note before that
 * work visible when the closing answer is short (`LONG_NOTE_CHARS`). The
 * guard only applies to a closing answer made of prose: an image or a plan
 * card is an answer of its own, and a reply that ends on its work has nothing
 * folded to begin with.
 */
function splitStretch(
  parts: AdaptedContentPart[],
  keepLongNotes: boolean
): Array<{ progress: AdaptedContentPart[]; answer: AdaptedContentPart[] }> {
  const { body, trailing } = splitTrailingAnswerParts(parts)
  const whole = [{ progress: body, answer: trailing }]
  if (!keepLongNotes || body.length === 0) return whole
  const closingIsShortProse =
    trailing.length > 0 &&
    trailing.every((part) => part.type === "text") &&
    visibleTextLength(trailing) > 0 &&
    visibleTextLength(trailing) < LONG_NOTE_CHARS
  if (!closingIsShortProse) return whole

  let note = -1
  for (let i = body.length - 1; i >= 0; i--) {
    const part = body[i]!
    if (part.type === "text" && part.text.trim().length >= LONG_NOTE_CHARS) {
      note = i
      break
    }
  }
  if (note < 0) return whole
  // Keep the note together with answer parts written right alongside it.
  let start = note
  while (start > 0 && isTurnAnswerPart(body[start - 1]!)) start -= 1
  let end = note + 1
  while (end < body.length && isTurnAnswerPart(body[end]!)) end += 1
  return [
    { progress: body.slice(0, start), answer: body.slice(start, end) },
    { progress: body.slice(end), answer: trailing },
  ]
}

/**
 * Split a completed assistant reply into what the fold hides and what stays
 * visible.
 *
 * Within a stretch, everything up to the last progress item (tool, reasoning)
 * is progress and what follows is the answer. Text before or between work is
 * commentary; a text-only response is left untouched because there is no
 * reliable signal that any of it is progress rather than the answer. The
 * progress/answer taxonomy is the adapter's (`isTurnAnswerPart`), shared with
 * the Goal capsule's trailing-answer lift — the same question ("what may a
 * collapsed chip swallow?") must not get two answers.
 *
 * A Stop-hook marker cuts the reply into stretches first. The agent had
 * finished when the hook fired, so the answer it wrote then is a final answer;
 * the work it does in reply to the hook must not turn that answer into
 * progress. Each stretch is split on its own, and the hook's feedback renders
 * between them.
 *
 * `keepLongNotes` adds the long-note guard (`LONG_NOTE_CHARS`). It is for a
 * settled reply: while the turn streams, its fold is open anyway, and moving
 * parts between stretches as the closing answer grows would remount them.
 */
export function splitAssistantTurnParts(
  parts: AdaptedContentPart[],
  { keepLongNotes = false }: { keepLongNotes?: boolean } = {}
): SplitAssistantTurnParts {
  const stretches: Array<{
    hook: AdaptedHookFeedbackPart | null
    parts: AdaptedContentPart[]
  }> = [{ hook: null, parts: [] }]
  for (const part of parts) {
    if (part.type === "hook-feedback") {
      stretches.push({ hook: part, parts: [] })
    } else {
      stretches[stretches.length - 1]!.parts.push(part)
    }
  }

  const segments: AssistantTurnSegment[] = []
  for (const stretch of stretches) {
    splitStretch(stretch.parts, keepLongNotes).forEach((piece, i) => {
      segments.push({ hook: i === 0 ? stretch.hook : null, ...piece })
    })
  }
  return {
    progress: segments.flatMap((segment) => segment.progress),
    answer: segments.flatMap((segment) => segment.answer),
    segments,
  }
}

/**
 * Manual fold overrides for turns OUTSIDE the current round, keyed by the
 * group's `parts` array and stamped with the fold epoch.
 *
 * Weak on `parts` because the thread is virtualized: scrolling a turn past the
 * overscan buffer unmounts it, and an uncontrolled Collapsible would forget the
 * expansion — so scrolling away from a turn you opened and back would re-hide
 * its work. For settled history `parts` is exactly as stable as the turn's
 * identity (it comes from the per-turn adapter cache and the merged-run cache
 * in `message-list-view`), and being weak it is collected with the turn rather
 * than accumulating per conversation.
 *
 * The epoch stamp is what makes "sending a new message folds everything above
 * it" a single number bump rather than a walk over the thread: an entry written
 * under an earlier epoch simply stops matching.
 *
 * The CURRENT round deliberately does NOT live here. Its `parts` array is
 * replaced twice on the way into history (the stream settling into a promoted
 * local turn, then the authoritative detail refetch), so anything keyed on it
 * would drop the expansion mid-read — which is exactly the "the reply folds
 * itself up the moment it finishes" behaviour this replaces. `message-list-view`
 * owns that one state positionally and passes it down controlled.
 */
const manualFold = new WeakMap<
  AdaptedContentPart[],
  { epoch: number; open: boolean }
>()

/**
 * The same overrides, keyed by the reply's first tool call id: the one handle
 * on a settled reply that survives its `parts` being rebuilt. A reply that
 * finishes (the stream settling into a local turn), a detail refetch after
 * the NEXT reply finishes, and a reconnect's resync all hand a turn above the
 * current round a fresh `parts` array, and a WeakMap entry on the old one is
 * gone with it — so a reply the reader had opened folded itself shut again a
 * few seconds later, taking what they were reading with it. Tool call ids are
 * the agent's own and read the same live and from the transcript.
 *
 * Bounded: the oldest entries go first, past `MAX_FOLD_IDS`.
 */
const manualFoldById = new Map<string, { epoch: number; open: boolean }>()
const MAX_FOLD_IDS = 500

/** Forget every remembered fold. Module state outlives a render, so tests that
 *  reuse a tool call id start from a clean slate with this. */
export function resetManualFoldMemory(): void {
  manualFoldById.clear()
}

function foldIdentity(parts: AdaptedContentPart[]): string | null {
  for (const part of parts) {
    if (part.type === "tool-call" && part.toolCallId) {
      return `tool:${part.toolCallId}`
    }
    if (
      (part.type === "delegation-status-group" ||
        part.type === "background-task-group") &&
      part.polls[0]?.toolCallId
    ) {
      return `tool:${part.polls[0].toolCallId}`
    }
    if (part.type === "goal-run" && part.start.toolCallId) {
      return `tool:${part.start.toolCallId}`
    }
  }
  return null
}

function readManualFold(
  parts: AdaptedContentPart[]
): { epoch: number; open: boolean } | undefined {
  const direct = manualFold.get(parts)
  if (direct) return direct
  const id = foldIdentity(parts)
  return id ? manualFoldById.get(id) : undefined
}

function writeManualFold(
  parts: AdaptedContentPart[],
  entry: { epoch: number; open: boolean }
): void {
  manualFold.set(parts, entry)
  const id = foldIdentity(parts)
  if (!id) return
  manualFoldById.delete(id)
  manualFoldById.set(id, entry)
  while (manualFoldById.size > MAX_FOLD_IDS) {
    const oldest = manualFoldById.keys().next().value
    if (oldest === undefined) break
    manualFoldById.delete(oldest)
  }
}

type RevealRef = RefObject<((stepKey: string) => boolean) | null>

export const CompletedTurnContent = memo(function CompletedTurnContent({
  parts,
  durationMs,
  completed,
  currentRound = false,
  roundOpen = true,
  onRoundOpenChange,
  foldEpoch = 0,
  pending = false,
}: {
  parts: AdaptedContentPart[]
  durationMs?: number | null
  completed: boolean
  /** This reply is the thread's current round — the newest assistant run, from
   *  the moment the agent started replying until the next user send. Its fold
   *  state is owned by `message-list-view` (see `manualFold`). */
  currentRound?: boolean
  /** Current-round fold state. Only read when `currentRound`. */
  roundOpen?: boolean
  onRoundOpenChange?: (open: boolean) => void
  /** Bumped by `message-list-view` on every user send. */
  foldEpoch?: number
  /** Not a reply yet: what stands in the thread between a send and the
   *  agent's first word — the reply's header and turning ring, where the
   *  reply will draw them, so it takes over without a jump (see
   *  `ReplyMotion`'s handoff). */
  pending?: boolean
}) {
  const tElapsed = useTranslations("Folder.chat.liveTurnStats")
  const split = useMemo(
    () => splitAssistantTurnParts(parts, { keepLongNotes: completed }),
    [parts, completed]
  )
  // A Stop hook sent the agent back to work, or a long report sits before the
  // reply's last work (`splitAssistantTurnParts`): each stretch folds its own
  // work under its own list and keeps its own answer in view.
  const segmented = split.segments.length > 1

  const [localOpen, setLocalOpen] = useState(() => {
    const entry = readManualFold(parts)
    if (entry?.epoch === foldEpoch) return entry.open
    // A reply still being written is never folded by default — folding it is
    // an explicit act. Normally `currentRound` covers the live reply, but a
    // host that tracks no rounds at all (the delegation-child viewer) leans on
    // this, and it keeps the component honest on its own.
    return !completed
  })

  // Derived-state-during-render, not an effect: the fold has to be settled in
  // the same render that reads it, or sending a message would paint one frame
  // of the previous round still expanded before collapsing it.
  const [foldMark, setFoldMark] = useState({ epoch: foldEpoch, currentRound })
  if (foldMark.epoch !== foldEpoch || foldMark.currentRound !== currentRound) {
    setFoldMark({ epoch: foldEpoch, currentRound })
    if (foldMark.epoch !== foldEpoch) {
      // A new user message folds everything above it, including whatever the
      // reader had opened by hand. Everything above is settled by definition;
      // the `!completed` case is steering (a send lands mid-reply), where the
      // reply being written must stay open.
      setLocalOpen(!completed)
    } else if (foldMark.currentRound && !currentRound) {
      // A newer round took over this position without a send in between (a
      // background/loop turn). Carry the outgoing round's expansion into local
      // state so it doesn't snap shut under the reader.
      setLocalOpen(roundOpen)
    }
  }

  const open = currentRound ? roundOpen : localOpen

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (currentRound) {
        onRoundOpenChange?.(next)
        return
      }
      writeManualFold(parts, { epoch: foldEpoch, open: next })
      setLocalOpen(next)
    },
    [currentRound, foldEpoch, onRoundOpenChange, parts]
  )

  const elapsed =
    typeof durationMs === "number" && durationMs > 0
      ? formatElapsedLabel(durationMs, tElapsed)
      : null

  // Folding trades the process away to keep the answer. With no answer left
  // over there is nothing to keep, and the reply would fold to a lone header —
  // which is exactly the shape of the turns a reader most needs to see: one
  // stopped mid-tool-call (agents leave no closing prose), a Cline reply whose
  // `attempt_completion` card IS the answer, a plan-mode turn that ends on
  // ExitPlanMode with the plan inside that card. Those settle un-foldable.
  //
  // A live reply is exempt from the answer half of that rule: its closing prose
  // has not been written yet, so applying it would withhold the toggle for the
  // whole stream and hand it over one beat before the turn ends. Folding a live
  // reply is then an explicit choice; the round settling re-applies the rule.
  //
  // With stretches (a Stop hook reopened the turn), "ends on progress" is read
  // off the LAST stretch: an earlier stretch's answer does not make it safe to
  // fold away the card the reply finally stopped on.
  const lastSegment = split.segments[split.segments.length - 1]
  const endsOnProgress =
    !!lastSegment &&
    lastSegment.progress.length > 0 &&
    !hasVisibleAnswer(lastSegment.answer)
  const foldable =
    split.progress.length > 0 &&
    (!completed || (hasVisibleAnswer(split.answer) && !endsOnProgress))
  // What is drawn: a reply that cannot fold shows its steps whatever `open`
  // says.
  const bodyOpen = foldable ? open : true

  // The unfold animation belongs to a real closed→open TOGGLE, never to a mount
  // that starts open. This component remounts while staying open: the
  // authoritative detail refetch renames the turn, and the virtualizer
  // recycles any row scrolled past its overscan buffer. Without this gate each
  // of those replays a 200ms unfold, so a finished reply appears to collapse
  // and re-open by itself — precisely the behaviour the round model exists to
  // prevent. Read from what is drawn, so `open` moving under a reply that
  // cannot fold (its failure link opening it) unfolds nothing.
  //
  // Only the ENTER side is gated. The exit animation must always run: it is
  // what unmounts the content (see the presence check in `instant-collapsible`).
  const [openMark, setOpenMark] = useState({
    open: bodyOpen,
    animateEnter: false,
  })
  if (openMark.open !== bodyOpen) {
    setOpenMark({ open: bodyOpen, animateEnter: bodyOpen })
  }
  const animateEnter = openMark.open === bodyOpen && openMark.animateEnter

  // Streamdown's incomplete-markdown repair (remend) may only run on text that
  // is still being written. On settled text it appends a closer after spans
  // that are ALREADY complete — a glob inside code, an identifier like `_meta`
  // — leaving a stray `*` / `_`; landing after a final code fence, that closer
  // reopens the block (#555). Every branch below renders some slice of this one
  // turn, so they all get the same answer.
  const isStreaming = !completed

  // While the agent is still at it, the prose after its last step is one more
  // step, not yet the answer: on the rail, as prose between steps is, with the
  // turning ring under it. Until the reply ends there is no telling an aside
  // ("Checking the tests next.") from its closing words; drawn as the answer,
  // the words being written sat under the ring, cut off from the steps they
  // follow, until the next call pulled them up into the steps. So are a
  // reply's first words, before it has any step: on the rail under the
  // header, where they stay as the steps join under them. Once the reply is
  // done its closing prose is lifted out under the steps as the answer — a
  // reply of words alone, out under its header. Folded, there is no rail to
  // put it on: it stays under the header, as the answer does.
  const proseOnRail = isStreaming && bodyOpen

  const bodyId = useId()
  const turnRef = useRef<HTMLDivElement | null>(null)
  // A long reply draws only the rows near the view (see `ActivityTimeline`):
  // the failure link asks it to draw the one it is after.
  const revealRef = useRef<((stepKey: string) => boolean) | null>(null)
  const activity = useMemo(
    () => buildActivity(parts, { isStreaming, keepAnswer: proseOnRail }),
    [parts, isStreaming, proseOnRail]
  )
  // Stretches: each draws its own steps (the whole reply's model still heads
  // the turn). The last one, while its closing words are on the rail, takes
  // them in as `activity` does.
  const segmentModels = useMemo<Array<ActivityModel | null> | null>(() => {
    if (!segmented) return null
    const last = split.segments.length - 1
    return split.segments.map((segment, i) => {
      const body =
        i === last && proseOnRail
          ? [...segment.progress, ...segment.answer]
          : segment.progress
      return body.length > 0
        ? buildActivity(body, { isStreaming, keepAnswer: true })
        : null
    })
  }, [segmented, split, isStreaming, proseOnRail])
  const segmentReveals = useMemo<RevealRef[]>(
    () => split.segments.map(() => ({ current: null })),
    [split.segments]
  )
  // The header's red "N failed": open the turn at the first failure nothing
  // redid — the row, and the group it is folded into.
  const failureKey = activity.summary.firstUnrecoveredKey
  const jumpToFailure = useCallback(() => {
    if (!failureKey) return
    openDisclosures(disclosureKeysFor(activity.items, failureKey))
    if (!bodyOpen) handleOpenChange(true)
    requestAnimationFrame(() => {
      // Drawn by now, if the steps were folded; the row itself may still
      // be a scroll away.
      if (segmented) {
        segmentReveals.some((reveal) => reveal.current?.(failureKey))
      } else {
        revealRef.current?.(failureKey)
      }
      requestAnimationFrame(() => {
        const root = turnRef.current
        if (!root) return
        const escaped = CSS.escape(failureKey)
        // The step's own row: a group's first member shares the group's key,
        // and is the one inside it.
        const rows = root.querySelectorAll(`[data-step-key="${escaped}"]`)
        const row =
          rows[rows.length - 1] ??
          root.querySelector(`[data-step-key^="${escaped}:"]`)
        row?.scrollIntoView({ block: "center", behavior: "smooth" })
      })
    })
  }, [
    activity,
    failureKey,
    bodyOpen,
    handleOpenChange,
    segmented,
    segmentReveals,
  ])

  // An open fold's steps end on a foot. While its agent is at work — not
  // while it waits on the user to answer a permission request — that is the
  // turning ring, under whatever it is writing; otherwise a row that folds
  // the steps away, saying what it folds: `Collapse 14 steps · 3m 34s`. A
  // reply with no step yet ends on the ring too while its agent is at work,
  // under its first words on the rail — with nothing in it yet, on the rail
  // from the header alone, where the first step will go; the steps join
  // above it. It has nothing to fold, so no row once the agent stops. A live
  // reply with its steps folded ends on the turning mark under whatever does
  // end it instead.
  const { awaitingUser } = useActivityLive()
  const working = isStreaming && !awaitingUser
  const footShown =
    bodyOpen && (working || (foldable && activity.items.length > 0))
  const tActivity = useTranslations("Folder.chat.activity")
  const headerRef = useRef<HTMLDivElement | null>(null)
  const foldBack = useFoldBack()
  const steps = activity.summary.steps
  // The time, as the header gives it: once the turn is done.
  const took = completed ? elapsed : null
  const foot = useMemo(
    () => ({
      // Only while the steps are open: folding, they stay in view as they
      // slide shut, and the mark under the reply has taken over by then.
      working: working && bodyOpen,
      what:
        [steps > 0 ? tActivity("header.steps", { count: steps }) : null, took]
          .filter(Boolean)
          .join(tActivity("header.separator")) || tActivity("header.label"),
      onFold: (control: HTMLButtonElement) =>
        foldBack({
          head: headerRef.current,
          control,
          toggle:
            headerRef.current?.querySelector<HTMLElement>(
              "button[aria-expanded]"
            ) ?? null,
          fold: () => handleOpenChange(false),
        }),
    }),
    [working, bodyOpen, steps, took, tActivity, foldBack, handleOpenChange]
  )

  const header = (
    <ActivityHeader
      ref={headerRef}
      summary={activity.summary}
      completed={completed}
      hasSteps={activity.items.length > 0}
      elapsed={elapsed}
      onJumpToFailure={failureKey ? jumpToFailure : undefined}
      toggle={
        foldable
          ? {
              open,
              onToggle: () => handleOpenChange(!open),
              controls: bodyId,
            }
          : undefined
      }
    />
  )
  // Parsers leave empty placeholder turns between tool exchanges;
  // `mergeConsecutiveAssistantTurns` only swallows them mid-run, so a lone one
  // reaches here with nothing in it at all. It has no content for a header to
  // head — heading it would turn an invisible turn into a visible empty one.
  // Settled turns only: a live reply's header is the point, even before its
  // first token lands.
  const blank =
    completed && split.progress.length === 0 && !hasVisibleAnswer(split.answer)
  if (blank) {
    return (
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={isStreaming}
      />
    )
  }

  // One tree for every shape the reply takes, so its header and its steps
  // stay the same elements as it changes shape: words alone gaining a first
  // step to fold, the reply ending with nothing to fold. A reply that cannot
  // fold — all process (stopped on a tool call, or ended on a card that is
  // its answer), or no steps at all — shows its rows as an open fold does,
  // hung under the header, its answer under them; the header's failure link
  // looks for its row in here.
  const answerShown = split.answer.length > 0 && !proseOnRail
  // What moves the layout (see `ReplyMotion`): not the words of the prose
  // being written, which only lengthen it.
  const shape = [
    foldable,
    proseOnRail,
    completed,
    working,
    footShown,
    answerShown,
    activity.items.length,
    activity.summary.steps,
    split.segments.length,
  ].join("|")
  const foldBodyClass = cn(
    "reply-fold-body w-full outline-none",
    animateEnter && "reply-fold-enter"
  )
  // The stretch whose list ends on the foot: the last one with steps — while
  // the agent is at work, only the last stretch, or the turning ring would
  // stand above what it is writing now.
  const lastWithSteps = segmentModels
    ? segmentModels.reduce<number>((at, model, i) => (model ? i : at), -1)
    : -1
  const footSegment =
    working && lastWithSteps !== split.segments.length - 1 ? -1 : lastWithSteps
  const segmentFoot = (i: number) =>
    i === footSegment && (foldable || working) ? foot : undefined
  const footDrawn = segmentModels
    ? bodyOpen && footSegment >= 0 && (foldable || working)
    : footShown
  // What the header heads: the whole reply, or its first stretch.
  const firstModel = segmentModels ? segmentModels[0] : activity
  return (
    <ReplyMotion
      shape={shape}
      live={isStreaming}
      open={bodyOpen}
      rootRef={turnRef}
      handoff={pending ? "give" : "take"}
    >
      <div
        ref={turnRef}
        className={foldable ? "space-y-4" : "space-y-3"}
        // The newest reply (globals.css): its blocks are laid out at once
        // rather than when scrolled near, so none of them is drawn first at a
        // placeholder height while it is written or as it settles.
        data-reply-current={isStreaming || currentRound ? "" : undefined}
      >
        <Collapsible
          className="w-full"
          open={bodyOpen}
          onOpenChange={handleOpenChange}
        >
          {header}
          {/* Folded: what can outlive the turn — a delegation or sub-agent
              still running — stays in view under the header, and so do the
              turn's outcomes (its images, a sub-agent the provider stopped;
              see `canOutliveTurn`). */}
          {!bodyOpen && firstModel ? (
            <ActivityParts
              model={firstModel}
              isStreaming={isStreaming}
              pinnedOnly
              headed
            />
          ) : null}
          {/* `reply-fold-body` (globals.css) slides the body open and shut on
              a grid track. The div is the clipped grid item — it must stay a
              single child, and the spacing has to live INSIDE it (the headed
              list's own, under the header) or the closed track never reaches
              zero. */}
          {firstModel ? (
            <CollapsibleContent id={bodyId} className={foldBodyClass}>
              <div>
                <ActivityParts
                  model={firstModel}
                  isStreaming={isStreaming}
                  foot={
                    segmentModels
                      ? segmentFoot(0)
                      : foldable || working
                        ? foot
                        : undefined
                  }
                  headed
                  revealRef={segmentModels ? segmentReveals[0] : revealRef}
                />
              </div>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
        {segmented ? (
          <>
            {split.segments[0]!.answer.length > 0 ? (
              <ContentPartsRenderer
                parts={split.segments[0]!.answer}
                role="assistant"
                isStreaming={isStreaming}
              />
            ) : null}
            {/* Later stretches: the hook that sent the agent back to work,
                then that stretch's own steps under the same fold, then its
                answer. One wrapper per stretch keeps the closed folds from
                leaving gaps: the fold's root stays mounted when shut, so the
                spacing lives inside it. */}
            {split.segments.slice(1).map((segment, j) => {
              const i = j + 1
              const model = segmentModels![i]
              const last = i === split.segments.length - 1
              const answerHere =
                segment.answer.length > 0 && !(last && proseOnRail)
              return (
                <div key={i}>
                  {segment.hook ? (
                    <HookFeedbackMarker part={segment.hook} />
                  ) : null}
                  {model ? (
                    <Collapsible className="w-full" open={bodyOpen}>
                      {!bodyOpen ? (
                        <ActivityParts
                          model={model}
                          isStreaming={isStreaming}
                          pinnedOnly
                          headed={!!segment.hook}
                        />
                      ) : null}
                      <CollapsibleContent className={foldBodyClass}>
                        <div>
                          <ActivityParts
                            model={model}
                            isStreaming={isStreaming}
                            foot={segmentFoot(i)}
                            headed={!!segment.hook}
                            revealRef={segmentReveals[i]}
                          />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}
                  {answerHere ? (
                    <div
                      className={
                        segment.hook || (bodyOpen && model) ? "pt-4" : undefined
                      }
                      data-motion-key={
                        last ? `prose:${segment.progress.length}` : undefined
                      }
                    >
                      <ContentPartsRenderer
                        parts={segment.answer}
                        role="assistant"
                        isStreaming={isStreaming}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </>
        ) : answerShown ? (
          // Keyed as the prose it was on the rail (`prose:<its index in the
          // reply>`), so the closing words glide off the rail into place when
          // the reply ends.
          <div data-motion-key={`prose:${split.progress.length}`}>
            <ContentPartsRenderer
              parts={split.answer}
              role="assistant"
              isStreaming={isStreaming}
            />
          </div>
        ) : null}
        {working && !footDrawn ? <WorkingMark /> : null}
      </div>
    </ReplyMotion>
  )
})
