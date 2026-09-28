/**
 * The composer's Continue: when it shows, and that it sends CONTINUE_PROMPT
 * through the very route Enter takes in the same state — a normal send while
 * the session is idle, a delivery into a turn held open for background work,
 * the queue where that turn has no way in.
 *
 * The host decides whether the conversation can take a Continue
 * (`canContinue`, see `lib/continue-turn`); these tests cover the composer's
 * half of the decision and the send.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentProps } from "react"
import type { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RichComposerHandle } from "./composer/rich-composer"
import { serializeDocToText } from "./composer/to-prompt-blocks"

// Capture the RichComposer handle so a test can type into the real editor.
const composerHandle = vi.hoisted(() => ({
  current: null as RichComposerHandle | null,
}))
vi.mock("./composer/rich-composer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/rich-composer")>()
  const React = await import("react")
  const Captured = React.forwardRef<
    RichComposerHandle,
    ComponentProps<typeof actual.RichComposer>
  >((props, ref) => {
    const assign = (handle: RichComposerHandle | null) => {
      composerHandle.current = handle
      if (typeof ref === "function") ref(handle)
      else if (ref) ref.current = handle
    }
    return React.createElement(actual.RichComposer, { ...props, ref: assign })
  })
  Captured.displayName = "CapturedRichComposer"
  return { ...actual, RichComposer: Captured }
})

// The send / newline bindings are per test: Continue's chord must yield to
// either one when the user has moved it onto ⌘/Ctrl+Enter.
const shortcutSettings = vi.hoisted(() => ({
  current: { send_message: "enter", newline_in_message: "shift+enter" },
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: shortcutSettings.current }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
vi.mock("@/hooks/use-agent-skills", () => ({ useAgentSkills: () => [] }))
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({
    enabledIds: new Set(),
    ready: false,
    supported: true,
  }),
}))
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => async () => [],
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationContextBar: () => null,
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: () => false,
}))
vi.mock("./composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("./composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
  openUrl: vi.fn(async () => {}),
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
}))
vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => async () => {},
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  quickMessagesList: vi.fn(async () => []),
}))
vi.mock("@/lib/turn-busy", () => ({
  isNoActiveTurnRejection: vi.fn(() => false),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}))

import enMessages from "@/i18n/messages/en.json"
import { CONTINUE_PROMPT } from "@/lib/session-activity"
import type { PromptCapabilitiesInfo } from "@/lib/types"
import { MessageInput } from "./message-input"

const MI = enMessages.Folder.chat.messageInput
const CAPS: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}
const CONTINUE_DRAFT = {
  blocks: [{ type: "text", text: CONTINUE_PROMPT }],
  displayText: CONTINUE_PROMPT,
}

type InputProps = Partial<ComponentProps<typeof MessageInput>>

async function mount(props: InputProps = {}) {
  const onSend = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageInput onSend={onSend} promptCapabilities={CAPS} {...props} />
    </NextIntlClientProvider>
  )
  await waitFor(
    () => expect(composerHandle.current?.getEditor()).toBeTruthy(),
    { timeout: 5000 }
  )
  const editor = composerHandle.current?.getEditor()
  if (!editor) throw new Error("composer editor not mounted")
  return { onSend, editor, view }
}

/** An idle, connected session that can take a Continue. */
const IDLE: InputProps = { canContinue: true, onEnqueue: vi.fn() }

/** A turn held open for background work, with the steering channel that
 *  reaches the idle agent at once. As the conversation panel wires it:
 *  prompting, with a Stop button and the held-turn delivery. */
