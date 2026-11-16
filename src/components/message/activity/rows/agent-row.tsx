"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, Clock3 } from "lucide-react"

import { MessageResponse } from "@/components/ai-elements/message"
import { useTruncation } from "@/hooks/use-truncation"
import { buildActivity } from "@/lib/activity/build-activity"
import { describeToolCall } from "@/lib/activity/describe-tool-call"
import { cleanTitle, tallySteps } from "@/lib/activity/progress"
import { previewLine } from "@/lib/activity/format"
import type { StepStatus } from "@/lib/activity/types"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { firstLine, type SubagentRun } from "@/lib/agent-run-meta"
import { shortAgentId } from "@/lib/collab-tool"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { detectTextDirection } from "@/lib/text-direction"
import { cn } from "@/lib/utils"
import { ModelNotesToggle } from "../../model-notes-toggle"
import { ProviderErrorNotice } from "../../provider-error-notice"
import { SubagentSessionDialog } from "../../subagent-session-dialog"
import {
  SubagentExchanges,
  SubagentRunChildren,
} from "../../subagent-run-children"
import { useAgentCallModel } from "../../use-agent-call-model"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { useFoldRow } from "../fold-back"
import { ProgressLine } from "../progress-line"
import { RailIcon } from "../rail-icon"
import { StatusFigure, useStatusText } from "../step-visuals"
import {
  formatClock,
  LIVE_CLOCK_AFTER_MS,
  useLiveElapsed,
} from "../use-live-elapsed"
import type { ToolStep } from "./explore-rows"

/** Longest result line shown under a finished sub-agent. */
const RESULT_PREVIEW_CHARS = 240

/**
 * A sub-agent the turn launched (Claude Code's Agent/Task, codex's spawned
 * agents, Grok's sub-agents): `Explore  Find binding consumers  Find every
 * consumer of…   48s` — the prompt it was handed on the title line — and,
 * while it runs, its latest step (a skeleton until it has one), or once done
 * the first line of its result, beside "Open conversation ↗" when it has a
 * session of its own. The panel holds the full prompt, the sub-agent's own
 * steps as a nested timeline, and its result.
 *
 * A Pi sub-agent run (`_meta["codeg.subagentRun"]`, folded by the parser or
 * sent live) is one row for the whole run: its panel holds a row per child
 * when there are several, the one child's questions and alerts otherwise,
 * and the run's own error and result in place of the plain-text report. A
 * sub-agent the model provider stopped shows its compact stopped state
 * instead of the provider's message as a reply, and stays in view when the
 * reply folds (see `canOutliveTurn`).
 */
