import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => {
  const session = {
    conn: {
      status: null as string | null,
      agentType: null as string | null,
      configOptions: null as unknown,
      pendingPermission: null,
      pendingAskQuestion: null,
      respondPermission: () => Promise.resolve(),
      answerQuestion: () => Promise.resolve(),
    },
    effectiveAgent: "claude_code",
    thread: [] as unknown[],
    binding: null as null | Record<string, unknown>,
    starting: false,
    error: null as null | { code: string; detail: string | null },
    lastCleanup: null,
    isPrivate: false,
    prepare: () => Promise.resolve(),
    send: (() => Promise.resolve(true)) as (text: string) => Promise<boolean>,
    cancel: () => Promise.resolve(),
    clear: () => Promise.resolve(null as unknown),
    setConfigOption: () => Promise.resolve(),
    dismissError: () => {},
  }
  return {
    session,
    lastArgs: null as null | Record<string, unknown>,
    openConversation: null as unknown as ReturnType<typeof vi.fn>,
  }
})

vi.mock("../_hooks/use-quick-ask-session", () => ({
  QUICK_ASK_CONTEXT_KEY: "quick-ask",
  useQuickAskSession: (args: Record<string, unknown>) => {
    h.lastArgs = args
    return {
      ...h.session,
      isPrivate: h.session.isPrivate || args.target === "private",
    }
  },
}))
vi.mock("../_hooks/use-quick-ask-data", () => ({
  useQuickAskData: () => ({
    folders: [
      {
        id: 1,
        name: "codeg",
        alias: null,
        path: "/work/codeg",
        kind: "regular",
      },
      {
        id: 2,
        name: "site",
        alias: null,
        path: "/work/site",
        kind: "regular",
      },
    ],
    sessions: [],
    loading: false,
    reload: () => {},
  }),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: [
      {
        agent_type: "claude_code",
        enabled: true,
        available: true,
        installed_version: "0.81.1",
      },
    ],
    fresh: true,
    refresh: async () => {},
  }),
}))
vi.mock("@/hooks/use-feedback-enabled", () => ({
  useFeedbackEnabled: () => false,
}))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => ({
    getConnection: () => undefined,
    subscribeKey: () => () => {},
  }),
}))
vi.mock("@/lib/quick-ask/desktop", () => ({
  hideQuickAskWindow: vi.fn(async () => {}),
  openQuickAskConversation: (...args: unknown[]) => h.openConversation(...args),
}))

import { QuickAskWindow } from "./QuickAskWindow"

function renderWindow() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QuickAskWindow />
    </NextIntlClientProvider>
  )
}

const answer = (id: string, parts: unknown[]) => ({
  id,
  role: "assistant",
  message: { id, role: "assistant", content: parts, startedAt: 1 },
})

