/**
 * Talk mode — the desktop's half.
 *
 * The user holds a hands-free voice conversation with one session from the
 * phone, which does the listening and the speaking; the backend keeps each
 * conversation's Talk state and asks the agent for short spoken answers while
 * it is on (see `docs/talk-mode.md`). The desktop shows the state (a badge on
 * the session's sidebar row, its tab and its header), turns it on or off — a
 * Talk left on by a phone that crashed, say — marks the messages that were
 * spoken, and edits the global settings.
 */

import { setConversationTalkMode } from "@/lib/api"
import type { TalkAddress, TalkLanguage } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** Choices offered in Settings, in order. */
export const TALK_LANGUAGES = [
  "auto",
  "he",
  "en",
] as const satisfies readonly TalkLanguage[]
export const TALK_ADDRESSES = [
  "auto",
  "masculine",
  "feminine",
] as const satisfies readonly TalkAddress[]

/** Label per language, under `TalkSettings`. Literal on purpose: next-intl
 *  keys are typed. */
export const TALK_LANGUAGE_LABEL_KEYS = {
  auto: "languageAuto",
  he: "languageHebrew",
  en: "languageEnglish",
} as const satisfies Record<TalkLanguage, string>

/** Label per address form, under `TalkSettings`. */
export const TALK_ADDRESS_LABEL_KEYS = {
  auto: "addressAuto",
  masculine: "addressMasculine",
  feminine: "addressFeminine",
} as const satisfies Record<TalkAddress, string>

/**
 * Turn Talk mode on or off for a conversation, optimistically: the row (and
 * with it the badge on its sidebar row, tab and header) changes at once, and
 * goes back if the backend refuses. The backend's upsert echo then carries the
 * stored state to every client. Turning it off sends the agent nothing by
 * itself: the user's next message tells it.
 */
export async function setTalkMode(
  conversationId: number,
  enabled: boolean
): Promise<void> {
  const store = useAppWorkspaceStore.getState()
  const prev = store.conversations.find((c) => c.id === conversationId)
  store.updateConversationLocal(conversationId, { talk_mode: enabled })
  try {
    await setConversationTalkMode(conversationId, enabled)
  } catch (err) {
    if (prev) {
      useAppWorkspaceStore.getState().updateConversationLocal(conversationId, {
        talk_mode: prev.talk_mode ?? false,
      })
    }
    throw err
  }
}
