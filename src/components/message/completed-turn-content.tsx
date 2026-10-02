"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  splitTrailingAnswerParts,
  isTurnAnswerPart,
  type AdaptedContentPart,
  type AdaptedHookFeedbackPart,
} from "@/lib/adapters/ai-elements-adapter"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { ContentPartsRenderer } from "./content-parts-renderer"
import { HookFeedbackMarker } from "./hook-feedback-marker"

/**
 * One stretch of a reply between boundaries: the work the chip folds, then the
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
  /** Every progress part of the reply, in order: what the chip folds. */
  progress: AdaptedContentPart[]
  /** Every part that stays visible with the chip folded, in order. */
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
 * away behind "Worked for …". Showing a mid-turn report the reader did not
 * need costs a scroll; hiding a question costs a turn that sits idle.
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
 * Split a completed assistant reply into what the "Worked for …" chip folds
 * and what stays visible.
 *
 * Within a stretch, everything up to the last progress item (tool, reasoning)
 * is progress and what follows is the answer. Text before or between work is
 * commentary; a text-only response is left untouched because there is no
 * reliable signal that any of it is progress rather than the answer. The
 * progress/answer taxonomy is the adapter's (`isTurnAnswerPart`), shared with
 * the Goal capsule's trailing-answer lift.
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
 * Does the split leave anything for the reader once the progress is folded
 * away? Whitespace-only text is not an answer: it renders as an empty markdown
 * block, so a turn "kept visible" by it still reads as a blank reply.
 */
