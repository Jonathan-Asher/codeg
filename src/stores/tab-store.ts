import { useMemo } from "react"
import {
  folderScope,
  useFolderTabsStore,
  type TabScope,
} from "@/stores/folder-tabs-store"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { prewarmConversationsFromDisk } from "@/stores/conversation-runtime-store"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  getFolderConversation,
  listOpenedTabs,
  saveOpenedTabs,
} from "@/lib/api"
import { resolveDefaultAgent } from "@/lib/resolve-default-agent"
import { formatConversationTitle } from "@/lib/conversation-title"
import {
  firstLeafId,
  isLayoutNode,
  leafIds,
  makeGroupId,
  neighborGroupId,
  normalizeTree,
  removeGroup,
  resizeSplitAt,
  singleGroupLayout,
  splitGroup,
  toggleOrientation,
  type LayoutNode,
  type SplitDirection,
} from "@/lib/tab-group-layout"
import {
  loadLastActiveContext,
  saveLastActiveContext,
  clearLastActiveContext,
} from "@/lib/last-active-context-storage"
import {
  buildNewConversationDraftStorageKey,
  clearMessageInputDraftV2,
  hasLiveComposerContent,
  loadMessageInputDraftV2,
  moveMessageInputDraft,
  sweepOrphanDraftKeys,
} from "@/lib/message-input-draft"
import { discardAskSelectionPrompts } from "@/lib/ask-selection-handoff"
import { discardComposerPrefill } from "@/lib/composer-prefill-handoff"
import {
  clearContinuationLink,
  moveContinuationLink,
} from "@/lib/continuation-links"
import { noteTabActivation, requestComposerFocus } from "@/lib/composer-focus"
import {
  batchCloseSlots,
  pushClosedTab,
  snapshotStripTab,
} from "@/lib/closed-tab-stack"
import { hasOpenMessageEdit } from "@/lib/open-message-edits"
import type {
  AgentType,
  ConversationChange,
  ConversationStatus,
  DbConversationSummary,
  OpenedTab,
  TabsChanged,
} from "@/lib/types"

/**
 * Workspace tab state as a Zustand store. Replaces the former single
 * merged-value `TabContext`, whose value changed identity on every tab/status
 * update and re-rendered all ~20 consumers (including every keep-alive
 * `ConversationTabView`, which reads the context internally and so could not be
 * memo-blocked). Consumers now subscribe to the narrowest slice they render via
 * `useTabStore(selector)` / `useTabActions()`.
 *
 * The store owns all state, the cross-derive-stable `tabs` derivation, and every
 * mutation + orchestration action (hydration, debounced CAS save, cross-client
 * `tabs://changed` apply, sub-session summary seeding, provisional-agent
 * correction, post-hydration recovery). `TabRuntimeEffects` (in
 * `contexts/tab-context.tsx`) is a thin component that injects the React-land
 * dependencies (i18n labels, `activateConversationPane`, `acpDisconnect`, the
 * agent availability list) and drives the effects that need a React lifecycle
 * (platform subscriptions, timers, gates).
 */

/**
 * What a sub-agent tab shows: the thread of the Claude Code sub-agent that an
 * Agent call in a conversation's transcript launched, read from the
 * sub-agent's own transcript (`get_claude_subagent_thread`). A sub-agent has
 * no conversation row of its own, so the tab is keyed by the call.
 */
export interface SubagentTabTarget {
  /** The conversation whose transcript holds the Agent call. */
  parentConversationId: number
  /** The Agent call (its `tool_use` id). */
  toolCallId: string
  /** The sub-agent's `agentId`, once known: it names its transcript. */
  agentId?: string | null
  /** `general-purpose`, `Explore`, … */
  subagentType?: string | null
  /** What the call asked of it, in a few words. */
  description?: string | null
}

export interface TabItemInternal {
  id: string
  /**
   * `conversation`: a session (`conversationId` set) or a draft (`null`).
   * `subagent`: a read-only view of a Claude Code sub-agent's thread
   * (`subagent`); `conversationId` stays `null`, but it is no draft — see
   * `isDraftTab`. Device-local, like a draft: never in `opened_tabs`.
   */
  kind: "conversation" | "subagent"
  folderId: number
  conversationId: number | null
  /** The runtime session key used by ConversationRuntimeContext.
   *  For new conversations this is a virtual (negative) ID that differs
   *  from the persisted `conversationId`. */
  runtimeConversationId?: number
  agentType: AgentType
  title: string
  /**
   * Not a preview: a tab the user is keeping open. A tab without it is the
   * group's preview (italic title), which the next session opened in the group
   * replaces; a double click, or starting to work in it, sets it. Synced
   * (`opened_tabs.is_pinned`). Not what the tab menu's "Pin tab" does: that is
   * `isAnchored`.
   */
  isPinned: boolean
  /**
   * Pinned to the start of the strip — the tab menu's "Pin tab", a browser's
   * pinned tab. Shown first and compact whatever the grouping or sort, dragged
   * only among the other pinned tabs, and skipped by "Close Others", "Close to
   * the Right" and "Close All" (a plain close still closes it). Implies
   * `isPinned`: a pinned tab is never a preview. Synced for conversation tabs
   * (`opened_tabs.is_anchored`); a draft's or a sub-agent tab's rides the
   * device-local group blob, like the tab itself.
   */
  isAnchored?: boolean
  workingDir?: string
  status?: ConversationStatus
  /**
   * Marks `agentType` as a system best-guess that should be replaced once
   * the agent list becomes fresh. True for draft tabs whose default came
   * from a stale localStorage seed or the AGENT_DISPLAY_ORDER fallback;
   * cleared by `confirmDraftAgent` (user click), `bindConversationTab`
   * (draft → real conversation), or the correction effect (fresh agent
   * list arrives). **Not persisted** to opened_tabs — hydrated drafts
   * default to false and are re-evaluated only when their agent_type is
   * no longer in the fresh sorted list (the `!sortedAvailableAgents.
   * includes(...)` branch of correction). Internal-only: no UI component
   * reads it, so a stale `true` value is harmless if correction never
   * runs (e.g. `acpListAgents()` keeps failing).
   */
  agentTypeProvisional?: boolean
  /**
   * Marks a tab as "chat mode" (folderless). Set by `openChatModeTab`. It
   * survives the draft binding to its conversation (`bindConversationTab`
   * spreads the tab), alongside the hidden chat folder that then also drives
   * chat-mode chrome via `useIsActiveChatMode`; it is cleared when that
   * conversation is moved into a project (`alignConversationTabFolders`).
   * **Internal-only and never persisted** — opened_tabs does not carry it, so a
   * tab restored from the server never has it. While set on a draft, the draft
   * has no resolvable folder, so the composer hides the branch picker and shows
   * the "no-folder" chip.
   */
  isChat?: boolean
  /** Set exactly on a `subagent` tab. */
  subagent?: SubagentTabTarget
}

export type TabItem = TabItemInternal

/** An unsent draft: a conversation tab with no conversation yet. A sub-agent
 *  tab has no conversation either, and is not one. */
export function isDraftTab(
  tab: Pick<TabItemInternal, "kind" | "conversationId">
): boolean {
  return tab.kind === "conversation" && tab.conversationId == null
}

/** The group's preview tab: the one the next opened session replaces. Never a
 *  pinned tab. */
export function isPreviewTab(
  tab: Pick<TabItemInternal, "isPinned" | "isAnchored">
): boolean {
  return !tab.isPinned && tab.isAnchored !== true
}

/** A read-only view of a Claude Code sub-agent's thread. */
export function isSubagentTab(
  tab: TabItemInternal
): tab is TabItemInternal & { kind: "subagent"; subagent: SubagentTabTarget } {
  return tab.kind === "subagent" && tab.subagent != null
}

/** `known` with what `update` adds; the same object when it adds nothing. */
function mergeSubagentTarget(
  known: SubagentTabTarget | undefined,
  update: Partial<SubagentTabTarget>
): SubagentTabTarget | undefined {
  if (!known) return known
  let next: SubagentTabTarget | undefined
  for (const key of ["agentId", "subagentType", "description"] as const) {
    const value = update[key]
    if (value && value !== known[key]) {
      next = { ...(next ?? known), [key]: value }
    }
  }
  return next ?? known
}

/** A sub-agent tab's id: stable across restarts, one per Agent call. */
export function makeSubagentTabId(
  parentConversationId: number,
  toolCallId: string
): string {
  return `sub-${parentConversationId}-${toolCallId}`
}

interface DraftRetargetRequest {
  tabId: string
  expectedAgent: AgentType
  folderId: number
  workingDir: string
  agentType: AgentType
  provisional: boolean
}

/**
 * What a "new conversation" open resolved to: the draft tab that ended up
 * serving the request — the freshly created one, or the target group's existing
 * draft it reused — and the identity that tab will be carrying once the open has
 * fully settled.
 *
 * `agentType`/`folderId` are a PROMISE, not necessarily the tab's state right
 * now: reusing a draft that belongs to another folder or agent retargets it
 * asynchronously (see `consumeDraftRetargets`), so the tab only takes on this
 * identity after its stale ACP session has been torn down. Callers that hand
 * work to the tab must gate on it rather than acting the moment they get the id.
 */
export interface OpenedDraftTarget {
  tabId: string
  agentType: AgentType
  folderId: number
}

/** i18n strings the store needs for seed titles, injected from `TabProvider`
 *  (the store itself is locale-agnostic). Defaults to the raw keys until the
 *  provider's first effect injects the translated values — a one-frame window
 *  that only touches cosmetic seed titles, which the `tabs` derivation then
 *  overwrites from `conversations`. */
export interface TabLabels {
  loadingConversation: string
  newConversation: string
  untitledConversation: string
}

export interface TabStoreState {
  rawTabs: TabItemInternal[]
  activeTabId: string | null
  previewReplacedTabIds: string[]
  draftRetargetRequests: DraftRetargetRequest[]
  tabsHydrated: boolean
  /**
   * IDEA-style split groups (device-local, like tile mode). `groupLayout` is
   * the splitter tree (leaves = groups); `groupOf` maps tab id → group id
   * (missing = first leaf); `groupSelection` is each group's selected tab
   * (the visible one in non-tiled mode); `tileByGroup` is the per-group tile
   * flag. Group state never enters the synced `opened_tabs` payload — it is
   * persisted to localStorage by `persistGroupState` and re-keyed to
   * canonical tab ids there so it survives restarts.
   */
  groupLayout: LayoutNode
  groupOf: Record<string, string>
  groupSelection: Record<string, string>
  tileByGroup: Record<string, boolean>
  /**
   * The group state of every tab view not on screen, by view key. While tabs
   * follow the folder each folder has its own view — its own split layout,
   * assignments, selection and tile flags — and the normal-mode view waits
   * here under "all"; the fields above always belong to the view on screen.
   * Device-local and persisted with them (see `persistGroupState`).
   */
  groupViews: Record<string, GroupView>
  /**
   * Transient cross-group tab drag (never persisted): the dragged tab, the
   * live pointer position, and the FOREIGN group currently under the pointer
   * (null while over the tab's own strip / no valid target). Drives the
   * drop-target highlight and the floating ghost chip; cleared on drag end.
   */
  tabDrag: {
    tabId: string
    title: string
    x: number
    y: number
    overGroupId: string | null
  } | null
  childSummaries: Map<number, DbConversationSummary>
  /**
   * Derived from `rawTabs` × `conversations` × `childSummaries`: tab titles and
   * status decorated from the live conversation list, with cross-derive
   * reference reuse so an update that touches no open tab keeps the array (and
   * every item's) identity stable. Recomputed on every relevant write and on
   * `conversations` change (see the module-level app-workspace subscription).
   */
  tabs: TabItemInternal[]
  /** Bumped on reconnect to re-run the child-summary reconcile. */
  reseedTick: number
  /** Bumped from a save's resolution to re-run the save effect when the local
   *  set moved while the save was in flight. */
  saveReconcileTick: number

  // ── Mutations ──────────────────────────────────────────────────────────────
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    pin?: boolean,
    title?: string,
    opts?: {
      /** rawTabs slot for a tab that needs a NEW slot (clamped); omitted =
       *  append. Reopening a closed tab passes the slot it was closed from. A
       *  conversation that is already open is focused where it is, and a
       *  preview still replaces the group's current preview in place. */
      index?: number
    }
  ) => void
  /**
   * Show a session in place of the tab `tabId`: same slot, same split group,
   * and that tab's turn left running (the replaced session is released like a
   * replaced preview: only once idle). The replaced session goes on the
   * reopen-closed-tab stack. A session already open is focused where it is
   * instead, and a tab that may not be replaced — pinned, an unsent draft with
   * something in it, a message open in its editor, another folder's slot while
   * tabs follow the folder, or gone — makes this an ordinary `openTab(…, pin)`.
   */
  replaceTabWithConversation: (
    tabId: string,
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    opts: { pin: boolean; title?: string }
  ) => void
  /**
   * `recordForReopen: false` closes without offering the tab to
   * `reopen_last_closed_tab`. Pass it whenever the tab is going away because
   * its conversation no longer exists — resurrecting it would mint a tab (and
   * an `opened_tabs` row) pointing at a deleted conversation.
   */
  closeTab: (tabId: string, options?: { recordForReopen?: boolean }) => void
  closeConversationTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType
  ) => void
  /** Closes the rest of the tab's group, except the pinned tabs. */
  closeOtherTabs: (tabId: string) => void
  /**
   * "Close to the Right": closes the tabs listed after `tabId` in `shownOrder`
   * (the strip's display order, which only the strip knows: it depends on the
   * grouping and sort), except the pinned ones.
   */
  closeTabsToRight: (tabId: string, shownOrder: readonly string[]) => void
  /** Closes every tab on screen except the pinned ones. */
  closeAllTabs: () => void
  closeTabsByFolder: (folderId: number) => void
  switchTab: (tabId: string) => void
  /** Keep a preview open (`isPinned`). Not "Pin tab": see `setTabAnchored`. */
  pinTab: (tabId: string) => void
  /**
   * "Pin tab" / "Unpin tab" (`isAnchored`). As in a browser, a newly pinned
   * tab goes after the pinned tabs already there, and an unpinned one becomes
   * the first of the rest. Pinning also keeps it open (`isPinned`).
   */
  setTabAnchored: (tabId: string, anchored: boolean) => void
  toggleGroupTile: (groupId: string) => void
  splitTab: (
    tabId: string,
    direction: SplitDirection,
    opts: { move: boolean }
  ) => void
  moveTabToGroup: (
    tabId: string,
    targetGroupId: string,
    opts?: {
      /** Position within the target group (clamped). Omitted = keep the tab's
       *  global rawTabs slot (menu moves — no reorder, no synced save). */
      index?: number
    }
  ) => void
  updateTabDrag: (drag: NonNullable<TabStoreState["tabDrag"]>) => void
  endTabDrag: () => void
  toggleGroupOrientation: (groupId: string) => void
  dissolveGroup: (groupId: string) => void
  unsplitAll: () => void
  reorderGroupTabs: (groupId: string, orderedTabs: TabItem[]) => void
  resizeGroupSplit: (
    splitId: string,
    handleIndex: number,
    boundaryFraction: number
  ) => void
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options?: {
      inheritFromActive?: boolean
      folderDefaultAgent?: AgentType | null
      targetGroup?: string
      /** Pin the draft to this agent, outranking BOTH the folder default and
       *  the inherit/fallback chain. For callers that must reproduce a specific
       *  agent (e.g. "ask about this selection" continues the conversation the
       *  text came from), not merely suggest one. */
      forceAgent?: AgentType
      /** rawTabs slot for the draft (clamped); omitted = append / leave put.
       *  Reopening a closed draft passes the slot it was closed from — and
       *  since the per-group singleton may hand it the group's EXISTING draft
       *  instead of a new tab, that draft is moved to the slot. */
      index?: number
      /** Move THIS unbound draft to the folder (the composer's folder picker)
       *  rather than resolving the target group's draft. Matters while tabs
       *  follow the folder, where the target folder may have a draft of its
       *  own. */
      retargetTabId?: string
    }
  ) => OpenedDraftTarget
  openChatModeTab: (options?: {
    targetGroup?: string
    /** See `openNewConversationTab`'s `forceAgent`. */
    forceAgent?: AgentType
    /** See `openNewConversationTab`'s `retargetTabId`. */
    retargetTabId?: string
  }) => OpenedDraftTarget
  setChatDraftWorkingDir: (tabId: string, workingDir: string) => void
  confirmDraftAgent: (tabId: string, agentType: AgentType) => void
  setDraftAgentFromFallback: (tabId: string, agentType: AgentType) => void
  bindConversationTab: (
    tabId: string,
    conversationId: number,
    agentType: AgentType,
    title: string,
    runtimeConversationId?: number,
    folderId?: number,
    workingDir?: string
  ) => void
  setTabRuntimeConversationId: (
    tabId: string,
    runtimeConversationId: number
  ) => void
  reorderTabs: (reorderedTabs: TabItem[]) => void
  /**
   * Open (or focus) the tab of a Claude Code sub-agent's thread, next to its
   * parent conversation's tab when that is open (in its group), else in the
   * focused group. A preview by default: it takes the place of the group's
   * preview, and a double click pins it. A parent that is itself the group's
   * preview is pinned first, so opening its sub-agent never closes it.
   * Returns the tab's id.
   */
  openSubagentTab: (
    target: SubagentTabTarget,
    opts?: {
      pin?: boolean
      title?: string
      /** rawTabs slot (clamped), from the closed-tab stack. */
      index?: number
      /** The folder of the parent, when the caller knows it better. */
      folderId?: number
    }
  ) => string
  /** Patch what a sub-agent tab knows about its sub-agent (its id once
   *  read, its type and description, its title and running state). */
  updateSubagentTab: (
    tabId: string,
    patch: Partial<
      Pick<SubagentTabTarget, "agentId" | "subagentType" | "description">
    > & { title?: string; status?: ConversationStatus }
  ) => void
  consumeRemoteActivation: () => boolean
  onPreviewTabReplaced: (callback: (tabId: string) => void) => () => void

  // ── Orchestration (driven by TabRuntimeEffects) ──────────────────────────────
  hydrate: () => () => void
  runSaveEffect: () => void
  clearSaveTimer: () => void
  reconcileChildSummaries: () => void
  handleChildConversationChange: (change: ConversationChange) => void
  handleChildReconnect: () => void
  handleTabsChanged: (change: TabsChanged) => void
  refetchTabs: () => Promise<void>
  correctDraftAgents: () => void
  recoverActiveContext: () => void
  consumePreviewReplaced: () => void
  consumeDraftRetargets: () => void
  syncActiveFolderId: () => void
  persistLastActiveContext: () => void

  // ── Runtime dependency injection ─────────────────────────────────────────────
  setLabels: (labels: TabLabels) => void
  setSideEffects: (deps: {
    activateConversationPane: () => void
    acpDisconnect: (contextKey: string) => Promise<void>
  }) => void
  setAgentAvailability: (sortedTypes: AgentType[], fresh: boolean) => void
}

/** Legacy pre-groups tile flag — read once as the first group's default. */
const TILE_MODE_STORAGE_KEY = "workspace:tile-mode"
/** Device-local split-group state (layout tree, assignments, selection, tile
 *  flags), keyed by canonical tab ids. See `persistGroupState`. */
