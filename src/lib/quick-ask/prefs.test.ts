import { beforeEach, describe, expect, it } from "vitest"

import {
  QUICK_ASK_PREFS_KEY,
  backendKey,
  defaultQuickAskPrefs,
  pickDefaultFolder,
  publishActiveFolder,
  quickAskConfigValues,
  readActiveFolder,
  readQuickAskPrefs,
  updateQuickAskPrefs,
  withConfigValue,
} from "./prefs"

describe("Quick Ask prefs", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("starts on a new session with Claude Code", () => {
    const prefs = readQuickAskPrefs()
    expect(prefs).toEqual(defaultQuickAskPrefs())
    expect(prefs.target).toBe("new")
    expect(prefs.agent).toBe("claude_code")
  })

  it("remembers the target choice across reads", () => {
    updateQuickAskPrefs((p) => ({ ...p, target: "private" }))
    expect(readQuickAskPrefs().target).toBe("private")
    updateQuickAskPrefs((p) => ({ ...p, target: "existing" }))
    expect(readQuickAskPrefs().target).toBe("existing")
  })

  it("repairs malformed storage back to defaults, field by field", () => {
    window.localStorage.setItem(
      QUICK_ASK_PREFS_KEY,
      JSON.stringify({
        target: "somewhere",
        agent: 42,
        configValues: { codex: { model: "gpt", effort: 3 } },
        folderByBackend: { local: 5, "remote:1": "x" },
        sessionByBackend: null,
      })
    )
    const prefs = readQuickAskPrefs()
    expect(prefs.target).toBe("new")
    expect(prefs.agent).toBe("claude_code")
    expect(prefs.configValues).toEqual({ codex: { model: "gpt" } })
    expect(prefs.folderByBackend).toEqual({ local: 5 })
    expect(prefs.sessionByBackend).toEqual({})

    window.localStorage.setItem(QUICK_ASK_PREFS_KEY, "{not json")
    expect(readQuickAskPrefs()).toEqual(defaultQuickAskPrefs())
  })

  it("defaults Claude Code to a fast model at low effort", () => {
    expect(quickAskConfigValues(defaultQuickAskPrefs(), "claude_code")).toEqual(
      { model: "haiku", effort: "low" }
    )
    // No defaults invented for other agents.
    expect(quickAskConfigValues(defaultQuickAskPrefs(), "codex")).toEqual({})
  })

  it("keeps its model picks apart from the workspace's per-agent picks", () => {
    window.localStorage.setItem(
      "codeg:selector-prefs",
      JSON.stringify({ claude_code: { configValues: { model: "opus" } } })
    )
    const prefs = updateQuickAskPrefs((p) =>
      withConfigValue(p, "claude_code", "model", "sonnet")
    )
    expect(quickAskConfigValues(prefs, "claude_code")).toEqual({
      model: "sonnet",
      effort: "low",
    })
    // The composer's saved pick is untouched.
    expect(
      JSON.parse(window.localStorage.getItem("codeg:selector-prefs")!)
    ).toEqual({ claude_code: { configValues: { model: "opus" } } })
  })

  it("remembers folders per backend", () => {
    updateQuickAskPrefs((p) => ({
      ...p,
      folderByBackend: {
        ...p.folderByBackend,
        [backendKey(null)]: 3,
        [backendKey(7)]: 9,
      },
    }))
    const prefs = readQuickAskPrefs()
    expect(prefs.folderByBackend.local).toBe(3)
    expect(prefs.folderByBackend["remote:7"]).toBe(9)
  })

  it("publishes the workspace's active folder per backend", () => {
    publishActiveFolder(null, 4)
    publishActiveFolder(2, 11)
    expect(readActiveFolder(null)).toBe(4)
    expect(readActiveFolder(2)).toBe(11)
    publishActiveFolder(null, null)
    expect(readActiveFolder(null)).toBeNull()
  })

  it("starts in the last used folder, else the active one, else the first", () => {
    expect(pickDefaultFolder([1, 2, 3], 2, 3)).toBe(2)
    // The remembered folder is gone: fall back to the workspace's.
    expect(pickDefaultFolder([1, 3], 2, 3)).toBe(3)
    expect(pickDefaultFolder([1, 3], undefined, null)).toBe(1)
    expect(pickDefaultFolder([], 2, 3)).toBeNull()
  })
})
