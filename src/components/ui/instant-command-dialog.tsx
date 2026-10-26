"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Command as CommandPrimitive } from "cmdk"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  COMMAND_DIALOG_COMMAND_CLASS,
  COMMAND_DIALOG_CONTENT_CLASS,
} from "@/components/ui/command"
import { useNativeSurfaceOcclusion } from "@/lib/browser/native-surface-occlusion"
import { cn } from "@/lib/utils"

/** `DialogContent`'s box without its open/close animation. */
const PANEL_CLASS = cn(
  "bg-background ring-border pointer-events-auto relative grid max-h-[calc(100dvh-2rem)] w-full max-w-md gap-6 overflow-y-auto rounded-4xl p-6 shadow-2xl ring-1 outline-none",
  COMMAND_DIALOG_CONTENT_CLASS
)

const OVERLAY_CLASS =
  "bg-black/80 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50"

const CLOSE_BUTTON_CLASS =
  "absolute top-1.5 right-4 z-10 hover:text-destructive focus-visible:text-destructive"

const COMMAND_CLASS = cn(
  "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
  COMMAND_DIALOG_COMMAND_CLASS
)

/** Another layer that holds focus captive (a modal dialog, an open menu). */
const FOREIGN_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"]'

const TABBABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export interface InstantCommandDialogProps extends Omit<
  React.ComponentProps<typeof CommandPrimitive>,
  "title"
> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Read to assistive tech; not shown. */
  title: string
  /** Takes focus the moment the dialog opens. */
  initialFocusRef: React.RefObject<HTMLElement | null>
  /** Runs when the dialog has opened with focus in place, before paint. */
  onOpened?: () => void
  closeLabel?: string
}

/**
 * A command palette that is always mounted and only shown or hidden.
 *
 * `CommandDialog` mounts a Radix modal on every open: the portal, the focus
 * scope, the scroll lock (a style sheet and a measurement on the body), the
 * outside-pointer block (`pointer-events: none` on the body) and `aria-hidden`
 * on every other branch of the page — each of which restyles the whole
 * document — then cmdk registers every row and settles its selection, and an
 * entry animation plays on top. Measured in WebKit, a ⌘K took ~200 ms to show
 * anything, so an Enter typed right after it raced the dialog.
 *
 * Here the content stays rendered (hidden) between uses, so opening is one
 * attribute flip plus a focus: no mount, no page-wide mutation, no animation.
 * What the modal did is kept in a lighter form: the overlay takes every
 * pointer event outside the panel (a click on it closes), focus is held inside
 * (Tab wraps; focus pulled elsewhere comes back), Escape closes, focus returns
 * on close, and native browser surfaces are occluded while it shows.
 */
export function InstantCommandDialog({
  open,
  onOpenChange,
  title,
  initialFocusRef,
  onOpened,
  closeLabel = "Close",
  className,
  children,
  ...commandProps
}: InstantCommandDialogProps) {
  const titleId = React.useId()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)
  const wasOpenRef = React.useRef(false)
  const [container, setContainer] = React.useState<HTMLElement | null>(null)

  // Its own host at the end of <body>, created once on the client (the page
  // is prerendered without a document).
  React.useEffect(() => {
    const host = document.createElement("div")
    host.setAttribute("data-instant-command-dialog", "")
    document.body.appendChild(host)
    setContainer(host)
    return () => {
      host.remove()
    }
  }, [])

  useNativeSurfaceOcclusion("dialog", open)

  const onOpenedRef = React.useRef(onOpened)
  React.useLayoutEffect(() => {
    onOpenedRef.current = onOpened
  })

  // Focus moves in the same commit as the open, so the very next key typed
  // already lands in the dialog.
  React.useLayoutEffect(() => {
    // Nothing is rendered before the host exists; an open requested before
    // then is handled once it does.
    if (!container) return
    const panel = panelRef.current
    const wasOpen = wasOpenRef.current
    // Before focus moves below: the focus guard reads it.
    wasOpenRef.current = open
    if (open && !wasOpen) {
      // Stack above any layer opened since this host was created.
      if (container !== document.body.lastElementChild) {
        document.body.appendChild(container)
      }
      const active = document.activeElement
      restoreRef.current =
        active instanceof HTMLElement &&
        active !== document.body &&
        !panel?.contains(active)
          ? active
          : null
      initialFocusRef.current?.focus({ preventScroll: true })
      onOpenedRef.current?.()
    } else if (!open && wasOpen) {
      // Focus still inside goes back where it was. A pick that sends the user
      // elsewhere moves focus on itself, before it closes the dialog.
      const restore = restoreRef.current
      restoreRef.current = null
      const active = document.activeElement
      if (panel && active instanceof HTMLElement && panel.contains(active)) {
        if (restore?.isConnected) restore.focus({ preventScroll: true })
        else active.blur()
      }
    }
  }, [open, container, initialFocusRef])

  // Escape closes, as a Radix dialog's does: on the document, in the capture
  // phase, claimed with preventDefault so later listeners (read-aloud's stop)
  // know it was taken.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return
      if (event.defaultPrevented) return
      event.preventDefault()
      onOpenChange(false)
    }
    // Focus pulled out of the dialog while it shows (a composer refocusing
    // after a turn) comes back. A layer opening on top takes over instead:
    // the dialog closes rather than fight it for focus.
    const onFocusIn = (event: FocusEvent) => {
      // Closing: focus is being handed back on purpose.
      if (!wasOpenRef.current) return
      const panel = panelRef.current
      const target = event.target
      if (!panel || !(target instanceof Node) || panel.contains(target)) return
      if (target instanceof Element && target.closest(FOREIGN_LAYER_SELECTOR)) {
        onOpenChange(false)
        return
      }
      initialFocusRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("focusin", onFocusIn)
    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("focusin", onFocusIn)
    }
  }, [open, onOpenChange, initialFocusRef])

  const trapTab = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    const panel = panelRef.current
    if (!panel) return
    const tabbables = Array.from(
      panel.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)
    ).filter((el) => el.getClientRects().length > 0)
    if (tabbables.length === 0) {
      event.preventDefault()
      return
    }
    const first = tabbables[0]
    const last = tabbables[tabbables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (
      !event.shiftKey &&
      (active === last || !panel.contains(active))
    ) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  if (!container) return null

  return createPortal(
    <div hidden={!open} data-slot="instant-command-dialog">
      <div
        aria-hidden
        data-slot="instant-command-dialog-overlay"
        className={OVERLAY_CLASS}
        // A click outside closes, and only a whole click: closing on press
        // would hand the release to whatever sits under the overlay.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpenChange(false)}
      />
      <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-state={open ? "open" : "closed"}
          data-slot="instant-command-dialog-content"
          tabIndex={-1}
          className={PANEL_CLASS}
          onKeyDown={trapTab}
        >
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
          <CommandPrimitive
            data-slot="command"
            className={cn(COMMAND_CLASS, className)}
            {...commandProps}
          >
            {children}
          </CommandPrimitive>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={CLOSE_BUTTON_CLASS}
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
            <span className="sr-only">{closeLabel}</span>
          </Button>
        </div>
      </div>
    </div>,
    container
  )
}
