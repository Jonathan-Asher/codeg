import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: vi.fn(),
}))

import { useAcpAgents } from "@/hooks/use-acp-agents"
import enMessages from "@/i18n/messages/en.json"
import type { ContinuationHandoff } from "@/lib/api"
import {
  resetComposerPrefillsForTests,
  takeComposerPrefill,
} from "@/lib/composer-prefill-handoff"
import { peekContinuationLink } from "@/lib/continuation-links"
import {
  rememberSelectorTemplate,
  resetSelectorOptionsCacheForTests,
} from "@/lib/selector-options-cache"
import type {
  AcpAgentInfo,
  AgentType,
  DbConversationSummary,
  SessionConfigOptionInfo,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"
import { useContinueInAgentStore } from "@/stores/continue-in-agent-store"
import { ContinueInAgentDialog } from "./continue-in-agent-dialog"
import { ContinueInAgentMenuItem } from "./continue-in-agent-menu-item"

const AT = new Date(1_700_000_000_000).toISOString()

function conv(
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 42,
    folder_id: 5,
    title: "Fix the login",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: "feat/login",
    external_id: "session-S1",
    message_count: 4,
    child_count: 0,
    created_at: AT,
    updated_at: AT,
    pinned_at: null,
    working_dir: "/work/app",
    turn_state: null,
    ...overrides,
  }
}

function agent(agentType: AgentType): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: agentType,
    enabled: true,
    available: true,
    sort_order: 0,
  } as AcpAgentInfo
}

