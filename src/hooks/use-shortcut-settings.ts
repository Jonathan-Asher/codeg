"use client"

import { useCallback, useEffect, useState } from "react"
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_STORAGE_KEY,
  SHORTCUTS_UPDATED_EVENT,
  type ShortcutActionId,
  type ShortcutSettings,
  normalizeShortcut,
  readShortcutSettings,
  withShortcutTakenOver,
  writeShortcutSettings,
} from "@/lib/keyboard-shortcuts"

interface UseShortcutSettingsResult {
  shortcuts: ShortcutSettings
  updateShortcut: (actionId: ShortcutActionId, shortcut: string) => boolean
  /**
   * Bind `shortcut` to `actionId` and unassign `from`, the actions it takes
   * the chord from, in one write.
   */
  takeOverShortcut: (
    actionId: ShortcutActionId,
    shortcut: string,
    from: readonly ShortcutActionId[]
  ) => boolean
  resetShortcuts: () => void
}

export function useShortcutSettings(): UseShortcutSettingsResult {
  const [shortcuts, setShortcuts] =
    useState<ShortcutSettings>(DEFAULT_SHORTCUTS)

  useEffect(() => {
    const syncFromStorage = () => {
      setShortcuts(readShortcutSettings())
    }

    syncFromStorage()

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== SHORTCUTS_STORAGE_KEY) return
      syncFromStorage()
    }

    window.addEventListener("storage", onStorage)
    window.addEventListener(SHORTCUTS_UPDATED_EVENT, syncFromStorage)

    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(SHORTCUTS_UPDATED_EVENT, syncFromStorage)
    }
  }, [])

  const updateShortcut = useCallback(
    (actionId: ShortcutActionId, shortcut: string): boolean => {
      const normalized = normalizeShortcut(shortcut)
      if (!normalized) return false

      setShortcuts((previous) => {
        const next = {
          ...previous,
          [actionId]: normalized,
        }
        writeShortcutSettings(next)
        return next
      })

      return true
    },
    []
  )

  const takeOverShortcut = useCallback(
    (
      actionId: ShortcutActionId,
      shortcut: string,
      from: readonly ShortcutActionId[]
    ): boolean => {
      const normalized = normalizeShortcut(shortcut)
      if (!normalized) return false

      setShortcuts((previous) => {
        const next = withShortcutTakenOver(previous, actionId, normalized, from)
        writeShortcutSettings(next)
        return next
      })

      return true
    },
    []
  )

  const resetShortcuts = useCallback(() => {
    setShortcuts({ ...DEFAULT_SHORTCUTS })
    writeShortcutSettings(DEFAULT_SHORTCUTS)
  }, [])

  return {
    shortcuts,
    updateShortcut,
    takeOverShortcut,
    resetShortcuts,
  }
}
