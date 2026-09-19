"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import {
  listAllConversations,
  searchMessages,
  type MessageSearchHit as ApiMessageSearchHit,
} from "@/lib/api"
import { setPendingFind } from "@/lib/pending-find"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
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

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
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
  const folderId = activeFolderId ?? 0
  const conversations = useMemo(
    () =>
      activeFolderId == null
        ? []
        : allConversations.filter((c) => c.folder_id === activeFolderId),
    [allConversations, activeFolderId]
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [messageHits, setMessageHits] = useState<ApiMessageSearchHit[]>([])
  const [messageSearching, setMessageSearching] = useState(false)
  const messageDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const folderPath = folder?.path ?? ""

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
      if (!q.trim() && !agent) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: folderId > 0 ? [folderId] : null,
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
    [folderId]
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

  // Message-content search (FTS5): runs WITHOUT agent filter across every
  // non-deleted conversation. Indexed at app start / turn completion; hits
  // may miss the newest tokens of a streaming turn until its TurnComplete
  // beats the debounce — acceptable for a search surface.
  useEffect(() => {
    if (activeTab !== "messages") return
    if (messageDebounceRef.current) clearTimeout(messageDebounceRef.current)
    messageDebounceRef.current = setTimeout(() => {
      const q = query.trim()
      if (!q) {
        setMessageHits([])
        setMessageSearching(false)
        return
      }
      setMessageSearching(true)
      searchMessages(q, 40)
        .then((hits) => setMessageHits(hits))
        .catch(() => setMessageHits([]))
        .finally(() => setMessageSearching(false))
    }, 250)
    return () => {
      if (messageDebounceRef.current) clearTimeout(messageDebounceRef.current)
    }
  }, [query, activeTab])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setAgentFilter(null)
      setResults([])
      setActiveTab("conversations")
      resetFileTree()
    }
  }, [open, resetFileTree])

  const renderSnippet = useCallback((snippet: string) => {
    // FTS5 snippet() wrapped matches with [[mark]]...[[/mark]]; split keeps
    // the delimiters so parity is the highlight state (never innerHTML).
    const parts = snippet.split(/(\[\[mark\]\]|\[\[\/mark\]\])/g)
    let marked = false
    return parts.map((part, i) => {
      if (part === "[[mark]]") {
        marked = true
        return null
      }
      if (part === "[[/mark]]") {
        marked = false
        return null
      }
      if (marked && part.length > 0) {
        return (
          <mark
            key={i}
            className="rounded-[0.25rem] bg-amber-400/40 px-0.5 text-inherit"
          >
            {part}
          </mark>
        )
      }
      return part.length > 0 ? <span key={i}>{part}</span> : null
    })
  }, [])

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

  const handleSelectMessageHit = useCallback(
    (hit: ApiMessageSearchHit) => {
      // Open the conversation and hand the matched query to its find bar —
      // the hit's turn autoplains via the same highlighted loop ⌘F paints,
      // so the match is visible in context even when it sits pages deep.
      openConversations()
      openTab(hit.folder_id, hit.conversation_id, hit.agent_type as never, true)
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
    activeTab === "conversations" ? t("placeholder") : t("filePlaceholder")

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
          onClick={() => setActiveTab("conversations")}
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
          onClick={() => setActiveTab("messages")}
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
          onClick={() => setActiveTab("files")}
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
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {results.length > 0 && (
              <CommandGroup>
                {results.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={`${conv.id}-${formatConversationTitle(conv.title)}`}
                    onSelect={() => handleSelectConversation(conv)}
                  >
                    <ConversationStatusDot
                      status={conv.status as ConversationStatus}
                    />
                    <span className="flex-1 truncate">
                      {formatConversationTitle(conv.title) ||
                        t("untitledConversation")}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {getAgentLabel(conv.agent_type)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(conv.created_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {/* Messages tab — FTS5 content search across every conversation */}
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
                    value={`m-${hit.conversation_id}-${hit.turn_idx}`}
                    onSelect={() => handleSelectMessageHit(hit)}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[0.8125rem] font-medium">
                          {hit.title || t("untitledConversation")}
                        </span>
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                          {getAgentLabel(hit.agent_type as never)}
                        </span>
                      </div>
                      <div className="truncate text-[0.75rem] text-muted-foreground">
                        <span className="me-1 font-medium capitalize">
                          {hit.role}:
                        </span>
                        {renderSnippet(hit.snippet)}
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