function hasVisibleAnswer(answer: AdaptedContentPart[]): boolean {
  return answer.some(
    (part) => part.type !== "text" || part.text.trim().length > 0
  )
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
 * Shared between the interactive trigger and the static (nothing-to-fold) row
 * so a turn's header keeps the same shape whether or not it can be folded.
 *
 * `w-full` with the chevron sitting right after the label (not pushed to the
 * far edge): the rule underneath is a section divider and spans the reply,
 * while the control it belongs to reads as one unit. No corner radius — a
 * radius curls the ends of a lone `border-b` up into little hooks.
 *
 * The rule is tinted from `--foreground` rather than taking `--border`, which
 * it cannot use at any opacity: `--border` is a near-white `oklch(0.922)` in
 * light and `white/10%` in dark, so the usual `border-border/50` came out at
 * roughly `oklch(0.96)` on white and white at 5% on near-black — invisible in
 * both, and worst in dark. A foreground tint inverts with the theme instead —
 * the same derivation as task-card's outline and `--ws-chrome-border`, which
 * both reach for `--foreground` for exactly this reason.
 *
 * The TINT is what buys the legibility here, not the strength: at 10% this
 * lands about where `--border` would if it were used undiluted, except it now
 * holds up in dark and over a workspace background image, where the token
 * washes out. Deliberately no heavier — the header is a quiet label the reader
 * scans past, and a rule spanning the full width of every reply in the thread
 * carries far more weight than a lone boxed card's outline does.
 */
const HEADER_CLASS =
  "flex w-full items-center gap-1 border-b border-foreground/10 pb-1.5 text-xs font-medium text-muted-foreground/70"

export const CompletedTurnContent = memo(function CompletedTurnContent({
  parts,
  durationMs,
  completed,
  currentRound = false,
  roundOpen = true,
  onRoundOpenChange,
  foldEpoch = 0,
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
}) {
  const t = useTranslations("Folder.chat.messageList")
  const tElapsed = useTranslations("Folder.chat.liveTurnStats")
  const split = useMemo(
    () => splitAssistantTurnParts(parts, { keepLongNotes: completed }),
    [parts, completed]
  )

  const [localOpen, setLocalOpen] = useState(() => {
    const entry = manualFold.get(parts)
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

  // The unfold animation belongs to a real closed→open TOGGLE, never to a mount
  // that starts open. This component remounts constantly while staying open:
  // the row key flips from `streaming-…` to `persisted-…` the instant a reply
  // settles, the authoritative detail refetch renames the turn and flips it
  // again, and the virtualizer recycles any row scrolled past its overscan
  // buffer. Without this gate each of those replays a 200ms unfold, so a
  // finished reply appears to collapse and re-open by itself — precisely the
  // behaviour the round model exists to prevent.
  //
  // Only the ENTER side is gated. The exit animation must always run: it is
  // what unmounts the content (see the presence check in `instant-collapsible`).
  const [openMark, setOpenMark] = useState({ open, animateEnter: false })
  if (openMark.open !== open) setOpenMark({ open, animateEnter: open })
  const animateEnter = openMark.open === open && openMark.animateEnter

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (currentRound) {
        onRoundOpenChange?.(next)
        return
      }
      manualFold.set(parts, { epoch: foldEpoch, open: next })
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
  const foldable =
    split.progress.length > 0 && (!completed || hasVisibleAnswer(split.answer))

  const label = !completed
    ? t("working")
    : elapsed
      ? t("workedFor", { duration: elapsed })
      : t("worked")

  // Every assistant reply with content carries a header. Gating it on "has work
  // to fold or a duration to show" made it blink out at the worst moment: a
  // reply settles BEFORE the post-turn reparse backfills `duration_ms`, so a
  // text-only reply went "Working…" → no header at all → "Worked for 3s" a
  // second later. The settled-no-duration label holds that slot.
  const labelNode = completed ? (
    <span className="min-w-0 truncate tabular-nums">{label}</span>
  ) : (
    <Shimmer
      as="span"
      className="min-w-0 truncate"
      duration={1}
      shineColor="var(--primary)"
    >
      {label}
    </Shimmer>
  )

  // Streamdown's incomplete-markdown repair (remend) may only run on text that
  // is still being written. On settled text it appends a closer after spans
  // that are ALREADY complete — a glob inside code, an identifier like `_meta`
  // — leaving a stray `*` / `_`; landing after a final code fence, that closer
  // reopens the block (#555). Every branch below renders some slice of this one
  // turn, so they all get the same answer.
  const isStreaming = !completed

  if (!foldable) {
    // Parsers leave empty placeholder turns between tool exchanges;
    // `mergeConsecutiveAssistantTurns` only swallows them mid-run, so a lone
    // one reaches here with nothing in it at all. It has no content for a
    // header to head — heading it would turn an invisible turn into a visible
    // empty one. Settled turns only: a live reply's header is the point, even
    // before its first token lands.
    const blank =
      completed &&
      split.progress.length === 0 &&
      !hasVisibleAnswer(split.answer)
    if (blank) {
      return (
        <ContentPartsRenderer
          parts={parts}
          role="assistant"
          isStreaming={isStreaming}
        />
      )
    }
    return (
      <div className="space-y-3">
        <div className={HEADER_CLASS}>{labelNode}</div>
        <ContentPartsRenderer
          parts={parts}
          role="assistant"
          isStreaming={isStreaming}
        />
      </div>
    )
  }

  const [first, ...rest] = split.segments
  const foldBodyClass = cn(
    "reply-fold-body w-full outline-none",
    animateEnter && "reply-fold-enter"
  )

  return (
    <div className="space-y-4">
      <Collapsible
        className="w-full"
        open={open}
        onOpenChange={handleOpenChange}
      >
        {/* No hover treatment at all — the header is a quiet label the reader
            scans past, and the chevron carries the affordance. Closed points
            along the reading direction, open points down at what it revealed:
            the same disclosure triangle every other fold in the thread uses. */}
        <CollapsibleTrigger
          className={cn(
            HEADER_CLASS,
            "group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
        >
          {labelNode}
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-90"
          />
        </CollapsibleTrigger>
        {/* `reply-fold-body` (globals.css) slides the body open and shut on a
            grid track. The inner div is the clipped grid item — it must stay a
            single child, and the spacing has to live INSIDE it or the closed
            track never reaches zero. */}
        {first && first.progress.length > 0 && (
          <CollapsibleContent className={foldBodyClass}>
            <div>
              <div className="pt-3">
                <ContentPartsRenderer
                  parts={first.progress}
                  role="assistant"
                  isStreaming={isStreaming}
                />
              </div>
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
      {first && first.answer.length > 0 && (
        <ContentPartsRenderer
          parts={first.answer}
          role="assistant"
          isStreaming={isStreaming}
        />
      )}
      {/* Later stretches: the hook that reopened the turn, then that
          stretch's own work under the same fold, then its answer. One wrapper
          per stretch keeps the closed folds from leaving gaps: the fold's root
          stays mounted when shut, so its spacing lives inside it. */}
      {rest.map((segment, i) => (
        <div key={i}>
          {segment.hook && <HookFeedbackMarker part={segment.hook} />}
          {segment.progress.length > 0 && (
            <Collapsible className="w-full" open={open}>
              <CollapsibleContent className={foldBodyClass}>
                <div>
                  <div className={segment.hook ? "pt-4" : undefined}>
                    <ContentPartsRenderer
                      parts={segment.progress}
                      role="assistant"
                      isStreaming={isStreaming}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
          {segment.answer.length > 0 && (
            <div
              className={
                segment.hook || (open && segment.progress.length > 0)
                  ? "pt-4"
                  : undefined
              }
            >
              <ContentPartsRenderer
                parts={segment.answer}
                role="assistant"
                isStreaming={isStreaming}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
})
