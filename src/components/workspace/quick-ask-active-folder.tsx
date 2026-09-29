"use client"

import { useEffect } from "react"

import { publishActiveFolder } from "@/lib/quick-ask/prefs"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/**
 * Tells the Quick Ask window which folder this workspace is looking at, so a
 * new question that has no remembered folder yet starts there. Published per
 * backend: a remote workspace's folder ids mean nothing locally.
 */
export function QuickAskActiveFolderPublisher() {
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  useEffect(() => {
    publishActiveFolder(getActiveRemoteConnectionId(), activeFolderId)
  }, [activeFolderId])
  return null
}
