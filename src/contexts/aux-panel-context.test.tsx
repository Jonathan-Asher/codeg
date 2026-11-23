import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolderId: 1 }),
}))

import {
  AuxPanelProvider,
  useAuxPanelActions,
  useAuxPanelContext,
  useAuxPanelPendingReveal,
  type AuxPanelActions,
} from "./aux-panel-context"

const seen = {
  actionRenders: 0,
  revealRenders: 0,
  actions: null as AuxPanelActions | null,
  isOpen: null as boolean | null,
  activeTab: null as string | null,
  reveal: undefined as string | null | undefined,
}

// Each reader reports what it rendered with, once per render.
function ActionsReader({
  report,
}: {
  report: (actions: AuxPanelActions) => void
}) {
  report(useAuxPanelActions())
  return null
}

function RevealReader({ report }: { report: (path: string | null) => void }) {
  report(useAuxPanelPendingReveal())
  return null
}

function StateReader({
  report,
}: {
  report: (isOpen: boolean, activeTab: string) => void
}) {
  const { isOpen, activeTab } = useAuxPanelContext()
  report(isOpen, activeTab)
  return null
}

const onActions = (actions: AuxPanelActions) => {
  seen.actionRenders += 1
  seen.actions = actions
}
const onReveal = (path: string | null) => {
  seen.revealRenders += 1
  seen.reveal = path
}
const onState = (isOpen: boolean, activeTab: string) => {
  seen.isOpen = isOpen
  seen.activeTab = activeTab
}

function renderProvider() {
  return render(
    <AuxPanelProvider>
      <ActionsReader report={onActions} />
      <RevealReader report={onReveal} />
      <StateReader report={onState} />
    </AuxPanelProvider>
  )
}

describe("AuxPanelProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    Object.assign(seen, {
      actionRenders: 0,
      revealRenders: 0,
      actions: null,
      isOpen: null,
      activeTab: null,
      reveal: undefined,
    })
  })

  it("keeps readers of the actions alone out of a toggle's render", () => {
    renderProvider()
    const actions = seen.actions
    const actionRenders = seen.actionRenders
    const revealRenders = seen.revealRenders
    const wasOpen = seen.isOpen

    act(() => actions?.toggle())
    expect(seen.isOpen).toBe(!wasOpen)
    act(() => actions?.setWidth(420))
    act(() => actions?.toggle())
    expect(seen.isOpen).toBe(wasOpen)

    expect(seen.actionRenders).toBe(actionRenders)
    expect(seen.revealRenders).toBe(revealRenders)
    expect(seen.actions).toBe(actions)
  })

  it("hands the file tree its reveal request through its own context", () => {
    renderProvider()
    expect(seen.reveal).toBeNull()

    act(() => seen.actions?.revealInFileTree("src/app/page.tsx"))
    expect(seen.reveal).toBe("src/app/page.tsx")
    expect(seen.isOpen).toBe(true)
    expect(seen.activeTab).toBe("file_tree")

    act(() => seen.actions?.consumePendingRevealPath())
    expect(seen.reveal).toBeNull()
  })

  it("refuses the actions outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<ActionsReader report={onActions} />)).toThrow(
      /AuxPanelProvider/
    )
    spy.mockRestore()
  })
})
