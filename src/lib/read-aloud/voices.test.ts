import { describe, expect, it } from "vitest"

import {
  langForText,
  normalizeLang,
  pickVoice,
  voicesByTier,
  voicesFor,
  voiceTier,
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

// What WebKit reports on a Mac: `voiceURI` is the AVSpeechSynthesisVoice
// identifier, which carries the voice's size, and every voice is `default`.
function webkitVoice(id: string, name: string, lang: string): VoiceLike {
  return { name, lang, voiceURI: id, default: true, localService: true }
}

const COMPACT_SAMANTHA = webkitVoice(
  "com.apple.voice.compact.en-US.Samantha",
  "Samantha",
  "en-US"
)
const COMPACT_CARMIT = webkitVoice(
  "com.apple.voice.compact.he-IL.Carmit",
  "Carmit",
  "he-IL"
)

describe("voiceTier", () => {
  it("reads the tier from the identifier WebKit exposes", () => {
    expect(
      voiceTier(
        webkitVoice("com.apple.voice.premium.en-US.Ava", "Ava", "en-US")
      )
    ).toBe("premium")
    expect(
      voiceTier(
        webkitVoice("com.apple.voice.enhanced.he-IL.Carmit", "Carmit", "he-IL")
      )
    ).toBe("enhanced")
    expect(voiceTier(COMPACT_SAMANTHA)).toBe("basic")
    expect(
      voiceTier(
        webkitVoice(
          "com.apple.voice.super-compact.en-AU.Karen",
          "Karen",
          "en-AU"
        )
      )
    ).toBe("basic")
  })

  it("reads the tier from the name where the identifier is the name", () => {
    expect(voiceTier(voice("Ava (Premium)", "en-US"))).toBe("premium")
    expect(voiceTier(voice("Zoe (Enhanced)", "en-US"))).toBe("enhanced")
    expect(
      voiceTier(voice("Microsoft Aria Online (Natural) - English", "en-US"))
    ).toBe("natural")
    expect(voiceTier(voice("Samantha", "en-US"))).toBe("basic")
  })
})

describe("voice quality outranks the default", () => {
  it("takes a downloaded Premium voice over the compact system default (WebKit)", () => {
    // The system voice is the compact Samantha, listed first.
    const voices = [
      COMPACT_SAMANTHA,
      webkitVoice("com.apple.voice.compact.en-GB.Daniel", "Daniel", "en-GB"),
      webkitVoice("com.apple.voice.premium.en-US.Ava", "Ava", "en-US"),
      COMPACT_CARMIT,
    ]
    expect(pickVoice(voices, "en")?.voiceURI).toBe(
      "com.apple.voice.premium.en-US.Ava"
    )
  })

  it("takes a Premium or Enhanced voice over the flagged default (Chrome)", () => {
    const voices = [
      voice("Samantha", "en-US", { default: true }),
      voice("Zoe (Enhanced)", "en-US"),
    ]
    expect(pickVoice(voices, "en")?.name).toBe("Zoe (Enhanced)")
    expect(
      pickVoice([...voices, voice("Ava (Premium)", "en-GB")], "en")?.name
    ).toBe("Ava (Premium)")
  })

  it("still prefers the default among voices of one tier", () => {
    const voices = [
      voice("Ava (Premium)", "en-US"),
      voice("Zoe (Premium)", "en-US", { default: true }),
    ]
    expect(pickVoice(voices, "en")?.name).toBe("Zoe (Premium)")
  })

  it("always honours the voice picked in Settings", () => {
    const voices = [
      COMPACT_SAMANTHA,
      webkitVoice("com.apple.voice.premium.en-US.Ava", "Ava", "en-US"),
    ]
    expect(pickVoice(voices, "en", COMPACT_SAMANTHA.voiceURI)).toBe(
      COMPACT_SAMANTHA
    )
  })

  it("takes Carmit (Enhanced) over the compact Carmit, by identifier", () => {
    const enhanced = webkitVoice(
      "com.apple.voice.enhanced.he-IL.Carmit",
      "Carmit",
      "he-IL"
    )
    expect(pickVoice([COMPACT_CARMIT, enhanced], "he")).toBe(enhanced)
  })

  it("keeps Carmit ahead of other Hebrew voices of a better tier", () => {
    const voices = [voice("Hebrew (Premium)", "he-IL"), COMPACT_CARMIT]
    expect(pickVoice(voices, "he")).toBe(COMPACT_CARMIT)
  })

  it("never picks a novelty voice, even under a translated name", () => {
    const voices = [
      // Eloquence's Eddy, and the Effects voice Whisper, as a German Mac
      // might name them, listed first.
      webkitVoice("com.apple.eloquence.en-US.Eddy", "Eddy (Englisch)", "en-US"),
      webkitVoice(
        "com.apple.speech.synthesis.voice.Whisper",
        "Flüstern",
        "en-US"
      ),
      COMPACT_SAMANTHA,
    ]
    expect(pickVoice(voices, "en")).toBe(COMPACT_SAMANTHA)
    expect(
      voicesFor(voices, "en")
        .slice(-2)
        .map((v) => v.voiceURI)
    ).toEqual([
      "com.apple.eloquence.en-US.Eddy",
      "com.apple.speech.synthesis.voice.Whisper",
    ])
  })
})

describe("voicesByTier", () => {
  it("lists better tiers first, novelty voices last", () => {
    const voices = [
      voice("Albert", "en-US"),
      COMPACT_SAMANTHA,
      voice("Microsoft Aria Online (Natural)", "en-US"),
      voice("Zoe (Enhanced)", "en-US"),
      webkitVoice("com.apple.voice.premium.en-US.Ava", "Ava", "en-US"),
    ]
    expect(voicesByTier(voices, "en").map((v) => v.name)).toEqual([
      "Ava",
      "Zoe (Enhanced)",
      "Microsoft Aria Online (Natural)",
      "Samantha",
      "Albert",
    ])
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
