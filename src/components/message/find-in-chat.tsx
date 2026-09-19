"use client"

import { useEffect, useRef, type RefObject } from "react"
import { useTranslations } from "next-intl"
import { ArrowDown, ArrowUp, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ThreadRenderItem } from "@/components/message/message-list-view"
import { cn } from "@/lib/utils"

/**
 * Plain-text projection of one thread item for find-in-chat. Only message
 * prose is searchable (text parts of the adapted group) — tool calls, tool
 * results, reasoning traces and chrome (typing indicator, compaction
 * divider) are excluded, mirroring what a reader scans visually.
 *
 * Mirrors the `ThreadRenderItem` contract in `message-list-view.tsx`; keep in
 * sync when new item kinds gain user-visible text.
 */
export function extractFindableText(item: ThreadRenderItem): string {
  if (item.kind !== "turn") return ""
  const texts: string[] = []
  for (const part of item.group.parts) {
    if (part.type === "text") texts.push(part.text)
  }
  return texts.join("\n")
}

interface FindInChatBarProps {
  query: string
  onQueryChange: (query: string) => void
  /** Total matches in the loaded transcript window. */
  count: number
  /** Zero-based index of the match currently in view. */
  index: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

/**
 * Find bar for the open conversation transcript (⌘F / Ctrl+F). A compact
 * overlay pinned by the parent — matches are jumped to by the parent via the
 * virtualizer's `scrollToIndex`, and the hit row is highlighted there too
 * (this bar stays stateless beyond its own input focus).
 */
export function FindInChatBar({
  query,
  onQueryChange,
  count,
  index,
  onNext,
  onPrev,
  onClose,
}: FindInChatBarProps) {
  const t = useTranslations("Folder.chat.messageList")
  const inputRef = useRef<HTMLInputElement>(null)

  // autoFocus misses the case where the bar mounts while the window itself
  // regains focus; re-assert on open is cheap and idempotent.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const hasQuery = query.trim().length > 0

  return (
    <div
      className="absolute end-4 top-3 z-30 flex items-center gap-1 rounded-lg border bg-background/95 px-2 py-1.5 shadow-md backdrop-blur"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          onClose()
        } else if (e.key === "Enter" && hasQuery) {
          e.preventDefault()
          if (e.shiftKey) onPrev()
          else onNext()
        }
      }}
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={t("findPlaceholder")}
        className="h-7 w-52 border-none bg-transparent text-sm shadow-none focus-visible:ring-0"
        aria-label={t("findPlaceholder")}
      />
      <span
        className={cn(
          "min-w-14 text-center text-xs tabular-nums text-muted-foreground",
          hasQuery && count === 0 && "text-destructive"
        )}
      >
        {hasQuery
          ? count > 0
            ? t("findMatchOf", { index: index + 1, count })
            : t("findNoResults")
          : ""}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        disabled={count === 0}
        onClick={onPrev}
        aria-label={t("findPrev")}
      >
        <ArrowUp className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        disabled={count === 0}
        onClick={onNext}
        aria-label={t("findNext")}
      >
        <ArrowDown className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-6"
        onClick={onClose}
        aria-label={t("findClose")}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

export interface FindHighlightTarget {
  enabled: boolean
  query: string
  /** Row keys that contain ≥1 match (drives which mounted rows get walked). */
  matchKeys: Set<string>
  /** The row the find bar currently points at. */
  activeKey: string | null
  /** 1-based occurrence of the active match WITHIN its row. */
  activeOccInRow: number
}

/**
 * Paint find matches onto the rendered transcript with the CSS Custom
 * Highlight API (`::highlight(find-match)` / `::highlight(find-match-active)`
 * — see globals.css). Walking text nodes + Ranges means the rendered Markdown
 * is never mutated, which matters here: rows are virtualized (mount/unmount as
 * you scroll) and re-render from streaming.
 *
 * Re-walks on a MutationObserver of the thread container so rows that mount
 * later (scrolling, streaming, paging in older history) get painted too. All
 * layer bookkeeping is torn down when the find bar closes.
 */
export function useFindHighlights(
  containerRef: RefObject<HTMLElement | null>,
  target: FindHighlightTarget
) {
  const { enabled, query, matchKeys, activeKey, activeOccInRow } = target

  useEffect(() => {
    const root = containerRef.current
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined
    if (!root || !registry || !enabled || query.trim().length === 0) {
      registry?.delete("find-match")
      registry?.delete("find-match-active")
      return
    }
    const q = query.toLowerCase()
    let raf = 0

    // ::highlight() styles injected at runtime — the build-time CSS
    // transformer (Lightning CSS) rejects the pseudo-element on some
    // versions, so the stylesheet never carries it.
    const styleId = "find-in-chat-highlights"
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style")
      style.id = styleId
      style.textContent = `
::highlight(find-match) { background-color: rgba(251, 191, 36, 0.3); color: inherit; }
::highlight(find-match-active) { background-color: rgba(251, 146, 60, 0.85); color: #1c1917; }`
      document.head.appendChild(style)
    }

    const paint = () => {
      const ranges: Range[] = []
      let activeRange: Range | null = null

      const rows = root.querySelectorAll<HTMLElement>("[data-find-key]")
      rows.forEach((row) => {
        const key = row.dataset.findKey ?? ""
        if (!matchKeys.has(key)) return

        // Accumulate the row's text with per-node offsets (matches span
        // Markdown element boundaries, code blocks, plain text — anything
        // with a text node).
        const nodes: Text[] = []
        const offsets: number[] = []
        let full = ""
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const text = node as Text
          offsets.push(full.length)
          full += text.data
          nodes.push(text)
        }
        if (!full) return

        const lower = full.toLowerCase()
        let occ = 0
        let pos = lower.indexOf(q)
        while (pos !== -1) {
          occ++
          const start = pos
          const end = pos + q.length
          let startNode: Text | null = null
          let startOffset = 0
          let endNode: Text | null = null
          let endOffset = 0
          for (let i = nodes.length - 1; i >= 0; i--) {
            if (offsets[i]! <= start) {
              startNode = nodes[i]!
              startOffset = start - offsets[i]!
              break
            }
          }
          for (let i = nodes.length - 1; i >= 0; i--) {
            if (offsets[i]! < end) {
              endNode = nodes[i]!
              endOffset = end - offsets[i]!
              break
            }
          }
          if (startNode && endNode) {
            try {
              const range = document.createRange()
              range.setStart(startNode, startOffset)
              range.setEnd(endNode, endOffset)
              ranges.push(range)
              if (key === activeKey && occ === activeOccInRow) {
                activeRange = range
              }
            } catch {
              // Range across a boundary the engine refuses (rare) — skip.
            }
          }
          pos = lower.indexOf(q, end)
        }
      })

      registry.delete("find-match")
      registry.delete("find-match-active")
      if (ranges.length > 0) {
        registry.set("find-match", new Highlight(...ranges))
      }
      if (activeRange) {
        registry.set("find-match-active", new Highlight(activeRange))
      }
    }

    // Virtualized rows mount/unmount on scroll; stream tokens mutate text.
    // Either invalidates the painted ranges, so re-walk on DOM change.
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(paint)
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    paint()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      registry.delete("find-match")
      registry.delete("find-match-active")
    }
  }, [containerRef, enabled, query, matchKeys, activeKey, activeOccInRow])
}
