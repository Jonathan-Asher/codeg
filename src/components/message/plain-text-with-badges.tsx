"use client"

import { memo, useMemo } from "react"

import { ReferenceBadge } from "@/components/chat/composer/badges/reference-badge"
import { parseQuoteBlocks, type QuoteBlock } from "@/lib/message-quote"
import {
  detectTextDirection,
  splitLinesByDirection,
} from "@/lib/text-direction"
import { cn } from "@/lib/utils"

import { FileReferenceActions } from "./file-reference-actions"
import { parseUserMessageSegments } from "./user-message-segments"

/**
 * One prose run: literal text with the five built-in reference kinds (file /
 * agent / session / commit / skill) resolved into inline colored badges.
 *
 * A fragment, not a wrapping element, so adjacent text and badges share one
 * inline flow and the caller's `whitespace-pre-wrap` collapses nothing.
 */
const TextRun = memo(function TextRun({ text }: { text: string }) {
  const segments = useMemo(() => parseUserMessageSegments(text), [text])
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "reference" ? (
          segment.attrs.refType === "file" && segment.attrs.uri ? (
            // Right-clicking a file badge opens its reveal / copy-path menu. A
            // non-file reference (session, agent, commit, skill) has no path, so
            // it stays a bare badge.
            <FileReferenceActions key={index} target={segment.attrs.uri}>
              <ReferenceBadge data={segment.attrs} />
            </FileReferenceActions>
          ) : (
            <ReferenceBadge key={index} data={segment.attrs} />
          )
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
})

/**
 * Plain text as `whitespace-pre-wrap` blocks that each read in their own
 * direction: lines are grouped into runs that share one
 * ({@link splitLinesByDirection}), so a Hebrew message aligns right with its
 * punctuation where it belongs, and an English line above a Hebrew paragraph
 * keeps its own side. One run — every message in a single language — is one
 * block, the same markup as before plus its `dir`.
 */
function DirectedText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const runs = useMemo(() => splitLinesByDirection(text), [text])
  if (runs.length === 1) {
    return (
      <div dir={runs[0].dir} className={cn("whitespace-pre-wrap", className)}>
        <TextRun text={text} />
      </div>
    )
  }
  return (
    <div className={className}>
      {runs.map((run, index) => (
        <div key={index} dir={run.dir} className="whitespace-pre-wrap">
          <TextRun text={run.text} />
        </div>
      ))}
    </div>
  )
}

function blockText(block: QuoteBlock): string {
  return block.kind === "text"
    ? block.text
    : block.children.map(blockText).join("\n")
}

/**
 * Render one parsed block. A quote nests, so this recurses.
 *
 * The rule is `border-foreground/25`, not `border-border`: a user bubble sits on
 * `bg-secondary` (see `ai-elements/message.tsx`), where `--border` all but
 * disappears. Quoted text keeps the surrounding color rather than going muted —
 * muted on `bg-secondary` washes out, and the rule already marks it as quoted.
 * The rule and indent are logical: a quote of right-to-left text takes `dir`
 * from it and draws them on the right.
 */
function renderBlock(block: QuoteBlock, key: number) {
  if (block.kind === "quote") {
    return (
      <div
        key={key}
        data-testid="user-message-quote"
        dir={detectTextDirection(blockText(block))}
        className="my-1.5 border-s-2 border-foreground/25 ps-3 first:mt-0 last:mb-0"
      >
        {block.children.map(renderBlock)}
      </div>
    )
  }
  return <DirectedText key={key} text={block.text} />
}

/**
 * Read-only renderer for a USER message's text: plain text with literal line
 * breaks, and the five built-in reference kinds (file / agent / session / commit
 * / skill) shown as inline colored badges. Everything else — including Markdown
 * syntax like `# heading`, `**bold**`, `- item`, code fences — renders VERBATIM.
 *
 * This is the transcript counterpart of the plain-text composer: what the user
 * typed is what they see. Assistant/agent output keeps full Markdown via
 * {@link "@/components/ai-elements/message".MessageResponse} and must NOT use this.
 *
 * The ONE exception is a line-leading `>`, which renders as a quote rule instead
 * of a literal marker ({@link parseQuoteBlocks}) — the transcript's half of the
 * quote action, and the same treatment the composer's `.codeg-quote-marker`
 * decoration gives the draft, so a quote looks the same before and after
 * sending. Markdown rendering is NOT otherwise widened: only `>` is structural.
 *
 * `whitespace-pre-wrap` preserves the sender's newlines (replacing the old
 * `remark-breaks` path); `break-words` keeps long unbroken tokens from
 * overflowing the bubble.
 */
export const PlainTextWithBadges = memo(function PlainTextWithBadges({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const blocks = useMemo(() => parseQuoteBlocks(text), [text])

  // Fast path for the overwhelming majority of messages, which quote nothing:
  // one prose run, rendered by the markup this component always emitted (plus
  // `dir`) unless its lines change direction.
  if (blocks.length === 1 && blocks[0].kind === "text") {
    return (
      <DirectedText
        text={blocks[0].text}
        className={cn("break-words", className)}
      />
    )
  }

  return (
    <div className={cn("break-words", className)}>
      {blocks.map(renderBlock)}
    </div>
  )
})
