"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { getClaudeSubagentThread } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"
import { useTabStore, type SubagentTabTarget } from "@/stores/tab-store"

/** Re-read cadence while the sub-agent works (or its file is awaited). Each
 *  read parses only what the sub-agent appended since (the transcript cache). */
export const SUBAGENT_REFRESH_MS = 2000

/** How long a tab opened as its sub-agent started waits for the first write
 *  before it says there is no transcript. */
export const SUBAGENT_FILE_WAIT_MS = 60_000

export type SubagentThreadStatus =
  | "loading"
  /** Nothing on disk yet; the sub-agent may still be starting. */
  | "waiting"
  | "ready"
  /** Nothing on disk, and nothing came. */
  | "missing"
  | "error"

export interface SubagentThreadState {
  status: SubagentThreadStatus
  running: boolean
  error: string | null
  parentTitle: string | null
  subagentType: string | null
}

/**
 * Read a Claude Code sub-agent's thread into the runtime session `runtimeId`,
 * where the tab's `MessageListView` renders it like any session's. Read when
 * the tab is shown, and again every couple of seconds while the backend says
 * the sub-agent is still at work; a hidden tab reads nothing. The id the
 * first read learns goes with every later one, so they go straight to the
 * file, and onto the tab (it is what reopens it after a restart).
 */
export function useSubagentThread({
  tabId,
  target,
  runtimeId,
  visible,
}: {
  tabId: string
  target: SubagentTabTarget
  runtimeId: number
  visible: boolean
}): SubagentThreadState {
  const { putViewerDetail, removeConversation } =
    useConversationRuntimeActions()
  const [state, setState] = useState<SubagentThreadState>(() => ({
    status: "loading",
    running: false,
    error: null,
    parentTitle: null,
    subagentType: target.subagentType ?? null,
  }))
  const openedAt = useRef(Date.now())
  const agentIdRef = useRef(target.agentId ?? null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The session belongs to this tab alone.
  useEffect(
    () => () => removeConversation(runtimeId),
    [runtimeId, removeConversation]
  )

  const { parentConversationId, toolCallId } = target
  const read = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const thread = await getClaudeSubagentThread(
        parentConversationId,
        toolCallId,
        agentIdRef.current
      )
      if (!mountedRef.current) return
      if (!thread) {
        const waited = Date.now() - openedAt.current
        setState((prev) => ({
          ...prev,
          status: waited < SUBAGENT_FILE_WAIT_MS ? "waiting" : "missing",
          running: false,
        }))
        return
      }
      agentIdRef.current = thread.agent_id
      putViewerDetail(runtimeId, thread.detail)
      useTabStore.getState().updateSubagentTab(tabId, {
        agentId: thread.agent_id,
        ...(thread.subagent_type ? { subagentType: thread.subagent_type } : {}),
        ...(thread.description ? { description: thread.description } : {}),
        ...(thread.description ? { title: thread.description } : {}),
        status: thread.running ? "in_progress" : "completed",
      })
      setState({
        status: "ready",
        running: thread.running,
        error: null,
        parentTitle: thread.parent_title ?? null,
        subagentType: thread.subagent_type ?? target.subagentType ?? null,
      })
    } catch (err) {
      if (!mountedRef.current) return
      // A read failing after a good one (the file rewritten mid-read) keeps
      // what is on screen; the next one will very likely succeed.
      setState((prev) =>
        prev.status === "ready"
          ? prev
          : {
              ...prev,
              status: "error",
              running: false,
              error: toErrorMessage(err),
            }
      )
    } finally {
      inFlightRef.current = false
    }
  }, [
    parentConversationId,
    toolCallId,
    runtimeId,
    tabId,
    putViewerDetail,
    target.subagentType,
  ])

  // Shown: read it (again — a resumed sub-agent writes to the same file).
  useEffect(() => {
    if (visible) void read()
  }, [visible, read])

  const keepReading =
    state.status === "loading" ||
    state.status === "waiting" ||
    (state.status === "ready" && state.running)
  useEffect(() => {
    if (!visible || !keepReading) return
    const timer = window.setInterval(() => void read(), SUBAGENT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [visible, keepReading, read])

  return state
}
