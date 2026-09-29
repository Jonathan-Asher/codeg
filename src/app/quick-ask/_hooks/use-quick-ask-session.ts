"use client"

/**
 * The one session a Quick Ask window runs at a time, for whichever target the
 * user picked:
 *
 * - **new** — a real conversation in a folder. The agent connects in that
 *   folder with Quick Ask's own model/effort picks; the first question creates
 *   the conversation row (so it shows in the sidebar) and is sent linked to it.
 * - **existing** — a conversation already in the sidebar. The window connects
 *   the way a tab would (attaching as a viewer when the session is live
 *   somewhere else, resuming it otherwise, always with the session's OWN
 *   selectors) and routes each question like the composer does: sent when the
 *   agent is idle, steered into the running reply when it can take it, queued
 *   until the reply ends otherwise.
 * - **private** — nothing saved. The agent runs in a throwaway scratch
 *   directory, is asked not to keep a transcript, and every prompt goes out
 *   unlinked, so no conversation row exists at any point. Clearing the window
 *   disconnects the agent and deletes the directory plus anything the agent
 *   recorded anyway.
 *
 * Follow-ups continue the same session. Nothing here writes the per-agent
 * selector picks the workspace composer uses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  useAcpActions,
  useConnectionStore,
  type ConnectionStoreApi,
  type LiveMessage,
} from "@/contexts/acp-connections-context"
import { useConnection } from "@/hooks/use-connection"
import {
  createChatDir,
  createConversation,
  discardPrivateQuickAsk,
  submitSessionFeedback,
  type PrivateQuickAskCleanup,
} from "@/lib/api"
import { describeError } from "@/lib/app-error"
import {
  promptOptionsFor,
  routeQuickAskSend,
  type QuickAskPromptTarget,
  type QuickAskSendRoute,
} from "@/lib/quick-ask/routing"
import type { QuickAskTargetKind } from "@/lib/quick-ask/prefs"
import { isNoActiveTurnRejection, TurnBusyError } from "@/lib/turn-busy"
import type { AgentType, PromptInputBlock } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

/** The Quick Ask window runs one connection, always under this key. */
export const QUICK_ASK_CONTEXT_KEY = "quick-ask"
const LIVE_SURFACE_SOURCE = "quick-ask"
/** Long enough for a cold agent start plus a resume. */
const CONNECT_READY_TIMEOUT_MS = 180_000

export interface QuickAskFolderTarget {
  id: number
  path: string
  name: string
}

export interface QuickAskSessionTarget {
  id: number
  folderId: number
  folderPath: string
  agentType: AgentType
  externalId: string | null
  title: string | null
}

export type QuickAskUserTurnState = "sent" | "queued" | "steered" | "failed"

export type QuickAskTurn =
  | {
      id: string
      role: "user"
      text: string
      state: QuickAskUserTurnState
    }
  | { id: string; role: "assistant"; message: LiveMessage }

/** What the window is talking to once the first question went out. */
export interface QuickAskBinding {
  target: QuickAskTargetKind
  agentType: AgentType
  workingDir: string
  folderId: number | null
  conversationId: number | null
  title: string | null
}

export interface UseQuickAskSessionArgs {
  target: QuickAskTargetKind
  /** Agent for new / private questions (an existing session has its own). */
  agentType: AgentType
  folder: QuickAskFolderTarget | null
  session: QuickAskSessionTarget | null
  /** Quick Ask's own model/effort picks for `agentType`. */
  configValues: Record<string, string>
  /** Called with the folder a new session was created in, to remember it. */
  onFolderUsed?: (folderId: number) => void
  onSessionUsed?: (conversationId: number) => void
}

export type QuickAskErrorCode =
  | "no_folder"
  | "no_session"
  | "connect_failed"
  | "send_failed"

export interface QuickAskError {
  code: QuickAskErrorCode
  detail: string | null
}

/** Resolve once the connection under `key` can take a prompt. */
export function waitForConnectionReady(
  store: ConnectionStoreApi,
  key: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => {}
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      const conn = store.getConnection(key)
      if (conn?.status === "connected" || conn?.status === "prompting") {
        finish(null)
        return
      }
      const failure = store.getConnectError(key)
      if (failure) {
        finish(new Error(failure.detail ?? failure.title))
        return
      }
      if (conn?.status === "error" || conn?.status === "disconnected") {
        finish(new Error(conn.error ?? conn.status))
      }
    }
    const timer = setTimeout(
      () => finish(new Error("The agent did not start in time")),
      timeoutMs
    )
    unsubscribe = store.subscribeKey(key, check)
    check()
  })
}

function textBlocks(text: string): PromptInputBlock[] {
  return [{ type: "text", text }]
}

