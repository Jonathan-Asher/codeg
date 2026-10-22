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
  canDeliverIntoHeldTurn,
  shouldDrainIntoHeldTurn,
} from "@/lib/background-idle"
import { flushRetryDelayMs } from "@/lib/queue-flush"
import { classifySendError, nextSendFailure } from "@/lib/send-failure"
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

/**
 * A question waiting for the session to take it. The thread shows it as
 * `queued` for exactly as long as it sits here.
 */
export interface QueuedQuestion {
  turnId: string
  text: string
  images: ImageInputAttachment[]
  /**
   * Wait for the END of the turn, not merely for the agent to go idle in a
   * turn held open for background work: its delivery into that turn failed
   * outright, so it goes out as an ordinary prompt once the turn is over
   * (the composer's `QueuedMessage.holdUntilTurnEnd`).
   */
  holdUntilTurnEnd?: boolean
}

/** The client message id a question is sent under, on every attempt: the
 *  server answers a repeat of it as a duplicate instead of a second turn. */
export function questionClientId(turnId: string): string {
  return `optimistic-${turnId}`
}

/** Automatic resends of one question after failures that only mean "the
 *  server could not be reached", before it waits for Retry. */
const MAX_QUESTION_AUTO_RESENDS = 5

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
  const threadRef = useRef(thread)
  useEffect(() => {
    threadRef.current = thread
  }, [thread])
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
  // The questions waiting for the session, oldest first. The ref is the
  // authoritative copy (async paths read it the moment they run); the version
  // bump re-runs the drain below on every change.
  const queueRef = useRef<QueuedQuestion[]>([])
  const [queueVersion, setQueueVersion] = useState(0)
  const setQueue = useCallback((next: QueuedQuestion[]) => {
    queueRef.current = next
    setQueueVersion((v) => v + 1)
  }, [])
  // The turn of the question the drain has on the wire right now (a prompt,
  // or a delivery into a held turn), or null. Nothing else leaves the queue
  // until it settles, so no question can go out twice.
  const drainingRef = useRef<string | null>(null)
  // Identifies the drain in flight, so one that settles after "New question"
  // moved on cannot release the next question's drain.
  const drainTokenRef = useRef(0)
  const [drainVersion, setDrainVersion] = useState(0)
  // When the drain last sent a prompt or saw one bounce. The next prompt waits
  // out `flushRetryDelayMs` from here, so a session that still reads idle a
  // moment after a send (its "prompting" not in yet), or that keeps bouncing,
  // is retried at a bounded rate instead of being hammered.
  const lastDrainAttemptAtRef = useRef(0)
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

  // Failed questions on a recorded session that go out again by themselves
  // once the session is connected (turn id -> automatic resends so far). Only
  // reachability failures qualify, and only where the question carries an id
  // the server dedupes (not a private question): a resend after a lost answer
  // is then never a second turn. Everything else waits for Retry.
  const autoResendAttemptsRef = useRef(new Map<string, number>())
  const autoResendDueRef = useRef(new Set<string>())
  const [autoResendVersion, setAutoResendVersion] = useState(0)
  const noteFailedQuestion = useCallback((turnId: string, error: unknown) => {
    if (bindingRef.current?.target === "private") return
    const failure = nextSendFailure(error, undefined)
    if (!failure.autoRetry || classifySendError(error).reason === "server") {
      return
    }
    const attempts = autoResendAttemptsRef.current.get(turnId) ?? 0
    if (attempts >= MAX_QUESTION_AUTO_RESENDS) return
    autoResendAttemptsRef.current.set(turnId, attempts + 1)
    autoResendDueRef.current.add(turnId)
    setAutoResendVersion((v) => v + 1)
  }, [])

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

  /** Put a question at the end of the line. */
  const enqueue = useCallback(
    (question: QueuedQuestion) => {
      setQueue([...queueRef.current, question])
      updateTurn(question.turnId, "queued")
    },
    [setQueue, updateTurn]
  )

  /** Steer a question into the turn running now. Images ride along as the
   *  steer's blocks, as the composer's mid-turn send does; plain text stays a
   *  plain note. */
  const steerInto = useCallback(
    async (
      connectionId: string,
      text: string,
      images: ImageInputAttachment[],
      caps: PromptCapabilitiesInfo | undefined,
      clientId?: string
    ) => {
      if (images.length > 0) {
        await submitSessionFeedback(
          connectionId,
          text,
          questionBlocks(text, images, caps),
          clientId
        )
      } else {
        await submitSessionFeedback(connectionId, text, null, clientId)
      }
    },
    []
  )

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
        enqueue({ turnId, text, images })
        return
      }
      const live = store.getConnection(keyRef.current)
      if (route === "steer" && live) {
        try {
          await steerInto(
            live.connectionId,
            text,
            images,
            live.promptCapabilities,
            questionClientId(turnId)
          )
          updateTurn(turnId, "steered")
          return
        } catch (e) {
          if (!isNoActiveTurnRejection(e)) throw e
          // The reply ended in the meantime: it is an ordinary prompt now,
          // and the queue sends it as soon as the session takes one, behind
          // anything that was already waiting.
          enqueue({ turnId, text, images })
          return
        }
      }
      try {
        await actions.sendPrompt(
          keyRef.current,
          questionBlocks(text, images, live?.promptCapabilities),
          {
            ...promptOptionsFor(promptTargetOf(b)),
            clientMessageId: questionClientId(turnId),
          }
        )
        updateTurn(turnId, "sent")
      } catch (e) {
        if (e instanceof TurnBusyError) {
          // Another client started a turn first: wait for it, like the
          // composer's queue does. The bounce is stamped so the drain retries
          // at a bounded rate if this window still reads the session as idle.
          lastDrainAttemptAtRef.current = Date.now()
          enqueue({ turnId, text, images })
          return
        }
        throw e
      }
    },
    [actions, enqueue, promptTargetOf, steerInto, store, updateTurn]
  )

  /** Take back a question that could not go out as asked: the window puts
   *  it back in the input. */
  const withdraw = useCallback((turnId: string) => {
    setThread((prev) => prev.filter((turn) => turn.id !== turnId))
  }, [])

  /** Where a question for the bound session goes right now. */
  const routeFor = useCallback(
    async (b: QuickAskBinding, text: string): Promise<QuickAskSendRoute> => {
      // A steer is a note: it needs words (images may ride along).
      const steerable = text.length > 0 && (await canSteer(b))
      // Everything else is read after that await, which can be a round trip.
      const live = store.getConnection(keyRef.current)
      return routeQuickAskSend({
        target: b.target,
        status: live?.status ?? null,
        steerable,
        heldTurnReady:
          text.length > 0 &&
          live != null &&
          canDeliverIntoHeldTurn({
            status: live.status,
            awaitingBackground: live.awaitingBackground,
            nativeSteering: live.nativeSteering,
          }),
        // A question the drain has on the wire counts as waiting.
        queued: queueRef.current.length > 0 || drainingRef.current != null,
      })
    },
    [canSteer, store]
  )

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
        try {
          await deliver(
            await routeFor(bound, text),
            turnId,
            text,
            images,
            bound
          )
        } catch (e) {
          updateTurn(turnId, "failed")
          noteFailedQuestion(turnId, e)
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
        await deliver(await routeFor(next, text), turnId, text, images, next)
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
      deliver,
      noteFailedQuestion,
      onFolderUsed,
      onSessionUsed,
      prepare,
      routeFor,
      store,
      updateTurn,
      withdraw,
    ]
  )

  // Settle each reply: when the agent leaves `prompting`, keep its final
  // message in the thread. Sending what waits behind it is the drain's job
  // (below), which runs after this in the same commit.
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
  }, [conn.status, store])

  /** Mark the drain idle again (if `token` is still the drain in flight) and
   *  let it look at the queue once more. */
  const settleDrain = useCallback((token: number) => {
    if (drainTokenRef.current !== token) return
    drainingRef.current = null
    setDrainVersion((v) => v + 1)
  }, [])

  /**
   * Send the oldest waiting question as an ordinary prompt. Runs only while
   * the session is idle; re-checks that at the moment it runs, since it is
   * scheduled from a timer.
   */
  const sendQueueHead = useCallback(() => {
    if (drainingRef.current != null) return
    const b = bindingRef.current
    const key = keyRef.current
    const live = store.getConnection(key)
    if (!b || live?.status !== "connected") return
    const [next, ...rest] = queueRef.current
    if (!next) return
    setQueue(rest)
    const token = ++drainTokenRef.current
    const generation = generationRef.current
    drainingRef.current = next.turnId
    lastDrainAttemptAtRef.current = Date.now()
    void (async () => {
      try {
        await actions.sendPrompt(
          key,
          questionBlocks(next.text, next.images, live.promptCapabilities),
          {
            ...promptOptionsFor(promptTargetOf(b)),
            clientMessageId: questionClientId(next.turnId),
          }
        )
        updateTurn(next.turnId, "sent")
      } catch (e) {
        if (generationRef.current !== generation) return
        if (e instanceof TurnBusyError) {
          // A turn started first (another window on the same session, or one
          // this window has not heard about yet). It was the head, so it goes
          // back to the FRONT and retries once the session is idle again.
          lastDrainAttemptAtRef.current = Date.now()
          setQueue([next, ...queueRef.current])
          return
        }
        updateTurn(next.turnId, "failed")
        noteFailedQuestion(next.turnId, e)
        setError({ code: "send_failed", detail: describeError(e) })
      } finally {
        settleDrain(token)
      }
    })()
  }, [
    actions,
    noteFailedQuestion,
    promptTargetOf,
    setQueue,
    settleDrain,
    store,
    updateTurn,
  ])

  /**
   * Deliver the oldest waiting question into a turn held open only for
   * background work, the way the composer drains its queue into one (see
   * `lib/background-idle.ts`): the agent is idle, so it reads the question
   * now instead of after the background work, which can run for an hour. The
   * question stays queued until the delivery is confirmed.
   */
  const deliverQueueHead = useCallback(() => {
    if (drainingRef.current != null) return
    const live = store.getConnection(keyRef.current)
    const head = queueRef.current[0]
    if (!live || !head) return
    const token = ++drainTokenRef.current
    const generation = generationRef.current
    drainingRef.current = head.turnId
    void steerInto(
      live.connectionId,
      head.text,
      head.images,
      live.promptCapabilities,
      questionClientId(head.turnId)
    )
      .then(() => {
        if (generationRef.current !== generation) return
        setQueue(queueRef.current.filter((q) => q.turnId !== head.turnId))
        updateTurn(head.turnId, "steered")
      })
      .catch(() => {
        if (generationRef.current !== generation) return
        // It goes out as an ordinary prompt once the turn is over, keeping
        // its place (everything behind it waits too), and is not delivered
        // again meanwhile: either the backend said the turn already ended —
        // the idle drain sends it as soon as this window sees that too — or
        // the delivery would fail the same way again.
        setQueue(
          queueRef.current.map((q) =>
            q.turnId === head.turnId ? { ...q, holdUntilTurnEnd: true } : q
          )
        )
      })
      .finally(() => settleDrain(token))
  }, [setQueue, settleDrain, steerInto, store, updateTurn])

  /** The session is gone (the agent exited or failed): nothing waiting can be
   *  sent any more, so say so instead of showing it queued forever. */
  const abandonQueue = useCallback(
    (detail: string | null) => {
      const waiting = new Set(queueRef.current.map((q) => q.turnId))
      if (waiting.size === 0) return
      // Lost with the connection, not refused: sent again by themselves
      // once the session is back (see `noteFailedQuestion`).
      for (const turnId of waiting) {
        noteFailedQuestion(turnId, new Error("connection not found: lost"))
      }
      setQueue([])
      setThread((prev) =>
        prev.map((turn) =>
          turn.role === "user" && waiting.has(turn.id)
            ? { ...turn, state: "failed" }
            : turn
        )
      )
      setError({ code: "send_failed", detail })
    },
    [noteFailedQuestion, setQueue]
  )

  const heldTurnReady = canDeliverIntoHeldTurn({
    status: conn.status,
    awaitingBackground: conn.awaitingBackground,
    nativeSteering: conn.nativeSteering,
  })

  /** Send a failed question again: it joins the queue (same turn, same
   *  client id), which sends it as soon as the session takes one. */
  const retryQuestion = useCallback(
    (turnId: string) => {
      if (queueRef.current.some((q) => q.turnId === turnId)) return
      const turn = threadRef.current.find((t) => t.id === turnId)
      if (!turn || turn.role !== "user" || turn.state !== "failed") return
      setError(null)
      setQueue([
        ...queueRef.current,
        { turnId, text: turn.text, images: turn.images ?? [] },
      ])
      updateTurn(turnId, "queued")
    },
    [setQueue, updateTurn]
  )

  // Resend the failed questions marked above once the session is connected
  // again (and the window still talks to it).
  useEffect(() => {
    if (!binding || binding.target === "private") return
    if (conn.status !== "connected") return
    if (autoResendDueRef.current.size === 0) return
    const due = threadRef.current.filter(
      (turn) =>
        turn.role === "user" &&
        turn.state === "failed" &&
        autoResendDueRef.current.has(turn.id)
    )
    if (due.length === 0) return
    const timer = setTimeout(
      () => {
        for (const turn of due) {
          autoResendDueRef.current.delete(turn.id)
          retryQuestion(turn.id)
        }
      },
      flushRetryDelayMs(Date.now(), lastDrainAttemptAtRef.current)
    )
    return () => clearTimeout(timer)
  }, [autoResendVersion, binding, conn.status, retryQuestion, thread])

  /**
   * The queue's send engine — level-triggered, like the composer's: whenever
   * the session is idle and a question waits, the oldest one goes out. It
   * does not wait for a prompting → idle edge, so a question that lands in the
   * queue after the edge passed (a send that bounced because another window
   * started a turn, a steer that lost the race with the turn's end, a route
   * decided while the reply was finishing) still goes out, and Stop sends
   * what waits once the reply has stopped, as it does in the workspace. One
   * question at a time: the next waits until the drain in flight settles.
   */
  useEffect(() => {
    if (!binding || drainingRef.current != null) return
    const head = queueRef.current[0]
    if (!head) return
    const status = conn.status
    if (status === "error" || status === "disconnected") {
      abandonQueue(store.getConnection(keyRef.current)?.error ?? status)
      return
    }
    if (status === "connected") {
      const timer = setTimeout(
        sendQueueHead,
        flushRetryDelayMs(Date.now(), lastDrainAttemptAtRef.current)
      )
      return () => clearTimeout(timer)
    }
    if (
      status === "prompting" &&
      binding.target !== "private" &&
      head.text.length > 0 &&
      shouldDrainIntoHeldTurn({
        canDeliverNow: heldTurnReady,
        head: { id: head.turnId, holdUntilTurnEnd: head.holdUntilTurnEnd },
        busy: false,
        editingItemId: null,
      })
    ) {
      deliverQueueHead()
    }
  }, [
    abandonQueue,
    binding,
    conn.status,
    deliverQueueHead,
    drainVersion,
    heldTurnReady,
    queueVersion,
    sendQueueHead,
    store,
  ])

  /**
   * Take a waiting question back out of the queue (and the thread). Returns it
   * so the window can put it back in the input, or null when it already left:
   * a question on its way out cannot be recalled.
   */
  const unqueue = useCallback(
    (turnId: string): QueuedQuestion | null => {
      if (drainingRef.current === turnId) return null
      const question = queueRef.current.find((q) => q.turnId === turnId)
      if (!question) return null
      setQueue(queueRef.current.filter((q) => q.turnId !== turnId))
      setThread((prev) => prev.filter((turn) => turn.id !== turnId))
      return question
    },
    [setQueue]
  )

  // Stop ends the reply being written, nothing more: questions still waiting
  // go out once it has stopped, as the workspace composer's queue does.
  const cancel = useCallback(async () => {
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
      setQueue([])
      drainingRef.current = null
      drainTokenRef.current += 1
      lastDrainAttemptAtRef.current = 0
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
    }, [actions, setQueue, store])

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
      unqueue,
      retryQuestion,
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
      unqueue,
      retryQuestion,
      clear,
      setConfigOption,
    ]
  )
}

export type QuickAskSession = ReturnType<typeof useQuickAskSession>
