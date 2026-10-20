import Foundation

/// Wraps Latin-script runs in Hebrew text in `<en>…</en>` so BlueTTS reads
/// them with the English phonemizer, the form Jonathan picked by ear in the
/// listening spike (where the tags were placed by hand).
///
/// Rules:
/// - A *token* is letters/digits joined by `.` `_` `/` `-` (and `://`), with an
///   apostrophe allowed between Latin letters (`you're`, `don't`) and an
///   optional `++`/`#` suffix (`C++`, `C#`). It must contain a Latin letter, so
///   bare numbers stay Hebrew and are read by the Hebrew number normalizer.
/// - Tokens separated only by spaces or tabs merge into one run (`Pull Request`,
///   `pnpm test`); trailing punctuation stays outside the tag.
/// - A Hebrew prefix glued with a hyphen stays Hebrew: `ב-README` →
///   `ב-<en>README</en>`; the normalizer later drops the hyphen.
/// - An apostrophe or geresh after a Hebrew letter is Hebrew (`בראנץ'`,
///   `האימג'`): it never starts a Latin token. Typographic apostrophes there
///   (`’`, `‘`, `` ` ``, `´`) are folded to `'`, which RenikudPlus reads as a geresh.
/// - Existing `<xx>…</xx>` spans and e-mail addresses are left alone (the
///   normalizer spells addresses itself).
public enum EnglishAutoTagger {
    static let existingSpanRe = PyRegex("(<(\\w+)>.*?</\\2>)", dotAll: true)
    static let emailRe = PyRegex("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")

    // One token: alnum pieces joined by connectors; apostrophes only between Latin letters.
    static let token = "[A-Za-z0-9]+(?:(?:[._/\\-]|://)[A-Za-z0-9]+|(?<=[A-Za-z])['’](?=[A-Za-z])[A-Za-z]+)*(?:\\+\\+|#)?"
    static let runRe = PyRegex("(?<![A-Za-z0-9])\(token)(?:[ \\t]+\(token))*")
    static let latinLetterRe = PyRegex("[A-Za-z]")
    static let pureNumberTokenRe = PyRegex("^[0-9]+(?:[._/\\-][0-9]+)*$")
    static let hebrewApostropheRe = PyRegex("(?<=[\\u05D0-\\u05EA])[’‘`´]")

    /// Tag `text`. Text with no Hebrew letters is returned unchanged (it is
    /// synthesized as English as a whole).
    public static func tag(_ text: String) -> String {
        guard text.unicodeScalars.contains(where: { $0.value >= 0x05D0 && $0.value <= 0x05EA }) else {
            return text
        }
        let folded = hebrewApostropheRe.sub(text, "'")
        // Split around existing tag spans; group 2 (the tag name) is dropped below.
        var out = ""
        var last = folded.startIndex
        for m in existingSpanRe.finditer(folded) {
            out += tagPlain(String(folded[last..<m.range.lowerBound]))
            out += m.value
            last = m.range.upperBound
        }
        out += tagPlain(String(folded[last...]))
        return out
    }

    private static func tagPlain(_ s: String) -> String {
        if s.isEmpty { return s }
        // Protect e-mail addresses.
        var out = ""
        var last = s.startIndex
        for m in emailRe.finditer(s) {
            out += tagRuns(String(s[last..<m.range.lowerBound]))
            out += m.value
            last = m.range.upperBound
        }
        out += tagRuns(String(s[last...]))
        return out
    }

    private static func tagRuns(_ s: String) -> String {
        runRe.sub(s) { m in
            // Split the run back into tokens with their separators, then trim
            // leading/trailing tokens without a Latin letter (they stay Hebrew).
            let run = m.value
            let parts = splitKeepingSeparators(run)
            var lo = 0, hi = parts.count - 1
            while lo <= hi && !isLatinToken(parts[lo].token) { lo += 1 }
            while hi >= lo && !isLatinToken(parts[hi].token) { hi -= 1 }
            if lo > hi { return run }
            var prefix = "", body = "", suffix = ""
            for (i, p) in parts.enumerated() {
                let piece = (i == 0 ? "" : p.sep) + p.token
                if i < lo {
                    prefix += piece
                } else if i <= hi {
                    body += (i == lo ? p.token : piece)
                    if i == lo && i > 0 { prefix += p.sep }
                } else {
                    suffix += piece
                }
            }
            return prefix + "<en>" + body + "</en>" + suffix
        }
    }

    private static func isLatinToken(_ t: String) -> Bool {
        latinLetterRe.search(t) != nil
    }

    private static func splitKeepingSeparators(_ run: String) -> [(sep: String, token: String)] {
        var parts: [(String, String)] = []
        var sep = "", tok = ""
        for ch in run {
            if ch == " " || ch == "\t" {
                if !tok.isEmpty { parts.append((sep, tok)); sep = ""; tok = "" }
                sep.append(ch)
            } else {
                tok.append(ch)
            }
        }
        if !tok.isEmpty { parts.append((sep, tok)) }
        return parts
    }

    /// True when `text` contains a Hebrew letter.
    public static func containsHebrew(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value >= 0x05D0 && $0.value <= 0x05EA }
    }
}
