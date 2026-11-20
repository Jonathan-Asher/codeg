import { act, cleanup, render, screen } from "@testing-library/react"
import { Reorder } from "motion/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import type { AttentionKind, DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  __resetConversationAttentionForTests,
  useConversationAttentionStore,
} from "@/stores/conversation-attention-store"
import { TabGroupLabel } from "./tab-group-label"
import { TabItem } from "./tab-item"

function row(): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:30:00.000Z",
    pinned_at: null,
  }
}

const noop = () => {}

const conversationTab = {
  id: "t7",
  kind: "conversation",
  folderId: 3,
  conversationId: 7,
  agentType: "claude_code",
  title: "Deploy fix",
  status: "in_progress",
  isPinned: true,
} as TabItemData

function renderTab(tab: TabItemData = conversationTab) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Reorder.Group axis="x" values={[tab.id]} onReorder={noop} as="div">
        <TabItem
          tab={tab}
          isActive={false}
          isTileMode={false}
          folderName="proj"
          folderBranch={null}
          isSplit={false}
          canSplitMove={false}
          canMoveToGroup
          moveTargets={[]}
          onSwitch={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseAll={noop}
          onPin={noop}
          onToggleTile={noop}
          onSplit={noop}
          onMoveToGroup={noop}
          onToggleSplitOrientation={noop}
          onUnsplit={noop}
          onUnsplitAll={noop}
          isCoarsePointer={false}
          isTouchSorting={false}
          onTouchSortingStart={noop}
          onTouchSortingEnd={noop}
        />
      </Reorder.Group>
    </NextIntlClientProvider>
  )
}

function waitOn(kind: AttentionKind | null, id = 7) {
  act(() => {
    useConversationAttentionStore.setState({
      byConversationId: new Map(kind ? [[id, kind]] : []),
    })
  })
}

/** The review-status dot: yellow while in progress. */
function statusDot(container: HTMLElement) {
  return container.querySelector(".bg-yellow-400")
}

beforeEach(() => {
  useAppWorkspaceStore.setState({ conversations: [row()] })
})

afterEach(() => {
  cleanup()
  __resetConversationAttentionForTests()
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("TabItem waiting-on-you mark", () => {
  it("shows the yellow running dot while nothing waits", () => {
    const { container } = renderTab()
    expect(statusDot(container)).not.toBeNull()
    expect(screen.queryByTestId("tab-attention-badge")).toBeNull()
  })

  it("outranks the running dot with what the session waits for", () => {
    const { container } = renderTab()
    waitOn("question")
    const badge = screen.getByTestId("tab-attention-badge")
    expect(badge).toHaveAttribute("data-attention", "question")
    expect(badge).toHaveAttribute("title", "Waiting for your answer")
    expect(statusDot(container)).toBeNull()
  })

  it("clears the moment it is answered", () => {
    const { container } = renderTab()
    waitOn("permission")
    expect(screen.getByTestId("tab-attention-badge")).toHaveAttribute(
      "title",
      "Waiting for your permission"
    )
    waitOn(null)
    expect(screen.queryByTestId("tab-attention-badge")).toBeNull()
    expect(statusDot(container)).not.toBeNull()
  })

  it("gives each kind its own icon colour", () => {
    renderTab()
    const colours = (["permission", "question", "plan_approval"] as const).map(
      (kind) => {
        waitOn(kind)
        const svg = screen
          .getByTestId("tab-attention-badge")
          .querySelector("svg") as SVGElement
        const colour = svg
          .getAttribute("class")!
          .split(" ")
          .find((c) => c.startsWith("text-"))
        // Never the amber of "running".
        expect(colour).not.toMatch(/amber|yellow/)
        return colour
      }
    )
    expect(new Set(colours).size).toBe(3)
  })

  it("ignores another session's wait, and a draft tab has none", () => {
    renderTab({ ...conversationTab, id: "draft", conversationId: null })
    waitOn("question", 7)
    expect(screen.queryByTestId("tab-attention-badge")).toBeNull()
    cleanup()
    renderTab()
    waitOn("question", 8)
    expect(screen.queryByTestId("tab-attention-badge")).toBeNull()
  })
})

describe("TabGroupLabel waiting count", () => {
  function renderLabel(attentionCount: number, collapsed = true) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TabGroupLabel
          runKey="folder:3"
          label="proj"
          count={4}
          attentionCount={attentionCount}
          collapsed={collapsed}
          accentStyle={undefined}
          movable={false}
          dropBefore={false}
          dragging={false}
          isCoarsePointer={false}
          onToggle={noop}
          onGroupDrag={noop}
          onGroupDragEnd={noop}
        />
      </NextIntlClientProvider>
    )
  }

  it("says how many of a folded group's tabs wait on you", () => {
    renderLabel(2)
    const chip = screen.getByTestId("attention-count-badge")
    expect(chip).toHaveAttribute("title", "2 sessions waiting for you")
    expect(chip.textContent).toContain("2")
  })

  it("shows nothing when none wait", () => {
    renderLabel(0)
    expect(screen.queryByTestId("attention-count-badge")).toBeNull()
  })
})
