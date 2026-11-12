"use client"

import { useState, type KeyboardEvent } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  GitFork,
  Loader2,
  MessageCircleQuestion,
  RotateCw,
  Trash2,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { CHAT_TEXT_SCOPE_CLASS } from "@/lib/chat-text-scale"
import { cn } from "@/lib/utils"
import type {
  SideQuestionEntry,
  SideQuestionPanelState,
} from "@/stores/side-question-store"

export interface SideQuestionPanelProps {
  panel: SideQuestionPanelState
  onClose: () => void
  /** Step to an earlier (-1) or later (+1) exchange. */
  onStep: (delta: number) => void
  onRetry: (entry: SideQuestionEntry) => void
  onCopy: (entry: SideQuestionEntry) => void
  /** Absent while there is no conversation to keep exchanges on. */
  onClear?: () => void
  /** Absent while there is no conversation to fork. */
  onContinueInFork?: (entry: SideQuestionEntry) => void
}

const ICON_BUTTON = "size-7 text-muted-foreground hover:text-foreground"

/**
 * The side-question panel above the composer (`/btw`, see
 * `lib/side-question`): the question, then a spinner until the answer arrives
 * as Markdown. Earlier exchanges are a step away; the answer can be copied or
 * taken into a fork of the conversation, where the agent has its tools.
 * Nothing here is part of the conversation. Esc closes it.
 */
export function SideQuestionPanel({
  panel,
  onClose,
  onStep,
  onRetry,
  onCopy,
  onClear,
  onContinueInFork,
}: SideQuestionPanelProps) {
  const t = useTranslations("Folder.chat.sideQuestion")
  // "Clear everything?" is asked about what is on screen: once another
  // exchange shows (or one is added), the half-made question is gone.
  const screenKey = `${panel.index}/${panel.entries.length}`
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null)
  const confirmingClear = confirmingFor === screenKey
  const setConfirmingClear = (confirming: boolean) =>
    setConfirmingFor(confirming ? screenKey : null)
  const entry = panel.entries[panel.index] ?? null
  const total = panel.entries.length

  if (!panel.open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (confirmingClear) {
      setConfirmingClear(false)
      return
    }
    onClose()
  }

  const answered = entry?.status === "answered" ? entry.record : null

  return (
    <div
      role="region"
      aria-label={t("title")}
      data-testid="side-question-panel"
      onKeyDown={onKeyDown}
      className={cn(
        CHAT_TEXT_SCOPE_CLASS,
        "mb-2 w-full rounded-lg border border-border/60 bg-card/60 shadow-xs"
      )}
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-3 py-1.5">
        <MessageCircleQuestion
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="text-sm font-medium text-foreground">
          {t("title")}
        </span>
        <span className="ms-1 min-w-0 truncate text-xs text-muted-foreground">
          {t("notInConversation")}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          {total > 1 && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON}
                aria-label={t("previous")}
                title={t("previous")}
                disabled={panel.index <= 0}
                onClick={() => onStep(-1)}
              >
                <ChevronLeft className="size-4 rtl:rotate-180" />
              </Button>
              <span
                className="min-w-10 text-center text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {t("position", { current: panel.index + 1, total })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON}
                aria-label={t("next")}
                title={t("next")}
                disabled={panel.index >= total - 1}
                onClick={() => onStep(1)}
              >
                <ChevronRight className="size-4 rtl:rotate-180" />
              </Button>
            </>
          )}
          {entry && answered?.answer && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              aria-label={t("copy")}
              title={t("copy")}
              onClick={() => onCopy(entry)}
            >
              <Copy className="size-3.5" />
            </Button>
          )}
          {entry && answered && onContinueInFork && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              aria-label={t("continueInFork")}
              title={t("continueInForkHint")}
              onClick={() => onContinueInFork(entry)}
            >
              <GitFork className="size-3.5" />
            </Button>
          )}
          {onClear && total > 0 && !confirmingClear && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ICON_BUTTON}
              aria-label={t("clearHistory")}
              title={t("clearHistory")}
              onClick={() => setConfirmingClear(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-label={t("close")}
            title={t("closeHint")}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {confirmingClear && onClear && (
        <div
          role="alertdialog"
          aria-label={t("clearConfirm")}
          className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 text-muted-foreground">
            {t("clearConfirm")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setConfirmingClear(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7 px-2 text-xs"
            autoFocus
            onClick={() => {
              setConfirmingClear(false)
              onClear()
            }}
          >
            {t("clear")}
          </Button>
        </div>
      )}

      <div className="max-h-72 space-y-2 overflow-auto px-3.5 py-2.5">
        {entry === null ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <p
              dir="auto"
              className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
              data-testid="side-question-question"
            >
              {entry.question}
            </p>
            {entry.status === "pending" && (
              <div
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 aria-hidden className="size-4 animate-spin" />
                {t("thinking")}
              </div>
            )}
            {entry.status === "failed" && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 text-destructive" dir="auto">
                  {entry.error ?? t("failed")}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onRetry(entry)}
                >
                  <RotateCw className="size-3.5" />
                  {t("retry")}
                </Button>
              </div>
            )}
            {answered && (
              <div data-testid="side-question-answer" className="space-y-1.5">
                {answered.synthetic && (
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t("notice")}
                  </p>
                )}
                {answered.answer ? (
                  <div className="prose prose-sm max-w-none text-sm dark:prose-invert">
                    <MessageResponse>{answered.answer}</MessageResponse>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("noAnswer")}
                  </p>
                )}
                {answered.fallbackNotice && (
                  <p className="text-xs text-muted-foreground" dir="auto">
                    {answered.fallbackNotice}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
