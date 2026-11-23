"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { Reorder, useDragControls } from "motion/react"
import {
  GripVertical,
  ListPlus,
  MessageSquareText,
  Pencil,
  SendHorizontal,
  TextCursorInput,
  Trash2,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { useTabStore } from "@/contexts/tab-context"
import { useIsMac } from "@/hooks/use-is-mac"
import { usePreparedPrompts } from "@/hooks/use-prepared-prompts"
import { toErrorMessage } from "@/lib/app-error"
import { useComposerBridge, type ComposerBridge } from "@/lib/composer-bridge"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { formatTimeAgo } from "@/lib/relative-time"
import type { PreparedPrompt } from "@/lib/types"
import { cn } from "@/lib/utils"

/** ⌘↩ / Ctrl+Enter: saves the prompt being written or edited. */
const SAVE_SHORTCUT = "mod+enter"
/** A second Send of the same prompt this soon after the first is a double
 *  click, not a second message. */
const SEND_REPEAT_GUARD_MS = 800

function isSaveChord(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.nativeEvent.isComposing
  )
}

/**
 * The right-hand panel's Prompts tab: messages the user prepared for the
 * active session, each sent with a click (or put in the composer to edit
 * first). Each session has its own list, kept on its server, so a remote
 * window shows its server's lists. Sending never removes a prompt; it is
 * marked with when it was sent, so a sequence of follow-ups can be worked
 * through in order.
 *
 * Sends go through the session's own composer (`lib/composer-bridge`), by the
 * route Enter would take there: now, into the queue while a reply runs, or
 * into a turn held for background work.
 */
export function PreparedPromptsTab() {
  const t = useTranslations("Folder.preparedPrompts")
  const activeTab = useTabStore((s) =>
    s.activeTabId == null
      ? null
      : (s.tabs.find((tab) => tab.id === s.activeTabId) ?? null)
  )

  if (!activeTab || activeTab.kind !== "conversation") {
    return <PromptsNotice text={t("noSession")} />
  }
  if (activeTab.conversationId == null) {
    return <PromptsNotice text={t("draftSession")} />
  }
  return (
    <PreparedPromptsList
      key={activeTab.conversationId}
      conversationId={activeTab.conversationId}
      tabId={activeTab.id}
    />
  )
}

function PromptsNotice({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <MessageSquareText
        className="size-5 text-muted-foreground/60"
        aria-hidden
      />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}

function PreparedPromptsList({
  conversationId,
  tabId,
}: {
  conversationId: number
  tabId: string
}) {
  const t = useTranslations("Folder.preparedPrompts")
  const list = usePreparedPrompts(conversationId)
  const bridge = useComposerBridge(tabId)
  const { prompts, error } = list

  // "Sent 5 minutes ago" against one clock, refreshed each minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const lastSendRef = useRef(new Map<number, number>())
  const handleSend = useCallback(
    (prompt: PreparedPrompt) => {
      if (!bridge) return
      const at = Date.now()
      const previous = lastSendRef.current.get(prompt.id) ?? 0
      if (at - previous < SEND_REPEAT_GUARD_MS) return
      const route = bridge.send(prompt.content)
      if (route == null) return
      lastSendRef.current.set(prompt.id, at)
      setNow(at)
      list.markSent(prompt.id)
      if (route === "enqueue") {
        toast.info(t(bridge.isReplying ? "queuedToast" : "queuedUntilReady"))
      }
    },
    [bridge, list, t]
  )

  const handleInsert = useCallback(
    (prompt: PreparedPrompt) => {
      bridge?.insert(prompt.content)
    },
    [bridge]
  )

  const handleDelete = useCallback(
    async (prompt: PreparedPrompt) => {
      try {
        const removed = await list.remove(prompt.id)
        toast(t("deleted"), {
          action: {
            label: t("undo"),
            onClick: () => {
              list.restore(removed.prompt, removed.index).catch((err) => {
                toast.error(t("restoreFailed"), {
                  description: toErrorMessage(err),
                })
              })
            },
          },
        })
      } catch (err) {
        toast.error(t("deleteFailed"), { description: toErrorMessage(err) })
      }
    },
    [list, t]
  )

  const handleDragEnd = useCallback(() => {
    list.endDrag().catch((err) => {
      toast.error(t("reorderFailed"), { description: toErrorMessage(err) })
    })
  }, [list, t])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {prompts == null ? (
          error ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <p className="text-xs text-destructive">{t("loadFailed")}</p>
              <p className="text-2xs break-words text-muted-foreground">
                {error}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={list.reload}
              >
                {t("retry")}
              </Button>
            </div>
          ) : (
            <p className="p-6 text-center text-xs text-muted-foreground">
              {t("loading")}
            </p>
          )
        ) : prompts.length === 0 ? (
          <p
            data-testid="prepared-prompts-empty"
            className="p-6 text-center text-xs text-muted-foreground"
          >
            {t("empty")}
          </p>
        ) : (
          <Reorder.Group
            as="ul"
            axis="y"
            values={prompts}
            onReorder={list.dragTo}
            aria-label={t("listLabel")}
            className="flex flex-col gap-2 p-2"
          >
            {prompts.map((prompt) => (
              <PromptRow
                key={prompt.id}
                prompt={prompt}
                now={now}
                bridge={bridge}
                onSend={handleSend}
                onInsert={handleInsert}
                onSave={list.update}
                onDelete={handleDelete}
                onDragEnd={handleDragEnd}
              />
            ))}
          </Reorder.Group>
        )}
      </ScrollArea>
      <NewPromptForm onAdd={list.add} />
    </div>
  )
}

