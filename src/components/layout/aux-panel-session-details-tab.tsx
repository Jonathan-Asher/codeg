"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import type { MessageTurn } from "@/lib/types"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { resolveActiveSessionDetails } from "@/components/conversations/active-session-details"
import { SessionDetailsCard } from "@/components/conversations/session-details-content"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import {
  useConnectionAttachInfo,
  useConnectionStatus,
  useHeldTurnBackground,
  useLiveSessionModel,
} from "@/hooks/use-connection-status"
import { useOptionalAcpActions } from "@/contexts/acp-connection-contexts"
import { SessionActivityRow } from "@/components/conversations/session-activity"
import { CriticalSessionSection } from "@/components/conversations/critical-session-section"
import { LimitContinueSessionSection } from "@/components/conversations/limit-continue-session-section"
import { SessionDetailsInsights } from "./session-details-insights"

// Stable empty-turns reference so the `useShallow` slice below stays
// reference-equal when there's no active session — otherwise a fresh `[]` each
// render would defeat the shallow compare and re-render on every unrelated
// streaming batch.
const EMPTY_TURNS: MessageTurn[] = []

/**
 * The aux-panel "Session Details" tab. Shows the active conversation's identity
 * and identifiers as a card (`SessionDetailsCard`; the dialog is the full view,
 * with token usage and timestamps), then where the session stands right now
 * (its activity over this client's own connection, with Retry when the
 * connect failed) and its critical and limit-continue switches, then what its
 * transcript knows: the agent's plan and the message navigator, whose
 * messages carry their sub-agents and changed files
 * (`SessionDetailsInsights`). The branch selector
 * + command launcher that used to sit atop this tab now live in the bottom
 * status bar on both platforms.
 *
 * Details are resolved from live runtime state exactly the way the conversation
 * detail panel does it (`resolveActiveSessionDetails`), so no network fetch is
 * needed for the focused session.
 */
export function SessionDetailsTab() {
  const t = useTranslations("Folder.sessionDetails")
  const tActivity = useTranslations("Folder.sessionActivity")
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "session_details"

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )

  // A brand-new conversation streams under its virtual `runtimeConversationId`
  // until it reconciles; key the live-session lookup on it first (mirrors the
  // detail panel, exercised by active-session-details.test.ts). It is also the
  // key the conversation's transcript publishes its insights under.
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null
  // Subscribe to ONLY the detail-related fields, not the whole session object.
  // The live-message sink replaces the session object on every streaming batch
  // (~60/s via SET_LIVE_MESSAGE); a whole-session selector would re-render this
  // tab — and its non-memoized details subtree — on each token. These fields
  // change only at turn boundaries, so `useShallow` keeps the slice
  // reference-stable across batches (mirrors use-conversation-detail.ts).
  // Token usage isn't shown here, so its stats aren't read.
  const runtimeSlice = useConversationRuntimeStore(
    useShallow((s) => {
      const session =
        activeRuntimeId != null
          ? s.byConversationId.get(activeRuntimeId)
          : undefined
      return {
        detail: session?.detail ?? null,
        sessionStats: null,
        localTurns: session?.localTurns ?? EMPTY_TURNS,
      }
    })
  )
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  // The focused conversation's own connection (keyed by its tab) is the most
  // direct word on whether a turn is streaming right now — and on whether the
  // agent can be reached at all: an attach in flight or a failed connect must
  // not read as "Idle".
  const connectionStatus = useConnectionStatus(activeConversationTab?.id)
  const connection = useConnectionAttachInfo(activeConversationTab?.id)
  // A turn held open only for background work reads as idle with that work
  // running, not as "Working" for as long as the sub-agents take.
  const heldBackgroundTasks = useHeldTurnBackground(activeConversationTab?.id)
  const acpActions = useOptionalAcpActions()
  const activeTabKey = activeConversationTab?.id ?? null
  const retryConnect = useCallback(() => {
    if (!acpActions || !activeTabKey) return
    return acpActions.reconnect(activeTabKey)
  }, [acpActions, activeTabKey])
  // The tab scrolls as one, and the message navigator renders only the rows
  // in view of that scroll: it needs the real scroll container, which
  // OverlayScrollbars hands over once it has initialized.
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback(
    (element: HTMLElement | null) => setViewport(element),
    []
  )
  const liveModel = useLiveSessionModel(activeConversationTab?.id)
  const { summary, model } = resolveActiveSessionDetails(
    activeConversationTab,
    (id) => (id === activeRuntimeId ? runtimeSlice : null),
    conversations,
    liveModel
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {summary ? (
        <ScrollArea
          className="min-h-0 flex-1"
          onViewportRef={handleViewportRef}
        >
          <MessageNavScrollContext.Provider value={viewport}>
            {/* The cards are as far apart as they are from the panel's
                sides. */}
            <div className="min-w-0 space-y-3 p-3 text-sm">
              <SessionDetailsCard summary={summary} model={model} />
              {/* What the session is doing right now, from this client's own
                  connection to it, then the switches that act on it: alert
                  when it sits idle, continue once the usage limit resets. */}
              <section
                data-testid="session-live-card"
                className="min-w-0 space-y-4 rounded-xl border border-border/70 bg-muted/40 p-3"
              >
                <div className="min-w-0 space-y-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {tActivity("label")}
                  </h3>
                  <SessionActivityRow
                    summary={summary}
                    connectionStatus={connectionStatus}
                    connection={connection}
                    onRetry={acpActions ? retryConnect : undefined}
                    heldBackgroundTasks={heldBackgroundTasks}
                  />
                </div>
                <CriticalSessionSection summary={summary} />
                <LimitContinueSessionSection summary={summary} />
              </section>
              <SessionDetailsInsights
                conversationId={activeRuntimeId}
                active={active}
              />
            </div>
          </MessageNavScrollContext.Provider>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("noActiveSession")}
        </div>
      )}
    </div>
  )
}