export const AgentRow = memo(function AgentRow({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.contentParts")
  const tActivity = useTranslations("Folder.chat.activity")
  const tBg = useTranslations("Folder.chat.backgroundTasks")
  const tRun = useTranslations("Folder.chat.contentParts.agentRun")
  const statusText = useStatusText()
  const { renderNested, pinnedOnly } = useActivityRender()
  const m = useAgentCallModel(step.part)
  const run = m.subagentRun
  const live =
    m.isRunning ||
    m.isLiveBackgroundLaunch ||
    m.outcomeBackground ||
    m.runRunning
  const failed =
    m.isError ||
    m.backgroundFailed ||
    m.outcomeError != null ||
    m.providerError != null ||
    run?.status === "failed"
  // A codex native sub-agent's card settles when codex acknowledges the
  // launch, not when the child ends; how it ended arrives (if ever) as a
  // separate state. An interrupted one is drawn as interrupted.
  const codexInterrupted =
    m.isCodexSubagent && m.codexSubagentState === "interrupted"
  // …and until codex says, the panel explains why the outcome is unknown.
  const launchCaveat =
    m.isCodexSubagent && !m.isRunning && m.codexSubagentState === null
  const status: StepStatus = live
    ? "running"
    : failed
      ? "failed"
      : codexInterrupted || run?.status === "stopped"
        ? "cancelled"
        : "succeeded"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: failed,
  })
  const foldRow = useFoldRow()
  const elapsed = useLiveElapsed(step.key, live)
  const clock =
    elapsed !== null && elapsed >= LIVE_CLOCK_AFTER_MS
      ? formatClock(elapsed)
      : null

  // The sub-agent's own steps, as a timeline: its transcript in arrival order
  // when there is prose to interleave, else its tool calls alone.
  const childModel = useMemo(() => {
    const parts: AdaptedContentPart[] = []
    if (m.hasTimeline) {
      m.transcript.forEach((entry, at) => {
        if (entry.type === "tool_call") {
          const call = m.adaptedToolCalls[entry.childIndex]
          if (call) parts.push(call)
        } else if (entry.type === "thinking") {
          if (entry.text.trim()) {
            parts.push({
              type: "reasoning",
              content: entry.text,
              isStreaming: m.isRunning && at === m.transcript.length - 1,
            })
          }
        } else if (entry.text.trim()) {
          parts.push({ type: "text", text: entry.text })
        }
      })
    } else {
      parts.push(...m.adaptedToolCalls)
    }
    return parts.length > 0
      ? buildActivity(parts, { isStreaming: m.isRunning, keepAnswer: true })
      : null
  }, [m.hasTimeline, m.transcript, m.adaptedToolCalls, m.isRunning])

  // Its finished steps, one segment each, from the calls it recorded.
  const progress = useMemo(
    () =>
      tallySteps(
        m.adaptedToolCalls.map((call) => {
          const tool = describeToolCall(call)
          return {
            mark:
              tool.status === "succeeded"
                ? ("ok" as const)
                : tool.status === "failed" || tool.status === "rejected"
                  ? ("failed" as const)
                  : null,
            title:
              cleanTitle(tool.command?.display) ??
              cleanTitle(tool.target?.text) ??
              tool.toolName,
          }
        })
      ),
    [m.adaptedToolCalls]
  )

  // A background launch's lifecycle marker stands for its output: the result
  // it settled with, or none — never the marker itself, which is what
  // `part.output` holds then. A settle may carry no result at all (OpenCode's,
  // for a sub-agent that ended without writing a reply). A Pi run's result is
  // its own (`SubagentRunOutcome`): the call's output is a plain-text copy of
  // the run for clients that cannot read it. A provider's refusal is no
  // result at all.
  const output =
    run || m.providerError
      ? null
      : m.backgroundLifecycle
        ? m.backgroundLifecycle.result
        : ((m.taskOutcome || m.isLiveBackgroundLaunch
            ? null
            : step.part.output) ?? null)
  const latest = live
    ? (m.grokProgressLine ??
      (m.hasTimeline
        ? previewLine(
            [...m.transcript].reverse().find((e) => e.type !== "tool_call")
              ?.text,
            RESULT_PREVIEW_CHARS
          )
        : null))
    : null
  const summaryLine = live
    ? latest
    : failed
      ? null
      : previewLine(
          run?.result ?? output ?? m.backgroundLifecycle?.summary,
          RESULT_PREVIEW_CHARS
        )
  const prompt = m.prompt?.trim() || null
  // The prompt on the title line, as one line; on its own it opens the row
  // only when that line cuts it short.
  const promptLine = prompt?.replace(/\s+/g, " ") ?? null
  const { ref: promptRef, truncated: promptCut } =
    useTruncation<HTMLSpanElement>(promptLine)

  // Folded away with its reply, a sub-agent still running stays in view, and
  // so does one the model provider stopped: that is an outcome of the turn.
  if (pinnedOnly && !live && !m.providerError) return null

  // A Pi run that did not simply finish or fail says how it stands: paused,
  // stopped, or launched with no outcome in the transcript.
  const runNote =
    !!run &&
    !live &&
    (run.status === "paused" ||
      run.status === "stopped" ||
      run.status === "pending")
  const runChildren = m.runChildren
  const soleChild = m.soleChild
  const hasExchanges =
    !!soleChild &&
    (soleChild.exchanges.length > 0 || soleChild.attention.length > 0)

  return (
    <>
      <ActivityRow
        stepKey={step.key}
        approval={step.tool.approval}
        status={status}
        marker={
          <RailIcon
            icon={BotIcon}
            status={status}
            label={`${tActivity("kind.agent")}, ${statusText(status)}`}
          />
        }
        expandable={
          (promptLine !== null && (promptCut || open)) ||
          !!m.model ||
          !!m.effort ||
          !!childModel ||
          !!output ||
          failed ||
          launchCaveat ||
          !!m.backgroundLifecycle ||
          !!run ||
          hasExchanges ||
          !!m.providerError
        }
        expanded={open}
        onExpandedChange={setOpen}
        title={m.title}
        trailing={
          runNote ? (
            <span
              className={cn(run.status === "paused" && "text-tone-warning")}
            >
              {m.statusLabel}
            </span>
          ) : failed ? (
            m.backgroundFailed && m.backgroundLifecycle?.status ? (
              <span className="text-tone-danger">
                {m.backgroundLifecycle.status}
              </span>
            ) : (
              <StatusFigure status="failed" />
            )
          ) : live ? (
            m.isLiveBackgroundLaunch || m.outcomeBackground ? (
              tBg("cardRunning")
            ) : clock ? (
              <span aria-hidden="true">{clock}</span>
            ) : null
          ) : m.isCodexSubagent ? (
            // Never a quiet "done" for a launch codex has not reported on.
            m.codexSubagentState === "completed" ? (
              tActivity("metric.done")
            ) : codexInterrupted ? (
              <StatusFigure status="cancelled" />
            ) : (
              tActivity("metric.outcomeUnknown")
            )
          ) : m.backgroundLifecycle && !m.backgroundSettled ? (
            // Launched; its result has not come back yet.
            tActivity("metric.launched")
          ) : m.backgroundLifecycle?.interim ? (
            // It said it will report again: what it sent is not final.
            tActivity("metric.interim")
          ) : (
            m.durationSuffix
          )
        }
        addon={
          <ProgressLine
            progress={progress}
            working={live}
            summary={summaryLine}
            summaryLive={live}
            onOpenSession={m.openChildSession}
          />
        }
        detail={() => (
          <div className="space-y-2">
            {m.model || m.effort ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {m.model ? (
                  <span>
                    {t("agentModelLabel")}:{" "}
                    <span className="font-mono">{m.model}</span>
                  </span>
                ) : null}
                {m.effort ? (
                  <span>
                    {t("agentEffortLabel")}:{" "}
                    <span className="font-mono">{m.effort}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
            {prompt ? (
              <DetailBox tone="neutral">
                <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3 text-sm [&_ol]:list-inside [&_ul]:list-inside">
                  <MessageResponse>{prompt}</MessageResponse>
                </div>
              </DetailBox>
            ) : null}
            {/* Pi run: one row per child when there are several; the single
                child's questions and alerts otherwise (its session is the
                row's own "Open conversation", as for any one-child agent). */}
            {runChildren.length > 1 ? (
              <SubagentRunChildren
                items={runChildren}
                onOpenSession={m.openRunChildSession}
              />
            ) : null}
            {hasExchanges && soleChild ? (
              <SubagentExchanges
                exchanges={soleChild.exchanges}
                attention={soleChild.attention}
              />
            ) : null}
            {childModel
              ? renderNested(childModel, m.isRunning, {
                  working: m.isRunning,
                  what:
                    childModel.summary.steps > 0
                      ? tActivity("header.steps", {
                          count: childModel.summary.steps,
                        })
                      : tActivity("kind.agent"),
                  onFold: (control) => foldRow(control, () => setOpen(false)),
                })
              : null}
            {launchCaveat ? (
              <p className="text-xs text-muted-foreground">
                {t("agentCodexLaunchOnly")}
              </p>
            ) : null}
            {/* Stopped at the model provider: one compact line, the
                provider's link, and its message under "Details" — in place
                of every result section below, which would otherwise print
                that message as a reply. */}
            {m.providerError ? (
              <ProviderErrorNotice error={m.providerError} scope="subagent" />
            ) : null}
            {/* Pi run outcome: the run's own error and result, in place of
                the plain-text report the result carries. */}
            {run ? (
              <SubagentRunOutcome
                run={run}
                pendingLabel={tBg("cardResultPending")}
              />
            ) : null}
            {m.isError && step.part.errorText && !m.providerError && !run ? (
              <DetailBox tone="danger" anchor="end">
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                  {unwrapWholeFence(step.part.errorText)}
                </pre>
              </DetailBox>
            ) : null}
            {m.isError &&
            m.agentStats?.status === "completed" &&
            m.agentStats.recovered_result ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t("agentRecoveredNote")}
                </p>
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <MessageResponse>
                    {m.agentStats.recovered_result}
                  </MessageResponse>
                </div>
              </div>
            ) : null}
            {m.outcomeError && !m.isError && !m.providerError ? (
              <DetailBox tone="danger">
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                  {m.outcomeError}
                </pre>
              </DetailBox>
            ) : null}
            {m.backgroundLifecycle &&
            !m.isError &&
            !m.providerError &&
            !m.backgroundSettled ? (
              <p className="text-xs text-muted-foreground">
                {tBg("cardResultPending")}
              </p>
            ) : null}
            {/* What its notification said about how it ended — for an interim
                result, why it is not final. */}
            {m.backgroundLifecycle?.summary &&
            !m.isError &&
            !m.providerError ? (
              <p dir="auto" className="text-xs text-muted-foreground">
                {m.backgroundLifecycle.summary}
              </p>
            ) : null}
            {output && !m.isError ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ol]:list-inside [&_ul]:list-inside">
                <MessageResponse>{output}</MessageResponse>
              </div>
            ) : null}
          </div>
        )}
      >
        {/* The type and description are its title, the grey prompt after
            them what it was handed — in whatever room the title leaves (it
            is all in the panel); nothing runs past the line's end. */}
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          {m.subagentType ? (
            <>
              <span className="shrink-0 font-semibold text-foreground">
                {m.subagentType}
              </span>
              {m.description ? (
                <span className="min-w-0 truncate text-foreground" dir="auto">
                  {m.description}
                </span>
              ) : null}
            </>
          ) : (
            <span
              dir="auto"
              className={cn(
                "min-w-0 truncate font-semibold",
                live && !m.description ? "activity-shimmer" : "text-foreground"
              )}
            >
              {m.title}
            </span>
          )}
          {m.agentId ? (
            <span
              className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
              dir="ltr"
            >
              #{shortAgentId(m.agentId)}
            </span>
          ) : null}
          {/* A Pi run with several children says how many. */}
          {runChildren.length > 1 ? (
            <span className="shrink-0 text-activity-secondary">
              {tRun("children", { count: runChildren.length })}
            </span>
          ) : null}
          {promptLine ? (
            <span
              ref={promptRef}
              dir="auto"
              className="min-w-0 flex-1 truncate text-activity-secondary"
            >
              {promptLine}
            </span>
          ) : null}
        </span>
      </ActivityRow>
      {m.childSession && m.viewerHost == null && m.sessionOpen ? (
        <SubagentSessionDialog
          open={m.sessionOpen}
          onOpenChange={m.setSessionOpen}
          sessionId={m.childSession.sessionId}
          agentType={m.childSession.agentType}
          subagentType={m.subagentType}
          description={m.description}
          live={m.isRunning || m.isLiveBackgroundLaunch || m.runRunning}
        />
      ) : null}
      {m.openRunChild?.sessionId && m.viewerHost == null ? (
        <SubagentSessionDialog
          open
          onOpenChange={(next) => {
            if (!next) m.setOpenRunChild(null)
          }}
          sessionId={m.openRunChild.sessionId}
          agentType={m.runChildAgentType}
          subagentType={m.openRunChild.agent}
          description={m.openRunChild.label}
          live={m.openRunChild.status === "running"}
        />
      ) : null}
    </>
  )
})

