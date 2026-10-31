import Foundation

/// The Language setting in Settings › Voice › Voice Typing.
enum DictationLanguage: String, CaseIterable, Identifiable, Sendable {
    /// Hebrew or English, told apart per dictation by a small language-ID
    /// model, then transcribed by the ivrit.ai model with that language
    /// forced. Leans to Hebrew: English only when the language-ID model is
    /// confident (``SpokenLanguageDecision``). The default.
    case hebrewOrEnglish
    /// Hebrew, with English technical words written as the model writes them.
    /// Uses the ivrit.ai model with the language forced, because its own
    /// language detection was degraded by the Hebrew fine-tune.
    case hebrew
    /// English only, with the same ivrit.ai model.
    case english
    /// Whisper detects the language. Uses the stock multilingual model,
    /// whose detection works, at the cost of weaker Hebrew.
    case auto

    static let `default`: DictationLanguage = .hebrewOrEnglish

    var id: String { rawValue }

    var title: String {
        switch self {
        case .hebrewOrEnglish: "Hebrew or English (automatic)"
        case .hebrew: "Hebrew"
        case .english: "English"
        case .auto: "Detect automatically"
        }
    }

    /// Where the recording strip's language chip starts.
    var defaultChoice: DictationLanguageChoice {
        switch self {
        case .hebrewOrEnglish, .auto: .automatic
        case .hebrew: .hebrew
        case .english: .english
        }
    }

    /// How a dictation with this setting and the strip's `choice` picks its
    /// language. The chip never changes the model, only the language: with
    /// "Detect automatically" its Auto is the stock model's own detection.
    func plan(choice: DictationLanguageChoice) -> DictationLanguagePlan {
        switch choice {
        case .hebrew: .forced("he")
        case .english: .forced("en")
        case .automatic: self == .auto ? .detectAny : .hebrewOrEnglish
        }
    }
}

/// The recording strip's language chip: this one dictation's language.
enum DictationLanguageChoice: String, CaseIterable, Sendable {
    case automatic
    case hebrew
    case english

    /// The chip's text.
    var shortTitle: String {
        switch self {
        case .automatic: "Auto"
        case .hebrew: "עב"
        case .english: "EN"
        }
    }

    var accessibilityTitle: String {
        switch self {
        case .automatic: "Automatic"
        case .hebrew: "Hebrew"
        case .english: "English"
        }
    }

    /// A tap on the chip: Auto → עב → EN → Auto.
    var next: DictationLanguageChoice {
        switch self {
        case .automatic: .hebrew
        case .hebrew: .english
        case .english: .automatic
        }
    }
}

/// How one dictation gets its language.
enum DictationLanguagePlan: Equatable, Sendable {
    /// Decode with this whisper language.
    case forced(String)
    /// Ask the language-ID model whether it's English, then force that
    /// language; Hebrew unless English is clear.
    case hebrewOrEnglish
    /// The stock multilingual model detects the language itself.
    case detectAny
}

/// Hebrew or English from the language-ID model's probabilities (whisper
/// tiny q8_0). Measured on 93 Hebrew and 132 English clips in docs/FORK.md
/// ("Hebrew or English"): every clip of English speech scored p(en) above
/// 0.998, but Hebrew dense with English code words, spoken as English, can
/// score almost as high. The threshold sits between the two: every Hebrew
/// clip stayed Hebrew, and English was lost only in a few clips from old
/// robotic system voices.
enum SpokenLanguageDecision {
    /// The languages the model chooses between.
    static let candidates = ["he", "en"]
    /// English only when p(en), renormalized over Hebrew and English, is at
    /// least this (odds of about 3,300 to 1).
    static let englishThreshold: Float = 0.9997
    /// The model hears this much speech from the start of the trimmed clip.
    /// Its encoder costs the same for any length up to 30 s, and the first
    /// 3 or 5 s alone were less accurate.
    static let windowSeconds: Double = 30

    /// `raw` renormalized to add up to 1. Empty when nothing is left.
    static func normalized(_ raw: [String: Float]) -> [String: Float] {
        let finite = raw.filter { $0.value.isFinite && $0.value >= 0 }
        let total = finite.values.reduce(0, +)
        guard total > 0 else { return [:] }
        return finite.mapValues { $0 / total }
    }

    /// The language to force: "en" when English clears the threshold, else
    /// "he". No probabilities (no model, or it failed) means Hebrew, which is
    /// what the app did before it could tell them apart.
    static func language(for probabilities: [String: Float]?,
                         threshold: Float = englishThreshold) -> String {
        guard let english = normalized(probabilities ?? [:])["en"] else { return "he" }
        return english >= threshold ? "en" : "he"
    }

    /// The samples the model hears: the first ``windowSeconds`` of `clip`.
    static func window(of clip: [Float], seconds: Double = windowSeconds, sampleRate: Double = 16_000) -> [Float] {
        let count = Int(seconds * sampleRate)
        return clip.count <= count ? clip : Array(clip.prefix(count))
    }
}
