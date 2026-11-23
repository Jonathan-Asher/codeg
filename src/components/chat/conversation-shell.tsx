import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import { useMemo, useRef, type ReactNode } from "react"
import type {
  AgentType,
  ConnectionStatus,
  PendingPlanApprovalState,
  PendingQuestionState,
  PlanApprovalAnswer,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
  PromptSuggestionInfo,
  QuestionAnswer,
  SessionConfigOptionInfo,
  SessionFailureRecord,
  SessionModeInfo,
  AvailableCommandInfo,
  RemoteControlInfo,
} from "@/lib/types"
import { ComposerStatusStrips } from "@/components/chat/composer-status-strips"
import { RemoteControlStrip } from "@/components/chat/remote-control-strip"
import type {
  PendingPermission,
  PendingQuestion,
  ClaudeApiRetryState,
} from "@/contexts/acp-connections-context"
import type { QueuedMessage, RequeueOptions } from "@/hooks/use-message-queue"
import type { QueueNotice } from "@/components/chat/message-queue-display"
import { ChatInput } from "@/components/chat/chat-input"
import { ChatWidthHandles } from "@/components/chat/chat-width-handles"
import { chatGutterStyle } from "@/lib/chat-content-width"
import { cn } from "@/lib/utils"
import type {
  ComposerInjectContent,
  ContinueBeforeReady,
} from "@/components/chat/message-input"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { QuestionDialog } from "@/components/chat/question-dialog"
import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import type { PromptCardDock } from "@/hooks/use-prompt-card-resize"
import type { SideQuestionController } from "@/hooks/use-side-question"
import { MarkdownImageProvider } from "@/components/ai-elements/markdown-local-image"

