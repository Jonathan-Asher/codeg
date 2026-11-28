import { describe, expect, it } from "vitest"
import {
  NO_SELECTORS,
  resolveDisplayedSelectors,
  type DisplayedSelectors,
  type SelectorValues,
} from "@/lib/selector-display"
import { sessionOnlyDefaults } from "@/lib/selector-prefs-storage"
import type { SessionConfigOptionInfo } from "@/lib/types"

// Grok's selectors as a Mac on 0.47.1-fork.256 with grok 1.0.92 remembered
// them (`codeg:selector-options`, written from a live `session_config_options`
// after a model catalog broadcast): Grok's model and effort, and the
// permission selector codeg builds, the session on Always approve.
const MAC_TEMPLATE: SessionConfigOptionInfo[] = [
  {
    id: "model",
    name: "Model",
    kind: {
      type: "select",
      current_value: "grok-4.7-build-fast",
      options: [
        { value: "grok-4.7", name: "Grok 4.7", description: null },
        {
          value: "grok-4.7-build-fast",
          name: "Grok 4.7 Fast",
          description: null,
        },
        { value: "grok-4.6", name: "Grok 4.6", description: null },
        { value: "grok-4.5", name: "Grok 4.5", description: null },
      ],
      groups: [],
    },
    description: null,
    category: "model",
    recommended_value: null,
  },
  {
    id: "mode",
    name: "Mode",
    kind: {
      type: "select",
      current_value: "bypassPermissions",
      options: [
        {
          value: "default",
          name: "Ask",
          description: "Asks before edits and commands",
        },
        {
          value: "auto",
          name: "Auto",
          description: "Grok checks each call and asks only when it is unsure",
        },
        {
          value: "bypassPermissions",
          name: "Always approve",
          description:
            "Runs every tool call without asking; deny rules still apply",
        },
      ],
      groups: [],
    },
    description: "Session permission mode",
    category: "mode",
    recommended_value: null,
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    kind: {
      type: "select",
      current_value: "xhigh",
      options: [
        {
          value: "xhigh",
          name: "Max",
          description: "Maximum reasoning for the hardest tasks.",
        },
        {
          value: "high",
          name: "High",
          description: "Thorough reasoning and quality. Recommended.",
        },
        {
          value: "medium",
          name: "Medium",
          description: "Strong quality with a faster turnaround.",
        },
        {
          value: "low",
          name: "Low",
          description: "Fastest responses. Best for simple tasks.",
        },
      ],
      groups: [],
    },
    description: null,
    category: "thought_level",
    recommended_value: null,
  },
]

const template: DisplayedSelectors = {
  modes: null,
  configOptions: MAC_TEMPLATE,
}

/** A conversation that never picked a mode: its record, as the backend keeps
 *  it, names only the model and effort. */
const UNPICKED_RECORD: SelectorValues = {
  modeId: null,
  configValues: { model: "grok-4.7-build-fast", reasoning_effort: "xhigh" },
}

/** What that Mac's composer remembered for a new Grok chat: the per-agent
 *  picks (a mode is never saved as one) and what an older version's new
 *  session started with (before there was a mode). */
const SAVED_PICKS: SelectorValues = UNPICKED_RECORD
const OLD_NEW_SESSION: SelectorValues = {
  modeId: null,
  configValues: { model: "grok-4.6", reasoning_effort: "high" },
}

function shown(selectors: DisplayedSelectors) {
  return Object.fromEntries(
    (selectors.configOptions ?? []).map((o) => [o.id, o.kind.current_value])
  )
}

