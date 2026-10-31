"use client"

/**
 * The Talk items of a session's menus (header, tab, sidebar row):
 *
 * - "Talk on this Mac" where it can run (the macOS app on Apple Silicon, the
 *   helper's check passed, a saved conversation on a server with Talk mode);
 * - "End Talk" in the window whose Talk is with this session;
 * - "Turn off Talk mode" for a Talk mode left on by the phone (or another
 *   window); "Turn on Talk mode" (reply style only) stays only where Talk on
 *   this Mac can't run.
 */

import { useCallback } from "react"

import { useTalkEligibility, useTalkVoice } from "@/contexts/talk-voice-context"

export interface TalkMenu {
  showTalkOnMac: boolean
  showEndTalk: boolean
  showTurnOff: boolean
  showTurnOn: boolean
  startTalk(): void
  endTalk(): void
}

export function useTalkMenu(
  conversationId: number | null | undefined,
  isTalk: boolean
): TalkMenu {
  const talk = useTalkVoice()
  const eligible = useTalkEligibility(conversationId) === "ok"
  const holdsHere =
    conversationId != null && talk.session?.conversationId === conversationId
  const { startTalk: start, endTalk: end } = talk
  const startTalk = useCallback(() => {
    if (conversationId != null) void start(conversationId)
  }, [conversationId, start])
  const endTalk = useCallback(() => {
    void end()
  }, [end])
  return {
    showTalkOnMac: eligible && !holdsHere,
    showEndTalk: holdsHere,
    showTurnOff: isTalk && !holdsHere,
    showTurnOn: !isTalk && !eligible && !holdsHere,
    startTalk,
    endTalk,
  }
}
