"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUp,
  EyeOff,
  ImagePlus,
  Loader2,
  MonitorCloud,
  Square,
  SquarePen,
  SquareArrowOutUpRight,
  X,
} from "lucide-react"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { ComposerImageThumbnails } from "@/components/chat/composer/composer-image-thumbnails"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import {
  useComposerAttachments,
  type UnattachableFiles,
} from "@/components/chat/composer/use-composer-attachments"
import type { ImageInputAttachment } from "@/components/chat/message-input-attachments"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { Button } from "@/components/ui/button"
import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useFeedbackEnabled } from "@/hooks/use-feedback-enabled"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  hideQuickAskWindow,
  openQuickAskConversation,
} from "@/lib/quick-ask/desktop"
import {
  backendKey,
  pickDefaultFolder,
  quickAskConfigValues,
  readActiveFolder,
  readQuickAskPrefs,
  updateQuickAskPrefs,
  withConfigValue,
  type QuickAskPrefs,
  type QuickAskTargetKind,
} from "@/lib/quick-ask/prefs"
import {
  QUICK_ASK_FOCUS_INPUT_EVENT,
  useQuickAskWindowState,
} from "@/lib/quick-ask/window-state"
import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"
import type { AgentType, PromptCapabilitiesInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useQuickAskData } from "../_hooks/use-quick-ask-data"
import {
  useQuickAskSession,
  type QuickAskErrorCode,
  type QuickAskFolderTarget,
  type QuickAskSessionTarget,
} from "../_hooks/use-quick-ask-session"
import {
  AgentModelPicker,
  findEffortOption,
  findModelOption,
  selectChoices,
} from "./AgentModelPicker"
import { QuickAskThread } from "./QuickAskThread"
import { TargetPicker } from "./TargetPicker"

const ERROR_KEYS = {
  no_folder: "errors.noFolder",
  no_session: "errors.noSession",
  connect_failed: "errors.connectFailed",
  send_failed: "errors.sendFailed",
} as const satisfies Record<
  Exclude<QuickAskErrorCode, "images_unsupported">,
  string
>

/** Until the agent is up and has said what it takes, images are accepted:
 *  the send checks again against what the connection reports. */
const ASSUMED_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}

/** How long a "couldn't attach that" hint stays up. */
const ATTACH_HINT_MS = 5000

const TARGET_HINT_KEYS = {
  new: "targetHints.new",
  existing: "targetHints.existing",
  private: "targetHints.private",
} as const satisfies Record<QuickAskTargetKind, string>

/** Most lines the question box grows to before it scrolls. */
const INPUT_MAX_HEIGHT_PX = 132

/** A Radix popover / menu is open: Esc belongs to it, not to the window. */
function overlayOpen(): boolean {
  return document.querySelector("[data-radix-popper-content-wrapper]") !== null
}

