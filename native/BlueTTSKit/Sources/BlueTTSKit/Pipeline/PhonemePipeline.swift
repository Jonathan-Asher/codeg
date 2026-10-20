import Foundation

/// Port of `blue_onnx.TextProcessor`: RenikudPlus for Hebrew, the pluggable
/// English phonemizer for `<en>` spans, `<lang>…</lang>` tags preserved.
final class PhonemeTextProcessor: @unchecked Sendable {
    static let inlineLangPair = PyRegex("<(\\w+)>(.*?)</\\1>", dotAll: true)
    static let langTagRe = PyRegex("</?\\w+>")

    private let renikudLoader: () throws -> RenikudG2P
    private var renikud: RenikudG2P?
    let english: (any EnglishPhonemizer)?
    let speaker: Int
    let targetSpeaker: Int

    init(renikud: @escaping () throws -> RenikudG2P, english: (any EnglishPhonemizer)?,
         speaker: Int = 0, targetSpeaker: Int = 0) {
        renikudLoader = renikud
        self.english = english
        self.speaker = speaker
        self.targetSpeaker = targetSpeaker
    }

    func loadRenikud() throws -> RenikudG2P {
        if let r = renikud { return r }
        let r = try renikudLoader()
        renikud = r
        return r
    }

    /// `strip_lang_tags_from_phoneme_string`.
    static func stripLangTags(_ s: String) -> String {
        Py.strip(TextNormalizer.wsRe.sub(langTagRe.sub(s, ""), " "))
    }

    private func phonemizeSegment(_ content0: String, _ lang: String) throws -> String {
        var content = Py.strip(Self.langTagRe.sub(content0, ""))
        content = TextNormalizer.stripEmoji(content)
        if content.isEmpty { return "" }
        let hasHebrew = content.unicodeScalars.contains { Py.isHebrewBlock($0) }
        if hasHebrew || lang == "he" {
            if !hasHebrew { return content }
            return try loadRenikud().phonemize(content, speaker: speaker, targetSpeaker: targetSpeaker)
        }
        // `_ESPEAK_MAP`: only English is wired to a phonemizer here.
        guard lang == "en" || lang == "en-us", let english else { return content }
        return try english.phonemize(content)
    }

    /// `TextProcessor.phonemize`.
    func phonemize(_ text: String, lang: String = "he") throws -> String {
        let matches = Self.inlineLangPair.finditer(text)
        if matches.isEmpty {
            let seg = try phonemizeSegment(text, lang)
            return seg.isEmpty ? "" : "<\(lang)>\(seg)</\(lang)>"
        }
        var pieces: [String] = []
        var last = text.startIndex
        for m in matches {
            if m.range.lowerBound > last {
                let seg = try phonemizeSegment(String(text[last..<m.range.lowerBound]), lang)
                if !seg.isEmpty { pieces.append("<\(lang)>\(seg)</\(lang)>") }
            }
            let tag = m.group(1)!
            let seg = try phonemizeSegment(m.group(2) ?? "", tag)
            if !seg.isEmpty { pieces.append("<\(tag)>\(seg)</\(tag)>") }
            last = m.range.upperBound
        }
        if last < text.endIndex {
            let seg = try phonemizeSegment(String(text[last...]), lang)
            if !seg.isEmpty { pieces.append("<\(lang)>\(seg)</\(lang)>") }
        }
        return Py.strip(TextNormalizer.wsRe.sub(pieces.joined(separator: " "), " "))
    }
}

/// Port of `blue_onnx.UnicodeProcessor`: phoneme string -> token ids.
struct UnicodeProcessor: Sendable {
    let padId: Int64
    let charToId: [Unicode.Scalar: Int64]
    static let availableLangs: Set<String> = ["en", "es", "de", "it", "he"]

