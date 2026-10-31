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
 *   3. for a brand-new chat, an option it has no pick for shows what the
 *      chat will start with: what the agent's last brand-new session started
 *      with (`lib/selector-options-cache`), else the value the agent itself
 *      recommends;
 *   4. otherwise nothing (the composer shows its loading placeholder).
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

/** `option` showing `value`, or `null` when it cannot show it. A boolean
 *  option reads anything but `"true"` as off, as the backend does. */
function optionShowing(
  option: SessionConfigOptionInfo,
  value: string
): SessionConfigOptionInfo | null {
  if (option.kind.type === "select") {
    const offered = offeredSelectValue(option, value)
    if (offered == null) return null
    if (offered === option.kind.current_value) return option
    return { ...option, kind: { ...option.kind, current_value: offered } }
  }
  if (option.kind.type === "boolean") {
    const on = value === "true"
    if (on === option.kind.current_value) return option
    return { ...option, kind: { ...option.kind, current_value: on } }
  }
  return null
}

/**
 * Value `layers` laid over an agent's option `template`, first layer first:
 * each option shows the value of the first layer that names one the template
 * can show — a layer whose value the agent no longer offers (a renamed or
 * removed model) falls through to the next. An option no layer can fill is
 * left out rather than shown with the template's (another session's) current
 * value.
 */
export function overlaySelectorLayers(
  template: DisplayedSelectors | null,
  layers: readonly (SelectorValues | null | undefined)[]
): DisplayedSelectors {
  if (!template) return NO_SELECTORS
  const present = layers.filter((l): l is SelectorValues => l != null)
  if (present.length === 0) return NO_SELECTORS
  let modes: SessionModeStateInfo | null = null
  if (template.modes) {
    for (const layer of present) {
      const id = layer.modeId
      if (id && template.modes.available_modes.some((m) => m.id === id)) {
        modes = { ...template.modes, current_mode_id: id }
        break
      }
    }
  }
  const configOptions: SessionConfigOptionInfo[] = []
  for (const option of template.configOptions ?? []) {
    for (const layer of present) {
      const value = layer.configValues?.[option.id]
      if (value == null) continue
      const shown = optionShowing(option, value)
      if (shown) {
        configOptions.push(shown)
        break
      }
    }
  }
  if (!modes && configOptions.length === 0) return NO_SELECTORS
  return {
    modes,
    configOptions: configOptions.length > 0 ? configOptions : null,
  }
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
  return overlaySelectorLayers(template, [values])
}

/** The values the agent itself recommends (`recommended_value`, its stated
 *  default) for the select options of `template`, or `null` when it names
 *  none. */
export function recommendedSelectorValues(
  template: DisplayedSelectors | null
): SelectorValues | null {
  let configValues: Record<string, string> | null = null
  for (const option of template?.configOptions ?? []) {
    if (option.kind.type !== "select") continue
    const recommended = option.recommended_value
    if (!recommended) continue
    configValues ??= {}
    configValues[option.id] = recommended
  }
  return configValues ? { modeId: null, configValues } : null
}

/**
 * The picks a session that is now ready still has to take, model first: a
 * model switch resets the effort to the new model's own default (Claude Code
 * does), so an effort applied before it would be undone. Picks the session
 * already shows, or whose value it no longer offers, are left out.
 */
export function selectorPicksOwed(
  configOptions: SessionConfigOptionInfo[] | null,
  picks: Record<string, string>
): [string, string][] {
  const owed: [string, string][] = []
  for (const option of configOptions ?? []) {
    const pick = picks[option.id]
    if (pick == null) continue
    if (option.kind.type === "select") {
      const offered = offeredSelectValue(option, pick)
      if (offered == null || offered === option.kind.current_value) continue
      owed.push([option.id, offered])
    } else if (option.kind.type === "boolean") {
      if ((pick === "true") === option.kind.current_value) continue
      owed.push([option.id, pick === "true" ? "true" : "false"])
    }
  }
  const isModel = (id: string) =>
    configOptions?.some((o) => o.id === id && isModelConfigOption(o)) ?? false
  return owed.sort(([a], [b]) => Number(isModel(b)) - Number(isModel(a)))
}

/**
 * `picks` shown over `selectors`: picks made while the session was not ready
 * yet, which the composer keeps showing until the agent has taken them. A pick
 * whose value an option does not offer leaves that option as it is.
 */
export function withSelectorPicks(
  selectors: DisplayedSelectors,
  picks: Record<string, string> | null
): DisplayedSelectors {
  if (!picks || !selectors.configOptions) return selectors
  let changed = false
  const configOptions = selectors.configOptions.map((option) => {
    const pick = picks[option.id]
    if (pick == null) return option
    const shown = optionShowing(option, pick)
    if (!shown || shown === option) return option
    changed = true
    return shown
  })
  return changed ? { ...selectors, configOptions } : selectors
}

/**
 * What a tab's composer shows: its own connection's selectors where the agent
 * has reported them, else its own stored values over the agent's template.
 * Modes and config options resolve separately — an agent reports its modes a
 * moment before it has applied and reported its config options, and in that
 * gap the chips keep showing the stored values rather than dropping them.
 *
 * `live` must be the tab's OWN connection (null when there is none, or when it
 * is still bound to a different agent than the one the tab shows).
 *
 * `defaults`: further value layers for an option `stored` does not fill — only
 * a brand-new chat has any (what it will start with; see the module doc).
 */
export function resolveDisplayedSelectors({
  live,
  stored,
  template,
  defaults = [],
}: {
  live: DisplayedSelectors | null
  stored: SelectorValues | null
  template: DisplayedSelectors | null
  defaults?: readonly (SelectorValues | null | undefined)[]
}): DisplayedSelectors {
  if (live && live.modes != null && live.configOptions != null) return live
  const fallback = overlaySelectorLayers(template, [stored, ...defaults])
  if (!live) return fallback
  const modes = live.modes ?? fallback.modes
  const configOptions = live.configOptions ?? fallback.configOptions
  if (modes === null && configOptions === null) return NO_SELECTORS
  return { modes, configOptions }
}