interface PromptRowProps {
  prompt: PreparedPrompt
  now: number
  bridge: ComposerBridge | null
  onSend: (prompt: PreparedPrompt) => void
  onInsert: (prompt: PreparedPrompt) => void
  onSave: (id: number, content: string) => Promise<PreparedPrompt>
  onDelete: (prompt: PreparedPrompt) => void
  onDragEnd: () => void
}

function PromptRow({
  prompt,
  now,
  bridge,
  onSend,
  onInsert,
  onSave,
  onDelete,
  onDragEnd,
}: PromptRowProps) {
  const t = useTranslations("Folder.preparedPrompts")
  const locale = useLocale()
  const dragControls = useDragControls()
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  // The text is clamped to a few lines; "Show more" appears only when the
  // clamp actually hides something.
  const textRef = useRef<HTMLParagraphElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, prompt.content, editing])

  // What Send will do, by the route the composer would take right now.
  const route = bridge?.sendRoute ?? null
  const queues = route === "enqueue"
  const sendTitle =
    route == null
      ? t("sendUnavailable")
      : queues
        ? t(bridge?.isReplying ? "queueTitle" : "queueUntilReadyTitle")
        : t(route === "deliver" ? "deliverTitle" : "sendTitle")
  const SendIcon = queues ? ListPlus : SendHorizontal
  const sentAt = prompt.lastSentAt ? Date.parse(prompt.lastSentAt) : NaN

  return (
    <Reorder.Item
      as="li"
      value={prompt}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      onDragEnd={onDragEnd}
      data-testid="prepared-prompt"
      className="group/prompt list-none rounded-lg border border-border/70 bg-card"
    >
      <div className="flex items-start gap-1 p-2 pb-1">
        <button
          type="button"
          className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
          title={t("drag")}
          aria-label={t("drag")}
          onPointerDown={startDrag}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <PromptEditor
              initial={prompt.content}
              onCancel={() => setEditing(false)}
              onSave={async (content) => {
                await onSave(prompt.id, content)
                setEditing(false)
              }}
            />
          ) : (
            <>
              <p
                ref={textRef}
                dir="auto"
                data-testid="prepared-prompt-text"
                className={cn(
                  "text-start text-sm leading-5 break-words whitespace-pre-wrap",
                  !expanded && "line-clamp-4"
                )}
              >
                {prompt.content}
              </p>
              {(overflows || expanded) && (
                <button
                  type="button"
                  className="mt-0.5 text-2xs font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                >
                  {expanded ? t("showLess") : t("showMore")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {!editing && (
        <div className="flex items-center gap-0.5 px-2 pb-1.5">
          <span
            data-testid="prepared-prompt-sent"
            className="min-w-0 flex-1 truncate ps-5 text-2xs text-muted-foreground/80"
          >
            {Number.isFinite(sentAt)
              ? t("sent", { time: formatTimeAgo(sentAt, now, locale) })
              : null}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-60 group-hover/prompt:opacity-100 focus-visible:opacity-100"
            title={t("edit")}
            aria-label={t("edit")}
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-60 group-hover/prompt:opacity-100 hover:text-destructive focus-visible:opacity-100"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={() => onDelete(prompt)}
          >
            <Trash2 aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title={t(bridge ? "insertTitle" : "insertUnavailable")}
            aria-label={t("insert")}
            disabled={!bridge}
            onClick={() => onInsert(prompt)}
          >
            <TextCursorInput aria-hidden />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            title={sendTitle}
            disabled={route == null}
            onClick={() => onSend(prompt)}
          >
            <SendIcon
              className={cn(!queues && "rtl:-scale-x-100")}
              aria-hidden
            />
            {queues ? t("queue") : t("send")}
          </Button>
        </div>
      )}
    </Reorder.Item>
  )
}

function PromptEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("Folder.preparedPrompts")
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const canSave = text.trim().length > 0 && !saving
  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(text)
    } catch (err) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        ref={ref}
        dir="auto"
        value={text}
        aria-label={t("editLabel")}
        className="max-h-60 min-h-16 rounded-md px-2 py-1.5 text-sm"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (isSaveChord(event)) {
            event.preventDefault()
            event.stopPropagation()
            void save()
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
}

function NewPromptForm({
  onAdd,
}: {
  onAdd: (content: string) => Promise<PreparedPrompt>
}) {
  const t = useTranslations("Folder.preparedPrompts")
  const isMac = useIsMac()
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const canAdd = text.trim().length > 0 && !saving

  const add = async () => {
    if (!canAdd) return
    setSaving(true)
    try {
      await onAdd(text)
      setText("")
    } catch (err) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      <Textarea
        dir="auto"
        value={text}
        placeholder={t("newPlaceholder")}
        aria-label={t("newLabel")}
        className="max-h-40 min-h-14 rounded-md px-2 py-1.5 text-sm"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (!isSaveChord(event)) return
          event.preventDefault()
          event.stopPropagation()
          void add()
        }}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {t("addHint", { keys: formatShortcutLabel(SAVE_SHORTCUT, isMac) })}
        </span>
        <Button
          type="button"
          size="xs"
          disabled={!canAdd}
          onClick={() => void add()}
        >
          {t("add")}
        </Button>
      </div>
    </div>
  )
}
