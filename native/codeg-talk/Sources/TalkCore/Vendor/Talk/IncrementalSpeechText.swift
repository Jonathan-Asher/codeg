import Foundation

/// A reply's Markdown, streamed in, turned into speakable units as soon as
/// each sentence is complete. It reads with the rules of
/// ``SpeechText/fromMarkdown(_:options:)``: for any way the text is cut into
/// chunks, the units joined with spaces are that function's output (with the
/// paragraph breaks as spaces).
///
/// - A sentence is only emitted once it is complete: its end is followed by
///   more text, or its paragraph ended.
/// - A line that could still turn out to be a code fence, a table row, a
///   heading, a list item or a quote is held back until the line is complete.
///   A line that starts as prose is read as it arrives, up to the last space
///   before anything whose reading depends on what follows (Markdown
///   emphasis, inline code, links, quotes next to Hebrew).
/// - Sentences never split inside abbreviations ("e.g."), numbers ("3.5"),
///   URLs, paths or inline code. A unit is at most ``maxUnitLength``
///   characters; a longer sentence is cut at a comma or a space.
struct IncrementalSpeechText: Sendable {
    /// The longest unit, in characters.
    static let maxUnitLength = 300

    /// The reply the units belong to (their ids).
    let reply: String
    let options: SpeechText.MarkdownOptions

    /// Units emitted so far (the next unit's index).
    private(set) var emitted = 0
    /// The line being received, not yet read (marks already stripped).
    private var line = ""
    /// The start of the current line was already read as prose; the rest of
    /// it continues that prose.
    private var lineStarted = false
    /// Whether the read part of the current line holds Hebrew (a URL later in
    /// the line is named in the line's language).
    private var lineHebrew = false
    private var inFence = false
    private var fenceMarker = ""
    private var codeLines: [String] = []
    /// The paragraph's text not yet spoken, with inline code's sentence
    /// punctuation as stand-ins. After a complete line or a read piece it ends
    /// with a space, which stands for the line break or the space the piece
    /// ended at.
    private var pending = ""
    /// The whole paragraph so far (for the screen cue's context).
    private var paragraph = ""
    private var cues: SpeechText.ScreenCueTracker
    /// Drop what is emitted until the sentence in progress ends.
    private var skipping = false
    /// The dropped sentence is prose of the current paragraph, so it also
    /// ends with the paragraph.
    private var skippingProse = false

    init(reply: String, options: SpeechText.MarkdownOptions = .talk) {
        self.reply = reply
        self.options = options
        self.cues = SpeechText.ScreenCueTracker(cue: options.screenCue)
    }

    /// Whether a cue said now would be in Hebrew: the language of the last
    /// prose paragraph, else the options' default.
    var contextIsHebrew: Bool { cues.cueIsHebrew }

    // MARK: - Input

    /// More of the reply.
    mutating func append(_ text: String) -> [SpeechUnit] {
        guard !text.isEmpty else { return [] }
        let chunk = options.cleanHebrew ? HebrewText.stripMarks(text) : text
        var units: [SpeechUnit] = []
        var run = String.UnicodeScalarView()
        for scalar in chunk.unicodeScalars {
            if Self.isNewline(scalar) {
                line.unicodeScalars.append(contentsOf: run)
                run = String.UnicodeScalarView()
                units += completeLine()
            } else {
                run.append(scalar)
            }
        }
        line.unicodeScalars.append(contentsOf: run)
        units += readPartialLine()
        return units
    }

    /// A tool ran between two runs of text: what came before is a finished
    /// paragraph (and any open code block or table ends).
    mutating func boundary() -> [SpeechUnit] {
        var units: [SpeechUnit] = []
        if !line.isEmpty || lineStarted { units += completeLine() }
        if inFence, options.includeCode { units += codeParagraph() }
        inFence = false
        codeLines = []
        units += flush()
        cues.leaveTable()
        return units
    }

    /// The reply is complete: say what is left.
    mutating func finish() -> [SpeechUnit] {
        var units = completeLine()
        // An unclosed fence is code to the end.
        if inFence, options.includeCode { units += codeParagraph() }
        inFence = false
        codeLines = []
        units += flush()
        cues.leaveTable()
        skipping = false
        skippingProse = false
        return units
    }

