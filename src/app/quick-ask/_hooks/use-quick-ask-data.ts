"use client"

import { useCallback, useEffect, useState } from "react"

import { listAllConversations, listAllFolderDetails } from "@/lib/api"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

/** How many recent sessions the "existing session" picker offers. */
const MAX_SESSIONS = 200

export interface QuickAskSessionOption {
  id: number
  title: string | null
  agentType: DbConversationSummary["agent_type"]
  folderId: number
  folderName: string
  folderPath: string
  externalId: string | null
  updatedAt: string
}

export interface QuickAskData {
  /** Project folders (hidden chat folders excluded), most recently opened
   *  first. */
  folders: FolderDetail[]
  sessions: QuickAskSessionOption[]
  loading: boolean
  reload: () => void
}

/** Sessions worth continuing: top-level regular and chat conversations whose
 *  folder is known, most recently updated first. */
export function toSessionOptions(
  conversations: DbConversationSummary[],
  allFolders: FolderDetail[]
): QuickAskSessionOption[] {
  const byId = new Map(allFolders.map((f) => [f.id, f]))
  return conversations
    .filter(
      (c) =>
        (c.kind === "regular" || c.kind === "chat") &&
        c.parent_id == null &&
        byId.has(c.folder_id)
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_SESSIONS)
    .map((c) => {
      const folder = byId.get(c.folder_id)!
      return {
        id: c.id,
        title: c.title,
        agentType: c.agent_type,
        folderId: c.folder_id,
        folderName: folder.name,
        folderPath: folder.path,
        externalId: c.external_id,
        updatedAt: c.updated_at,
      }
    })
}

export function toFolderOptions(allFolders: FolderDetail[]): FolderDetail[] {
  return allFolders
    .filter((f) => f.kind !== "chat")
    .sort((a, b) => b.last_opened_at.localeCompare(a.last_opened_at))
}

/** Folders and recent sessions of the backend the window is bound to. */
export function useQuickAskData(): QuickAskData {
  const [folders, setFolders] = useState<FolderDetail[]>([])
  const [sessions, setSessions] = useState<QuickAskSessionOption[]>([])
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [allFolders, conversations] = await Promise.all([
          listAllFolderDetails(),
          listAllConversations({}),
        ])
        if (cancelled) return
        setFolders(toFolderOptions(allFolders))
        setSessions(toSessionOptions(conversations, allFolders))
      } catch (e) {
        console.warn("[quick-ask] could not load folders/sessions:", e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return { folders, sessions, loading, reload }
}
