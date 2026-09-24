import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import {
  UserMessageEditor,
  type UserMessageEditorProps,
} from "./user-message-editor"
import enMessages from "@/i18n/messages/en.json"

const L = enMessages.Folder.chat.messageList

function renderEditor(props: Partial<UserMessageEditorProps> = {}) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  const rememberDraft = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UserMessageEditor
        draftKey="persisted-user-turn-2"
        initialText="original text"
        recallDraft={() => undefined}
        rememberDraft={rememberDraft}
        images={[]}
        startsNewConversation={false}
        saving={false}
        blocked={null}
        onCancel={onCancel}
        onSave={onSave}
        {...props}
      />
    </NextIntlClientProvider>
  )
  const field = screen.getByRole("textbox", { name: L.editMessage })
  return { field, onSave, onCancel, rememberDraft }
}

describe("UserMessageEditor", () => {
  it("picks up a draft typed into an earlier mount", () => {
    // The transcript is virtualized: scrolled out of view, the editor
    // unmounts, and coming back must not start the edit over.
    const { field } = renderEditor({
      recallDraft: (key) =>
        key === "persisted-user-turn-2" ? "half-edited" : undefined,
    })
    expect(field).toHaveValue("half-edited")
  })

  it("hands every keystroke to the host's draft keeper", async () => {
    const { field, rememberDraft } = renderEditor()
    await userEvent.type(field, "!")
    expect(rememberDraft).toHaveBeenLastCalledWith(
      "persisted-user-turn-2",
      "original text!"
    )
  })

  it("leaves an Enter that confirms an IME candidate to the IME", () => {
    // ⌘/Ctrl+Enter mid-composition commits the candidate; saving on it would
    // send half-typed text — the common case for every CJK input method.
    const { field, onSave } = renderEditor()
    fireEvent.keyDown(field, { key: "Enter", metaKey: true, keyCode: 229 })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: "Enter", metaKey: true })
    expect(onSave).toHaveBeenCalledWith("original text")
  })

  it("won't save an empty message, unless it carries images", () => {
    const { field, onSave } = renderEditor({ initialText: "" })
    expect(screen.getByRole("button", { name: L.editSave })).toBeDisabled()
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows the images that go along, and lets them carry an empty text", () => {
    renderEditor({
      initialText: "",
      images: [
        {
          name: "shot.png",
          data: "iVBORw0KGgo=",
          mime_type: "image/png",
          uri: null,
        },
      ],
    })
    expect(
      screen.getByRole("list", { name: L.editImagesKept })
    ).toHaveTextContent("shot.png")
    expect(screen.getByRole("button", { name: L.editSave })).toBeEnabled()
  })

  it("says why saving can't run, and doesn't", () => {
    const { field, onSave } = renderEditor({ blocked: "queued" })
    expect(screen.getByText(L.editQueued)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: L.editSave })).toBeDisabled()
    fireEvent.keyDown(field, { key: "Enter", metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("won't cancel mid-save — the edit is already under way", () => {
    const { field, onCancel } = renderEditor({ saving: true })
    fireEvent.keyDown(field, { key: "Escape" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: L.editCancel })).toBeDisabled()
  })

  it("keeps Escape to itself, away from find-in-chat and the panes", () => {
    const { field, onCancel } = renderEditor()
    const outer = vi.fn()
    document.addEventListener("keydown", outer)
    try {
      fireEvent.keyDown(field, { key: "Escape" })
    } finally {
      document.removeEventListener("keydown", outer)
    }
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it("names the new conversation when it's the first message being edited", () => {
    renderEditor({ startsNewConversation: true, saving: true })
    expect(screen.getByText(L.editHintNewConversation)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: L.editSavingNewConversation })
    ).toBeDisabled()
  })
})
