/**
 * A Pi sub-agent run or background job keeps changing after the turn that
 * started it. The live connection sends its newest card (`tool_card`,
 * `acp::pi_meta`) in the shape the history parser writes, and the cards read
 * it ahead of their own `_meta` — so the card in an earlier turn, or already
 * replaced by the transcript's copy, updates in place, through the same
 * renderer either way.
 */

import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { AgentToolCallPart } from "./agent-tool-call"
import { BackgroundJobChip } from "./background-job-chip"
import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  LiveToolCardsProvider,
  type LiveToolCards,
} from "./live-tool-cards-context"
import { SessionViewerHostContext } from "./session-viewer-host-context"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { parseBackgroundJob, parseSubagentRun } from "@/lib/agent-run-meta"

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

const LAUNCH = "chatcmpl-tool-00f26fec2c6d4169be85630ef46c60ad"

/** The launch as the transcript has it while the run is out: launched, no
 *  outcome recorded (the history card's `pending`). */
const HISTORY_CARD = {
  "codeg.subagentRun": {
    version: 1,
    mode: "workflow",
    async: true,
    status: "pending",
    agent: "workflow",
    children: [],
    notes: [{ kind: "launch", text: "Async workflow [5f686226]" }],
  },
}

/** The same run a few seconds in, as pi-acp reported it. */
const LIVE_CARD = {
  "codeg.subagentRun": {
    version: 1,
    mode: "workflow",
    async: true,
    status: "running",
    agent: "scout",
    children: [
      {
        key: "task-1",
        label: "task-1",
        agent: "scout",
        status: "running",
        sessionId: "child-1",
        activity: { currentTool: "bash", toolCount: 1 },
      },
      { key: "task-2", label: "task-2", agent: "scout", status: "pending" },
    ],
    notes: [{ kind: "launch", text: "Async workflow [5f686226]" }],
  },
}

function launchPart(): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: LAUNCH,
    toolName: "agent",
    input: JSON.stringify({ subagent_type: "workflow", workflow: "parallel" }),
    state: "output-available",
    output: "Running in the background; its result is not in this transcript.",
    meta: HISTORY_CARD,
  }
}

function renderWith(
  ui: ReactNode,
  cards: LiveToolCards | null,
  open = vi.fn()
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionViewerHostContext.Provider value={{ open }}>
        <LiveToolCardsProvider value={cards}>{ui}</LiveToolCardsProvider>
      </SessionViewerHostContext.Provider>
    </NextIntlClientProvider>
  )
}

describe("a live run card", () => {
  it("draws the transcript's card when no live one is known", () => {
    renderWith(
      <AgentToolCallPart part={launchPart()} renderToolCall={() => null} />,
      null
    )
    expect(screen.getByLabelText("Launched · result pending")).toBeInTheDocument()
  })

  it("draws the live card over it: running, one row per child, the current tool", () => {
    renderWith(
      <AgentToolCallPart part={launchPart()} renderToolCall={() => null} />,
      new Map([[LAUNCH, LIVE_CARD]])
    )
    expect(screen.getByLabelText("Running")).toBeInTheDocument()
    const rows = screen.getAllByTestId("subagent-run-child")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("task-1")
    expect(rows[0].textContent).toContain("bash")
    expect(rows[1].textContent).not.toContain("bash")
  })

  it("updates the same card in place as the run moves on", () => {
    const part = launchPart()
    const view = renderWith(
      <AgentToolCallPart part={part} renderToolCall={() => null} />,
      new Map([[LAUNCH, LIVE_CARD]])
    )
    const done = {
      "codeg.subagentRun": {
        ...LIVE_CARD["codeg.subagentRun"],
        status: "completed",
        result: "16 and 9",
        children: LIVE_CARD["codeg.subagentRun"].children.map((row) => ({
          ...row,
          status: "completed",
          activity: undefined,
        })),
      },
    }
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SessionViewerHostContext.Provider value={{ open: vi.fn() }}>
          <LiveToolCardsProvider value={new Map([[LAUNCH, done]])}>
            <AgentToolCallPart part={part} renderToolCall={() => null} />
          </LiveToolCardsProvider>
        </SessionViewerHostContext.Provider>
      </NextIntlClientProvider>
    )
    expect(screen.getByLabelText("Completed")).toBeInTheDocument()
    expect(screen.getAllByTestId("subagent-run-child")).toHaveLength(2)
  })

  it("opens a one-child run's transcript as a Pi session with no transcript agent above it", () => {
    const open = vi.fn()
    renderWith(
      <AgentToolCallPart
        part={{
          ...launchPart(),
          input: JSON.stringify({ subagent_type: "scout", description: "count" }),
          meta: null,
        }}
        renderToolCall={() => null}
      />,
      new Map([
        [
          LAUNCH,
          {
            "codeg.subagentRun": {
              version: 1,
              mode: "single",
              async: true,
              status: "running",
              agent: "scout",
              children: [
                {
                  key: "#0",
                  label: "scout",
                  status: "running",
                  sessionId: "01a1d126-b3e8",
                },
              ],
            },
          },
        ],
      ]),
      open
    )
    fireEvent.click(screen.getByRole("button", { name: /View sub-agent session/ }))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "01a1d126-b3e8",
        agentType: "pi",
        live: true,
      })
    )
  })
})

describe("a live job chip", () => {
  const JOB = "chatcmpl-tool-98a8944ceb08426cb832b7b6c1b6e120"

  function jobPart(): ToolCallPart {
    return {
      type: "tool-call",
      toolCallId: JOB,
      toolName: "bash",
      displayTitle: "bgj_run",
      input: JSON.stringify({ command: "sleep 6; echo bg-done" }),
      state: "output-available",
      output: "Command running in background with ID: jb-1 (pid 58718).",
      meta: {
        "codeg.backgroundJob": { version: 1, id: "jb-1", state: "running" },
      },
    }
  }

  it("says the job is running, then how it ended", () => {
    const view = renderWith(
      <ContentPartsRenderer parts={[jobPart()]} role="assistant" />,
      null
    )
    expect(screen.getByTestId("background-job-chip").textContent).toBe(
      "Running"
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LiveToolCardsProvider
          value={
            new Map([
              [
                JOB,
                {
                  "codeg.backgroundJob": {
                    version: 1,
                    id: "jb-1",
                    state: "completed",
                    exitCode: 0,
                    duration: "6s",
                  },
                },
              ],
            ])
          }
        >
          <ContentPartsRenderer parts={[jobPart()]} role="assistant" />
        </LiveToolCardsProvider>
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("background-job-chip").textContent).toBe(
      "Exit 0 · 6s"
    )
  })

  it("never shows a running job's duration", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BackgroundJobChip
          job={{
            id: "jb-1",
            state: "running",
            exitCode: null,
            killedBy: null,
            duration: "2s",
            tail: null,
            notice: null,
          }}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("background-job-chip").textContent).toBe(
      "Running"
    )
  })
})

describe("live-only fields", () => {
  it("reads a child's current tool and a running job", () => {
    const run = parseSubagentRun(LIVE_CARD)
    expect(run?.children[0].currentTool).toBe("bash")
    expect(run?.children[1].currentTool).toBeNull()
    expect(
      parseBackgroundJob({
        "codeg.backgroundJob": { state: "running", id: "jb-1" },
      })?.state
    ).toBe("running")
  })
})
