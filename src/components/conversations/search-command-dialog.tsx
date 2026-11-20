"use client"

import {
  memo,
  startTransition,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useDeferredValue,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import { formatDistance } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { prefetchConversationDetail } from "@/stores/conversation-runtime-store"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import {
  listAllConversations,
  searchMessages,
  type MessageSearchHit,
} from "@/lib/api"
import { setPendingFind } from "@/lib/pending-find"
import { recentSessions } from "@/lib/recent-sessions"
import { archivedFolderIds } from "@/components/conversations/sidebar-conversation-grouping"
import { useShowRecentOnSearch } from "@/lib/search-recent-prefs"
import {
  cancelConversationPreconnect,
  preconnectConversation,
} from "@/lib/session-preconnect"
import {
  cancelQuickSwitchTypeahead,
  setQuickSwitchTypeaheadOwner,
  takeQuickSwitchTypeahead,
} from "@/lib/quick-switch-typeahead"
import {
  markQuickSwitchPick,
  markQuickSwitchShown,
} from "@/lib/quick-switch-perf"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
import { splitSnippet } from "@/lib/message-search-snippet"
import { detectTextDirection } from "@/lib/text-direction"
import { compareAgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { InstantCommandDialog } from "@/components/ui/instant-command-dialog"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"
import { isWebLinkDown } from "@/lib/transport/web-connection-store"

/** Why a search came back with nothing to show, when it is not "no match". */
type SearchFailure = "offline" | "failed"

/**
 * A failed search must not read as "no results". Offline when the link is
 * known down or the request never got an answer; otherwise the server
 * answered with an error.
 */
function searchFailure(err: unknown): SearchFailure {
  if (isWebLinkDown()) return "offline"
  if (err instanceof TypeError) return "offline"
  const message =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : ""
  return /timed out|Remote HTTP request failed/.test(message)
    ? "offline"
    : "failed"
}

type SearchTab = "all" | "conversations" | "messages" | "files"

/** The tabs in order, which is also the order Tab steps through them. */
const SEARCH_TABS: readonly SearchTab[] = [
  "all",
  "conversations",
  "messages",
  "files",
]

const SEARCH_TAB_LABEL_KEYS = {
  all: "tabAll",
  conversations: "tabConversations",
  messages: "tabMessages",
  files: "tabFiles",
} as const

/** The tab `step` places from `tab`, wrapping round both ends. */
export function stepSearchTab(tab: SearchTab, step: 1 | -1): SearchTab {
  const at = SEARCH_TABS.indexOf(tab)
  return SEARCH_TABS[(at + step + SEARCH_TABS.length) % SEARCH_TABS.length]
}

/** Most message hits one search shows. */
const MESSAGE_SEARCH_LIMIT = 40

/**
 * The All tab's share of the message search: a few hits under the sessions,
 * and a row that opens the Messages tab when there are more. It asks for one
 * more than it shows to know whether there are, waits a little longer than
 * the Messages tab and skips one-letter queries, so typing a session's title
 * does not run a full-text search per keystroke.
 */
const ALL_TAB_MESSAGE_LIMIT = 5
const ALL_TAB_MESSAGE_MIN_CHARS = 2
const ALL_TAB_MESSAGE_DEBOUNCE_MS = 400
const MESSAGES_TAB_DEBOUNCE_MS = 250

/** Most sessions the recent list shows with nothing typed. */
const RECENT_SESSION_LIMIT = 30

/** How long the selection rests on a row before its transcript is fetched. */
const PREFETCH_DWELL_MS = 300

const MESSAGE_ROLE_KEYS = {
  user: "roleUser",
  assistant: "roleAssistant",
  system: "roleSystem",
} as const

// Shared empties, so resetting an already-empty list changes nothing.
const NO_CONVERSATIONS: DbConversationSummary[] = []
const NO_MESSAGE_HITS: MessageSearchHit[] = []

/**
 * Another layer holds focus captive (a modal dialog, an open menu or
 * popover): Radix and Base UI mark one with focus guards while it is up.
 */
function focusHeldElsewhere(): boolean {
  if (typeof document === "undefined") return false
  return (
    document.querySelector(
      "[data-radix-focus-guard], [data-base-ui-focus-guard]"
    ) !== null
  )
}

/** After the frame that follows has been painted. */
function afterNextPaint(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0)
  })
  return () => {
    cancelAnimationFrame(frame)
    if (timer != null) clearTimeout(timer)
  }
}

