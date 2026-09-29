"use client"

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  EyeOff,
  FolderPlus,
  MessagesSquare,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { FolderSelect } from "@/components/shared/folder-select"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  QUICK_ASK_TARGETS,
  type QuickAskTargetKind,
} from "@/lib/quick-ask/prefs"
import type { FolderDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { QuickAskSessionOption } from "../_hooks/use-quick-ask-data"

const TARGET_LABEL_KEYS = {
  new: "targets.new",
  existing: "targets.existing",
  private: "targets.private",
} as const satisfies Record<QuickAskTargetKind, string>

const TARGET_ICONS = {
  new: FolderPlus,
  existing: MessagesSquare,
  private: EyeOff,
} as const satisfies Record<QuickAskTargetKind, unknown>

function SessionSelect({
  sessions,
  value,
  onChange,
  onOpen,
  disabled,
}: {
  sessions: QuickAskSessionOption[]
  value: number | null
  onChange: (id: number) => void
  /** The list is re-read each time it opens: sessions come and go. */
  onOpen?: () => void
  disabled: boolean
}) {
  const t = useTranslations("QuickAsk")
  const [open, setOpen] = useState(false)
  const current = sessions.find((s) => s.id === value)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (disabled) return
        setOpen(o)
        if (o) onOpen?.()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 min-w-0 max-w-[15rem] gap-1.5 rounded-full px-2.5 text-[0.8125rem] font-medium"
          data-testid="qa-session-picker"
        >
          <MessagesSquare
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-start",
              !current && "text-muted-foreground"
            )}
          >
            {current
              ? (current.title ?? t("session.untitled"))
              : t("session.placeholder")}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] p-0">
        <Command>
          <CommandInput placeholder={t("session.search")} />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("session.empty")}</CommandEmpty>
            {sessions.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.id} ${s.title ?? ""} ${s.folderName}`}
                onSelect={() => {
                  onChange(s.id)
                  setOpen(false)
                }}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">
                    {s.title ?? t("session.untitled")}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {s.folderName} · {getAgentLabel(s.agentType)}
                  </span>
                </div>
                {s.id === value ? <Check className="size-4 shrink-0" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export const TargetPicker = memo(function TargetPicker({
  target,
  onTargetChange,
  folders,
  folderId,
  onFolderChange,
  sessions,
  sessionId,
  onSessionChange,
  onSessionsOpen,
  locked,
}: {
  target: QuickAskTargetKind
  onTargetChange: (target: QuickAskTargetKind) => void
  folders: FolderDetail[]
  folderId: number | null
  onFolderChange: (id: number) => void
  sessions: QuickAskSessionOption[]
  sessionId: number | null
  onSessionChange: (id: number) => void
  onSessionsOpen?: () => void
  /** A question is open: the target can't change until "New question". */
  locked: boolean
}) {
  const t = useTranslations("QuickAsk")
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div
        role="radiogroup"
        aria-label={t("targetLabel")}
        className="flex shrink-0 items-center rounded-full bg-muted/70 p-0.5"
      >
        {QUICK_ASK_TARGETS.map((kind) => {
          const Icon = TARGET_ICONS[kind]
          const selected = kind === target
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={locked && !selected}
              onClick={() => onTargetChange(kind)}
              data-testid={`qa-target-${kind}`}
              className={cn(
                "flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors",
                "hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                selected && "bg-background text-foreground shadow-sm"
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {t(TARGET_LABEL_KEYS[kind])}
            </button>
          )
        })}
      </div>
      {target === "new" && (
        <FolderSelect
          folders={folders}
          value={folderId}
          onChange={onFolderChange}
          placeholder={t("folder.placeholder")}
          variant="ghost"
          disabled={locked}
          className="max-w-[12rem]"
        />
      )}
      {target === "existing" && (
        <SessionSelect
          sessions={sessions}
          value={sessionId}
          onChange={onSessionChange}
          onOpen={onSessionsOpen}
          disabled={locked}
        />
      )}
    </div>
  )
})