const TAB_GROUPS_STORAGE_KEY = "workspace:tab-groups:v1"

/** Per-window/session identity stamped on every tab save and echoed back on
 *  `tabs://changed`, so this client ignores its own broadcast (echo
 *  suppression). Regenerated each load — it identifies the window for echo
 *  suppression, not the user, so nothing about it needs to persist. */
const TAB_ORIGIN = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

// ── React-land dependencies, injected by TabRuntimeEffects ─────────────────────
// Kept out of the reactive store state so updating them never notifies
// consumers; actions read them directly.
interface TabRuntime {
  labels: TabLabels
  activateConversationPane: () => void
  acpDisconnect: (contextKey: string) => Promise<void>
  sortedAvailableAgents: AgentType[]
  agentsFresh: boolean
}

function defaultRuntime(): TabRuntime {
  return {
    labels: {
      loadingConversation: "loadingConversation",
      newConversation: "newConversation",
      untitledConversation: "untitledConversation",
    },
    activateConversationPane: () => {},
    acpDisconnect: async () => {},
    sortedAvailableAgents: [],
    agentsFresh: false,
  }
}

let runtime: TabRuntime = defaultRuntime()

// ── Cross-client / coordination state (non-reactive; see original TabProvider) ──
// `version` — last workspace tab version this client observed/applied; every
//   save sends it as the CAS `expected_version`.
// `applyingRemote` — one-shot guard so applying a remote snapshot does not echo
//   back as a save.
// `pendingRemote` — a remote change that beat hydration; applied once hydrated.
// `lastSavedPayload` — JSON of the last persisted payload; draft-only changes
//   match it and skip the save.
let version = 0
let applyingRemote = false
let remoteActivationPending = false
// True while `applyRemoteSnapshot` writes the store: an activeTabId change made
// then mirrors another client's focus, and must not move this window's keyboard
// (see `noteTabActivation`).
let applyingRemoteFocus = false
let pendingRemote: TabsChanged | null = null
let lastSavedPayload: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
// Conversation tabs the SERVER is known to hold, as of the last snapshot this
// client read, applied, or successfully saved. It is the common ancestor of the
// three-way merge in `applyRemoteSnapshot`: without it, "absent from the
// snapshot" is ambiguous — a tab another client closed and a tab this client
// just opened look identical, and adopting the snapshot wholesale silently
// discards the second. That is not hypothetical: a server-side invalidation
// bumps the tab version WITHOUT broadcasting when it removes no row (see
// `delete_conversation_tabs_and_bump`), so a client can sit on a stale version
// indefinitely and have its next save rejected — which used to erase whatever
// tab that save was carrying, most visibly the draft that had just bound to a
// freshly-sent conversation.
let serverKnownTabKeys = new Set<string>()
// Last JSON written to TAB_GROUPS_STORAGE_KEY (no-op gate), plus the trailing
// debounce used while a split divider is being dragged.
let lastGroupBlob: string | null = null
let groupPersistTimer: ReturnType<typeof setTimeout> | null = null
// Device-local draft tabs read from the blob at store creation, consumed once by
// `hydrate` (kept out of store state: they are an input to hydration, not
// renderable state). Refreshed whenever `initialTabState()` runs.
let pendingRestoreDrafts: PersistedDraft[] = []
let pendingRestoreActiveDraft: string | null = null
// The same for the pinned sub-agent tabs (see `PersistedSubagentTab`).
let pendingRestoreSubagents: PersistedSubagentTab[] = []
let orphanDraftPruneRan = false
// True once a tab snapshot has actually been read from the backend (hydration,
// a refetch, or a remote change). Until then the open-tab set is UNKNOWN — a
// failed `listOpenedTabs` leaves it empty — and treating that emptiness as truth
// would prune every group assignment, collapse the layout, and write that ruin
// over the good blob (destroying the user's remembered layout on a transient
// backend hiccup). Both the invariant prune and the blob write wait for it; the
// session self-heals the moment any snapshot lands.
let tabsSnapshotLoaded = false
const childSummaryInFlight = new Set<number>()
const childSeedBuffer = new Map<
  number,
  { summary?: DbConversationSummary; status?: string; deleted?: boolean }
>()
let seedEpoch = 0
const previewReplacedCallbacks = new Set<(tabId: string) => void>()
let correctionRan = false
let recoveryRan = false
// Tracks the last `conversations` reference recomputeTabs derived against, so
// the module-level app-workspace subscription recomputes only when it changes.
let lastConversations = useAppWorkspaceStore.getState().conversations

function makeConversationTabId(
  folderId: number,
  agentType: AgentType,
  conversationId: number
): string {
  return `conv-${folderId}-${agentType}-${conversationId}`
}

function makeNewConversationTabId(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Identity of a conversation for tab sync: agent + conversation, deliberately
 *  WITHOUT the folder. A conversation has one tab at most, and the folder is a
 *  property of the conversation that can change under the tab (it was moved to
 *  another project): keyed by folder, the three-way merge would read a moved
 *  conversation's tab as "closed in one folder, opened in another" — and a
 *  close this client hadn't pushed yet would come back as a remote open. */
function conversationSyncKey(
  agentType: AgentType,
  conversationId: number
): string {
  return `${agentType}:${conversationId}`
}

/** Sync identity of a persisted tab (see `conversationSyncKey`). A bound draft
 *  keeps its volatile `new-*` id, so this is deliberately derived from the
 *  fields rather than read off `tab.id`. Drafts have no sync identity (they are
 *  device-local and never persisted) → `null`. */
function tabSyncKey(tab: TabItemInternal): string | null {
  if (tab.conversationId == null) return null
  return conversationSyncKey(tab.agentType, tab.conversationId)
}

function snapshotSyncKeys(items: OpenedTab[]): Set<string> {
  const keys = new Set<string>()
  for (const it of items) {
    if (it.conversation_id == null) continue
    keys.add(conversationSyncKey(it.agent_type, it.conversation_id))
  }
  return keys
}

function findTabIndexForConversation(
  tabs: TabItemInternal[],
  folderId: number,
  agentType: AgentType,
  conversationId: number
): number {
  const canonicalId = makeConversationTabId(folderId, agentType, conversationId)
  const idx = tabs.findIndex((t) => t.id === canonicalId)
  if (idx >= 0) return idx
  return tabs.findIndex(
    (t) =>
      t.folderId === folderId &&
      t.conversationId === conversationId &&
      t.agentType === agentType
  )
}

/** A requested slot clamped to a strip of `length`. */
function clampSlot(index: number, length: number): number {
  return Math.max(0, Math.min(index, length))
}

/** `tabs` with `tab` inserted at `index`, clamped to the array, or appended
 *  when no index is given. Reopening a closed tab passes the slot it was
 *  closed from, so it goes back where it was rather than to the end. */
function insertTab(
  tabs: TabItemInternal[],
  tab: TabItemInternal,
  index: number | undefined
): TabItemInternal[] {
  const at = index == null ? tabs.length : clampSlot(index, tabs.length)
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)]
}

/** `tabs` with the tab already at `tabId` moved to `index` (clamped) — the same
 *  array back when it is absent or already there, so callers can skip the write.
 *  Reopening a closed DRAFT lands here: the per-group draft singleton hands the
 *  reopen an existing draft instead of a new tab, and that draft still has to
 *  take the closed one's slot. */
function moveTabToSlot(
  tabs: TabItemInternal[],
  tabId: string,
  index: number
): TabItemInternal[] {
  const from = tabs.findIndex((t) => t.id === tabId)
  if (from < 0) return tabs
  const without = tabs.filter((t) => t.id !== tabId)
  if (clampSlot(index, without.length) === from) return tabs
  return insertTab(without, tabs[from], index)
}

/**
 * `raw` with the tabs sitting at `slots` rearranged into the order a reorder
 * callback asked for, or `null` when that list is not a permutation of exactly
 * those slots (and so must be ignored).
 *
 * A reorder callback is a request to MOVE tabs, never a new tab set. The
 * distinction matters because `Reorder.Group` emits the order it has measured
 * since its own last render and then drops, by reference, whatever is missing
 * from its current `values` — so mid-drag it can legitimately hand back a list
 * that is short, repeats an id, or carries a tab object from an earlier derive.
 * Resolving every entry back to the live `rawTabs` item by id keeps a drag
 * unable to close a tab, resurrect a closed one, or write a stale copy of a
 * tab's fields over the current one (a draft that bound to a conversation
 * mid-drag would otherwise go back to being an unbound draft).
 */
function permuteSlots(
  raw: TabItemInternal[],
  slots: number[],
  orderedTabs: TabItem[]
): TabItemInternal[] | null {
  if (orderedTabs.length !== slots.length) return null
  const slotIds = new Set(slots.map((i) => raw[i].id))
  const seen = new Set<string>()
  const ordered: TabItemInternal[] = []
  for (const tab of orderedTabs) {
    if (!slotIds.has(tab.id) || seen.has(tab.id)) return null
    seen.add(tab.id)
    const item = raw.find((t) => t.id === tab.id)
    if (!item) return null
    ordered.push(item)
  }
  const next = [...raw]
  slots.forEach((slot, k) => {
    next[slot] = ordered[k]
  })
  return next.every((tab, i) => tab === raw[i]) ? null : next
}

/** Field-wise equality for derived tab items. Backs the cross-derive reuse in
 *  the `tabs` derivation: an item whose every field matches the previous derive
 *  keeps its old reference, so downstream `Object.is` gates (consumers' memos)
 *  can short-circuit. TabItemInternal is a closed shape — keep this list in sync
 *  when adding fields. */
function sameDerivedTab(a: TabItemInternal, b: TabItemInternal): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.folderId === b.folderId &&
    a.conversationId === b.conversationId &&
    a.runtimeConversationId === b.runtimeConversationId &&
    a.agentType === b.agentType &&
    a.title === b.title &&
    a.isPinned === b.isPinned &&
    (a.isAnchored === true) === (b.isAnchored === true) &&
    a.workingDir === b.workingDir &&
    a.status === b.status &&
    a.agentTypeProvisional === b.agentTypeProvisional &&
    a.isChat === b.isChat &&
    a.subagent === b.subagent
  )
}

/** Build the persisted (synced) tab payload: conversation-bound tabs only
 *  (drafts are device-local), `position` = display index, and `is_active` set on
 *  the focused tab so focus mirrors across clients. Used by both the save effect
 *  and remote-apply so their JSON is byte-identical for the no-op gate. */
function buildPersistItems(
  tabs: TabItemInternal[],
  activeTabId: string | null
): OpenedTab[] {
  return tabs
    .filter((tab) => tab.conversationId != null)
    .map((tab, i) => ({
      id: 0,
      folder_id: tab.folderId,
      conversation_id: tab.conversationId,
      agent_type: tab.agentType,
      position: i,
      is_active: tab.id === activeTabId,
      is_pinned: tab.isPinned,
      is_anchored: tab.isAnchored === true,
    }))
}

/** A synced tab's "Pin tab" flag. A server that predates it sends none. */
function anchoredFromItem(
  item: OpenedTab
): Pick<TabItemInternal, "isAnchored"> {
  return item.is_anchored === true ? { isAnchored: true } : {}
}

/** Resolve a tab's group: its assignment when it points at a live leaf, else
 *  the first leaf. Exported for the strip / detail-panel render filters. */
export function groupOfTab(
  groupOf: Record<string, string>,
  layout: LayoutNode,
  tabId: string
): string {
  const assigned = groupOf[tabId]
  if (assigned != null && leafIds(layout).includes(assigned)) return assigned
  return firstLeafId(layout)
}

/** True when more than one group exists (the canonical tree keeps a split root
 *  only while it has ≥ 2 leaves). */
export function selectIsSplit(s: TabStoreState): boolean {
  return s.groupLayout.type !== "group"
}

/**
 * Unmount classifier for a conversation view: is it being REPARENTED (its tab
 * moved to another split group — remount, keep the ACP connection) or TORN
 * DOWN (disconnect)?
 *
 * Narrowly scoped on purpose. "The tab is still open" alone is NOT a reparent
 * marker: the whole conversation surface also unmounts with tabs left open
 * (mobile conversation→file pane switch, workbench route overlay), and those
 * must still disconnect — the idle sweep skips viewers, so a viewer left
 * attached leaks its subscription. Since group shells are flat siblings keyed
 * by group id, a surviving tab leaves its shell if and only if its shell group
 * (`shellGroupOfTab`) changed, which is exactly what this compares.
 */
export function isReparentUnmount(
  state: GroupResolutionState,
  tabId: string,
  renderedGroupId: string
): boolean {
  if (!state.rawTabs.some((tab) => tab.id === tabId)) return false
  return shellGroupOfTab(state, tabId) !== renderedGroupId
}

/** The conversation view each tab has mounted: the group it rendered under and
 *  the runtime session key it mounted on. Module scope rather than store state
 *  because it tracks React mounts, which nothing renders from. */
const mountedConversationViews = new Map<
  string,
  { groupId: string; runtimeConversationId: number }
>()

/** Record the conversation view `tabId` just mounted. The returned release
 *  drops only its own entry, so it can never unregister a successor. */
export function trackConversationView(
  tabId: string,
  groupId: string,
  runtimeConversationId: number
): () => void {
  const entry = { groupId, runtimeConversationId }
  mountedConversationViews.set(tabId, entry)
  return () => {
    if (mountedConversationViews.get(tabId) === entry) {
      mountedConversationViews.delete(tabId)
    }
  }
}

/**
 * Mount-side counterpart of `isReparentUnmount`: the runtime session key a
 * conversation view arriving for `tabId` must inherit from the view it
 * replaces, or null when a fresh key is right.
 *
 * React renders the arriving view BEFORE the departing one's cleanup runs, so
 * at this view's first render its predecessor is still registered, and that
 * cleanup is about to ask `isReparentUnmount` about its own group. This asks the
 * same question first. Yes means the session is kept, and the arriving view has
 * to carry on with it rather than key itself by the tab's row id — a tab that
 * started as a draft keeps its transcript under a virtual key for good. No
 * means the session is about to be removed (the desktop/mobile layout swap
 * remounts every view in one commit without moving any), so inheriting it
 * would strand the view on a key with nothing behind it; a virtual key never
 * fetches.
 */
export function reparentedViewRuntimeConversationId(
  state: GroupResolutionState,
  tabId: string
): number | null {
  const predecessor = mountedConversationViews.get(tabId)
  if (!predecessor) return null
  return isReparentUnmount(state, tabId, predecessor.groupId)
    ? predecessor.runtimeConversationId
    : null
}

/** Where a new tab should land: the explicit target when it's a live group,
 *  else the focused (active tab's) group. */
function resolveTargetGroup(
  st: Pick<TabStoreState, "activeTabId" | "groupOf" | "groupLayout">,
  explicit?: string
): string {
  if (explicit != null && leafIds(st.groupLayout).includes(explicit)) {
    return explicit
  }
  return st.activeTabId != null
    ? groupOfTab(st.groupOf, st.groupLayout, st.activeTabId)
    : firstLeafId(st.groupLayout)
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function sanitizeBoolRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v
  }
  return out
}

/** The blob's folder views (written while tabs follow the folder), parked
 *  until the mode is restored — or dropped if it comes back off. */
function sanitizeGroupViews(value: unknown): Record<string, GroupView> {
  const out: Record<string, GroupView> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith(FOLDER_GROUP_VIEW_PREFIX)) continue
    if (typeof raw !== "object" || raw === null) continue
    const view = raw as Record<string, unknown>
    if (!isLayoutNode(view.layout)) continue
    out[key] = {
      layout: view.layout,
      groupOf: sanitizeStringRecord(view.assignments),
      selection: sanitizeStringRecord(view.selection),
      tileByGroup: sanitizeBoolRecord(view.tileByGroup),
      active: null,
    }
  }
  return out
}

/**
 * A device-local draft tab as stored in the group blob. Drafts never reach
 * `opened_tabs` (the lazy-conversation invariant: no DB row before the first
 * send), so without this a split group holding only a draft — the common
 * "conversation | new conversation" layout — lost its member on restart and
 * `normalizeTree` collapsed the whole group.
 *
 * `index` is the draft's position in `rawTabs` at save time (counting only
 * the tabs a restart brings back: a preview sub-agent tab before it does not
 * shift it), so restoring splices it back among the conversation tabs instead
 * of appending. `agentType`
 * is written ONLY for an explicitly-chosen agent (`agentTypeProvisional` is
 * falsy) — persisting a provisional pick would launder a cold-start guess into
 * a user choice, the same rule `last-active-context-storage` documents. Chat
 * drafts omit `workingDir`: their scratch dir is recreated eagerly on focus.
 */
interface PersistedDraft {
  id: string
  group: string
  index: number
  folderId: number
  isChat?: boolean
  workingDir?: string
  agentType?: AgentType
  /** Pinned to the start of the strip (`isAnchored`). */
  anchored?: true
}

function sanitizeDrafts(value: unknown): PersistedDraft[] {
  if (!Array.isArray(value)) return []
  const out: PersistedDraft[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== "string" || e.id.length === 0) continue
    if (typeof e.group !== "string" || e.group.length === 0) continue
    if (typeof e.folderId !== "number" || !Number.isFinite(e.folderId)) continue
    const index =
      typeof e.index === "number" && Number.isFinite(e.index) && e.index >= 0
        ? Math.floor(e.index)
        : out.length
    out.push({
      id: e.id,
      group: e.group,
      index,
      folderId: e.folderId,
      ...(e.isChat === true ? { isChat: true } : {}),
      ...(typeof e.workingDir === "string" && e.workingDir.length > 0
        ? { workingDir: e.workingDir }
        : {}),
      ...(typeof e.agentType === "string" && e.agentType.length > 0
        ? { agentType: e.agentType as AgentType }
        : {}),
      ...(e.anchored === true ? { anchored: true as const } : {}),
    })
  }
  return out
}

/**
 * A PINNED sub-agent tab as stored in the group blob, so it survives a restart
 * the way a draft does (sub-agent tabs never reach `opened_tabs`). A preview is
 * not kept: it is the tab the next preview replaces anyway. `index` is its
 * slot at save time, like a draft's.
 */
interface PersistedSubagentTab {
  id: string
  group: string
  index: number
  folderId: number
  title: string
  target: SubagentTabTarget
  /** Pinned to the start of the strip (`isAnchored`). */
  anchored?: true
}

function sanitizeSubagentTabs(value: unknown): PersistedSubagentTab[] {
  if (!Array.isArray(value)) return []
  const out: PersistedSubagentTab[] = []
  const text = (v: unknown) =>
    typeof v === "string" && v.length > 0 ? v : undefined
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    const target = e.target as Record<string, unknown> | null | undefined
    if (typeof target !== "object" || target === null) continue
    const parentConversationId = target.parentConversationId
    const toolCallId = text(target.toolCallId)
    if (
      typeof parentConversationId !== "number" ||
      !Number.isFinite(parentConversationId) ||
      !toolCallId
    ) {
      continue
    }
    const id = makeSubagentTabId(parentConversationId, toolCallId)
    if (e.id !== id) continue
    if (typeof e.group !== "string" || e.group.length === 0) continue
    if (typeof e.folderId !== "number" || !Number.isFinite(e.folderId)) continue
    out.push({
      id,
      group: e.group,
      index:
        typeof e.index === "number" && Number.isFinite(e.index) && e.index >= 0
          ? Math.floor(e.index)
          : out.length,
      folderId: e.folderId,
      title: text(e.title) ?? "",
      target: {
        parentConversationId,
        toolCallId,
        ...(text(target.agentId) ? { agentId: text(target.agentId) } : {}),
        ...(text(target.subagentType)
          ? { subagentType: text(target.subagentType) }
          : {}),
        ...(text(target.description)
          ? { description: text(target.description) }
          : {}),
      },
      ...(e.anchored === true ? { anchored: true as const } : {}),
    })
  }
  return out
}