describe("Grok's permission mode before the session reports", () => {
  it("was left out of a chat that never picked one", () => {
    // The rule that keeps another session's values off a tab: an option no
    // stored value fills is not shown. Nothing ever fills Grok's mode.
    const before = resolveDisplayedSelectors({
      live: null,
      stored: UNPICKED_RECORD,
      template,
    })
    expect(shown(before)).toEqual({
      model: "grok-4.7-build-fast",
      reasoning_effort: "xhigh",
    })
  })

  it("shows, in a chat that never picked one, the mode its Grok settings launch it in", () => {
    const displayed = resolveDisplayedSelectors({
      live: null,
      stored: UNPICKED_RECORD,
      template,
      sessionDefaults: sessionOnlyDefaults("grok", "bypassPermissions"),
    })
    expect(shown(displayed)).toEqual({
      model: "grok-4.7-build-fast",
      mode: "bypassPermissions",
      reasoning_effort: "xhigh",
    })
    // Not the template's value: a chat launched in Ask shows Ask.
    expect(
      shown(
        resolveDisplayedSelectors({
          live: null,
          stored: UNPICKED_RECORD,
          template,
          sessionDefaults: sessionOnlyDefaults("grok", null),
        })
      ).mode
    ).toBe("default")
  })

  it("shows a brand-new chat's mode next to its saved model and effort", () => {
    const displayed = resolveDisplayedSelectors({
      live: null,
      stored: SAVED_PICKS,
      template,
      sessionDefaults: sessionOnlyDefaults("grok", "bypassPermissions"),
      defaults: [OLD_NEW_SESSION, null],
    })
    expect(shown(displayed)).toEqual({
      model: "grok-4.7-build-fast",
      mode: "bypassPermissions",
      reasoning_effort: "xhigh",
    })
  })

  it("keeps a mode the conversation picked over the Grok settings", () => {
    const displayed = resolveDisplayedSelectors({
      live: null,
      stored: {
        modeId: null,
        configValues: { ...UNPICKED_RECORD.configValues, mode: "auto" },
      },
      template,
      sessionDefaults: sessionOnlyDefaults("grok", "bypassPermissions"),
    })
    expect(shown(displayed).mode).toBe("auto")
  })

  it("does not turn the loading placeholder into a chip of the mode alone", () => {
    expect(
      resolveDisplayedSelectors({
        live: null,
        stored: null,
        template,
        sessionDefaults: sessionOnlyDefaults("grok", "bypassPermissions"),
      })
    ).toBe(NO_SELECTORS)
  })

  it("leaves the mode out when the remembered list cannot show the launch mode", () => {
    // Settings moved to a fixed launch mode the remembered base row predates.
    const displayed = resolveDisplayedSelectors({
      live: null,
      stored: UNPICKED_RECORD,
      template,
      sessionDefaults: sessionOnlyDefaults("grok", "acceptEdits"),
    })
    expect(shown(displayed)).not.toHaveProperty("mode")
  })

  it("gives way to the session's own values once it reports", () => {
    const live = MAC_TEMPLATE.map((o) =>
      o.id === "mode" && o.kind.type === "select"
        ? { ...o, kind: { ...o.kind, current_value: "auto" } }
        : o
    )
    const displayed = resolveDisplayedSelectors({
      live: { modes: null, configOptions: live },
      stored: UNPICKED_RECORD,
      template,
      sessionDefaults: sessionOnlyDefaults("grok", "bypassPermissions"),
    })
    expect(displayed.configOptions).toBe(live)
  })
})

describe("sessionOnlyDefaults", () => {
  it("is the mode Grok is launched in, Ask when the settings name none or an unknown one", () => {
    const mode = (setting: string | null) =>
      sessionOnlyDefaults("grok", setting)?.configValues?.mode
    expect(mode("bypassPermissions")).toBe("bypassPermissions")
    expect(mode("auto")).toBe("auto")
    expect(mode("acceptEdits")).toBe("acceptEdits")
    expect(mode("plan")).toBe("plan")
    expect(mode("dontAsk")).toBe("dontAsk")
    expect(mode("default")).toBe("default")
    expect(mode(null)).toBe("default")
    expect(mode("yolo")).toBe("default")
  })

  it("claims nothing while Grok's settings are unknown, or for another agent", () => {
    expect(sessionOnlyDefaults("grok", undefined)).toBeNull()
    expect(sessionOnlyDefaults("claude_code", "bypassPermissions")).toBeNull()
  })
})