function heldTurn(overrides: InputProps = {}): InputProps {
  return {
    canContinue: true,
    isPrompting: true,
    onCancel: vi.fn(),
    onEnqueue: vi.fn(),
    heldTurnReady: true,
    onDeliverNow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function continueButton() {
  return screen.queryByTestId("composer-continue")
}

function type(editor: Editor, text: string) {
  act(() => {
    editor.commands.insertContent(text)
  })
}

/** Press ⌘+Enter inside the editor, through ProseMirror's own key handling. */
function pressModEnter(editor: Editor) {
  act(() => {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  })
}

afterEach(() => {
  cleanup()
  composerHandle.current = null
  shortcutSettings.current = {
    send_message: "enter",
    newline_in_message: "shift+enter",
  }
  vi.clearAllMocks()
})

describe("MessageInput Continue: when it shows", () => {
  it("shows on an empty composer when the conversation can continue", async () => {
    await mount(IDLE)
    const button = continueButton()
    expect(button).toBeInTheDocument()
    expect(button).toHaveAccessibleName(MI.continue)
    // The tooltip names the chord, in the app's usual shortcut notation.
    expect(button).toHaveAttribute(
      "title",
      MI.continueHintShortcut.replace("{shortcut}", "⌘Enter")
    )
  })

  it("stays away when the host says the conversation cannot continue", async () => {
    await mount({ ...IDLE, canContinue: false })
    expect(continueButton()).toBeNull()
  })

  it("steps aside as soon as the user starts typing, and comes back when cleared", async () => {
    const { editor } = await mount(IDLE)
    type(editor, "actually, one more thing")
    await waitFor(() => expect(continueButton()).toBeNull())
    act(() => {
      editor.commands.clearContent(true)
    })
    await waitFor(() => expect(continueButton()).toBeInTheDocument())
  })

  it("stays away while a queued message is open for editing", async () => {
    await mount({ ...IDLE, isEditingQueueItem: true, editingItemId: "q-1" })
    expect(continueButton()).toBeNull()
  })

  it("stays away while the composer cannot send", async () => {
    // `disabled` without a turn in flight: disconnected, selectors loading.
    await mount({ ...IDLE, disabled: true })
    expect(continueButton()).toBeNull()
  })

  it("shows in a turn held open for background work, beside Stop", async () => {
    await mount(heldTurn())
    expect(continueButton()).toBeInTheDocument()
    expect(screen.getByTitle(MI.cancel)).toBeInTheDocument()
  })
})

describe("MessageInput Continue: what it sends", () => {
  it("sends CONTINUE_PROMPT as a normal turn when the session is idle", async () => {
    const user = userEvent.setup()
    const onEnqueue = vi.fn()
    const { onSend } = await mount({ ...IDLE, onEnqueue })
    await user.click(continueButton()!)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toEqual(CONTINUE_DRAFT)
    expect(onEnqueue).not.toHaveBeenCalled()
  })

  it("delivers it into a held turn, exactly where Enter would", async () => {
    const user = userEvent.setup()
    const props = heldTurn()
    const { onSend } = await mount(props)
    await user.click(continueButton()!)
    await waitFor(() =>
      expect(props.onDeliverNow).toHaveBeenCalledWith(
        CONTINUE_PROMPT,
        undefined
      )
    )
    expect(onSend).not.toHaveBeenCalled()
    expect(props.onEnqueue).not.toHaveBeenCalled()
  })

  it("leaves what the user typed meanwhile alone", async () => {
    const user = userEvent.setup()
    let deliver: () => void = () => {}
    const props = heldTurn({
      onDeliverNow: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            deliver = resolve
          })
      ),
    })
    const { editor } = await mount(props)
    await user.click(continueButton()!)
    type(editor, "and then the docs")
    await act(async () => deliver())
    expect(serializeDocToText(editor.state.doc)).toContain("and then the docs")
  })

  it("queues it where the held turn has no way in, as Enter does", async () => {
    const user = userEvent.setup()
    const props = heldTurn({ heldTurnReady: false, onDeliverNow: undefined })
    const { onSend } = await mount(props)
    await user.click(continueButton()!)
    expect(props.onEnqueue).toHaveBeenCalledTimes(1)
    expect(vi.mocked(props.onEnqueue!).mock.calls[0][0]).toEqual(CONTINUE_DRAFT)
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe("MessageInput Continue: ⌘/Ctrl+Enter", () => {
  it("continues from an empty composer", async () => {
    const { onSend, editor } = await mount(IDLE)
    pressModEnter(editor)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toEqual(CONTINUE_DRAFT)
  })

  it("does nothing special once there is text — the chord keeps its line break", async () => {
    const { onSend, editor } = await mount(IDLE)
    type(editor, "draft")
    pressModEnter(editor)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does nothing when Continue is not on offer", async () => {
    const { onSend, editor } = await mount({ ...IDLE, canContinue: false })
    pressModEnter(editor)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("yields the chord to a send binding moved onto it", async () => {
    shortcutSettings.current = {
      send_message: "mod+enter",
      newline_in_message: "enter",
    }
    const { onSend, editor } = await mount(IDLE)
    pressModEnter(editor)
    // Send on an empty box sends nothing, and Continue does not step in.
    expect(onSend).not.toHaveBeenCalled()
    // The tooltip stops promising the chord.
    expect(continueButton()).toHaveAttribute("title", MI.continueHint)
  })
})