interface ConversationShellProps {
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  agentName?: string
  /** The in-flight retry line under the composer (see
   *  `ComposerStatusStrips`). The session's errors are notifications, raised by
   *  the connections provider — none is drawn here. */
  claudeApiRetry: ClaudeApiRetryState | null
  /** AIR typed session failures for this connection (active + resolved); the
   *  dock draws only the in-flight retry incidents. Omit/empty renders
   *  nothing. */
  sessionFailures?: SessionFailureRecord[]
  /** Closes an incident strip, taking every record it stands for. Passed for
   *  every surface with a live store — dismissing is client-local, so viewers
   *  get it too. */
  onSessionFailureDismiss?: (ids: string[]) => void
  /** Claude Code's Remote Control while it is on; its strip shows the
   *  session's link and QR code. Omit/`null` renders nothing. */
  remoteControl?: RemoteControlInfo | null
  /** Turns Remote Control off (sends `/remote-control off`). Omitted for
   *  surfaces without a connection of their own — the button is then hidden. */
  onRemoteControlOff?: () => void
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  /** Awaiting-answer multiple-choice `ask_user_question`. */
  pendingAskQuestion: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval. */
  pendingPlanApproval: PendingPlanApprovalState | null
  onFocus: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  onRespondPermission: (requestId: string, optionId: string) => void
  onAnswerQuestion: (answer: string) => void
  onAnswerAskQuestion: (
    questionId: string,
    answer: QuestionAnswer
  ) => void | Promise<void>
  onAnswerPlanApproval: (
    approvalId: string,
    answer: PlanApprovalAnswer
  ) => void | Promise<void>
  children: ReactNode
  modes?: SessionModeInfo[]
  configOptions?: SessionConfigOptionInfo[]
  modeLoading?: boolean
  configOptionsLoading?: boolean
  selectorsLoading?: boolean
  /** Pass-through: see `MessageInput.selectorsAwaitConnection`. */
  selectorsAwaitConnection?: boolean
  selectedModeId?: string | null
  onModeChange?: (modeId: string) => void
  onConfigOptionChange?: (configId: string, valueId: string) => void
  agentType?: AgentType | null
  availableCommands?: AvailableCommandInfo[] | null
  attachmentTabId?: string | null
  /** Pass-through: see `MessageInput`. */
  folderPickerOverride?: ConversationFolderPickerOverride
  draftStorageKey?: string | null
  /** Pass-through: see `MessageInput.getSentHistory`. */
  getSentHistory?: () => string[]
  hideInput?: boolean
  /** Optional banner rendered in the composer dock, where the input sits.
   *  Used with `hideInput` to explain WHY the composer is unavailable (e.g.
   *  the agent failed to load this session) without hijacking the message
   *  area above. Renders nothing when omitted. */
  composerBanner?: ReactNode
  /** Talk on this Mac's dock (`TalkDock`), above the composer while this
   *  window talks with the conversation; renders nothing otherwise. */
  talkDock?: ReactNode
  /** Optional read-only live-feedback notes list rendered just above the
   *  composer (see `FeedbackNotesDisplay`). Renders nothing when there are no
   *  notes for the current turn. */
  feedbackList?: ReactNode
  /** Open the live-feedback dialog from the composer "+" menu (hidden when
   *  omitted / feature off). */
  onAddFeedback?: () => void
  /** Grey out the live-feedback "+" entry when a note can't be sent right now. */
  feedbackAddDisabled?: boolean
  isActive?: boolean
  /** Show the composer's flowing active-session border (tiled multi-session
   *  active tab only). Threaded straight through to the composer. */
  showActiveFlow?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: RequeueOptions
  ) => void
  /** Pass-through: see `ChatInput.awaitingBackground`. */
  awaitingBackground?: boolean
  /** Pass-through: see `ChatInput.backgroundTaskCount`. */
  backgroundTaskCount?: number
  /** Pass-through: see `MessageInput.heldTurnReady`. */
  heldTurnReady?: boolean
  /** Pass-through: see `MessageInput.onDeliverNow`. */
  onDeliverNow?: (
    text: string,
    blocks?: PromptInputBlock[],
    clientId?: string
  ) => Promise<void>
  /** Pass-through: see `MessageInput.canContinue`. */
  canContinue?: boolean
  /** Pass-through: see `MessageInput.continueBeforeReady`. */
  continueBeforeReady?: ContinueBeforeReady | null
  /** Why the queue is held, shown above it (see `QueueNotice`). */
  queueNotice?: QueueNotice | null
  /** Pass-through: see `ChatInputProps.connectingReason`. */
  connectingReason?: string | null
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  /** Pass-through: see `ChatInput.onQueueRetry`. */
  onQueueRetry?: (id: string) => void
  /** Insert one queued item into the RUNNING turn over the session's
   *  live-feedback channel; threaded straight through to the composer's
   *  queue list. See `ChatInputProps.onQueueSteer`. */
  onQueueSteer?: (id: string) => Promise<void> | void
  editingItemId?: string | null
  editingDraftText?: string | null
  editingDraftBlocks?: PromptInputBlock[] | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
  /** Send the draft into the RUNNING turn over the session's live-feedback
   *  channel. Present only for sessions with a working delivery channel;
   *  threaded straight through to the composer. `blocks` carries the full
   *  draft when it holds more than plain text (image attachments, file
   *  badges); `text` stays the recorded/display form. Must stay in sync with
   *  `MessageInputProps.onSteer` — the optional second parameter makes a
   *  stale one-arg declaration here assignable, so tsc would NOT catch a
   *  wrapper that silently drops the blocks. */
  onSteer?: (
    text: string,
    blocks?: PromptInputBlock[],
    clientId?: string
  ) => Promise<void>
  /** Which channel `onSteer` rides (picks the composer's honest copy);
   *  threaded straight through. See `MessageInput`. */
  steerChannel?: "native" | "pull"
  /** Optional banner pinned to the top of the panel, above the message area
   *  (e.g. the "restart to apply" config-stale banner). Renders nothing when
   *  omitted. */
  topBanner?: ReactNode
  /** Content pushed into the docked composer from outside it — currently a
   *  quoted transcript selection. Cleared by the host via `onInjectConsumed`
   *  once the composer has taken it. */
  injectContent?: ComposerInjectContent | null
  onInjectConsumed?: () => void
  /** Pass-through: see `MessageInput.composerBridgeKey`. */
  composerBridgeKey?: string
  /** Pass-through: see `ChatInputProps.sideQuestion`. */
  sideQuestion?: SideQuestionController | null
  /** Pass-through: see `MessageInput.promptSuggestion`. */
  promptSuggestion?: PromptSuggestionInfo | null
  onPromptSuggestionShown?: (id: number) => void
  onPromptSuggestionAccepted?: (id: number) => void
  /** Give the chat column drag handles on its edges (`ChatWidthHandles`) and
   *  the window-edge gutter they need. Only for the conversation tab: a canvas
   *  card renders this shell inside the board's zoom transform, where the
   *  handles' layout maths would be off by the zoom factor, and a card has no
   *  window edge to keep clear. */
  resizableWidth?: boolean
}