/**
 * A Pi run's own outcome: its error (first line, the rest on demand), its
 * result, or — for a background run whose end never reached the transcript —
 * a note that there is none; then the text the model was given, behind a
 * toggle.
 */
function SubagentRunOutcome({
  run,
  pendingLabel,
}: {
  run: SubagentRun
  pendingLabel: string
}) {
  const tRun = useTranslations("Folder.chat.contentParts.agentRun")
  const [errorOpen, setErrorOpen] = useState(false)
  const errorHead = run.error ? firstLine(run.error) : null
  const errorHasMore = Boolean(run.error && run.error.trim() !== errorHead)

  return (
    <div className="space-y-2">
      {run.error ? (
        <DetailBox tone="danger">
          <div className="flex items-start gap-2 px-4 py-3 text-xs text-tone-danger">
            <span
              dir={detectTextDirection(run.error)}
              className="min-w-0 flex-1 whitespace-pre-wrap break-words"
            >
              {errorOpen ? run.error : errorHead}
            </span>
            {errorHasMore ? (
              <button
                type="button"
                onClick={() => setErrorOpen((open) => !open)}
                className="shrink-0 font-medium underline-offset-2 hover:underline"
              >
                {errorOpen ? tRun("less") : tRun("more")}
              </button>
            ) : null}
          </div>
        </DetailBox>
      ) : null}
      {run.result ? (
        <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ol]:list-inside [&_ul]:list-inside">
          <MessageResponse>{run.result}</MessageResponse>
        </div>
      ) : null}
      {!run.error && !run.result && run.status === "pending" ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" />
          {pendingLabel}
        </p>
      ) : null}
      <ModelNotesToggle notes={run.notes} />
    </div>
  )
}
