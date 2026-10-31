/**
 * The window side of a Talk on this Mac: a plain class (no React) between one
 * conversation tab and the native helper.
 *
 * Toward the helper it turns the tab's live state into exactly what the
 * iPhone's controller expects (`SessionTalkObserver`): the port (the session
 * and its waiting cards) as it changes, the live turn's main-thread text and
 * each turn's end (`live-text.ts`), turns the agent wrote outside a turn
 * (`background_activity`), and the pending items of the session's
 * sub-agents. It is fed by the connection store's per-key subscription and
 * the raw event stream, never by React renders, so a hidden window keeps up.
 *
 * Toward the session it carries out the helper's requests the way the tab
 * would: a spoken message goes through the tab's own send pipeline (a
 * registered `TalkSendAdapter`: prompt, insert into the turn, or the queue,
 * marked spoken), cards are answered with the same actions the cards use,
 * Talk mode is switched on the session's own backend, and presence says
 * `talking` to a remote server while the person talks.
 *
 * Messages to the helper are queued and sent in order, a batch per call.
 */

import type { ConnectionStoreApi } from "@/contexts/acp-connections-context"
import type {
  EventEnvelope,
  MessageTurn,
  PendingItem,
  PlanApprovalAnswer,
  PlanApprovalDecision,
  QuestionAnswer,
  TalkSettings,
} from "@/lib/types"
import type { TalkVoiceApi } from "./api"
import type { TalkSendAdapter } from "./adapters"
import { LiveTurnTracker, type TalkTimers } from "./live-text"
import { portChanges, portSnapshot } from "./port-snapshot"
import {
  controlMessage,
  parseEnvelope,
  parseHelperMessage,
  responseMessage,
  TALK_PROTOCOL_VERSION,
  type HelperMessage,
  type TalkControl,
  type TalkFlags,
  type TalkItemRef,
  type TalkLevel,
  type TalkPort,
  type TalkRequest,
  type TalkStartMessage,
  type TalkUiState,
  type TalkWirePrefs,
  type WindowMessage,
} from "./protocol"

/** The cards' own actions, by the tab's context key. */
export interface TalkBridgeActions {
  respondPermission(
    contextKey: string,
    requestId: string,
    optionId: string
  ): Promise<void>
  answerQuestion(
    contextKey: string,
    questionId: string,
    answer: QuestionAnswer
  ): Promise<void>
  answerPlanApproval(
    contextKey: string,
    approvalId: string,
    answer: PlanApprovalAnswer
  ): Promise<void>
  cancel(contextKey: string): Promise<void>
  /** Keep the tab's connection open while Talk holds it. */
  registerLiveSurfaceKeys(source: string, keys: Set<string>): void
}

/** The session's own backend (local, or the remote server). */
export interface TalkBridgeBackend {
  setTalkMode(conversationId: number, enabled: boolean): Promise<void>
  fetchSettings(): Promise<TalkSettings | null>
  respondItem(item: TalkItemRef, optionId: string): Promise<void>
  answerItem(item: TalkItemRef, answer: QuestionAnswer): Promise<void>
  answerItemPlan(
    item: TalkItemRef,
    decision: PlanApprovalDecision,
    feedback: string | null
  ): Promise<void>
  /** Talk's tuning report (`talk_lab`), stored with the session's backend. */
  uploadReport(report: Record<string, unknown>): Promise<void>
}

export interface TalkBridgeSources {
  store: Pick<ConnectionStoreApi, "getConnection" | "subscribeKey">
  pendingItems: {
    get(): PendingItem[]
    subscribe(onChange: () => void): () => void
  }
  title(): string | null
  folder(): string | null
  /** The tab's send pipeline, looked up when a message is said. */
  adapter(): TalkSendAdapter | null
}