    /// Talk started in the middle of this reply: the sentence in progress
    /// began before, so it is dropped, and speech starts with the next one.
    mutating func skipCurrentSentence() {
        guard !inFence else { return }
        let hadPending = !pending.trimmingCharacters(in: .whitespaces).isEmpty
        pending = ""
        skipping = false
        skippingProse = false
        if lineStarted {
            skipping = hadPending || !line.trimmingCharacters(in: .whitespaces).isEmpty
            skippingProse = skipping
            line = ""
        } else if let first = line.first(where: { !Self.isSpaceOrTab($0) }) {
            skipping = true
            if Self.mayStartBlock(first) {
                // Kept to be read whole (it may open a code block); whatever
                // it turns out to say first is dropped.
                skippingProse = false
            } else {
                // Plain prose: what arrived is gone; the rest continues it.
                line = ""
                lineStarted = true
                skippingProse = true
            }
        } else if hadPending {
            skipping = true
            skippingProse = true
        }
    }

    // MARK: - Lines

    private mutating func completeLine() -> [SpeechUnit] {
        let text = line
        line = ""
        if lineStarted {
            lineStarted = false
            let hebrew = lineHebrew
            lineHebrew = false
            addProse(text, hebrewLine: hebrew || HebrewText.containsHebrew(text))
            return takeSentences()
        }
        lineHebrew = false
        return readLine(text)
    }

