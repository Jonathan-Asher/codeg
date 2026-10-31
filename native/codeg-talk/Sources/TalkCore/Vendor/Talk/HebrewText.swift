import Foundation

/// Hebrew-aware text handling for Talk: cleaning what is spoken, and
/// splitting and normalizing what was heard so it can be compared with the
/// words it should match (commands, yes and no, option labels).
enum HebrewText {
    // MARK: - Speech

    /// Strip nikud and cantillation (U+0591–U+05C7) and bidi marks. The maqaf
    /// (U+05BE) becomes a plain hyphen. Works on scalars, so it is safe on any
    /// piece of a longer text.
    static func stripMarks(_ text: String) -> String {
        guard text.unicodeScalars.contains(where: { isMark($0) }) else { return text }
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar.value == 0x05BE {
                out.append("-")
            } else if !isMark(scalar) {
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// Geresh and gershayim typed as quote marks become ׳ (U+05F3) and ״
    /// (U+05F4): a double quote between two Hebrew letters (ד"ר, צה"ל), two
    /// apostrophes in its place (ד''ר), and an apostrophe after a Hebrew
    /// letter (ג'ירה, וכו'), unless it closes a quote that an apostrophe
    /// before a Hebrew word opened.
    static func normalizeGershayim(_ text: String) -> String {
        guard text.contains(where: { quoteMarks.contains($0) }) else { return text }
        let chars = Array(text)
        var out = ""
        out.reserveCapacity(text.utf8.count)
        var openSingle = false
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let prev: Character? = i > 0 ? chars[i - 1] : nil
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            let prevHebrew = prev.map(isHebrewLetter) ?? false
            let nextHebrew = next.map(isHebrewLetter) ?? false
            switch c {
            case "\"", "\u{201C}", "\u{201D}":
                out.append(prevHebrew && nextHebrew ? "\u{05F4}" : c)
            case "'", "\u{2018}", "\u{2019}":
                if c == "'", next == "'", prevHebrew, i + 2 < chars.count, isHebrewLetter(chars[i + 2]) {
                    out.append("\u{05F4}")
                    i += 2
                    continue
                }
                if prevHebrew, nextHebrew {
                    out.append("\u{05F3}")
                } else if prevHebrew {
                    if openSingle {
                        openSingle = false
                        out.append(c)
                    } else {
                        out.append("\u{05F3}")
                    }
                } else if nextHebrew, prev.map({ $0.isWhitespace || "([{-–—".contains($0) }) ?? true {
                    openSingle = true
                    out.append(c)
                } else {
                    out.append(c)
                }
            default:
                out.append(c)
            }
            i += 1
        }
        return out
    }

    /// What is handed to the synthesizer: marks stripped, geresh and
    /// gershayim normalized.
    static func forSpeech(_ text: String) -> String {
        normalizeGershayim(stripMarks(text))
    }

    // MARK: - Matching

    /// A word of a text, normalized for matching, and where it sits in the
    /// text it came from.
    struct Token: Equatable, Sendable {
        var word: String
        var range: Range<String.Index>
    }

    /// Unicode-aware words: runs of letters, digits and combining marks.
    /// Geresh and gershayim stay inside a word after a Hebrew letter
    /// (ד״ר, ג׳ירה, וכו׳), and an apostrophe stays between two letters
    /// (don't); everything else separates words. Words are lowercased.
    /// `text` is used as it is; ``words(_:)`` cleans it first.
    static func tokens(_ text: String) -> [Token] {
        var tokens: [Token] = []
        var start: String.Index?
        var word = ""
        var prev: Character?
        var index = text.startIndex
        func close(at end: String.Index) {
            if let s = start, !word.isEmpty { tokens.append(Token(word: word, range: s..<end)) }
            start = nil
            word = ""
        }
        while index < text.endIndex {
            let c = text[index]
            let nextIndex = text.index(after: index)
            let next: Character? = nextIndex < text.endIndex ? text[nextIndex] : nil
            var isWordChar = isWordCharacter(c)
            if !isWordChar, start != nil {
                switch c {
                case "\u{05F3}", "\u{05F4}":
                    isWordChar = prev.map(isHebrewLetter) ?? false
                case "'", "\u{2019}":
                    isWordChar = (prev?.isLetter ?? false) && (next?.isLetter ?? false)
                default:
                    break
                }
            }
            if isWordChar {
                if start == nil { start = index }
                word.append(contentsOf: c == "\u{2019}" ? "'" : String(c).lowercased())
            } else {
                close(at: index)
            }
            prev = c
            index = nextIndex
        }
        close(at: text.endIndex)
        return tokens
    }

    /// The normalized words of `text`: marks stripped, geresh and gershayim
    /// normalized, Latin lowercased, punctuation dropped.
    static func words(_ text: String) -> [String] {
        tokens(forSpeech(text)).map(\.word)
    }

    /// The words of `text` joined by single spaces.
    static func normalized(_ text: String) -> String {
        words(text).joined(separator: " ")
    }

    /// The one-letter Hebrew prefixes (and, the, that, in, to, as, from).
    static let prefixLetters: Set<Character> = ["ו", "ה", "ש", "ב", "ל", "כ", "מ"]

    /// `word` without its leading prefix letters, for matching (הראשונה and
    /// ראשונה, וכן and כן). At most three are stripped, and at least two
    /// letters are left, so short words survive. Both sides of a comparison
    /// must go through this.
    static func stripPrefixes(_ word: String, maxPrefixes: Int = 3, minimumLength: Int = 2) -> String {
        var rest = Substring(word)
        var stripped = 0
        while stripped < maxPrefixes, rest.count > minimumLength, let first = rest.first,
              prefixLetters.contains(first) {
            rest = rest.dropFirst()
            stripped += 1
        }
        return String(rest)
    }

    /// The comparison key of a normalized word.
    static func matchKey(_ word: String) -> String {
        stripPrefixes(word)
    }

    // MARK: - Characters

    static func isHebrewLetter(_ c: Character) -> Bool {
        guard let scalar = c.unicodeScalars.first else { return false }
        switch scalar.value {
        case 0x05D0...0x05EA, 0x05F0...0x05F2, 0xFB1D...0xFB4F: return true
        default: return false
        }
    }

    static func isLatinLetter(_ c: Character) -> Bool {
        guard let scalar = c.unicodeScalars.first else { return false }
        switch scalar.value {
        case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F: return true
        default: return false
        }
    }

    /// Whether the text holds a Hebrew letter.
    static func containsHebrew(_ text: String) -> Bool {
        text.contains(where: isHebrewLetter)
    }

    /// Whether the text holds a Latin letter.
    static func containsLatin(_ text: String) -> Bool {
        text.contains(where: isLatinLetter)
    }

    private static let quoteMarks: Set<Character> = ["\"", "'", "\u{2018}", "\u{2019}", "\u{201C}", "\u{201D}"]

    private static func isWordCharacter(_ c: Character) -> Bool {
        if c.isLetter || c.isNumber { return true }
        // A lone combining mark (a piece of a longer text) stays with its word.
        return c.unicodeScalars.allSatisfy { $0.properties.generalCategory == .nonspacingMark }
    }

    /// Nikud and cantillation (not the maqaf), bidi controls, and the
    /// invisible zero-width space and byte-order mark.
    private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0591...0x05C7: return true
        case 0x200B, 0x200E, 0x200F, 0x061C, 0x202A...0x202E, 0x2066...0x2069, 0xFEFF: return true
        default: return false
        }
    }
}