export interface TalkBridgeOptions {
  conversationId: number
  /** The conversation tab's id, its connection's context key. */
  contextKey: string
  /** The session runs on this Mac's own backend. */
  local: boolean
  api: TalkVoiceApi
  actions: TalkBridgeActions
  backend: TalkBridgeBackend
  sources: TalkBridgeSources
  /** Presence `talking` (a remote session's; Rust reports a local one). */
  setTalking(conversationId: number | null): void
  timers?: TalkTimers
  graceMs?: number
  onUi?(state: TalkUiState): void
  onLevel?(level: TalkLevel): void
  onFlags?(flags: TalkFlags): void
  /** The Talk let go (the helper's `ended`, or Rust's for it). Once. */
  onEnded?(ended: { reason: string; error: string | null }): void
}

/** What `start` carries besides the session itself. */
export type TalkBridgeStart = Pick<
  TalkStartMessage,
  "settings" | "voice" | "app"
> & { prefs: TalkWirePrefs }

/** The name Talk holds the tab's connection open under
 *  (`registerLiveSurfaceKeys`). */
const LIVE_SURFACE_SOURCE = "talk-voice"

/** A sub-agent's waiting item of this conversation. */
export function isSubAgentItem(item: PendingItem, conversationId: number) {
  return (
    item.root_conversation_id === conversationId &&
    item.conversation_id !== conversationId
  )
}

type BridgePhase = "idle" | "starting" | "running" | "ended"

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

export class TalkBridge {
  readonly conversationId: number
  readonly contextKey: string
  private phase: BridgePhase = "idle"
  private talkId: number | null = null
  private readonly tracker: LiveTurnTracker
  private lastPort: TalkPort | null = null
  private lastItems = ""
  private readonly sentTurns = new Map<string, string>()
  private readonly seenEvents = new Set<string>()
  private readonly unsubscribe: (() => void)[] = []
  /** Helper messages that came before `start` answered with the Talk id. */
  private early: unknown[] = []
  private outbox: WindowMessage[] = []
  private flushing = false
  private endedReported = false

  constructor(private readonly options: TalkBridgeOptions) {
    this.conversationId = options.conversationId
    this.contextKey = options.contextKey
    this.tracker = new LiveTurnTracker(
      options.conversationId,
      (message) => this.post(message),
      options.timers,
      options.graceMs
    )
  }

  get id(): number | null {
    return this.talkId
  }

  get running(): boolean {
    return this.phase === "running"
  }

  /** Start the Talk; resolves with its id once the helper took it. */
  async start(init: TalkBridgeStart): Promise<number> {
    if (this.phase !== "idle") throw new Error("this Talk already started")
    this.phase = "starting"
    const { api, sources, actions } = this.options
    // Listen first: the helper answers the start before the call returns.
    this.unsubscribe.push(
      await api.onMessage((payload) => this.onHelperPayload(payload))
    )
    if (this.phase !== "starting") {
      this.teardown()
      throw new Error("Talk ended as it started")
    }
    const conn = sources.store.getConnection(this.contextKey)
    const port = portSnapshot(conn, sources.title())
    const live = this.tracker.prime(conn)
    const items = this.subAgentItems()
    const message: TalkStartMessage = {
      type: "start",
      protocol: TALK_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      title: sources.title(),
      folder: sources.folder(),
      settings: init.settings,
      prefs: init.prefs,
      voice: init.voice,
      port,
      live,
      items,
      app: init.app,
    }
    let started: { talkId: number }
    try {
      started = await api.start(
        this.conversationId,
        this.options.local,
        message
      )
    } catch (error) {
      this.teardown()
      throw error
    }
    if (this.phase !== "starting") {
      // Ended (or stopped) while it was starting.
      void api.stop(started.talkId).catch(() => {})
      throw new Error("Talk ended as it started")
    }
    this.talkId = started.talkId
    this.lastPort = port
    this.lastItems = JSON.stringify(items)
    this.phase = "running"
    actions.registerLiveSurfaceKeys(
      LIVE_SURFACE_SOURCE,
      new Set([this.contextKey])
    )
    this.unsubscribe.push(
      sources.store.subscribeKey(this.contextKey, () => this.onConnection())
    )
    this.unsubscribe.push(sources.pendingItems.subscribe(() => this.onItems()))
    // Whatever changed while the start was on its way.
    this.onConnection()
    this.onItems()
    const early = this.early
    this.early = []
    for (const payload of early) this.onHelperPayload(payload)
    void this.flush()
    return started.talkId
  }

