import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  openFilePreview: vi.fn(),
}))

vi.mock("@/components/message/session-viewer-host", () => ({
  useSessionViewerHost: () => ({ open: mocks.open }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
}))

import { SubAgentOverlay, type RunningItemTarget } from "./sub-agent-overlay"
import { useBackgroundTitle } from "@/components/conversations/session-activity"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type {
  AsyncTaskRecord,
  BackgroundTaskBrief,
  ConversationBackground,
} from "@/lib/types"

const ago = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString()

/** One item of every kind the server lists: a sub-agent the turn waits for,
 *  one launched into the background, a codeg delegation, a background
 *  shell. */
const ITEMS: BackgroundTaskBrief[] = [
  {
    id: "toolu_fg",
    kind: "subagent",
    label: "Explore: Find the bug",
    started_at: ago(65),
    tool_call_id: "toolu_fg",
  },
  {
    id: "a4dc31",
    kind: "agent",
    label: "Review the diff",
    started_at: ago(30),
  },
  {
    id: "task-1",
    kind: "delegation",
    label: "Run the tests",
    started_at: ago(20),
    tool_call_id: "toolu_d",
    agent_type: "codex",
    conversation_id: 77,
  },
  { id: "sh1", kind: "shell", label: "pnpm build", started_at: ago(5) },
]

const background = (
  tasks: BackgroundTaskBrief[] = ITEMS
): ConversationBackground => ({
  task_count: tasks.length,
  tasks,
  out_of_turn: false,
  held_open: false,
})

const shellTask: AsyncTaskRecord = {
  task_id: "sh1",
  name: "pnpm build",
  task_type: "shell",
  description: "pnpm build",
  show_in_transcript: false,
  can_stop: true,
  state: "running",
  output_file_path: "/tmp/sh1.output",
}

const delegationSource: DelegationCardSource = {
  parentToolUseId: "toolu_d",
  input: null,
  output: null,
  errorText: null,
  state: "input-available",
  meta: null,
}

const locate = (item: BackgroundTaskBrief): RunningItemTarget => ({
  toolCallId: item.tool_call_id ?? (item.id === "a4dc31" ? "toolu_bg" : null),
  delegation: item.kind === "delegation" ? delegationSource : null,
})

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.open.mockReset()
  mocks.openFilePreview.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

const rows = () => screen.getAllByTestId("running-item")

describe("SubAgentOverlay (the Running panel)", () => {
  it("renders nothing while nothing runs", () => {
    const { container } = render(wrap(<SubAgentOverlay background={null} />))
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every kind in one place, with its kind, status and elapsed time", () => {
    render(wrap(<SubAgentOverlay background={background()} />))
    // Collapsed by default: a chip carrying the count.
    const chip = screen.getByRole("button", { name: "4 running" })
    fireEvent.click(chip)

    expect(rows().map((row) => row.dataset.kind)).toEqual([
      "subagent",
      "agent",
      "delegation",
      "shell",
    ])
    const [fg, bg, deleg, shell] = rows()
    expect(fg).toHaveTextContent("Explore: Find the bug")
    expect(fg).toHaveTextContent("Sub-agent")
    expect(fg).toHaveTextContent("Running")
    expect(fg).toHaveTextContent(/1:0[5-9]/)
    expect(bg).toHaveTextContent("Background sub-agent")
    expect(deleg).toHaveTextContent("Delegated agent · Codex")
    expect(shell).toHaveTextContent("Shell")
    // The choice is remembered for the next conversation.
    expect(window.localStorage.getItem("codeg:running-overlay-expanded")).toBe(
      "1"
    )
  })

  it("jumps to a sub-agent's card, and opens a delegation's own conversation", () => {
    window.localStorage.setItem("codeg:running-overlay-expanded", "1")
    const onJump = vi.fn()
    render(
      wrap(
        <SubAgentOverlay
          background={background()}
          locate={locate}
          onJumpToToolCall={onJump}
        />
      )
    )
    const [fg, bg, deleg] = rows()
    fireEvent.click(within(fg).getAllByRole("button")[0])
    expect(onJump).toHaveBeenLastCalledWith("toolu_fg")
    // Known to the server by its agent id only: found by what launched it.
    fireEvent.click(within(bg).getAllByRole("button")[0])
    expect(onJump).toHaveBeenLastCalledWith("toolu_bg")

    fireEvent.click(within(deleg).getAllByRole("button")[0])
    expect(mocks.open).toHaveBeenCalledWith({
      kind: "delegation",
      source: delegationSource,
    })
    expect(onJump).toHaveBeenCalledTimes(2)
  })

  it("offers a background task's output and stop on its row", async () => {
    window.localStorage.setItem("codeg:running-overlay-expanded", "1")
    const onStop = vi.fn(() => Promise.resolve(true))
    render(
      wrap(
        <SubAgentOverlay
          background={background()}
          asyncTasks={[shellTask]}
          onStopAsyncTask={onStop}
        />
      )
    )
    const shell = rows()[3]
    fireEvent.click(within(shell).getByRole("button", { name: "Output" }))
    expect(mocks.openFilePreview).toHaveBeenCalledWith("/tmp/sh1.output")
    await act(async () => {
      fireEvent.click(within(shell).getByRole("button", { name: "Stop" }))
    })
    expect(onStop).toHaveBeenCalledWith("sh1")
    // Only the adapter's tasks have these controls.
    expect(within(rows()[0]).queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("says how a finished item ended for a moment, then lets it go", () => {
    vi.useFakeTimers()
    window.localStorage.setItem("codeg:running-overlay-expanded", "1")
    const outcomeOf = (item: BackgroundTaskBrief) =>
      item.id === "toolu_fg" ? ("failed" as const) : ("done" as const)
    const { rerender } = render(
      wrap(<SubAgentOverlay background={background()} outcomeOf={outcomeOf} />)
    )
    rerender(
      wrap(
        <SubAgentOverlay
          background={background(ITEMS.slice(2))}
          outcomeOf={outcomeOf}
        />
      )
    )
    const finished = rows().filter((row) => row.dataset.status !== "running")
    expect(finished.map((row) => row.dataset.status)).toEqual([
      "failed",
      "done",
    ])
    expect(finished[0]).toHaveTextContent("Failed")
    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(rows().map((row) => row.dataset.kind)).toEqual([
      "delegation",
      "shell",
    ])
  })

  it("names the same items and count as the sidebar's indicator", () => {
    window.localStorage.setItem("codeg:running-overlay-expanded", "1")
    const bg = background()
    function SidebarTitle() {
      const title = useBackgroundTitle("working", bg, null)
      return <pre data-testid="sidebar-title">{title}</pre>
    }
    render(
      wrap(
        <>
          <SidebarTitle />
          <SubAgentOverlay background={bg} />
        </>
      )
    )
    const sidebarTitle = screen.getByTestId("sidebar-title").textContent ?? ""
    const [first, ...lines] = sidebarTitle.split("\n")
    expect(first).toBe("Working · 4 running")
    expect(screen.getByTestId("running-overlay").dataset.count).toBe("4")
    expect(lines).toHaveLength(rows().length)
    rows().forEach((row, i) => {
      const [kind, ...label] = lines[i].split(": ")
      expect(row).toHaveTextContent(kind)
      expect(row).toHaveTextContent(label.join(": "))
    })
  })
})
