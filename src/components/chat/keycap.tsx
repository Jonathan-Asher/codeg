import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A small key hint ("1", "↵", "⌘↵") inside an option or button, like a command
 * palette's. Decorative: hidden from assistive tech (the control's name and
 * `aria-keyshortcuts` carry the meaning) and from touch screens, where there
 * is no keyboard to press it on.
 *
 * Sized in `em` of its own text (16px around 10px at 100%), so the key grows
 * with the chat text size of the card it sits in instead of the digit
 * outgrowing a fixed box.
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
        "pointer-events-none inline-flex h-[1.6em] min-w-[1.6em] shrink-0 select-none items-center justify-center rounded border border-current/25 px-1 font-sans text-3xs leading-none font-medium opacity-60 pointer-coarse:hidden",
        className
      )}
    >
      {children}
    </kbd>
  )
}