    init(vocabURL: URL) throws {
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: vocabURL))
        guard let d = raw as? [String: Any], let c2i = d["char_to_id"] as? [String: Int] else {
            throw OrtError.badOutputType("vocab.json without char_to_id")
        }
        padId = Int64((d["pad_id"] as? Int) ?? 0)
        var m: [Unicode.Scalar: Int64] = [:]
        for (k, v) in c2i where k.unicodeScalars.count == 1 { m[k.unicodeScalars.first!] = Int64(v) }
        charToId = m
    }

    static let replacements: [(String, String)] = [
        ("–", "-"), ("‑", "-"), ("—", "-"), ("_", " "), ("\u{201C}", "\""), ("\u{201D}", "\""),
        ("\u{2018}", "'"), ("\u{2019}", "'"), ("´", "'"), ("`", "'"), ("[", " "), ("]", " "),
        ("|", " "), ("/", " "), ("#", " "), ("→", " "), ("←", " "),
    ]
    static let specialRe = PyRegex("[♥☆♡©\\\\]")
    static let exprReplacements: [(String, String)] = [
        ("@", " at "), ("e.g.,", "for example, "), ("i.e.,", "that is, "),
    ]
    static let spaceFixes: [(PyRegex, String)] = [
        (PyRegex(" ,"), ","), (PyRegex(" \\."), "."), (PyRegex(" !"), "!"), (PyRegex(" \\?"), "?"),
        (PyRegex(" ;"), ";"), (PyRegex(" :"), ":"), (PyRegex(" '"), "'"),
    ]
    static let endsWithPunctRe = PyRegex("[.!?;:,'\"')\\]}…。」』】〉》›»]$")

    /// `_preprocess_text`.
    static func preprocess(_ text0: String, lang: String) -> String {
        var text = PhonemeTextProcessor.stripLangTags(text0)
        text = text.decomposedStringWithCompatibilityMapping
        text = TextNormalizer.stripEmoji(text)
        for (k, v) in replacements { text = Py.replace(text, k, v) }
        text = specialRe.sub(text, "")
        for (k, v) in exprReplacements { text = Py.replace(text, k, v) }
        for (re, v) in spaceFixes { text = re.sub(text, v) }
        while Py.contains(text, "\"\"") { text = Py.replace(text, "\"\"", "\"") }
        while Py.contains(text, "''") { text = Py.replace(text, "''", "'") }
        while Py.contains(text, "``") { text = Py.replace(text, "``", "`") }
        text = Py.strip(TextNormalizer.wsRe.sub(text, " "))
        if endsWithPunctRe.search(text) == nil { text += "." }
        return "<\(lang)>" + text + "</\(lang)>"
    }

    /// `__call__` for one text: (ids, mask) with shapes [1, T] and [1, 1, T].
    func encode(_ text: String, lang: String) -> [Int64] {
        let pre = PhonemeTextProcessor.langTagRe.sub(Self.preprocess(text, lang: lang), "")
        return pre.unicodeScalars.map { charToId[$0] ?? padId }
    }
}

/// `chunk_text`: paragraphs, then sentences packed up to `maxLen` code points.
enum TextChunker {
    static let paragraphRe = PyRegex("\\n\\s*\\n+")
    static let sentenceRe = PyRegex(
        "(?<!Mr\\.)(?<!Mrs\\.)(?<!Ms\\.)(?<!Dr\\.)(?<!Prof\\.)(?<!Sr\\.)(?<!Jr\\.)(?<!Ph\\.D\\.)(?<!etc\\.)"
            + "(?<!e\\.g\\.)(?<!i\\.e\\.)(?<!vs\\.)(?<!Inc\\.)(?<!Ltd\\.)(?<!Co\\.)(?<!Corp\\.)(?<!St\\.)"
            + "(?<!Ave\\.)(?<!Blvd\\.)(?<!\\b[A-Z]\\.)(?<=[.!?])\\s+"
    )

    static func sentences(_ paragraph: String) -> [String] {
        sentenceRe.split(paragraph)
    }

    static func paragraphs(_ text: String) -> [String] {
        paragraphRe.split(Py.strip(text)).map { Py.strip($0) }.filter { !$0.isEmpty }
    }

    static func chunk(_ text: String, maxLen: Int = 300) -> [String] {
        var chunks: [String] = []
        for p in paragraphs(text) {
            let paragraph = Py.strip(p)
            if paragraph.isEmpty { continue }
            var current = ""
            for sentence in sentences(paragraph) {
                if Py.len(current) + Py.len(sentence) + 1 <= maxLen {
                    current += (current.isEmpty ? "" : " ") + sentence
                } else {
                    if !current.isEmpty { chunks.append(Py.strip(current)) }
                    current = sentence
                }
            }
            if !current.isEmpty { chunks.append(Py.strip(current)) }
        }
        return chunks
    }
}