export function ConversationShell({
  status,
  promptCapabilities,
  defaultPath,
  agentName,
  claudeApiRetry,
  sessionFailures,
  onSessionFailureDismiss,
  remoteControl,
  onRemoteControlOff,
  pendingPermission,
  pendingQuestion,
  pendingAskQuestion,
  pendingPlanApproval,
  onFocus,
  onSend,
  onCancel,
  onRespondPermission,
  onAnswerQuestion,
  onAnswerAskQuestion,
  onAnswerPlanApproval,
  children,
  modes,
  configOptions,
  modeLoading = false,
  configOptionsLoading = false,
  selectorsLoading = false,
  selectorsAwaitConnection = false,
  selectedModeId,
  onModeChange,
  onConfigOptionChange,
  agentType,
  availableCommands,
  attachmentTabId,
  folderPickerOverride,
  draftStorageKey,
  getSentHistory,
  hideInput = false,
  composerBanner,
  talkDock,
  feedbackList,
  onAddFeedback,
  feedbackAddDisabled,
  isActive,
  showActiveFlow,
  queue,
  onEnqueue,
  awaitingBackground,
  backgroundTaskCount,
  heldTurnReady,
  onDeliverNow,
  canContinue,
  continueBeforeReady,
  queueNotice,
  connectingReason,
  onQueueReorder,
  onQueueEdit,
  onQueueDelete,
  onQueueRetry,
  onQueueSteer,
  editingItemId,
  editingDraftText,
  editingDraftBlocks,
  isEditingQueueItem,
  onSaveQueueEdit,
  onCancelQueueEdit,
  onSteer,
  steerChannel,
  topBanner,
  injectContent,
  onInjectConsumed,
  composerBridgeKey,
  sideQuestion,
  promptSuggestion,
  onPromptSuggestionShown,
  onPromptSuggestionAccepted,
  resizableWidth = false,
}: ConversationShellProps) {
  // The blocking cards below the thread grow upwards into it, and only by
  // what it can spare (see `usePromptCardResize`).
  const threadRef = useRef<HTMLDivElement>(null)
  const dock = useMemo<PromptCardDock>(
    () => ({ roomRef: threadRef, edge: "top" }),
    []
  )
  return (
    // The composer scope: the blocking cards below hand the keyboard to this
    // conversation's composer (Esc) and take it from there (↑ when empty).
    // The gutter keeps the chat column (transcript and composer alike) off
    // the window edge, so its width handles stay grabbable at any width.
    <div
      className="relative flex h-full min-h-0 flex-col"
      style={resizableWidth ? chatGutterStyle : undefined}
      data-composer-scope=""
    >
      {topBanner}

      {/* Above the transcript, not down in the composer dock: Remote Control
          is the session's standing state, and pinning it here keeps it still
          while the messages scroll under it. The dock below is for things that
          come and go with the turn or the connection
          (`ComposerStatusStrips`). Work running past a turn — background
          tasks, sub-agents, delegations — is the transcript's live activity
          row's "N running" (`MessageListView`'s `liveRuns`). */}
      {remoteControl && (
        <RemoteControlStrip
          remoteControl={remoteControl}
          onTurnOff={onRemoteControlOff}
          canTurnOff={status === "connected"}
        />
      )}

      {/* The transcript: focus left here is nobody typing, and a window
          coming back moves it to the composer (see `lib/composer-focus`). */}
      <div
        ref={threadRef}
        className={cn("flex-1 min-h-0", resizableWidth && "relative")}
        data-composer-thread=""
      >
        {children}
        {resizableWidth && <ChatWidthHandles />}
      </div>

      {/* Below the transcript, so outside its image scope: a request or a
          plan names local images the way a reply does, against the same
          folder. */}
      <MarkdownImageProvider rootPath={defaultPath ?? null}>
        <PermissionDialog
          permission={pendingPermission}
          onRespond={onRespondPermission}
          agentType={agentType}
          autoFocus={isActive ?? true}
          dock={dock}
        />
      </MarkdownImageProvider>

      <QuestionDialog
        question={pendingQuestion}
        onAnswer={onAnswerQuestion}
        autoFocus={isActive ?? true}
      />

      {/* Composer dock. The ask-question card sits in normal flow just above the
          feedback list and input — like the permission/question dialogs — so it
          shrinks the message list instead of covering it, while staying aligned
          to the input width. */}
      <div>
        {pendingAskQuestion && pendingAskQuestion.questions.length > 0 && (
          <div className="mx-auto w-full chat-content-w px-4">
            <AskQuestionCard
              question={pendingAskQuestion}
              onAnswer={onAnswerAskQuestion}
              autoFocus={isActive ?? true}
              dock={dock}
            />
          </div>
        )}
        {pendingPlanApproval && (
          <div className="mx-auto w-full chat-content-w px-4">
            {/* key on approval_id so the card always remounts (fresh in-flight /
                feedback state) if the slot is ever reused for a new approval. */}
            <MarkdownImageProvider rootPath={defaultPath ?? null}>
              <PlanApprovalCard
                key={pendingPlanApproval.approval_id}
                approval={pendingPlanApproval}
                onAnswer={onAnswerPlanApproval}
                autoFocus={isActive ?? true}
                dock={dock}
              />
            </MarkdownImageProvider>
          </div>
        )}

        {composerBanner && (
          <div className="mx-auto w-full chat-content-w px-4 pb-2">
            {composerBanner}
          </div>
        )}

        {talkDock && (
          <div className="mx-auto w-full chat-content-w px-4">{talkDock}</div>
        )}

        {!hideInput && feedbackList && (
          <div className="mx-auto w-full chat-content-w px-4">
            {feedbackList}
          </div>
        )}

        {!hideInput && (
          <div className="mx-auto w-full chat-content-w">
            <ChatInput
              status={status}
              promptCapabilities={promptCapabilities}
              defaultPath={defaultPath}
              agentName={agentName}
              onFocus={onFocus}
              onSend={onSend}
              onCancel={onCancel}
              modes={modes}
              configOptions={configOptions}
              modeLoading={modeLoading}
              configOptionsLoading={configOptionsLoading}
              selectorsLoading={selectorsLoading}
              selectorsAwaitConnection={selectorsAwaitConnection}
              selectedModeId={selectedModeId}
              onModeChange={onModeChange}
              onConfigOptionChange={onConfigOptionChange}
              agentType={agentType}
              availableCommands={availableCommands}
              attachmentTabId={attachmentTabId}
              folderPickerOverride={folderPickerOverride}
              draftStorageKey={draftStorageKey}
              getSentHistory={getSentHistory}
              isActive={isActive}
              showActiveFlow={showActiveFlow}
              queue={queue}
              onEnqueue={onEnqueue}
              awaitingBackground={awaitingBackground}
              backgroundTaskCount={backgroundTaskCount}
              heldTurnReady={heldTurnReady}
              onDeliverNow={onDeliverNow}
              canContinue={canContinue}
              continueBeforeReady={continueBeforeReady}
              queueNotice={queueNotice}
              connectingReason={connectingReason}
              onQueueReorder={onQueueReorder}
              onQueueEdit={onQueueEdit}
              onQueueDelete={onQueueDelete}
              onQueueRetry={onQueueRetry}
              onQueueSteer={onQueueSteer}
              editingItemId={editingItemId}
              editingDraftText={editingDraftText}
              editingDraftBlocks={editingDraftBlocks}
              isEditingQueueItem={isEditingQueueItem}
              onSaveQueueEdit={onSaveQueueEdit}
              onCancelQueueEdit={onCancelQueueEdit}
              onSteer={onSteer}
              steerChannel={steerChannel}
              onAddFeedback={onAddFeedback}
              feedbackAddDisabled={feedbackAddDisabled}
              injectContent={injectContent}
              onInjectConsumed={onInjectConsumed}
              composerBridgeKey={composerBridgeKey}
              sideQuestion={sideQuestion}
              promptSuggestion={promptSuggestion}
              onPromptSuggestionShown={onPromptSuggestionShown}
              onPromptSuggestionAccepted={onPromptSuggestionAccepted}
            />
          </div>
        )}
      </div>

      <ComposerStatusStrips
        status={status}
        claudeApiRetry={claudeApiRetry}
        sessionFailures={sessionFailures}
        onSessionFailureDismiss={onSessionFailureDismiss}
      />
    </div>
  )
}
