import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode, Ref } from "react"

import enMessages from "@/i18n/messages/en.json"
import type { TabItemInternal } from "@/stores/tab-store"
import type { FolderDetail } from "@/lib/types"

// The strip's reorder list is motion's; what it does with a drag is not under
// test here. The list is replaced by a plain element that records the strip's
// own reorder handler, so a reorder can be fed in directly, as motion would.
const h = vi.hoisted(() => ({
  onReorder: null as ((next: unknown[]) => void) | null,
  openConversations: vi.fn(),
}))

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  const { useEffect } = await import("react")
  const KEEP = (key: string) =>
    key === "className" ||
    key === "role" ||
    key === "title" ||
    key === "onClick" ||
    key === "onPointerDownCapture" ||
    key.startsWith("data-") ||
    key.startsWith("aria-")
  const plain = (record: boolean) => {
    function PlainReorder({
      children,
      ref,
      ...rest
    }: Record<string, unknown> & {
      children?: ReactNode
      ref?: Ref<HTMLDivElement>
    }) {
      const onReorder = rest.onReorder as (next: unknown[]) => void
      useEffect(() => {
        if (record) h.onReorder = onReorder
      })
      return (
        <div
          ref={ref}
          {...Object.fromEntries(
            Object.entries(rest).filter(([key]) => KEEP(key))
          )}
        >
          {children}
        </div>
      )
    }
    return PlainReorder
  }
  return {
    ...actual,
    Reorder: { Group: plain(true), Item: plain(false) },
  }
})

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: h.openConversations }),
}))

import { TabBar } from "./tab-bar"
import { useTabStore } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"

function tab(
  id: string,
  folderId: number,
  title: string = id,
  status: TabItemInternal["status"] = "completed"
): TabItemInternal {
  return {
    id,
    kind: "conversation",
    folderId,
    conversationId: Number(id.replace(/\D/g, "")) + folderId * 100,
    agentType: "claude_code",
    title,
    isPinned: true,
    status,
  }
}

function folder(id: number, name: string): FolderDetail {
  return {
    id,
    name,
    alias: null,
    color: "inherit",
    kind: "regular",
    path: `/tmp/${name}`,
  } as unknown as FolderDetail
}

const reorderTabs = vi.fn()
const reorderGroupTabs = vi.fn()

function seed(tabs: TabItemInternal[], activeTabId = tabs[0]?.id ?? null) {
  useTabStore.setState({
    rawTabs: tabs,
    tabs,
    activeTabId,
    reorderTabs,
    reorderGroupTabs,
  })
}

function setView(
  over: Partial<ReturnType<typeof useTabArrangeStore.getState>> = {}
) {
  useTabArrangeStore.setState({
    groupBy: "none",
    sort: "manual",
    groupOrder: { folder: [], status: [] },
    collapsedRuns: new Set(),
    hydrated: true,
    ...over,
  })
}

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TabBar />
    </NextIntlClientProvider>
  )
}

const shownIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-tab-id]")).map((el) =>
    el.getAttribute("data-tab-id")
  )
const labelKeys = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-tab-group-label]")).map((el) =>
    el.getAttribute("data-tab-group-label")
  )

// Manual order interleaves three folders: a = 1, b = 2, c = 3.
const TABS = [
  tab("a1", 1, "zulu"),
  tab("b1", 2, "mike"),
  tab("a2", 1, "alpha"),
  tab("c1", 3, "kilo"),
  tab("b2", 2, "bravo"),
]

beforeEach(() => {
  window.localStorage.clear()
  reorderTabs.mockReset()
  reorderGroupTabs.mockReset()
  h.onReorder = null
  useAppWorkspaceStore.setState({
    allFolders: [
      folder(1, "alpha-repo"),
      folder(2, "beta-repo"),
      folder(3, "gamma-repo"),
    ],
    branches: new Map(),
  })
  seed(TABS)
  setView()
})

afterEach(() => cleanup())

function openMenu() {
  const trigger = document.querySelector("[data-tab-arrange-trigger]")!
  fireEvent.keyDown(trigger, { key: "Enter" })
}

describe("TabBar view menu", () => {
  it("offers grouping and sorting as two separate choices", () => {
    renderBar()
    openMenu()
    expect(screen.getByText("Group by")).toBeTruthy()
    expect(screen.getByText("Sort")).toBeTruthy()
    const groupBys = Array.from(
      document.querySelectorAll("[data-tab-group-by]")
    ).map((el) => el.getAttribute("data-tab-group-by"))
    const sorts = Array.from(document.querySelectorAll("[data-tab-sort]")).map(
      (el) => el.getAttribute("data-tab-sort")
    )
    expect(groupBys).toEqual(["none", "folder", "status"])
    expect(sorts).toEqual(["manual", "status", "recent", "name"])
  })

  it("sets each independently and stays open between picks", () => {
    renderBar()
    openMenu()
    fireEvent.click(document.querySelector('[data-tab-group-by="folder"]')!)
    expect(useTabArrangeStore.getState().groupBy).toBe("folder")
    fireEvent.click(document.querySelector('[data-tab-sort="name"]')!)
    expect(useTabArrangeStore.getState().sort).toBe("name")
    expect(useTabArrangeStore.getState().groupBy).toBe("folder")
  })

  it("disables the status sort while grouped by status", () => {
    setView({ groupBy: "status" })
    renderBar()
    openMenu()
    const status = document.querySelector('[data-tab-sort="status"]')!
    expect(status.hasAttribute("data-disabled")).toBe(true)
    expect(status.textContent).toContain("Already grouped by status")
    // Manual is the sort that applies.
    expect(
      document
        .querySelector('[data-tab-sort="manual"]')!
        .getAttribute("data-state")
    ).toBe("checked")
  })
})

