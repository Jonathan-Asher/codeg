import { describe, expect, it } from "vitest"

import {
  isResumeAfterRestartPrompt,
  RESUME_AFTER_RESTART_PROMPT,
  RESUME_BACKGROUND_PROMPT_HEAD,
  RESUME_BACKGROUND_PROMPT_TAIL,
  RESUME_TURN_BACKGROUND_HEADER,
  resumeAfterRestartItems,
  resumeAfterRestartKind,
} from "./auto-resume"
import {
  continuationVariant,
  type ContinuationGroupLike,
} from "./continue-turn"

/** The background prompt as the backend words it (`resume_prompt`). */
const BACKGROUND_PROMPT = [
  RESUME_BACKGROUND_PROMPT_HEAD,
  "- sub-agent: Review the parser (started 13:02)",
  "- background shell: sleep 900",
  RESUME_BACKGROUND_PROMPT_TAIL,
].join("\n")

/** A cut-off turn that also had background work running. */
const TURN_PROMPT_WITH_LIST = `${RESUME_AFTER_RESTART_PROMPT}\n\n${RESUME_TURN_BACKGROUND_HEADER}\n- monitor: main run: errors`

function textGroup(text: string): ContinuationGroupLike {
  return {
    role: "user",
    parts: [{ type: "text", text }],
    images: [],
    resources: [],
  }
}

describe("resumeAfterRestartKind", () => {
  it("recognizes both resume prompts by how they start", () => {
    expect(resumeAfterRestartKind(RESUME_AFTER_RESTART_PROMPT)).toBe("turn")
    expect(resumeAfterRestartKind(`  ${RESUME_AFTER_RESTART_PROMPT}\n`)).toBe(
      "turn"
    )
    expect(resumeAfterRestartKind(TURN_PROMPT_WITH_LIST)).toBe("turn")
    expect(resumeAfterRestartKind(BACKGROUND_PROMPT)).toBe("background")
    expect(isResumeAfterRestartPrompt(BACKGROUND_PROMPT)).toBe(true)
  })

  it("keeps a message the user wrote around the prompt a message", () => {
    expect(
      resumeAfterRestartKind(
        `${RESUME_AFTER_RESTART_PROMPT} Also run the tests.`
      )
    ).toBeNull()
    expect(
      resumeAfterRestartKind(`${RESUME_AFTER_RESTART_PROMPT}\n\nAnd the docs.`)
    ).toBeNull()
    // The head alone, with no list, is not what the backend sends.
    expect(resumeAfterRestartKind(RESUME_BACKGROUND_PROMPT_HEAD)).toBeNull()
    expect(resumeAfterRestartKind("continue")).toBeNull()
  })

  it("lists what the prompt says was stopped", () => {
    expect(resumeAfterRestartItems(BACKGROUND_PROMPT)).toEqual([
      "sub-agent: Review the parser (started 13:02)",
      "background shell: sleep 900",
    ])
    expect(resumeAfterRestartItems(TURN_PROMPT_WITH_LIST)).toEqual([
      "monitor: main run: errors",
    ])
    expect(resumeAfterRestartItems(RESUME_AFTER_RESTART_PROMPT)).toEqual([])
    expect(resumeAfterRestartItems("- not a resume")).toEqual([])
  })

  it("draws each as its own divider", () => {
    expect(continuationVariant(textGroup(RESUME_AFTER_RESTART_PROMPT))).toBe(
      "resumed"
    )
    expect(continuationVariant(textGroup(TURN_PROMPT_WITH_LIST))).toBe(
      "resumed"
    )
    expect(continuationVariant(textGroup(BACKGROUND_PROMPT))).toBe(
      "resumed_background"
    )
  })
})
