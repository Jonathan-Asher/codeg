"use client"

/**
 * A session's own actions — rename, fork, move, pin, critical, Talk, export,
 * details, add to session, tags, status, manage, delete — as ONE section that
 * every context menu showing a session renders: a sidebar row's and a
 * conversation tab's. Both menus take the items and the dialogs from here, so
 * they cannot come to offer different things; what differs between them (a
 * tab's Pin tab, closes and splits) stays in the menu around this section.
 *
 * Mounted inside the menu's content, which Radix mounts only while the menu
 * is open: whatever is read when it opens (the tab "Add to session" writes
 * into, why Fork can't run) is read once, then.
 */

import {
  useCallback,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import {
  AtSign,
  AudioLines,
  Circle,
  FileDown,
  Flag,
  FlagOff,
  FolderInput,
  Info,
  ListChecks,
  MicOff,
  Pencil,
  PhoneOff,
  Pin,
  PinOff,
  Split,
  SquarePen,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useTabStore } from "@/contexts/tab-context"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  useForkBlockLabel,
  useForkConversation,
} from "@/hooks/use-fork-conversation"
import type { SessionActionHandlers } from "@/hooks/use-session-action-handlers"
import { formatConversationTitle } from "@/lib/conversation-title"
import { conversationForkBlock } from "@/lib/fork-conversation"
import { emitAttachSessionToSession } from "@/lib/session-attachment-events"
import { STATUS_ORDER, type DbConversationSummary } from "@/lib/types"
import { useTalkMenu } from "@/components/talk-voice/use-talk-menu"
import {
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConversationStatusDot } from "./conversation-status-dot"
import { ContinueInAgentMenuItem } from "./continue-in-agent-menu-item"
import { MoveToProjectDialog, canMoveToProject } from "./move-to-project-dialog"
import { SessionDetailsDialog } from "./session-details-dialog"
import {
  ConversationTagContextSubmenu,
  NewConversationTagDialog,
} from "./conversation-tag-picker"

/** The dialogs a session's menu opens. They live beside the menu, never in
 *  it: the menu unmounts its content as it closes. */
export type SessionDialogKind =
  | "rename"
  | "delete"
  | "details"
  | "move"
  | "newTag"

/** The menu item component a menu brings (as `ContinueInAgentMenuItem`
 *  takes it). The Status and Tags submenus are context-menu ones, so the
 *  section belongs in a context menu. */
type MenuItemComponent = ComponentType<{
  disabled?: boolean
  onSelect?: (event: Event) => void
  variant?: "default" | "destructive"
  children?: ReactNode
}>

/**
 * The conversation tab whose composer "add to session" writes into — the active
 * one — or null when no conversation tab is open. Reads the store imperatively so
 * it can serve both the menu's disabled state and the click itself.
 *
 * Deliberately no self-mention guard: the composer's own `@` panel lists every
 * session including the one being typed in, so the menu matches it.
 */
function resolveAttachTabId(): string | null {
  const { tabs, activeTabId } = useTabStore.getState()
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  if (!activeTab || activeTab.kind !== "conversation") return null
  return activeTab.id
}

