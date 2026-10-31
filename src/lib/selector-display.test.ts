import { describe, expect, it } from "vitest"
import {
  NO_SELECTORS,
  offeredSelectValue,
  overlaySelectorLayers,
  overlaySelectorValues,
  recommendedSelectorValues,
  resolveDisplayedSelectors,
  selectorValuesFromRecord,
  withSelectorPicks,
  type DisplayedSelectors,
} from "@/lib/selector-display"
import type { SessionConfigOptionInfo, SessionModeStateInfo } from "@/lib/types"

function select(
  id: string,
  current: string,
  values: string[],
  category: string | null = null
): SessionConfigOptionInfo {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    category,
    kind: {
      type: "select",
      current_value: current,
      options: values.map((value) => ({ value, name: value.toUpperCase() })),
      groups: [],
    },
  }
}

const MODES: SessionModeStateInfo = {
  current_mode_id: "default",
  available_modes: [
    { id: "default", name: "Manual" },
    { id: "plan", name: "Plan" },
  ],
}

/** What the per-agent cache holds after session A (Sonnet / Low, Plan) was the
 *  last one to report. */
const LAST_SEEN_FROM_A: DisplayedSelectors = {
  modes: { ...MODES, current_mode_id: "plan" },
  configOptions: [
    select("model", "sonnet", ["opus", "sonnet", "haiku"], "model"),
    select("effort", "low", ["low", "medium", "high", "max"], "thought_level"),
  ],
}

function currentValues(selectors: DisplayedSelectors) {
  return Object.fromEntries(
    (selectors.configOptions ?? []).map((o) => [o.id, o.kind.current_value])
  )
}

describe("selectorValuesFromRecord", () => {
  it("reads a conversation's record", () => {
    expect(
      selectorValuesFromRecord({
        modeId: "plan",
        configValues: { model: "opus", effort: "max" },
      })
    ).toEqual({
      modeId: "plan",
      configValues: { model: "opus", effort: "max" },
    })
  })

  it("treats a missing or empty record as nothing recorded", () => {
    expect(selectorValuesFromRecord(undefined)).toBeNull()
    expect(selectorValuesFromRecord(null)).toBeNull()
    expect(selectorValuesFromRecord({})).toBeNull()
    expect(selectorValuesFromRecord({ configValues: {} })).toBeNull()
  })
})

describe("resolveDisplayedSelectors — no session shows another's values", () => {
  const B_RECORD = {
    modeId: "default",
    configValues: { model: "opus", effort: "max" },
  }

  it("a tab whose session is not attached shows its own record over the template", () => {
    const shown = resolveDisplayedSelectors({
      live: null,
      stored: B_RECORD,
      template: LAST_SEEN_FROM_A,
    })
    expect(currentValues(shown)).toEqual({ model: "opus", effort: "max" })
    expect(shown.modes?.current_mode_id).toBe("default")
    // The labels still come from the agent's list.
    expect(shown.configOptions?.[0]?.kind).toMatchObject({
      type: "select",
      options: expect.arrayContaining([{ value: "opus", name: "OPUS" }]),
    })
  })

  it("an attaching connection with no data of its own does not fall back to the template's values", () => {
    const shown = resolveDisplayedSelectors({
      live: { modes: null, configOptions: null },
      stored: null,
      template: LAST_SEEN_FROM_A,
    })
    expect(shown).toEqual(NO_SELECTORS)
  })

  it("the connection's own values win once the agent reported them", () => {
    const own: DisplayedSelectors = {
      modes: MODES,
      configOptions: [
        select("model", "opus", ["opus", "sonnet"], "model"),
        select("effort", "max", ["low", "max"]),
      ],
    }
    const shown = resolveDisplayedSelectors({
      live: own,
      stored: { modeId: "plan", configValues: { model: "sonnet" } },
      template: LAST_SEEN_FROM_A,
    })
    expect(shown).toBe(own)
  })

  it("keeps the stored config values while the agent has reported only its modes", () => {
    // The agent reports its modes before it has applied and reported the
    // config options: the chips keep the conversation's own values meanwhile.
    const shown = resolveDisplayedSelectors({
      live: { modes: MODES, configOptions: null },
      stored: B_RECORD,
      template: LAST_SEEN_FROM_A,
    })
    expect(shown.modes).toBe(MODES)
    expect(currentValues(shown)).toEqual({ model: "opus", effort: "max" })
  })

  it("a brand-new chat shows the per-agent picks it will be started with", () => {
    const shown = resolveDisplayedSelectors({
      live: null,
      stored: { modeId: null, configValues: { model: "haiku" } },
      template: LAST_SEEN_FROM_A,
    })
    // Only what the picks name: effort was never picked, so the template's
    // (session A's) Low is not shown as this chat's.
    expect(currentValues(shown)).toEqual({ model: "haiku" })
    expect(shown.modes).toBeNull()
  })

  it("shows nothing without a template to label the values", () => {
    expect(
      resolveDisplayedSelectors({
        live: null,
        stored: B_RECORD,
        template: null,
      })
    ).toEqual(NO_SELECTORS)
  })
})

describe("overlaySelectorValues", () => {
  it("leaves out a value the template cannot label instead of showing the template's", () => {
    const shown = overlaySelectorValues(LAST_SEEN_FROM_A, {
      modeId: "acceptEdits",
      configValues: { model: "opus", effort: "ultra" },
    })
    expect(currentValues(shown)).toEqual({ model: "opus" })
    expect(shown.modes).toBeNull()
  })

  it("reads a boolean option's stored value", () => {
    const template: DisplayedSelectors = {
      modes: null,
      configOptions: [
        {
          id: "auto_approve",
          name: "Auto-approve",
          kind: { type: "boolean", current_value: false },
        },
      ],
    }
    const shown = overlaySelectorValues(template, {
      modeId: null,
      configValues: { auto_approve: "true" },
    })
    expect(shown.configOptions?.[0]?.kind.current_value).toBe(true)
  })
})