describe("TabBar grouped strip", () => {
  it("groups by folder in the saved group order, unplaced folders after", () => {
    setView({ groupBy: "folder", groupOrder: { folder: [3], status: [] } })
    const { container } = renderBar()
    expect(labelKeys(container)).toEqual(["folder-3", "folder-1", "folder-2"])
    expect(shownIds(container)).toEqual(["c1", "a1", "a2", "b1", "b2"])
  })

  it("sorts inside each group without moving the groups", () => {
    setView({ groupBy: "folder", sort: "name" })
    const { container } = renderBar()
    expect(labelKeys(container)).toEqual(["folder-1", "folder-2", "folder-3"])
    expect(shownIds(container)).toEqual(["a2", "a1", "b2", "b1", "c1"])
  })

  it("keeps a collapsed group's label, and its active tab", () => {
    setView({ groupBy: "folder", collapsedRuns: new Set(["folder-1"]) })
    seed(TABS, "a2")
    const { container } = renderBar()
    expect(labelKeys(container)).toEqual(["folder-1", "folder-2", "folder-3"])
    expect(shownIds(container)).toEqual(["a2", "b1", "b2", "c1"])
  })

  it("makes group labels movable whenever there is more than one group", () => {
    setView({ groupBy: "folder", sort: "recent" })
    const { container } = renderBar()
    const label = container.querySelector('[data-tab-group-label="folder-2"]')!
    expect(label.className).toContain("cursor-grab")
    expect(
      label.querySelector("[data-tab-group-toggle]")!.getAttribute("title")
    ).toContain("Drag to move the group")
  })

  it("explains why tabs don't drag under a non-manual sort", () => {
    setView({ groupBy: "folder", sort: "name" })
    const { container } = renderBar()
    const item = container.querySelector('[data-tab-id="a1"]')!
    expect(item.className).not.toContain("cursor-grab")
    expect(
      item.querySelector("[title]")?.getAttribute("title") ?? ""
    ).toContain("Switch Sort to Manual to drag")
  })
})

describe("TabBar reorder write-back", () => {
  const ids = (list: unknown) =>
    (list as { id: string }[]).map((item) => item.id)
  const byId = (...wanted: string[]) =>
    wanted.map((id) => TABS.find((t) => t.id === id)!)
  function press(container: HTMLElement, tabId: string) {
    fireEvent.pointerDown(container.querySelector(`[data-tab-id="${tabId}"]`)!)
  }

  it("passes an ungrouped manual reorder straight through", () => {
    const { container } = renderBar()
    press(container, "b2")
    act(() => h.onReorder!(byId("b2", "a1", "b1", "a2", "c1")))
    expect(ids(reorderTabs.mock.calls[0][0])).toEqual([
      "b2",
      "a1",
      "b1",
      "a2",
      "c1",
    ])
  })

  it("writes a drag inside a group back among its group-mates only", () => {
    setView({ groupBy: "folder" })
    const { container } = renderBar()
    // Shown: a1 a2 | b1 b2 | c1 — a2 dragged in front of a1.
    press(container, "a2")
    act(() => h.onReorder!(byId("a2", "a1", "b1", "b2", "c1")))
    const written = ids(reorderTabs.mock.calls[0][0])
    expect(written).toEqual(["a2", "a1", "b1", "c1", "b2"])
    // Other groups keep their relative order.
    expect(written.filter((id) => id.startsWith("b"))).toEqual(["b1", "b2"])
  })

  it("turns down a reorder that would move a tab into another group", () => {
    setView({ groupBy: "folder" })
    const { container } = renderBar()
    press(container, "a2")
    act(() => h.onReorder!(byId("a1", "b1", "a2", "b2", "c1")))
    expect(reorderTabs).not.toHaveBeenCalled()
  })

  it("ignores reorders under a non-manual sort", () => {
    setView({ sort: "name" })
    const { container } = renderBar()
    press(container, "a1")
    act(() => h.onReorder!(byId("b1", "a1", "a2", "c1", "b2")))
    expect(reorderTabs).not.toHaveBeenCalled()
  })

  it("drags inside status bands under status grouping", () => {
    seed([
      tab("a1", 1, "one", "in_progress"),
      tab("b1", 2, "two", "completed"),
      tab("a2", 1, "three", "in_progress"),
    ])
    setView({ groupBy: "status", sort: "status" })
    const { container } = renderBar()
    expect(shownIds(container)).toEqual(["a1", "a2", "b1"])
    press(container, "a2")
    const [a1, b1, a2] = useTabStore.getState().tabs
    act(() => h.onReorder!([a2, a1, b1]))
    expect(ids(reorderTabs.mock.calls[0][0])).toEqual(["a2", "a1", "b1"])
  })
})
