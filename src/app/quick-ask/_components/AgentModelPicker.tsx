"use client"

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { Bot, Check, ChevronDown, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useModelLabels } from "@/hooks/use-model-labels"
import { getAgentLabel } from "@/lib/custom-agents"
import type {
  AgentType,
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Every choice of a select option, groups flattened, first occurrence wins. */
export function selectChoices(
  option: SessionConfigOptionInfo | null | undefined
): SessionConfigSelectOptionInfo[] {
  if (!option || option.kind.type !== "select") return []
  const seen = new Set<string>()
  const out: SessionConfigSelectOptionInfo[] = []
  const take = (choice: SessionConfigSelectOptionInfo) => {
    if (seen.has(choice.value)) return
    seen.add(choice.value)
    out.push(choice)
  }
  option.kind.options.forEach(take)
  option.kind.groups.forEach((group) => group.options.forEach(take))
  return out
}

/** The session's model option (Claude Code: id `model`). */
export function findModelOption(
  options: SessionConfigOptionInfo[] | null
): SessionConfigOptionInfo | null {
  return (
    options?.find(
      (o) =>
        o.kind.type === "select" && (o.category === "model" || o.id === "model")
    ) ?? null
  )
}

/** The session's effort option (Claude Code: id `effort`, category
 *  `thought_level`). */
export function findEffortOption(
  options: SessionConfigOptionInfo[] | null
): SessionConfigOptionInfo | null {
  return (
    options?.find(
      (o) =>
        o.kind.type === "select" &&
        (o.category === "thought_level" || o.id === "effort")
    ) ?? null
  )
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value
}

function currentValueOf(
  option: SessionConfigOptionInfo | null,
  fallback: string | undefined
): string | null {
  if (option && option.kind.type === "select") return option.kind.current_value
  return fallback ?? null
}

function ChoiceList({
  title,
  choices,
  value,
  onPick,
  disabled,
  testId,
}: {
  title: string
  choices: SessionConfigSelectOptionInfo[]
  value: string | null
  onPick: (value: string) => void
  disabled: boolean
  testId: string
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <div className="px-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          disabled={disabled}
          onClick={() => onPick(choice.value)}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-60",
            choice.value === value && "font-medium"
          )}
        >
          <span className="min-w-0 flex-1 truncate">{choice.name}</span>
          {choice.value === value ? <Check className="size-3.5" /> : null}
        </button>
      ))}
    </div>
  )
}

export const AgentModelPicker = memo(function AgentModelPicker({
  agentType,
  agents,
  onAgentChange,
  agentLocked,
  configOptions,
  savedValues,
  onValueChange,
  readOnly,
  loading,
  onOpen,
}: {
  agentType: AgentType
  /** Installed agents the user can pick. */
  agents: { agentType: AgentType; name: string }[]
  onAgentChange: (agent: AgentType) => void
  agentLocked: boolean
  /** The live session's options, when it runs `agentType`. */
  configOptions: SessionConfigOptionInfo[] | null
  /** Quick Ask's saved picks for `agentType`, shown before a session exists. */
  savedValues: Record<string, string>
  onValueChange: (configId: string, valueId: string) => void
  /** An existing session keeps its own model and effort. */
  readOnly: boolean
  loading: boolean
  /** Opening the picker starts the agent so its model list is known. */
  onOpen: () => void
}) {
  const t = useTranslations("QuickAsk")
  const [open, setOpen] = useState(false)
  const modelLabel = useModelLabels(agentType)

  const modelOption = findModelOption(configOptions)
  const effortOption = findEffortOption(configOptions)
  const model = currentValueOf(modelOption, savedValues.model)
  const effort = currentValueOf(effortOption, savedValues.effort)
  // Before a session exists the label comes from the names the agent gave
  // earlier (remembered per agent), else the id itself, capitalized.
  const rememberedName = model ? modelLabel(model) : null
  const modelName =
    selectChoices(modelOption).find((c) => c.value === model)?.name ??
    (model
      ? rememberedName && rememberedName !== model
        ? rememberedName
        : capitalize(model)
      : null)
  const effortName =
    selectChoices(effortOption).find((c) => c.value === effort)?.name ??
    (effort ? capitalize(effort) : null)

  const summary = [getAgentLabel(agentType), modelName, effortName]
    .filter(Boolean)
    .join(" · ")

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 min-w-0 max-w-[16rem] shrink gap-1.5 rounded-full px-2 text-[11px] font-medium text-muted-foreground"
          data-testid="qa-model-picker"
        >
          <Bot className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="flex max-h-[18rem] w-72 flex-col gap-3 overflow-y-auto p-2"
      >
        {readOnly ? (
          <p className="px-2 text-xs text-muted-foreground">
            {t("picker.sessionOwnsModel")}
          </p>
        ) : modelOption || effortOption ? (
          <>
            {modelOption && (
              <ChoiceList
                title={t("picker.model")}
                choices={selectChoices(modelOption)}
                value={model}
                onPick={(v) => onValueChange(modelOption.id, v)}
                disabled={false}
                testId="qa-model-list"
              />
            )}
            {effortOption && (
              <ChoiceList
                title={t("picker.effort")}
                choices={selectChoices(effortOption)}
                value={effort}
                onPick={(v) => onValueChange(effortOption.id, v)}
                disabled={false}
                testId="qa-effort-list"
              />
            )}
          </>
        ) : loading ? (
          <p className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("picker.loadingOptions")}
          </p>
        ) : (
          <p className="px-2 text-xs text-muted-foreground">
            {t("picker.noOptions")}
          </p>
        )}
        <div className="flex flex-col gap-0.5" data-testid="qa-agent-list">
          <div className="px-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("picker.agent")}
          </div>
          {agents.map((agent) => (
            <button
              key={agent.agentType}
              type="button"
              disabled={agentLocked}
              onClick={() => onAgentChange(agent.agentType)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-60",
                agent.agentType === agentType && "font-medium"
              )}
            >
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.agentType === agentType ? (
                <Check className="size-3.5" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
})