/** Seed group state from the device-local blob (canonical tab ids — they match
 *  nothing until `hydrate` restores canonical-id tabs; `applyGroupInvariants`
 *  defers pruning until then). Falls back to a single group, seeding its tile
 *  flag from the legacy pre-groups key. The blob's draft entries are parked in
 *  module scope (not store state) for `hydrate` to splice back in. */
function readPersistedGroupState(): {
  groupLayout: LayoutNode
  groupOf: Record<string, string>
  groupSelection: Record<string, string>
  tileByGroup: Record<string, boolean>
  groupViews: Record<string, GroupView>
} {
  pendingRestoreDrafts = []
  pendingRestoreActiveDraft = null
  pendingRestoreSubagents = []
  const fallback = () => ({
    groupLayout: singleGroupLayout() as LayoutNode,
    groupOf: {} as Record<string, string>,
    groupSelection: {} as Record<string, string>,
    tileByGroup: {} as Record<string, boolean>,
    groupViews: {} as Record<string, GroupView>,
  })
  if (typeof window === "undefined") return fallback()
  try {
    const raw = localStorage.getItem(TAB_GROUPS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && isLayoutNode(parsed.layout)) {
        // Older blobs predate `drafts`/`activeDraft` — both sanitize to empty.
        pendingRestoreDrafts = sanitizeDrafts(parsed.drafts)
        pendingRestoreSubagents = sanitizeSubagentTabs(parsed.subagents)
        pendingRestoreActiveDraft =
          typeof parsed.activeDraft === "string" ? parsed.activeDraft : null
        return {
          groupLayout: parsed.layout,
          groupOf: sanitizeStringRecord(parsed.assignments),
          groupSelection: sanitizeStringRecord(parsed.selection),
          tileByGroup: sanitizeBoolRecord(parsed.tileByGroup),
          groupViews: sanitizeGroupViews(parsed.views),
        }
      }
    }
    const seeded = fallback()
    if (localStorage.getItem(TILE_MODE_STORAGE_KEY) === "true") {
      seeded.tileByGroup[firstLeafId(seeded.groupLayout)] = true
    }
    return seeded
  } catch {
    return fallback()
  }
}

/** Write the group blob: conversation tabs re-keyed to canonical tab ids, draft
 *  tabs carried in `drafts` under their own (now restart-stable) ids so a
 *  draft-only group survives a restart. String-diffed no-op gate; never runs
 *  before hydration so a transient pre-hydration state can't clobber the good
 *  blob. */
function persistGroupState() {
  if (typeof window === "undefined") return
  const st = useTabStore.getState()
  // Both gates matter: pre-hydration the state is transient, and after a FAILED
  // hydration it is missing every conversation tab — writing either would
  // replace the good blob with a collapsed layout.
  if (!st.tabsHydrated || !tabsSnapshotLoaded) return
  // The top level is always the normal-mode view, as a session with the mode
  // off reads it; folder views (while tabs follow the folder, or parked from
  // the last session until the stored mode is known) ride in `views`.
  const views: Record<string, GroupView> = {
    ...st.groupViews,
    [groupViewKey(useFolderTabsStore.getState())]: groupViewOnScreen(st),
  }
  const normal = views[ALL_GROUP_VIEW] ?? groupViewOnScreen(st)
  const canonicalId = (tab: TabItemInternal) =>
    tab.conversationId != null
      ? makeConversationTabId(tab.folderId, tab.agentType, tab.conversationId)
      : tab.id
  const canonicalSelection = (selection: Record<string, string>) => {
    const out: Record<string, string> = {}
    for (const [groupId, tabId] of Object.entries(selection)) {
      const tab = st.rawTabs.find((t) => t.id === tabId)
      if (tab) out[groupId] = canonicalId(tab)
    }
    return out
  }
  const assignments: Record<string, string> = {}
  const drafts: PersistedDraft[] = []
  const subagents: PersistedSubagentTab[] = []
  // A slot counts only the tabs a restart brings back: a preview sub-agent
  // tab is not one, so the tabs after it must not count it.
  let index = 0
  st.rawTabs.forEach((tab) => {
    const group = groupOfTab(normal.groupOf, normal.layout, tab.id)
    if (tab.conversationId != null) {
      assignments[canonicalId(tab)] = group
      index += 1
      return
    }
    if (isSubagentTab(tab)) {
      if (tab.isPinned) {
        subagents.push({
          id: tab.id,
          group,
          index: index++,
          folderId: tab.folderId,
          title: tab.title,
          target: tab.subagent,
          ...(tab.isAnchored === true ? { anchored: true as const } : {}),
        })
      }
      return
    }
    drafts.push({
      id: tab.id,
      group,
      index: index++,
      folderId: tab.folderId,
      ...(tab.isChat === true ? { isChat: true } : {}),
      // Chat drafts get a fresh scratch dir on focus; persisting the old one
      // would point the connection at a directory the GC may have removed.
      ...(tab.isChat !== true && tab.workingDir
        ? { workingDir: tab.workingDir }
        : {}),
      ...(tab.agentTypeProvisional ? {} : { agentType: tab.agentType }),
      ...(tab.isAnchored === true ? { anchored: true as const } : {}),
    })
  })
  // Each folder view lists only its own folder's tabs (drafts by their own
  // ids — the draft entries above carry the normal-mode group). A folder with
  // no tabs left has nothing to restore: it starts afresh like any new one.
  const folderViews: Record<string, unknown> = {}
  for (const [key, view] of Object.entries(views)) {
    if (key === ALL_GROUP_VIEW) continue
    const viewAssignments: Record<string, string> = {}
    for (const tab of st.rawTabs) {
      if (folderGroupViewKey(tab) !== key) continue
      viewAssignments[canonicalId(tab)] = groupOfTab(
        view.groupOf,
        view.layout,
        tab.id
      )
    }
    if (Object.keys(viewAssignments).length === 0) continue
    folderViews[key] = {
      layout: view.layout,
      assignments: viewAssignments,
      selection: canonicalSelection(view.selection),
      tileByGroup: view.tileByGroup,
    }
  }
  const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId)
  const blob = JSON.stringify({
    layout: normal.layout,
    assignments,
    selection: canonicalSelection(normal.selection),
    tileByGroup: normal.tileByGroup,
    drafts,
    ...(subagents.length > 0 ? { subagents } : {}),
    // Only a DRAFT (or sub-agent) focus needs restoring here; conversation
    // focus rides the synced `opened_tabs.is_active`.
    activeDraft:
      activeTab && activeTab.conversationId == null ? activeTab.id : null,
    ...(Object.keys(folderViews).length > 0 ? { views: folderViews } : {}),
  })
  if (blob === lastGroupBlob) return
  lastGroupBlob = blob
  try {
    localStorage.setItem(TAB_GROUPS_STORAGE_KEY, blob)
  } catch {
    /* ignore */
  }
}

/**
 * Splice the blob's draft tabs back among the freshly-hydrated conversation
 * tabs, returning the merged list plus the group assignments to seed. Consumed
 * once (the pending list is cleared), so a later refetch/reconnect never
 * resurrects a draft the user closed.
 *
 * The agent is re-resolved exactly like any new draft unless the blob carried an
 * explicit (non-provisional) choice; the title comes from the current locale's
 * label rather than the stale persisted one.
 */
function mergeRestoredDrafts(restored: TabItemInternal[]): {
  tabs: TabItemInternal[]
  groupOf: Record<string, string>
} {
  const pending = pendingRestoreDrafts
  pendingRestoreDrafts = []
  const pendingSubagents = pendingRestoreSubagents
  pendingRestoreSubagents = []
  if (pending.length === 0 && pendingSubagents.length === 0) {
    return { tabs: restored, groupOf: {} }
  }

  const tabs = [...restored]
  const groupOf: Record<string, string> = {}
  const seen = new Set(restored.map((tab) => tab.id))
  // Drafts and sub-agent tabs splice back in one pass, in slot order: their
  // indices were taken from the same strip.
  const local = [
    ...pending.map((draft) => ({ index: draft.index, draft })),
    ...pendingSubagents.map((sub) => ({ index: sub.index, sub })),
  ].sort((a, b) => a.index - b.index)
  for (const entry of local) {
    if ("sub" in entry) {
      const sub = entry.sub
      if (seen.has(sub.id)) continue
      seen.add(sub.id)
      tabs.splice(Math.min(sub.index, tabs.length), 0, {
        id: sub.id,
        kind: "subagent",
        folderId: sub.folderId,
        conversationId: null,
        agentType: "claude_code",
        title: sub.title || runtime.labels.untitledConversation,
        isPinned: true,
        ...(sub.anchored ? { isAnchored: true } : {}),
        subagent: sub.target,
      })
      groupOf[sub.id] = sub.group
      continue
    }
    const draft = entry.draft
    if (seen.has(draft.id)) continue
    seen.add(draft.id)
    const resolved = draft.agentType
      ? { agentType: draft.agentType, provisional: false }
      : resolveAgentForFolder(draft.folderId, null)
    const tab: TabItemInternal = {
      id: draft.id,
      kind: "conversation",
      folderId: draft.folderId,
      conversationId: null,
      agentType: resolved.agentType,
      title: runtime.labels.newConversation,
      isPinned: true,
      ...(draft.anchored ? { isAnchored: true } : {}),
      workingDir: draft.workingDir,
      agentTypeProvisional: resolved.provisional,
      ...(draft.isChat === true ? { isChat: true } : {}),
    }
    tabs.splice(Math.min(draft.index, tabs.length), 0, tab)
    groupOf[draft.id] = draft.group
  }
  return { tabs, groupOf }
}

/** Trailing-debounced persist for divider drags (per-frame ratio writes). */
function schedulePersistGroupState() {
  if (groupPersistTimer) clearTimeout(groupPersistTimer)
  groupPersistTimer = setTimeout(() => {
    groupPersistTimer = null
    persistGroupState()
  }, 300)
}

function shallowRecordEqual(
  a: Record<string, string> | Record<string, boolean>,
  b: Record<string, string> | Record<string, boolean>
): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === (b as Record<string, unknown>)[k])
}

/** View filtering is deliberately separate from rawTabs and the CAS payload. */
export function isTabInScope(tab: Pick<TabItem, "folderId">) {
  const state = useFolderTabsStore.getState()
  return !state.enabled || folderScope(tab.folderId) === state.scope
}

export function useVisibleConversationTabs() {
  const enabled = useFolderTabsStore((s) => s.enabled)
  const scope = useFolderTabsStore((s) => s.scope)
  return useTabStore(
    useShallow((s) =>
      enabled
        ? s.tabs.filter((tab) => folderScope(tab.folderId) === scope)
        : s.tabs
    )
  )
}

/** The on-screen view's layout. While tabs follow the folder that is the
 *  folder's own layout, already narrowed to its tabs once the tab set is
 *  known; narrowing here as well covers the moments before that. */
export function useVisibleConversationLayout() {
  const enabled = useFolderTabsStore((s) => s.enabled)
  const tabs = useVisibleConversationTabs()
  const layout = useTabStore((s) => s.groupLayout)
  const groupOf = useTabStore((s) => s.groupOf)
  return useMemo(
    () =>
      enabled
        ? normalizeTree(
            layout,
            new Set(tabs.map((tab) => groupOfTab(groupOf, layout, tab.id)))
          )
        : layout,
    [enabled, tabs, groupOf, layout]
  )
}

/**
 * Split-group state of a tab view that is not on screen. A view is the tabs
 * one layout arranges: every tab in normal mode, or one folder's while tabs
 * follow the folder — so splitting, resizing or unsplitting in one folder
 * leaves every other folder's layout alone. The view on screen lives in the
 * store's own group fields; a switch parks it here and loads the next one.
 */
export interface GroupView {
  layout: LayoutNode
  groupOf: Record<string, string>
  selection: Record<string, string>
  tileByGroup: Record<string, boolean>
  /** Its active tab when it was left, offered back on a folder switch. */
  active: string | null
}

/** Key of the normal-mode view (parked while tabs follow the folder). */
const ALL_GROUP_VIEW = "all"
const FOLDER_GROUP_VIEW_PREFIX = "scope:"

function groupViewKey(state: { enabled: boolean; scope: TabScope }): string {
  return state.enabled
    ? `${FOLDER_GROUP_VIEW_PREFIX}${state.scope}`
    : ALL_GROUP_VIEW
}

/** The folder view a tab belongs to while tabs follow the folder. */
function folderGroupViewKey(tab: Pick<TabItem, "folderId">): string {
  return `${FOLDER_GROUP_VIEW_PREFIX}${folderScope(tab.folderId)}`
}

function groupViewOnScreen(st: TabStoreState): GroupView {
  return {
    layout: st.groupLayout,
    groupOf: st.groupOf,
    selection: st.groupSelection,
    tileByGroup: st.tileByGroup,
    active: st.activeTabId,
  }
}

type GroupResolutionState = Pick<
  TabStoreState,
  "rawTabs" | "groupOf" | "groupLayout"
> &
  Partial<Pick<TabStoreState, "groupViews">>

/** What a tab's group resolves against: the view on screen for a tab it
 *  shows, else the tab's own folder view — parked, or not built yet and so
 *  still the normal-mode one it will be narrowed from. */
function groupViewOfTab(
  state: GroupResolutionState,
  tab: Pick<TabItem, "folderId">
): Pick<GroupView, "groupOf" | "layout"> {
  const onScreen = { groupOf: state.groupOf, layout: state.groupLayout }
  if (isTabInScope(tab)) return onScreen
  const views = state.groupViews ?? {}
  return views[folderGroupViewKey(tab)] ?? views[ALL_GROUP_VIEW] ?? onScreen
}

/**
 * The group shell a tab's conversation view renders in, whichever view is on
 * screen. A hidden tab stays in its own view's group, so switching folders
 * never moves a live conversation to another shell (which would remount it).
 */
export function shellGroupOfTab(
  state: GroupResolutionState,
  tabId: string
): string {
  const tab = state.rawTabs.find((t) => t.id === tabId)
  const view = tab
    ? groupViewOfTab(state, tab)
    : { groupOf: state.groupOf, layout: state.groupLayout }
  return groupOfTab(view.groupOf, view.layout, tabId)
}

/**
 * A folder's first view: the normal-mode arrangement narrowed to the folder's
 * tabs, keeping the group ids, so turning the mode on moves no tab. Until the
 * tab set is known nothing is narrowed — the conversations not loaded yet
 * still need their assignments — and the invariant pass narrows the copy once
 * the set arrives.
 */
function projectGroupView(
  base: GroupView,
  tabs: TabItemInternal[],
  tabSetKnown: boolean
): GroupView {
  if (!tabSetKnown) return { ...base, active: null }
  const groupOf: Record<string, string> = {}
  const live = new Set<string>()
  for (const tab of tabs) {
    const group = groupOfTab(base.groupOf, base.layout, tab.id)
    live.add(group)
    if (base.groupOf[tab.id] === group) groupOf[tab.id] = group
  }
  const layout = normalizeTree(base.layout, live)
  const leaves = new Set(leafIds(layout))
  const selection: Record<string, string> = {}
  for (const [groupId, tabId] of Object.entries(base.selection)) {
    if (leaves.has(groupId)) selection[groupId] = tabId
  }
  const tileByGroup: Record<string, boolean> = {}
  for (const [groupId, tiled] of Object.entries(base.tileByGroup)) {
    if (leaves.has(groupId)) tileByGroup[groupId] = tiled
  }
  return { layout, groupOf, selection, tileByGroup, active: null }
}

/**
 * Re-establish the group invariants of the view on screen after any tab/group
 * write (parked views are repaired when they are loaded):
 *   1. assignments only for the view's open tabs, pointing at live leaves;
 *   2. every leaf has ≥ 1 tab (normalizeTree collapses the rest);
 *   3. each group's selection is one of its members, and the focused group's
 *      selection IS the active tab;
 *   4. per-group tile flags only for live groups.
 * Pruning/normalizing waits until the open-tab set is KNOWN — before hydration
 * the blob-seeded canonical-id state matches nothing yet, and after a failed
 * snapshot fetch the set is empty for want of data, not because the tabs closed
 * (selection repair still runs either way, for the live drafts). Never touches
 * rawTabs/tabs — no recursion with `recomputeTabs`.
 */
function applyGroupInvariants() {
  const st = useTabStore.getState()
  const visibleTabs = st.rawTabs.filter(isTabInScope)
  if (
    useFolderTabsStore.getState().enabled &&
    st.activeTabId != null &&
    !visibleTabs.some((t) => t.id === st.activeTabId)
  ) {
    useTabStore.setState({ activeTabId: visibleTabs[0]?.id ?? null })
    applyGroupInvariants()
    return
  }
  const openIds = new Set(st.rawTabs.map((t) => t.id))
  // The view's own tabs: all of them in normal mode, the folder's otherwise.
  const viewIds = new Set(visibleTabs.map((t) => t.id))
  const tabSetKnown = st.tabsHydrated && tabsSnapshotLoaded

  let groupOf = st.groupOf
  let layout = st.groupLayout

  if (tabSetKnown) {
    let pruned: Record<string, string> | null = null
    const layoutLeaves = new Set(leafIds(layout))
    for (const [tabId, groupId] of Object.entries(groupOf)) {
      if (!viewIds.has(tabId) || !layoutLeaves.has(groupId)) {
        pruned = pruned ?? { ...groupOf }
        delete pruned[tabId]
      }
    }
    if (pruned) groupOf = pruned

    const firstLeaf = firstLeafId(layout)
    const liveGroups = new Set<string>()
    for (const tab of visibleTabs) {
      liveGroups.add(groupOf[tab.id] ?? firstLeaf)
    }
    layout = normalizeTree(layout, liveGroups)
    if (layout !== st.groupLayout) {
      // Leaves may have merged away — re-validate assignments against the
      // normalized tree so every entry still points at a live leaf.
      const nextLeaves = new Set(leafIds(layout))
      let revalidated: Record<string, string> | null = null
      for (const [tabId, groupId] of Object.entries(groupOf)) {
        if (!nextLeaves.has(groupId)) {
          revalidated = revalidated ?? { ...groupOf }
          delete revalidated[tabId]
        }
      }
      if (revalidated) groupOf = revalidated
    }
  }

  const leaves = leafIds(layout)
  const active =
    st.activeTabId != null && openIds.has(st.activeTabId)
      ? st.activeTabId
      : null
  const activeGroup = active ? groupOfTab(groupOf, layout, active) : null

  const selection: Record<string, string> = {}
  for (const groupId of leaves) {
    const members = visibleTabs.filter(
      (t) => groupOfTab(groupOf, layout, t.id) === groupId
    )
    if (members.length === 0) {
      // An empty leaf can only stand while the tab set is still unknown; keep
      // its seeded selection for the repair that follows the real snapshot.
      const kept = st.groupSelection[groupId]
      if (!tabSetKnown && kept != null) selection[groupId] = kept
      continue
    }
    if (activeGroup === groupId && active != null) {
      selection[groupId] = active
      continue
    }
    const current = st.groupSelection[groupId]
    selection[groupId] =
      current != null && members.some((t) => t.id === current)
        ? current
        : members[0].id
  }

  let tileByGroup = st.tileByGroup
  if (tabSetKnown) {
    const leafSet = new Set(leaves)
    let prunedTile: Record<string, boolean> | null = null
    for (const groupId of Object.keys(tileByGroup)) {
      if (!leafSet.has(groupId)) {
        prunedTile = prunedTile ?? { ...tileByGroup }
        delete prunedTile[groupId]
      }
    }
    if (prunedTile) tileByGroup = prunedTile
  }

  const changed =
    groupOf !== st.groupOf ||
    layout !== st.groupLayout ||
    tileByGroup !== st.tileByGroup ||
    !shallowRecordEqual(selection, st.groupSelection)
  if (changed) {
    useTabStore.setState({
      groupOf,
      groupLayout: layout,
      groupSelection: selection,
      tileByGroup,
    })
  }
  persistGroupState()
}