describe("QuickAskWindow", () => {
  beforeEach(() => {
    window.localStorage.clear()
    h.openConversation = vi.fn(async () => {})
    Object.assign(h.session, {
      thread: [],
      binding: null,
      error: null,
      starting: false,
      isPrivate: false,
      send: vi.fn(async () => true),
      clear: vi.fn(async () => null),
    })
    h.session.conn.status = null
    h.session.conn.agentType = null
    h.session.conn.configOptions = null
    h.session.setConfigOption = vi.fn(async () => {})
  })

  it("opens on a new session in the remembered folder with a fast model", () => {
    window.localStorage.setItem(
      "codeg:quick-ask:v1",
      JSON.stringify({ target: "new", folderByBackend: { local: 2 } })
    )
    renderWindow()
    expect(screen.getByText("Ask anything")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Starts a new conversation in the folder, listed in the sidebar."
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId("qa-target-new")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(h.lastArgs?.folder).toMatchObject({ id: 2, path: "/work/site" })
    expect(screen.getByTestId("qa-model-picker")).toHaveTextContent(
      "Claude Code · Haiku · Low"
    )
  })

  it("falls back to the workspace's active folder", () => {
    window.localStorage.setItem("codeg:quick-ask:active-folder:local", "2")
    renderWindow()
    expect(h.lastArgs?.folder).toMatchObject({ id: 2 })
  })

  it("remembers a new target and flags private questions", () => {
    renderWindow()
    fireEvent.click(screen.getByTestId("qa-target-private"))
    expect(
      JSON.parse(window.localStorage.getItem("codeg:quick-ask:v1")!).target
    ).toBe("private")
    expect(screen.getByTestId("qa-private-banner")).toHaveTextContent(
      "Private: deleted when you clear or close this window."
    )
    expect(
      screen.getByText(
        "Nothing is saved: no sidebar entry, no search, no history."
      )
    ).toBeInTheDocument()
  })

  it("sends on Enter, keeps a newline on Shift+Enter", async () => {
    renderWindow()
    const input = screen.getByTestId("qa-input")
    fireEvent.change(input, { target: { value: "line one" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(h.session.send).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(h.session.send).toHaveBeenCalledWith("line one"))
    expect(input).toHaveValue("")
  })

  it("puts the question back when it could not be sent", async () => {
    h.session.send = vi.fn(async () => false)
    renderWindow()
    const input = screen.getByTestId("qa-input")
    fireEvent.change(input, { target: { value: "no folder yet" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(input).toHaveValue("no folder yet"))
  })

  it("renders the answer with the app renderer, work folded away", () => {
    h.session.thread = [
      { id: "q1", role: "user", text: "What is 2+2?", state: "sent" },
      answer("a1", [
        {
          type: "tool_call",
          info: {
            tool_call_id: "call-1",
            title: "Read",
            kind: "read",
            status: "completed",
            content: null,
            raw_input: '{"file_path":"notes.md"}',
            raw_output_chunks: ["4"],
            raw_output_total_bytes: 1,
            locations: null,
            meta: null,
            images: [],
          },
        },
        { type: "text", text: "The answer is 4." },
      ]),
    ]
    h.session.binding = {
      target: "new",
      agentType: "claude_code",
      workingDir: "/work/codeg",
      folderId: 1,
      conversationId: 9,
      title: "What is 2+2?",
    }
    renderWindow()
    expect(screen.getByTestId("qa-question")).toHaveTextContent("What is 2+2?")
    expect(screen.getByTestId("qa-reply")).toHaveTextContent("The answer is 4.")
    // The tool call sits folded under the reply's header until asked for.
    expect(screen.queryByText(/Read files/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Finished working"))
    expect(screen.getByText(/Read files/)).toBeInTheDocument()
    // The target can't change under an open question.
    expect(screen.getByTestId("qa-target-private")).toBeDisabled()
    expect(screen.getByTestId("qa-input")).toHaveAttribute(
      "placeholder",
      "Ask a follow-up…"
    )
  })

  it("offers Open in codeg for saved sessions only", async () => {
    h.session.thread = [{ id: "q", role: "user", text: "hi", state: "sent" }]
    h.session.binding = {
      target: "new",
      agentType: "claude_code",
      workingDir: "/work/codeg",
      folderId: 1,
      conversationId: 9,
      title: "hi",
    }
    const { unmount } = renderWindow()
    const open = screen.getByTestId("qa-open")
    const opened = vi.spyOn(window, "open").mockReturnValue(null)
    fireEvent.click(open)
    // Outside the desktop app it opens the conversation in the workspace.
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith(
        "/workspace?folderId=1&conversationId=9&agent=claude_code",
        "_blank",
        "noopener"
      )
    )
    opened.mockRestore()
    unmount()

    h.session.binding = { ...h.session.binding, target: "private" }
    h.session.isPrivate = true
    renderWindow()
    expect(screen.queryByTestId("qa-open")).not.toBeInTheDocument()
  })

  it("clears on New question and confirms a private question was deleted", async () => {
    h.session.thread = [{ id: "q", role: "user", text: "hi", state: "sent" }]
    h.session.binding = {
      target: "private",
      agentType: "claude_code",
      workingDir: "/tmp/x",
      folderId: null,
      conversationId: null,
      title: null,
    }
    h.session.isPrivate = true
    h.session.clear = vi.fn(async () => {
      h.session.thread = []
      h.session.binding = null
      return { removed: ["/tmp/x"], failed: [] }
    })
    const { rerender } = renderWindow()
    fireEvent.click(screen.getByTestId("qa-new"))
    await waitFor(() => expect(h.session.clear).toHaveBeenCalled())
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QuickAskWindow />
      </NextIntlClientProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("qa-notice")).toHaveTextContent(
        "Private question deleted."
      )
    )
  })

  it("keeps Quick Ask's effort when a model switch resets it", () => {
    const select = (
      id: string,
      category: string,
      current: string,
      values: string[]
    ) => ({
      id,
      name: id,
      category,
      kind: {
        type: "select",
        current_value: current,
        options: values.map((v) => ({ value: v, name: v })),
        groups: [],
      },
    })
    h.session.conn.status = "connected"
    h.session.conn.agentType = "claude_code"
    // The adapter moved effort to Sonnet's own default after the switch.
    h.session.conn.configOptions = [
      select("model", "model", "sonnet", ["haiku", "sonnet"]),
      select("effort", "thought_level", "xhigh", ["low", "medium", "xhigh"]),
    ]
    const { rerender } = renderWindow()
    expect(h.session.setConfigOption).toHaveBeenCalledWith("effort", "low")
    // Once per model: a re-render (or a refusal) does not loop.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QuickAskWindow />
      </NextIntlClientProvider>
    )
    expect(h.session.setConfigOption).toHaveBeenCalledTimes(1)
  })

  it("leaves an existing session's effort alone", () => {
    window.localStorage.setItem(
      "codeg:quick-ask:v1",
      JSON.stringify({ target: "existing" })
    )
    h.session.conn.status = "connected"
    h.session.conn.agentType = "claude_code"
    h.session.conn.configOptions = [
      {
        id: "effort",
        name: "effort",
        category: "thought_level",
        kind: {
          type: "select",
          current_value: "xhigh",
          options: [
            { value: "low", name: "low" },
            { value: "xhigh", name: "xhigh" },
          ],
          groups: [],
        },
      },
    ]
    renderWindow()
    expect(h.session.setConfigOption).not.toHaveBeenCalled()
  })

  it("shows why a question could not start", () => {
    h.session.error = { code: "connect_failed", detail: "not logged in" }
    renderWindow()
    expect(screen.getByTestId("qa-error")).toHaveTextContent(
      "Couldn't start the agent: not logged in"
    )
  })
})
