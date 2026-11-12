"use client"

/**
 * The children of one sub-agent run, one row each, inside its Agent card.
 *
 * A Pi `subagent` call can start several children at once (workflow lanes,
 * parallel tasks, chain steps), and everything that happens to them reaches
 * the parent as notices. The parser folds those notices into the call
 * (`parsers/pi/fold.rs`); this renders what they said per child: how it ended
 * and why, the questions it asked the parent and the answers it got, and a way
 * into the child's own transcript. A row opens up to the child's full task,
 * error and result.
 */

import { memo, useId, useState, type ReactNode } from "react"
import {
  Ban,
  CheckIcon,
  ChevronRightIcon,
  CircleDashed,
  CornerDownRightIcon,
  Loader2,
  MessagesSquare,
  OctagonX,
  PauseCircle,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import {
  compactCount,
  firstLine,
  type SubagentRunChild,
  type SubagentRunExchange,
  type SubagentRunStatus,
} from "@/lib/agent-run-meta"
import { detectTextDirection } from "@/lib/text-direction"
import { cn } from "@/lib/utils"

export function SubagentStatusIcon({
  status,
  className,
}: {
  status: SubagentRunStatus | null
  className?: string
}) {
  const base = cn("size-3.5 shrink-0", className)
  switch (status) {
    case "completed":
      return <CheckIcon aria-hidden className={cn(base, "text-green-600")} />
    case "failed":
      return <OctagonX aria-hidden className={cn(base, "text-destructive")} />
    case "paused":
      return <PauseCircle aria-hidden className={cn(base, "text-amber-500")} />
    case "stopped":
      return <Ban aria-hidden className={cn(base, "text-muted-foreground")} />
    case "running":
      return (
        <Loader2
          aria-hidden
          className={cn(base, "animate-spin text-muted-foreground")}
        />
      )
    default:
      return (
        <CircleDashed
          aria-hidden
          className={cn(base, "text-muted-foreground/70")}
        />
      )
  }
}

/** The questions a child asked and Pi's answers, as quoted lines. */
export const SubagentExchanges = memo(function SubagentExchanges({
  exchanges,
  attention,
  expanded = false,
}: {
  exchanges: SubagentRunExchange[]
  attention: string[]
  /** Show each question and answer in full instead of its first line. */
  expanded?: boolean
}) {
  const t = useTranslations("Folder.chat.contentParts.agentRun")
  if (exchanges.length === 0 && attention.length === 0) return null
  const line = (value: string) => (expanded ? value : firstLine(value))

  return (
    <div className="space-y-1">
      {exchanges.map((exchange, i) => (
        <div key={`q-${i}`} className="space-y-0.5 text-xs">
          <QuotedLine
            label={t("asked")}
            text={line(exchange.question)}
            expanded={expanded}
          />
          <QuotedLine
            label={t("answered")}
            text={
              exchange.answer != null ? line(exchange.answer) : t("noAnswer")
            }
            muted={exchange.answer == null}
            expanded={expanded}
          />
        </div>
      ))}
      {attention.map((message, i) => (
        <div
          key={`a-${i}`}
          className="flex min-w-0 items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span
            dir={detectTextDirection(message)}
            className={cn(
              "min-w-0",
              expanded ? "whitespace-pre-wrap" : "truncate"
            )}
          >
            {expanded ? message : firstLine(message)}
          </span>
        </div>
      ))}
    </div>
  )
})

function QuotedLine({
  label,
  text,
  muted = false,
  expanded,
}: {
  label: string
  text: string
  muted?: boolean
  expanded: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
      <CornerDownRightIcon
        aria-hidden
        className="mt-0.5 size-3 shrink-0 opacity-60"
      />
      <span className="shrink-0 font-medium">{label}</span>
      <span
        dir={detectTextDirection(text)}
        className={cn(
          "min-w-0",
          expanded ? "whitespace-pre-wrap break-words" : "truncate",
          muted ? "italic opacity-70" : "text-foreground/80"
        )}
      >
        {text}
      </span>
    </div>
  )
}

export const SubagentRunChildren = memo(function SubagentRunChildren({
  items,
  onOpenSession,
}: {
  items: SubagentRunChild[]
  /** Open a child's own transcript; absent → no transcript buttons. */
  onOpenSession?: (child: SubagentRunChild) => void
}) {
  return (
    <div
      data-testid="subagent-run-children"
      className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60"
    >
      {items.map((child) => (
        <ChildRow key={child.key} item={child} onOpenSession={onOpenSession} />
      ))}
    </div>
  )
})

const ChildRow = memo(function ChildRow({
  item,
  onOpenSession,
}: {
  item: SubagentRunChild
  onOpenSession?: (child: SubagentRunChild) => void
}) {
  const t = useTranslations("Folder.chat.contentParts.agentRun")
  const tAgent = useTranslations("Folder.chat.contentParts")
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const facts = [
    item.agent && item.agent !== item.label ? item.agent : null,
    item.turns != null ? t("turns", { count: item.turns }) : null,
    item.tokens != null
      ? t("tokens", { count: compactCount(item.tokens) })
      : null,
  ].filter((fact): fact is string => fact !== null)
  const headline = item.error ?? item.result
  const hasDetails = Boolean(
    item.task ||
    item.error ||
    item.result ||
    item.exchanges.length > 0 ||
    item.attention.length > 0
  )

  return (
    <div data-testid="subagent-run-child" className="px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          disabled={!hasDetails}
          aria-expanded={hasDetails ? open : undefined}
          aria-controls={hasDetails && open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs disabled:cursor-default"
        >
          <SubagentStatusIcon status={item.status} />
          <span className="shrink-0 font-medium text-foreground">
            {item.label}
          </span>
          {facts.length > 0 && (
            <span className="min-w-0 truncate text-muted-foreground/80">
              {facts.join(" · ")}
            </span>
          )}
          {hasDetails && (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 opacity-50 transition-transform",
                open && "rotate-90"
              )}
            />
          )}
        </button>
        {item.sessionId && onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(item)}
            title={tAgent("agentSessionAction")}
            aria-label={tAgent("agentSessionAction")}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-3xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <MessagesSquare aria-hidden className="size-3 shrink-0" />
            {t("transcript")}
          </button>
        )}
      </div>

      {headline && !open && (
        <div
          dir={detectTextDirection(headline)}
          className={cn(
            "mt-1 truncate pl-5 text-xs",
            item.error ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {firstLine(headline)}
        </div>
      )}

      {(item.exchanges.length > 0 || item.attention.length > 0) && (
        <div className="mt-1 pl-5">
          <SubagentExchanges
            exchanges={item.exchanges}
            attention={item.attention}
            expanded={open}
          />
        </div>
      )}

      {open && hasDetails && (
        <div id={panelId} className="mt-2 space-y-2 pl-5">
          {item.task && (
            <Section label={t("task")}>
              <div
                dir={detectTextDirection(item.task)}
                className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
              >
                {item.task}
              </div>
            </Section>
          )}
          {item.error && (
            <Section label={t("error")}>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                {item.error}
              </pre>
            </Section>
          )}
          {item.result && (
            <Section label={t("result")}>
              {/* A written report, in the compact type the background-task
                  card gives a sub-agent's: headings must not outshout the
                  transcript around the card. */}
              <div className="max-h-72 overflow-auto rounded-md border border-border/60 px-2.5 py-2">
                <div className="prose prose-sm max-w-none break-words text-xs dark:prose-invert [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_ol]:list-inside [&_ul]:list-inside">
                  <MessageResponse>{item.result}</MessageResponse>
                </div>
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  )
})

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  )
}
