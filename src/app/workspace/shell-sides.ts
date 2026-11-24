// The px widths of the workspace shell's side columns (sidebar, aux panel), for
// FolderWorkspaceShell. Kept out of the layout module so they can be tested.

/** The narrowest the centre column is squeezed to before the sides shrink. */
export const MIN_CENTER_WIDTH_PX = 420

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export interface ShellSidesInput {
  sidebarOpen: boolean
  sidebarWidth: number
  sidebarMinWidth: number
  sidebarMaxWidth: number
  auxOpen: boolean
  auxWidth: number
  auxMinWidth: number
  auxMaxWidth: number
  /** The shell container's width (0 before it is first measured). */
  shellWidth: number
}

export interface ShellSides {
  left: number
  right: number
  totalWidth: number
}

/**
 * The width the panels share. They split the width LEFT OVER by the dividers,
 * not the container's: an open divider is a fixed 1px flex item (a closed one
 * is `w-0`), and the panels' percentages are shares of the remainder.
 * Converting px <-> percent against the full container width left the side
 * columns up to a pixel off their requested width, by an amount that changes
 * with every window width — the divider crept sub-pixel on each resize step.
 */
export function shellPanelsWidthFor(
  shellWidth: number,
  sidebarOpen: boolean,
  auxOpen: boolean
): number {
  const handlesWidth = (sidebarOpen ? 1 : 0) + (auxOpen ? 1 : 0)
  return shellWidth > 0 ? Math.max(1, shellWidth - handlesWidth) : 0
}

/**
 * The side columns' widths in px: the requested widths, scaled down together
 * when the window is too narrow to also leave MIN_CENTER_WIDTH_PX between —
 * but never below a column's own minimum. These px are what is drawn, and the
 * library clamps its own layout to the panels' minSize, so they have to land
 * where that clamp would: below it, a column renders narrower than its content
 * allows (the aux minimum on Windows/Linux is what keeps the title-bar overlay
 * off the center column), and the library's layout — the base a handle drag
 * starts from — sits tens of px away from the divider on screen.
 */
export function resolveShellSides({
  sidebarOpen,
  sidebarWidth,
  sidebarMinWidth,
  sidebarMaxWidth,
  auxOpen,
  auxWidth,
  auxMinWidth,
  auxMaxWidth,
  shellWidth,
}: ShellSidesInput): ShellSides {
  const shellPanelsWidth = shellPanelsWidthFor(shellWidth, sidebarOpen, auxOpen)
  const requestedLeft = sidebarOpen
    ? clamp(sidebarWidth, sidebarMinWidth, sidebarMaxWidth)
    : 0
  const requestedRight = auxOpen ? clamp(auxWidth, auxMinWidth, auxMaxWidth) : 0

  const totalWidth =
    shellPanelsWidth > 0
      ? shellPanelsWidth
      : requestedLeft + requestedRight + 960

  let left = requestedLeft
  let right = requestedRight

  const maxSideTotal = Math.max(0, totalWidth - MIN_CENTER_WIDTH_PX)
  const sideTotal = left + right
  if (sideTotal > maxSideTotal && sideTotal > 0) {
    const scale = maxSideTotal / sideTotal
    left *= scale
    right *= scale

    // Back up to each open column's minimum the way the library's clamp
    // does it (validatePanelGroupLayout): a panel raised to its minSize
    // takes the shortfall from the first panel in order that can spare it —
    // the sidebar, down to its own minimum, and then the center.
    let shortfall = 0
    if (sidebarOpen && left < sidebarMinWidth) {
      shortfall += sidebarMinWidth - left
      left = sidebarMinWidth
    }
    if (auxOpen && right < auxMinWidth) {
      shortfall += auxMinWidth - right
      right = auxMinWidth
    }
    if (sidebarOpen && shortfall > 0) {
      left -= Math.min(shortfall, left - sidebarMinWidth)
    }
  }

  return { left, right, totalWidth }
}

/**
 * The width the aux column's content is laid out at: the column's own width
 * while it is open, and — while it is closed and its content is kept mounted
 * and hidden — the width it would open at now, so opening it lays nothing out.
 */
export function auxContentWidthFor(input: ShellSidesInput): number {
  return resolveShellSides({ ...input, auxOpen: true }).right
}
