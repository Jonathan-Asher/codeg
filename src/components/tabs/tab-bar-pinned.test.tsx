import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
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
  toast: vi.fn(),
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
    key === "onPointerMove" ||
    key === "onPointerUp" ||
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

vi.mock("sonner", () => ({
  toast: Object.assign(h.toast, { error: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "conversation",
    conversationMaximized: false,
  }),
  useWorkspaceActions: () => ({ toggleConversationMaximized: vi.fn() }),
}))
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
  title: string,
  isAnchored = false
): TabItemInternal {
  return {
    id,
    kind: "conversation",
    folderId,
    conversationId: Number(id.replace(/\D/g, "")) + folderId * 100,
    agentType: "claude_code",
    title,
    isPinned: true,
    status: "completed",
    ...(isAnchored ? { isAnchored: true } : {}),
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

// Manual order: a = folder 1, b = folder 2; p = pinned.
const TABS = [
  tab("a1", 1, "zulu"),
  tab("pb1", 2, "yankee", true),
  tab("b2", 2, "mike"),
  tab("pa2", 1, "xray", true),
  tab("a3", 1, "alpha"),
]

const reorderTabs = vi.fn()

function seed(
  tabs: TabItemInternal[],
  activeTabId = tabs[0]?.id ?? null,
  actions: Partial<ReturnType<typeof useTabStore.getState>> = { reorderTabs }
) {
  useTabStore.setState({ rawTabs: tabs, tabs, activeTabId, ...actions })
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

const strip = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll("[data-tab-id], [data-tab-group-label]")
  ).map(
    (el) =>
      el.getAttribute("data-tab-id") ??
      `[${el.getAttribute("data-tab-group-label")}]`
  )
const item = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-tab-id="${id}"]`)!
const ids = (list: unknown) => (list as { id: string }[]).map((t) => t.id)
const byId = (...wanted: string[]) =>
  wanted.map((id) => useTabStore.getState().tabs.find((t) => t.id === id)!)
const press = (container: HTMLElement, id: string) =>
  fireEvent.pointerDown(item(container, id))
const realReorderTabs = useTabStore.getState().reorderTabs

beforeEach(() => {
  window.localStorage.clear()
  reorderTabs.mockReset()
  h.toast.mockReset()
  h.onReorder = null
  useAppWorkspaceStore.setState({
    allFolders: [folder(1, "alpha-repo"), folder(2, "beta-repo")],
    folders: [folder(1, "alpha-repo"), folder(2, "beta-repo")],
    branches: new Map(),
  })
  seed(TABS)
  setView()
})

afterEach(() => cleanup())

describe("pinned tabs on the strip", () => {
  it("lead the strip, ahead of every group, in their manual order", () => {
    setView({ groupBy: "folder", sort: "name" })
    const { container } = renderBar()
    expect(strip(container)).toEqual([
      "pb1",
      "pa2",
      "[folder-1]",
      "a3",
      "a1",
      "[folder-2]",
      "b2",
    ])
  })

  it("look compact: a pin mark, the agent's icon, and no close button", () => {
    const { container } = renderBar()
    const pinned = item(container, "pb1")
    expect(pinned).toHaveAttribute("data-anchored", "true")
    expect(pinned.className).toContain("w-30")
    expect(pinned.querySelector("[data-tab-pin-mark]")).toHaveAttribute(
      "aria-label",
      "Pinned"
    )
    expect(
      pinned.querySelector('[aria-label="Close conversation tab"]')
    ).toBeNull()
    const plain = item(container, "a1")
    expect(plain).not.toHaveAttribute("data-anchored")
    expect(plain.querySelector("[data-tab-pin-mark]")).toBeNull()
  })

  it("still drag under a sort, while the rest don't", () => {
    setView({ sort: "name" })
    const { container } = renderBar()
    expect(item(container, "pb1").className).toContain("cursor-grab")
    expect(item(container, "a1").className).not.toContain("cursor-grab")
  })
})

describe("dragging with pinned tabs", () => {
  it("reorders the pinned tabs among themselves under any sort", () => {
    setView({ groupBy: "folder", sort: "name" })
    const { container } = renderBar()
    // Shown: pb1 pa2 | a3 a1 | b2 — pa2 dragged in front of pb1.
    press(container, "pa2")
    act(() => h.onReorder!(byId("pa2", "pb1", "a3", "a1", "b2")))
    expect(ids(reorderTabs.mock.calls[0][0])).toEqual([
      "a1",
      "pa2",
      "pb1",
      "b2",
      "a3",
    ])
  })

  it("turns down a reorder that would take a tab across the pinned edge", () => {
    const { container } = renderBar()
    // Shown: pb1 pa2 a1 b2 a3 — a1 dragged in front of pa2.
    press(container, "a1")
    act(() => h.onReorder!(byId("pb1", "a1", "pa2", "b2", "a3")))
    press(container, "pa2")
    act(() => h.onReorder!(byId("pb1", "a1", "pa2", "b2", "a3")))
    expect(reorderTabs).not.toHaveBeenCalled()
  })

  it("writes an ungrouped drag among the rest back among the rest only", () => {
    const { container } = renderBar()
    // Shown: pb1 pa2 a1 b2 a3 — a3 dragged in front of a1.
    press(container, "a3")
    act(() => h.onReorder!(byId("pb1", "pa2", "a3", "a1", "b2")))
    expect(ids(reorderTabs.mock.calls[0][0])).toEqual([
      "a3",
      "a1",
      "pb1",
      "b2",
      "pa2",
    ])
  })

  it("still ignores an unpinned tab's reorder under a sort", () => {
    setView({ sort: "name" })
    const { container } = renderBar()
    press(container, "a1")
    act(() => h.onReorder!(byId("pb1", "pa2", "a1", "a3", "b2")))
    expect(reorderTabs).not.toHaveBeenCalled()
  })
})

describe("the tab menu", () => {
  function menuOf(container: HTMLElement, id: string) {
    fireEvent.contextMenu(item(container, id).querySelector('[role="tab"]')!)
  }

  it("pins and unpins", () => {
    seed(TABS, "a1", { reorderTabs: realReorderTabs })
    const { container } = renderBar()
    menuOf(container, "b2")
    fireEvent.click(screen.getByText("Pin tab"))
    expect(strip(container).slice(0, 3)).toEqual(["pb1", "pa2", "b2"])
    expect(item(container, "b2")).toHaveAttribute("data-anchored", "true")

    menuOf(container, "pb1")
    fireEvent.click(screen.getByText("Unpin tab"))
    expect(strip(container).slice(0, 3)).toEqual(["pa2", "b2", "pb1"])
    expect(item(container, "pb1")).not.toHaveAttribute("data-anchored")
  })

  it("closes to the right in shown order, sparing pinned tabs", () => {
    seed(TABS, "a3", { reorderTabs: realReorderTabs })
    setView({ groupBy: "folder" })
    const { container } = renderBar()
    // Shown: pb1 pa2 | a1 a3 | b2
    menuOf(container, "a1")
    fireEvent.click(screen.getByText("Close to the Right"))
    expect(strip(container)).toEqual(["pb1", "pa2", "[folder-1]", "a1"])
    expect(useTabStore.getState().activeTabId).toBe("a1")
  })

  it("offers Close to the Right only when an unpinned tab follows", () => {
    seed([tab("a1", 1, "one"), tab("pa2", 1, "two", true)])
    const { container } = renderBar()
    // Shown: pa2 a1 — nothing after a1.
    menuOf(container, "a1")
    expect(document.querySelector("[data-tab-close-right]")).toHaveAttribute(
      "data-disabled"
    )
  })
})

describe("a sorted strip", () => {
  // jsdom has no PointerEvent, and the plain Event Testing Library falls back
  // to drops the button and position a press carries.
  const hadPointerEvent = "PointerEvent" in window
  beforeAll(() => {
    if (!hadPointerEvent) {
      Object.defineProperty(window, "PointerEvent", {
        value: class extends MouseEvent {},
        configurable: true,
      })
    }
  })
  afterAll(() => {
    if (!hadPointerEvent) Reflect.deleteProperty(window, "PointerEvent")
  })

  it("offers to switch to manual order, keeping what is shown", () => {
    seed(TABS, "a1", { reorderTabs: realReorderTabs })
    setView({ sort: "name" })
    const { container } = renderBar()
    const shown = strip(container)
    expect(shown).toEqual(["pb1", "pa2", "a3", "b2", "a1"])
    fireEvent.contextMenu(item(container, "a1").querySelector('[role="tab"]')!)
    fireEvent.click(screen.getByText("Switch to manual order"))
    expect(useTabArrangeStore.getState().sort).toBe("manual")
    expect(strip(container)).toEqual(shown)
    expect(item(container, "a1").className).toContain("cursor-grab")
  })

  it("has the same choice in the arrange menu, only while sorted", () => {
    setView({ sort: "recent" })
    const { container, unmount } = renderBar()
    fireEvent.keyDown(container.querySelector("[data-tab-arrange-trigger]")!, {
      key: "Enter",
    })
    expect(document.querySelector("[data-tab-keep-order]")).not.toBeNull()
    unmount()

    setView({ sort: "manual" })
    const again = renderBar()
    fireEvent.keyDown(
      again.container.querySelector("[data-tab-arrange-trigger]")!,
      { key: "Enter" }
    )
    expect(document.querySelector("[data-tab-keep-order]")).toBeNull()
  })

  it("says why a tab won't drag when one is pulled sideways", () => {
    setView({ sort: "name" })
    const { container } = renderBar()
    const stripEl = container.querySelector('[role="tablist"]')!
    fireEvent.pointerDown(item(container, "a1"), { button: 0, clientX: 100 })
    fireEvent.pointerMove(stripEl, { buttons: 1, clientX: 104 })
    expect(h.toast).not.toHaveBeenCalled()
    fireEvent.pointerMove(stripEl, { buttons: 1, clientX: 130 })
    expect(h.toast).toHaveBeenCalledTimes(1)
    expect(h.toast.mock.calls[0][0]).toBe("Sorted tabs don't drag")
    expect(h.toast.mock.calls[0][1].action.label).toBe("Switch to manual order")
    // Once per press.
    fireEvent.pointerMove(stripEl, { buttons: 1, clientX: 160 })
    expect(h.toast).toHaveBeenCalledTimes(1)
  })

  it("says nothing for a pinned tab, which does drag", () => {
    setView({ sort: "name" })
    const { container } = renderBar()
    const stripEl = container.querySelector('[role="tablist"]')!
    fireEvent.pointerDown(item(container, "pb1"), { button: 0, clientX: 100 })
    fireEvent.pointerMove(stripEl, { buttons: 1, clientX: 140 })
    expect(h.toast).not.toHaveBeenCalled()
  })
})
