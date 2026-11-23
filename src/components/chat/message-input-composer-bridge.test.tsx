/**
 * The composer as the rest of the window reaches it (`lib/composer-bridge`):
 * the right-hand panel's prepared prompts are sent through it on the very
 * route Enter takes in the same state, and put into it for editing without
 * losing what the user has drafted.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentProps } from "react"
import type { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RichComposerHandle } from "./composer/rich-composer"
import { serializeDocToText } from "./composer/to-prompt-blocks"

// Capture the RichComposer handle so a test can drive the real editor.
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

vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { send_message: "enter", newline_in_message: "shift+enter" },
  }),
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
import {
  getComposerBridge,
  resetComposerBridgesForTests,
} from "@/lib/composer-bridge"
import type { PromptCapabilitiesInfo } from "@/lib/types"
import { MessageInput } from "./message-input"

const CAPS: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}
const KEY = "tab-1"

type InputProps = Partial<ComponentProps<typeof MessageInput>>

async function mount(props: InputProps = {}) {
  const onSend = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPS}
        composerBridgeKey={KEY}
        {...props}
      />
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

function bridge() {
  const found = getComposerBridge(KEY)
  if (!found) throw new Error("no composer published")
  return found
}

function text(editor: Editor): string {
  return serializeDocToText(editor.state.doc)
}

/** A draft the user typed, with the caret where they left it. */
function draft(editor: Editor, content: string, caret?: number) {
  act(() => {
    fireEvent.focus(editor.view.dom)
    editor.commands.insertContent(content)
    if (caret != null) editor.commands.setTextSelection(caret)
  })
}

afterEach(() => {
  cleanup()
  composerHandle.current = null
  resetComposerBridgesForTests()
  vi.clearAllMocks()
})

describe("composer bridge: publishing", () => {
  it("is published under its key while mounted, and only then", async () => {
    const { view } = await mount()
    expect(getComposerBridge(KEY)).not.toBeNull()
    view.unmount()
    expect(getComposerBridge(KEY)).toBeNull()
  })

  it("is not published without a key", async () => {
    await mount({ composerBridgeKey: undefined })
    expect(getComposerBridge(KEY)).toBeNull()
  })
})

