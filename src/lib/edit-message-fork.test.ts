/**
 * "Edit message" continues the conversation it edits: the fork it asks for,
 * and where the forked session lands in the runtime store — on the session the
 * conversation's tab already shows, never on a new one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  acpFork: vi.fn(),
}))

import { acpFork } from "@/lib/api"
import { editForkMode, forkConversationForEdit } from "./edit-message"
import {
  loadKeepOriginalOnEdit,
  saveKeepOriginalOnEdit,
} from "./edit-message-prefs"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

/** The runtime session the conversation's tab shows… */
const TAB_CONVERSATION = 7
/** …the DB row behind it… */
const ROW = 42
/** …and the row the backend made to hold the original branch. */
const SIBLING_ROW = 43

function seedConversation() {
  const { actions } = useConversationRuntimeStore.getState()
  actions.setDbConversationId(TAB_CONVERSATION, ROW)
  actions.setExternalId(TAB_CONVERSATION, "session-S1")
}

/** Save an edit the way the conversation panel does. */
function saveEdit() {
  const { actions } = useConversationRuntimeStore.getState()
  return forkConversationForEdit({
    connectionId: "conn-1",
    conversationId: ROW,
    folderId: 3,
    forkPointId: "turn-1",
    keepOriginal: loadKeepOriginalOnEdit(),
    adoptForkedSession: (sessionId) =>
      actions.setExternalId(TAB_CONVERSATION, sessionId),
  })
}

beforeEach(() => {
  resetConversationRuntimeStore()
  vi.mocked(acpFork).mockReset()
  vi.mocked(acpFork).mockResolvedValue({
    forkedSessionId: "session-S2",
    originalSessionId: "session-S1",
    siblingConversationId: SIBLING_ROW,
  })
})

afterEach(() => {
  localStorage.clear()
  resetConversationRuntimeStore()
})

describe("editing a past message", () => {
  it("continues the same conversation on the forked session, by default", async () => {
    seedConversation()

    await expect(saveEdit()).resolves.toBe("session-S2")

    // The fork is asked for on THIS conversation's row, in place.
    expect(acpFork).toHaveBeenCalledWith(
      "conn-1",
      ROW,
      3,
      "turn-1",
      "edit_in_place"
    )
    // Still one runtime session — the one the tab shows — with the same row
    // behind it, now running on the forked agent session.
    const state = useConversationRuntimeStore.getState()
    expect([...state.byConversationId.keys()]).toEqual([TAB_CONVERSATION])
    const session = state.byConversationId.get(TAB_CONVERSATION)
    expect(session?.dbConversationId).toBe(ROW)
    expect(session?.externalId).toBe("session-S2")
    // Whatever finds a conversation by its agent session (the live
    // connection's events, a reconnect) lands on the same tab, and the
    // session left behind resolves to nothing.
    expect(state.conversationIdByExternalId.get("session-S2")).toBe(
      TAB_CONVERSATION
    )
    expect(state.conversationIdByExternalId.has("session-S1")).toBe(false)
    expect(state.byConversationId.has(SIBLING_ROW)).toBe(false)
  })

  it("asks to keep the original as its own conversation only when that is set", async () => {
    saveKeepOriginalOnEdit(true)
    seedConversation()

    await saveEdit()

    expect(acpFork).toHaveBeenCalledWith("conn-1", ROW, 3, "turn-1", "edit")
    // Even then the edited conversation stays where it is.
    const session = useConversationRuntimeStore
      .getState()
      .byConversationId.get(TAB_CONVERSATION)
    expect(session?.externalId).toBe("session-S2")
  })

  it("leaves the conversation on its session when the fork fails", async () => {
    seedConversation()
    vi.mocked(acpFork).mockRejectedValueOnce(new Error("fork refused"))

    await expect(saveEdit()).rejects.toThrow("fork refused")

    const session = useConversationRuntimeStore
      .getState()
      .byConversationId.get(TAB_CONVERSATION)
    expect(session?.externalId).toBe("session-S1")
  })
})

describe("editForkMode", () => {
  it("hides the original unless it is to be kept", () => {
    expect(editForkMode(false)).toBe("edit_in_place")
    expect(editForkMode(true)).toBe("edit")
  })

  it("defaults to editing in place", () => {
    expect(loadKeepOriginalOnEdit()).toBe(false)
    saveKeepOriginalOnEdit(true)
    expect(loadKeepOriginalOnEdit()).toBe(true)
  })
})
