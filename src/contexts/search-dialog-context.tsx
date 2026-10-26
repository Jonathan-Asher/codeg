"use client"

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

interface SearchDialogContextValue {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
}

const SearchDialogOpenContext = createContext<boolean | null>(null)
const SearchDialogSetterContext = createContext<Dispatch<
  SetStateAction<boolean>
> | null>(null)

/**
 * Shared open-state for the conversation search command dialog.
 *
 * The dialog itself, and the global ⌘K shortcut that toggles it, are owned by
 * `WorkspaceChromeController` (which is always mounted, desktop + mobile). The
 * trigger buttons live elsewhere: `LeftEdgeChrome` on desktop, `FolderTitleBar`
 * on mobile. Lifting just the boolean here lets any of them open the dialog
 * without owning it — including surfaces that unmount, which is why the trigger
 * was moved out of the sidebar in the first place.
 *
 * `setOpen` is the raw state setter so callers can use the functional updater
 * form (the shortcut handler does `setOpen((prev) => !prev)`).
 *
 * The boolean and the setter travel in separate contexts: opening the dialog
 * is the session switcher's hot path, and a trigger that only ever calls
 * `setOpen` (`useSearchDialogSetter`) must not re-render when it flips.
 */
export function useSearchDialog(): SearchDialogContextValue {
  const open = useContext(SearchDialogOpenContext)
  const setOpen = useContext(SearchDialogSetterContext)
  if (open === null || !setOpen) {
    throw new Error("useSearchDialog must be used within SearchDialogProvider")
  }
  return useMemo(() => ({ open, setOpen }), [open, setOpen])
}

/** Just the setter: never re-renders when the dialog opens or closes. */
export function useSearchDialogSetter(): Dispatch<SetStateAction<boolean>> {
  const setOpen = useContext(SearchDialogSetterContext)
  if (!setOpen) {
    throw new Error(
      "useSearchDialogSetter must be used within SearchDialogProvider"
    )
  }
  return setOpen
}

export function SearchDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <SearchDialogSetterContext.Provider value={setOpen}>
      <SearchDialogOpenContext.Provider value={open}>
        {children}
      </SearchDialogOpenContext.Provider>
    </SearchDialogSetterContext.Provider>
  )
}