  /** A raw ACP event of this window (the `useAcpEvent` host feeds it). */
  onEnvelope(envelope: EventEnvelope): void {
    if (this.phase !== "running") return
    const conn = this.options.sources.store.getConnection(this.contextKey)
    if (!conn || envelope.connection_id !== conn.connectionId) return
    // Web and remote windows deliver an event once per surface key.
    const key = `${envelope.connection_id}:${envelope.seq}`
    if (this.seenEvents.has(key)) return
    this.seenEvents.add(key)
    if (this.seenEvents.size > 512) {
      const oldest = this.seenEvents.values().next().value
      if (oldest !== undefined) this.seenEvents.delete(oldest)
    }
    switch (envelope.type) {
      case "turn_complete":
        // The reducer already moved the status; the final text is in.
        this.tracker.update(conn)
        this.tracker.turnComplete(envelope.stop_reason || null)
        break
      case "background_activity":
        this.backgroundTurns(envelope.turns)
        break
      default:
        break
    }
  }

  /** A dock button or a choice (`control`). */
  control(control: TalkControl): void {
    this.post(controlMessage(control))
  }

  /** The stored preferences changed (`handsFree` applies at once). */
  updatePrefs(prefs: Partial<TalkWirePrefs>): void {
    this.post({ type: "prefs", prefs })
  }

  /** The server's Talk settings changed. */
  updateSettings(settings: TalkSettings): void {
    this.post({ type: "settings", settings })
  }

  /** End the Talk. The helper's `ended` finishes it; without a Talk id yet,
   *  it is finished here. */
  async stop(): Promise<void> {
    if (this.phase === "ended") return
    if (this.phase !== "running" || this.talkId === null) {
      this.finish({ reason: "stopped", error: null })
      return
    }
    try {
      await this.options.api.stop(this.talkId)
    } catch (error) {
      console.warn("[TalkBridge] stop:", error)
      this.finish({ reason: "stopped", error: null })
    }
  }

  /** Let go without telling the helper (the window is going away). */
  dispose(): void {
    if (this.phase === "ended") return
    this.teardown()
  }

  // ── The session → the helper ──

  private onConnection(): void {
    if (this.phase !== "running") return
    const { sources } = this.options
    const conn = sources.store.getConnection(this.contextKey)
    const port = portSnapshot(conn, sources.title())
    const changes = portChanges(this.lastPort, port)
    this.lastPort = port
    if (changes) this.post({ type: "port", ...changes })
    this.tracker.update(conn)
  }

  private subAgentItems(): PendingItem[] {
    return this.options.sources.pendingItems
      .get()
      .filter((item) => isSubAgentItem(item, this.conversationId))
  }

  private onItems(): void {
    if (this.phase !== "running") return
    const items = this.subAgentItems()
    const key = JSON.stringify(items)
    if (key === this.lastItems) return
    this.lastItems = key
    this.post({ type: "items", items })
  }

  /** Turns written outside a turn: the new ones, and grown ones whole. */
  private backgroundTurns(turns: MessageTurn[] | undefined): void {
    if (!turns || turns.length === 0) return
    const changed = turns.filter((turn) => {
      const json = JSON.stringify(turn)
      if (this.sentTurns.get(turn.id) === json) return false
      this.sentTurns.set(turn.id, json)
      return true
    })
    if (changed.length > 0) this.post({ type: "bgTurns", turns: changed })
  }

  // ── The helper → the session ──

  private onHelperPayload(payload: unknown): void {
    if (this.phase === "ended") return
    if (this.phase === "starting" || this.talkId === null) {
      this.early.push(payload)
      return
    }
    const envelope = parseEnvelope(payload)
    if (!envelope || envelope.talkId !== this.talkId) return
    const message = parseHelperMessage(envelope.message)
    if (message) this.onHelperMessage(message)
  }