function withIntl(ui: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** A plain stand-in for a menu's item component. */
function Item({
  disabled,
  onSelect,
  children,
}: {
  disabled?: boolean
  onSelect?: (event: Event) => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  )
}

function renderDialog(
  conversation: DbConversationSummary,
  deps: {
    requestHandoff: (id: number) => Promise<ContinuationHandoff>
    buildMechanical?: (id: number) => Promise<string>
    savePicks?: (agentType: AgentType, picks: unknown) => void
  }
) {
  const onClose = vi.fn()
  const openNewConversationTab = vi.fn(() => ({
    tabId: "draft-9",
    agentType: "codex" as AgentType,
    folderId: 5,
  }))
  render(
    withIntl(
      <ContinueInAgentDialog
        conversation={conversation}
        onClose={onClose}
        deps={{
          ...deps,
          openNewConversationTab,
          placement: () => ({ targetGroup: "g-main", index: 2 }),
          savePicks: deps.savePicks ?? (() => {}),
          focusComposer: () => {},
        }}
      />
    )
  )
  return { onClose, openNewConversationTab, user: userEvent.setup() }
}

beforeAll(() => {
  // jsdom has no ResizeObserver; the agent selector measures its row.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  localStorage.clear()
  resetComposerPrefillsForTests()
  resetSelectorOptionsCacheForTests()
  resetAppWorkspaceStore()
  useConversationAttentionStore.getState().reset()
  useContinueInAgentStore.getState().close()
  vi.mocked(useAcpAgents).mockReturnValue({
    agents: [agent("claude_code"), agent("codex")],
    fresh: true,
    refresh: async () => {},
  })
})

afterEach(cleanup)

describe("the menu item", () => {
  it("is disabled, saying why, while a turn runs", () => {
    useAppWorkspaceStore.setState({
      conversations: [conv({ turn_state: "running" })],
    })
    render(
      withIntl(<ContinueInAgentMenuItem conversationId={42} item={Item} />)
    )
    const button = screen.getByRole("button", {
      name: /Continue in another agent/,
    })
    expect(button).toBeDisabled()
    expect(button.parentElement?.getAttribute("title")).toBe(
      "Available once the current reply finishes"
    )
  })

  it("is disabled while a permission waits for the user", () => {
    useAppWorkspaceStore.setState({ conversations: [conv()] })
    useConversationAttentionStore.getState().applyChange({
      id: 42,
      kind: "permission",
    } as never)
    render(
      withIntl(<ContinueInAgentMenuItem conversationId={42} item={Item} />)
    )
    const button = screen.getByRole("button", {
      name: /Continue in another agent/,
    })
    expect(button).toBeDisabled()
    expect(button.parentElement?.getAttribute("title")).toBe(
      "Answer what the session is waiting for first"
    )
  })

  it("opens the dialog for its session when idle", async () => {
    useAppWorkspaceStore.setState({ conversations: [conv()] })
    render(
      withIntl(<ContinueInAgentMenuItem conversationId={42} item={Item} />)
    )
    const button = screen.getByRole("button", {
      name: /Continue in another agent/,
    })
    expect(button).not.toBeDisabled()
    await userEvent.setup().click(button)
    expect(useContinueInAgentStore.getState().conversationId).toBe(42)
  })
})

describe("the dialog", () => {
  it("says the old agent writes a handoff first, and can't start mid-turn", () => {
    const running = conv({ turn_state: "running" })
    useAppWorkspaceStore.setState({ conversations: [running] })
    renderDialog(running, { requestHandoff: vi.fn() })
    expect(
      screen.getByText(
        "Claude Code will first write a handoff in this session (one extra message)."
      )
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
  })

  it("captures the handoff and opens the new session with it prefilled", async () => {
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    const requestHandoff = vi.fn(
      async (): Promise<ContinuationHandoff> => ({
        text: "## Goal\nShip the login fix.",
        failure: null,
      })
    )
    const { user, onClose, openNewConversationTab } = renderDialog(source, {
      requestHandoff,
    })

    await user.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(openNewConversationTab).toHaveBeenCalled())
    expect(requestHandoff).toHaveBeenCalledWith(42)
    expect(onClose).toHaveBeenCalled()
    // Another agent than the old one by default; same folder and working
    // directory; beside the old tab.
    expect(openNewConversationTab).toHaveBeenCalledWith(5, "/work/app", {
      targetGroup: "g-main",
      index: 2,
      forceAgent: "codex",
    })
    expect(
      takeComposerPrefill("draft-9", { agentType: "codex", folderId: 5 })?.text
    ).toBe(
      "Continuing [Fix the login](codeg://session/42) from Claude Code.\n\n## Goal\nShip the login fix."
    )
    expect(peekContinuationLink("draft-9")).toBe(42)
  })

  it("shows why the handoff failed and continues without a summary", async () => {
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    const requestHandoff = vi.fn(
      async (): Promise<ContinuationHandoff> => ({
        text: null,
        failure: {
          kind: "usage_limit",
          message: "You've hit your weekly limit",
        },
      })
    )
    const buildMechanical = vi.fn(
      async () =>
        "- **Session**: [Fix the login](codeg://session/42)\n- **Branch**: `feat/login`"
    )
    const { user, onClose, openNewConversationTab } = renderDialog(source, {
      requestHandoff,
      buildMechanical,
    })

    await user.click(screen.getByRole("button", { name: "Continue" }))

    expect(
      await screen.findByText(
        /Claude Code could not write the handoff\. The account's usage limit stopped it\./
      )
    ).toBeTruthy()
    expect(screen.getByText("You've hit your weekly limit")).toBeTruthy()
    expect(openNewConversationTab).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole("button", { name: "Continue without a summary" })
    )

    await waitFor(() => expect(openNewConversationTab).toHaveBeenCalled())
    expect(buildMechanical).toHaveBeenCalledWith(42)
    expect(
      takeComposerPrefill("draft-9", { agentType: "codex", folderId: 5 })?.text
    ).toBe(
      "Continuing [Fix the login](codeg://session/42) from Claude Code.\n\n- **Session**: [Fix the login](codeg://session/42)\n- **Branch**: `feat/login`"
    )
  })

  it("sets the new session's model and effort with the composer's settings chip", async () => {
    const select = (
      id: string,
      name: string,
      category: string,
      options: string[],
      recommended: string
    ): SessionConfigOptionInfo => ({
      id,
      name,
      description: null,
      category,
      kind: {
        type: "select",
        current_value: options[0]!,
        options: options.map((o) => ({ value: o, name: o, description: null })),
        groups: [],
      },
      recommended_value: recommended,
    })
    rememberSelectorTemplate("codex", {
      modes: null,
      configOptions: [
        select("model", "Model", "model", ["gpt-6", "gpt-5"], "gpt-6"),
        select(
          "effort",
          "Effort",
          "thought_level",
          ["low", "medium", "high"],
          "medium"
        ),
      ],
    })
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    const savePicks = vi.fn()
    const { user, openNewConversationTab } = renderDialog(source, {
      requestHandoff: async () => ({ text: "handoff", failure: null }),
      savePicks,
    })

    const chip = screen.getByRole("button", { name: /Agent settings/ })
    expect(chip).toHaveAccessibleName(/Model gpt-6, Effort medium/)
    await user.click(chip)
    await user.click(await screen.findByRole("button", { name: "high" }))
    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(openNewConversationTab).toHaveBeenCalled())
    expect(savePicks).toHaveBeenCalledWith("codex", {
      modeId: null,
      configValues: { effort: "high" },
    })
  })

  it("does not offer Grok's permission mode, which a new session takes from the Grok settings", async () => {
    vi.mocked(useAcpAgents).mockReturnValue({
      agents: [agent("claude_code"), agent("grok")],
      fresh: true,
      refresh: async () => {},
    })
    const select = (
      id: string,
      category: string,
      values: string[],
      current: string
    ): SessionConfigOptionInfo => ({
      id,
      name: id === "model" ? "Model" : "Mode",
      description: null,
      category,
      kind: {
        type: "select",
        current_value: current,
        options: values.map((v) => ({ value: v, name: v, description: null })),
        groups: [],
      },
      recommended_value: current,
    })
    rememberSelectorTemplate("grok", {
      modes: null,
      configOptions: [
        select("model", "model", ["grok-4.6", "grok-4.5"], "grok-4.6"),
        select(
          "mode",
          "mode",
          ["default", "auto", "bypassPermissions"],
          "bypassPermissions"
        ),
      ],
    })
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    const savePicks = vi.fn()
    const { user, openNewConversationTab } = renderDialog(source, {
      requestHandoff: async () => ({ text: "handoff", failure: null }),
      savePicks,
    })

    const chip = screen.getByRole("button", { name: /Agent settings/ })
    expect(chip).toHaveAccessibleName(/Model grok-4\.6/)
    expect(chip).not.toHaveAccessibleName(/Always approve/)
    await user.click(chip)
    const popover = await screen.findByRole("dialog", {
      name: "Agent settings",
    })
    expect(within(popover).getByRole("group", { name: "Model" })).toBeTruthy()
    expect(within(popover).queryByRole("group", { name: "Mode" })).toBeNull()
    expect(within(popover).queryByText(/Always approve/)).toBeNull()
    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(openNewConversationTab).toHaveBeenCalled())
    expect(savePicks).toHaveBeenCalledWith("grok", {
      modeId: null,
      configValues: {},
    })
  })

  it("stops on Cancel after a failure, opening nothing", async () => {
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    const buildMechanical = vi.fn(async () => "plain")
    const { user, onClose, openNewConversationTab } = renderDialog(source, {
      requestHandoff: async () => ({
        text: null,
        failure: { kind: "connect", message: "the agent exited" },
      }),
      buildMechanical,
    })

    await user.click(screen.getByRole("button", { name: "Continue" }))
    await screen.findByText(/The session could not be opened\./)
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onClose).toHaveBeenCalled()
    expect(buildMechanical).not.toHaveBeenCalled()
    expect(openNewConversationTab).not.toHaveBeenCalled()
  })

  it("drops a handoff that arrives after Cancel", async () => {
    const source = conv()
    useAppWorkspaceStore.setState({ conversations: [source] })
    let resolve: (value: ContinuationHandoff) => void = () => {}
    const requestHandoff = vi.fn(
      () =>
        new Promise<ContinuationHandoff>((r) => {
          resolve = r
        })
    )
    const { user, onClose, openNewConversationTab } = renderDialog(source, {
      requestHandoff,
    })

    await user.click(screen.getByRole("button", { name: "Continue" }))
    expect(
      await screen.findByText("Claude Code is writing the handoff…")
    ).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    resolve({ text: "late", failure: null })
    await Promise.resolve()

    expect(onClose).toHaveBeenCalled()
    expect(openNewConversationTab).not.toHaveBeenCalled()
  })
})
