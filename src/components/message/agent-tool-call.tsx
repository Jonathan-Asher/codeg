import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { AgentToolCall, AgentType } from "@/lib/types"
import { tryParseJson, extractJsonField } from "./content-parts-renderer"
import { SubagentSessionDialog } from "./subagent-session-dialog"
import { useSessionViewerHost } from "./session-viewer-host"
import { shortAgentId } from "@/lib/collab-tool"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashed,
  Clock3,
  Loader2,
  OctagonX,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentCapsule } from "./agent-capsule"
import { ProviderErrorNotice } from "./provider-error-notice"
import { SubagentSessionButton } from "./subagent-session-button"
import { detectProviderError } from "@/lib/provider-errors"
import {
  isAsyncLaunchAckText,
  parseBackgroundTaskMarker,
} from "@/lib/background-agent"
import {
  firstLine,
  parseSubagentRun,
  type SubagentRun,
  type SubagentRunChild,
} from "@/lib/agent-run-meta"
import { detectTextDirection } from "@/lib/text-direction"
import { ModelNotesToggle } from "./model-notes-toggle"
import { SubagentExchanges, SubagentRunChildren } from "./subagent-run-children"
import { useTranscriptAgentType } from "./transcript-agent-context"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${(sec / 60).toFixed(1)}m`
}

/** Convert AgentToolCall[] to AdaptedContentPart[] for reuse with ToolCallPart */
function adaptToolCalls(
  calls: AgentToolCall[],
  parentId: string
): AdaptedContentPart[] {
  return calls.map(
    (call, i): Extract<AdaptedContentPart, { type: "tool-call" }> => ({
      type: "tool-call",
      toolCallId: `${parentId}-sub-${i}`,
      toolName: call.tool_name,
      input: call.input_preview ?? null,
      state: call.is_error ? "output-error" : "output-available",
      output: call.output_preview ?? null,
      errorText: call.is_error ? (call.output_preview ?? undefined) : undefined,
    })
  )
}

// A parsed JSON field is only usable here if it's a non-empty STRING. Some
// hosts (e.g. CodeBuddy) hand us inputs where `subagent_type` / `description`
// arrive as objects (or empty `{}`); the old `as string` casts let those leak
// straight into the rendered `title`, crashing React with "Objects are not
// valid as a React child". Coerce so a non-string field is treated as absent.
function asText(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

interface TaskOutcomeEnvelope {
  durationMs: number | null
  isBackground: boolean
  error: string | null
}

// Cursor's live task completions carry a bare JSON envelope instead of report
// text: success → {durationMs, isBackground}, failure → {error} — and the
// wire status stays "completed" either way. `isTask` gates folding to inputs
// that prove the call is a Cursor task (the `_toolName:"task"` stamp): another
// agent's sub-agent legitimately returning `{"error":...}` text must render
// as-is, not get repainted as a failure. Shape stays exact-keys on top.
function parseTaskOutcomeEnvelope(
  output: string | null | undefined,
  isTask: boolean
): TaskOutcomeEnvelope | null {
  if (!isTask || !output) return null
  const trimmed = output.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0) return null
  if (
    keys.every((k) => k === "durationMs" || k === "isBackground") &&
    (!("durationMs" in obj) || typeof obj.durationMs === "number") &&
    (!("isBackground" in obj) || typeof obj.isBackground === "boolean")
  ) {
    const duration = obj.durationMs
    return {
      durationMs:
        typeof duration === "number" && Number.isFinite(duration)
          ? duration
          : null,
      isBackground: obj.isBackground === true,
      error: null,
    }
  }
  if (
    keys.length === 1 &&
    keys[0] === "error" &&
    typeof obj.error === "string" &&
    obj.error.length > 0
  ) {
    return { durationMs: null, isBackground: false, error: obj.error }
  }
  return null
}

/** Render bound for the live subagent transcript — the DATA is uncapped;
 *  only the visible tail is limited (entries only split at kind boundaries,
 *  so the count stays small in practice; this is a backstop). */
const AGENT_TRANSCRIPT_RENDER_TAIL = 20

interface GrokSubagentProgress {
  durationMs: number | null
  turnCount: number | null
  toolCallCount: number | null
  contextUsagePct: number | null
}

/**
 * Grok's live sub-agent progress, forwarded by the backend as
 * `meta.grokSubagentProgress` on the launching Agent tool call
 * (`connection.rs::map_grok_subagent_notification`, from grok 0.2.11x's
 * `subagent_progress` ext notification). Grok never streams a child's chunks
 * or tool calls over ACP, so this ticker is the only live signal of what the
 * child is doing. `null` for any other meta shape.
 */
function parseGrokSubagentProgress(
  meta: Record<string, unknown> | null | undefined
): GrokSubagentProgress | null {
  if (!meta || typeof meta !== "object") return null
  const raw = (meta as Record<string, unknown>).grokSubagentProgress
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  const progress: GrokSubagentProgress = {
    durationMs: num(obj.durationMs),
    turnCount: num(obj.turnCount),
    toolCallCount: num(obj.toolCallCount),
    contextUsagePct: num(obj.contextUsagePct),
  }
  return progress.durationMs != null ||
    progress.turnCount != null ||
    progress.toolCallCount != null ||
    progress.contextUsagePct != null
    ? progress
    : null
}

/**
 * The child's own session, when the sub-agent ran as a standalone session on
 * disk. TWO agents do this, and for the same reason: the child is a full
 * session that streams its transcript to disk while none of it is forwarded
 * over ACP, so opening that session is the ONLY way to see the child's work.
 *
 * Grok, live, arrives as `meta.grokSubagentSession.childSessionId`
 * (`connection.rs::grok_subagent_meta`, re-sent on every progress tick because
 * meta is replaced wholesale); in history it comes off the parsed
 * `agent_stats.child_session_id` (`parsers/grok.rs::subagent_stats`).
 *
 * Codex needs neither, because its child's thread id IS its rollout's id and
 * the card already carries it as `agent_id` — the badge and the session key are
 * the same string. Both of its paths already write it
 * (`connection.rs::classify_codex_subagent_activity` live,
 * `parsers/codex.rs::inject_agent_id_into_input` on reload), alongside the
 * launch marker that identifies the producer.
 *
 * Pi is the third producer of `child_session_id` (`parsers/pi/fold.rs`, for a
 * run with one child), so the parsed stats name a session of the transcript's
 * own agent: a parent's child is a session of the parent's kind. The
 * transcript says which (`useTranscriptAgentType`); without one above the
 * card, grok — the producer this was first written for — is assumed. The live
 * grok meta and the codex branch name their agent themselves.
 */
function parseChildSessionId(
  meta: Record<string, unknown> | null | undefined,
  statsChildSessionId: string | null | undefined,
  codexSubagentId: string | null,
  transcriptAgentType: AgentType | null
): { sessionId: string; agentType: AgentType } | null {
  const raw = meta?.grokSubagentSession
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const live = (raw as Record<string, unknown>).childSessionId
    if (typeof live === "string" && live.length > 0) {
      return { sessionId: live, agentType: "grok" }
    }
  }
  if (statsChildSessionId && statsChildSessionId.length > 0) {
    return {
      sessionId: statsChildSessionId,
      agentType: transcriptAgentType ?? "grok",
    }
  }
  return codexSubagentId
    ? { sessionId: codexSubagentId, agentType: "codex" }
    : null
}

/**
 * How the codex sub-agent itself ended, as a pill chip.
 *
 * Separate from the capsule's own status chrome, and deliberately so: the card
 * settles when codex acknowledges the LAUNCH, so its "completed" says nothing
 * about the child, which may still be working. codex reports the real outcome
 * later as `SubAgentActivity{kind}` — live via `settle_codex_subagent_launch`,
 * on reload via the rollout parser — and both write it to the same key.
 *
 * `null` (no outcome heard yet) is a state in its own right, not an absence:
 * the child's fate is genuinely unknown, and saying so is the whole reason this
 * chip exists. That case keeps the full explanation in the body, since a
 * two-word chip cannot carry a caveat.
 */
function CodexSubagentStateBadge({ state }: { state: string | null }) {
  const t = useTranslations("Folder.chat.contentParts")
  const [Icon, label, tone] =
    state === "completed"
      ? ([CheckIcon, t("agentSubagentDone"), "text-green-600"] as const)
      : state === "interrupted"
        ? ([OctagonX, t("agentSubagentInterrupted"), "text-amber-500"] as const)
        : ([
            CircleDashed,
            t("agentSubagentUnknown"),
            "text-muted-foreground/70",
          ] as const)

  return (
    <span className="inline-flex items-center gap-1 text-3xs font-normal text-muted-foreground">
      <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
      {label}
    </span>
  )
}

// ── main component ────────────────────────────────────────────────────

export const AgentToolCallPart = memo(function AgentToolCallPart({
  part,
  renderToolCall,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
  /** Render a single tool-call part — injected by the parent to avoid
   *  circular imports (content-parts-renderer → agent-tool-call → renderer). */
  renderToolCall: (
    part: Extract<AdaptedContentPart, { type: "tool-call" }>,
    key: string
  ) => ReactNode
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const tTool = useTranslations("Folder.chat.tool")
  const tBg = useTranslations("Folder.chat.backgroundTasks")
  const tProvider = useTranslations("Folder.chat.providerError")
  const tRun = useTranslations("Folder.chat.contentParts.agentRun")
  const transcriptAgentType = useTranscriptAgentType()

  const isRunning =
    part.state === "input-available" || part.state === "input-streaming"
  const isError = part.state === "output-error"

  const parsed = useMemo(
    () => (part.input ? tryParseJson(part.input) : null),
    [part.input]
  )

  // A Pi sub-agent run, folded by the parser from the notices its children
  // sent (`parsers/pi/fold.rs`): status, result and one row per child. Takes
  // over from the raw result text, which is a plain-text copy of the same for
  // clients that cannot read it.
  const subagentRun = useMemo(() => parseSubagentRun(part.meta), [part.meta])
  const runChildren = subagentRun?.children ?? NO_RUN_CHILDREN
  const soleChild = runChildren.length === 1 ? runChildren[0] : null

  // Background sub-agent lifecycle. Historical/refetched turns carry the
  // parser's structured marker (settled state + summary + result folded from
  // the transcript's task-notification); a live turn still holds the raw wire
  // ack text, shown as "running in background" instead of being dumped. An
  // unsettled marker (null status) deliberately reads "result pending", not
  // "running" — the transcript alone can't prove the task is still alive.
  const backgroundLifecycle = useMemo(
    () => parseBackgroundTaskMarker(part.output),
    [part.output]
  )
  // Cursor task completion envelope — fold into the capsule chrome (duration
  // suffix / error box / background label) instead of dumping raw JSON into
  // the body. Gated on the live input's `_toolName:"task"` identity stamp.
  const taskOutcome = useMemo(
    () => parseTaskOutcomeEnvelope(part.output, parsed?._toolName === "task"),
    [part.output, parsed]
  )
  const outcomeError = taskOutcome?.error ?? null
  const outcomeBackground = taskOutcome?.isBackground === true
  const isLiveBackgroundLaunch =
    backgroundLifecycle === null &&
    part.state === "output-available" &&
    isAsyncLaunchAckText(part.output)
  const backgroundSettled = backgroundLifecycle?.status != null
  const backgroundFailed =
    backgroundSettled && backgroundLifecycle?.status !== "completed"
  // The sub-agent's request was refused or failed at the model provider
  // (a usage-policy block, a rate limit, …): its "result" is the provider's
  // message, whichever way it arrived — the result text, an error result, a
  // background task's folded result or a task-outcome error. Shown as a
  // compact stopped state on this card instead of as a reply.
  const providerError = useMemo(
    () =>
      detectProviderError(isError ? part.errorText : part.output) ??
      detectProviderError(backgroundLifecycle?.result) ??
      detectProviderError(outcomeError),
    [isError, part.errorText, part.output, backgroundLifecycle, outcomeError]
  )

  const [promptOpen, setPromptOpen] = useState(false)

  const transcriptTail = useMemo(
    () => (part.agentTranscript ?? []).slice(-AGENT_TRANSCRIPT_RENDER_TAIL),
    [part.agentTranscript]
  )

  const subagentType = useMemo(
    () =>
      asText(parsed?.subagent_type) ??
      // Codex's live `spawn_agent` payload labels the agent with `agent_type`
      // instead of `subagent_type` (the historical parser already maps it
      // across). Read both so the prefix shows during streaming too.
      asText(parsed?.agent_type) ??
      // Cursor's live task payload carries `subagentType` as a protobuf-es
      // oneof object ({case: "generalPurpose", …}); its history parser emits
      // a plain snake_case string, so read the live case here for parity.
      asText(parsed?.subagentType) ??
      asText((parsed?.subagentType as { case?: unknown } | undefined)?.case) ??
      (part.input ? extractJsonField(part.input, "subagent_type") : null) ??
      (part.input ? extractJsonField(part.input, "agent_type") : null),
    [parsed, part.input]
  )

  const description = useMemo(
    () =>
      asText(parsed?.description) ??
      (part.input ? extractJsonField(part.input, "description") : null),
    [parsed, part.input]
  )

  const prompt = useMemo(
    () =>
      asText(parsed?.prompt) ??
      (part.input ? extractJsonField(part.input, "prompt") : null) ??
      subagentRun?.task ??
      null,
    [parsed, part.input, subagentRun]
  )

  const model = useMemo(
    () =>
      asText(parsed?.model) ??
      (part.input ? extractJsonField(part.input, "model") : null),
    [parsed, part.input]
  )

  // codex 0.147's native team-of-agents marks its capsules as LAUNCH-only
  // (`CODEX_SUBAGENT_LAUNCH_KEY`, written by both the live path and the rollout
  // parser). The card settles when codex acknowledges the spawn, which is not
  // when the child finishes — an asynchronous child can still be working long
  // after. Say so, rather than let a green "completed" claim the sub-agent is
  // done.
  const isCodexSubagent = parsed?.__codegCodexSubagentLaunch === true

  // …and codex DOES eventually say how the child ended
  // (`SubAgentActivity{kind}`), which both paths stamp here. Present only once
  // that has been heard; while it is absent the child's fate is genuinely
  // unknown, which is what the launch note describes.
  const codexSubagentState = asText(parsed?.__codegCodexSubagentState)

  // codex spawn capsules carry the sub-agent's UUID (`agent_id`); show it in the
  // pill so the execution capsule reads uniformly with the live/wait collab
  // capsules. Other agents (e.g. Claude Task) have no `agent_id` → no badge.
  const agentId = useMemo(
    () =>
      asText(parsed?.agent_id) ??
      (part.input ? extractJsonField(part.input, "agent_id") : null),
    [parsed, part.input]
  )

  const title = useMemo(() => {
    // A run with several children says how many, after the agent they share.
    const children =
      runChildren.length > 1
        ? tRun("children", { count: runChildren.length })
        : null
    if (subagentType) {
      const base = description
        ? `${subagentType}: ${description}`
        : subagentType
      return children ? `${base} · ${children}` : base
    }
    // The sub-agent type hasn't streamed in yet. Prefer the description if it
    // has already arrived, and only fall back to the "starting…" placeholder
    // when there's genuinely nothing to show — never prepend it to a title
    // that already carries real content.
    return description || children || t("agentFallbackTitle")
  }, [subagentType, description, runChildren.length, t, tRun])

  const statusLabel = subagentRun
    ? tRun(RUN_STATUS_LABEL_KEYS[subagentRun.status])
    : providerError
      ? tProvider("subagentStopped", {
          reason: tProvider(`reason.${providerError.kind}`),
        })
      : backgroundLifecycle
        ? backgroundFailed
          ? tBg("cardFinishedWithStatus", {
              status: backgroundLifecycle.status ?? "",
            })
          : backgroundSettled
            ? tBg("cardCompleted")
            : tBg("cardLaunchedPending")
        : isLiveBackgroundLaunch
          ? tBg("cardRunning")
          : outcomeError
            ? // Cursor reports a failed task with wire status "completed"; the
              // error envelope is the only failure signal.
              tTool("status.outputError")
            : outcomeBackground
              ? // A background task's completion envelope only acknowledges the
                // launch — the sub-agent is still running.
                tBg("cardRunning")
              : part.state === "input-available"
                ? tTool("status.inputAvailable")
                : part.state === "input-streaming"
                  ? tTool("status.inputStreaming")
                  : part.state === "output-available"
                    ? tTool("status.outputAvailable")
                    : tTool("status.outputError")

  const agentStats = part.agentStats ?? null
  const adaptedToolCalls = useMemo(
    () => adaptToolCalls(agentStats?.tool_calls ?? [], part.toolCallId),
    [agentStats?.tool_calls, part.toolCallId]
  )

  // Grok live sub-agent ticker — the only live signal of the child's work
  // (grok forwards no child chunks/tool calls). Shown while the child runs:
  // in-turn for a blocking spawn, alongside the "running in background" state
  // for a background one. Frozen values disappear with those states.
  const grokProgress = useMemo(
    () => parseGrokSubagentProgress(part.meta),
    [part.meta]
  )

  // The child's own session, when it has one (grok, codex). Available live —
  // from the spawn notification's meta / id — as well as in history, so a
  // running child can be watched while it works instead of only after it
  // reports back.
  const childSession = useMemo(
    () =>
      parseChildSessionId(
        part.meta,
        agentStats?.child_session_id,
        isCodexSubagent ? agentId : null,
        transcriptAgentType
      ),
    [
      part.meta,
      agentStats?.child_session_id,
      isCodexSubagent,
      agentId,
      transcriptAgentType,
    ]
  )
  const viewerHost = useSessionViewerHost()
  const [sessionOpen, setSessionOpen] = useState(false)
  // A row's child, opened in a drawer this card owns when there is no host.
  const [openRunChild, setOpenRunChild] = useState<SubagentRunChild | null>(
    null
  )
  // Pi is the only producer of run rows, and its children are Pi sessions.
  const runChildAgentType: AgentType = transcriptAgentType ?? "pi"
  const openRunChildSession = useMemo(() => {
    if (!runChildren.some((child) => child.sessionId)) return undefined
    return (child: SubagentRunChild) => {
      if (!child.sessionId) return
      if (viewerHost) {
        viewerHost.open({
          kind: "agentSession",
          sessionId: child.sessionId,
          agentType: runChildAgentType,
          subagentType: child.agent,
          description: child.label,
          live: false,
        })
      } else {
        setOpenRunChild(child)
      }
    }
  }, [runChildren, viewerHost, runChildAgentType])
  const grokProgressLine = useMemo(() => {
    if (!grokProgress) return null
    const pieces: string[] = []
    if (grokProgress.toolCallCount != null) {
      pieces.push(
        t("agentProgressTools", { count: grokProgress.toolCallCount })
      )
    }
    if (grokProgress.turnCount != null) {
      pieces.push(t("agentProgressTurns", { count: grokProgress.turnCount }))
    }
    if (grokProgress.durationMs != null) {
      pieces.push(formatDuration(grokProgress.durationMs))
    }
    if (grokProgress.contextUsagePct != null) {
      pieces.push(
        t("agentProgressContext", {
          pct: Math.round(grokProgress.contextUsagePct),
        })
      )
    }
    return pieces.length > 0 ? pieces.join(" · ") : null
  }, [grokProgress, t])

  const durationSuffix = useMemo(() => {
    if (agentStats?.total_duration_ms) {
      return formatDuration(agentStats.total_duration_ms)
    }
    if (taskOutcome?.durationMs != null) {
      return formatDuration(taskOutcome.durationMs)
    }
    return null
  }, [agentStats, taskOutcome])

  // Opening the child's transcript is capsule-level, not body-level: while it
  // runs (and, for codex, even after) the child's session is the only record of
  // its work, so the entry point must not depend on the capsule having a body
  // to expand. Same handler as the body version it replaces.
  const openChildSession = useMemo(() => {
    if (!childSession) return null
    return () =>
      // Preferred: the transcript-level host, which survives this card
      // scrolling out of the virtual list. Falls back to owning the drawer here
      // when there is no host (this part also renders inside the grok child
      // transcript, which is not virtualized).
      viewerHost
        ? viewerHost.open({
            kind: "agentSession",
            sessionId: childSession.sessionId,
            agentType: childSession.agentType,
            subagentType,
            description,
            // Keep re-reading the child's transcript from disk while its launch
            // call is unsettled or the background child is still out. A snapshot
            // once handed over — see the note on `AgentSessionRequest.live`.
            live: isRunning || isLiveBackgroundLaunch,
          })
        : setSessionOpen(true)
  }, [
    childSession,
    viewerHost,
    subagentType,
    description,
    isRunning,
    isLiveBackgroundLaunch,
  ])

  return (
    <>
      <AgentCapsule
        title={title}
        isRunning={isRunning || isLiveBackgroundLaunch || outcomeBackground}
        isError={
          isError ||
          backgroundFailed ||
          outcomeError != null ||
          providerError != null
        }
        rightSuffix={durationSuffix}
        idBadge={agentId ? shortAgentId(agentId) : null}
        // codex only: the launch capsule's own state describes the spawn, so the
        // child's outcome needs a chip of its own. Held back while the spawn is
        // still in flight — there is nothing to report yet.
        stateBadge={
          isCodexSubagent && !isRunning ? (
            <CodexSubagentStateBadge state={codexSubagentState} />
          ) : null
        }
        headerAction={
          openChildSession ? (
            <SubagentSessionButton onClick={openChildSession} />
          ) : null
        }
        statusLabel={statusLabel}
      >
        {/* Model summary */}
        {model && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("agentModelLabel")}: <span className="font-mono">{model}</span>
            </span>
          </div>
        )}

        {/* Collapsible prompt */}
        {prompt && (
          <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <ChevronRightIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 transition-transform",
                  promptOpen && "rotate-90"
                )}
              />
              {t("agentPromptLabel")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{prompt}</MessageResponse>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Pi run: one row per child when there are several; the single
          child's questions and alerts otherwise (its session is the header
          action, as for any one-child Agent card). */}
        {runChildren.length > 1 && (
          <SubagentRunChildren
            items={runChildren}
            onOpenSession={openRunChildSession}
          />
        )}
        {soleChild &&
          (soleChild.exchanges.length > 0 ||
            soleChild.attention.length > 0) && (
            <SubagentExchanges
              exchanges={soleChild.exchanges}
              attention={soleChild.attention}
            />
          )}

        {/* Subagent tool calls — rendered with the same ToolCallPart
      as the outer conversation for consistent appearance */}
        {adaptedToolCalls.length > 0 && (
          <div className="space-y-2">
            {adaptedToolCalls.map((tc, i) =>
              renderToolCall(
                tc as Extract<AdaptedContentPart, { type: "tool-call" }>,
                `subagent-tc-${i}`
              )
            )}
          </div>
        )}

        {/* Live subagent transcript (claude-agent-acp ≥0.63) — streaming
          text/thinking attributed to this Agent call. LIVE-only by
          construction: the store stops attaching it at settle and promotion
          never carries it, so this section disappears when the real result
          takes over below. Render is tail-bounded; the data is not. */}
        {isRunning && transcriptTail.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("agentLiveTranscript")}
            </div>
            {transcriptTail.map((entry, i) =>
              entry.type === "thinking" ? (
                entry.text.trim() ? (
                  <div
                    key={i}
                    dir={detectTextDirection(entry.text)}
                    className="whitespace-pre-wrap text-xs italic text-muted-foreground/80"
                  >
                    {entry.text}
                  </div>
                ) : null
              ) : (
                <div
                  key={i}
                  className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside"
                >
                  <MessageResponse>{entry.text}</MessageResponse>
                </div>
              )
            )}
          </div>
        )}

        {/* Running indicator (in-turn streaming, a live background launch whose
          ack just replaced the stream, or a cursor background-task envelope) */}
        {((isRunning && !part.output) ||
          isLiveBackgroundLaunch ||
          outcomeBackground) && (
          <div className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <Shimmer
              className="text-sm"
              duration={1}
              shineColor="var(--primary)"
            >
              {isLiveBackgroundLaunch || outcomeBackground
                ? tBg("cardRunning")
                : t("agentRunning")}
            </Shimmer>
          </div>
        )}

        {/* codex native sub-agent whose outcome codex has NOT reported. The chip
          can only say "unknown"; the caveat behind it needs a sentence, because
          the card would otherwise read as "the sub-agent finished" when all
          that finished was the launch. Settled outcomes say it in the chip
          instead and add nothing here — which is what lets a live capsule with
          no result collapse to a bare pill rather than an empty frame. */}
        {isCodexSubagent && !isRunning && codexSubagentState === null && (
          <div className="text-xs text-muted-foreground">
            {t("agentCodexLaunchOnly")}
          </div>
        )}

        {/* Grok live sub-agent ticker (`subagent_progress`) — only while the
          child is still running; the settled card renders stats/result. */}
        {(isRunning || isLiveBackgroundLaunch) && grokProgressLine && (
          <div className="text-xs text-muted-foreground">
            {grokProgressLine}
          </div>
        )}

        {/* Stopped at the model provider: one compact line, the provider's
          link, and its message under "Details" — in place of every result
          section below, which would otherwise print that message as a reply. */}
        {providerError && (
          <ProviderErrorNotice error={providerError} scope="subagent" />
        )}

        {/* Pi run outcome: the run's own error and result, in place of the
          plain-text report the result carries. */}
        {subagentRun && (
          <SubagentRunOutcome
            run={subagentRun}
            pendingLabel={tBg("cardResultPending")}
          />
        )}

        {/* Error output */}
        {isError && part.errorText && !providerError && !subagentRun && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {part.errorText}
            </pre>
          </div>
        )}

        {/* Cursor task failure envelope ({error}) — the wire marks the call
          "completed", so this renders where the error styling belongs. */}
        {outcomeError && !isError && !providerError && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {outcomeError}
            </pre>
          </div>
        )}

        {/* Background lifecycle: settled summary + folded result markdown, or a
          neutral "result pending" line for an unsettled launch. Never dumps
          the marker/ack text. */}
        {backgroundLifecycle && !isError && !providerError && (
          <div className="space-y-2">
            {backgroundLifecycle.summary && (
              <div className="text-xs text-muted-foreground">
                {backgroundLifecycle.summary}
              </div>
            )}
            {backgroundLifecycle.result ? (
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{backgroundLifecycle.result}</MessageResponse>
              </div>
            ) : !backgroundSettled ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="size-3.5 shrink-0" />
                {tBg("cardResultPending")}
              </div>
            ) : null}
          </div>
        )}

        {/* Final output. A folded task-outcome envelope renders via the
          capsule chrome above (duration suffix / error box), never as body. */}
        {part.output &&
          !isError &&
          !providerError &&
          !taskOutcome &&
          !backgroundLifecycle &&
          !isLiveBackgroundLaunch &&
          !subagentRun && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{part.output}</MessageResponse>
            </div>
          )}
      </AgentCapsule>

      {/* The drawer the header action opens when this card has to own it (no
          `SessionViewerHost` above — see `openChildSession`). A SIBLING of the
          capsule, never one of its children: the capsule counts its children to
          decide whether it has a body, so mounting the drawer inside would grow
          a chevron and a bordered frame the moment the drawer opened — and a
          bodyless capsule never renders its children at all, which is exactly
          the live case this drawer exists for. */}
      {childSession && viewerHost == null && sessionOpen && (
        <SubagentSessionDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          sessionId={childSession.sessionId}
          agentType={childSession.agentType}
          subagentType={subagentType}
          description={description}
          live={isRunning || isLiveBackgroundLaunch}
        />
      )}
      {openRunChild?.sessionId && viewerHost == null && (
        <SubagentSessionDialog
          open
          onOpenChange={(open) => {
            if (!open) setOpenRunChild(null)
          }}
          sessionId={openRunChild.sessionId}
          agentType={runChildAgentType}
          subagentType={openRunChild.agent}
          description={openRunChild.label}
        />
      )}
    </>
  )
})

const NO_RUN_CHILDREN: SubagentRunChild[] = []

const RUN_STATUS_LABEL_KEYS = {
  completed: "statusCompleted",
  failed: "statusFailed",
  paused: "statusPaused",
  stopped: "statusStopped",
  running: "statusRunning",
  pending: "statusPending",
} as const satisfies Record<SubagentRun["status"], string>

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
      {run.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          <div className="flex items-start gap-2">
            <span
              dir={detectTextDirection(run.error)}
              className="min-w-0 flex-1 whitespace-pre-wrap break-words"
            >
              {errorOpen ? run.error : errorHead}
            </span>
            {errorHasMore && (
              <button
                type="button"
                onClick={() => setErrorOpen((open) => !open)}
                className="shrink-0 font-medium underline-offset-2 hover:underline"
              >
                {errorOpen ? tRun("less") : tRun("more")}
              </button>
            )}
          </div>
        </div>
      )}
      {run.result && (
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
          <MessageResponse>{run.result}</MessageResponse>
        </div>
      )}
      {!run.error && !run.result && run.status === "pending" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" />
          {pendingLabel}
        </div>
      )}
      <ModelNotesToggle notes={run.notes} />
    </div>
  )
}