/** The user asked for a tab: when it is already the one in front, no
 *  activeTabId change will hand its composer the keyboard, so ask for it (see
 *  `requestComposerFocus`). Call before the write. */
function noteTabRequested(tabId: string) {
  if (useTabStore.getState().activeTabId === tabId) requestComposerFocus()
}

/** Write state from another client's snapshot (see `applyingRemoteFocus`). */
function setRemoteTabState(partial: Partial<TabStoreState>) {
  applyingRemoteFocus = true
  try {
    useTabStore.setState(partial)
  } finally {
    applyingRemoteFocus = false
  }
}

/** Focus a tab and realign the per-group selection with it. The shared path
 *  for every activeTabId-only write (rawTabs writes get the same invariant
 *  pass via `recomputeTabs`). */
function focusTab(tabId: string) {
  if (useTabStore.getState().activeTabId !== tabId) {
    useTabStore.setState({ activeTabId: tabId })
  }
  applyGroupInvariants()
}

/** A draft holding nothing to lose: no saved text, and its composer reports
 *  no unsaved typing or image attachment either. */
function isBlankDraft(tab: TabItemInternal): boolean {
  if (!isDraftTab(tab)) return false
  const key = buildNewConversationDraftStorageKey(tab.id)
  return loadMessageInputDraftV2(key) == null && !hasLiveComposerContent(key)
}

/**
 * One draft per group: close the blank drafts that share a group with
 * `keepId` in its own folder view (parked or on screen). While tabs follow
 * the folder, a draft moved into a folder can land beside that folder's own
 * draft; the moved one is what the user is typing in, so it stays. A draft
 * with content is kept too — two drafts beat a lost prompt — and so is the
 * one on screen, which the user may have just switched to.
 */
function closeBlankDraftsBeside(keepId: string) {
  const st = useTabStore.getState()
  const kept = st.rawTabs.find((t) => t.id === keepId)
  if (!kept || !isDraftTab(kept)) return
  const scope = folderScope(kept.folderId)
  const group = shellGroupOfTab(st, keepId)
  for (const tab of st.rawTabs) {
    if (
      tab.id !== keepId &&
      tab.id !== st.activeTabId &&
      isBlankDraft(tab) &&
      folderScope(tab.folderId) === scope &&
      shellGroupOfTab(st, tab.id) === group
    ) {
      useTabStore.getState().closeTab(tab.id, { recordForReopen: false })
    }
  }
}

/**
 * Turning the mode off puts every folder's drafts back in one layout, where a
 * group carries one draft: per group keep the active draft, else one with
 * content, else the first, and close the other blank ones (never one with
 * content).
 */
function closeBlankDraftsPerGroup() {
  const st = useTabStore.getState()
  const draftsByGroup = new Map<string, TabItemInternal[]>()
  for (const tab of st.rawTabs) {
    if (!isDraftTab(tab)) continue
    const group = groupOfTab(st.groupOf, st.groupLayout, tab.id)
    draftsByGroup.set(group, [...(draftsByGroup.get(group) ?? []), tab])
  }
  for (const drafts of draftsByGroup.values()) {
    if (drafts.length < 2) continue
    const keep =
      drafts.find((draft) => draft.id === st.activeTabId) ??
      drafts.find((draft) => !isBlankDraft(draft)) ??
      drafts[0]
    for (const draft of drafts) {
      if (draft !== keep && isBlankDraft(draft)) {
        useTabStore.getState().closeTab(draft.id, { recordForReopen: false })
      }
    }
  }
}

/**
 * Recompute the decorated `tabs` from `rawTabs` × `conversations` ×
 * `childSummaries`, reusing prior-derive references so an update touching no open
 * tab keeps the array identity stable (no consumer re-render). Called after every
 * rawTabs/childSummaries write, on `conversations` change, and when labels change.
 */
/**
 * The conversation row a tab of `conversationId` shows, when this client knows
 * it: a root from the sidebar list, or a sub-session's seeded summary.
 */
function knownConversationRow(
  conversationId: number,
  agentType: AgentType
): DbConversationSummary | undefined {
  const root = useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === conversationId)
  const row = root ?? useTabStore.getState().childSummaries.get(conversationId)
  return row && row.agent_type === agentType ? row : undefined
}

/**
 * The folder a conversation tab must be opened in: the folder its row is in
 * NOW when this client knows the row, else the one the caller named. Callers
 * often carry a folder id from an older snapshot — an automation run's
 * worktree, the closed-tab stack — and a conversation may have been moved to
 * another project since.
 */
function canonicalConversationFolder(
  folderId: number,
  conversationId: number,
  agentType: AgentType
): number {
  return knownConversationRow(conversationId, agentType)?.folder_id ?? folderId
}

/**
 * Invariant: a conversation tab lives in the folder its conversation row is in.
 *
 * The tab's folder is where the agent works (its connection's cwd is the
 * folder's path) and part of the tab's sync key, so a conversation moved to
 * another project — from this client, another one, or while this one was
 * offline — must take its open tabs along. Run on every derive, so it covers a
 * row upsert, the full refetch after a reconnect, an applied remote snapshot
 * (including a rejected save's reconcile) and hydration alike. Each tab is
 * re-pointed in place: same id, position, pin, group and focus; its working
 * dir is dropped so the connection re-derives it from the new folder (the
 * connection lifecycle reconnects on a working-dir change). A bound chat tab
 * whose row has become a regular project conversation also leaves chat mode.
 * A second tab for the same conversation goes.
 *
 * Tabs whose row this client doesn't know are left alone, and so are drafts;
 * nothing moves while the conversation list is being refetched.
 * The three-way merge in `applyRemoteSnapshot` keys tabs by conversation, not
 * folder (`conversationSyncKey`), so a re-pointed tab is the same tab to it
 * whether or not the server has re-pointed its own copy yet, and a close this
 * client has not pushed yet survives a move made elsewhere. A worktree removal
 * closes its tabs on the server before the conversations are refetched, so
 * nothing is "rescued" here.
 */
function alignConversationTabFolders() {
  const st = useTabStore.getState()
  const { conversations, conversationsLoading, allFolders } =
    useAppWorkspaceStore.getState()
  // Mid-refetch the rows may be older than the tab set — after a reconnect the
  // tab snapshot can land first, already showing a move this list predates —
  // and pointing tabs back at a stale folder would push that back to the
  // server. Wait for the refetch; its settling re-runs the derive.
  if (conversationsLoading) return
  if (conversations.length === 0 && st.childSummaries.size === 0) return
  if (!st.rawTabs.some((t) => t.conversationId != null || isSubagentTab(t))) {
    return
  }
  // Runs on every derive (status ticks included): one pass over the list, not
  // one per tab.
  const roots = new Map(conversations.map((c) => [c.id, c]))
  const rowOf = (tab: TabItemInternal) => {
    const id = tab.conversationId as number
    const row = roots.get(id) ?? st.childSummaries.get(id)
    return row && row.agent_type === tab.agentType ? row : undefined
  }
  let changed = false
  // A sub-agent tab that only follows its parent changes nothing synced.
  let syncedChanged = false
  let activeTabId = st.activeTabId
  const next: TabItemInternal[] = []
  const keys = new Set<string>()
  for (const tab of st.rawTabs) {
    let item = tab
    if (isSubagentTab(tab)) {
      // A sub-agent's thread lives with its session: in its folder.
      const parentId = tab.subagent.parentConversationId
      const parent = roots.get(parentId) ?? st.childSummaries.get(parentId)
      if (parent && parent.folder_id !== tab.folderId) {
        item = { ...tab, folderId: parent.folder_id }
        changed = true
      }
    } else if (tab.conversationId != null) {
      const row = rowOf(tab)
      if (row) {
        const rowFolderKind = allFolders.find(
          (f) => f.id === row.folder_id
        )?.kind
        const leavesChat =
          tab.isChat === true &&
          row.kind !== "chat" &&
          rowFolderKind != null &&
          rowFolderKind !== "chat"
        if (row.folder_id !== tab.folderId || leavesChat) {
          item = {
            ...tab,
            folderId: row.folder_id,
            ...(row.folder_id !== tab.folderId
              ? { workingDir: undefined }
              : {}),
            ...(leavesChat ? { isChat: false } : {}),
          }
          changed = true
          syncedChanged = true
        }
      }
      const key = tabSyncKey(item)
      if (key != null) {
        if (keys.has(key)) {
          // The conversation is already open in another tab: keep that one.
          const kept = next.find((t) => tabSyncKey(t) === key)
          if (activeTabId === tab.id) activeTabId = kept?.id ?? null
          changed = true
          syncedChanged = true
          continue
        }
        keys.add(key)
      }
    }
    next.push(item)
  }
  if (!changed) return
  // A remote apply may have armed the echo guard for the set it just
  // committed; this correction is ours and has to be pushed.
  if (syncedChanged) {
    applyingRemote = false
    lastSavedPayload = null
  }
  useTabStore.setState({ rawTabs: next, activeTabId })
}

function recomputeTabs() {
  alignConversationTabFolders()
  const st = useTabStore.getState()
  const { rawTabs, childSummaries } = st
  const conversations = useAppWorkspaceStore.getState().conversations
  const prev = st.tabs

  let next: TabItemInternal[]
  if (conversations.length === 0 && childSummaries.size === 0) {
    next = rawTabs
  } else {
    const conversationMap = new Map<string, (typeof conversations)[number]>()
    for (const c of conversations) {
      conversationMap.set(`${c.folder_id}-${c.agent_type}-${c.id}`, c)
    }
    const prevById = prev.length ? new Map(prev.map((d) => [d.id, d])) : null
    next = rawTabs.map((tab) => {
      if (tab.conversationId != null) {
        const conv =
          conversationMap.get(
            `${tab.folderId}-${tab.agentType}-${tab.conversationId}`
          ) ?? childSummaries.get(tab.conversationId)
        if (conv) {
          const newTitle =
            formatConversationTitle(conv.title) ||
            runtime.labels.untitledConversation
          const newStatus = conv.status as ConversationStatus | undefined
          if (tab.title !== newTitle || tab.status !== newStatus) {
            const derived = { ...tab, title: newTitle, status: newStatus }
            const prevItem = prevById?.get(tab.id)
            return prevItem && sameDerivedTab(prevItem, derived)
              ? prevItem
              : derived
          }
        }
      }
      return tab
    })
  }

  if (
    prev.length === next.length &&
    next.every((item, i) => item === prev[i])
  ) {
    // Membership may have changed even when the derived output didn't (it
    // usually can't, but the invariant pass is cheap and self-no-ops).
    applyGroupInvariants()
    return
  }
  useTabStore.setState({ tabs: next })
  applyGroupInvariants()
}

/** Pick the agent + provisional flag for a new draft tab. Wraps the pure
 *  `resolveDefaultAgent` helper with tab-store-scoped lookups (folder default
 *  from the live app-workspace store, latest sorted types, fresh flag). */
function resolveAgentForFolder(
  folderId: number,
  inherit: AgentType | null,
  // `undefined` = look the folder default up; `null` = explicitly none.
  folderDefaultOverride?: AgentType | null
): { agentType: AgentType; provisional: boolean } {
  const folderDefault =
    folderDefaultOverride !== undefined
      ? folderDefaultOverride
      : (useAppWorkspaceStore.getState().folders.find((f) => f.id === folderId)
          ?.default_agent_type ?? null)
  return resolveDefaultAgent({
    folderDefault,
    inherit,
    sortedTypes: runtime.sortedAvailableAgents,
    fresh: runtime.agentsFresh,
  })
}

function makeReplacementDraftTab(preferred?: TabItemInternal): TabItemInternal {
  const { folders, allFolders } = useAppWorkspaceStore.getState()
  // A closing chat-mode tab (its hidden chat folder, or the in-memory draft
  // flag) must not seed the replacement draft — that folder is hidden from
  // folder lists and has no real project cwd. Fall back to a real folder.
  // Detection reads `allFolders` (the in-memory draft flag is dropped on reload,
  // and `folders` excludes chat folders after refetch), while the fallback pool
  // reads the user-facing `folders`.
  const preferredIsChat =
    preferred?.isChat === true ||
    allFolders.find((f) => f.id === preferred?.folderId)?.kind === "chat"
  const nonChatFallbackId = folders.find((f) => f.kind !== "chat")?.id ?? 0
  const folderId = preferredIsChat
    ? nonChatFallbackId
    : (preferred?.folderId ?? nonChatFallbackId)
  const workingDir = preferredIsChat
    ? (folders.find((f) => f.id === folderId)?.path ?? "")
    : (preferred?.workingDir ??
      folders.find((f) => f.id === folderId)?.path ??
      "")
  // If we have a preferred (closing) tab, inherit BOTH its agent and its
  // provisional flag — never silently launder a system best-guess into a
  // confirmed value just because the source tab was closed.
  const { agentType, provisional } = preferred?.agentType
    ? {
        agentType: preferred.agentType,
        provisional: preferred.agentTypeProvisional ?? false,
      }
    : resolveAgentForFolder(folderId, null)
  return {
    id: makeNewConversationTabId(),
    kind: "conversation",
    folderId,
    conversationId: null,
    agentType,
    title: runtime.labels.newConversation,
    isPinned: true,
    workingDir,
    agentTypeProvisional: provisional,
  }
}

function initialTabState() {
  return {
    rawTabs: [] as TabItemInternal[],
    activeTabId: null as string | null,
    previewReplacedTabIds: [] as string[],
    draftRetargetRequests: [] as DraftRetargetRequest[],
    tabsHydrated: false,
    ...readPersistedGroupState(),
    tabDrag: null as TabStoreState["tabDrag"],
    childSummaries: new Map<number, DbConversationSummary>(),
    tabs: [] as TabItemInternal[],
    reseedTick: 0,
    saveReconcileTick: 0,
  }
}

