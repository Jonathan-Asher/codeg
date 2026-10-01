/**
 * What a composer shows in its mode / model / effort chips, per conversation.
 *
 * The connection store keeps the last option lists ANY session of an agent type
 * reported (`getCachedSelectors`). Those lists are a fine template for an
 * agent's SHAPE — which selectors it has, the labels of their values — but
 * their current values belong to whichever session reported them last. Showing
 * them on a tab whose own session was not attached yet (idle-swept, reopened
 * after a restart, opened in a second window, a brand-new chat) made one
 * conversation display the model and effort just picked in another, which reads
 * exactly like the pick having changed that conversation too.
 *
 * So a tab shows, in order:
 *   1. its own connection's values, once the agent reported them;
 *   2. otherwise its own stored values laid over the template: an existing
 *      conversation's record (`DbConversationSummary.selector_state`, kept per
 *      conversation by the backend), or — for a brand-new chat only — the
 *      per-agent picks it will be started with;
 *   3. otherwise nothing (the composer shows its loading placeholder).
 * Never another session's current values.
 */

import { isModelConfigOption } from "@/lib/model-config-groups"
import type {
  ConversationSelectorState,
  SessionConfigOptionInfo,
  SessionModeStateInfo,
} from "@/lib/types"

/** The mode + config values one session runs with. */
export interface SelectorValues {
  modeId: string | null
  configValues: Record<string, string> | null
}

export interface DisplayedSelectors {
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
}

export const NO_SELECTORS: DisplayedSelectors = Object.freeze({
  modes: null,
  configOptions: null,
}) as DisplayedSelectors

/** A conversation's stored record as {@link SelectorValues}, or `null` when
 *  nothing is recorded. */
export function selectorValuesFromRecord(
  record: ConversationSelectorState | null | undefined
): SelectorValues | null {
  if (!record) return null
  const modeId = record.modeId ?? null
  const configValues =
    record.configValues && Object.keys(record.configValues).length > 0
      ? record.configValues
      : null
  if (!modeId && !configValues) return null
  return { modeId, configValues }
}

/** A context-window hint on a model id, as claude-agent-acp spelled its 1M rows
 *  before 0.84 (`opus[1m]`, `sonnet[1m]`). */
const CONTEXT_HINT_SUFFIX = /\[\d+[mk]\]$/i

function selectValues(option: SessionConfigOptionInfo): string[] {
  if (option.kind.type !== "select") return []
  const values = option.kind.options.map((o) => o.value)
  for (const group of option.kind.groups ?? []) {
    for (const o of group.options) values.push(o.value)
  }
  return values
}

/**
 * The value `option` offers for a stored `value`, or `null` when it offers none.
 *
 * A model id stored with a context hint the agent no longer lists maps onto the
 * same model's plain row: claude-agent-acp 0.84 dropped `opus[1m]` because its
 * `opus` row now runs Opus 5.5 with the 1M window itself. The backend applies
 * the same mapping when it re-establishes the session.
 */
export function offeredSelectValue(
  option: SessionConfigOptionInfo,
  value: string
): string | null {
  const values = selectValues(option)
  if (values.includes(value)) return value
  if (isModelConfigOption(option) && CONTEXT_HINT_SUFFIX.test(value)) {
    const base = value.replace(CONTEXT_HINT_SUFFIX, "")
    if (base && values.includes(base)) return base
  }
  return null
}

/**
 * `values` laid over an agent's option `template`: each option the values name
 * shows that value; an option they don't name — or name a value the template
 * can't label — is left out rather than shown with the template's (another
 * session's) current value.
 */
export function overlaySelectorValues(
  template: DisplayedSelectors | null,
  values: SelectorValues | null
): DisplayedSelectors {
  if (!template || !values) return NO_SELECTORS
  let modes: SessionModeStateInfo | null = null
  if (
    values.modeId &&
    template.modes?.available_modes.some((m) => m.id === values.modeId)
  ) {
    modes = { ...template.modes, current_mode_id: values.modeId }
  }
  const configOptions: SessionConfigOptionInfo[] = []
  for (const option of template.configOptions ?? []) {
    const stored = values.configValues?.[option.id]
    if (stored == null) continue
    if (option.kind.type === "select") {
      const offered = offeredSelectValue(option, stored)
      if (offered == null) continue
      configOptions.push({
        ...option,
        kind: { ...option.kind, current_value: offered },
      })
    } else if (option.kind.type === "boolean") {
      configOptions.push({
        ...option,
        kind: { ...option.kind, current_value: stored === "true" },
      })
    }
  }
  if (!modes && configOptions.length === 0) return NO_SELECTORS
  return {
    modes,
    configOptions: configOptions.length > 0 ? configOptions : null,
  }
}

/**
 * What a tab's composer shows: its own connection's selectors when the agent
 * has reported them, else its own stored values over the agent's template.
 *
 * `live` must be the tab's OWN connection (null when there is none, or when it
 * is still bound to a different agent than the one the tab shows).
 */
export function resolveDisplayedSelectors({
  live,
  stored,
  template,
}: {
  live: DisplayedSelectors | null
  stored: SelectorValues | null
  template: DisplayedSelectors | null
}): DisplayedSelectors {
  if (live && (live.modes != null || live.configOptions != null)) return live
  return overlaySelectorValues(template, stored)
}