describe("composer bridge: sending, by Enter's route", () => {
  it("sends now on an idle session, leaving the draft alone", async () => {
    const onEnqueue = vi.fn()
    const { onSend, editor } = await mount({ onEnqueue })
    draft(editor, "half a thought")
    expect(bridge().sendRoute).toBe("send")
    expect(bridge().isReplying).toBe(false)

    let route: unknown
    act(() => {
      route = bridge().send("  Run the tests again.\n")
    })
    expect(route).toBe("send")
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toEqual({
      blocks: [{ type: "text", text: "Run the tests again." }],
      displayText: "Run the tests again.",
    })
    expect(onEnqueue).not.toHaveBeenCalled()
    expect(text(editor)).toBe("half a thought")
  })

  it("queues while a reply runs, as Enter does", async () => {
    const onEnqueue = vi.fn()
    const { onSend } = await mount({
      isPrompting: true,
      onCancel: vi.fn(),
      onEnqueue,
    })
    expect(bridge().sendRoute).toBe("enqueue")
    expect(bridge().isReplying).toBe(true)

    act(() => {
      bridge().send("Next: the docs")
    })
    expect(onEnqueue).toHaveBeenCalledTimes(1)
    expect(onEnqueue.mock.calls[0][0]).toEqual({
      blocks: [{ type: "text", text: "Next: the docs" }],
      displayText: "Next: the docs",
    })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("queues while the session is still opening", async () => {
    const onEnqueue = vi.fn()
    await mount({ disabled: false, queueSends: true, onEnqueue })
    expect(bridge().sendRoute).toBe("enqueue")
    expect(bridge().isReplying).toBe(false)
  })

  it("delivers into a turn held open for background work", async () => {
    const onDeliverNow = vi.fn().mockResolvedValue(undefined)
    const { onSend } = await mount({
      isPrompting: true,
      onCancel: vi.fn(),
      onEnqueue: vi.fn(),
      heldTurnReady: true,
      onDeliverNow,
    })
    expect(bridge().sendRoute).toBe("deliver")
    act(() => {
      bridge().send("go on")
    })
    await waitFor(() =>
      expect(onDeliverNow).toHaveBeenCalledWith(
        "go on",
        undefined,
        expect.stringMatching(/^optimistic-/)
      )
    )
    expect(onSend).not.toHaveBeenCalled()
  })

  it("refuses where the composer refuses: disconnected, or replying with no queue", async () => {
    const first = await mount({ disabled: true, onEnqueue: vi.fn() })
    expect(bridge().sendRoute).toBeNull()
    let route: unknown = "unset"
    act(() => {
      route = bridge().send("hello")
    })
    expect(route).toBeNull()
    expect(first.onSend).not.toHaveBeenCalled()
    first.view.unmount()

    const second = await mount({ isPrompting: true, onCancel: vi.fn() })
    expect(bridge().sendRoute).toBeNull()
    act(() => {
      bridge().send("hello")
    })
    expect(second.onSend).not.toHaveBeenCalled()
  })

  it("follows the composer as its state changes", async () => {
    const onEnqueue = vi.fn()
    const { view } = await mount({ onEnqueue })
    expect(bridge().sendRoute).toBe("send")
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={vi.fn()}
          promptCapabilities={CAPS}
          composerBridgeKey={KEY}
          isPrompting
          onCancel={vi.fn()}
          onEnqueue={onEnqueue}
        />
      </NextIntlClientProvider>
    )
    expect(bridge().sendRoute).toBe("enqueue")
  })
})

describe("composer bridge: putting a prompt in to edit first", () => {
  it("fills an empty composer with it", async () => {
    const { editor, onSend } = await mount()
    let placed = false
    act(() => {
      placed = bridge().insert("Explain the failing test")
    })
    expect(placed).toBe(true)
    expect(text(editor)).toBe("Explain the failing test")
    // Nothing goes out: the user sends it when they are done editing.
    expect(onSend).not.toHaveBeenCalled()
  })

  it("keeps a draft and adds the prompt on its own line at the caret", async () => {
    const { editor } = await mount()
    // Caret at the end of the draft.
    draft(editor, "first line")
    act(() => {
      bridge().insert("the prompt")
    })
    expect(text(editor)).toBe("first line\nthe prompt")
  })

  it("splits the line around a caret in the middle of it", async () => {
    const { editor } = await mount()
    // Position 6 is right after "hello".
    draft(editor, "hello world", 6)
    act(() => {
      bridge().insert("PROMPT")
    })
    expect(text(editor)).toBe("hello\nPROMPT\n world")
  })

  it("needs no extra break at the start of a line", async () => {
    const { editor } = await mount()
    act(() => {
      fireEvent.focus(editor.view.dom)
      composerHandle.current?.insertTextAtCursor("one\ntwo")
    })
    // Right after the line break, before "two".
    const breakEnd = 1 + "one".length + 1
    act(() => {
      editor.commands.setTextSelection(breakEnd)
    })
    act(() => {
      bridge().insert("PROMPT")
    })
    expect(text(editor)).toBe("one\nPROMPT\ntwo")
  })

  it("never replaces a selection", async () => {
    const { editor } = await mount()
    draft(editor, "keep all of this")
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    act(() => {
      bridge().insert("PROMPT")
    })
    expect(text(editor)).toBe("keep\nPROMPT\n all of this")
  })

  it("goes after a draft whose caret was never placed", async () => {
    const { editor } = await mount()
    // A restored draft: content, but the user never clicked into it.
    act(() => {
      composerHandle.current?.setText("restored draft")
      editor.commands.setTextSelection(1)
    })
    act(() => {
      bridge().insert("PROMPT")
    })
    expect(text(editor)).toBe("restored draft\nPROMPT")
  })
})