describe("offeredSelectValue — model ids an agent stopped listing", () => {
  const model084 = select(
    "model",
    "opus",
    ["opus", "claude-fable-5-1", "sonnet", "haiku"],
    "model"
  )

  it("maps a 1M-context id from before claude-agent-acp 0.84 onto its plain row", () => {
    expect(offeredSelectValue(model084, "opus[1m]")).toBe("opus")
    expect(offeredSelectValue(model084, "sonnet[1M]")).toBe("sonnet")
  })

  it("keeps a value the agent still lists, and maps nothing else", () => {
    expect(offeredSelectValue(model084, "haiku")).toBe("haiku")
    expect(offeredSelectValue(model084, "opusplan")).toBeNull()
    expect(offeredSelectValue(model084, "claude-opus-5[1m]")).toBeNull()
  })

  it("only rewrites the model selector", () => {
    const other = select("context", "1m", ["opus"])
    expect(offeredSelectValue(other, "opus[1m]")).toBeNull()
  })

  it("lets a record from before 0.84 show the model the session will run", () => {
    const shown = overlaySelectorValues(
      { modes: null, configOptions: [model084] },
      { modeId: null, configValues: { model: "opus[1m]" } }
    )
    expect(currentValues(shown)).toEqual({ model: "opus" })
  })
})

describe("a brand-new chat before its session is up", () => {
  /** The remembered lists, with session A's current values (Sonnet / Low)
   *  and the agent's own recommendation for the effort. */
  const REMEMBERED: DisplayedSelectors = {
    modes: { ...MODES, current_mode_id: "plan" },
    configOptions: [
      select("model", "sonnet", ["opus", "sonnet", "haiku"], "model"),
      {
        ...select(
          "effort",
          "low",
          ["low", "medium", "high", "max"],
          "thought_level"
        ),
        recommended_value: "high",
      },
    ],
  }

  it("shows every remembered selector with what the chat will start with", () => {
    const shown = resolveDisplayedSelectors({
      live: null,
      // The user's saved pick for the model...
      stored: { modeId: null, configValues: { model: "haiku" } },
      template: REMEMBERED,
      defaults: [
        // ...what the agent's last new session started with...
        { modeId: "default", configValues: { model: "opus" } },
        // ...and what the agent recommends.
        recommendedSelectorValues(REMEMBERED),
      ],
    })
    expect(currentValues(shown)).toEqual({ model: "haiku", effort: "high" })
    expect(shown.modes?.current_mode_id).toBe("default")
  })

  it("never shows another session's current value for an option nothing fills", () => {
    const shown = resolveDisplayedSelectors({
      live: null,
      stored: null,
      template: {
        modes: null,
        configOptions: [select("model", "sonnet", ["opus", "sonnet"], "model")],
      },
      defaults: [null, null],
    })
    expect(shown).toEqual(NO_SELECTORS)
  })

  it("falls back silently from a saved pick the agent no longer offers", () => {
    const shown = overlaySelectorLayers(REMEMBERED, [
      { modeId: "gone", configValues: { model: "opus-4", effort: "max" } },
      { modeId: "default", configValues: { model: "opus" } },
    ])
    expect(currentValues(shown)).toEqual({ model: "opus", effort: "max" })
    expect(shown.modes?.current_mode_id).toBe("default")
  })

  it("switches to the live lists once the session reports, replacing the remembered ones", () => {
    const live: DisplayedSelectors = {
      modes: MODES,
      configOptions: [select("model", "opus-6", ["opus-6", "sonnet"], "model")],
    }
    expect(
      resolveDisplayedSelectors({
        live,
        stored: { modeId: null, configValues: { model: "haiku" } },
        template: REMEMBERED,
        defaults: [recommendedSelectorValues(REMEMBERED)],
      })
    ).toBe(live)
  })
})

describe("recommendedSelectorValues", () => {
  it("collects the select options' recommendations", () => {
    expect(
      recommendedSelectorValues({
        modes: null,
        configOptions: [
          { ...select("model", "a", ["a", "b"]), recommended_value: "b" },
          select("effort", "low", ["low"]),
        ],
      })
    ).toEqual({ modeId: null, configValues: { model: "b" } })
  })

  it("is nothing when no option recommends anything", () => {
    expect(recommendedSelectorValues(LAST_SEEN_FROM_A)).toBeNull()
    expect(recommendedSelectorValues(null)).toBeNull()
  })
})

describe("withSelectorPicks", () => {
  it("shows a pick still on its way over the value the session reported", () => {
    const live: DisplayedSelectors = {
      modes: MODES,
      configOptions: [
        select("model", "sonnet", ["opus", "sonnet"], "model"),
        select("effort", "low", ["low", "max"]),
      ],
    }
    const shown = withSelectorPicks(live, { effort: "max", model: "gpt" })
    // The model the session does not offer stays as reported.
    expect(currentValues(shown)).toEqual({ model: "sonnet", effort: "max" })
    expect(shown.modes).toBe(MODES)
  })

  it("leaves the selectors untouched without picks", () => {
    expect(withSelectorPicks(LAST_SEEN_FROM_A, null)).toBe(LAST_SEEN_FROM_A)
    expect(withSelectorPicks(LAST_SEEN_FROM_A, { effort: "low" })).toBe(
      LAST_SEEN_FROM_A
    )
  })
})
