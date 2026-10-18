/**
 * Which installed system voice reads which script.
 *
 * How natural a voice sounds comes first: a Premium voice, then an Enhanced
 * one, then a neural/natural one, and only then the compact and basic voices
 * every Mac ships with. Within that, Hebrew prefers Carmit (the macOS Hebrew
 * voice, also what the iPhone app falls back to), and English takes the
 * system's default voice when that one is English, otherwise the English voice
 * of the user's own region. So a downloaded "Ava (Premium)" reads English even
 * while the system voice is the compact Samantha, and "Carmit (Enhanced)"
 * reads Hebrew over the compact Carmit.
 *
 * Either language can be pinned in Settings → Read aloud, and a pinned voice
 * always wins; one that is no longer installed falls back to the automatic
 * choice. Novelty voices are never picked automatically.
 */

import type { SpeechScript } from "./speech-text"

/** The fields of a `SpeechSynthesisVoice` the picker reads. */
export interface VoiceLike {
  name: string
  lang: string
  voiceURI: string
  default: boolean
  localService: boolean
}

/** A language a voice can be chosen for: Hebrew or English in Settings. */
export type VoiceLanguage = "he" | "en"

/** The BCP 47 language each script is read in. */
export const SCRIPT_LANG: Record<SpeechScript, string> = {
  he: "he-IL",
  ar: "ar",
  latin: "en",
  cjk: "zh",
  hangul: "ko",
  cyrillic: "ru",
  greek: "el",
  thai: "th",
  devanagari: "hi",
  other: "",
}

/**
 * `he_IL` (Android) and `he-il` → `he-IL`; the retired Hebrew code `iw` →
 * `he`. Returns the lowercase primary subtag with the region, if any.
 */
export function normalizeLang(lang: string): { base: string; region: string } {
  const [rawBase = "", rawRegion = ""] = lang.replace(/_/g, "-").split("-")
  const base = rawBase.toLowerCase()
  return {
    base: base === "iw" ? "he" : base,
    region: rawRegion.toUpperCase(),
  }
}

/** Whether a voice speaks `base` (a primary language subtag such as `he`). */
export function voiceSpeaks(voice: VoiceLike, base: string): boolean {
  return normalizeLang(voice.lang).base === base
}

// macOS ships these for fun, and the Eloquence set is robotic. They are still
// offered in Settings; they are just never picked automatically. The
// identifiers catch them where macOS shows the names translated.
const NOVELTY_VOICES =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i
const NOVELTY_VOICE_URIS =
  /^com\.apple\.eloquence\.|^com\.apple\.speech\.synthesis\.voice\.(albert|badnews|bahh|bells|boing|bubbles|cellos|deranged|fred|goodnews|hysterical|junior|kathy|organ|princess|ralph|trinoids|whisper|zarvox)$/i

function isNovelty(voice: VoiceLike): boolean {
  return (
    NOVELTY_VOICES.test(voice.name) || NOVELTY_VOICE_URIS.test(voice.voiceURI)
  )
}

/**
 * How natural a voice sounds, best first. macOS installs a voice in up to
 * three sizes that share one name; WebKit tells them apart only by `voiceURI`,
 * the AVSpeechSynthesisVoice identifier (`com.apple.voice.premium.en-US.Ava`,
 * `com.apple.voice.enhanced.he-IL.Carmit`,
 * `com.apple.voice.compact.en-US.Samantha`), while Chrome and Edge put it in
 * the name ("Ava (Premium)", "Microsoft Aria Online (Natural)"). Everything
 * else, compact and super-compact voices included, is `basic`. Siri's voices
 * are not offered to apps at all.
 */
export type VoiceTier = "premium" | "enhanced" | "natural" | "basic"

const TIER_RANK: Record<VoiceTier, number> = {
  premium: 3,
  enhanced: 2,
  natural: 1,
  basic: 0,
}

export function voiceTier(voice: VoiceLike): VoiceTier {
  const text = `${voice.name} ${voice.voiceURI}`
  if (/premium/i.test(text)) return "premium"
  if (/enhanced/i.test(text)) return "enhanced"
  if (/neural|natural/i.test(text)) return "natural"
  return "basic"
}

/**
 * What decides the automatic choice, most important first; the first entry
 * that differs between two voices settles it.
 */
function rank(
  voice: VoiceLike,
  base: string,
  preferredRegion: string | undefined,
  isDefault: boolean
): number[] {
  return [
    isNovelty(voice) ? 0 : 1,
    base === "he" && /carmit/i.test(voice.name) ? 1 : 0,
    TIER_RANK[voiceTier(voice)],
    base === "en" && isDefault ? 1 : 0,
    voice.localService ? 1 : 0,
    preferredRegion && normalizeLang(voice.lang).region === preferredRegion
      ? 1
      : 0,
    base === "en" && /^samantha\b/i.test(voice.name) ? 1 : 0,
    isDefault ? 1 : 0,
  ]
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return b[i] - a[i]
  }
  return 0
}

/** The installed voices for a language, best automatic choice first. */
export function voicesFor(
  voices: readonly VoiceLike[],
  base: string,
  preferredRegion?: string
): VoiceLike[] {
  const region =
    preferredRegion ?? (base === "en" ? navigatorRegion("en") : undefined)
  const candidates = voices.filter((voice) => voiceSpeaks(voice, base))
  // Chrome flags the one voice the system uses. WebKit flags every voice
  // `default` and lists the system's own voice for a language first, so there
  // the first (non-novelty) voice listed stands for the default.
  const defaultMeaningful = voices.some((voice) => !voice.default)
  const listedFirst = candidates.find((voice) => !isNovelty(voice))
  return candidates
    .map((voice, index) => ({
      voice,
      index,
      rank: rank(
        voice,
        base,
        region,
        defaultMeaningful ? voice.default : voice === listedFirst
      ),
    }))
    .sort((a, b) => compareRanks(a.rank, b.rank) || a.index - b.index)
    .map((entry) => entry.voice)
}

/**
 * The installed voices for a language as Settings lists them: better tiers
 * first, each tier in the automatic order.
 */
export function voicesByTier(
  voices: readonly VoiceLike[],
  base: string,
  preferredRegion?: string
): VoiceLike[] {
  return voicesFor(voices, base, preferredRegion)
    .map((voice, index) => ({
      voice,
      index,
      tier: TIER_RANK[voiceTier(voice)],
    }))
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .map((entry) => entry.voice)
}

/** The region of the user's own locale when it is in `base`: `en-GB` → `GB`. */
function navigatorRegion(base: string): string | undefined {
  if (typeof navigator === "undefined") return undefined
  const languages = navigator.languages?.length
    ? navigator.languages
    : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const parsed = normalizeLang(language)
    if (parsed.base === base && parsed.region) return parsed.region
  }
  return base === "en" ? "US" : undefined
}

/**
 * The voice for `base`: the pinned one when it is still installed, otherwise
 * the best automatic choice, or null when no voice speaks the language.
 */
export function pickVoice(
  voices: readonly VoiceLike[],
  base: string,
  pinnedURI?: string | null
): VoiceLike | null {
  if (pinnedURI) {
    const pinned = voices.find(
      (voice) => voice.voiceURI === pinnedURI && voiceSpeaks(voice, base)
    )
    if (pinned) return pinned
  }
  return voicesFor(voices, base)[0] ?? null
}

/** The language `cjk` text is read in: Japanese when it holds kana. */
export function langForText(script: SpeechScript, text: string): string {
  if (script === "cjk") return /[぀-ヿㇰ-ㇿ]/.test(text) ? "ja" : "zh"
  return SCRIPT_LANG[script]
}
