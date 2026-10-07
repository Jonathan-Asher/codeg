import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  UserMessageEditor,
  type UserMessageEditorProps,
} from "./user-message-editor"
import enMessages from "@/i18n/messages/en.json"
import { saveKeepOriginalOnEdit } from "@/lib/edit-message-prefs"

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

  it("takes focus when opened, but not when it only comes back into view", () => {
    // Scrolling back to an open editor remounts it; the user may be typing in
    // the composer by then.
    const { field } = renderEditor({ takeFocus: () => true })
    expect(field).toHaveFocus()
    cleanup()
    const again = renderEditor({ takeFocus: () => false })
    expect(again.field).not.toHaveFocus()
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

  describe("switching to the saving state", () => {
    afterEach(() => {
      localStorage.clear()
    })

    /** Whether a class list transitions `opacity` (unprefixed classes only). */
    function easesOpacity(className: string): boolean {
      return className.split(/\s+/).some((name) => {
        if (
          ["transition", "transition-all", "transition-opacity"].includes(name)
        ) {
          return true
        }
        const list = /^transition-\[(.+)\]$/.exec(name)?.[1]
        return list !== undefined && /(^|,)(all|opacity)(,|$)/.test(list)
      })
    }

    function editorProps(
      saving: boolean,
      startsNewConversation: boolean
    ): UserMessageEditorProps {
      return {
        draftKey: "persisted-user-turn-2",
        initialText: "original text",
        recallDraft: () => undefined,
        rememberDraft: () => {},
        images: [],
        startsNewConversation,
        saving,
        blocked: null,
        onCancel: () => {},
        onSave: () => {},
      }
    }

    // Each path's wording: in place (the default), a new branch with the
    // original kept, and the first message (a new conversation).
    it.each([
      ["in place", false, false, L.editSavingInPlace],
      ["as a new branch", true, false, L.editSaving],
      ["into a new conversation", false, true, L.editSavingNewConversation],
    ])(
      "saving %s swaps the one button row without easing its dimming",
      (_path, keepOriginal, startsNewConversation, savingLabel) => {
        // The buttons dim (disabled) as the spinner starts. Eased, that
        // opacity change left WebKit painting the idle row — Cancel and
        // "Save & send" — under the saving one until the edit landed.
        if (keepOriginal) saveKeepOriginalOnEdit(true)
        const { rerender } = render(
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <UserMessageEditor {...editorProps(false, startsNewConversation)} />
          </NextIntlClientProvider>
        )
        rerender(
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <UserMessageEditor {...editorProps(true, startsNewConversation)} />
          </NextIntlClientProvider>
        )
        const editor = screen.getByRole("group", { name: L.editMessage })
        const buttons = within(editor).getAllByRole("button")
        expect(buttons.map((b) => b.textContent?.trim())).toEqual([
          L.editCancel,
          savingLabel,
        ])
        for (const button of buttons) {
          expect(button).toBeDisabled()
          expect(easesOpacity(button.className)).toBe(false)
        }
        // And back: a save that didn't go out restores the idle row, alone.
        rerender(
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <UserMessageEditor {...editorProps(false, startsNewConversation)} />
          </NextIntlClientProvider>
        )
        const idle = within(editor).getAllByRole("button")
        expect(idle).toHaveLength(2)
        expect(idle[1]).toHaveAccessibleName(L.editSave)
        for (const button of idle) {
          expect(easesOpacity(button.className)).toBe(false)
        }
      }
    )
  })

  describe("what saving does to the original", () => {
    afterEach(() => {
      localStorage.clear()
    })

    it("says the edit continues this conversation in place, by default", () => {
      renderEditor({ saving: true })
      expect(screen.getByText(L.editHintInPlace)).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: L.editSavingInPlace })
      ).toBeDisabled()
      expect(screen.queryByText(L.editHint)).toBeNull()
    })

    it("says the original stays in the sidebar when that is kept", () => {
      saveKeepOriginalOnEdit(true)
      renderEditor({ saving: true })
      expect(screen.getByText(L.editHint)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: L.editSaving })).toBeDisabled()
    })

    it("rewords an open editor when the setting changes elsewhere", () => {
      renderEditor()
      expect(screen.getByText(L.editHintInPlace)).toBeInTheDocument()
      act(() => saveKeepOriginalOnEdit(true))
      expect(screen.getByText(L.editHint)).toBeInTheDocument()
    })
  })
})