  private onHelperMessage(message: HelperMessage): void {
    switch (message.type) {
      case "state":
        this.options.onUi?.(message)
        break
      case "level":
        this.options.onLevel?.(message)
        break
      case "req":
        void this.handleRequest(message)
        break
      case "cmd":
        void this.options.actions
          .cancel(this.contextKey)
          .catch((error) => console.warn("[TalkBridge] cancel:", error))
        break
      case "flags":
        // A local session's `talking` is reported by the backend, which
        // hears the helper itself.
        if (!this.options.local) {
          this.options.setTalking(
            message.isTalking ? this.conversationId : null
          )
        }
        this.options.onFlags?.(message)
        break
      case "ended":
        this.finish({ reason: message.reason, error: message.error ?? null })
        break
      case "error":
        console.warn("[TalkBridge] the helper could not use a line:", message)
        break
      case "hello":
        break
    }
  }

  private async handleRequest(request: TalkRequest): Promise<void> {
    let result: { ok: true; value: unknown } | { ok: false; error: string }
    try {
      result = { ok: true, value: await this.perform(request) }
    } catch (error) {
      result = { ok: false, error: errorText(error) }
    }
    this.post(responseMessage(request.id, result))
  }

  /** Carry out one request; its answer's `value`. */
  private async perform(request: TalkRequest): Promise<unknown> {
    const { actions, backend, sources } = this.options
    const key = this.contextKey
    switch (request.op) {
      case "sendSpoken": {
        const adapter = sources.adapter()
        if (!adapter) throw new Error("the session's tab is not open")
        return await adapter.sendSpoken(request.text)
      }
      case "respondPermission":
        await actions.respondPermission(
          key,
          request.requestId,
          request.optionId
        )
        return true
      case "answerQuestion":
        await actions.answerQuestion(key, request.questionId, request.answer)
        return true
      case "declineQuestion":
        await actions.answerQuestion(key, request.questionId, {
          answers: [],
          declined: true,
        })
        return true
      case "answerPlanApproval":
        await actions.answerPlanApproval(key, request.approvalId, {
          decision: request.decision,
          feedback: request.feedback ?? null,
        })
        return true
      case "setTalkMode":
        await backend.setTalkMode(this.conversationId, request.enabled)
        return true
      case "fetchSettings":
        return (await backend.fetchSettings()) ?? null
      case "respondItem":
        await backend.respondItem(request.item, request.optionId)
        return true
      case "answerItem":
        await backend.answerItem(request.item, request.answer)
        return true
      case "answerItemPlan":
        await backend.answerItemPlan(
          request.item,
          request.decision,
          request.feedback ?? null
        )
        return true
      case "uploadReport":
        await backend.uploadReport(request.report)
        return true
    }
  }

  // ── Plumbing ──

  /** Queue a message for the helper; sent in order, a batch per call. */
  private post(message: WindowMessage): void {
    if (this.phase === "ended") return
    this.outbox.push(message)
    if (this.phase === "running") void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.talkId === null) return
    this.flushing = true
    try {
      while (this.outbox.length > 0 && this.phase === "running") {
        const batch = this.outbox
        this.outbox = []
        try {
          await this.options.api.send(this.talkId, batch)
        } catch (error) {
          // The Talk is gone (its `ended` is on its way) or the helper
          // stopped: nothing more can be delivered.
          console.warn("[TalkBridge] send:", error)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private finish(ended: { reason: string; error: string | null }): void {
    if (this.phase === "ended") return
    this.teardown()
    if (this.endedReported) return
    this.endedReported = true
    this.options.onEnded?.(ended)
  }

  private teardown(): void {
    this.phase = "ended"
    for (const off of this.unsubscribe.splice(0)) {
      try {
        off()
      } catch {
        // Already gone.
      }
    }
    this.tracker.dispose()
    this.outbox = []
    this.early = []
    this.options.setTalking(null)
    this.options.actions.registerLiveSurfaceKeys(LIVE_SURFACE_SOURCE, new Set())
  }
}