export function SessionActionsMenuItems({
  conversation,
  handlers,
  onOpenDialog,
  item: Item,
  surface = "sidebar",
}: {
  conversation: DbConversationSummary
  handlers: SessionActionHandlers
  onOpenDialog: (kind: SessionDialogKind) => void
  item: MenuItemComponent
  /** A tab's menu also has "Pin tab", so the sidebar pin says what it pins. */
  surface?: "sidebar" | "tab"
}) {
  const t = useTranslations("Folder.conversationCard")
  const tSidebar = useTranslations("Folder.sidebar")
  const tStatus = useTranslations("Folder.statusLabels")
  const tDetails = useTranslations("Folder.sessionDetails")
  const tMove = useTranslations("Folder.moveSession")
  const tTalk = useTranslations("TalkVoice")
  const {
    onNewConversation,
    onTogglePin,
    onToggleCritical,
    onToggleTalk,
    onExportMarkdown,
    onManageConversations,
    onStatusChange,
  } = handlers
  // Read as the menu opens. They drive the DISABLED STATE only; a click
  // re-resolves (see `handleAttachToSession`) and the backend still refuses
  // a fork the state changed under.
  const [attachTabId] = useState(resolveAttachTabId)
  const [forkBlock] = useState(() => conversationForkBlock(conversation))
  const forkConversation = useForkConversation()
  const forkBlockLabel = useForkBlockLabel()

  // A delegation sub-session is driven by its parent: no new session, move,
  // continue, tags or manage, and only an unmark for a mark it carries.
  const isSubsession = conversation.parent_id != null
  const isPinned = conversation.pinned_at != null
  const isCritical = conversation.critical === true
  const isTalk = conversation.talk_mode === true
  const talkMenu = useTalkMenu(conversation.id, isTalk)

  const handleFork = useCallback(
    () => forkConversation(conversation),
    [forkConversation, conversation]
  )

  const handleAttachToSession = useCallback(() => {
    // Re-resolved at click time rather than reused from the open-time snapshot:
    // the workspace's `mod+w` / `mod+tab` handler sits on `document`, and Radix
    // lets modifier combos through to it while the menu is open, so the active
    // tab really can change under an open menu. Posting to the stale id would
    // drop the badge into a closed (or now-background) composer and read to the
    // user as "nothing happened".
    const tabId = resolveAttachTabId()
    if (!tabId) return
    emitAttachSessionToSession({ tabId, conversation })
  }, [conversation])

  const pinLabel =
    surface === "tab"
      ? isPinned
        ? t("unpinFromSidebar")
        : t("pinInSidebar")
      : isPinned
        ? t("unpin")
        : t("pin")

  return (
    <>
      {onNewConversation && (
        <>
          <Item onSelect={() => onNewConversation(conversation.folder_id)}>
            <SquarePen className="h-4 w-4" />
            {t("newConversation")}
          </Item>
          <ContextMenuSeparator />
        </>
      )}
      <Item onSelect={() => onOpenDialog("rename")}>
        <Pencil className="h-4 w-4" />
        {t("rename")}
      </Item>
      {/* A copy forked at the latest finished reply, in a new tab; this one
          stays as it is. A disabled item takes no pointer, so its wrapper
          carries the reason. */}
      {forkBlock ? (
        <div title={forkBlockLabel(forkBlock)}>
          <Item disabled>
            <Split className="h-4 w-4" />
            {t("fork")}
          </Item>
        </div>
      ) : (
        <Item onSelect={handleFork}>
          <Split className="h-4 w-4" />
          {t("fork")}
        </Item>
      )}
      {/* Another project, with the agent's files where it keys them by
          folder. A chat or a sub-session (it moves with its parent) has none
          to leave. */}
      {canMoveToProject(conversation) && (
        <Item onSelect={() => onOpenDialog("move")}>
          <FolderInput className="h-4 w-4" />
          {tMove("menuLabel")}
        </Item>
      )}
      {/* A new session on another agent picks the work up (a sub-session
          goes on with its parent). */}
      {!isSubsession && (
        <ContinueInAgentMenuItem conversationId={conversation.id} item={Item} />
      )}
      {onTogglePin && (
        <Item onSelect={() => onTogglePin(conversation.id, !isPinned)}>
          {isPinned ? (
            <PinOff className="h-4 w-4" />
          ) : (
            <Pin className="h-4 w-4" />
          )}
          {pinLabel}
        </Item>
      )}
      {/* A sub-session is driven by its parent, so it is not watched on its
          own (as in Session Details); one marked anyway can still be
          unmarked. */}
      {onToggleCritical && (!isSubsession || isCritical) && (
        <Item onSelect={() => onToggleCritical(conversation.id, !isCritical)}>
          {isCritical ? (
            <FlagOff className="h-4 w-4" />
          ) : (
            <Flag className="h-4 w-4" />
          )}
          {isCritical ? t("unmarkCritical") : t("markCritical")}
        </Item>
      )}
      {/* Talk on this Mac, or its end in the window that holds it. Not
          offered on a sub-session, like the mark. */}
      {talkMenu.showEndTalk && (
        <Item onSelect={talkMenu.endTalk}>
          <PhoneOff className="h-4 w-4" />
          {tTalk("menuEndTalk")}
        </Item>
      )}
      {!isSubsession && talkMenu.showTalkOnMac && (
        <Item onSelect={talkMenu.startTalk}>
          <AudioLines className="h-4 w-4" />
          {tTalk("menuTalkOnMac")}
        </Item>
      )}
      {/* Talk mode held from the phone; turned off here too, for one a phone
          left on. Turned on (reply style only) where Talk on this Mac can't
          run. */}
      {onToggleTalk &&
        (!isSubsession || isTalk) &&
        (talkMenu.showTurnOff || talkMenu.showTurnOn) && (
          <Item onSelect={() => onToggleTalk(conversation.id, !isTalk)}>
            {isTalk ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <AudioLines className="h-4 w-4" />
            )}
            {isTalk ? t("talkOff") : t("talkOn")}
          </Item>
        )}
      {onExportMarkdown && (
        <Item onSelect={() => onExportMarkdown(conversation.id)}>
          <FileDown className="h-4 w-4" />
          {t("exportMarkdown")}
        </Item>
      )}
      <Item onSelect={() => onOpenDialog("details")}>
        <Info className="h-4 w-4" />
        {tDetails("menuLabel")}
      </Item>
      {/* Mirrors the file tree's "add to session": inserts an `@`-style
          mention of THIS conversation into the active session's composer.
          Disabled only when no conversation tab is open — there is no
          composer to write into then. */}
      <Item onSelect={handleAttachToSession} disabled={!attachTabId}>
        <AtSign className="h-4 w-4" />
        {t("attachToCurrentSession")}
      </Item>
      <ContextMenuSeparator />
      {/* Sub-sessions opt out like they do of pinning: a sub-agent run is not
          a conversation the user files away, and the sidebar filter only ever
          matches root rows. */}
      {!isSubsession && (
        <ConversationTagContextSubmenu
          conversationId={conversation.id}
          folderId={conversation.folder_id}
          tagIds={conversation.tag_ids}
          onNewTag={() => onOpenDialog("newTag")}
        />
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Circle className="h-4 w-4" />
          {t("status")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {STATUS_ORDER.filter((s) => s !== conversation.status).map((s) => (
            <Item key={s} onSelect={() => onStatusChange(conversation.id, s)}>
              <ConversationStatusDot status={s} />
              {tStatus(s)}
            </Item>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {onManageConversations &&
        !isSubsession &&
        conversation.kind !== "chat" && (
          <>
            <ContextMenuSeparator />
            <Item onSelect={() => onManageConversations(conversation)}>
              <ListChecks className="h-4 w-4" />
              {tSidebar("folderHeaderMenu.manageConversations")}
            </Item>
          </>
        )}
      <ContextMenuSeparator />
      <Item variant="destructive" onSelect={() => onOpenDialog("delete")}>
        <Trash2 className="h-4 w-4" />
        {t("delete")}
      </Item>
    </>
  )
}

/**
 * The dialogs `SessionActionsMenuItems` opens, rendered beside the menu by its
 * owner: rename, delete (confirmed), details, move to another project, and a
 * new tag. `dialog` says which is open; `onDialogChange(null)` closes it.
 */
export function SessionActionDialogs({
  conversation,
  dialog,
  onDialogChange,
  onRename,
  onDelete,
}: {
  conversation: DbConversationSummary
  dialog: SessionDialogKind | null
  onDialogChange: (dialog: SessionDialogKind | null) => void
  onRename: SessionActionHandlers["onRename"]
  onDelete: SessionActionHandlers["onDelete"]
}) {
  const t = useTranslations("Folder.conversationCard")
  const close = useCallback(
    (open: boolean) => {
      if (!open) onDialogChange(null)
    },
    [onDialogChange]
  )

  const handleRenameConfirm = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (trimmed && trimmed !== conversation.title) {
        await onRename(conversation.id, trimmed)
      }
      onDialogChange(null)
    },
    [conversation.id, conversation.title, onRename, onDialogChange]
  )

  const handleDeleteConfirm = useCallback(async () => {
    await onDelete(
      conversation.id,
      conversation.agent_type,
      conversation.folder_id
    )
    onDialogChange(null)
  }, [
    conversation.id,
    conversation.agent_type,
    conversation.folder_id,
    onDelete,
    onDialogChange,
  ])

  return (
    <>
      <Dialog open={dialog === "rename"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameConversation")}</DialogTitle>
          </DialogHeader>
          {/* Mounted with the dialog's content, so each opening starts from
              the title as it is then. */}
          <RenameConversationForm
            initialTitle={conversation.title || ""}
            onCancel={() => onDialogChange(null)}
            onSave={handleRenameConfirm}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog === "delete"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConversationTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConversationDescription", {
                title:
                  formatConversationTitle(conversation.title) ||
                  t("untitledConversation"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mounted only while open: one dormant dialog per sidebar row would be
          all cost. */}
      {dialog === "details" && (
        <SessionDetailsDialog
          open
          onOpenChange={close}
          summary={conversation}
        />
      )}
      {dialog === "move" && (
        <MoveToProjectDialog
          open
          onOpenChange={close}
          conversation={conversation}
        />
      )}
      {dialog === "newTag" && (
        <NewConversationTagDialog
          open
          onOpenChange={close}
          conversationId={conversation.id}
          folderId={conversation.folder_id}
        />
      )}
    </>
  )
}

function RenameConversationForm({
  initialTitle,
  onCancel,
  onSave,
}: {
  initialTitle: string
  onCancel: () => void
  onSave: (value: string) => void
}) {
  const t = useTranslations("Folder.conversationCard")
  const ime = useImeGuard()
  const [value, setValue] = useState(initialTitle)
  return (
    <>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        {...ime.props}
        onKeyDown={(e) => {
          if (ime.isComposing(e)) return
          if (e.key === "Enter") onSave(value)
        }}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={() => onSave(value)}>{t("save")}</Button>
      </DialogFooter>
    </>
  )
}
