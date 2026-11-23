import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitLogTab } from "./aux-panel-git-log-tab"
import { AuxPanelShownProvider } from "./aux-panel-watch"
import enMessages from "@/i18n/messages/en.json"
import type { GitLogEntry } from "@/lib/types"

// The Commits tab stays mounted while the aux panel is closed. A reopen must
// not refetch a log nothing has touched, and must refresh one whose refs moved
// while it was hidden (a commit made outside the app sends no git event).

type Envelope = { seq: number; kind: string; changed_paths: string[] }

const state = vi.hoisted(() => ({
  gitLog: vi.fn(async () => ({ entries: [] as GitLogEntry[] })),
  envelopeListeners: new Set<(envelope: Envelope) => void>(),
}))

vi.mock("virtua", () => ({
  Virtualizer: ({
    data,
    children,
  }: {
    data: unknown[]
    children: (item: unknown, index: number) => ReactNode
  }) => <>{data.map((item, index) => children(item, index))}</>,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <>{children}</>
  },
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  gitLog: state.gitLog,
  getGitBranch: async () => "main",
  gitListAllBranches: async () => ({
    local: ["main"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  }),
  gitCurrentUser: async () => null,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1, path: "/repo" } }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openCommitDiff: vi.fn(),
    openFilePreview: vi.fn(),
  }),
}))

const subscribeEnvelopes = (listener: (envelope: Envelope) => void) => {
  state.envelopeListeners.add(listener)
  return () => {
    state.envelopeListeners.delete(listener)
  }
}
vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({ isGitRepo: true, subscribeEnvelopes }),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    pull: vi.fn(),
    fetchAll: vi.fn(),
    openPushWindow: vi.fn(),
    dialogs: null,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    selector: (state: { gitHeads: Map<number, unknown> }) => unknown
  ) => selector({ gitHeads: new Map() }),
}))

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: async () => () => {},
}))

vi.mock("@/components/layout/remote-manage-dialog", () => ({
  RemoteManageDialog: () => null,
}))

const COMMIT: GitLogEntry = {
  hash: "c3c3c3c",
  full_hash: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  author: "Alice",
  date: "2026-09-01T00:00:00Z",
  message: "Add the parser",
  files: [],
  pushed: true,
}

function tree(shown: boolean) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AuxPanelShownProvider shown={shown}>
        <GitLogTab />
      </AuxPanelShownProvider>
    </NextIntlClientProvider>
  )
}

function emit(changed_paths: string[]) {
  act(() => {
    for (const listener of state.envelopeListeners) {
      listener({ seq: 1, kind: "fs_delta", changed_paths })
    }
  })
}

async function openedTab() {
  const view = render(tree(true))
  await screen.findByText("Add the parser")
  await waitFor(() => expect(state.gitLog).toHaveBeenCalledTimes(1))
  return view
}

describe("Commits tab kept mounted behind a closed aux panel", () => {
  beforeEach(() => {
    window.localStorage.clear()
    state.gitLog.mockReset()
    state.gitLog.mockImplementation(async () => ({ entries: [{ ...COMMIT }] }))
    state.envelopeListeners.clear()
  })
  afterEach(() => cleanup())

  it("fetches nothing on reopen when the repository did not change", async () => {
    const view = await openedTab()
    view.rerender(tree(false))
    emit(["src/app.ts"])
    view.rerender(tree(true))
    // Give a refresh every chance to start.
    await act(async () => {})
    expect(state.gitLog).toHaveBeenCalledTimes(1)
  })

  it("refreshes the log once on reopen after its refs moved while hidden", async () => {
    const view = await openedTab()
    view.rerender(tree(false))
    emit([".git/refs/heads/main", ".git/index"])
    emit([".git/HEAD"])
    // Nothing is fetched while it stays hidden.
    await act(async () => {})
    expect(state.gitLog).toHaveBeenCalledTimes(1)

    view.rerender(tree(true))
    await waitFor(() => expect(state.gitLog).toHaveBeenCalledTimes(2))
    // An inline refresh: the rows stay on screen throughout.
    expect(screen.getByText("Add the parser")).toBeInTheDocument()

    // Noted once: the next reopen with nothing new fetches nothing.
    view.rerender(tree(false))
    view.rerender(tree(true))
    await act(async () => {})
    expect(state.gitLog).toHaveBeenCalledTimes(2)
  })

  it("refreshes after a batch too large to list its paths", async () => {
    const view = await openedTab()
    view.rerender(tree(false))
    emit([])
    view.rerender(tree(true))
    await waitFor(() => expect(state.gitLog).toHaveBeenCalledTimes(2))
  })

  it("does not watch while it is shown", async () => {
    await openedTab()
    expect(state.envelopeListeners.size).toBe(0)
  })
})
