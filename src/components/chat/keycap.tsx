import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A small key hint ("1", "↵", "⌘↵") inside an option or button, like a command
 * palette's. Decorative: hidden from assistive tech (the control's name and
 * `aria-keyshortcuts` carry the meaning) and from touch screens, where there
 * is no keyboard to press it on.
 */
export function Keycap({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 shrink-0 select-none items-center justify-center rounded border border-current/25 px-1 font-sans text-3xs leading-none font-medium opacity-60 pointer-coarse:hidden",
        className
      )}
    >
      {children}
    </kbd>
  )
}