    /// One whole line, read as ``SpeechText/fromMarkdown(_:options:)`` reads
    /// it.
    private mutating func readLine(_ raw: String) -> [SpeechUnit] {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        var units: [SpeechUnit] = []
        if inFence {
            if trimmed.hasPrefix(fenceMarker) {
                inFence = false
                if options.includeCode { units += codeParagraph() }
                codeLines = []
            } else {
                codeLines.append(raw)
            }
            return units
        }
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            units += flush()
            inFence = true
            fenceMarker = String(trimmed.prefix(3))
            cues.leaveTable()
            if !options.includeCode { units += cue() }
            return units
        }
        if trimmed.isEmpty {
            units += flush()
            cues.leaveTable()
            return units
        }
        if trimmed.range(of: SpeechText.horizontalRulePattern, options: .regularExpression) != nil {
            units += flush()
            cues.leaveTable()
            return units
        }
        if trimmed.range(of: SpeechText.tableSeparatorPattern, options: .regularExpression) != nil {
            return units
        }
        if let heading = trimmed.range(of: SpeechText.headingPattern, options: .regularExpression) {
            units += flush()
            cues.leaveTable()
            addProse(String(trimmed[heading.upperBound...]))
            units += flush()
            return units
        }
        var text = trimmed
        if text.hasPrefix("|") {
            units += flush()
            if options.skipTables {
                if cues.enterTable() { units += cue() }
                return units
            }
            let cells = text.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            addInlined(cells.map { SpeechText.inline($0, options: options, protectingCode: true) }
                .joined(separator: ", "))
            units += flush()
            return units
        }
        cues.leaveTable()
        text = text.replacingOccurrences(of: SpeechText.blockQuotePattern, with: "", options: .regularExpression)
        let isListItem = text.range(of: SpeechText.listMarkerPattern, options: .regularExpression) != nil
        text = text.replacingOccurrences(of: SpeechText.listMarkerPattern, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: SpeechText.taskBoxPattern, with: "", options: .regularExpression)
        if isListItem {
            units += flush()
            addProse(text)
            units += flush()
        } else {
            addProse(text)
            units += takeSentences()
        }
        return units
    }

    /// Read the start of an incomplete line when it is prose and what is read
    /// can't change with the rest of the line.
    private mutating func readPartialLine() -> [SpeechUnit] {
        guard !inFence, !line.isEmpty else { return [] }
        if !lineStarted {
            guard let first = line.first(where: { !Self.isSpaceOrTab($0) }), !Self.mayStartBlock(first) else {
                return []
            }
        }
        guard let cut = Self.lastSafeSpace(in: line) else { return [] }
        let piece = String(line[..<cut])
        line = String(line[cut...])
        lineStarted = true
        lineHebrew = lineHebrew || HebrewText.containsHebrew(piece)
        addProse(piece, hebrewLine: lineHebrew)
        return takeSentences()
    }

    // MARK: - Paragraphs

    private mutating func addProse(_ raw: String, hebrewLine: Bool? = nil) {
        addInlined(SpeechText.inline(raw, options: options, protectingCode: true, hebrewLine: hebrewLine))
    }

    private mutating func addInlined(_ text: String) {
        let collapsed = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard !collapsed.isEmpty else { return }
        pending += collapsed + " "
        paragraph += paragraph.isEmpty ? collapsed : " " + collapsed
    }

    /// Emit the complete sentences at the start of `pending`, and cut it when
    /// it grew past the longest unit without ending a sentence.
    private mutating func takeSentences() -> [SpeechUnit] {
        var units: [SpeechUnit] = []
        while let end = Self.sentenceEnd(in: pending) {
            let sentence = String(pending[..<end])
            pending = String(pending[pending.index(after: end)...])
            units += emit(sentence, completesSentence: true)
        }
        while pending.trimmingCharacters(in: .whitespaces).count > Self.maxUnitLength {
            let (head, rest) = Self.cut(pending)
            pending = rest
            units += emit(head, completesSentence: false)
        }
        return units
    }

    /// The paragraph ended: say the rest of it.
    private mutating func flush() -> [SpeechUnit] {
        var units = takeSentences()
        let rest = pending.trimmingCharacters(in: .whitespaces)
        pending = ""
        if !rest.isEmpty {
            units += emit(rest, completesSentence: true, endsParagraph: true)
        }
        if !paragraph.isEmpty {
            cues.prose(SpeechText.restoreProtected(paragraph))
            paragraph = ""
        }
        if skippingProse {
            skipping = false
            skippingProse = false
        }
        return units
    }

    private mutating func cue() -> [SpeechUnit] {
        guard let text = cues.next() else { return [] }
        return emit(SpeechText.sentence(text), completesSentence: true, kind: .cue)
    }

    /// Code read aloud (``SpeechText/MarkdownOptions/includeCode``).
    private mutating func codeParagraph() -> [SpeechUnit] {
        let code = codeLines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .joined(separator: ". ")
        guard !code.isEmpty else { return [] }
        var text = SpeechText.sentence(code) + " "
        var units: [SpeechUnit] = []
        while let end = Self.sentenceEnd(in: text) {
            units += emit(String(text[..<end]), completesSentence: true)
            text = String(text[text.index(after: end)...])
        }
        let rest = text.trimmingCharacters(in: .whitespaces)
        if !rest.isEmpty { units += emit(rest, completesSentence: true) }
        return units
    }

    // MARK: - Units

    private mutating func emit(_ text: String, completesSentence: Bool, endsParagraph: Bool = false,
                               kind: SpeechUnit.Kind = .sentence) -> [SpeechUnit] {
        var restored = SpeechText.restoreProtected(text)
        if endsParagraph { restored = SpeechText.sentence(restored) }
        if skipping {
            if completesSentence {
                skipping = false
                skippingProse = false
            }
            return []
        }
        var units: [SpeechUnit] = []
        var rest = restored
        while rest.count > Self.maxUnitLength {
            let (head, tail) = Self.cut(rest)
            units.append(unit(head, kind: kind))
            rest = tail
        }
        let last = rest.trimmingCharacters(in: .whitespaces)
        if !last.isEmpty { units.append(unit(last, kind: kind)) }
        return units
    }

    private mutating func unit(_ text: String, kind: SpeechUnit.Kind) -> SpeechUnit {
        defer { emitted += 1 }
        return SpeechUnit(id: SpeechUnit.ID(reply: reply, index: emitted), text: text,
                          isFirstOfReply: emitted == 0, kind: kind)
    }

    // MARK: - Sentence ends

    /// English abbreviations whose period doesn't end a sentence.
    static let abbreviations: Set<String> = [
        "e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "no", "nos", "fig", "approx",
        "inc", "ltd", "co", "corp", "cf", "al", "a.m", "p.m", "u.s", "u.k", "jan", "feb", "mar", "apr", "jun",
        "jul", "aug", "sep", "sept", "oct", "nov", "dec", "vol", "ver", "est", "dept", "min", "max", "ca",
    ]

    private static let sentenceEnders: Set<Character> = [".", "!", "?", "…"]

    /// The index of the space after the first complete sentence in `text`:
    /// a word ending in . ! ? or … and then a space, unless it is an
    /// abbreviation or an initial.
    static func sentenceEnd(in text: String) -> String.Index? {
        var tokenStart = text.startIndex
        var i = text.startIndex
        while i < text.endIndex {
            if text[i] == " " {
                if i > tokenStart, let last = text[tokenStart..<i].last, sentenceEnders.contains(last),
                   !isAbbreviation(text[tokenStart..<i]) {
                    return i
                }
                tokenStart = text.index(after: i)
            }
            i = text.index(after: i)
        }
        return nil
    }

    /// A word whose final period belongs to it: a known abbreviation
    /// ("e.g.", "Dr.") or a single letter (an initial, "א.").
    static func isAbbreviation(_ token: Substring) -> Bool {
        guard token.hasSuffix("."), !token.hasSuffix("..") else { return false }
        let word = token.dropLast().drop(while: { "([{\"'“‘«".contains($0) })
        if word.count == 1, let c = word.first, c.isLetter { return true }
        return abbreviations.contains(word.lowercased())
    }

    /// Cut a text longer than ``maxUnitLength``: after the last comma, colon,
    /// semicolon or dash that leaves a unit of at least 100 characters, else
    /// at the last space, else hard at the limit.
    static func cut(_ text: String) -> (head: String, rest: String) {
        let chars = Array(text)
        let limit = min(maxUnitLength, chars.count - 1)
        var lastSpace: Int?
        var lastPause: Int?
        if limit >= 1 {
            for i in 1...limit where chars[i] == " " {
                lastSpace = i
                let before = chars[i - 1]
                if ",;:—–".contains(before) || (before == "-" && i >= 2 && chars[i - 2] == " ") {
                    lastPause = i
                }
            }
        }
        if let at = (lastPause.flatMap { $0 >= 100 ? $0 : nil }) ?? lastSpace {
            return (String(chars[..<at]), String(chars[(at + 1)...]))
        }
        return (String(chars[..<maxUnitLength]), String(chars[maxUnitLength...]))
    }

    // MARK: - Characters

    /// The last space in an incomplete prose line before anything whose
    /// reading depends on what comes after it.
    static func lastSafeSpace(in line: String) -> String.Index? {
        var best: String.Index?
        var prev: Character?
        var i = line.startIndex
        while i < line.endIndex {
            let c = line[i]
            let nextIndex = line.index(after: i)
            let next: Character? = nextIndex < line.endIndex ? line[nextIndex] : nil
            if isUndecided(c, prev: prev, next: next) { break }
            if c.isWhitespace, i > line.startIndex { best = i }
            prev = c
            i = nextIndex
        }
        return best
    }

    /// A character whose reading can depend on the rest of the line.
    private static func isUndecided(_ c: Character, prev: Character?, next: Character?) -> Bool {
        switch c {
        case "`", "*", "[", "\u{F0000}", "\u{F0001}", "\u{F0002}", "\u{F0003}":
            return true
        case "~":
            return next == nil || next == "~"
        case "_":
            guard let prev, let next else { return true }
            return !(prev.isLetter || prev.isNumber) || !(next.isLetter || next.isNumber)
        case "<":
            guard let next else { return true }
            return next.isLetter || next == "/"
        case ":":
            return next == nil || next == "/"
        case "\"", "'", "\u{2018}", "\u{2019}", "\u{201C}", "\u{201D}":
            return next == nil || (prev.map(HebrewText.isHebrewLetter) ?? false)
                || HebrewText.isHebrewLetter(next ?? " ")
        default:
            return false
        }
    }

    /// A first character that may make a line something other than prose.
    static func mayStartBlock(_ c: Character) -> Bool {
        "`~#|-*_+>[:".contains(c) || c.isNumber
    }

    private static func isSpaceOrTab(_ c: Character) -> Bool {
        c == " " || c == "\t" || (c.isWhitespace && !c.isNewline)
    }

    /// The line breaks `components(separatedBy: .newlines)` splits at.
    private static func isNewline(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0A...0x0D, 0x85, 0x2028, 0x2029: return true
        default: return false
        }
    }
}
