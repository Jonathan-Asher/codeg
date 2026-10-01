"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
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
import { useShowRecentOnSearch } from "@/lib/search-recent-prefs"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
import { splitSnippet } from "@/lib/message-search-snippet"
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
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

type SearchTab = "conversations" | "messages" | "files"

/** Most message hits one search shows. */
const MESSAGE_SEARCH_LIMIT = 40

/** Most sessions the recent list shows with nothing typed. */
const RECENT_SESSION_LIMIT = 30

const MESSAGE_ROLE_KEYS = {
  user: "roleUser",
  assistant: "roleAssistant",
  system: "roleSystem",
} as const

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ConversationRowProps {
  value: string
  onSelect: () => void
  title: string
  status: string | undefined
  /** Shown when the list spans folders; null hides it. */
  folderName: string | null
  agentType: AgentType
  /** Relative time already formatted, or null when unknown. */
  time: string | null
  /** A short label after the title (the current session's "Current"). */
  badge?: string
}

/** One conversation in the Conversations tab — a result or a recent one. */
function ConversationRow({
  value,
  onSelect,
  title,
  status,
  folderName,
  agentType,
  time,
  badge,
}: ConversationRowProps) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
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
}

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
  // With nothing typed, the Conversations tab is a session switcher: the
  // current session first (selected), the most recently active ones below,
  // so ↓ Enter goes back to the last session you were in.
  const [showRecent] = useShowRecentOnSearch()
  const activeConversationTab = useTabStore(
    (s) =>
      s.tabs.find(
        (tab) => tab.id === s.activeTabId && tab.conversationId != null
      ) ?? null
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs leaves it there, so typing always searches.
  const inputRef = useRef<HTMLInputElement>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    inputRef.current?.focus()
  }, [])
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [messageHits, setMessageHits] = useState<MessageSearchHit[]>([])
  const [messageSearching, setMessageSearching] = useState(false)

  const folderPath = folder?.path ?? ""

  const recentMode =
    activeTab === "conversations" && showRecent && !query.trim()

  // The workspace store holds every sidebar row; only when it has none yet
  // (not loaded) does the recent list ask the backend itself.
  const storeEmpty = allConversations.length === 0
  const [fetchedConversations, setFetchedConversations] = useState<
    DbConversationSummary[]
  >([])
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

  const currentConversation = useMemo(() => {
    const id = activeConversationTab?.conversationId
    if (!open || !activeConversationTab || id == null) return null
    // A tab carries enough to show the row even when the list lacks it.
    const known = recentSource.find((c) => c.id === id)
    return {
      id,
      folderId: known?.folder_id ?? activeConversationTab.folderId,
      agentType: known?.agent_type ?? activeConversationTab.agentType,
      title: known ? known.title : activeConversationTab.title,
      status: known?.status ?? activeConversationTab.status,
      updatedAt: known?.updated_at ?? null,
    }
  }, [open, activeConversationTab, recentSource])

  const recent = useMemo(
    () =>
      open && recentMode
        ? recentSessions(recentSource, {
            knownFolderIds: new Set(folderNames.keys()),
            excludeId: currentConversation?.id ?? null,
            folderId: scopedFolderId,
            agentType: agentFilter,
            limit: RECENT_SESSION_LIMIT,
          })
        : [],
    [
      open,
      recentMode,
      recentSource,
      folderNames,
      currentConversation,
      scopedFolderId,
      agentFilter,
    ]
  )

  const relativeTime = useCallback(
    (iso: string) =>
      formatDistanceToNow(new Date(iso), {
        addSuffix: true,
        locale: dateFnsLocale,
      }),
    [dateFnsLocale]
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
    enabled: activeTab === "files",
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // Rank files by relevance (name/path tiers + fuzzy subsequence), scanning the
  // full list so a deeply nested match isn't crowded out by shallower ones.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null) => {
      // With nothing typed, the recent list (narrowed by the agent filter)
      // stands in for results — unless it is turned off.
      if (!q.trim() && (!agent || showRecent)) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: scopedFolderId != null ? [scopedFolderId] : null,
          search: q.trim() || null,
          agent_type: agent,
        })
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [scopedFolderId, showRecent]
  )

  // Debounced search on query change (conversations tab only)
  useEffect(() => {
    if (activeTab !== "conversations") return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, agentFilter)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, agentFilter, doSearch, activeTab])

  // Debounced message-content search (messages tab only). It spans every
  // conversation rather than the active folder's: the words of a message are
  // often all that is remembered of a conversation, including where it ran.
  useEffect(() => {
    if (activeTab !== "messages") return
    const q = query.trim()
    let stale = false
    const timer = setTimeout(() => {
      if (!q) {
        setMessageHits([])
        setMessageSearching(false)
        return
      }
      setMessageSearching(true)
      searchMessages(q, MESSAGE_SEARCH_LIMIT)
        .then((hits) => {
          if (!stale) setMessageHits(hits)
        })
        .catch(() => {
          if (!stale) setMessageHits([])
        })
        .finally(() => {
          if (!stale) setMessageSearching(false)
        })
    }, 250)
    return () => {
      // The query moved on: an answer still in flight must not replace the
      // results of the newer one.
      stale = true
      clearTimeout(timer)
    }
  }, [query, activeTab])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setAgentFilter(null)
      setThisFolderOnly(false)
      setResults([])
      setMessageHits([])
      setMessageSearching(false)
      setActiveTab("conversations")
      resetFileTree()
    }
  }, [open, resetFileTree])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations]
  )

  // The current session is already in front: picking it only closes the
  // dialog (and leaves a workbench route covering it, as picking any does).
  const handleSelectCurrent = useCallback(() => {
    openConversations()
    onOpenChange(false)
  }, [onOpenChange, openConversations])

  const handleSelectMessageHit = useCallback(
    (hit: MessageSearchHit) => {
      // Open the conversation (as picking it above does) and hand the query to
      // its find bar, so the matched turn is highlighted in context even when
      // it sits pages deep — also in a conversation that is already open.
      openConversations()
      openTab(hit.folder_id, hit.conversation_id, hit.agent_type, true)
      setPendingFind(hit.conversation_id, query.trim())
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations, query]
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

  const placeholder =
    activeTab === "conversations"
      ? t("placeholder")
      : activeTab === "messages"
        ? t("messagePlaceholder")
        : t("filePlaceholder")

  return (
    <CommandDialog
      title={
        folder
          ? t("dialogTitleWithFolder", { name: folder.name })
          : t("dialogTitle")
      }
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={activeTab === "conversations"}
    >
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {t("dialogTitleWithFolder", { name: folder.name })}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {activeTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("messages")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "messages"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabMessages")}
          {activeTab === "messages" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {activeTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
      </div>

      <CommandInput
        ref={inputRef}
        autoFocus
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
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

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && (!agentFilter || showRecent)
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {recentMode && currentConversation && (
              <CommandGroup>
                <ConversationRow
                  value={`current-${currentConversation.id}`}
                  onSelect={handleSelectCurrent}
                  title={
                    formatConversationTitle(currentConversation.title) ||
                    t("untitledConversation")
                  }
                  status={currentConversation.status}
                  folderName={folderLabel(currentConversation.folderId)}
                  agentType={currentConversation.agentType}
                  time={
                    currentConversation.updatedAt
                      ? relativeTime(currentConversation.updatedAt)
                      : null
                  }
                  badge={t("currentSession")}
                />
              </CommandGroup>
            )}
            {recentMode && recent.length > 0 && (
              <CommandGroup heading={t("recentHeading")}>
                {recent.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    value={`recent-${conv.id}`}
                    onSelect={() => handleSelectConversation(conv)}
                    title={
                      formatConversationTitle(conv.title) ||
                      t("untitledConversation")
                    }
                    status={conv.status}
                    folderName={folderLabel(conv.folder_id)}
                    agentType={conv.agent_type}
                    time={relativeTime(conv.updated_at)}
                  />
                ))}
              </CommandGroup>
            )}
            {!recentMode && results.length > 0 && (
              <CommandGroup>
                {results.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    value={`${conv.id}-${formatConversationTitle(conv.title)}`}
                    onSelect={() => handleSelectConversation(conv)}
                    title={
                      formatConversationTitle(conv.title) ||
                      t("untitledConversation")
                    }
                    status={conv.status}
                    folderName={folderLabel(conv.folder_id)}
                    agentType={conv.agent_type}
                    time={relativeTime(conv.created_at)}
                  />
                ))}
              </CommandGroup>
            )}
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
                  : t("noResults")}
            </CommandEmpty>
            {messageHits.length > 0 && (
              <CommandGroup heading={t("messagesHeading")}>
                {messageHits.map((hit) => (
                  <CommandItem
                    key={`${hit.conversation_id}-${hit.turn_idx}`}
                    value={`${hit.conversation_id}-${hit.turn_idx}`}
                    onSelect={() => handleSelectMessageHit(hit)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate">
                          {formatConversationTitle(hit.title) ||
                            t("untitledConversation")}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {getAgentLabel(hit.agent_type)}
                        </span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
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
                ))}
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
    </CommandDialog>
  )
}