/** A one-line title for the conversation a first question creates. */
export function titleFromQuestion(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80)
}

export function useQuickAskSession({
  target,
  agentType,
  folder,
  session,
  configValues,
  onFolderUsed,
  onSessionUsed,
}: UseQuickAskSessionArgs) {
  const actions = useAcpActions()
  const store = useConnectionStore()
  const conn = useConnection(QUICK_ASK_CONTEXT_KEY)

  const [thread, setThread] = useState<QuickAskTurn[]>([])
  const [binding, setBinding] = useState<QuickAskBinding | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<QuickAskError | null>(null)
  const [lastCleanup, setLastCleanup] = useState<PrivateQuickAskCleanup | null>(
    null
  )

  // Refs mirror what async paths need to read at the moment they run.
  const bindingRef = useRef<QuickAskBinding | null>(null)
  const privateDirRef = useRef<string | null>(null)
  const privateDirPromiseRef = useRef<Promise<string> | null>(null)
  const queueRef = useRef<{ turnId: string; text: string }[]>([])
  const committedLiveIdsRef = useRef(new Set<string>())
  const argsRef = useRef({ target, agentType, folder, session, configValues })
  useEffect(() => {
    argsRef.current = { target, agentType, folder, session, configValues }
  }, [target, agentType, folder, session, configValues])

  const effectiveAgent: AgentType =
    target === "existing" && session ? session.agentType : agentType

  const updateTurn = useCallback(
    (turnId: string, state: QuickAskUserTurnState) => {
      setThread((prev) =>
        prev.map((turn) =>
          turn.id === turnId && turn.role === "user" ? { ...turn, state } : turn
        )
      )
    },
    []
  )

  const promptTargetOf = useCallback(
    (b: QuickAskBinding): QuickAskPromptTarget =>
      b.target === "private" || b.conversationId == null || b.folderId == null
        ? { kind: "unlinked" }
        : {
            kind: "linked",
            folderId: b.folderId,
            conversationId: b.conversationId,
          },
    []
  )

  /** Where the connection for the current selection should run. */
  const desiredConnection = useCallback(async () => {
    const args = argsRef.current
    if (args.target === "existing") {
      if (!args.session) return null
      return {
        agentType: args.session.agentType,
        workingDir: args.session.folderPath,
        sessionId: args.session.externalId ?? undefined,
        conversationId: args.session.id,
        options: undefined,
      }
    }
    const selectorPrefs = {
      modeId: null,
      configValues:
        Object.keys(args.configValues).length > 0 ? args.configValues : null,
    }
    if (args.target === "new") {
      if (!args.folder) return null
      return {
        agentType: args.agentType,
        workingDir: args.folder.path,
        sessionId: undefined,
        conversationId: undefined,
        options: { selectorPrefs },
      }
    }
    // One scratch directory per private question, however many keystrokes
    // race to prepare it.
    if (!privateDirRef.current) {
      privateDirPromiseRef.current ??= createChatDir()
        .then((res) => {
          privateDirRef.current = res.path
          return res.path
        })
        .finally(() => {
          privateDirPromiseRef.current = null
        })
      await privateDirPromiseRef.current
    }
    if (!privateDirRef.current) return null
    return {
      agentType: args.agentType,
      workingDir: privateDirRef.current,
      sessionId: undefined,
      conversationId: undefined,
      options: { selectorPrefs, ephemeral: true },
    }
  }, [])

  /**
   * Connect for the current selection ahead of the first question (called as
   * the user starts typing), so the agent is up by the time they press Enter.
   * A no-op once a question went out: follow-ups stay on that session.
   */
  const prepare = useCallback(async () => {
    if (bindingRef.current) return
    const desired = await desiredConnection()
    if (!desired) return
    const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
    const pending = store.getConnectPending(QUICK_ASK_CONTEXT_KEY)
    const matches =
      live != null &&
      live.agentType === desired.agentType &&
      live.workingDir === desired.workingDir &&
      live.status !== "error" &&
      live.status !== "disconnected"
    if (matches) return
    if (
      pending &&
      pending.agentType === desired.agentType &&
      pending.workingDir === desired.workingDir
    ) {
      return
    }
    await actions.connect(
      QUICK_ASK_CONTEXT_KEY,
      desired.agentType,
      desired.workingDir,
      desired.sessionId,
      desired.conversationId,
      desired.options
    )
  }, [actions, desiredConnection, store])

  /** Deliver one question on the bound session along `route`. */
  const deliver = useCallback(
    async (
      route: QuickAskSendRoute,
      turnId: string,
      text: string,
      b: QuickAskBinding
    ): Promise<void> => {
      if (route === "queue") {
        queueRef.current.push({ turnId, text })
        updateTurn(turnId, "queued")
        return
      }
      const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
      if (route === "steer" && live) {
        try {
          await submitSessionFeedback(live.connectionId, text)
          updateTurn(turnId, "steered")
          return
        } catch (e) {
          // The reply ended in the meantime: it is an ordinary prompt now.
          if (!isNoActiveTurnRejection(e)) throw e
        }
      }
      try {
        await actions.sendPrompt(
          QUICK_ASK_CONTEXT_KEY,
          textBlocks(text),
          promptOptionsFor(promptTargetOf(b))
        )
        updateTurn(turnId, "sent")
      } catch (e) {
        if (e instanceof TurnBusyError) {
          // Another client started a turn first: wait for it, like the
          // composer's queue does.
          queueRef.current.push({ turnId, text })
          updateTurn(turnId, "queued")
          return
        }
        throw e
      }
    },
    [actions, promptTargetOf, store, updateTurn]
  )

  const send = useCallback(
    async (rawText: string): Promise<boolean> => {
      const text = rawText.trim()
      if (!text) return false
      const args = argsRef.current
      if (!bindingRef.current) {
        if (args.target === "new" && !args.folder) {
          setError({ code: "no_folder", detail: null })
          return false
        }
        if (args.target === "existing" && !args.session) {
          setError({ code: "no_session", detail: null })
          return false
        }
      }
      setError(null)
      const turnId = randomUUID()
      setThread((prev) => [
        ...prev,
        { id: turnId, role: "user", text, state: "sent" },
      ])

      // Follow-up on the session the window already talks to.
      const bound = bindingRef.current
      if (bound) {
        const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
        const route = routeQuickAskSend({
          target: bound.target,
          status: live?.status ?? null,
          nativeSteering: live?.nativeSteering ?? false,
        })
        try {
          await deliver(route, turnId, text, bound)
        } catch (e) {
          updateTurn(turnId, "failed")
          setError({ code: "send_failed", detail: describeError(e) })
        }
        return true
      }

      // First question: connect, create what the target needs, send.
      setStarting(true)
      try {
        try {
          await prepare()
          await waitForConnectionReady(
            store,
            QUICK_ASK_CONTEXT_KEY,
            CONNECT_READY_TIMEOUT_MS
          )
        } catch (e) {
          updateTurn(turnId, "failed")
          setError({ code: "connect_failed", detail: describeError(e) })
          return true
        }
        const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
        const workingDir = live?.workingDir ?? ""
        let next: QuickAskBinding
        if (args.target === "existing" && args.session) {
          next = {
            target: "existing",
            agentType: args.session.agentType,
            workingDir,
            folderId: args.session.folderId,
            conversationId: args.session.id,
            title: args.session.title,
          }
        } else if (args.target === "new" && args.folder) {
          const title = titleFromQuestion(text)
          const conversationId = await createConversation(
            args.folder.id,
            args.agentType,
            title
          )
          next = {
            target: "new",
            agentType: args.agentType,
            workingDir,
            folderId: args.folder.id,
            conversationId,
            title,
          }
        } else {
          next = {
            target: "private",
            agentType: args.agentType,
            workingDir,
            folderId: null,
            conversationId: null,
            title: null,
          }
        }
        bindingRef.current = next
        setBinding(next)
        actions.registerLiveSurfaceKeys(
          LIVE_SURFACE_SOURCE,
          new Set([QUICK_ASK_CONTEXT_KEY])
        )
        if (next.target === "new" && next.folderId != null) {
          onFolderUsed?.(next.folderId)
        }
        if (next.target === "existing" && next.conversationId != null) {
          onSessionUsed?.(next.conversationId)
        }
        const route = routeQuickAskSend({
          target: next.target,
          status: live?.status ?? null,
          nativeSteering: live?.nativeSteering ?? false,
        })
        await deliver(route, turnId, text, next)
      } catch (e) {
        updateTurn(turnId, "failed")
        setError({ code: "send_failed", detail: describeError(e) })
      } finally {
        setStarting(false)
      }
      return true
    },
    [actions, deliver, onFolderUsed, onSessionUsed, prepare, store, updateTurn]
  )

  // Settle each reply: when the agent leaves `prompting`, keep its final
  // message in the thread, then send the next queued question.
  const lastStatusRef = useRef(conn.status)
  useEffect(() => {
    const previous = lastStatusRef.current
    lastStatusRef.current = conn.status
    if (previous !== "prompting" || conn.status === "prompting") return
    const finished = store.getConnection(QUICK_ASK_CONTEXT_KEY)?.liveMessage
    if (
      bindingRef.current &&
      finished &&
      !committedLiveIdsRef.current.has(finished.id)
    ) {
      committedLiveIdsRef.current.add(finished.id)
      setThread((prev) => [
        ...prev,
        { id: `reply-${finished.id}`, role: "assistant", message: finished },
      ])
    }
    const bound = bindingRef.current
    const nextQueued = queueRef.current.shift()
    if (bound && nextQueued && conn.status === "connected") {
      void deliver("send", nextQueued.turnId, nextQueued.text, bound).catch(
        (e: unknown) => {
          updateTurn(nextQueued.turnId, "failed")
          setError({ code: "send_failed", detail: describeError(e) })
        }
      )
    }
  }, [conn.status, deliver, store, updateTurn])

  const cancel = useCallback(async () => {
    queueRef.current = []
    await actions.cancel(QUICK_ASK_CONTEXT_KEY)
  }, [actions])

  /**
   * "New question": drop the thread and let go of the session. A private
   * question is deleted outright — agent disconnected, scratch directory and
   * any leftover transcript removed. A saved conversation keeps running in
   * the background if it is mid-reply (its answer lands in the conversation).
   */
  const clear =
    useCallback(async (): Promise<PrivateQuickAskCleanup | null> => {
      const bound = bindingRef.current
      const privateDir = privateDirRef.current
      const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
      bindingRef.current = null
      privateDirRef.current = null
      queueRef.current = []
      committedLiveIdsRef.current = new Set()
      setBinding(null)
      setThread([])
      setError(null)
      actions.registerLiveSurfaceKeys(LIVE_SURFACE_SOURCE, new Set())

      let report: PrivateQuickAskCleanup | null = null
      if (privateDir) {
        const sessionId = live?.sessionId ?? null
        const agent = live?.agentType ?? bound?.agentType ?? null
        await actions.disconnect(QUICK_ASK_CONTEXT_KEY)
        try {
          report = await discardPrivateQuickAsk(privateDir, agent, sessionId)
        } catch (e) {
          report = { removed: [], failed: [privateDir] }
          setError({ code: "send_failed", detail: describeError(e) })
        }
        setLastCleanup(report)
      } else if (live) {
        await actions.disconnectIfIdle(QUICK_ASK_CONTEXT_KEY)
      }
      return report
    }, [actions, store])

  // A private scratch dir prepared for a question that was never asked (the
  // user switched to another target) is discarded right away.
  useEffect(() => {
    if (target === "private" || bindingRef.current) return
    const dir = privateDirRef.current
    if (!dir) return
    privateDirRef.current = null
    // Only the private connection itself: one for the new target may already
    // be starting under the same key.
    const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
    const stop =
      live?.workingDir === dir
        ? actions.disconnect(QUICK_ASK_CONTEXT_KEY)
        : Promise.resolve(true)
    void stop
      .then(() => discardPrivateQuickAsk(dir, null, null))
      .catch(() => {})
  }, [actions, store, target])

  // The window going away (reload onto another backend, app quit) takes a
  // private question with it. Best effort: the IPC may not finish, and the
  // backend's startup sweep reclaims a scratch directory left behind.
  useEffect(() => {
    const onPageHide = () => {
      const dir = privateDirRef.current
      if (!dir) return
      const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
      void actions.disconnect(QUICK_ASK_CONTEXT_KEY).catch(() => false)
      void discardPrivateQuickAsk(
        dir,
        live?.agentType ?? null,
        live?.sessionId ?? null
      ).catch(() => {})
    }
    window.addEventListener("pagehide", onPageHide)
    return () => window.removeEventListener("pagehide", onPageHide)
  }, [actions, store])

  /** Change the model / effort of the running session without saving it as
   *  the workspace's per-agent pick. */
  const setConfigOption = useCallback(
    async (configId: string, valueId: string) => {
      const live = store.getConnection(QUICK_ASK_CONTEXT_KEY)
      if (!live || live.isViewer) return
      if (live.status !== "connected" && live.status !== "prompting") return
      await actions.setConfigOption(QUICK_ASK_CONTEXT_KEY, configId, valueId, {
        remember: false,
      })
    },
    [actions, store]
  )

  const isPrivate = (binding?.target ?? target) === "private"

  return useMemo(
    () => ({
      conn,
      effectiveAgent,
      thread,
      binding,
      starting,
      error,
      lastCleanup,
      isPrivate,
      prepare,
      send,
      cancel,
      clear,
      setConfigOption,
      dismissError: () => setError(null),
    }),
    [
      conn,
      effectiveAgent,
      thread,
      binding,
      starting,
      error,
      lastCleanup,
      isPrivate,
      prepare,
      send,
      cancel,
      clear,
      setConfigOption,
    ]
  )
}

export type QuickAskSession = ReturnType<typeof useQuickAskSession>