const recentValue = (conv: DbConversationSummary) => `recent-${conv.id}`
const resultValue = (conv: DbConversationSummary) =>
  `${conv.id}-${formatConversationTitle(conv.title)}`
// Prefixed: on the All tab a hit shares the list with session rows, whose
// values are `<id>-<title>` and could otherwise spell the same string.
const messageHitValue = (hit: MessageSearchHit) =>
  `message-${hit.conversation_id}-${hit.turn_idx}`
const SHOW_ALL_MESSAGES_VALUE = "show-all-messages"

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ConversationRowProps {
  value: string
  conversation: DbConversationSummary
  onPick: (conversation: DbConversationSummary) => void
  title: string
  status: string | undefined
  /** Shown when the list spans folders; null hides it. */
  folderName: string | null
  agentType: AgentType
  /** Relative time already formatted, or null when unknown. */
  time: string | null
  /** A short label after the title (an archived folder's "Archived"). */
  badge?: string
}

/**
 * One conversation in the Conversations tab — a result or a recent one.
 * Memoized: the list stays rendered while the dialog is hidden, and a row
 * only re-renders when something it shows changed.
 */
const ConversationRow = memo(function ConversationRow({
  value,
  conversation,
  onPick,
  title,
  status,
  folderName,
  agentType,
  time,
  badge,
}: ConversationRowProps) {
  return (
    <CommandItem value={value} onSelect={() => onPick(conversation)}>
      <ConversationStatusDot status={status as ConversationStatus} />
      <span className="flex-1 truncate">{title}</span>
      {badge && (
        <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
          {badge}
        </span>
      )}
      {folderName && (
        <span className="flex max-w-40 items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Folder className="w-3 h-3 shrink-0" />
          <span className="truncate">{folderName}</span>
        </span>
      )}
      <span className="text-xs text-muted-foreground shrink-0">
        {getAgentLabel(agentType)}
      </span>
      {time && (
        <span className="text-xs text-muted-foreground shrink-0">{time}</span>
      )}
    </CommandItem>
  )
})

/**
 * Whether this opening of the dialog uses the modal fallback, which stacks
 * with a layer that holds focus. Decided as each open starts, during render,
 * so the open's first frame already has it, without a second render pass on
 * the hot path.
 */
/* eslint-disable react-hooks/refs -- decided once per open during render; a state round-trip would cost the open a second render */
function useLegacyShellForThisOpen(open: boolean): boolean {
  const shellRef = useRef({ open, legacy: false })
  if (shellRef.current.open !== open) {
    shellRef.current = { open, legacy: open && focusHeldElsewhere() }
  }
  return shellRef.current.legacy
}
/* eslint-enable react-hooks/refs */

/**
 * The search dialog (⌘K), which with nothing typed is also the session
 * switcher: ⌘K then Enter goes back to the previous session, like Alt-Tab.
 *
 * It stays mounted and rendered between uses (`InstantCommandDialog`): the
 * recent list is kept current in the background — the session in front left
 * out, the next one first and selected — so opening only reveals it and puts
 * the caret in the search box, within the frame of the key press. Whatever is
 * typed after the shortcut, even before that, is the dialog's (see
 * `quick-switch-typeahead`). Each close resets the search once the frame that
 * hid it has been painted, so the next open starts fresh at no cost of its
 * own. While a session not open in a tab is selected, its transcript is
 * fetched and its agent pre-connected, so picking it does not wait on either.
 */
