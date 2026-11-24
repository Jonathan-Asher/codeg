"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import type { WorkspaceWatchMode } from "@/hooks/use-workspace-state-store"

/**
 * How long a kept-mounted aux tab keeps its FULL workspace stream (a tree walk
 * and a `git status` on every watched change) once the panel has closed, or
 * once its folder changed while the panel was closed, before it steps down to
 * "paths" (changed paths only, which costs the backend nothing per change).
 * Within it, closing and reopening the panel costs nothing and shows current
 * data at once; past it, a panel left closed costs what an unmounted one did.
 * Stepping down keeps the data last scanned, and the step back up refreshes
 * it, so a reopened panel never shows an empty tree.
 */
export const AUX_CLOSED_FULL_WATCH_MS = 60_000

/**
 * Whether the aux panel is on screen and done sliding open. `true` outside an
 * AuxPanel, so a tab body rendered on its own (a test, a future host) watches
 * the way it always did.
 */
const AuxPanelShownContext = createContext(true)

export function AuxPanelShownProvider({
  shown,
  children,
}: {
  shown: boolean
  children: ReactNode
}) {
  return (
    <AuxPanelShownContext.Provider value={shown}>
      {children}
    </AuxPanelShownContext.Provider>
  )
}

/** See AuxPanelShownContext. */
export function useAuxPanelShown(): boolean {
  return useContext(AuxPanelShownContext)
}

/**
 * The workspace-stream mode for a tab body kept mounted in the aux panel:
 * "full" while the panel is shown, and for AUX_CLOSED_FULL_WATCH_MS after it
 * closes or after `rootPath` changes while it is closed (a folder it has not
 * scanned yet gets its first full snapshot before stepping down); "paths"
 * after that, until the panel is shown again. "Shown" waits for the opening
 * slide to end, so the step back up — and the fresh snapshot it returns —
 * lands after the slide, not in the middle of it.
 */
export function useAuxPanelWatchMode(
  rootPath: string | null
): WorkspaceWatchMode {
  const shown = useAuxPanelShown()
  // Each close starts a new grace window; a step-down belongs to the window
  // and the root it was taken in, so neither a reopen-and-close nor a folder
  // switch inherits an old one.
  const [closedEpoch, setClosedEpoch] = useState(0)
  const [prevShown, setPrevShown] = useState(shown)
  if (prevShown !== shown) {
    setPrevShown(shown)
    if (!shown) setClosedEpoch((epoch) => epoch + 1)
  }
  const [steppedDown, setSteppedDown] = useState<{
    epoch: number
    root: string | null
  } | null>(null)

  useEffect(() => {
    if (shown) return
    const timer = setTimeout(
      () => setSteppedDown({ epoch: closedEpoch, root: rootPath }),
      AUX_CLOSED_FULL_WATCH_MS
    )
    return () => clearTimeout(timer)
  }, [shown, closedEpoch, rootPath])

  const isSteppedDown =
    !shown &&
    steppedDown !== null &&
    steppedDown.epoch === closedEpoch &&
    steppedDown.root === rootPath
  return isSteppedDown ? "paths" : "full"
}
