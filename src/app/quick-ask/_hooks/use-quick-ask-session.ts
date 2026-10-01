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
 *
 * A question may carry images. They are encoded for the agent at delivery
 * time, from the capabilities the live connection reports; an agent that
 * takes images in no form gets the question refused, not silently stripped.
 * In web / remote mode the images were uploaded into this question's own
 * upload bucket (`uploadBucket`), which a private question's discard deletes.
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
  acpGetSessionSnapshot,
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
import type {
  AgentType,
  PromptCapabilitiesInfo,
  PromptInputBlock,
} from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import {
  imageAttachmentToPromptBlock,
  type ImageInputAttachment,
} from "@/components/chat/message-input-attachments"

/**
 * Prefix of the key the window's connection lives under. Each question gets a
 * fresh key (`quick-ask-0`, `quick-ask-1`, …): "New question" can then leave a
 * saved conversation that is still answering to finish in the background,
 * while the next question starts its own connection instead of tearing that
 * one down.
 */
export const QUICK_ASK_CONTEXT_KEY = "quick-ask"

export function quickAskContextKey(generation: number): string {
  return `${QUICK_ASK_CONTEXT_KEY}-${generation}`
}
const LIVE_SURFACE_SOURCE = "quick-ask"
/** Long enough for a cold agent start plus a resume. */
const CONNECT_READY_TIMEOUT_MS = 180_000
/** How long a "no images" reading may wait to be corrected: capabilities come
 *  in their own event (or with an attached viewer's snapshot), which can trail
 *  the connection becoming ready. */
const IMAGE_SUPPORT_SETTLE_MS = 1500

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
      /** Images sent with the question (kept for its thumbnails). */
      images?: ImageInputAttachment[]
      state: QuickAskUserTurnState
    }
  | {
      id: string
      role: "assistant"
      message: LiveMessage
      /** Wall-clock time the reply took, for its "Worked for" header. */
      durationMs: number | null
    }

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
  /** Live feedback (steering) is switched on — the composer's own gate for
   *  sending into a running reply. Off: a question for a busy session is
   *  queued, as the composer does. */
  steeringEnabled?: boolean
  /** Called with the folder a new session was created in, to remember it. */
  onFolderUsed?: (folderId: number) => void
  onSessionUsed?: (conversationId: number) => void
}

export type QuickAskErrorCode =
  | "no_folder"
  | "no_session"
  | "connect_failed"
  | "send_failed"
  | "images_unsupported"

export interface QuickAskError {
  code: QuickAskErrorCode
  detail: string | null
}

/**
 * Does the agent under `key` take images? Answered at once when it says yes;
 * a "no" is given `timeoutMs` to turn into a yes before it stands, since the
 * capabilities can reach the connection a moment after it is ready.
 */
export function waitForImageSupport(
  store: ConnectionStoreApi,
  key: string,
  timeoutMs: number
): Promise<boolean> {
  const takes = () =>
    agentTakesImages(store.getConnection(key)?.promptCapabilities)
  if (takes()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(takes())
    }, timeoutMs)
    unsubscribe = store.subscribeKey(key, () => {
      if (!takes()) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
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

/**
 * Upload bucket for one question's images (`/upload_attachment`'s session
 * field). The backend deletes only buckets of exactly this shape when a
 * private question is discarded, so it never touches another surface's
 * uploads.
 */
export function newQuickAskUploadBucket(): string {
  return `quick-ask-${randomUUID().replace(/-/g, "").toLowerCase()}`
}

/** Whether an agent takes images in any form (native block or embedded
 *  resource), as the composer decides it. Unknown capabilities count as yes:
 *  the connection is the one to say no. */
export function agentTakesImages(
  caps: Pick<PromptCapabilitiesInfo, "image" | "embedded_context"> | undefined
): boolean {
  return !caps || caps.image || caps.embedded_context
}

/** The prompt for one question: its text, then its images in the encoding
 *  the agent accepts. */
export function questionBlocks(
  text: string,
  images: ImageInputAttachment[],
  caps: Pick<PromptCapabilitiesInfo, "image" | "embedded_context"> | undefined
): PromptInputBlock[] {
  const encoding = caps ?? { image: true, embedded_context: true }
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => imageAttachmentToPromptBlock(image, encoding)),
  ]
}