export function QuickAskWindow() {
  const t = useTranslations("QuickAsk")
  const remote = useRemoteConnection()
  const remoteId = getActiveRemoteConnectionId()
  const backend = backendKey(remoteId)

  const [prefs, setPrefs] = useState<QuickAskPrefs>(() => readQuickAskPrefs())
  const savePrefs = useCallback(
    (change: (p: QuickAskPrefs) => QuickAskPrefs) => {
      setPrefs(updateQuickAskPrefs(change))
    },
    []
  )

  const data = useQuickAskData()
  const reloadData = data.reload
  const { agents: allAgents } = useAcpAgents()
  const installedAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.enabled && a.available && a.installed_version)
        .map((a) => ({
          agentType: a.agent_type,
          name: getAgentLabel(a.agent_type),
        })),
    [allAgents]
  )

  // ── Selection ────────────────────────────────────────────────────────────
  const target = prefs.target
  const [activeFolderId, setActiveFolderId] = useState(() =>
    readActiveFolder(remoteId)
  )
  const [chosenFolderId, setChosenFolderId] = useState<number | null>(null)
  const folderIds = useMemo(() => data.folders.map((f) => f.id), [data.folders])
  const folderId =
    chosenFolderId != null && folderIds.includes(chosenFolderId)
      ? chosenFolderId
      : pickDefaultFolder(
          folderIds,
          prefs.folderByBackend[backend],
          activeFolderId
        )
  const [chosenSessionId, setChosenSessionId] = useState<number | null>(null)
  const sessionId = chosenSessionId ?? prefs.sessionByBackend[backend] ?? null

  const folder = useMemo<QuickAskFolderTarget | null>(() => {
    const f = data.folders.find((x) => x.id === folderId)
    return f ? { id: f.id, path: f.path, name: f.alias ?? f.name } : null
  }, [data.folders, folderId])
  const sessionOption = data.sessions.find((s) => s.id === sessionId) ?? null
  const session = useMemo<QuickAskSessionTarget | null>(
    () =>
      sessionOption
        ? {
            id: sessionOption.id,
            folderId: sessionOption.folderId,
            folderPath: sessionOption.folderPath,
            agentType: sessionOption.agentType,
            externalId: sessionOption.externalId,
            title: sessionOption.title,
          }
        : null,
    [sessionOption]
  )

  // Quick Ask's own agent pick, if that agent is still installed.
  const agentType: AgentType = useMemo(() => {
    if (installedAgents.length === 0) return prefs.agent
    return installedAgents.some((a) => a.agentType === prefs.agent)
      ? prefs.agent
      : (installedAgents.find((a) => a.agentType === "claude_code")
          ?.agentType ?? installedAgents[0].agentType)
  }, [installedAgents, prefs.agent])
  const configValues = useMemo(
    () => quickAskConfigValues(prefs, agentType),
    [prefs, agentType]
  )

  const onFolderUsed = useCallback(
    (id: number) =>
      savePrefs((p) => ({
        ...p,
        folderByBackend: { ...p.folderByBackend, [backend]: id },
      })),
    [backend, savePrefs]
  )
  const onSessionUsed = useCallback(
    (id: number) =>
      savePrefs((p) => ({
        ...p,
        sessionByBackend: { ...p.sessionByBackend, [backend]: id },
      })),
    [backend, savePrefs]
  )

  const steeringEnabled = useFeedbackEnabled()
  const qa = useQuickAskSession({
    target,
    agentType,
    folder,
    session,
    configValues,
    steeringEnabled,
    onFolderUsed,
    onSessionUsed,
  })
  const { conn } = qa
  const bound = qa.binding != null
  const locked = bound || qa.thread.length > 0
  const streaming = bound && conn.status === "prompting"
  const liveAgent = qa.effectiveAgent
  const connOptions = conn.agentType === liveAgent ? conn.configOptions : null

  // A model switch resets effort to that model's own default (Claude Code
  // does). Quick Ask keeps its saved effort instead, once per model, and only
  // when the new model offers it.
  const setLiveConfig = qa.setConfigOption
  const effortOption = findEffortOption(connOptions)
  const modelOption = findModelOption(connOptions)
  const liveEffort =
    effortOption?.kind.type === "select"
      ? effortOption.kind.current_value
      : null
  const liveModel =
    modelOption?.kind.type === "select" ? modelOption.kind.current_value : null
  const wantedEffort = target === "existing" ? undefined : configValues.effort
  const effortOffered =
    wantedEffort != null &&
    selectChoices(effortOption).some((c) => c.value === wantedEffort)
  const effortOptionId = effortOption?.id ?? null
  const enforcedEffortRef = useRef<string | null>(null)
  useEffect(() => {
    if (!effortOptionId || !wantedEffort || !effortOffered) return
    if (liveEffort === wantedEffort) return
    const stamp = `${liveModel ?? ""}:${wantedEffort}`
    if (enforcedEffortRef.current === stamp) return
    enforcedEffortRef.current = stamp
    void setLiveConfig(effortOptionId, wantedEffort).catch(() => {})
  }, [
    effortOffered,
    effortOptionId,
    liveEffort,
    liveModel,
    setLiveConfig,
    wantedEffort,
  ])

  // ── Window state shared with the shell ──────────────────────────────────
  const setHasContent = useQuickAskWindowState((s) => s.setHasContent)
  const pendingRoute = useQuickAskWindowState((s) => s.pendingRoute)
  const hasContent = qa.thread.length > 0
  useEffect(() => {
    setHasContent(hasContent)
  }, [hasContent, setHasContent])

  // ── Input ────────────────────────────────────────────────────────────────
  const [input, setInput] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // ── Images ──────────────────────────────────────────────────────────────
  // The composer's own attachment engine, in its images-only mode: Quick Ask
  // has a plain text box, no editor to hold file badges. Drops land anywhere
  // on the window (the root is the drop target, for browser drops and the
  // desktop's OS drops alike); pastes come from the text box.
  const rootRef = useRef<HTMLDivElement>(null)
  const noEditorRef = useRef<RichComposerHandle | null>(null)
  const capsKnown =
    conn.agentType === liveAgent &&
    (conn.status === "connected" || conn.status === "prompting")
  const liveCaps = conn.promptCapabilities
  const promptCapabilities = useMemo(
    () =>
      capsKnown && liveCaps
        ? { image: liveCaps.image, embedded_context: liveCaps.embedded_context }
        : ASSUMED_PROMPT_CAPABILITIES,
    [capsKnown, liveCaps]
  )
  const [attachHint, setAttachHint] = useState<string | null>(null)
  const onUnattachable = useCallback(
    ({ reason, names }: UnattachableFiles) => {
      const list = names.join(", ")
      setAttachHint(
        reason === "not_image"
          ? t("attach.notImage", { names: list })
          : reason === "images_unsupported"
            ? t("attach.imagesUnsupported", {
                agent: getAgentLabel(liveAgent),
              })
            : t("attach.noFiles")
      )
    },
    [liveAgent, t]
  )
  useEffect(() => {
    if (!attachHint) return
    const timer = setTimeout(() => setAttachHint(null), ATTACH_HINT_MS)
    return () => clearTimeout(timer)
  }, [attachHint])
  const attach = useComposerAttachments({
    editorRef: noEditorRef,
    containerRef: rootRef,
    promptCapabilities,
    attachmentTabId: qa.uploadBucket,
    logLabel: "QuickAsk",
    onUnattachable,
  })
  const images = attach.imageAttachments
  const hasImages = images.length > 0
  const canSend =
    (input.trim().length > 0 || hasImages) &&
    !qa.starting &&
    !attach.hasUploadingImage

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`
  }, [input])

  // Each time the window is shown: focus the question box and refresh what
  // the pickers offer.
  useEffect(() => {
    const onShown = () => {
      inputRef.current?.focus()
      setActiveFolderId(readActiveFolder(remoteId))
      reloadData()
    }
    window.addEventListener(QUICK_ASK_FOCUS_INPUT_EVENT, onShown)
    return () =>
      window.removeEventListener(QUICK_ASK_FOCUS_INPUT_EVENT, onShown)
  }, [reloadData, remoteId])

  // Esc hides the window (desktop); an open picker takes its own Esc first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (overlayOpen()) return
      void hideQuickAskWindow().catch(() => {})
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const prepare = qa.prepare
  // An attached image starts the agent too, like typing does (and gives a
  // private question its scratch space before anything is sent).
  useEffect(() => {
    if (hasImages && !bound) void prepare().catch(() => {})
  }, [bound, hasImages, prepare])

  const onInputChange = (value: string) => {
    const startedTyping = input.trim().length === 0 && value.trim().length > 0
    setInput(value)
    // Start the agent while the question is being typed.
    if (startedTyping && !bound) {
      void prepare().catch(() => {})
    }
  }

  const submit = async () => {
    if (!canSend) return
    const text = input
    const sent: ImageInputAttachment[] = images
    setNotice(null)
    setAttachHint(null)
    setInput("")
    attach.clearAttachments()
    const accepted = await qa.send(text, sent)
    if (!accepted) {
      setInput(text)
      attach.setAttachments((prev) => [...sent, ...prev])
    }
  }

  const newQuestion = async () => {
    const report = await qa.clear()
    setInput("")
    attach.clearAttachments()
    setAttachHint(null)
    reloadData()
    if (report) setNotice(t("private.deleted"))
    if (pendingRoute) {
      window.location.replace(`/${pendingRoute}`)
      return
    }
    inputRef.current?.focus()
  }

  const openInCodeg = async () => {
    const b = qa.binding
    if (!b || b.conversationId == null || b.folderId == null) return
    if (isDesktop()) {
      await openQuickAskConversation({
        remoteConnectionId: remoteId,
        folderId: b.folderId,
        conversationId: b.conversationId,
        agent: b.agentType,
      }).catch((e: unknown) => console.warn("[quick-ask] open failed:", e))
      return
    }
    const params = new URLSearchParams({
      folderId: String(b.folderId),
      conversationId: String(b.conversationId),
      agent: b.agentType,
    })
    window.open(`/workspace?${params.toString()}`, "_blank", "noopener")
  }

  // ── Pickers ──────────────────────────────────────────────────────────────
  const onTargetChange = (next: QuickAskTargetKind) => {
    if (locked) return
    savePrefs((p) => ({ ...p, target: next }))
    reloadData()
  }
  const onFolderChange = (id: number) => {
    setChosenFolderId(id)
    onFolderUsed(id)
  }
  const onSessionChange = (id: number) => {
    setChosenSessionId(id)
    onSessionUsed(id)
  }
  const onAgentChange = (next: AgentType) => {
    if (locked) return
    savePrefs((p) => ({ ...p, agent: next }))
  }
  const onValueChange = (configId: string, valueId: string) => {
    savePrefs((p) => withConfigValue(p, agentType, configId, valueId))
    void qa.setConfigOption(configId, valueId).catch(() => {})
  }

  const canOpenInCodeg =
    qa.binding != null &&
    qa.binding.target !== "private" &&
    qa.binding.conversationId != null

  const showStarting = qa.starting && conn.status !== "prompting"
  const privateNote =
    qa.isPrivate && liveAgent !== "claude_code"
      ? t("private.agentKeepsLog", { agent: getAgentLabel(liveAgent) })
      : null

  const footer = (
    <>
      {conn.pendingPermission && (
        <PermissionDialog
          permission={conn.pendingPermission}
          onRespond={(requestId, optionId) =>
            void conn.respondPermission(requestId, optionId)
          }
          agentType={liveAgent}
        />
      )}
      {conn.pendingAskQuestion &&
        conn.pendingAskQuestion.questions.length > 0 && (
          <AskQuestionCard
            question={conn.pendingAskQuestion}
            onAnswer={(questionId, answer) =>
              conn.answerQuestion(questionId, answer)
            }
          />
        )}
      {showStarting && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("status.connecting", { agent: getAgentLabel(liveAgent) })}
        </div>
      )}
    </>
  )

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col"
      data-testid="quick-ask"
      {...attach.containerDragProps}
    >
      {attach.isDragActive && (
        <div
          className="pointer-events-none absolute inset-1.5 z-50 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-background/90 text-sm font-medium"
          data-testid="qa-drop-overlay"
        >
          <ImagePlus className="size-6 text-primary" aria-hidden="true" />
          {t("attach.dropOverlay")}
        </div>
      )}
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-2.5"
      >
        <TargetPicker
          target={target}
          onTargetChange={onTargetChange}
          folders={data.folders}
          folderId={folderId}
          onFolderChange={onFolderChange}
          sessions={data.sessions}
          sessionId={sessionId}
          onSessionChange={onSessionChange}
          onSessionsOpen={reloadData}
          locked={locked}
        />
        <div className="h-full min-w-2 flex-1" data-tauri-drag-region />
        {remote?.connection && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground"
            data-testid="qa-backend"
          >
            <MonitorCloud className="size-3" aria-hidden="true" />
            {t("backend.remote", { name: remote.connection.name })}
          </span>
        )}
        {isDesktop() && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={t("actions.hide")}
            onClick={() => void hideQuickAskWindow().catch(() => {})}
          >
            <X className="size-4" />
          </Button>
        )}
      </header>

      {pendingRoute && (
        <div className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {t("backend.switchPending")}
        </div>
      )}
      {qa.isPrivate && (
        <div
          className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="qa-private-banner"
        >
          <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {t("private.active")}
            {privateNote ? ` ${privateNote}` : ""}
          </span>
        </div>
      )}

      {qa.thread.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-5">
          <div className="text-sm font-medium">{t("empty.title")}</div>
          <div className="text-xs text-muted-foreground">
            {t(TARGET_HINT_KEYS[target])}
          </div>
          {notice && (
            <div
              className="pt-2 text-xs text-muted-foreground"
              data-testid="qa-notice"
            >
              {notice}
            </div>
          )}
          {installedAgents.length === 0 && !data.loading && (
            <div className="pt-2 text-xs text-destructive">
              {t("errors.noAgents")}
            </div>
          )}
          <div className="pt-1">{footer}</div>
        </div>
      ) : (
        <QuickAskThread
          contextKey={qa.contextKey}
          thread={qa.thread}
          streaming={streaming}
          footer={footer}
        />
      )}

      {qa.error && (
        <div
          className="shrink-0 border-t border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
          role="alert"
          data-testid="qa-error"
        >
          {qa.error.code === "images_unsupported"
            ? t("errors.imagesUnsupported", {
                agent: getAgentLabel(liveAgent),
              })
            : t(ERROR_KEYS[qa.error.code], { error: qa.error.detail ?? "" })}
        </div>
      )}

      <footer className="shrink-0 border-t border-border/60 p-2">
        {attachHint && (
          <div
            className="px-1 pb-1 text-[11px] text-muted-foreground"
            role="status"
            data-testid="qa-attach-hint"
          >
            {attachHint}
          </div>
        )}
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-background/80 px-3 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          {hasImages && (
            <div
              className="flex gap-1.5 overflow-x-auto pt-0.5"
              data-testid="qa-attachments"
            >
              <ComposerImageThumbnails
                attachments={images}
                onRemove={attach.removeAttachment}
              />
            </div>
          )}
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-1.5 size-7 shrink-0 text-muted-foreground"
              aria-label={t("attach.button")}
              title={t("attach.button")}
              onClick={() => void attach.handleUploadLocalFiles()}
              data-testid="qa-attach"
            >
              <ImagePlus className="size-4" />
            </Button>
            <textarea
              ref={inputRef}
              autoFocus
              rows={1}
              value={input}
              placeholder={
                hasContent ? t("input.followUp") : t("input.placeholder")
              }
              onChange={(e) => onInputChange(e.target.value)}
              onPaste={(e) => {
                if (attach.handlePasteFiles(e.nativeEvent)) e.preventDefault()
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault()
                  void submit()
                }
              }}
              className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
              data-testid="qa-input"
            />
            {streaming ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="size-7 shrink-0 rounded-full"
                aria-label={t("input.stop")}
                onClick={() => void qa.cancel().catch(() => {})}
                data-testid="qa-stop"
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="size-7 shrink-0 rounded-full"
                aria-label={t("input.send")}
                disabled={!canSend}
                onClick={() => void submit()}
                data-testid="qa-send"
              >
                {qa.starting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
        <div className="flex h-7 items-center gap-1 pt-1 text-[11px] text-muted-foreground">
          <AgentModelPicker
            agentType={liveAgent}
            agents={installedAgents}
            onAgentChange={onAgentChange}
            agentLocked={locked || target === "existing"}
            configOptions={connOptions}
            savedValues={target === "existing" ? {} : configValues}
            onValueChange={onValueChange}
            readOnly={target === "existing"}
            loading={
              conn.status === "connecting" ||
              (!bound && connOptions == null && installedAgents.length > 0)
            }
            onOpen={() => {
              if (!bound) void prepare().catch(() => {})
            }}
          />
          <span className="min-w-0 flex-1 truncate px-1">
            {hasContent ? null : t("hint")}
          </span>
          {canOpenInCodeg && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("h-6 gap-1 px-2 text-[11px]")}
              onClick={() => void openInCodeg()}
              data-testid="qa-open"
            >
              <SquareArrowOutUpRight className="size-3" />
              {t("actions.openInCodeg")}
            </Button>
          )}
          {hasContent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => void newQuestion()}
              data-testid="qa-new"
            >
              <SquarePen className="size-3" />
              {t("actions.newQuestion")}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}
