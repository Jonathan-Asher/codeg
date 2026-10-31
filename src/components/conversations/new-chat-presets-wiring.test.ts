import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * A brand-new chat can be set up — agent, mode, model, effort — and its first
 * message sent while its session is still on its way. The behaviour lives in
 * shared pieces with their own tests (`useConnectionLifecycle`'s
 * `newSession`, `newChatComposerStatus`, the message queue, the connection
 * store's switch handling); these pin the wiring in the two new-chat
 * surfaces, which only mount under the whole workspace (or canvas) stack.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const PANEL = "src/components/conversations/conversation-detail-panel.tsx"
const CANVAS = "src/components/canvas/canvas-conversation-surface.tsx"

/** Every `<AgentSelector ... />` element of `source`. */
function agentSelectors(source: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf("<AgentSelector", from)
    if (start < 0) return out
    const end = source.indexOf("/>", start)
    out.push(source.slice(start, end))
    from = end
  }
}

/** The welcome page's composer: the `<ChatInput` inside the welcome branch. */
function welcomeComposer(panel: string): string {
  const branch = panel.indexOf("{isWelcomeMode ? (")
  const start = panel.indexOf("<ChatInput", branch)
  expect(branch).toBeGreaterThan(-1)
  expect(start).toBeGreaterThan(branch)
  return panel.slice(start, panel.indexOf("/>", start))
}

describe("the workspace tab's new chat", () => {
  const panel = read(PANEL)

  it("lets the agent be switched whatever the connection is doing, until the conversation exists", () => {
    const selectors = agentSelectors(panel)
    expect(selectors).toHaveLength(2)
    for (const selector of selectors) {
      expect(selector).toContain("disabled={dbConversationId != null}")
      expect(selector).not.toMatch(/connecting/i)
    }
  })

  it("runs its connection as a new session", () => {
    expect(panel).toContain("newSession: dbConversationId == null")
  })

  it("queues a send while the session is on its way, and says so", () => {
    const composer = welcomeComposer(panel)
    expect(composer).toContain("status={newChatComposerConnStatus}")
    expect(composer).toContain("onEnqueue={handleNewChatEnqueue}")
    expect(composer).toContain("queue={msgQueue}")
    expect(composer).toContain("queueNotice={queueNotice}")
    expect(composer).toContain(
      "selectorsAwaitConnection={selectorsAwaitConnection}"
    )
    expect(panel).toContain("newChat: !hasPersistedConversation")
  })

  it("sends the queued first message only once the picks made before have reached the session", () => {
    const flush = panel.slice(
      panel.indexOf("Flush queued messages whenever the agent is idle"),
      panel.indexOf("Mirror the connection's liveMessage into the runtime")
    )
    expect(flush).toContain("if (!connectionReady) return")
    expect(flush).toContain("if (presetsPending) return")
  })
})

describe("the canvas draft card", () => {
  const canvas = read(CANVAS)

  it("lets the agent be switched whatever the connection is doing", () => {
    const selectors = agentSelectors(canvas)
    expect(selectors).toHaveLength(1)
    expect(selectors[0]).not.toContain("disabled=")
  })

  it("runs its connection as a new session and queues a first message sent before it is ready", () => {
    expect(canvas).toContain("newSession: dbConversationId == null")
    expect(canvas).toContain(
      "onEnqueue={isDraft ? handleDraftEnqueue : mqEnqueue}"
    )
    expect(canvas).toContain("status={composerStatus}")
    expect(canvas).toContain(": draftSessionReady && !creating")
  })
})
