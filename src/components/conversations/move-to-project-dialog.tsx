"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { FolderSelect } from "@/components/shared/folder-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  moveConversationToFolder,
  type MoveConversationResult,
} from "@/lib/api"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** What the dialog needs to know about the session it moves. */
export type MoveToProjectTarget = Pick<
  DbConversationSummary,
  "id" | "folder_id" | "agent_type" | "title"
>

/**
 * Whether "Move to project…" is offered for a session: a top-level session
 * (not a chat, not a sub-session — those move with their parent) that has a
 * row. The backend refuses the rest too; this only keeps the menus honest.
 */
export function canMoveToProject(
  conversation: Pick<DbConversationSummary, "kind" | "parent_id"> | null
): boolean {
  return (
    conversation != null &&
    conversation.kind === "regular" &&
    conversation.parent_id == null
  )
}

type Preview =
  | { state: "idle" }
  | { state: "checking"; folderId: number }
  | { state: "ready"; folderId: number; result: MoveConversationResult }
  | { state: "refused"; folderId: number; message: string }

interface MoveToProjectDialogProps {
  conversation: MoveToProjectTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Move to project…": pick one of the open projects, see what the move does
 * (a dry run — the agent's files move with it, or it can only be listed
 * there, or it is refused, and why), then move. The session reappears under
 * the new project through the server's broadcasts, and an open tab follows
 * it. Mount it only while open: its state belongs to one opening.
 */
export function MoveToProjectDialog({
  conversation,
  open,
  onOpenChange,
}: MoveToProjectDialogProps) {
  const t = useTranslations("Folder.moveSession")
  // A refusal names its own key (`errors.<code>`), so the translator takes
  // keys the type system cannot list.
  const tError = t as unknown as AppErrorTranslator
  const openFolders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  // Open projects only: not the one it is in, not a hidden chat folder.
  const choices = useMemo(
    () =>
      openFolders.filter(
        (f) => f.kind !== "chat" && f.id !== conversation.folder_id
      ),
    [openFolders, conversation.folder_id]
  )
  const [folderId, setFolderId] = useState<number | null>(null)
  const [preview, setPreview] = useState<Preview>({ state: "idle" })
  const [moving, setMoving] = useState(false)
  // Only the latest pick's answer may land. The callers mount the dialog
  // only while it is open, so every opening starts from a clean slate.
  const requestRef = useRef(0)

  const handlePick = useCallback(
    (id: number) => {
      setFolderId(id)
      const request = ++requestRef.current
      setPreview({ state: "checking", folderId: id })
      moveConversationToFolder(conversation.id, id, { dryRun: true })
        .then((result) => {
          if (requestRef.current !== request) return
          setPreview({ state: "ready", folderId: id, result })
        })
        .catch((err: unknown) => {
          if (requestRef.current !== request) return
          setPreview({
            state: "refused",
            folderId: id,
            message: toLocalizedErrorMessage(err, tError),
          })
        })
    },
    [conversation.id, tError]
  )

  const target = choices.find((f) => f.id === folderId) ?? null
  const projectName = target ? (target.alias ?? target.name) : ""
  // Where the session keeps running when it can only be listed.
  const runsIn = useMemo(() => {
    const current = allFolders.find((f) => f.id === conversation.folder_id)
    if (preview.state !== "ready") return current?.path ?? ""
    return (
      preview.result.conversation.working_dir ??
      preview.result.conversation.origin_cwd ??
      current?.path ??
      ""
    )
  }, [allFolders, conversation.folder_id, preview])
  const agent = getAgentLabel(conversation.agent_type)

  const handleMove = useCallback(async () => {
    if (folderId == null || preview.state !== "ready") return
    const request = ++requestRef.current
    setMoving(true)
    try {
      const result = await moveConversationToFolder(conversation.id, folderId)
      if (result.mode === "listed_only") {
        toast.success(
          t("movedListedOnly", {
            project: projectName,
            path:
              result.conversation.working_dir ??
              result.conversation.origin_cwd ??
              runsIn,
          })
        )
      } else {
        toast.success(t("moved", { project: projectName }))
      }
      onOpenChange(false)
    } catch (err) {
      if (requestRef.current === request) setMoving(false)
      toast.error(
        t("failed", { message: toLocalizedErrorMessage(err, tError) })
      )
    }
  }, [
    conversation.id,
    folderId,
    onOpenChange,
    preview,
    projectName,
    runsIn,
    t,
    tError,
  ])

  const title =
    formatConversationTitle(conversation.title) || t("untitledSession")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="move-to-project-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { title })}</DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProjects")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <FolderSelect
              folders={choices}
              value={folderId}
              onChange={handlePick}
              placeholder={t("pickProject")}
              variant="field"
              disabled={moving}
              className="max-w-full"
            />
            <MovePreview
              preview={preview}
              agent={agent}
              project={projectName}
              runsIn={runsIn}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={handleMove}
            disabled={moving || preview.state !== "ready"}
          >
            {moving ? t("moving") : t("move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MovePreview({
  preview,
  agent,
  project,
  runsIn,
}: {
  preview: Preview
  agent: string
  project: string
  runsIn: string
}) {
  const t = useTranslations("Folder.moveSession")
  if (preview.state === "idle") return null
  if (preview.state === "checking") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("checking")}
      </p>
    )
  }
  if (preview.state === "refused") {
    return (
      <p
        className="text-sm text-destructive"
        role="alert"
        data-testid="move-refusal"
      >
        {preview.message}
      </p>
    )
  }
  const { result } = preview
  const children = result.moved_children.length
  return (
    <div className="flex flex-col gap-1.5 text-sm" data-testid="move-preview">
      {result.mode === "full" ? (
        <p className="text-muted-foreground">{t("fullNote", { project })}</p>
      ) : (
        <p className="text-amber-700 dark:text-amber-400">
          {t(`listedOnly.${result.reason ?? "agent_unsupported"}`, {
            agent,
            project,
            path: runsIn,
          })}
        </p>
      )}
      {children > 0 ? (
        <p className="text-muted-foreground">
          {t("children", { count: children })}
        </p>
      ) : null}
    </div>
  )
}