/**
 * Place a finished reply in the thread. Questions queued while it was being
 * written were asked AFTER it, so the reply goes in front of them.
 */
export function insertReplyBeforeQueued(
  thread: QuickAskTurn[],
  reply: QuickAskTurn
): QuickAskTurn[] {
  const at = thread.findIndex(
    (turn) => turn.role === "user" && turn.state === "queued"
  )
  if (at < 0) return [...thread, reply]
  return [...thread.slice(0, at), reply, ...thread.slice(at)]
}

/** A one-line title for the conversation a first question creates. An
 *  image-only question is named after its first image. */
export function titleFromQuestion(
  text: string,
  images: ImageInputAttachment[] = []
): string {
  const title = text.replace(/\s+/g, " ").trim().slice(0, 80)
  return title || (images[0]?.name ?? "").slice(0, 80)
}

export function useQuickAskSession({
  target,
  agentType,
  folder,
  session,
  configValues,
  steeringEnabled = false,
  onFolderUsed,
  onSessionUsed,
}: UseQuickAskSessionArgs) {
  const actions = useAcpActions()
  const store = useConnectionStore()
  const [generation, setGeneration] = useState(0)
  const contextKey = quickAskContextKey(generation)
  // Read by async paths, which must act on the key of the question they
  // belong to even after "New question" moved on.
  const keyRef = useRef(contextKey)
  const generationRef = useRef(0)
  const conn = useConnection(contextKey)

  const [thread, setThread] = useState<QuickAskTurn[]>([])
  const [binding, setBinding] = useState<QuickAskBinding | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<QuickAskError | null>(null)
  const [lastCleanup, setLastCleanup] = useState<PrivateQuickAskCleanup | null>(
    null
  )
  // One bucket per question: a private one's uploads go with its discard.
  const [uploadBucket, setUploadBucket] = useState(newQuickAskUploadBucket)
  const uploadBucketRef = useRef(uploadBucket)

  // Refs mirror what async paths need to read at the moment they run.
  const bindingRef = useRef<QuickAskBinding | null>(null)
  const privateDirRef = useRef<string | null>(null)
  const privateDirPromiseRef = useRef<Promise<string> | null>(null)
  const queueRef = useRef<
    { turnId: string; text: string; images: ImageInputAttachment[] }[]
  >([])
  const committedLiveIdsRef = useRef(new Set<string>())
  const argsRef = useRef({
    target,
    agentType,
    folder,
    session,
    configValues,
    steeringEnabled,
  })
  useEffect(() => {
    argsRef.current = {
      target,
      agentType,
      folder,
      session,
      configValues,
      steeringEnabled,
    }
  }, [target, agentType, folder, session, configValues, steeringEnabled])

  /**
   * Can a question go into the reply being written right now? Only with live
   * feedback switched on and a working channel on this session. The channel
   * is read from the backend snapshot, as the composer does: the connection
   * state learns it late (a freshly spawned agent reports it after connect).
   */
  const canSteer = useCallback(
    async (b: QuickAskBinding): Promise<boolean> => {
      const live = store.getConnection(keyRef.current)
      if (b.target === "private" || live?.status !== "prompting") return false
      if (!argsRef.current.steeringEnabled) return false
      if (live.nativeSteering) return true
      try {
        const snap = await acpGetSessionSnapshot(live.connectionId)
        return Boolean(
          snap?.native_steering_available || snap?.feedback_tool_available
        )
      } catch {
        return false
      }
    },
    [store]
  )

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
    const live = store.getConnection(keyRef.current)
    const pending = store.getConnectPending(keyRef.current)
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
      keyRef.current,
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
      images: ImageInputAttachment[],
      b: QuickAskBinding
    ): Promise<void> => {
      if (route === "queue") {
        queueRef.current.push({ turnId, text, images })
        updateTurn(turnId, "queued")
        return
      }
      const live = store.getConnection(keyRef.current)
      const blocks = questionBlocks(text, images, live?.promptCapabilities)
      if (route === "steer" && live) {
        try {
          // Images ride along as the steer's blocks, as the composer's
          // mid-turn send does; plain text stays a plain note.
          if (images.length > 0) {
            await submitSessionFeedback(live.connectionId, text, blocks)
          } else {
            await submitSessionFeedback(live.connectionId, text)
          }
          updateTurn(turnId, "steered")
          return
        } catch (e) {
          // The reply ended in the meantime: it is an ordinary prompt now.
          if (!isNoActiveTurnRejection(e)) throw e
        }
      }
      try {
        await actions.sendPrompt(
          keyRef.current,
          blocks,
          promptOptionsFor(promptTargetOf(b))
        )
        updateTurn(turnId, "sent")
      } catch (e) {
        if (e instanceof TurnBusyError) {
          // Another client started a turn first: wait for it, like the
          // composer's queue does.
          queueRef.current.push({ turnId, text, images })
          updateTurn(turnId, "queued")
          return
        }
        throw e
      }
    },
    [actions, promptTargetOf, store, updateTurn]
  )

  /** Take back a question that could not go out as asked: the window puts
   *  it back in the input. */
  const withdraw = useCallback((turnId: string) => {
    setThread((prev) => prev.filter((turn) => turn.id !== turnId))
  }, [])

  const send = useCallback(
    async (
      rawText: string,
      images: ImageInputAttachment[] = []
    ): Promise<boolean> => {
      const text = rawText.trim()
      if (!text && images.length === 0) return false
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
        {
          id: turnId,
          role: "user",
          text,
          ...(images.length > 0 ? { images } : {}),
          state: "sent",
        },
      ])
      // An agent that takes no images: refuse the question rather than drop
      // its images on the floor.
      const refusesImages = async () =>
        images.length > 0 &&
        !(await waitForImageSupport(
          store,
          keyRef.current,
          IMAGE_SUPPORT_SETTLE_MS
        ))

      // Follow-up on the session the window already talks to.
      const bound = bindingRef.current
      if (bound) {
        if (await refusesImages()) {
          withdraw(turnId)
          setError({ code: "images_unsupported", detail: null })
          return false
        }
        const live = store.getConnection(keyRef.current)
        const route = routeQuickAskSend({
          target: bound.target,
          status: live?.status ?? null,
          // A steer is a note: it needs words (images may ride along).
          steerable: text.length > 0 && (await canSteer(bound)),
        })
        try {
          await deliver(route, turnId, text, images, bound)
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
            keyRef.current,
            CONNECT_READY_TIMEOUT_MS
          )
        } catch (e) {
          updateTurn(turnId, "failed")
          setError({ code: "connect_failed", detail: describeError(e) })
          return true
        }
        if (await refusesImages()) {
          withdraw(turnId)
          setError({ code: "images_unsupported", detail: null })
          return false
        }
        const live = store.getConnection(keyRef.current)
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
          const title = titleFromQuestion(text, images)
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
          new Set([keyRef.current])
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
          steerable: text.length > 0 && (await canSteer(next)),
        })
        await deliver(route, turnId, text, images, next)
      } catch (e) {
        updateTurn(turnId, "failed")
        setError({ code: "send_failed", detail: describeError(e) })
      } finally {
        setStarting(false)
      }
      return true
    },
    [
      actions,
      canSteer,
      deliver,
      onFolderUsed,
      onSessionUsed,
      prepare,
      store,
      updateTurn,
      withdraw,
    ]
  )

  // Settle each reply: when the agent leaves `prompting`, keep its final
  // message in the thread, then send the next queued question.
  const lastStatusRef = useRef(conn.status)
  useEffect(() => {
    const previous = lastStatusRef.current
    lastStatusRef.current = conn.status
    if (previous !== "prompting" || conn.status === "prompting") return
    const finished = store.getConnection(keyRef.current)?.liveMessage
    if (
      bindingRef.current &&
      finished &&
      !committedLiveIdsRef.current.has(finished.id)
    ) {
      committedLiveIdsRef.current.add(finished.id)
      setThread((prev) =>
        insertReplyBeforeQueued(prev, {
          id: `reply-${finished.id}`,
          role: "assistant",
          message: finished,
          durationMs: Math.max(0, Date.now() - finished.startedAt),
        })
      )
    }
    const bound = bindingRef.current
    const nextQueued = queueRef.current.shift()
    if (bound && nextQueued && conn.status === "connected") {
      void deliver(
        "send",
        nextQueued.turnId,
        nextQueued.text,
        nextQueued.images,
        bound
      ).catch((e: unknown) => {
        updateTurn(nextQueued.turnId, "failed")
        setError({ code: "send_failed", detail: describeError(e) })
      })
    }
  }, [conn.status, deliver, store, updateTurn])

  const cancel = useCallback(async () => {
    queueRef.current = []
    await actions.cancel(keyRef.current)
  }, [actions])

  /**
   * "New question": drop the thread and let go of the session. A private
   * question is deleted outright — agent disconnected, scratch directory,
   * uploaded images and any leftover transcript removed. A saved
   * conversation keeps running in the background if it is mid-reply (its
   * answer lands in the conversation).
   */
  const clear =
    useCallback(async (): Promise<PrivateQuickAskCleanup | null> => {
      const bound = bindingRef.current
      const privateDir = privateDirRef.current
      const live = store.getConnection(keyRef.current)
      const oldKey = keyRef.current
      const oldBucket = uploadBucketRef.current
      const nextGeneration = generationRef.current + 1
      generationRef.current = nextGeneration
      keyRef.current = quickAskContextKey(nextGeneration)
      setGeneration(nextGeneration)
      const nextBucket = newQuickAskUploadBucket()
      uploadBucketRef.current = nextBucket
      setUploadBucket(nextBucket)
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
        await actions.disconnect(oldKey)
        try {
          report = await discardPrivateQuickAsk(
            privateDir,
            agent,
            sessionId,
            oldBucket
          )
        } catch (e) {
          report = { removed: [], failed: [privateDir] }
          setError({ code: "send_failed", detail: describeError(e) })
        }
        setLastCleanup(report)
      } else if (live) {
        // Idle: released now. Still answering: left running under its old
        // key until the reply lands in the conversation; the sweeps reclaim
        // it after that.
        await actions.disconnectIfIdle(oldKey)
      }
      return report
    }, [actions, store])

  // A private scratch dir prepared for a question that was never asked (the
  // user switched to another target) is discarded right away. Its upload
  // bucket stays: images already attached go with the question to the new
  // target.
  useEffect(() => {
    if (target === "private" || bindingRef.current) return
    const dir = privateDirRef.current
    if (!dir) return
    privateDirRef.current = null
    // Only the private connection itself: one for the new target may already
    // be starting under the same key.
    const live = store.getConnection(keyRef.current)
    const stop =
      live?.workingDir === dir
        ? actions.disconnect(keyRef.current)
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
      const live = store.getConnection(keyRef.current)
      void actions.disconnect(keyRef.current).catch(() => false)
      void discardPrivateQuickAsk(
        dir,
        live?.agentType ?? null,
        live?.sessionId ?? null,
        uploadBucketRef.current
      ).catch(() => {})
    }
    window.addEventListener("pagehide", onPageHide)
    return () => window.removeEventListener("pagehide", onPageHide)
  }, [actions, store])

  /** Change the model / effort of the running session without saving it as
   *  the workspace's per-agent pick. */
  const setConfigOption = useCallback(
    async (configId: string, valueId: string) => {
      const live = store.getConnection(keyRef.current)
      if (!live || live.isViewer) return
      if (live.status !== "connected" && live.status !== "prompting") return
      await actions.setConfigOption(keyRef.current, configId, valueId, {
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
      contextKey,
      uploadBucket,
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
      contextKey,
      uploadBucket,
      prepare,
      send,
      cancel,
      clear,
      setConfigOption,
    ]
  )
}

export type QuickAskSession = ReturnType<typeof useQuickAskSession>
