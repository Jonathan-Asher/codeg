"use client"

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import { ListTodoIcon, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MessageResponse } from "@/components/ai-elements/message"
import { Keycap } from "@/components/chat/keycap"
import { useCardArrivalFocus, useComposerHandoff } from "@/hooks/use-card-focus"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  focusComposerAfterAnswer,
  focusComposerFrom,
  isTypingTarget,
} from "@/lib/card-focus"
import {
  formatShortcutLabel,
  matchShortcutEvent,
} from "@/lib/keyboard-shortcuts"
import { localeDirection } from "@/lib/text-direction"
import type {
  PendingPlanApprovalState,
  PlanApprovalAnswer,
  PlanApprovalDecision,
} from "@/lib/types"

interface PlanApprovalCardProps {
  /** The awaiting-decision plan approval. The shell renders this card only when
   *  an approval is pending, so the prop is always present. */
  approval: PendingPlanApprovalState
  /** Resolves the parked `exit_plan_mode` ext request. Returns a promise so the
   *  card can hold an in-flight state and surface a retryable error on failure. */
  onAnswer: (
    approvalId: string,
    answer: PlanApprovalAnswer
  ) => void | Promise<void>
  /** Take keyboard focus when the approval arrives — never from someone typing
   *  (see `canCardTakeFocus`). A conversation not in front passes false. */
  autoFocus?: boolean
}

/** The card's controls, by the `data-plan-action` that names them. */
type PlanControl =
  | "approve"
  | "request_changes"
  | "abandon"
  | "cancel"
  | "send"
  | "feedback"

/**
 * Grok plan-mode approval card. When the agent finishes planning it calls
 * `exit_plan_mode` and BLOCKS on the user's decision; this renders the plan above
 * the composer with Approve / Request-changes / Abandon actions (mirroring Grok's
 * own TUI approval bar). "Request changes" reveals a textarea for freeform
 * revision notes. Modeled on `AskQuestionCard`'s in-flight/disable pattern: on
 * success the backend's `plan_approval_resolved` clears `pendingPlanApproval` and
 * unmounts this card, so controls stay disabled rather than flashing back on.
 *
 * Keyboard: 1 approves, 2 opens the change request, 3 moves to Abandon (it
 * throws the plan away, so Enter there confirms rather than the digit alone).
 * Approve holds focus on arrival, so Enter approves. In the notes the send
 * shortcut sends and Esc closes them; elsewhere Esc returns to the composer.
 */
