"use client"

/**
 * Talk on this Mac, for this window: which conversation it talks with, the
 * dock's state, and the actions the menus, the dock and the global shortcut
 * use. Mounted inside the ACP connections (it reads the tab's connection and
 * feeds the bridge the raw events) and the tabs (Talk is bound to the
 * conversation's tab: starting opens it, closing it ends Talk).
 *
 * One Talk at a time, app-wide: the backend replaces a Talk another window
 * holds. Read-aloud steps aside in every window while one runs.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useAcpActions,
  useAcpEvent,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { TalkSetupDialog } from "@/components/talk-voice/talk-setup-dialog"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { getTalkSettings } from "@/lib/api"
import { setTalkingConversation } from "@/lib/presence"
import { getReadAloudPlayer } from "@/lib/read-aloud/player"
import { getReadAloudPrefs } from "@/lib/read-aloud/prefs"
import { setTalkVoiceActive } from "@/lib/talk-voice/active"
import { talkSendAdapter } from "@/lib/talk-voice/adapters"
import {
  DEFAULT_TALK_VOICE_PREFS,
  TALK_VOICE_ERROR_MODELS_MISSING,
  settled,
  talkModelsApi,
  talkPrefsApi,
  talkVoiceApi,
  wirePrefs,
  type TalkModelsStatus,
  type TalkVoiceStatus,
} from "@/lib/talk-voice/api"
import { TalkBridge } from "@/lib/talk-voice/bridge"
import type { TalkAppInfo, TalkControl } from "@/lib/talk-voice/protocol"
import { sessionBackend } from "@/lib/talk-voice/session-backend"
import {
  levelsStore,
  TalkVoiceContext,
  uiStore,
  type TalkSession,
  type TalkVoiceContextValue,
} from "@/contexts/talk-voice-state"
import { watchTabClosed } from "@/lib/talk-voice/tab-watch"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePendingItemsStore } from "@/stores/pending-items-store"
import { useTabStore } from "@/stores/tab-store"

async function appInfo(): Promise<TalkAppInfo> {
  try {
    const { getVersion, getIdentifier } = await import("@tauri-apps/api/app")
    const [version, bundleId] = await Promise.all([
      getVersion(),
      getIdentifier(),
    ])
    const build = /-fork\.(\d+)/.exec(version)?.[1] ?? version
    return { version, build, bundleId }
  } catch {
    return { version: "unknown", build: "unknown", bundleId: "unknown" }
  }
}

function conversationSummary(conversationId: number) {
  return useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === conversationId)
}

export {
  useTalkEligibility,
  useTalkLevels,
  useTalkUi,
  useTalkVoice,
  type TalkEligibility,
  type TalkSession,
  type TalkVoiceContextValue,
} from "@/contexts/talk-voice-state"

export function TalkVoiceProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("TalkVoice")
  const store = useConnectionStore()
  const actions = useAcpActions()
  const workbench = useOptionalWorkbenchRoute()
  const available = isDesktop()

  const [status, setStatus] = useState<TalkVoiceStatus | null>(null)
  const [session, setSession] = useState<TalkSession | null>(null)
  const [setupFor, setSetupFor] = useState<number | null>(null)
  const bridgeRef = useRef<TalkBridge | null>(null)
  const actionsRef = useRef(actions)
  const workbenchRef = useRef(workbench)
  const tRef = useRef(t)
  useEffect(() => {
    actionsRef.current = actions
    workbenchRef.current = workbench
    tRef.current = t
  }, [actions, workbench, t])

  // The backend's status: on mount (which starts the helper's probe), then
  // as it changes (a Talk started or ended anywhere, the probe's result).
  useEffect(() => {
    if (!available) return
    let cancelled = false
    const offs: (() => void)[] = []
    void settled(() => talkVoiceApi.status())
      .then((next) => {
        if (!cancelled && next) setStatus(next)
      })
      .catch(() => {
        // An older backend without Talk on this Mac.
      })
    const keep = (off: (() => void) | undefined) => {
      if (typeof off !== "function") return
      if (cancelled) off()
      else offs.push(off)
    }
    void settled(() =>
      talkVoiceApi.onStatus((payload) => setStatus(payload as TalkVoiceStatus))
    ).then(keep)
    void settled(() =>
      talkModelsApi.onChange((payload) =>
        setStatus((prev) =>
          prev ? { ...prev, models: payload as TalkModelsStatus } : prev
        )
      )
    ).then(keep)
    return () => {
      cancelled = true
      for (const off of offs) off()
    }
  }, [available])

  // Read-aloud steps aside in every window while a Talk runs.
  const anyTalk = status?.active != null || session != null
  useEffect(() => {
    setTalkVoiceActive(anyTalk)
    if (anyTalk) getReadAloudPlayer()?.stop()
  }, [anyTalk])

  // The raw events of this window, for the bridge (turn ends with their stop
  // reason, background turns).
  const onEnvelope = useCallback(
    (envelope: Parameters<TalkBridge["onEnvelope"]>[0]) => {
      bridgeRef.current?.onEnvelope(envelope)
    },
    []
  )
  useAcpEvent(onEnvelope)

  const refreshStatus = useCallback(
    async (refreshProbe?: boolean) => {
      if (!available) return
      try {
        setStatus(await talkVoiceApi.status(refreshProbe))
      } catch {
        // Nothing to show.
      }
    },
    [available]
  )

  const endTalk = useCallback(async () => {
    const bridge = bridgeRef.current
    if (!bridge) return
    await bridge.stop()
  }, [])

  const startTalk = useCallback(
    async (conversationId: number) => {
      const tr = tRef.current
      if (!available) return
      const summary = conversationSummary(conversationId)
      if (!summary) {
        toast.error(tr("notFound"))
        return
      }
      let current: TalkVoiceStatus | undefined
      try {
        current = await settled(() => talkVoiceApi.status())
        if (current) setStatus(current)
      } catch (error) {
        toast.error(tr("startFailed", { error: toErrorMessage(error) }))
        return
      }
      if (!current?.supported) {
        toast.error(tr("unsupported"))
        return
      }
      if (!current.models.ready) {
        setSetupFor(conversationId)
        return
      }
      // One Talk per window; the backend replaces another window's.
      if (bridgeRef.current) {
        if (bridgeRef.current.conversationId === conversationId) return
        await bridgeRef.current.stop()
      }

      // Talk is bound to the conversation's tab.
      useTabStore
        .getState()
        .openTab(summary.folder_id, conversationId, summary.agent_type, true)
      workbenchRef.current?.openConversations()
      const tab = useTabStore
        .getState()
        .rawTabs.find(
          (candidate) => candidate.conversationId === conversationId
        )
      if (!tab) {
        toast.error(tr("notFound"))
        return
      }

      getReadAloudPlayer()?.stop()
      const [prefs, settings, app] = await Promise.all([
        settled(() => talkPrefsApi.get())
          .then((stored) => stored ?? DEFAULT_TALK_VOICE_PREFS)
          .catch(() => DEFAULT_TALK_VOICE_PREFS),
        getTalkSettings().catch(() => null),
        appInfo(),
      ])
      const readAloud = getReadAloudPrefs()
      const folderName = (folderId: number) =>
        useAppWorkspaceStore.getState().getFolder(folderId)?.name ?? null

      const bridge: TalkBridge = new TalkBridge({
        conversationId,
        contextKey: tab.id,
        local: !isRemoteDesktopMode(),
        api: talkVoiceApi,
        actions: {
          respondPermission: (key, requestId, optionId) =>
            actionsRef.current.respondPermission(key, requestId, optionId),
          answerQuestion: (key, questionId, answer) =>
            actionsRef.current.answerQuestion(key, questionId, answer),
          answerPlanApproval: (key, approvalId, answer) =>
            actionsRef.current.answerPlanApproval(key, approvalId, answer),
          cancel: (key) => actionsRef.current.cancel(key),
          registerLiveSurfaceKeys: (source, keys) =>
            actionsRef.current.registerLiveSurfaceKeys(source, keys),
        },
        backend: sessionBackend,
        sources: {
          store,
          pendingItems: {
            get: () => usePendingItemsStore.getState().items,
            subscribe: (onChange) => usePendingItemsStore.subscribe(onChange),
          },
          title: () => conversationSummary(conversationId)?.title ?? null,
          folder: () => folderName(summary.folder_id),
          adapter: () => talkSendAdapter(conversationId),
        },
        setTalking: setTalkingConversation,
        onUi: (ui) => {
          if (bridgeRef.current === bridge) uiStore.set(ui)
        },
        onLevel: (next) => {
          if (bridgeRef.current === bridge) levelsStore.set(next)
        },
        onEnded: ({ reason, error }) => {
          if (bridgeRef.current === bridge) {
            bridgeRef.current = null
            setSession(null)
            uiStore.set(null)
            levelsStore.set(null)
          }
          const tr2 = tRef.current
          if (error) toast.error(error)
          else if (reason === "crashed") toast.error(tr2("crashed"))
          else if (reason === "failed") toast.error(tr2("failed"))
          else if (reason === "replaced") toast.info(tr2("replaced"))
        },
      })
      bridgeRef.current = bridge
      uiStore.set(null)
      levelsStore.set(null)
      setSession({
        conversationId,
        contextKey: tab.id,
        talkId: null,
        phase: "starting",
      })
      try {
        const talkId = await bridge.start({
          settings,
          prefs: wirePrefs(prefs),
          voice: { name: readAloud.naturalVoice, speed: readAloud.rate },
          app,
        })
        setSession((prev) =>
          prev && prev.contextKey === tab.id
            ? { ...prev, talkId, phase: "running" }
            : prev
        )
      } catch (error) {
        if (bridgeRef.current === bridge) {
          bridgeRef.current = null
          setSession(null)
        }
        const appError = extractAppCommandError(error)
        if (appError?.i18n_key === TALK_VOICE_ERROR_MODELS_MISSING) {
          setSetupFor(conversationId)
          return
        }
        toast.error(tr("startFailed", { error: toErrorMessage(error) }))
      }
    },
    [available, store]
  )

  // Closing the conversation's tab ends its Talk (a tab moved to another
  // split group keeps its id, and its Talk).
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  useEffect(
    () =>
      watchTabClosed(
        useTabStore,
        () => sessionRef.current?.contextKey ?? null,
        () => void endTalk()
      ),
    [endTalk]
  )

  // The global shortcut with no Talk running: talk with the session in
  // front of this window.
  useEffect(() => {
    if (!available) return
    let cancelled = false
    let off: (() => void) | null = null
    void settled(() =>
      talkVoiceApi.onShortcut(() => {
        if (bridgeRef.current) return
        const tabs = useTabStore.getState()
        const active = tabs.rawTabs.find((tab) => tab.id === tabs.activeTabId)
        if (active?.conversationId != null && active.conversationId > 0) {
          void startTalk(active.conversationId)
        } else {
          toast.info(tRef.current("shortcutNoSession"))
        }
      })
    ).then((unsubscribe) => {
      if (typeof unsubscribe !== "function") return
      if (cancelled) unsubscribe()
      else off = unsubscribe
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [available, startTalk])

  // The page going away (a reload, the window closing): Rust ends the Talk
  // it held; only the local listeners go here.
  useEffect(
    () => () => {
      bridgeRef.current?.dispose()
      bridgeRef.current = null
    },
    []
  )

  const control = useCallback((next: TalkControl) => {
    bridgeRef.current?.control(next)
  }, [])

  const supported =
    available &&
    status != null &&
    status.supported &&
    status.probe?.ok !== false

  const value = useMemo<TalkVoiceContextValue>(
    () => ({
      available,
      status,
      supported,
      session,
      startTalk,
      endTalk,
      control,
      refreshStatus,
    }),
    [
      available,
      status,
      supported,
      session,
      startTalk,
      endTalk,
      control,
      refreshStatus,
    ]
  )

  return (
    <TalkVoiceContext.Provider value={value}>
      {children}
      {setupFor != null && (
        <TalkSetupDialog
          open
          onOpenChange={(open) => {
            if (!open) setSetupFor(null)
          }}
          onReady={() => {
            const conversationId = setupFor
            setSetupFor(null)
            void startTalk(conversationId)
          }}
        />
      )}
    </TalkVoiceContext.Provider>
  )
}
