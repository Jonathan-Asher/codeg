"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentSelector } from "@/components/chat/agent-selector"
import { SessionSettingsPicker } from "@/components/chat/session-settings-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import {
  openContinuation,
  writeHandoff,
  writeMechanicalHandoff,
  type ContinuationPicks,
  type HandoffResult,
  type OpenContinuationDeps,
} from "@/lib/continue-in-agent"
import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  buildSessionSettings,
  type SessionSettingTarget,
} from "@/lib/session-settings"
import {
  recommendedSelectorValues,
  resolveDisplayedSelectors,
  withSelectorPicks,
} from "@/lib/selector-display"
import {
  useNewSessionValues,
  useSelectorTemplate,
} from "@/lib/selector-options-cache"
import {
  isSessionOnlyConfigOption,
  useSavedSelectorPrefs,
} from "@/lib/selector-prefs-storage"
import type { AgentType, DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useContinueInAgentStore } from "@/stores/continue-in-agent-store"
import { useTabStore } from "@/stores/tab-store"
import {
  useContinueInAgentBlock,
  useContinueInAgentBlockLabel,
} from "./continue-in-agent-menu-item"

const NO_PICKS: ContinuationPicks = { modeId: null, configValues: {} }

/**
 * The new session's mode / model / effort: the composer's settings chip
 * (`SessionSettingsPicker`) over the option lists this agent's sessions last
 * reported, each on the value a new session of it starts with — as a
 * new-session draft shows them — with the picks made here laid over them.
 * Nothing is saved until the dialog continues.
 */
function ContinuationSelectors({
  agentType,
  picks,
  onPick,
}: {
  agentType: AgentType
  picks: ContinuationPicks
  onPick: (picks: ContinuationPicks) => void
}) {
  const t = useTranslations("ContinueInAgent")
  const tInput = useTranslations("Folder.chat.messageInput")
  const template = useSelectorTemplate(agentType)
  const saved = useSavedSelectorPrefs(agentType, true)
  const newSessionValues = useNewSessionValues(agentType)
  const vocabulary = useAgentVocabulary(agentType)

  const settings = useMemo(() => {
    const shape = template
      ? { modes: template.modes, configOptions: template.configOptions }
      : null
    const shown = withSelectorPicks(
      resolveDisplayedSelectors({
        live: null,
        stored: saved,
        template: shape,
        defaults: [newSessionValues, recommendedSelectorValues(shape)],
      }),
      picks.configValues
    )
    const agentOptions = vocabulary.configOptions(shown.configOptions ?? [])
    // An option whose pick belongs to one session (Grok's permission mode) is
    // not offered: a new session starts in the mode its agent's settings
    // launch it in, so a pick here would not reach it. Its composer switches
    // it once the session is open.
    const configOptions = agentOptions.filter(
      (option) => !isSessionOnlyConfigOption(agentType, option.id)
    )
    const modes = shown.modes
    // As in the composer: the mode list is the agent's selector only when it
    // publishes no config options.
    const showMode =
      agentOptions.length === 0 &&
      modes != null &&
      modes.available_modes.length > 0
    const currentModeId =
      showMode && modes
        ? picks.modeId &&
          modes.available_modes.some((m) => m.id === picks.modeId)
          ? picks.modeId
          : modes.current_mode_id
        : null
    return buildSessionSettings({
      configOptions,
      modes: showMode && modes ? vocabulary.modes(modes.available_modes) : [],
      currentModeId,
      modeTitle: tInput("modeLabel"),
    })
  }, [template, saved, newSessionValues, picks, vocabulary, tInput, agentType])

  const handleChange = useCallback(
    (target: SessionSettingTarget, value: string) => {
      if (target.type === "mode") {
        onPick({ ...picks, modeId: value })
      } else {
        onPick({
          ...picks,
          configValues: { ...picks.configValues, [target.configId]: value },
        })
      }
    },
    [onPick, picks]
  )

  if (settings.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("settingsLater")}</p>
  }
  return (
    <div
      className="flex min-w-0 items-center"
      data-testid="continue-in-agent-selectors"
    >
      <SessionSettingsPicker
        agentType={agentType}
        settings={settings}
        loadingLabel={null}
        onChange={handleChange}
      />
    </div>
  )
}