export function PlanApprovalCard({
  approval,
  onAnswer,
  autoFocus = true,
}: PlanApprovalCardProps) {
  const t = useTranslations("Folder.chat.planApproval")
  const dir = localeDirection(useLocale())
  const ime = useImeGuard()
  const isMac = useIsMac()
  const { shortcuts } = useShortcutSettings()
  const hintId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [feedback, setFeedback] = useState("")
  const inFlight = useRef(false)
  // A control to focus once the change that brings it on screen has rendered.
  const refocus = useRef<PlanControl | null>(null)

  useCardArrivalFocus(rootRef, approval.approval_id, autoFocus)
  useComposerHandoff(rootRef, true)
  useLayoutEffect(() => {
    const control = refocus.current
    if (!control) return
    refocus.current = null
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-plan-action="${control}"]`
    )
    el?.focus()
    // Notes kept from an earlier opening are continued, not typed over.
    if (el instanceof HTMLTextAreaElement) {
      el.setSelectionRange(el.value.length, el.value.length)
    }
  })

  const openNotes = () => {
    setChangesOpen(true)
    refocus.current = "feedback"
  }

  const plan = approval.plan_markdown.trim()

  // Run a decision round-trip, holding the card in an in-flight state until it
  // resolves. On failure re-enable and surface a retryable error. The keyboard
  // goes back to the composer once the decision lands, and stays in the card
  // for the retry if it fails.
  const run = async (answer: PlanApprovalAnswer) => {
    if (inFlight.current) return
    inFlight.current = true
    const hadFocus = rootRef.current?.contains(document.activeElement) ?? false
    const returnFocus = focusComposerAfterAnswer(rootRef.current)
    setSubmitting(true)
    setError(false)
    try {
      await onAnswer(approval.approval_id, answer)
      inFlight.current = false
      returnFocus()
    } catch {
      setError(true)
      setSubmitting(false)
      inFlight.current = false
      if (hadFocus) refocus.current = changesOpen ? "feedback" : "approve"
    }
  }

  const decide = (decision: PlanApprovalDecision, fb?: string) =>
    void run({ decision, feedback: fb ?? null })

  const sendChanges = () => {
    if (feedback.trim()) decide("request_changes", feedback.trim())
  }

  const locked = submitting

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || ime.isComposing(e)) return
    if (e.key === "Escape") {
      // Back to the composer; Esc never decides anything.
      if (focusComposerFrom(rootRef.current)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
    const digit = e.key === "1" || e.key === "2" || e.key === "3"
    // A held key repeats; one press must decide once.
    if (e.repeat && (digit || e.key === "Enter" || e.key === " ")) {
      e.preventDefault()
      return
    }
    if (digit && !changesOpen && !locked) {
      e.preventDefault()
      if (e.key === "1") decide("approve")
      else if (e.key === "2") openNotes()
      else
        rootRef.current
          ?.querySelector<HTMLElement>('[data-plan-action="abandon"]')
          ?.focus()
      return
    }
    // Arrows move between the buttons in view.
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight"
    if (!horizontal && e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    const buttons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-plan-action]"
      ) ?? []
    )
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const forward = horizontal
      ? (e.key === "ArrowRight") === (dir === "ltr")
      : e.key === "ArrowDown"
    e.preventDefault()
    buttons[(at + (forward ? 1 : -1) + buttons.length) % buttons.length].focus()
  }

  const onFeedbackKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ime.isComposing(e)) return
    if (e.key === "Escape") {
      // Close the notes (kept for when they reopen) and go back to the actions.
      e.preventDefault()
      e.stopPropagation()
      setChangesOpen(false)
      refocus.current = "request_changes"
      return
    }
    const modEnter = e.key === "Enter" && (e.metaKey || e.ctrlKey)
    if (modEnter || matchShortcutEvent(e, shortcuts.send_message)) {
      e.preventDefault()
      if (!e.repeat && !locked) sendChanges()
    }
  }

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t("title")}
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
      className="w-full space-y-3 rounded-lg border border-border/60 bg-card/60 p-4"
    >
      <p id={hintId} className="sr-only">
        {t("keyboardHint")}
      </p>
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <ListTodoIcon className="size-4 shrink-0 text-muted-foreground" />
        {t("title")}
      </div>

      {plan ? (
        <div className="prose prose-sm max-h-80 max-w-none overflow-auto rounded-md border border-border/60 bg-muted/30 px-3.5 py-3 text-sm dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside">
          <MessageResponse>{plan}</MessageResponse>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
          {t("emptyPlan")}
        </p>
      )}

      {changesOpen ? (
        <div className="space-y-2">
          <Textarea
            data-plan-action="feedback"
            data-card-entry=""
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            {...ime.props}
            onKeyDown={onFeedbackKeyDown}
            placeholder={t("feedbackPlaceholder")}
            disabled={locked}
            rows={3}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              data-plan-action="cancel"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => setChangesOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              data-plan-action="send"
              size="sm"
              disabled={locked || !feedback.trim()}
              onClick={sendChanges}
            >
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              {t("sendChanges")}
              <Keycap>
                {formatShortcutLabel(shortcuts.send_message, isMac).replace(
                  "Enter",
                  "↵"
                )}
              </Keycap>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-plan-action="approve"
            data-card-entry=""
            size="sm"
            disabled={locked}
            onClick={() => decide("approve")}
          >
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {t("approve")}
            <Keycap>1</Keycap>
            <Keycap>↵</Keycap>
          </Button>
          <Button
            data-plan-action="request_changes"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={openNotes}
          >
            {t("requestChanges")}
            <Keycap>2</Keycap>
          </Button>
          <Button
            data-plan-action="abandon"
            variant="destructive"
            size="sm"
            disabled={locked}
            onClick={() => decide("abandon")}
          >
            {t("abandon")}
            <Keycap>3</Keycap>
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{t("submitError")}</p>}
    </div>
  )
}
