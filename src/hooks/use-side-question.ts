"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useForkConversation } from "@/hooks/use-fork-conversation"
import {
  acpClearSideQuestions,
  acpListSideQuestions,
  acpSideQuestion,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { sideQuestionForkPrompt } from "@/lib/side-question"
import type { AgentType } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"
import {
  EMPTY_SIDE_QUESTION_PANEL,
  useSideQuestionStore,
  type SideQuestionEntry,
  type SideQuestionPanelState,
} from "@/stores/side-question-store"

export interface UseSideQuestionOptions {
  /** Where the panel's state lives (see `side-question-store`): the
   *  conversation's id once it has one, else the tab. */
  scope: string
  /** The live connection the question goes to, when there is one. */
  connectionId: string | null
  /** The conversation the exchanges are kept on. */
  conversationId: number | null
  agentType: AgentType | null
  /** The session answers side questions at all. Off: everything is inert. */
  supported: boolean
}

export interface SideQuestionController {
  panel: SideQuestionPanelState
  /** `/btw <question>`: ask it. `/btw` alone (an empty question): reopen. */
  ask: (question: string) => void
  close: () => void
  /** Step to an earlier (-1) or later (+1) exchange. */
  step: (delta: number) => void
  retry: (entry: SideQuestionEntry) => void
  copy: (entry: SideQuestionEntry) => void
  /** Forget the conversation's side questions. Absent before the
   *  conversation exists: nothing is kept then. */
  clear?: () => void
  /** Fork the conversation into a new one whose composer holds this
   *  exchange, to go on with it with tools. Absent before the conversation
   *  exists. */
  continueInFork?: (entry: SideQuestionEntry) => void
}

let localSerial = 0

/**
 * The composer's side questions for one conversation (see
 * `lib/side-question`): asking, the panel above the composer, and its
 * actions. Nothing here touches the transcript, the message queue or the
 * running turn.
 */
export function useSideQuestion({
  scope,
  connectionId,
  conversationId,
  agentType,
  supported,
}: UseSideQuestionOptions): SideQuestionController {
  const t = useTranslations("Folder.chat.sideQuestion")
  const panel = useSideQuestionStore(
    (state) => state.panels[scope] ?? EMPTY_SIDE_QUESTION_PANEL
  )
  const forkConversation = useForkConversation()
  // The newest target, read when a question goes out, so an answer that
  // takes a while never pins a stale connection.
  const targetRef = useRef({ connectionId, conversationId })
  useEffect(() => {
    targetRef.current = { connectionId, conversationId }
  }, [connectionId, conversationId])

  const loadHistory = useCallback(async () => {
    if (conversationId == null) return
    const store = useSideQuestionStore.getState()
    if ((store.panels[scope] ?? EMPTY_SIDE_QUESTION_PANEL).historyLoaded) return
    try {
      const records = await acpListSideQuestions(conversationId)
      useSideQuestionStore.getState().loadHistory(scope, records)
    } catch (err) {
      console.warn("[SideQuestion] could not load the history:", err)
    }
  }, [conversationId, scope])

  const send = useCallback(
    async (key: string, question: string) => {
      const store = useSideQuestionStore.getState()
      try {
        const record = await acpSideQuestion({
          connectionId: targetRef.current.connectionId,
          conversationId: targetRef.current.conversationId,
          question,
        })
        store.settle(scope, key, { status: "answered", record })
      } catch (err) {
        store.settle(scope, key, {
          status: "failed",
          error: toErrorMessage(err),
        })
      }
    },
    [scope]
  )

  const ask = useCallback(
    (question: string) => {
      if (!supported) return
      const store = useSideQuestionStore.getState()
      if (!question.trim()) {
        store.open(scope)
        void loadHistory()
        return
      }
      localSerial += 1
      const key = `local-${localSerial}`
      store.addPending(scope, key, question.trim())
      void loadHistory()
      void send(key, question.trim())
    },
    [supported, scope, loadHistory, send]
  )

  const close = useCallback(
    () => useSideQuestionStore.getState().close(scope),
    [scope]
  )

  const step = useCallback(
    (delta: number) => {
      const store = useSideQuestionStore.getState()
      const current = store.panels[scope] ?? EMPTY_SIDE_QUESTION_PANEL
      store.show(scope, current.index + delta)
    },
    [scope]
  )

  const retry = useCallback(
    (entry: SideQuestionEntry) => {
      useSideQuestionStore.getState().retry(scope, entry.key)
      void send(entry.key, entry.question)
    },
    [scope, send]
  )

  const copy = useCallback(
    (entry: SideQuestionEntry) => {
      const answer = entry.record?.answer
      if (!answer) return
      void copyTextToClipboard(answer).then((copied) => {
        if (copied) toast.success(t("copied"))
        else toast.error(t("copyFailed"))
      })
    },
    [t]
  )

  const clear = useMemo(() => {
    if (conversationId == null) return undefined
    return () => {
      void acpClearSideQuestions(conversationId)
        .then(() => useSideQuestionStore.getState().clear(scope))
        .catch((err: unknown) =>
          toast.error(t("clearFailed", { error: toErrorMessage(err) }))
        )
    }
  }, [conversationId, scope, t])

  const continueInFork = useMemo(() => {
    if (conversationId == null || agentType == null) return undefined
    return (entry: SideQuestionEntry) => {
      forkConversation(
        { id: conversationId, agent_type: agentType },
        {
          draft: sideQuestionForkPrompt(
            entry.question,
            entry.record?.answer ?? null
          ),
        }
      )
    }
  }, [conversationId, agentType, forkConversation])

  return useMemo(
    () => ({
      panel,
      ask,
      close,
      step,
      retry,
      copy,
      clear,
      continueInFork,
    }),
    [panel, ask, close, step, retry, copy, clear, continueInFork]
  )
}