export const useTabStore = create<TabStoreState>()((set, get) => ({
  ...initialTabState(),

  openTab: (
    requestedFolderId,
    conversationId,
    agentType,
    pin = false,
    title,
    opts
  ) => {
    const folderId = canonicalConversationFolder(
      requestedFolderId,
      conversationId,
      agentType
    )
    useFolderTabsStore.getState().activateScope(folderScope(folderId))
    const prevState = get()
    const existingIndex = findTabIndexForConversation(
      prevState.rawTabs,
      folderId,
      agentType,
      conversationId
    )

    if (existingIndex >= 0) {
      const activateTabId = prevState.rawTabs[existingIndex].id
      noteTabRequested(activateTabId)
      if (pin && !prevState.rawTabs[existingIndex].isPinned) {
        const updated = [...prevState.rawTabs]
        updated[existingIndex] = { ...updated[existingIndex], isPinned: true }
        set({ rawTabs: updated, activeTabId: activateTabId })
        recomputeTabs()
      } else {
        focusTab(activateTabId)
      }
      runtime.activateConversationPane()
      return
    }

    // New tabs land in the focused group (the active tab's group).
    const targetGroup = resolveTargetGroup(prevState)

    // Format the seed title so a draft/conversation title carrying an inline
    // reference link (`[README.md](file://…)`) shows its label, not raw
    // Markdown, before the `tabs` derivation re-derives it from the refreshed
    // conversation list.
    const resolvedTitle =
      formatConversationTitle(
        title ??
          useAppWorkspaceStore
            .getState()
            .conversations.find(
              (c) =>
                c.id === conversationId &&
                c.agent_type === agentType &&
                c.folder_id === folderId
            )?.title
      ) || runtime.labels.untitledConversation

    const tabId = makeConversationTabId(folderId, agentType, conversationId)
    const newTab: TabItemInternal = {
      id: tabId,
      kind: "conversation",
      folderId,
      conversationId,
      agentType,
      title: resolvedTitle,
      isPinned: pin,
    }

    if (pin) {
      set({
        rawTabs: insertTab(prevState.rawTabs, newTab, opts?.index),
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Preview replacement stays within the focused group — a preview parked in
    // another group is left alone (the new tab gets a slot of its own instead).
    // A pinned tab is never the preview, even one a client predating the pin
    // flag synced without `isPinned`.
    const previewIndex = prevState.rawTabs.findIndex(
      (t) =>
        isPreviewTab(t) &&
        isTabInScope(t) &&
        groupOfTab(prevState.groupOf, prevState.groupLayout, t.id) ===
          targetGroup
    )
    if (previewIndex >= 0) {
      const updated = [...prevState.rawTabs]
      const replacedPreviewTabId = updated[previewIndex].id
      updated[previewIndex] = newTab
      set({
        rawTabs: updated,
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
        previewReplacedTabIds: [
          ...prevState.previewReplacedTabIds,
          replacedPreviewTabId,
        ],
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    set({
      rawTabs: insertTab(prevState.rawTabs, newTab, opts?.index),
      activeTabId: tabId,
      groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  replaceTabWithConversation: (
    tabId,
    requestedFolderId,
    conversationId,
    agentType,
    { pin, title }
  ) => {
    const folderId = canonicalConversationFolder(
      requestedFolderId,
      conversationId,
      agentType
    )
    const prevState = get()
    const index = prevState.rawTabs.findIndex((t) => t.id === tabId)
    const target = index >= 0 ? prevState.rawTabs[index] : undefined
    const replaceable =
      target != null &&
      target.isAnchored !== true &&
      (!isDraftTab(target) || isBlankDraft(target)) &&
      !hasOpenMessageEdit(target.id) &&
      (!useFolderTabsStore.getState().enabled ||
        folderScope(target.folderId) === folderScope(folderId)) &&
      findTabIndexForConversation(
        prevState.rawTabs,
        folderId,
        agentType,
        conversationId
      ) < 0
    if (!target || !replaceable) {
      get().openTab(folderId, conversationId, agentType, pin, title)
      return
    }
    useFolderTabsStore.getState().activateScope(folderScope(folderId))
    const state = get()
    const slot = state.rawTabs.findIndex((t) => t.id === target.id)
    if (slot < 0) return
    const group = groupOfTab(state.groupOf, state.groupLayout, target.id)
    const resolvedTitle =
      formatConversationTitle(
        title ??
          useAppWorkspaceStore
            .getState()
            .conversations.find(
              (c) =>
                c.id === conversationId &&
                c.agent_type === agentType &&
                c.folder_id === folderId
            )?.title
      ) || runtime.labels.untitledConversation
    const newId = makeConversationTabId(folderId, agentType, conversationId)
    const newTab: TabItemInternal = {
      id: newId,
      kind: "conversation",
      folderId,
      conversationId,
      agentType,
      title: resolvedTitle,
      isPinned: pin,
    }
    // ⌘⇧T brings the replaced session back. An empty draft has nothing to
    // bring back; its (empty) composer state goes with it.
    if (isDraftTab(target)) {
      clearMessageInputDraftV2(buildNewConversationDraftStorageKey(target.id))
      clearContinuationLink(target.id)
    } else {
      pushClosedTab(snapshotStripTab(target, slot))
    }
    discardAskSelectionPrompts(target.id)
    discardComposerPrefill(target.id)
    const rawTabs = [...state.rawTabs]
    rawTabs[slot] = newTab
    set({
      rawTabs,
      activeTabId: newId,
      groupOf: { ...state.groupOf, [newId]: group },
      // Released like a replaced preview: disconnected only once idle, so a
      // turn still running in it goes on (see `disconnectIfIdle`).
      previewReplacedTabIds: [...state.previewReplacedTabIds, target.id],
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  closeTab: (tabId, options) => {
    const shouldActivateConversation = tabId === get().activeTabId

    const prevState = get()
    const index = prevState.rawTabs.findIndex((t) => t.id === tabId)
    if (index >= 0) {
      const closingTab = prevState.rawTabs[index]
      if (options?.recordForReopen !== false) {
        pushClosedTab(snapshotStripTab(closingTab, index))
      }
      const next = prevState.rawTabs.filter((t) => t.id !== tabId)
      // A closing draft's composer text is scoped to that tab's key. Drop it —
      // unless this close spawns the replacement draft, which continues the same
      // slot and inherits the text instead of losing it silently.
      const closingDraftKey = isDraftTab(closingTab)
        ? buildNewConversationDraftStorageKey(closingTab.id)
        : null
      // An "ask about this selection" prompt parked for this tab has no panel
      // left to drain it. Drop it rather than leave it in the module buffer for
      // the rest of the session — the tab id is never reused, so it could only
      // sit there.
      discardAskSelectionPrompts(closingTab.id)
      discardComposerPrefill(closingTab.id)

      let draftKeyHandedOver = false

      if (useFolderTabsStore.getState().enabled && !next.some(isTabInScope)) {
        set({ rawTabs: next, activeTabId: null })
      } else if (next.length === 0) {
        if (useAppWorkspaceStore.getState().folders.length === 0) {
          set({ rawTabs: [], activeTabId: null })
        } else {
          const replacementTab = makeReplacementDraftTab(closingTab)
          set({ rawTabs: [replacementTab], activeTabId: replacementTab.id })
          if (closingDraftKey) {
            draftKeyHandedOver = true
            moveMessageInputDraft(
              closingDraftKey,
              buildNewConversationDraftStorageKey(replacementTab.id)
            )
            // What the draft continues goes with its text.
            moveContinuationLink(closingTab.id, replacementTab.id)
          }
        }
      } else if (tabId === prevState.activeTabId) {
        // Pick the neighbor within the closed tab's group; when the group
        // emptied, fall to the neighboring group's selected tab. While tabs
        // follow the folder only the folder's tabs and groups count: a hidden
        // neighbor would be replaced by the folder's first tab. (The layout is
        // the folder's own, narrowed to its tabs once the tab set is known —
        // narrowed here too for the moments before.)
        const { groupOf, groupLayout, groupSelection } = prevState
        const followsFolder = useFolderTabsStore.getState().enabled
        const closedGroup = groupOfTab(groupOf, groupLayout, tabId)
        const inGroup = (t: TabItemInternal) =>
          isTabInScope(t) &&
          groupOfTab(groupOf, groupLayout, t.id) === closedGroup
        const indexInGroup = prevState.rawTabs
          .filter(inGroup)
          .findIndex((t) => t.id === tabId)
        const groupAfter = next.filter(inGroup)
        let newActiveId: string
        if (groupAfter.length > 0) {
          newActiveId =
            groupAfter[Math.min(indexInGroup, groupAfter.length - 1)].id
        } else {
          const layout = followsFolder
            ? normalizeTree(
                groupLayout,
                new Set(
                  prevState.rawTabs
                    .filter(isTabInScope)
                    .map((t) => groupOfTab(groupOf, groupLayout, t.id))
                )
              )
            : groupLayout
          const neighbor = neighborGroupId(layout, closedGroup)
          const neighborSelection = neighbor
            ? groupSelection[neighbor]
            : undefined
          newActiveId =
            neighborSelection != null &&
            next.some((t) => t.id === neighborSelection && isTabInScope(t))
              ? neighborSelection
              : (next.find(isTabInScope) ?? next[0]).id
        }
        set({ rawTabs: next, activeTabId: newActiveId })
      } else {
        set({ rawTabs: next })
      }
      if (closingDraftKey && !draftKeyHandedOver) {
        clearMessageInputDraftV2(closingDraftKey)
        clearContinuationLink(closingTab.id)
      }
      recomputeTabs()
    }

    if (shouldActivateConversation) {
      runtime.activateConversationPane()
    }
  },

  closeConversationTab: (folderId, conversationId, agentType) => {
    const target = get().rawTabs.find(
      (tab) =>
        tab.folderId === folderId &&
        tab.conversationId === conversationId &&
        tab.agentType === agentType
    )
    // Every caller reaches here right after `deleteConversation` — the row is
    // gone, so the tab must not be offered back by "reopen closed tab". Its
    // sub-agents' threads go with it.
    for (const tab of get().rawTabs) {
      if (
        isSubagentTab(tab) &&
        tab.subagent.parentConversationId === conversationId
      ) {
        get().closeTab(tab.id, { recordForReopen: false })
      }
    }
    if (!target) return
    get().closeTab(target.id, { recordForReopen: false })
  },

  closeOtherTabs: (tabId) => {
    const prevState = get()
    const target = prevState.rawTabs.find((tab) => tab.id === tabId)
    if (!target) return
    // Group-scoped while split: "others" are the target's group siblings only —
    // the other groups keep their tabs (IDEA semantics). Pinned tabs stay, as
    // in a browser.
    const { groupOf, groupLayout } = prevState
    const targetGroup = groupOfTab(groupOf, groupLayout, tabId)
    const keep =
      groupLayout.type === "group"
        ? prevState.rawTabs.filter(
            (tab) =>
              tab.id === tabId || !isTabInScope(tab) || tab.isAnchored === true
          )
        : prevState.rawTabs.filter(
            (tab) =>
              tab.id === tabId ||
              !isTabInScope(tab) ||
              tab.isAnchored === true ||
              groupOfTab(groupOf, groupLayout, tab.id) !== targetGroup
          )
    if (keep.length === prevState.rawTabs.length) {
      // Nothing to close (already alone in its group) — just focus.
      focusTab(tabId)
      return
    }
    const keepIds = new Set(keep.map((tab) => tab.id))
    const closing = batchCloseSlots(
      prevState.rawTabs,
      (tab) => !keepIds.has(tab.id)
    )
    for (const [tab, slot] of closing) {
      pushClosedTab(snapshotStripTab(tab, slot))
    }
    set({ rawTabs: keep, activeTabId: tabId })
    recomputeTabs()
  },

  closeTabsToRight: (tabId, shownOrder) => {
    const at = shownOrder.indexOf(tabId)
    if (at < 0) return
    const right = new Set(shownOrder.slice(at + 1))
    const prevState = get()
    const closes = (tab: TabItemInternal) =>
      right.has(tab.id) && tab.isAnchored !== true
    if (!prevState.rawTabs.some(closes)) return
    for (const [tab, slot] of batchCloseSlots(prevState.rawTabs, closes)) {
      pushClosedTab(snapshotStripTab(tab, slot))
    }
    const rawTabs = prevState.rawTabs.filter((tab) => !closes(tab))
    // The tab the menu was opened on takes over when the one in front went.
    const activeClosed =
      prevState.activeTabId != null &&
      !rawTabs.some((tab) => tab.id === prevState.activeTabId)
    set({ rawTabs, ...(activeClosed ? { activeTabId: tabId } : {}) })
    recomputeTabs()
  },

  closeAllTabs: () => {
    // Pinned tabs stay, as in a browser. With any of them on screen nothing
    // needs replacing: the one in front stays, or the first pinned tab takes
    // over.
    const current = get()
    const pinnedOnScreen = current.rawTabs.filter(
      (tab) => isTabInScope(tab) && tab.isAnchored === true
    )
    if (pinnedOnScreen.length > 0) {
      const closes = (tab: TabItemInternal) =>
        isTabInScope(tab) && tab.isAnchored !== true
      if (!current.rawTabs.some(closes)) return
      for (const [tab, slot] of batchCloseSlots(current.rawTabs, closes)) {
        pushClosedTab(snapshotStripTab(tab, slot))
      }
      const activeStays = pinnedOnScreen.some(
        (tab) => tab.id === current.activeTabId
      )
      set({
        rawTabs: current.rawTabs.filter((tab) => !closes(tab)),
        activeTabId: activeStays ? current.activeTabId : pinnedOnScreen[0].id,
      })
      recomputeTabs()
      if (!activeStays) runtime.activateConversationPane()
      return
    }
    if (useFolderTabsStore.getState().enabled) {
      const st = get()
      for (const [tab, slot] of batchCloseSlots(st.rawTabs, isTabInScope)) {
        pushClosedTab(snapshotStripTab(tab, slot))
      }
      set({
        rawTabs: st.rawTabs.filter((tab) => !isTabInScope(tab)),
        activeTabId: null,
      })
      recomputeTabs()
      return
    }
    if (useAppWorkspaceStore.getState().folders.length === 0) {
      const prevState = get()
      if (prevState.rawTabs.length === 0 && prevState.activeTabId == null) {
        return
      }
      for (const [tab, slot] of batchCloseSlots(prevState.rawTabs)) {
        pushClosedTab(snapshotStripTab(tab, slot))
      }
      set({ rawTabs: [], activeTabId: null })
      recomputeTabs()
      return
    }

    const prevState = get()
    const seedTab =
      prevState.rawTabs.find((t) => isDraftTab(t) && t.workingDir) ??
      prevState.rawTabs.find((t) => t.id === prevState.activeTabId) ??
      prevState.rawTabs[0]
    const replacementTab = makeReplacementDraftTab(seedTab)
    for (const [tab, slot] of batchCloseSlots(prevState.rawTabs)) {
      pushClosedTab(snapshotStripTab(tab, slot))
    }
    set({ rawTabs: [replacementTab], activeTabId: replacementTab.id })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  closeTabsByFolder: (folderId) => {
    const prevState = get()
    const remaining = prevState.rawTabs.filter((t) => t.folderId !== folderId)
    if (remaining.length === prevState.rawTabs.length) return
    // Deliberately not recorded for reopen: this runs when the folder itself
    // stops existing (a removed worktree, or the sidebar's "remove folder"),
    // so every tab it drops points at a cwd that is gone.

    const currentActive = prevState.activeTabId
    const stillActive =
      currentActive != null && remaining.some((t) => t.id === currentActive)

    set({
      rawTabs: remaining,
      activeTabId: stillActive ? currentActive : (remaining[0]?.id ?? null),
    })
    recomputeTabs()
  },

  switchTab: (tabId) => {
    if (!get().rawTabs.some((t) => t.id === tabId)) return
    noteTabRequested(tabId)
    const tab = get().rawTabs.find((t) => t.id === tabId)!
    useFolderTabsStore.getState().activateScope(folderScope(tab.folderId))
    focusTab(tabId)
    runtime.activateConversationPane()
  },

  pinTab: (tabId) => {
    const prev = get().rawTabs
    const idx = prev.findIndex((t) => t.id === tabId)
    // No-op when the tab is absent or already pinned — `map` would otherwise
    // always allocate a new array (and a new object for the matched tab),
    // needlessly re-rendering that tab's `ownTab` subscriber.
    if (idx < 0 || prev[idx].isPinned) return
    const next = prev.map((t, i) => (i === idx ? { ...t, isPinned: true } : t))
    set({ rawTabs: next })
    recomputeTabs()
  },

  setTabAnchored: (tabId, anchored) => {
    const prev = get().rawTabs
    const from = prev.findIndex((t) => t.id === tabId)
    if (from < 0 || (prev[from].isAnchored === true) === anchored) return
    // The manual order is what every view falls back to, so it follows the
    // move a browser makes: a pinned tab goes after the last pinned one, an
    // unpinned one before the first tab that isn't pinned (the start of the
    // rest, in whichever group). Pinned tabs show first either way.
    const without = prev.filter((_, i) => i !== from)
    let at: number
    if (anchored) {
      at = 0
      without.forEach((t, i) => {
        if (t.isAnchored === true) at = i + 1
      })
    } else {
      at = without.findIndex((t) => t.isAnchored !== true)
      if (at < 0) at = without.length
    }
    const tab: TabItemInternal = anchored
      ? { ...prev[from], isAnchored: true, isPinned: true }
      : { ...prev[from], isAnchored: false }
    set({ rawTabs: insertTab(without, tab, at) })
    recomputeTabs()
  },

  toggleGroupTile: (groupId) => {
    const st = get()
    set({
      tileByGroup: { ...st.tileByGroup, [groupId]: !st.tileByGroup[groupId] },
    })
    persistGroupState()
  },

  splitTab: (tabId, direction, opts) => {
    const st = get()
    const tab = st.rawTabs.find((t) => t.id === tabId)
    if (!tab) return
    const sourceGroup = groupOfTab(st.groupOf, st.groupLayout, tabId)

    if (opts.move) {
      // A draft belongs to the group that spawned it (see `moveTabToGroup`);
      // plain split still seeds the new group with its own draft.
      if (isDraftTab(tab)) return
      // Moving the group's only tab would just shift the group — pointless.
      const groupSize = st.rawTabs.filter(
        (t) =>
          isTabInScope(t) &&
          groupOfTab(st.groupOf, st.groupLayout, t.id) === sourceGroup
      ).length
      if (groupSize < 2) return
      const newGroupId = makeGroupId()
      const nextLayout = splitGroup(
        st.groupLayout,
        sourceGroup,
        direction,
        newGroupId
      )
      if (nextLayout === st.groupLayout) return
      set({
        groupLayout: nextLayout,
        groupOf: { ...st.groupOf, [tabId]: newGroupId },
        activeTabId: tabId,
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Split without moving: the new group opens with a fresh draft seeded from
    // the context tab (conversations can't be duplicated across groups).
    const newGroupId = makeGroupId()
    const nextLayout = splitGroup(
      st.groupLayout,
      sourceGroup,
      direction,
      newGroupId
    )
    if (nextLayout === st.groupLayout) return
    const inherit =
      tab.conversationId != null || !tab.agentTypeProvisional
        ? tab.agentType
        : null
    const { allFolders, folders } = useAppWorkspaceStore.getState()
    const contextIsChat =
      tab.isChat === true ||
      allFolders.find((f) => f.id === tab.folderId)?.kind === "chat"
    let newTab: TabItemInternal
    if (contextIsChat) {
      const { agentType, provisional } = resolveAgentForFolder(0, inherit, null)
      newTab = {
        id: makeNewConversationTabId(),
        kind: "conversation",
        folderId: 0,
        conversationId: null,
        agentType,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir: undefined,
        agentTypeProvisional: provisional,
        isChat: true,
      }
    } else {
      const { agentType, provisional } = resolveAgentForFolder(
        tab.folderId,
        inherit
      )
      newTab = {
        id: makeNewConversationTabId(),
        kind: "conversation",
        folderId: tab.folderId,
        conversationId: null,
        agentType,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir:
          tab.workingDir ?? folders.find((f) => f.id === tab.folderId)?.path,
        agentTypeProvisional: provisional,
      }
    }
    set({
      rawTabs: [...st.rawTabs, newTab],
      groupLayout: nextLayout,
      groupOf: { ...st.groupOf, [newTab.id]: newGroupId },
      activeTabId: newTab.id,
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  moveTabToGroup: (tabId, targetGroupId, opts) => {
    const st = get()
    const moving = st.rawTabs.find((t) => t.id === tabId)
    if (!moving) return
    if (!leafIds(st.groupLayout).includes(targetGroupId)) return
    if (groupOfTab(st.groupOf, st.groupLayout, tabId) === targetGroupId) return
    // Drafts are group-bound: each group owns its unsent scratch conversation
    // (its own composer text, its own folder/agent context), and every group can
    // spawn one on demand from its own strip. Moving one would leave a group
    // without its slot and hand another a second. Reordering WITHIN the group is
    // unaffected (that path never reaches here). The UI hides both move
    // affordances for drafts; this backstops the programmatic path.
    if (isDraftTab(moving)) return

    if (opts?.index == null) {
      // Menu move: only the assignment changes — the tab keeps its global
      // rawTabs slot (group order = filtered order), so the synced payload
      // stays byte-identical and no save fires.
      set({
        groupOf: { ...st.groupOf, [tabId]: targetGroupId },
        activeTabId: tabId,
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Drag drop: land at `index` within the target group. Splice the tab out,
    // then insert it before the target group's k-th visible member (after
    // its last visible member when k = member count). Hidden members do not
    // have drop slots. This partition insert preserves every OTHER
    // group's relative order. rawTabs order changes, which
    // syncs like any user reorder.
    const without = st.rawTabs.filter((t) => t.id !== tabId)
    const memberSlots: number[] = []
    without.forEach((t, i) => {
      if (
        groupOfTab(st.groupOf, st.groupLayout, t.id) === targetGroupId &&
        isTabInScope(t)
      ) {
        memberSlots.push(i)
      }
    })
    const k = Math.max(0, Math.min(opts.index, memberSlots.length))
    const insertPos =
      k < memberSlots.length
        ? memberSlots[k]
        : memberSlots.length > 0
          ? memberSlots[memberSlots.length - 1] + 1
          : without.length
    const nextRaw = [
      ...without.slice(0, insertPos),
      moving,
      ...without.slice(insertPos),
    ]
    set({
      rawTabs: nextRaw,
      groupOf: { ...st.groupOf, [tabId]: targetGroupId },
      activeTabId: tabId,
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  updateTabDrag: (drag) => {
    const prev = get().tabDrag
    // Per-frame writes: skip the set when nothing observable changed.
    if (
      prev != null &&
      prev.tabId === drag.tabId &&
      prev.x === drag.x &&
      prev.y === drag.y &&
      prev.overGroupId === drag.overGroupId
    ) {
      return
    }
    set({ tabDrag: drag })
  },

  endTabDrag: () => {
    if (get().tabDrag == null) return
    set({ tabDrag: null })
  },

  toggleGroupOrientation: (groupId) => {
    const st = get()
    const next = toggleOrientation(st.groupLayout, groupId)
    if (next === st.groupLayout) return
    set({ groupLayout: next })
    persistGroupState()
  },

  dissolveGroup: (groupId) => {
    const st = get()
    const target = neighborGroupId(st.groupLayout, groupId)
    if (!target) return
    const groupOf = { ...st.groupOf }
    for (const tab of st.rawTabs) {
      if (
        isTabInScope(tab) &&
        groupOfTab(st.groupOf, st.groupLayout, tab.id) === groupId
      ) {
        groupOf[tab.id] = target
      }
    }
    set({ groupOf, groupLayout: removeGroup(st.groupLayout, groupId) })
    recomputeTabs()
  },

  unsplitAll: () => {
    const st = get()
    if (st.groupLayout.type === "group") return
    // Everyone falls back to the (kept) first leaf; rawTabs order is already
    // the merged display order, so the synced payload doesn't change. Only
    // the view on screen unsplits: its assignments are its own.
    set({
      groupLayout: singleGroupLayout(firstLeafId(st.groupLayout)),
      groupOf: {},
    })
    recomputeTabs()
  },

  reorderGroupTabs: (groupId, orderedTabs) => {
    const st = get()
    const raw = st.rawTabs
    const slots: number[] = []
    raw.forEach((tab, i) => {
      if (
        isTabInScope(tab) &&
        groupOfTab(st.groupOf, st.groupLayout, tab.id) === groupId
      ) {
        slots.push(i)
      }
    })
    // Partition permutation: only this group's slots move, so the other
    // groups' persisted positions stay byte-stable.
    const next = permuteSlots(raw, slots, orderedTabs)
    if (!next) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  resizeGroupSplit: (splitId, handleIndex, boundaryFraction) => {
    const st = get()
    const next = resizeSplitAt(
      st.groupLayout,
      splitId,
      handleIndex,
      boundaryFraction
    )
    if (next === st.groupLayout) return
    set({ groupLayout: next })
    schedulePersistGroupState()
  },

  reorderTabs: (reorderedTabs) => {
    // The unsplit strip shows every tab, so its slots are the whole array —
    // otherwise identical to a group reorder, guards included.
    const raw = get().rawTabs
    const next = permuteSlots(
      raw,
      raw.flatMap((tab, i) => (isTabInScope(tab) ? [i] : [])),
      reorderedTabs
    )
    if (!next) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  openSubagentTab: (target, opts) => {
    const tabId = makeSubagentTabId(
      target.parentConversationId,
      target.toolCallId
    )
    const known = get().rawTabs.find((t) => t.id === tabId)
    if (known) {
      useFolderTabsStore.getState().activateScope(folderScope(known.folderId))
      noteTabRequested(tabId)
      // What the opener knows now (the sub-agent's id once its call settled)
      // replaces what the tab was opened with; nothing it knew is dropped.
      const merged = mergeSubagentTarget(known.subagent, target)
      const pin = opts?.pin === true && !known.isPinned
      if (pin || merged !== known.subagent) {
        set({
          rawTabs: get().rawTabs.map((t) =>
            t.id === tabId
              ? { ...t, subagent: merged, ...(pin ? { isPinned: true } : {}) }
              : t
          ),
          activeTabId: tabId,
        })
        recomputeTabs()
      } else {
        focusTab(tabId)
      }
      runtime.activateConversationPane()
      return tabId
    }

    const parentOf = (tabs: TabItemInternal[]) =>
      tabs.find(
        (t) =>
          t.kind === "conversation" &&
          t.conversationId === target.parentConversationId
      )
    const before = get()
    const activeTab = before.rawTabs.find((t) => t.id === before.activeTabId)
    const folderId =
      opts?.folderId ??
      parentOf(before.rawTabs)?.folderId ??
      knownConversationRow(target.parentConversationId, "claude_code")
        ?.folder_id ??
      activeTab?.folderId ??
      0
    useFolderTabsStore.getState().activateScope(folderScope(folderId))

    const prevState = get()
    const parent = parentOf(prevState.rawTabs)
    // Beside its parent, in the parent's group; else where new tabs land.
    const targetGroup =
      parent && isTabInScope(parent)
        ? groupOfTab(prevState.groupOf, prevState.groupLayout, parent.id)
        : resolveTargetGroup(prevState)
    const pinned = opts?.pin === true
    const newTab: TabItemInternal = {
      id: tabId,
      kind: "subagent",
      folderId,
      conversationId: null,
      agentType: "claude_code",
      title:
        formatConversationTitle(opts?.title) ||
        target.description ||
        target.subagentType ||
        runtime.labels.untitledConversation,
      isPinned: pinned,
      subagent: target,
    }
    let raw = prevState.rawTabs
    // A parent shown as the group's preview is in use now: keep it.
    if (parent && !parent.isPinned) {
      raw = raw.map((t) => (t.id === parent.id ? { ...t, isPinned: true } : t))
    }
    let at: number | undefined
    let replaced: string | null = null
    if (!pinned) {
      const previewIndex = raw.findIndex(
        (t) =>
          isPreviewTab(t) &&
          isTabInScope(t) &&
          groupOfTab(prevState.groupOf, prevState.groupLayout, t.id) ===
            targetGroup
      )
      if (previewIndex >= 0) {
        replaced = raw[previewIndex].id
        raw = raw.filter((t) => t.id !== replaced)
        at = previewIndex
      }
    }
    if (parent) {
      const parentIndex = raw.findIndex((t) => t.id === parent.id)
      if (parentIndex >= 0) at = parentIndex + 1
    }
    if (opts?.index != null) at = opts.index
    set({
      rawTabs: insertTab(raw, newTab, at),
      activeTabId: tabId,
      groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      ...(replaced != null
        ? {
            previewReplacedTabIds: [
              ...prevState.previewReplacedTabIds,
              replaced,
            ],
          }
        : {}),
    })
    recomputeTabs()
    runtime.activateConversationPane()
    return tabId
  },

  updateSubagentTab: (tabId, patch) => {
    const prev = get().rawTabs
    const tab = prev.find((t) => t.id === tabId)
    if (!tab || !isSubagentTab(tab)) return
    const subagent = mergeSubagentTarget(tab.subagent, patch)
    const title = patch.title ? formatConversationTitle(patch.title) : ""
    const next: TabItemInternal = {
      ...tab,
      subagent,
      ...(title ? { title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    }
    if (sameDerivedTab(next, tab)) return
    set({ rawTabs: prev.map((t) => (t.id === tabId ? next : t)) })
    recomputeTabs()
  },

  openNewConversationTab: (folderId, workingDir, options) => {
    // "New conversation" while a chat conversation is active resolves the active
    // (hidden) chat folder. Never pile a second conversation into a
    // per-conversation chat folder — start a fresh folderless chat draft
    // instead. Single choke point for every "new conversation" entry point.
    if (
      useAppWorkspaceStore.getState().allFolders.find((f) => f.id === folderId)
        ?.kind === "chat"
    ) {
      return get().openChatModeTab({
        ...(options?.targetGroup != null
          ? { targetGroup: options.targetGroup }
          : {}),
        ...(options?.forceAgent != null
          ? { forceAgent: options.forceAgent }
          : {}),
      })
    }
    // Read before any folder scope switch: "inherit from active" means the
    // tab the user is on, not whatever the target folder had selected.
    const inheritFromActive = options?.inheritFromActive === true
    let inherit: AgentType | null = null
    if (inheritFromActive) {
      const st = get()
      const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId)
      if (
        activeTab &&
        (activeTab.conversationId != null || !activeTab.agentTypeProvisional)
      ) {
        inherit = activeTab.agentType
      }
    }
    // A draft MOVED to this folder (the composer's folder picker) stays the
    // same tab, so its composer and typed prompt come along. While tabs
    // follow the folder it keeps its scope until the queued retarget lands
    // and the scope follows it (`consumeDraftRetargets`); switching first
    // would hide it and hand the user the target folder's own draft instead.
    const movingDraft =
      options?.retargetTabId != null
        ? get().rawTabs.find(
            (t) => t.id === options.retargetTabId && isDraftTab(t)
          )
        : undefined
    if (!movingDraft) {
      useFolderTabsStore.getState().activateScope(folderScope(folderId))
    }
    // A forced agent short-circuits resolution entirely (it outranks the folder
    // default, which `inherit` would lose to) and is never provisional — it is
    // explicit caller intent, not a guess to be corrected once the agent list
    // goes fresh.
    const { agentType: targetAgent, provisional } =
      options?.forceAgent != null
        ? { agentType: options.forceAgent, provisional: false }
        : resolveAgentForFolder(folderId, inherit, options?.folderDefaultAgent)

    const tabId = makeNewConversationTabId()
    const prevState = get()
    // Per-group draft singleton: reuse the target group's existing draft tab
    // (regardless of folder), so each group carries at most one draft.
    const targetGroup = movingDraft
      ? groupOfTab(prevState.groupOf, prevState.groupLayout, movingDraft.id)
      : resolveTargetGroup(prevState, options?.targetGroup)
    const existingTab =
      movingDraft ??
      prevState.rawTabs.find(
        (t) =>
          isDraftTab(t) &&
          isTabInScope(t) &&
          groupOfTab(prevState.groupOf, prevState.groupLayout, t.id) ===
            targetGroup
      )

    if (!existingTab) {
      const newTab: TabItemInternal = {
        id: tabId,
        kind: "conversation",
        folderId,
        conversationId: null,
        agentType: targetAgent,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir,
        agentTypeProvisional: provisional,
      }
      set({
        rawTabs: insertTab(prevState.rawTabs, newTab, options?.index),
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return { tabId, agentType: targetAgent, folderId }
    }
    noteTabRequested(existingTab.id)

    const folderChanged = existingTab.folderId !== folderId
    const workingDirChanged = existingTab.workingDir !== workingDir
    const agentChanged = existingTab.agentType !== targetAgent
    const provisionalChanged =
      (existingTab.agentTypeProvisional ?? false) !== provisional

    // The singleton means a reopened draft resolves to THIS draft rather than a
    // tab of its own, so the slot it was closed from has to move this one — a
    // close-all walked back would otherwise leave the draft shunted to the end
    // of the strip it is meant to rebuild. Only the reopen path passes an
    // index, and drafts never reach `buildPersistItems`, so no save fires.
    const nextRawTabs =
      options?.index == null
        ? prevState.rawTabs
        : moveTabToSlot(prevState.rawTabs, existingTab.id, options.index)
    const moved = nextRawTabs !== prevState.rawTabs

    if (folderChanged || agentChanged) {
      set({
        ...(moved ? { rawTabs: nextRawTabs } : {}),
        draftRetargetRequests: [
          ...prevState.draftRetargetRequests,
          {
            tabId: existingTab.id,
            expectedAgent: existingTab.agentType,
            folderId,
            workingDir,
            agentType: targetAgent,
            provisional,
          },
        ],
      })
      focusTab(existingTab.id)
      if (moved) recomputeTabs()
    } else if (workingDirChanged || provisionalChanged) {
      set({
        rawTabs: nextRawTabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, workingDir, agentTypeProvisional: provisional }
            : tab
        ),
        activeTabId: existingTab.id,
      })
      recomputeTabs()
    } else if (moved) {
      set({ rawTabs: nextRawTabs, activeTabId: existingTab.id })
      recomputeTabs()
    } else {
      focusTab(existingTab.id)
    }
    runtime.activateConversationPane()
    // Every branch above leaves the tab on `targetAgent` in `folderId` — either
    // already there, or once its queued retarget lands.
    return { tabId: existingTab.id, agentType: targetAgent, folderId }
  },

  openChatModeTab: (options) => {
    // Inherit the agent like openNewConversationTab's inherit path — read
    // before the folder-tabs switch to the global scope, from the tab the user
    // is on.
    const before = get()
    const activeTab = before.rawTabs.find((x) => x.id === before.activeTabId)
    const inherit =
      activeTab &&
      (activeTab.conversationId != null || !activeTab.agentTypeProvisional)
        ? activeTab.agentType
        : null
    // A draft MOVED into chat mode (the composer's picker) stays the same tab,
    // prompt and all. It is flipped synchronously below, so the global scope
    // shows it straight away.
    const movingDraft =
      options?.retargetTabId != null
        ? before.rawTabs.find(
            (t) => t.id === options.retargetTabId && isDraftTab(t)
          )
        : undefined
    useFolderTabsStore.getState().activateScope("global")
    const st = get()
    // Same short-circuit as openNewConversationTab: an explicitly forced agent
    // is caller intent and skips resolution.
    const { agentType: targetAgent, provisional } =
      options?.forceAgent != null
        ? { agentType: options.forceAgent, provisional: false }
        : resolveAgentForFolder(0, inherit, null)

    // Per-group draft singleton — all draft handling below is scoped to the
    // target group. Capture its existing draft (if any) up front so a stale
    // ACP session can be torn down after we flip it to chat mode.
    const targetGroup = movingDraft
      ? groupOfTab(st.groupOf, st.groupLayout, movingDraft.id)
      : resolveTargetGroup(st, options?.targetGroup)
    const inTargetGroup = (t: TabItemInternal) =>
      groupOfTab(st.groupOf, st.groupLayout, t.id) === targetGroup
    const isTargetDraft = (t: TabItemInternal) =>
      movingDraft
        ? t.id === movingDraft.id
        : isDraftTab(t) && isTabInScope(t) && inTargetGroup(t)
    const existingDraft = st.rawTabs.find(isTargetDraft)
    const needsDisconnect =
      existingDraft != null &&
      !(existingDraft.isChat && existingDraft.folderId === 0)

    const tabId = makeNewConversationTabId()
    const prevState = get()
    const existingTab = prevState.rawTabs.find(isTargetDraft)

    if (existingTab) noteTabRequested(existingTab.id)
    if (!existingTab) {
      const newTab: TabItemInternal = {
        id: tabId,
        kind: "conversation",
        folderId: 0,
        conversationId: null,
        agentType: targetAgent,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir: undefined,
        agentTypeProvisional: provisional,
        isChat: true,
      }
      set({
        rawTabs: [...prevState.rawTabs, newTab],
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
    } else if (existingTab.isChat && existingTab.folderId === 0) {
      // Already a chat-mode draft. Normally there is nothing to do but focus it
      // — it keeps whatever agent it was on, because `inherit` is only ever a
      // suggestion. A FORCED agent is not: the caller needs this draft to run on
      // that agent (an "ask about this selection" continuing a chat
      // conversation), so re-point it. No explicit disconnect: the connection
      // lifecycle is keyed on the agent and tears the old one down itself, the
      // same way the agent picker's `confirmDraftAgent` relies on.
      if (
        options?.forceAgent != null &&
        (existingTab.agentType !== targetAgent ||
          (existingTab.agentTypeProvisional ?? false) !== provisional)
      ) {
        set({
          activeTabId: existingTab.id,
          rawTabs: prevState.rawTabs.map((tab) =>
            tab.id === existingTab.id
              ? {
                  ...tab,
                  agentType: targetAgent,
                  agentTypeProvisional: provisional,
                }
              : tab
          ),
        })
        recomputeTabs()
      } else {
        focusTab(existingTab.id)
      }
    } else {
      // Existing draft on a real folder: flip it to chat mode SYNCHRONOUSLY
      // (folderId + isChat together), so a send issued before any async teardown
      // can never still create/send in the old folder. The agent is re-resolved
      // for chat mode (no folder default).
      set({
        activeTabId: existingTab.id,
        rawTabs: prevState.rawTabs.map((tab) =>
          tab.id === existingTab.id
            ? {
                ...tab,
                folderId: 0,
                workingDir: undefined,
                isChat: true,
                agentType: targetAgent,
                agentTypeProvisional: provisional,
              }
            : tab
        ),
      })
      recomputeTabs()
      // A draft moved in from a folder can land beside the chat view's own.
      if (movingDraft && useFolderTabsStore.getState().enabled) {
        closeBlankDraftsBeside(existingTab.id)
      }
    }

    if (needsDisconnect && existingDraft) {
      void runtime.acpDisconnect(existingDraft.id).catch((err) => {
        console.error("[TabStore] disconnect chat-mode draft:", err)
      })
    }
    runtime.activateConversationPane()
    // A reused chat draft that was NOT force-agented keeps its own agent (the
    // focus-only branch above), so report that rather than the resolved one.
    const settledAgent =
      existingTab && existingTab.isChat && existingTab.folderId === 0
        ? options?.forceAgent != null
          ? targetAgent
          : existingTab.agentType
        : targetAgent
    return {
      tabId: existingTab ? existingTab.id : tabId,
      agentType: settledAgent,
      folderId: 0,
    }
  },

  setChatDraftWorkingDir: (tabId, workingDir) => {
    const prev = get().rawTabs
    const next = prev.map((tab) => {
      if (tab.id !== tabId) return tab
      // Guard against a stale eager-prepare result landing after the draft
      // already bound, retargeted, or left chat mode. Only patch a still-unbound
      // chat draft, and skip a redundant write to keep the reference stable.
      if (
        !isDraftTab(tab) ||
        tab.isChat !== true ||
        tab.workingDir === workingDir
      ) {
        return tab
      }
      return { ...tab, workingDir }
    })
    if (next.every((tab, i) => tab === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  confirmDraftAgent: (tabId, agentType) => {
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (!isDraftTab(t)) return t // not a draft
      if (t.agentType === agentType && !t.agentTypeProvisional) return t
      return { ...t, agentType, agentTypeProvisional: false }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  setDraftAgentFromFallback: (tabId, agentType) => {
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (!isDraftTab(t)) return t // not a draft
      if (t.agentType === agentType && t.agentTypeProvisional) return t
      return { ...t, agentType, agentTypeProvisional: true }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  bindConversationTab: (
    tabId,
    conversationId,
    agentType,
    title,
    runtimeConversationId,
    folderId,
    workingDir
  ) => {
    const prevState = get()
    const nextTabs = prevState.rawTabs.flatMap((tab) => {
      if (tab.id === tabId) {
        const nextTab: TabItemInternal = {
          ...tab,
          conversationId,
          agentType,
          title: formatConversationTitle(title) || tab.title,
          runtimeConversationId,
          agentTypeProvisional: false,
          ...(folderId != null ? { folderId } : {}),
          ...(workingDir != null ? { workingDir } : {}),
        }
        return [nextTab]
      }
      // Drop any other tab that already represents the same (conversationId,
      // agentType) — conversation IDs are globally unique.
      if (
        tab.conversationId === conversationId &&
        tab.agentType === agentType
      ) {
        return []
      }
      return [tab]
    })

    const activeStillExists =
      prevState.activeTabId != null &&
      nextTabs.some((tab) => tab.id === prevState.activeTabId)
    const boundTab = nextTabs.find((tab) => tab.id === tabId)

    set({
      rawTabs: nextTabs,
      activeTabId: activeStillExists
        ? prevState.activeTabId
        : (boundTab?.id ?? nextTabs[0]?.id ?? null),
    })
    recomputeTabs()
  },

  setTabRuntimeConversationId: (tabId, runtimeConversationId) => {
    const prev = get().rawTabs
    const target = prev.find((tab) => tab.id === tabId)
    if (!target || target.runtimeConversationId === runtimeConversationId) {
      return
    }
    set({
      rawTabs: prev.map((tab) =>
        tab.id === tabId ? { ...tab, runtimeConversationId } : tab
      ),
    })
    recomputeTabs()
  },

  consumeRemoteActivation: () => {
    if (!remoteActivationPending) return false
    remoteActivationPending = false
    return true
  },

  onPreviewTabReplaced: (callback) => {
    previewReplacedCallbacks.add(callback)
    return () => {
      previewReplacedCallbacks.delete(callback)
    }
  },

  hydrate: () => {
    let cancelled = false
    // The tab each group showed when this device last closed: read back from
    // the history cache while the server lists the tabs (device-local, so
    // possibly stale; a session read for nothing just sits in memory).
    prewarmConversationsFromDisk(
      Object.values(get().groupSelection).flatMap((tabId) => {
        const id = /^conv-.+-(\d+)$/.exec(tabId)?.[1]
        return id ? [Number(id)] : []
      })
    )
    void (async () => {
      let snapshotLoaded = false
      try {
        const snap = await listOpenedTabs()
        if (cancelled) return
        snapshotLoaded = true
        tabsSnapshotLoaded = true
        version = snap.version
        serverKnownTabKeys = snapshotSyncKeys(snap.items)
        const restored: TabItemInternal[] = snap.items.map((it) => ({
          id:
            it.conversation_id != null
              ? makeConversationTabId(
                  it.folder_id,
                  it.agent_type,
                  it.conversation_id
                )
              : makeNewConversationTabId(),
          kind: "conversation",
          folderId: it.folder_id,
          conversationId: it.conversation_id,
          agentType: it.agent_type,
          title:
            it.conversation_id != null
              ? runtime.labels.loadingConversation
              : runtime.labels.newConversation,
          isPinned: it.is_pinned,
          ...anchoredFromItem(it),
        }))
        const activeItem = snap.items.find(
          (it) => it.is_active && it.conversation_id != null
        )
        // Read the restored tabs' sessions back from the history cache while
        // their views mount: the active one first, the rest behind it.
        prewarmConversationsFromDisk([
          ...(activeItem?.conversation_id != null
            ? [activeItem.conversation_id]
            : []),
          ...snap.items.flatMap((it) =>
            it.conversation_id != null && it !== activeItem
              ? [it.conversation_id]
              : []
          ),
        ])
        let restoredActive: string | null = activeItem
          ? makeConversationTabId(
              activeItem.folder_id,
              activeItem.agent_type,
              activeItem.conversation_id as number
            )
          : null
        // Splice the device-local drafts back in (same frame as the conversation
        // tabs, so the first invariant pass sees complete groups and can't
        // collapse a draft-only one).
        const { tabs: withDrafts, groupOf: draftGroups } =
          mergeRestoredDrafts(restored)
        if (
          pendingRestoreActiveDraft != null &&
          withDrafts.some((tab) => tab.id === pendingRestoreActiveDraft)
        ) {
          restoredActive = pendingRestoreActiveDraft
        }
        if (!restoredActive && withDrafts.length > 0) {
          restoredActive = withDrafts[0].id
        }
        set({
          rawTabs: withDrafts,
          activeTabId: restoredActive,
          ...(Object.keys(draftGroups).length > 0
            ? { groupOf: { ...get().groupOf, ...draftGroups } }
            : {}),
        })
        recomputeTabs()
        // Baseline from the POST-restore state: drafts never enter the payload,
        // so restoring focus onto a draft simply means no tab carries
        // `is_active`. Seeding that as the baseline keeps the restore free of a
        // CAS save (and of the focus broadcast that would follow it).
        lastSavedPayload = JSON.stringify(
          buildPersistItems(withDrafts, restoredActive)
        )
      } catch (err) {
        console.error("[TabStore] listOpenedTabs failed:", err)
        if (!cancelled) {
          // The snapshot is the CONVERSATION half only; the drafts are
          // device-local and still valid, so restore them rather than starting
          // blank. Everything that could destroy on-disk state — the invariant
          // prune, the blob write, the composer-key sweep — stays parked behind
          // `tabsSnapshotLoaded` until a snapshot actually lands (the refetch
          // that follows the subscription usually rescues it seconds later).
          const { tabs: draftsOnly, groupOf: draftGroups } =
            mergeRestoredDrafts(get().rawTabs)
          if (draftsOnly.length > 0) {
            const focus =
              pendingRestoreActiveDraft != null &&
              draftsOnly.some((tab) => tab.id === pendingRestoreActiveDraft)
                ? pendingRestoreActiveDraft
                : draftsOnly[0].id
            set({
              rawTabs: draftsOnly,
              activeTabId: focus,
              groupOf: { ...get().groupOf, ...draftGroups },
            })
            recomputeTabs()
          }
          // Drafts contribute nothing to the payload, so this baseline is the
          // empty list — which stops the save effect from pushing an empty tab
          // set at the server just because the read failed.
          lastSavedPayload = JSON.stringify(
            buildPersistItems(get().rawTabs, get().activeTabId)
          )
        }
      } finally {
        if (!cancelled) {
          set({ tabsHydrated: true })
          // First full invariant pass: with hydration done, blob-seeded group
          // entries that matched nothing (tabs closed on another client) prune
          // and ghost empty groups collapse.
          applyGroupInvariants()
          // Retire composer drafts left behind by tabs that no longer exist
          // (crash / pre-per-tab-key builds). The live set is read when the
          // sweep runs, so a draft opened in the meantime is never swept. Only
          // safe once the tab set is known — after a failed fetch every key
          // would look orphaned and the user's unsent text would be deleted.
          if (snapshotLoaded) {
            sweepOrphanDraftKeys(
              () =>
                new Set(
                  get()
                    .rawTabs.filter(isDraftTab)
                    .map((tab) => tab.id)
                )
            )
          }
          // Apply a remote change that raced ahead of hydration. Call
          // applyRemoteSnapshot directly (not handleTabsChanged): `pending` is
          // an authoritative server snapshot, and routing it through the live
          // handler's `version` gate would drop an equal-version reconcile.
          const pending = pendingRemote
          if (pending && pending.version > version) {
            pendingRemote = null
            applyRemoteSnapshot(pending)
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  },

  runSaveEffect: () => {
    const st = get()
    if (!st.tabsHydrated) return

    // A remote snapshot just mutated rawTabs/focus — consume the one-shot guard
    // so we don't echo it back (which would re-broadcast and ping-pong).
    if (applyingRemote) {
      applyingRemote = false
      return
    }

    const items = buildPersistItems(st.rawTabs, st.activeTabId)
    const payload = JSON.stringify(items)
    // Reverted to the last-saved state → cancel any save still armed.
    if (payload === lastSavedPayload) {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return
    }

    if (saveTimer) clearTimeout(saveTimer)
    const expectedVersion = version
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveOpenedTabs(items, expectedVersion, TAB_ORIGIN)
        .then((res) => {
          version = Math.max(version, res.version)
          if (!res.accepted) {
            // Rejected (another client committed first) → adopt server truth.
            // Apply directly, NOT via handleTabsChanged: we just advanced
            // `version` to `res.version`, so the live handler's
            // `change.version <= version` gate would drop this equal-version
            // snapshot and leave the stale local set in place. applyRemoteSnapshot
            // reconciles on equal version (its guard is strict `<`).
            applyRemoteSnapshot({
              version: res.version,
              origin: "server",
              tabs: res.tabs,
            })
            return
          }
          lastSavedPayload = payload
          // The server now holds exactly what we sent — unless a newer snapshot
          // landed while this was in flight, in which case that apply already
          // recorded the fresher truth and must not be walked back.
          if (res.version === version) {
            serverKnownTabKeys = snapshotSyncKeys(res.tabs)
          }
          const current = JSON.stringify(
            buildPersistItems(get().rawTabs, get().activeTabId)
          )
          if (current !== lastSavedPayload) {
            set({ saveReconcileTick: get().saveReconcileTick + 1 })
          }
        })
        .catch(() => {
          // Ignore save errors; the reconnect refetch reconciles.
        })
    }, 500)
  },

  clearSaveTimer: () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  },

  reconcileChildSummaries: () => {
    const { conversations, conversationsLoading } =
      useAppWorkspaceStore.getState()
    if (conversationsLoading) return
    const conversationKeys = new Set<string>()
    for (const c of conversations) {
      conversationKeys.add(`${c.folder_id}-${c.agent_type}-${c.id}`)
    }
    const rawTabs = get().rawTabs
    const openChildIds = new Set<number>()
    for (const tab of rawTabs) {
      const id = tab.conversationId
      if (id == null) continue
      if (conversationKeys.has(`${tab.folderId}-${tab.agentType}-${id}`)) {
        continue
      }
      openChildIds.add(id)
    }
    // Prune cached summaries for child tabs that have since closed.
    const prevChild = get().childSummaries
    let prunedChild: Map<number, DbConversationSummary> | null = null
    for (const id of prevChild.keys()) {
      if (!openChildIds.has(id)) {
        prunedChild = prunedChild ?? new Map(prevChild)
        prunedChild.delete(id)
      }
    }
    if (prunedChild) {
      set({ childSummaries: prunedChild })
      recomputeTabs()
    }
    // Seed the open child tabs that aren't cached or already being fetched.
    for (const id of openChildIds) {
      if (get().childSummaries.has(id)) continue
      if (childSummaryInFlight.has(id)) continue
      childSummaryInFlight.add(id)
      const epoch = seedEpoch
      // Only the SUMMARY is used below, so ask for the smallest window the
      // backend accepts instead of the legacy full detail. Without a window the
      // response carries every turn of the child session — for a long child
      // that is megabytes of transcript transferred and re-parsed purely to
      // read `detail.summary`. `tailTurns: 1` is the smallest window the
      // backend accepts (it still widens back to the last user turn). The
      // summary describes the whole transcript whatever the window, and it is
      // all the tab label and status read.
      void getFolderConversation(id, { tailTurns: 1 })
        .then((detail) => {
          if (seedEpoch !== epoch) return
          const buffered = childSeedBuffer.get(id)
          if (buffered?.deleted) return
          if (!get().rawTabs.some((tb) => tb.conversationId === id)) return
          let summary = buffered?.summary ?? detail.summary
          if (buffered?.status != null) {
            summary = { ...summary, status: buffered.status }
          }
          const nextChild = new Map(get().childSummaries)
          nextChild.set(id, summary)
          set({ childSummaries: nextChild })
          recomputeTabs()
        })
        .catch(() => {
          // Leave unseeded (e.g. deleted) — a later pass or live event retries.
        })
        .finally(() => {
          if (seedEpoch !== epoch) return
          childSummaryInFlight.delete(id)
          childSeedBuffer.delete(id)
        })
    }
  },

  handleChildConversationChange: (change) => {
    const id = change.kind === "upsert" ? change.summary.id : change.id
    if (get().childSummaries.has(id)) {
      if (change.kind === "upsert") {
        const summary = change.summary
        const prev = get().childSummaries
        if (!prev.has(summary.id)) return
        const next = new Map(prev)
        next.set(summary.id, summary)
        set({ childSummaries: next })
        recomputeTabs()
      } else if (change.kind === "status") {
        const prev = get().childSummaries
        const cur = prev.get(change.id)
        if (!cur || cur.status === change.status) return
        const next = new Map(prev)
        next.set(change.id, { ...cur, status: change.status })
        set({ childSummaries: next })
        recomputeTabs()
      } else {
        const prev = get().childSummaries
        if (!prev.has(change.id)) return
        const next = new Map(prev)
        next.delete(change.id)
        set({ childSummaries: next })
        recomputeTabs()
      }
      return
    }
    // Seed for this id is still in flight — accumulate into the pending buffer.
    if (childSummaryInFlight.has(id)) {
      const pending = childSeedBuffer.get(id) ?? {}
      if (change.kind === "deleted") {
        pending.deleted = true
      } else if (!pending.deleted) {
        if (change.kind === "upsert") {
          pending.summary = change.summary
          pending.status = undefined
        } else {
          pending.status = change.status
        }
      }
      childSeedBuffer.set(id, pending)
    }
  },

  handleChildReconnect: () => {
    seedEpoch += 1
    childSummaryInFlight.clear()
    childSeedBuffer.clear()
    if (get().childSummaries.size !== 0) {
      set({ childSummaries: new Map() })
      recomputeTabs()
    }
    set({ reseedTick: get().reseedTick + 1 })
  },

  handleTabsChanged: (change) => {
    if (change.origin === TAB_ORIGIN) {
      // Our own accepted save, echoed back: nothing to apply, but the snapshot
      // is authoritative — record it as the merge ancestor in case it beats the
      // save's own resolution (see `runSaveEffect`).
      if (change.version > version) {
        version = change.version
        serverKnownTabKeys = snapshotSyncKeys(change.tabs)
      }
      return
    }
    if (change.version <= version) return
    if (!get().tabsHydrated) {
      const pending = pendingRemote
      if (!pending || change.version >= pending.version) {
        pendingRemote = change
      }
      return
    }
    applyRemoteSnapshot(change)
  },

  refetchTabs: async () => {
    try {
      const snap = await listOpenedTabs()
      const change: TabsChanged = {
        version: snap.version,
        origin: "server",
        tabs: snap.items,
      }
      if (!get().tabsHydrated) {
        const pending = pendingRemote
        if (!pending || snap.version >= pending.version) {
          pendingRemote = change
        }
        return
      }
      // While the tab set is still UNKNOWN (hydration failed, so local state is
      // device-local drafts only) the snapshot's CONTENTS matter, not just its
      // version: the backend's version key defaults to 0 when absent, so a
      // non-empty set can legitimately arrive as version 0 and lose the `>`
      // comparison. Treating that as "nothing new" would mark the set known
      // while keeping the drafts-only state, and the next invariant pass would
      // prune the real tabs' groups away and persist the wreckage. Applying is
      // safe on an equal version — `applyRemoteSnapshot` reconciles rather than
      // clobbering (its own guard is a strict `<`).
      if (snap.version > version || !tabsSnapshotLoaded) {
        applyRemoteSnapshot(change)
      } else {
        version = Math.max(version, snap.version)
      }
    } catch (err) {
      console.error("[TabStore] refetchTabs failed:", err)
    }
  },

  correctDraftAgents: () => {
    const candidates = get().rawTabs.filter((tab) => {
      if (!isDraftTab(tab)) return false
      if (tab.agentTypeProvisional) return true
      if (!runtime.sortedAvailableAgents.includes(tab.agentType)) return true
      return false
    })
    if (candidates.length === 0) return

    for (const tab of candidates) {
      void (async () => {
        const { agentType: newAgent } = resolveAgentForFolder(
          tab.folderId,
          null
        )
        const current = get().rawTabs.find((t) => t.id === tab.id)
        if (!current || !isDraftTab(current)) return

        if (current.agentType === newAgent) {
          if (!current.agentTypeProvisional) return
          const prev = get().rawTabs
          const next = prev.map((t) =>
            t.id === tab.id && isDraftTab(t) && t.agentTypeProvisional
              ? { ...t, agentTypeProvisional: false }
              : t
          )
          if (next.every((t, i) => t === prev[i])) return
          set({ rawTabs: next })
          recomputeTabs()
          return
        }

        const expectedAgent = current.agentType
        try {
          await runtime.acpDisconnect(tab.id)
        } catch (err) {
          console.error("[TabStore] correct provisional disconnect:", err)
        }

        const prev = get().rawTabs
        const target = prev.find((t) => t.id === tab.id)
        if (!target) return
        if (!isDraftTab(target)) return
        if (
          target.agentType !== expectedAgent &&
          !target.agentTypeProvisional
        ) {
          return
        }
        set({
          rawTabs: prev.map((t) =>
            t.id === tab.id
              ? { ...t, agentType: newAgent, agentTypeProvisional: false }
              : t
          ),
        })
        recomputeTabs()
      })()
    }
  },

  recoverActiveContext: () => {
    const hint = loadLastActiveContext()
    if (hint?.isChat) {
      get().openChatModeTab()
      return
    }
    const folders = useAppWorkspaceStore.getState().folders
    if (hint) {
      const f = folders.find((x) => x.id === hint.folderId)
      if (f) {
        get().openNewConversationTab(f.id, f.path)
        return
      }
    }
    const first = folders[0]
    if (first) {
      get().openNewConversationTab(first.id, first.path)
      return
    }
    get().openChatModeTab()
  },

  consumePreviewReplaced: () => {
    const consumedIds = get().previewReplacedTabIds
    if (consumedIds.length === 0) return
    for (const tabId of consumedIds) {
      for (const cb of previewReplacedCallbacks) {
        cb(tabId)
      }
    }
    const prev = get().previewReplacedTabIds
    const matchesPrefix = consumedIds.every(
      (tabId, index) => prev[index] === tabId
    )
    if (!matchesPrefix) return
    set({ previewReplacedTabIds: prev.slice(consumedIds.length) })
  },

  consumeDraftRetargets: () => {
    const consumedRequests = get().draftRetargetRequests
    if (consumedRequests.length === 0) return

    const prev = get().draftRetargetRequests
    const matchesPrefix = consumedRequests.every(
      (request, index) => prev[index] === request
    )
    if (matchesPrefix) {
      set({
        draftRetargetRequests: prev.slice(consumedRequests.length),
      })
    }

    for (const request of consumedRequests) {
      void (async () => {
        try {
          await runtime.acpDisconnect(request.tabId)
        } catch (err) {
          console.error("[TabStore] disconnect draft tab:", err)
        }

        const rawTabs = get().rawTabs
        const target = rawTabs.find((tab) => tab.id === request.tabId)
        if (!target) return
        if (!isDraftTab(target)) return
        if (
          target.agentType !== request.expectedAgent &&
          !target.agentTypeProvisional
        ) {
          return
        }
        // Tabs follow the folder: a draft the user is still on carries the
        // view into its new folder, instead of vanishing from the scope it
        // leaves.
        const followScope =
          useFolderTabsStore.getState().enabled &&
          get().activeTabId === request.tabId &&
          folderScope(request.folderId) !== folderScope(target.folderId)
        set({
          rawTabs: rawTabs.map((tab) =>
            tab.id === request.tabId
              ? {
                  ...tab,
                  folderId: request.folderId,
                  workingDir: request.workingDir,
                  agentType: request.agentType,
                  agentTypeProvisional: request.provisional,
                  isChat: false,
                }
              : tab
          ),
        })
        recomputeTabs()
        if (followScope) {
          useFolderTabsStore
            .getState()
            .activateScope(folderScope(request.folderId))
          focusTab(request.tabId)
        }
        if (useFolderTabsStore.getState().enabled) {
          closeBlankDraftsBeside(request.tabId)
        }
      })()
    }
  },

  syncActiveFolderId: () => {
    const st = get()
    const folderTabs = useFolderTabsStore.getState()
    const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId) ?? null
    if (folderTabs.enabled && (activeTab == null || !isTabInScope(activeTab))) {
      // An empty scope still owns the folder chrome (file tree, terminal).
      useAppWorkspaceStore
        .getState()
        .setActiveFolderId(
          folderTabs.scope === "global" ? null : folderTabs.scope
        )
      return
    }
    // Otherwise the active tab decides, exactly as in normal mode: a chat
    // conversation in the global scope keeps its hidden chat folder, which is
    // how chat mode is recognised (`useIsActiveChatMode`).
    useAppWorkspaceStore
      .getState()
      .setActiveFolderId(activeTab?.folderId ?? null)
  },

  persistLastActiveContext: () => {
    const st = get()
    if (!st.tabsHydrated) return
    const active = st.rawTabs.find((t) => t.id === st.activeTabId)
    if (!active) return
    if (isDraftTab(active)) {
      saveLastActiveContext({
        folderId: active.folderId,
        isChat: active.isChat === true,
      })
    } else {
      clearLastActiveContext()
    }
  },

  setLabels: (labels) => {
    runtime.labels = labels
    recomputeTabs()
  },

  setSideEffects: (deps) => {
    runtime.activateConversationPane = deps.activateConversationPane
    runtime.acpDisconnect = deps.acpDisconnect
  },

  setAgentAvailability: (sortedTypes, fresh) => {
    runtime.sortedAvailableAgents = sortedTypes
    runtime.agentsFresh = fresh
  },
}))

/**
 * Correction / recovery are one-shot per session (module flags). `TabProvider`
 * calls these gate wrappers when their conditions flip, replacing the former
 * `correctionRanRef` / `recoveryRanRef`.
 */
export function runCorrectionOnce() {
  if (correctionRan) return
  correctionRan = true
  useTabStore.getState().correctDraftAgents()
}

export function runRecoveryOnce() {
  if (recoveryRan || useFolderTabsStore.getState().enabled) return
  recoveryRan = true
  useTabStore.getState().recoverActiveContext()
}

/**
 * Drop restored drafts whose folder no longer exists (deleted while the app was
 * closed, so no `closeTabsByFolder` ever ran). Folder-blind at hydrate time by
 * design — hydration must not wait on the folder list — so this runs once the
 * folders land, and `applyGroupInvariants` collapses any group it empties.
 * Chat drafts are folderless (`folderId` 0) and always survive.
 */
export function pruneOrphanDraftsOnce() {
  if (orphanDraftPruneRan) return
  orphanDraftPruneRan = true
  const st = useTabStore.getState()
  const { allFolders } = useAppWorkspaceStore.getState()
  const orphaned = st.rawTabs.filter(
    (tab) =>
      (isDraftTab(tab) || isSubagentTab(tab)) &&
      tab.isChat !== true &&
      !allFolders.some((folder) => folder.id === tab.folderId)
  )
  if (orphaned.length === 0) return
  const orphanIds = new Set(orphaned.map((tab) => tab.id))
  const next = st.rawTabs.filter((tab) => !orphanIds.has(tab.id))
  useTabStore.setState({
    rawTabs: next,
    activeTabId:
      st.activeTabId != null && orphanIds.has(st.activeTabId)
        ? (next[0]?.id ?? null)
        : st.activeTabId,
  })
  for (const tab of orphaned) {
    clearMessageInputDraftV2(buildNewConversationDraftStorageKey(tab.id))
  }
  recomputeTabs()
}

// Every change of the tab in front, for the composer focus: one this client
// made hands the new tab's composer the keyboard, one mirrored from another
// client's snapshot does not (see `noteTabActivation`).
useTabStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId) {
    noteTabActivation(applyingRemoteFocus)
  }
})

// Recompute `tabs` whenever the app-workspace `conversations` list changes (any
// agent's turn start/stop): titles/status decorate from it. Reference reuse in
// recomputeTabs keeps the array stable when no open tab is affected.
useAppWorkspaceStore.subscribe((next, previous) => {
  const c = next.conversations
  if (c !== lastConversations) {
    lastConversations = c
    recomputeTabs()
  } else if (previous.conversationsLoading && !next.conversationsLoading) {
    // A refetch just settled. Its rows landed while it still read as loading,
    // when `alignConversationTabFolders` holds off; run it now.
    recomputeTabs()
  }
})

/** All tab actions as a shallow-stable object. Actions never change identity, so
 *  this hook never triggers a re-render — consumers that only dispatch use it
 *  instead of subscribing to any state slice. */
export function useTabActions() {
  return useTabStore(
    useShallow((s) => ({
      openTab: s.openTab,
      replaceTabWithConversation: s.replaceTabWithConversation,
      closeTab: s.closeTab,
      closeConversationTab: s.closeConversationTab,
      closeOtherTabs: s.closeOtherTabs,
      closeTabsToRight: s.closeTabsToRight,
      closeAllTabs: s.closeAllTabs,
      closeTabsByFolder: s.closeTabsByFolder,
      switchTab: s.switchTab,
      pinTab: s.pinTab,
      setTabAnchored: s.setTabAnchored,
      toggleGroupTile: s.toggleGroupTile,
      splitTab: s.splitTab,
      moveTabToGroup: s.moveTabToGroup,
      toggleGroupOrientation: s.toggleGroupOrientation,
      dissolveGroup: s.dissolveGroup,
      unsplitAll: s.unsplitAll,
      reorderGroupTabs: s.reorderGroupTabs,
      resizeGroupSplit: s.resizeGroupSplit,
      updateTabDrag: s.updateTabDrag,
      endTabDrag: s.endTabDrag,
      openNewConversationTab: s.openNewConversationTab,
      openChatModeTab: s.openChatModeTab,
      setChatDraftWorkingDir: s.setChatDraftWorkingDir,
      confirmDraftAgent: s.confirmDraftAgent,
      setDraftAgentFromFallback: s.setDraftAgentFromFallback,
      bindConversationTab: s.bindConversationTab,
      setTabRuntimeConversationId: s.setTabRuntimeConversationId,
      reorderTabs: s.reorderTabs,
      openSubagentTab: s.openSubagentTab,
      updateSubagentTab: s.updateSubagentTab,
      consumeRemoteActivation: s.consumeRemoteActivation,
      onPreviewTabReplaced: s.onPreviewTabReplaced,
    }))
  )
}

/**
 * Restore pristine state (store + module coordination vars + injected runtime).
 * Used by tests, and by the backend-scoped reset registry if a realm's backend
 * identity ever changes (an invariant-violating transition that does not occur
 * today — see `RemoteConnectionGate`). In normal operation the store lives for
 * the window's lifetime and is never reset.
 */
export function resetTabStore() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (groupPersistTimer) {
    clearTimeout(groupPersistTimer)
    groupPersistTimer = null
  }
  version = 0
  applyingRemote = false
  remoteActivationPending = false
  applyingRemoteFocus = false
  pendingRemote = null
  lastSavedPayload = null
  serverKnownTabKeys = new Set()
  lastGroupBlob = null
  childSummaryInFlight.clear()
  childSeedBuffer.clear()
  seedEpoch = 0
  previewReplacedCallbacks.clear()
  correctionRan = false
  recoveryRan = false
  orphanDraftPruneRan = false
  tabsSnapshotLoaded = false
  runtime = defaultRuntime()
  lastConversations = useAppWorkspaceStore.getState().conversations
  // Merge (not replace) so the action methods are preserved; only the data
  // fields reset to their initial values.
  useTabStore.setState(initialTabState())
}

// Reset this backend-scoped store on any (currently-unreachable) in-realm
// backend switch. See `backend-scoped-store-reset.ts`.
registerBackendScopedStoreReset(resetTabStore)

/**
 * Standalone `applyRemoteSnapshot` (not a store method: it is only called
 * internally by handleTabsChanged / refetchTabs / hydrate, and closing over the
 * module coordination vars keeps the semantics identical to the former
 * `applyRemoteSnapshot` callback).
 */
function applyRemoteSnapshot(change: TabsChanged) {
  // Stale-safe: a snapshot older than what we've applied must not move the UI or
  // version backwards. Equal versions still reconcile.
  if (change.version < version) return
  version = change.version
  // An authoritative tab set just landed: if hydration had failed, this is what
  // un-parks the invariant prune and the blob write (see `tabsSnapshotLoaded`).
  tabsSnapshotLoaded = true
  // A newer remote truth supersedes any debounced local save still waiting.
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const snapshotItems = change.tabs.filter((it) => it.conversation_id != null)

  const prev = useTabStore.getState()
  // ── Three-way merge against `serverKnownTabKeys` (the common ancestor) ──────
  // A snapshot is the SERVER's set, not a newer truth about ours: the two can
  // have diverged in both directions since the last sync. Classify per tab
  // instead of adopting wholesale.
  const ancestorKeys = serverKnownTabKeys
  const snapshotKeys = snapshotSyncKeys(snapshotItems)
  serverKnownTabKeys = snapshotKeys
  const localKeys = new Set<string>()
  for (const tb of prev.rawTabs) {
    const key = tabSyncKey(tb)
    if (key) localKeys.add(key)
  }
  // Present on the server but gone here AND the server already had it at our
  // last sync → we closed it locally and our save hasn't landed (or was just
  // rejected). The local close is the newer intent: keep it closed. Anything
  // else on the server is adopted — including tabs opened on another client.
  const convItems = snapshotItems.filter((it) => {
    const key = conversationSyncKey(it.agent_type, it.conversation_id as number)
    return localKeys.has(key) || !ancestorKeys.has(key)
  })
  // Open here, absent from the snapshot, and never acknowledged by the server →
  // a local addition the snapshot simply predates (a draft that just bound to a
  // freshly-created conversation is the important one). Keep it and push it;
  // dropping it would strand a live, streaming conversation with no tab. A tab
  // the server DID know and no longer lists was closed elsewhere — that one
  // still goes away, which is the whole point of the ancestor set.
  const unsyncedLocal = prev.rawTabs.filter((tb) => {
    const key = tabSyncKey(tb)
    if (!key) return false
    return !snapshotKeys.has(key) && !ancestorKeys.has(key)
  })
  // Our set is ahead of the server's in at least one direction, so this apply
  // must NOT arm the echo guard or seed the no-op baseline — the save effect has
  // to push the merged set (against the version we just learned) or the
  // divergence never converges.
  const diverged =
    unsyncedLocal.length > 0 || convItems.length !== snapshotItems.length

  const remoteActive = convItems.find((it) => it.is_active)
  applyingRemote = !diverged

  const prevById = new Map(prev.rawTabs.map((tb) => [tb.id, tb]))
  const claimedIds = new Set<string>()
  const remoteTabs: TabItemInternal[] = convItems.map((it) => {
    const canonicalId = makeConversationTabId(
      it.folder_id,
      it.agent_type,
      it.conversation_id as number
    )
    // Prefer an already-open local tab for this conversation (including a draft
    // that just bound to it and still carries its `new-*` id) so we keep that
    // stable id and its live runtime session — in whichever folder it is open
    // here: the conversation may have been moved to another project, and the
    // snapshot's folder is then the newer one.
    const found =
      prevById.get(canonicalId) ??
      prev.rawTabs.find(
        (tb) =>
          tb.conversationId === it.conversation_id &&
          tb.agentType === it.agent_type
      )
    const existing = found && !claimedIds.has(found.id) ? found : undefined
    if (existing) claimedIds.add(existing.id)
    const sameFolder = existing?.folderId === it.folder_id
    return {
      id: existing?.id ?? canonicalId,
      kind: "conversation",
      folderId: it.folder_id,
      conversationId: it.conversation_id,
      agentType: it.agent_type,
      title: existing?.title ?? runtime.labels.loadingConversation,
      isPinned: it.is_pinned,
      ...anchoredFromItem(it),
      runtimeConversationId: existing?.runtimeConversationId,
      status: existing?.status,
      // Device-local per-tab fields the payload doesn't carry. Rebuilding the
      // tab from the snapshot must not blank them (a bound chat tab would lose
      // the scratch working dir it is connected in) — unless the folder
      // changed, when the working dir is re-derived from the new one.
      workingDir: sameFolder ? existing?.workingDir : undefined,
      isChat: existing?.isChat,
    }
  })

  const folders = useAppWorkspaceStore.getState().folders
  // Keep every device-local draft (one per split group) that's a folderless
  // chat draft or whose real folder still exists. Never yank the user off an
  // in-progress draft.
  const nextTabs = [...remoteTabs, ...unsyncedLocal]
  for (const localDraft of prev.rawTabs) {
    if (!isDraftTab(localDraft)) continue
    if (
      localDraft.isChat === true ||
      folders.some((f) => f.id === localDraft.folderId)
    ) {
      nextTabs.push(localDraft)
    }
  }
  // Sub-agent tabs are device-local too, and each goes back right after the
  // tab it followed (most often its parent), not to the end of the strip.
  prev.rawTabs.forEach((local, i) => {
    if (!isSubagentTab(local)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = nextTabs.findIndex((tb) => tb.id === prev.rawTabs[j].id)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    nextTabs.splice(at, 0, local)
  })

  // Never leave the workspace blank: synthesize a draft when empty.
  if (nextTabs.length === 0) {
    if (folders.length === 0 || useFolderTabsStore.getState().enabled) {
      lastSavedPayload = diverged ? null : JSON.stringify([])
      setRemoteTabState({ rawTabs: [], activeTabId: null })
      recomputeTabs()
      return
    }
    const replacement = makeReplacementDraftTab()
    lastSavedPayload = diverged
      ? null
      : JSON.stringify(buildPersistItems([replacement], replacement.id))
    setRemoteTabState({
      rawTabs: [replacement],
      activeTabId: replacement.id,
    })
    recomputeTabs()
    return
  }

  const remoteActiveId = remoteActive
    ? (nextTabs.find(
        (tb) =>
          tb.conversationId === remoteActive.conversation_id &&
          tb.folderId === remoteActive.folder_id &&
          tb.agentType === remoteActive.agent_type
      )?.id ?? null)
    : null

  // Focus resolution (focus is mirrored across clients):
  //   1. Never yank the user off local intent the snapshot predates — an
  //      in-progress draft, or a conversation tab the server has never seen
  //      (the just-sent conversation this client is watching stream).
  //   2. Otherwise mirror the remote's focused tab when present here.
  //   3. Else keep our focus if it survived, re-picking a neighbor only if it left.
  const activeTab = prev.activeTabId
    ? nextTabs.find((tb) => tb.id === prev.activeTabId)
    : undefined
  const activeStillExists = activeTab != null
  const activeKey = activeTab ? tabSyncKey(activeTab) : null
  const activeIsLocalOnly =
    activeStillExists &&
    (activeKey == null ||
      (!snapshotKeys.has(activeKey) && !ancestorKeys.has(activeKey)))

  let nextActiveId: string | null
  if (activeIsLocalOnly) {
    nextActiveId = prev.activeTabId
  } else if (remoteActiveId) {
    nextActiveId = remoteActiveId
  } else if (activeStillExists) {
    nextActiveId = prev.activeTabId
  } else {
    nextActiveId = nextTabs[0].id
  }

  if (useFolderTabsStore.getState().enabled) {
    // Remote clients synchronize open membership, but cannot move this client's
    // explicit folder scope or steal its current local selection.
    const visible = nextTabs.filter(isTabInScope)
    nextActiveId = visible.some((tab) => tab.id === prev.activeTabId)
      ? prev.activeTabId
      : (visible[0]?.id ?? null)
  }

  // A focus change driven by the remote snapshot must not trip the route-sync
  // chokepoint into the conversations route.
  if (nextActiveId !== prev.activeTabId) {
    remoteActivationPending = true
  }
  // Seed the last-saved payload from the state we're about to commit so the
  // guarded save-effect run is a confirmed no-op AND a passive focus fallback
  // never propagates to yank another client. When the merge diverged from the
  // server there is nothing to seed — clearing the baseline is what lets the
  // save effect push the difference back.
  lastSavedPayload = diverged
    ? null
    : JSON.stringify(buildPersistItems(nextTabs, nextActiveId))
  setRemoteTabState({ rawTabs: nextTabs, activeTabId: nextActiveId })
  recomputeTabs()
}

// A scope change swaps the view on screen: the leaving view's group state is
// parked, the arriving one's loaded, and the selection repaired. Membership and
// server persistence always keep the complete tab set, including live
// background sessions.
useFolderTabsStore.subscribe((next, previous) => {
  if (next.scope === previous.scope && next.enabled === previous.enabled) return
  const st = useTabStore.getState()
  const leavingKey = groupViewKey(previous)
  const arrivingKey = groupViewKey(next)
  // Only a folder SWITCH offers the folder's last tab back. Turning the mode on
  // starts from the tab (and per-group picks) the user is looking at.
  let remembered: string | null = null
  if (leavingKey !== arrivingKey) {
    const leaving = groupViewOnScreen(st)
    let views: Record<string, GroupView>
    let arriving: GroupView
    if (next.enabled) {
      views = { ...st.groupViews, [leavingKey]: leaving }
      arriving =
        views[arrivingKey] ??
        projectGroupView(
          views[ALL_GROUP_VIEW] ?? leaving,
          st.rawTabs.filter(isTabInScope),
          st.tabsHydrated && tabsSnapshotLoaded
        )
      delete views[arrivingKey]
      if (previous.enabled) remembered = arriving.active
    } else {
      // One layout for every tab again: the normal-mode one as it was left.
      // Folder views go with the mode; next time each starts from that one.
      arriving = st.groupViews[ALL_GROUP_VIEW] ?? leaving
      views = {}
    }
    useTabStore.setState({
      groupLayout: arriving.layout,
      groupOf: arriving.groupOf,
      groupSelection: arriving.selection,
      tileByGroup: arriving.tileByGroup,
      groupViews: views,
      tabDrag: null,
    })
  }
  const after = useTabStore.getState()
  if (next.enabled) {
    const visible = after.rawTabs.filter(isTabInScope)
    const active = remembered ?? after.activeTabId
    useTabStore.setState({
      activeTabId: visible.some((t) => t.id === active)
        ? active
        : (visible[0]?.id ?? null),
    })
  } else if (!after.rawTabs.some((tab) => tab.id === after.activeTabId)) {
    useTabStore.setState({ activeTabId: after.rawTabs[0]?.id ?? null })
  }
  applyGroupInvariants()
  if (previous.enabled && !next.enabled) closeBlankDraftsPerGroup()
  useTabStore.getState().syncActiveFolderId()
})

/** The stored mode came back off at hydration: folder views parked from the
 *  last session's blob are stale by now, so they go (turning the mode on later
 *  starts every folder from the normal-mode layout). */
export function dropParkedFolderGroupViews() {
  const st = useTabStore.getState()
  if (useFolderTabsStore.getState().enabled) return
  if (Object.keys(st.groupViews).length === 0) return
  useTabStore.setState({ groupViews: {} })
  persistGroupState()
}

// A scope whose folder left the workspace (its worktree was deleted, or the
// folder was removed from the sidebar) would keep the folder chrome — file
// tree, terminal, search — pointed at it. `closeTabsByFolder` cannot catch
// this: it returns early for a folder with no tabs. Move to the parent repo
// when it is still open, else to a remaining tab's scope, else the first
// open folder.
useAppWorkspaceStore.subscribe((next, previous) => {
  if (
    next.folders === previous.folders &&
    next.foldersHydrated === previous.foldersHydrated
  ) {
    return
  }
  const folderTabs = useFolderTabsStore.getState()
  const scope = folderTabs.scope
  if (!folderTabs.enabled || scope === "global" || !next.foldersHydrated) return
  const isOpen = (id: number | null | undefined) =>
    id != null && next.folders.some((f) => f.id === id)
  if (isOpen(scope)) return
  const parentId = (
    previous.allFolders.find((f) => f.id === scope) ??
    next.allFolders.find((f) => f.id === scope)
  )?.parent_id
  const fromTabs = useTabStore
    .getState()
    .rawTabs.map((tab) => folderScope(tab.folderId))
    .find((s) => s !== scope && (s === "global" || isOpen(s)))
  const target: TabScope =
    parentId != null && isOpen(parentId)
      ? parentId
      : (fromTabs ?? next.folders[0]?.id ?? "global")
  folderTabs.activateScope(target)
})