export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  // Conversations are searched across every folder by default — a title is
  // often all that is remembered, not where it ran. "This folder only" narrows
  // it; files stay folder-scoped (they live in the folder).
  const [thisFolderOnly, setThisFolderOnly] = useState(false)
  const scopedFolderId =
    thisFolderOnly && activeFolderId != null ? activeFolderId : null
  const conversations = useMemo(
    () =>
      scopedFolderId == null
        ? allConversations
        : allConversations.filter((c) => c.folder_id === scopedFolderId),
    [allConversations, scopedFolderId]
  )
  const folderNames = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f.name])),
    [allFolders]
  )
  const knownFolderIds = useMemo(
    () => new Set(folderNames.keys()),
    [folderNames]
  )
  // Archived folders (on their own, through their group, or through the repo
  // a worktree folder belongs to). With nothing typed, their sessions stay out
  // of the recent list, like the sidebar's Recent; a search still finds them,
  // marked "Archived".
  const folderGroups = useAppWorkspaceStore((s) => s.folderGroups)
  const archivedIds = useMemo(() => {
    const known = new Set(allFolders.map((f) => f.id))
    const repoOf = new Map<number, number>()
    for (const f of allFolders) {
      if (f.parent_id != null && known.has(f.parent_id)) {
        repoOf.set(f.id, f.parent_id)
      }
    }
    return archivedFolderIds({
      folders: allFolders,
      groups: folderGroups,
      childToParent: repoOf,
    })
  }, [allFolders, folderGroups])
  // With nothing typed, the Conversations tab is a session switcher, like
  // Alt-Tab: the conversation in front is left out and the most recently
  // active other one comes first, selected, so Enter goes straight back to it.
  const [showRecent] = useShowRecentOnSearch()
  const activeConversationId = useTabStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.conversationId ?? null
  )
  // Which sessions have a tab, as one string so a tab switch (a new `tabs`
  // array, the same sessions) does not re-render the dialog.
  const openConversationKey = useTabStore((s) =>
    s.tabs
      .map((tab) => tab.conversationId)
      .filter((id) => id != null)
      .join(",")
  )
  const openConversationIds = useMemo(
    () =>
      new Set(
        openConversationKey ? openConversationKey.split(",").map(Number) : []
      ),
    [openConversationKey]
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("all")
  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs or agent filters leaves it there, so typing always
  // searches. The query stays: the next tab searches the same words.
  const inputRef = useRef<HTMLInputElement>(null)
  // The row the user moved the selection to; until then, the first one.
  const [pickedValue, setPickedValue] = useState<string | null>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    // The selection belonged to the other tab's list.
    setPickedValue(null)
    inputRef.current?.focus()
  }, [])
  // Tab and Shift+Tab in the search box go to the next or previous search
  // instead of moving focus, which would only reach the tab buttons.
  const onSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey) return
      if (event.metaKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      // The dialog's focus trap must not move focus on its own either.
      event.stopPropagation()
      setActiveTab((tab) => stepSearchTab(tab, event.shiftKey ? -1 : 1))
      setPickedValue(null)
    },
    []
  )
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] =
    useState<DbConversationSummary[]>(NO_CONVERSATIONS)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState<SearchFailure | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [messageHits, setMessageHits] =
    useState<MessageSearchHit[]>(NO_MESSAGE_HITS)
  const [messageSearching, setMessageSearching] = useState(false)
  const [messageSearchFailed, setMessageSearchFailed] =
    useState<SearchFailure | null>(null)
  // Relative times are reckoned from here; brought up to date on each open.
  const [now, setNow] = useState(() => Date.now())

  // A layer that holds focus (a modal, an open menu) cannot have this dialog
  // stealing focus from under it: opened over one, it uses the modal dialog
  // as before, which stacks with it (`useLegacyShellForThisOpen`).
  const legacyShell = useLegacyShellForThisOpen(open)

  const folderPath = folder?.path ?? ""

  // The Conversations tab narrows by folder and agent; All searches every
  // session, the way it searches every message.
  const conversationTab = activeTab === "conversations" || activeTab === "all"
  const tabFolderId = activeTab === "conversations" ? scopedFolderId : null
  const tabAgentFilter = activeTab === "conversations" ? agentFilter : null
  const recentMode = conversationTab && showRecent && !query.trim()

  // The workspace store holds every sidebar row; only when it has none yet
  // (not loaded) does the recent list ask the backend itself.
  const storeEmpty = allConversations.length === 0
  const [fetchedConversations, setFetchedConversations] =
    useState<DbConversationSummary[]>(NO_CONVERSATIONS)
  useEffect(() => {
    if (!open || !showRecent || !storeEmpty) return
    let stale = false
    void (async () => {
      try {
        const list = await listAllConversations()
        if (!stale && Array.isArray(list)) setFetchedConversations(list)
      } catch {
        /* the list stays empty; typing still searches */
      }
    })()
    return () => {
      stale = true
    }
  }, [open, showRecent, storeEmpty])
  const recentSource = storeEmpty ? fetchedConversations : allConversations

  // The conversation in the active tab. It is never offered: picking it would
  // only close the dialog, so it stays out of the recent list and the results.
  // Tracked while the dialog is hidden too, so it opens already right — but
  // deferred then: a switch must not wait on redrawing a list nobody sees.
  // An open reads it directly, so even a hidden update still pending is
  // never shown stale.
  const deferredActiveConversationId = useDeferredValue(activeConversationId)
  const currentConversationId = open
    ? activeConversationId
    : deferredActiveConversationId

  const recent = useMemo(
    () =>
      recentMode
        ? recentSessions(recentSource, {
            knownFolderIds,
            excludeId: currentConversationId,
            folderId: tabFolderId,
            agentType: tabAgentFilter,
            excludeFolderIds: archivedIds,
            limit: RECENT_SESSION_LIMIT,
          })
        : NO_CONVERSATIONS,
    [
      recentMode,
      recentSource,
      knownFolderIds,
      currentConversationId,
      tabFolderId,
      tabAgentFilter,
      archivedIds,
    ]
  )

  const shownResults = useMemo(
    () =>
      currentConversationId == null
        ? results
        : results.filter((c) => c.id !== currentConversationId),
    [results, currentConversationId]
  )

  // The selection: the row the user moved to, else the first recent row.
  // Held here rather than left to cmdk so the hidden list is always opened
  // with its first row selected, without cmdk having to settle it on open.
  const firstRecentValue =
    recentMode && recent.length > 0 ? recentValue(recent[0]) : ""
  const selectedValue = pickedValue ?? firstRecentValue

  const relativeTime = useCallback(
    (iso: string) =>
      formatDistance(new Date(iso), now, {
        addSuffix: true,
        locale: dateFnsLocale,
      }),
    [dateFnsLocale, now]
  )
  const folderLabel = (folderId: number) =>
    scopedFolderId == null ? (folderNames.get(folderId) ?? null) : null

  // File search via shared hook (lazy-loaded when files tab is active)
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: open && activeTab === "files",
    query,
  })

  // Compute which agent types exist in current folder
  const availableAgents = useMemo(
    () =>
      Array.from(new Set(conversations.map((c) => c.agent_type))).sort(
        compareAgentType
      ),
    [conversations]
  )

  // The backend ranks the whole workspace before capping the response, so a
  // deeply nested match remains reachable without retaining the full index.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null, folderId: number | null) => {
      // With nothing typed, the recent list (narrowed by the agent filter)
      // stands in for results — unless it is turned off.
      if (!q.trim() && (!agent || showRecent)) {
        setResults(NO_CONVERSATIONS)
        setSearchFailed(null)
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: folderId != null ? [folderId] : null,
          search: q.trim() || null,
          agent_type: agent,
        })
        setResults(data)
        setSearchFailed(null)
      } catch (err) {
        setResults(NO_CONVERSATIONS)
        setSearchFailed(searchFailure(err))
      } finally {
        setSearching(false)
      }
    },
    [showRecent]
  )

  // Debounced search on query change (the All and Conversations tabs)
  useEffect(() => {
    if (!conversationTab) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, tabAgentFilter, tabFolderId)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, tabAgentFilter, tabFolderId, doSearch, conversationTab])

  // Debounced message-content search (the Messages tab, and a few hits on
  // All). It spans every conversation rather than the active folder's: the
  // words of a message are often all that is remembered of a conversation,
  // including where it ran.
  useEffect(() => {
    if (activeTab !== "messages" && activeTab !== "all") return
    const onAll = activeTab === "all"
    const q = query.trim()
    const tooShort = onAll && q.length < ALL_TAB_MESSAGE_MIN_CHARS
    let stale = false
    const timer = setTimeout(
      () => {
        if (!q || tooShort) {
          setMessageHits(NO_MESSAGE_HITS)
          setMessageSearchFailed(null)
          setMessageSearching(false)
          return
        }
        setMessageSearching(true)
        searchMessages(
          q,
          onAll ? ALL_TAB_MESSAGE_LIMIT + 1 : MESSAGE_SEARCH_LIMIT
        )
          .then((hits) => {
            if (stale) return
            setMessageHits(hits)
            setMessageSearchFailed(null)
          })
          .catch((err: unknown) => {
            if (stale) return
            setMessageHits(NO_MESSAGE_HITS)
            setMessageSearchFailed(searchFailure(err))
          })
          .finally(() => {
            if (!stale) setMessageSearching(false)
          })
      },
      onAll ? ALL_TAB_MESSAGE_DEBOUNCE_MS : MESSAGES_TAB_DEBOUNCE_MS
    )
    return () => {
      // The query moved on: an answer still in flight must not replace the
      // results of the newer one.
      stale = true
      clearTimeout(timer)
    }
  }, [query, activeTab])

  const listRef = useRef<HTMLDivElement>(null)
  const resetSearchState = useCallback(() => {
    setQuery("")
    setAgentFilter(null)
    setThisFolderOnly(false)
    setResults(NO_CONVERSATIONS)
    setMessageHits(NO_MESSAGE_HITS)
    setSearchFailed(null)
    setMessageSearchFailed(null)
    setMessageSearching(false)
    setActiveTab("all")
    setPickedValue(null)
    // Each opening searches files as they are now, not a native snapshot left
    // over from before it opened.
    resetFileTree(true)
  }, [resetFileTree])

  // Each close resets the search, but only after the frame that hid the
  // dialog: a pick switches sessions in that frame, and redrawing the hidden
  // list must not hold it up. Opened again before then, the reset runs right
  // away, inside the open, so nothing stale is ever shown.
  const resetPendingRef = useRef(false)
  const cancelResetRef = useRef<(() => void) | null>(null)
  const wasOpenRef = useRef(open)
  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = open
    if (open && !wasOpen) {
      if (resetPendingRef.current) {
        cancelResetRef.current?.()
        cancelResetRef.current = null
        resetPendingRef.current = false
        resetSearchState()
      }
      // The modal fallback focuses its own search box as it mounts; nothing
      // was held back for it.
      if (legacyShell) cancelQuickSwitchTypeahead()
      // Times shown as they stood at the last open; the fresh ones follow a
      // frame later rather than delay this one.
      startTransition(() => setNow(Date.now()))
    } else if (!open && wasOpen) {
      cancelQuickSwitchTypeahead()
      resetPendingRef.current = true
      cancelResetRef.current = afterNextPaint(() => {
        cancelResetRef.current = null
        if (!resetPendingRef.current) return
        resetPendingRef.current = false
        resetSearchState()
      })
    }
  }, [open, legacyShell, resetSearchState])
  useEffect(() => () => cancelResetRef.current?.(), [])

  // A pick that opens a session hands the caret to that session's composer
  // (it focuses itself as its tab comes to the front), so the search box lets
  // go of it first; every other close (Escape, a click outside, a file) gives
  // focus back where it was. Letting go before the switch, not after, also
  // keeps the restyle it costs off the switch's own frame.
  const releaseFocus = useCallback(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active === inputRef.current) {
      active.blur()
    }
  }, [])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      markQuickSwitchPick(conv.id)
      releaseFocus()
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations, releaseFocus]
  )

  const handleSelectMessageHit = useCallback(
    (hit: MessageSearchHit) => {
      releaseFocus()
      // Open the conversation (as picking it above does) and hand the query to
      // its find bar, so the matched turn is highlighted in context even when
      // it sits pages deep — also in a conversation that is already open.
      openConversations()
      openTab(hit.folder_id, hit.conversation_id, hit.agent_type, true)
      setPendingFind(hit.conversation_id, query.trim())
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations, query, releaseFocus]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )

  // The session the selection rests on, while the dialog shows. One that is
  // not open in a tab has its transcript fetched and its agent pre-connected
  // (after the usual short dwell), so picking it does not wait on either. An
  // open tab is live already.
  const selectedConversation = useMemo(() => {
    if (!open || legacyShell || !conversationTab) return null
    if (!selectedValue) return null
    if (recentMode) {
      return recent.find((c) => recentValue(c) === selectedValue) ?? null
    }
    return shownResults.find((c) => resultValue(c) === selectedValue) ?? null
  }, [
    open,
    legacyShell,
    conversationTab,
    selectedValue,
    recentMode,
    recent,
    shownResults,
  ])
  // The preselected row is fetched at once (⌘K then Enter is quick); a row
  // the selection only passes over on the way down the list is not, until it
  // rests there.
  const preselected = pickedValue == null
  useEffect(() => {
    const conv = selectedConversation
    if (!conv || openConversationIds.has(conv.id)) return
    const timer = setTimeout(
      () => prefetchConversationDetail(conv.id),
      preselected ? 0 : PREFETCH_DWELL_MS
    )
    preconnectConversation(conv)
    return () => {
      clearTimeout(timer)
      cancelConversationPreconnect(conv)
    }
  }, [selectedConversation, openConversationIds, preselected])

  // Keys typed after the shortcut but before the search box had focus: replay
  // them here, in order, once it has (text into the box, keys to the list).
  const replayTypeahead = useCallback(() => {
    const keys = takeQuickSwitchTypeahead()
    if (keys.length === 0) return
    // After the commit that opened the dialog, so state updates flush.
    queueMicrotask(() => {
      const input = inputRef.current
      if (!input) return
      for (const key of keys) {
        if (key.key === "Escape") {
          onOpenChange(false)
          return
        }
        if (key.key === "Backspace") {
          flushSync(() => setQuery((q) => q.slice(0, -1)))
        } else if (key.key.length === 1) {
          flushSync(() => setQuery((q) => q + key.key))
        } else {
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: key.key,
              code: key.code,
              shiftKey: key.shiftKey,
              bubbles: true,
              cancelable: true,
            })
          )
        }
      }
    })
  }, [onOpenChange])

  const handleOpened = useCallback(() => {
    // A list scrolled down last time comes back scrolled (the engine keeps a
    // hidden box's offset); the first row is the one to see.
    const list = listRef.current
    if (list && list.scrollTop !== 0) list.scrollTop = 0
    replayTypeahead()
    markQuickSwitchShown(list?.querySelectorAll("[cmdk-item]").length ?? 0)
  }, [replayTypeahead])

  // Keys aimed at the dialog are its own: the typeahead buffer lets them
  // through untouched.
  const commandRootRef = useCallback((node: HTMLDivElement | null) => {
    setQuickSwitchTypeaheadOwner(node)
  }, [])

  const placeholder =
    activeTab === "all"
      ? t("allPlaceholder")
      : activeTab === "conversations"
        ? t("placeholder")
        : activeTab === "messages"
          ? t("messagePlaceholder")
          : t("filePlaceholder")

  const title = folder
    ? t("dialogTitleWithFolder", { name: folder.name })
    : t("dialogTitle")

  // The rows the All and Conversations tabs share.
  const recentGroup =
    recentMode && recent.length > 0 ? (
      <CommandGroup heading={t("recentHeading")}>
        {recent.map((conv) => (
          <ConversationRow
            key={conv.id}
            value={recentValue(conv)}
            conversation={conv}
            onPick={handleSelectConversation}
            title={
              formatConversationTitle(conv.title) || t("untitledConversation")
            }
            status={conv.status}
            folderName={folderLabel(conv.folder_id)}
            agentType={conv.agent_type}
            time={relativeTime(conv.updated_at)}
          />
        ))}
      </CommandGroup>
    ) : null
  const conversationResultGroup = (heading?: string) =>
    !recentMode && shownResults.length > 0 ? (
      <CommandGroup heading={heading}>
        {shownResults.map((conv) => (
          <ConversationRow
            key={conv.id}
            value={resultValue(conv)}
            conversation={conv}
            onPick={handleSelectConversation}
            title={
              formatConversationTitle(conv.title) || t("untitledConversation")
            }
            status={conv.status}
            folderName={folderLabel(conv.folder_id)}
            agentType={conv.agent_type}
            time={relativeTime(conv.created_at)}
            badge={
              archivedIds.has(conv.folder_id) ? t("archivedBadge") : undefined
            }
          />
        ))}
      </CommandGroup>
    ) : null
  const renderMessageHit = (hit: MessageSearchHit) => (
    <CommandItem
      key={messageHitValue(hit)}
      value={messageHitValue(hit)}
      onSelect={() => handleSelectMessageHit(hit)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate">
            {formatConversationTitle(hit.title) || t("untitledConversation")}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {getAgentLabel(hit.agent_type)}
          </span>
        </div>
        {/* The excerpt's own direction: a Hebrew match reads right to left,
            its role label first on the right, and truncates at its end rather
            than its start. */}
        <div
          dir={detectTextDirection(
            splitSnippet(hit.snippet)
              .map((part) => part.text)
              .join("")
          )}
          className="truncate text-xs text-muted-foreground"
        >
          <span className="me-1.5 font-medium">
            {t(MESSAGE_ROLE_KEYS[hit.role])}
          </span>
          {splitSnippet(hit.snippet).map((part, i) =>
            part.marked ? (
              <mark
                key={i}
                className="rounded bg-yellow-400/30 text-foreground dark:bg-yellow-300/25"
              >
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            )
          )}
        </div>
      </div>
    </CommandItem>
  )
  const allTabMessageHits =
    activeTab === "all"
      ? messageHits.slice(0, ALL_TAB_MESSAGE_LIMIT)
      : NO_MESSAGE_HITS
  const allTabHasMoreMessages =
    activeTab === "all" && messageHits.length > ALL_TAB_MESSAGE_LIMIT

  const content: ReactNode = (
    <>
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {t("dialogTitleWithFolder", { name: folder.name })}
          </span>
        </div>
      )}

      {/* Tabs. Tab in the search box steps through them; the hint says so
          where there is room for it. */}
      <div className="flex items-center gap-0 border-b px-3">
        {SEARCH_TABS.map((tab) => (
          <button
            key={tab}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchTab(tab)}
            className={cn(
              "relative h-9 px-3 text-sm font-medium transition-colors",
              activeTab === tab
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(SEARCH_TAB_LABEL_KEYS[tab])}
            {activeTab === tab && (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        ))}
        <span
          aria-hidden="true"
          className="ms-auto hidden shrink-0 ps-2 text-2xs text-muted-foreground/70 sm:inline"
        >
          {t("tabHint")}
        </span>
      </div>

      <CommandInput
        ref={inputRef}
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
        onKeyDown={onSearchKeyDown}
      />

      {/* Agent filter (conversations tab only). Wraps: one chip per agent type
          present in the folder, each carrying a full name, so a workspace with
          a dozen enabled agents runs past the dialog — which is
          `overflow-hidden`, so the tail chips were clipped away and simply
          could not be clicked. Wrapping keeps every filter reachable and lets
          the block grow by a row instead of hiding options. */}
      {activeTab === "conversations" && folder && (
        <div className="flex items-center gap-1 px-3 pt-2">
          <button
            onClick={() => setThisFolderOnly(false)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              !thisFolderOnly
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("scopeAllFolders")}
          </button>
          <button
            onClick={() => setThisFolderOnly(true)}
            className={cn(
              "flex min-w-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
              thisFolderOnly
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Folder className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              {t("scopeThisFolder", { name: folder.name })}
            </span>
          </button>
        </div>
      )}

      {activeTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {getAgentLabel(at)}
            </button>
          ))}
        </div>
      )}

      <CommandList ref={listRef} className="min-h-96">
        {/* All: sessions by title first, then the messages that match */}
        {activeTab === "all" && (
          <>
            <CommandEmpty>
              {searching || messageSearching
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchAll")
                  : searchFailed && messageSearchFailed
                    ? t(searchFailed)
                    : t("noResults")}
            </CommandEmpty>
            {recentGroup}
            {conversationResultGroup(t("sessionsHeading"))}
            {!recentMode && allTabMessageHits.length > 0 && (
              <CommandGroup heading={t("messagesHeading")}>
                {allTabMessageHits.map(renderMessageHit)}
                {allTabHasMoreMessages && (
                  <CommandItem
                    value={SHOW_ALL_MESSAGES_VALUE}
                    onSelect={() => switchTab("messages")}
                    className="text-muted-foreground"
                  >
                    <span className="flex-1 truncate">
                      {t("showAllMessages")}
                    </span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}
          </>
        )}

        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && (!agentFilter || showRecent)
                  ? t("typeToSearch")
                  : searchFailed
                    ? t(searchFailed)
                    : t("noResults")}
            </CommandEmpty>
            {recentGroup}
            {conversationResultGroup()}
          </>
        )}

        {/* Messages tab */}
        {activeTab === "messages" && (
          <>
            <CommandEmpty>
              {messageSearching
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchMessages")
                  : messageSearchFailed
                    ? t(messageSearchFailed)
                    : t("noResults")}
            </CommandEmpty>
            {messageHits.length > 0 && (
              <CommandGroup heading={t("messagesHeading")}>
                {messageHits.map(renderMessageHit)}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </>
  )

  if (legacyShell) {
    return (
      <CommandDialog
        title={title}
        open={open}
        onOpenChange={onOpenChange}
        shouldFilter={activeTab === "conversations"}
        value={selectedValue}
        onValueChange={setPickedValue}
        // Not `autoFocus`: an input focused while mounting takes focus before
        // the focus trap starts listening, so the trap never records it and
        // has nothing to pull focus back to when the chat composer behind the
        // dialog refocuses itself at the end of a turn — the rest of the query
        // would be typed into the composer.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        {content}
      </CommandDialog>
    )
  }

  return (
    <InstantCommandDialog
      ref={commandRootRef}
      title={title}
      open={open}
      onOpenChange={onOpenChange}
      initialFocusRef={inputRef}
      onOpened={handleOpened}
      shouldFilter={activeTab === "conversations"}
      value={selectedValue}
      onValueChange={setPickedValue}
    >
      {content}
    </InstantCommandDialog>
  )
}
