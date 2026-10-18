import { describe, expect, it } from "vitest"

import {
  langForText,
  normalizeLang,
  pickVoice,
  voicesFor,
  type VoiceLike,
} from "./voices"

function voice(
  name: string,
  lang: string,
  extra: Partial<VoiceLike> = {}
): VoiceLike {
  return {
    name,
    lang,
    voiceURI: `com.apple.voice.${name}`,
    default: false,
    localService: true,
    ...extra,
  }
}

// What WebKit on a Mac reports, in its order: novelty voices first.
const MAC_VOICES: VoiceLike[] = [
  voice("Albert", "en-US"),
  voice("Bad News", "en-US"),
  voice("Daniel", "en-GB"),
  voice("Samantha", "en-US"),
  voice("Eddy (English (US))", "en-US"),
  voice("Majed", "ar-001"),
  voice("Carmit", "he-IL"),
  voice("Thomas", "fr-FR"),
]

describe("normalizeLang", () => {
  it("reads underscores, case and the retired Hebrew code", () => {
    expect(normalizeLang("he_IL")).toEqual({ base: "he", region: "IL" })
    expect(normalizeLang("iw-il")).toEqual({ base: "he", region: "IL" })
    expect(normalizeLang("en")).toEqual({ base: "en", region: "" })
  })
})

describe("pickVoice for Hebrew", () => {
  it("prefers Carmit", () => {
    const voices = [
      voice("Some Hebrew", "he-IL"),
      voice("Carmit", "he-IL"),
      ...MAC_VOICES.filter((v) => v.name !== "Carmit"),
    ]
    expect(pickVoice(voices, "he")?.name).toBe("Carmit")
  })

  it("takes the enhanced Carmit over the compact one", () => {
    const voices = [
      voice("Carmit", "he-IL"),
      voice("Carmit (Enhanced)", "he-IL"),
    ]
    expect(pickVoice(voices, "he")?.name).toBe("Carmit (Enhanced)")
  })

  it("falls back to any Hebrew voice, including Android's he_IL and iw", () => {
    expect(pickVoice([voice("Hebrew 1", "he_IL")], "he")?.name).toBe("Hebrew 1")
    expect(pickVoice([voice("Legacy", "iw-IL")], "he")?.name).toBe("Legacy")
  })

  it("returns null when no Hebrew voice is installed", () => {
    expect(
      pickVoice(
        MAC_VOICES.filter((v) => v.name !== "Carmit"),
        "he"
      )
    ).toBeNull()
  })

  it("honours a pinned voice while it is installed", () => {
    const voices = [voice("Carmit", "he-IL"), voice("Other", "he-IL")]
    expect(pickVoice(voices, "he", "com.apple.voice.Other")?.name).toBe("Other")
    expect(pickVoice(voices, "he", "com.apple.voice.Gone")?.name).toBe("Carmit")
  })

  it("ignores a pinned voice that speaks another language", () => {
    expect(pickVoice(MAC_VOICES, "he", "com.apple.voice.Samantha")?.name).toBe(
      "Carmit"
    )
  })
})

describe("pickVoice for English", () => {
  it("takes the system default when it is English", () => {
    const voices = MAC_VOICES.map((v) =>
      v.name === "Daniel" ? { ...v, default: true } : v
    )
    expect(pickVoice(voices, "en")?.name).toBe("Daniel")
  })

  it("never picks a novelty or Eloquence voice automatically", () => {
    // Default is Hebrew here, so English falls back to the best en voice.
    const voices = MAC_VOICES.map((v) =>
      v.name === "Carmit" ? { ...v, default: true } : v
    )
    expect(pickVoice(voices, "en")?.name).toBe("Samantha")
  })

  it("takes the first-listed voice where the engine marks every voice default (WebKit)", () => {
    // What WebKit on macOS reports: all 68 voices `default: true`, novelty
    // voices included, with the system's own voice listed first.
    const webkit = (names: [string, string][]) =>
      names.map(([name, lang]) => voice(name, lang, { default: true }))
    const samanthaSystem = webkit([
      ["Samantha", "en-US"],
      ["Albert", "en-US"],
      ["Daniel", "en-GB"],
      ["Carmit", "he-IL"],
    ])
    // Even for a user whose locale is en-GB: the system voice wins.
    expect(voicesFor(samanthaSystem, "en", "GB")[0].name).toBe("Samantha")
    expect(pickVoice(samanthaSystem, "he")?.name).toBe("Carmit")

    // A novelty voice listed first is passed over for the next one.
    const danielSystem = webkit([
      ["Albert", "en-US"],
      ["Daniel", "en-GB"],
      ["Samantha", "en-US"],
    ])
    expect(voicesFor(danielSystem, "en", "US")[0].name).toBe("Daniel")
  })

  it("prefers a local voice over a network one", () => {
    const voices = [
      voice("Google US English", "en-US", { localService: false }),
      voice("Local", "en-US"),
    ]
    expect(pickVoice(voices, "en")?.name).toBe("Local")
  })

  it("lists every English voice, best first", () => {
    const names = voicesFor(MAC_VOICES, "en").map((v) => v.name)
    expect(names[0]).toBe("Samantha")
    expect(names).toHaveLength(5)
    expect(names.slice(-3)).toEqual(
      expect.arrayContaining(["Albert", "Bad News", "Eddy (English (US))"])
    )
  })
})

describe("langForText", () => {
  it("maps scripts to languages, Japanese when kana are present", () => {
    expect(langForText("he", "שלום")).toBe("he-IL")
    expect(langForText("latin", "hello")).toBe("en")
    expect(langForText("cjk", "你好")).toBe("zh")
    expect(langForText("cjk", "こんにちは世界")).toBe("ja")
    expect(langForText("other", "x")).toBe("")
  })
})
