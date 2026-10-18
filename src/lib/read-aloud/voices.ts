/**
 * Which installed system voice reads which script.
 *
 * Hebrew prefers Carmit (the macOS Hebrew voice, also what the iPhone app
 * falls back to), then any Hebrew voice; English takes the system's default
 * voice when that one is English, otherwise the English voice of the user's
 * own region. Either can be pinned in Settings → Read aloud; a pinned voice
 * that is no longer installed falls back to the automatic choice.
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
// offered in Settings; they are just never picked automatically.
const NOVELTY_VOICES =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i

function score(
  voice: VoiceLike,
  base: string,
  preferredRegion: string | undefined,
  isDefault: boolean
): number {
  let points = 0
  if (base === "he" && /carmit/i.test(voice.name)) points += 100
  if (base === "en" && isDefault) points += 60
  if (
    /\((enhanced|premium)\)|enhanced|premium|neural|natural/i.test(voice.name)
  )
    points += 20
  if (voice.localService) points += 10
  if (preferredRegion && normalizeLang(voice.lang).region === preferredRegion)
    points += 8
  if (base === "en" && /^samantha\b/i.test(voice.name)) points += 3
  if (isDefault) points += 2
  if (NOVELTY_VOICES.test(voice.name)) points -= 50
  return points
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
  const listedFirst = candidates.find(
    (voice) => !NOVELTY_VOICES.test(voice.name)
  )
  return candidates
    .map((voice, index) => ({
      voice,
      index,
      points: score(
        voice,
        base,
        region,
        defaultMeaningful ? voice.default : voice === listedFirst
      ),
    }))
    .sort((a, b) => b.points - a.points || a.index - b.index)
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