type Phase =
  | { step: "pick" }
  | { step: "writing" }
  | {
      step: "failed"
      kind: Extract<HandoffResult, { ok: false }>["kind"]
      message: string | null
    }
  | { step: "building" }
  | { step: "build_failed"; message: string }

export interface ContinueInAgentDialogProps {
  conversation: DbConversationSummary
  onClose: () => void
  /** Test seam: what opening the new session goes through. */
  deps?: Partial<OpenContinuationDeps> & {
    requestHandoff?: Parameters<typeof writeHandoff>[1]
    buildMechanical?: Parameters<typeof writeMechanicalHandoff>[1]
  }
}

/**
 * "Continue in another agent…": pick the agent, model and effort of the new
 * session; the old session's agent then writes a handoff (one extra message
 * in it), and a new session opens beside it with the handoff in its composer.
 * When the handoff can't be written, it says why and offers a plain one
 * codeg writes itself, or stopping there.
 */
export function ContinueInAgentDialog({
  conversation,
  onClose,
  deps,
}: ContinueInAgentDialogProps) {
  const t = useTranslations("ContinueInAgent")
  const tCard = useTranslations("Folder.conversationCard")
  const blockLabel = useContinueInAgentBlockLabel()
  const block = useContinueInAgentBlock(conversation.id)
  const { agents } = useAcpAgents()
  const oldAgentLabel = getAgentLabel(conversation.agent_type)
  const title =
    formatConversationTitle(conversation.title ?? "") ||
    tCard("untitledConversation")

  // Another agent by default: the one the person most likely means.
  const firstOther = useMemo(
    () =>
      agents.find(
        (a) =>
          a.enabled && a.available && a.agent_type !== conversation.agent_type
      )?.agent_type ?? null,
    [agents, conversation.agent_type]
  )
  const [chosen, setChosen] = useState<AgentType | null>(null)
  const agentType = chosen ?? firstOther
  const [picksByAgent, setPicksByAgent] = useState<
    Partial<Record<AgentType, ContinuationPicks>>
  >({})
  const picks = (agentType && picksByAgent[agentType]) || NO_PICKS
  const setPicks = useCallback(
    (next: ContinuationPicks) => {
      if (!agentType) return
      setPicksByAgent((prev) => ({ ...prev, [agentType]: next }))
    },
    [agentType]
  )

  const requestHandoff = deps?.requestHandoff
  const buildMechanical = deps?.buildMechanical
  const [phase, setPhase] = useState<Phase>({ step: "pick" })
  // Closed (cancelled) while the handoff was being written: what arrives
  // after is dropped.
  const closedRef = useRef(false)
  useEffect(() => {
    closedRef.current = false
    return () => {
      closedRef.current = true
    }
  }, [])
  const close = useCallback(() => {
    closedRef.current = true
    onClose()
  }, [onClose])

  const finish = useCallback(
    (handoff: string) => {
      if (closedRef.current || !agentType) return
      closedRef.current = true
      onClose()
      openContinuation(
        {
          source: conversation,
          sourceTitle: title,
          sourceAgentLabel: oldAgentLabel,
          agentType,
          picks,
          handoff,
        },
        {
          openNewConversationTab:
            deps?.openNewConversationTab ??
            useTabStore.getState().openNewConversationTab,
          ...(deps?.placement ? { placement: deps.placement } : {}),
          ...(deps?.folderPath ? { folderPath: deps.folderPath } : {}),
          ...(deps?.park ? { park: deps.park } : {}),
          ...(deps?.parkLink ? { parkLink: deps.parkLink } : {}),
          ...(deps?.savePicks ? { savePicks: deps.savePicks } : {}),
          ...(deps?.focusComposer ? { focusComposer: deps.focusComposer } : {}),
        }
      )
    },
    [agentType, conversation, deps, oldAgentLabel, onClose, picks, title]
  )

  const handleContinue = useCallback(async () => {
    if (!agentType || block) return
    setPhase({ step: "writing" })
    const result = await writeHandoff(conversation.id, requestHandoff)
    if (closedRef.current) return
    if (result.ok) {
      finish(result.text)
    } else {
      setPhase({ step: "failed", kind: result.kind, message: result.message })
    }
  }, [agentType, block, conversation.id, requestHandoff, finish])

  const handleWithoutSummary = useCallback(async () => {
    setPhase({ step: "building" })
    try {
      const text = await writeMechanicalHandoff(
        conversation.id,
        buildMechanical
      )
      if (closedRef.current) return
      finish(text)
    } catch (err) {
      if (closedRef.current) return
      setPhase({
        step: "build_failed",
        message:
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : String(err),
      })
    }
  }, [conversation.id, buildMechanical, finish])

  const failureReason = (kind: Extract<Phase, { step: "failed" }>["kind"]) => {
    switch (kind) {
      case "no_session":
        return t("failedNoSession")
      case "busy":
        return t("failedBusy")
      case "connect":
        return t("failedConnect")
      case "stopped":
        return t("failedStopped")
      case "usage_limit":
        return t("failedUsageLimit")
      case "empty":
        return t("failedEmpty")
      case "timed_out":
        return t("failedTimedOut")
      case "request":
        return t("failedRequest")
      default:
        return t("failedError")
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // The new session's composer takes the keyboard once it opens; the
        // menu item that opened this is gone.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { title })}</DialogDescription>
        </DialogHeader>

        {phase.step === "pick" && (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("agentLabel")}
              </span>
              <AgentSelector
                defaultAgentType={agentType ?? undefined}
                onSelect={setChosen}
                onFallback={setChosen}
              />
            </div>
            {agentType && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settingsLabel")}
                </span>
                <ContinuationSelectors
                  key={agentType}
                  agentType={agentType}
                  picks={picks}
                  onPick={setPicks}
                />
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {t("handoffNote", { agent: oldAgentLabel })}
            </p>
            {block && (
              <p className="text-sm text-destructive" role="status">
                {blockLabel(block)}
              </p>
            )}
          </div>
        )}

        {(phase.step === "writing" || phase.step === "building") && (
          <div
            className="flex items-start gap-2 text-sm"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <span>
                {phase.step === "writing"
                  ? t("writing", { agent: oldAgentLabel })
                  : t("building")}
              </span>
              {phase.step === "writing" && (
                <span className="text-xs text-muted-foreground">
                  {t("writingHint")}
                </span>
              )}
            </div>
          </div>
        )}

        {phase.step === "failed" && (
          <div className="flex flex-col gap-1.5 text-sm" role="alert">
            <span className="font-medium">
              {t("failedTitle", { agent: oldAgentLabel })}{" "}
              {failureReason(phase.kind)}
            </span>
            {phase.message && (
              <span className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {phase.message}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {t("continueWithoutHint")}
            </span>
          </div>
        )}

        {phase.step === "build_failed" && (
          <p className="text-sm text-destructive" role="alert">
            {t("buildFailed", { error: phase.message })}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("cancel")}
          </Button>
          {phase.step === "pick" && (
            <Button
              onClick={() => void handleContinue()}
              disabled={!agentType || block != null}
            >
              {t("continue")}
            </Button>
          )}
          {(phase.step === "failed" || phase.step === "build_failed") && (
            <Button onClick={() => void handleWithoutSummary()}>
              {t("continueWithout")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The window's one "Continue in another agent…" dialog, for whichever
 *  session a menu opened it for. */
export function ContinueInAgentHost() {
  const conversationId = useContinueInAgentStore((s) => s.conversationId)
  const close = useContinueInAgentStore((s) => s.close)
  const conversation = useAppWorkspaceStore((s) =>
    conversationId == null
      ? null
      : (s.conversations.find((c) => c.id === conversationId) ?? null)
  )
  if (conversationId == null || !conversation) return null
  return (
    <ContinueInAgentDialog
      key={conversationId}
      conversation={conversation}
      onClose={close}
    />
  )
}
