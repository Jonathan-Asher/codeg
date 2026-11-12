import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HistoryUnavailable, SavedTurn } from "@/lib/types"

const getConversationSavedTurns = vi.hoisted(() =>
  vi.fn<(id: number) => Promise<SavedTurn[]>>()
)
vi.mock("@/lib/api", () => ({ getConversationSavedTurns }))

// The markdown stack and the overlay scrollbar are the transcript's concern,
// not this view's.
vi.mock("@/components/ai-elements/message", () => ({
  Message: ({
    children,
    from,
    ...rest
  }: {
    children?: ReactNode
    from: string
    "aria-label"?: string
  }) => (
    <div data-from={from} aria-label={rest["aria-label"]}>
      {children}
    </div>
  ),
  MessageContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageResponse: ({ children }: { children?: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { HistoryUnavailableView } from "./history-unavailable-view"
import enMessages from "@/i18n/messages/en.json"

const CLEANED_UP: HistoryUnavailable = {
  reason: "agent_cleanup",
  retention_days: 30,
  saved_turns: 3,
}

const SAVED: SavedTurn[] = [
  { turn_idx: 0, role: "user", content: "Do research on alternatives" },
  { turn_idx: 11, role: "assistant", content: "I've started **four** tracks" },
  { turn_idx: 58, role: "user", content: "What about Seedance 2.5?" },
]

function renderView(
  props: Partial<Parameters<typeof HistoryUnavailableView>[0]> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HistoryUnavailableView
        conversationId={76}
        info={CLEANED_UP}
        agentLabel="Claude Code"
        {...props}
      />
    </NextIntlClientProvider>
  )
}

// The saved copy loads after the first paint; tests about the rest of the view
// wait for it, so it does not land after they end.
const savedCopyLoaded = () =>
  screen.findByRole("list", { name: "Saved messages" })

beforeEach(() => {
  getConversationSavedTurns.mockReset()
  getConversationSavedTurns.mockResolvedValue(SAVED)
})

describe("HistoryUnavailableView", () => {
  it("says the agent's cleanup deleted the history, and how old it was", async () => {
    renderView()
    expect(
      screen.getByRole("heading", { name: "History unavailable" })
    ).toBeVisible()
    expect(
      screen.getByText(
        "Claude Code deleted this session's history because it was older than 30 days."
      )
    ).toBeVisible()
    expect(screen.getByText(/It can't be resumed or forked/)).toBeVisible()
    await savedCopyLoaded()
  })

  it("falls back to the plain reason when it can't tell why", async () => {
    renderView({
      info: { reason: "missing", retention_days: null, saved_turns: 3 },
    })
    expect(
      screen.getByText(
        "The agent's history file for this session no longer exists."
      )
    ).toBeVisible()
    await savedCopyLoaded()
  })

  it("reads an unknown reason from a newer server as the plain one", async () => {
    renderView({
      info: { reason: "something_new", saved_turns: 3 },
    })
    expect(
      screen.getByText(
        "The agent's history file for this session no longer exists."
      )
    ).toBeVisible()
    await savedCopyLoaded()
  })

  it("shows the saved turns, read-only and labelled as a partial copy", async () => {
    renderView()
    expect(
      screen.getByText("Saved copy · 3 messages · text only")
    ).toBeVisible()
    const list = await screen.findByRole("list", { name: "Saved messages" })
    const items = list.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(getConversationSavedTurns).toHaveBeenCalledWith(76)

    // The person's own messages as written; the agent's through markdown.
    expect(screen.getByText("Do research on alternatives")).toBeVisible()
    expect(screen.getByTestId("markdown").textContent).toBe(
      "I've started **four** tracks"
    )
    expect(
      screen.getAllByLabelText("You", { selector: "[data-from=user]" })
    ).toHaveLength(2)
    expect(
      screen.getAllByLabelText("Claude Code", {
        selector: "[data-from=assistant]",
      })
    ).toHaveLength(1)
    // Nothing to type into: the session can't take a message.
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("does not ask for saved text the index never had", () => {
    renderView({
      info: { reason: "agent_cleanup", retention_days: 30, saved_turns: 0 },
      onStartNew: vi.fn(),
    })
    expect(
      screen.getByText(
        "Opens a new Claude Code session in this folder. There is no saved text to carry over."
      )
    ).toBeVisible()
    expect(
      screen.getByText("codeg kept no text of this session.")
    ).toBeVisible()
    expect(getConversationSavedTurns).not.toHaveBeenCalled()
  })

  it("says so when the saved copy can't be loaded", async () => {
    getConversationSavedTurns.mockRejectedValue(new Error("server gone"))
    renderView()
    expect(
      await screen.findByText("Couldn't load the saved copy: server gone")
    ).toBeVisible()
  })

  it("offers to start a new session from it, and only then does anything", async () => {
    const onStartNew = vi.fn()
    renderView({ onStartNew })
    expect(
      screen.getByText(
        "Opens a new Claude Code session in this folder with the saved text in its composer. Nothing is sent until you send it."
      )
    ).toBeVisible()
    expect(onStartNew).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new session from this" })
    )
    expect(onStartNew).toHaveBeenCalledTimes(1)
    await savedCopyLoaded()
  })

  it("holds the button while the new session is being prepared", async () => {
    renderView({ onStartNew: vi.fn(), starting: true })
    expect(
      screen.getByRole("button", { name: "Start a new session from this" })
    ).toBeDisabled()
    await savedCopyLoaded()
  })

  it("leaves the action out where no new session can be opened", async () => {
    renderView({ onStartNew: undefined })
    await savedCopyLoaded()
    expect(
      screen.queryByRole("button", { name: "Start a new session from this" })
    ).toBeNull()
  })
})
