"use client"

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { Search, X } from "lucide-react"
import { useMessages, useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePlatform } from "@/hooks/use-platform"
import type {
  SettingsPageKey,
  SettingsSearchEntry,
} from "@/lib/settings-search/registry"
import {
  buildSettingsSearchIndex,
  searchSettings,
  type SettingsSearchDoc,
} from "@/lib/settings-search/search"
import { cn } from "@/lib/utils"

interface SettingsSearchProps {
  /** The pages the nav shows in this runtime. */
  pages: readonly SettingsPageKey[]
  desktop: boolean
  inputRef: RefObject<HTMLInputElement | null>
  /** The key that focuses the box, already formatted (⌘F); none hides it. */
  shortcutLabel?: string
  onPick: (entry: SettingsSearchEntry) => void
  /** The nav, shown while nothing is typed. */
  children: ReactNode
}

/** "Appearance › Fonts": where a result lives. A page names what it is for. */
function locationOf(doc: SettingsSearchDoc): string {
  if (doc.entry.kind === "page") return doc.description
  return doc.sectionTitle
    ? `${doc.pageLabel} › ${doc.sectionTitle}`
    : doc.pageLabel
}

/**
 * The search box at the top of the Settings nav. Typing swaps the nav for the
 * settings that match, across every page, mounted or not: the index is the
 * registry (`settings-search/registry`) in the user's language. Arrow keys
 * move through the results, Enter opens one, Esc clears the box.
 */
export function SettingsSearch({
  pages,
  desktop,
  inputRef,
  shortcutLabel,
  onPick,
  children,
}: SettingsSearchProps) {
  const t = useTranslations("SettingsShell.search")
  const messages = useMessages()
  const { platform } = usePlatform()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const listId = useId()

  const pagesKey = pages.join(",")
  const index = useMemo(
    () =>
      buildSettingsSearchIndex(messages as Record<string, unknown>, {
        pages: new Set(pagesKey.split(",") as SettingsPageKey[]),
        desktop,
        platform,
      }),
    [messages, pagesKey, desktop, platform]
  )
  const searching = query.trim().length > 0
  const results = useMemo(
    () => (searching ? searchSettings(index, query) : []),
    [index, query, searching]
  )
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0))
  const optionId = (at: number) => `${listId}-option-${at}`

  useEffect(() => {
    if (!searching || results.length === 0) return
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView?.({ block: "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is derived from listId
  }, [activeIndex, searching, results.length, listId])

  const pick = (doc: SettingsSearchDoc | undefined) => {
    if (doc) onPick(doc.entry)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      if (!query) {
        event.currentTarget.blur()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setQuery("")
      setActive(0)
      return
    }
    if (!searching || results.length === 0) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((activeIndex + step + results.length) % results.length)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      pick(results[activeIndex])
    }
  }

  return (
    <>
      <div className="px-1 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label={t("label")}
            aria-expanded={searching}
            aria-controls={searching ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              searching && results.length > 0
                ? optionId(activeIndex)
                : undefined
            }
            placeholder={t("placeholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            className="h-8 ps-7 pe-10 text-xs [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button
              type="button"
              aria-label={t("clear")}
              className="absolute end-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("")
                setActive(0)
                inputRef.current?.focus()
              }}
            >
              <X className="size-3.5" />
            </button>
          ) : shortcutLabel ? (
            <kbd className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 font-sans text-2xs text-muted-foreground/80">
              {shortcutLabel}
            </kbd>
          ) : null}
        </div>
      </div>
      {searching ? (
        <ScrollArea className="min-h-0 flex-1">
          {results.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("noResults", { query: query.trim() })}
            </p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label={t("resultsLabel")}
              className="space-y-0.5"
            >
              {results.map((doc, at) => {
                const selected = at === activeIndex
                const where = locationOf(doc)
                return (
                  <li
                    key={doc.entry.id}
                    id={optionId(at)}
                    role="option"
                    aria-selected={selected}
                    data-settings-result={doc.entry.id}
                    // Keep the caret in the box: a click picks, focus stays.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!selected) setActive(at)
                    }}
                    onClick={() => pick(doc)}
                    className={cn(
                      "cursor-pointer rounded-md px-2 py-1.5",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    )}
                  >
                    <div className="truncate text-xs font-medium">
                      {doc.title}
                    </div>
                    {where ? (
                      <div className="truncate text-2xs text-muted-foreground">
                        {where}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      ) : (
        children
      )}
    </>
  )
}
