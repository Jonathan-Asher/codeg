"use client"

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { detectPlatform } from "@/hooks/use-platform"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"

/** Why a save can't run right now (the Save button greys out and says so). */
export type UserEditBlock = "busy" | "queued" | "notReady"

export interface UserMessageEditorProps {
  /** Identifies the message being edited in `recallDraft` / `rememberDraft`. */
  draftKey: string
  /** The message's text as it was sent — where an edit starts. */
  initialText: string
  /**
   * Text typed into an earlier mount of this editor. The transcript is
   * virtualized, so scrolling the editor away unmounts it; the host keeps the
   * draft and hands it back here rather than starting over.
   */
  recallDraft: (key: string) => string | undefined
  rememberDraft: (key: string, text: string) => void
  /** The message's images: shown, not editable, and sent again with it. */
  images: UserImageDisplay[]
  /** The message opens the conversation, so saving starts a new one instead
   *  of a branch of this one. Only the wording changes. */
  startsNewConversation: boolean
  /** The save is under way: the text locks and the button says so. */
  saving: boolean
  /** Saving can't run right now, and why. The text stays editable. */
  blocked: UserEditBlock | null
  onCancel: () => void
  onSave: (text: string) => void
}

/** What each {@link UserEditBlock} says, under `Folder.chat.messageList`. */
export const USER_EDIT_BLOCKED_LABEL = {
  busy: "editBusy",
  queued: "editQueued",
  notReady: "editNotReady",
} as const

/**
 * A user message turned into an editor in place: its text in a field, its
 * images alongside as fixed chips, Cancel (Esc) and Save & send (⌘/Ctrl+Enter).
 */
export function UserMessageEditor({
  draftKey,
  initialText,
  recallDraft,
  rememberDraft,
  images,
  startsNewConversation,
  saving,
  blocked,
  onCancel,
  onSave,
}: UserMessageEditorProps) {
  const t = useTranslations("Folder.chat.messageList")
  const [text, setText] = useState(() => recallDraft(draftKey) ?? initialText)
  const [shortcut] = useState(() =>
    detectPlatform() === "macos" ? "⌘↵" : "Ctrl+↵"
  )
  const ime = useImeGuard()
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)

  // Open with the caret at the end, the way the message was left.
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])

  const hasContent = text.trim().length > 0 || images.length > 0
  const canSave = !saving && blocked === null && hasContent
  const save = () => {
    if (canSave) onSave(text)
  }

  return (
    <div
      role="group"
      aria-label={t("editMessage")}
      data-user-message-editor=""
      className="ms-auto flex w-full max-w-[88%] flex-col gap-2 rounded-lg bg-secondary px-3 py-3"
    >
      {images.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={t("editImagesKept")}
          title={t("editImagesKept")}
        >
          {images.map((image, index) => (
            <li
              key={`${image.uri ?? image.name}-${index}`}
              className="flex items-center gap-1.5 rounded-md border border-border/70 bg-background/60 py-0.5 ps-0.5 pe-2 text-xs text-muted-foreground"
            >
              <Image
                src={`data:${image.mime_type};base64,${image.data}`}
                alt=""
                width={20}
                height={20}
                unoptimized
                className="h-5 w-5 rounded object-cover"
              />
              <span className="max-w-40 truncate">{image.name}</span>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={fieldRef}
        value={text}
        readOnly={saving}
        aria-label={t("editMessage")}
        rows={Math.min(12, Math.max(3, text.split("\n").length))}
        className="max-h-80 min-h-20 overflow-y-auto bg-background"
        onChange={(event) => {
          setText(event.target.value)
          rememberDraft(draftKey, event.target.value)
        }}
        {...ime.props}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Swallow it: find-in-chat and the surrounding panes treat Escape
            // as their own dismissal.
            event.preventDefault()
            event.stopPropagation()
            if (!saving) onCancel()
            return
          }
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
            return
          }
          // A candidate being confirmed belongs to the IME, not to Save.
          if (ime.isComposing(event)) return
          event.preventDefault()
          event.stopPropagation()
          save()
        }}
      />
      <p className="text-xs text-muted-foreground">
        {startsNewConversation ? t("editHintNewConversation") : t("editHint")}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {blocked !== null && !saving && (
          <span className="me-auto text-xs text-muted-foreground">
            {t(USER_EDIT_BLOCKED_LABEL[blocked])}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          {t("editCancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={!canSave}
          aria-busy={saving || undefined}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
          {saving
            ? startsNewConversation
              ? t("editSavingNewConversation")
              : t("editSaving")
            : t("editSave")}
          {!saving && (
            <kbd
              aria-hidden="true"
              className="ms-1 font-sans text-[0.6875rem] opacity-70"
            >
              {shortcut}
            </kbd>
          )}
        </Button>
      </div>
    </div>
  )
}
