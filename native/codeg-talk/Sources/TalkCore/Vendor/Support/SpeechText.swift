import Foundation

/// Turns an agent reply into text worth reading aloud: the prose, with the
/// Markdown stripped. Fenced code blocks and tool output are skipped unless
/// the options ask for them.
enum SpeechText {
    struct Options: Equatable, Sendable {
        var includeCode = false
        var includeToolOutput = false
    }

    /// The longest tool output read aloud when tool output is included.
    static let toolOutputLimit = 600

    /// The speakable text of an assistant reply's blocks.
    static func from(blocks: [ContentBlock], options: Options = Options()) -> String {
        var paragraphs: [String] = []
        for block in blocks {
            switch block {
            case .text(let markdown):
                let text = fromMarkdown(markdown, includeCode: options.includeCode)
                if !text.isEmpty { paragraphs.append(text) }
            case .toolUse(_, let name, _, _):
                if options.includeToolOutput { paragraphs.append(sentence("Tool: \(name)")) }
            case .toolResult(_, let output, _, _):
                guard options.includeToolOutput, let output else { continue }
                let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                let clipped = trimmed.count > toolOutputLimit ? String(trimmed.prefix(toolOutputLimit)) : trimmed
                paragraphs.append(fromMarkdown(clipped, includeCode: true))
            case .thinking, .image, .imageGeneration, .unknown:
                continue
            }
        }
        return paragraphs.joined(separator: "\n\n")
    }

    /// Strip Markdown to readable prose, one paragraph per line group; every
    /// paragraph ends with punctuation so the synthesizer pauses there.
    static func fromMarkdown(_ markdown: String, includeCode: Bool = false) -> String {
        fromMarkdown(markdown, options: MarkdownOptions(includeCode: includeCode))
    }

    /// ``fromMarkdown(_:includeCode:)`` with the reading choices in `options`
    /// (Talk reads tables, paths and links differently from Read Aloud).
    static func fromMarkdown(_ markdown: String, options: MarkdownOptions) -> String {
        let includeCode = options.includeCode
        var paragraphs: [String] = []
        var current: [String] = []
        var inFence = false
        var fenceMarker = ""
        var codeLines: [String] = []
        var cues = ScreenCueTracker(cue: options.screenCue)

        func flush() {
            let joined = current.joined(separator: " ")
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty {
                paragraphs.append(sentence(joined))
                cues.prose(joined)
            }
            current = []
        }

        func cue() {
            if let text = cues.next() { paragraphs.append(sentence(text)) }
        }

        for rawLine in markdown.components(separatedBy: .newlines) {
            let sourceLine = options.cleanHebrew ? HebrewText.stripMarks(rawLine) : rawLine
            let line = sourceLine.trimmingCharacters(in: .whitespaces)
            // Fenced code: ``` or ~~~ (with an optional language).
            if inFence {
                if line.hasPrefix(fenceMarker) {
                    inFence = false
                    if includeCode {
                        let code = codeLines.map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                            .joined(separator: ". ")
                        if !code.isEmpty { paragraphs.append(sentence(code)) }
                    }
                    codeLines = []
                } else {
                    codeLines.append(sourceLine)
                }
                continue
            }
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                flush()
                inFence = true
                fenceMarker = String(line.prefix(3))
                cues.leaveTable()
                if !includeCode { cue() }
                continue
            }
            if line.isEmpty {
                flush()
                cues.leaveTable()
                continue
            }
            // Horizontal rules.
            if line.range(of: horizontalRulePattern, options: .regularExpression) != nil {
                flush()
                cues.leaveTable()
                continue
            }
            // Table separator rows (|---|:--:|).
            if line.range(of: tableSeparatorPattern, options: .regularExpression) != nil {
                continue
            }
            // Headings stand alone.
            if let heading = line.range(of: headingPattern, options: .regularExpression) {
                flush()
                cues.leaveTable()
                current.append(inline(String(line[heading.upperBound...]), options: options))
                flush()
                continue
            }
            var text = line
            // Table rows: read the cells, or skip the table and say the cue once.
            if text.hasPrefix("|") {
                flush()
                if options.skipTables {
                    if cues.enterTable() { cue() }
                    continue
                }
                let cells = text.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                current.append(cells.map { inline($0, options: options) }.joined(separator: ", "))
                flush()
                continue
            }
            cues.leaveTable()
            // Block quotes, list markers, task boxes.
            text = text.replacingOccurrences(of: blockQuotePattern, with: "", options: .regularExpression)
            let isListItem = text.range(of: listMarkerPattern, options: .regularExpression) != nil
            text = text.replacingOccurrences(of: listMarkerPattern, with: "", options: .regularExpression)
            text = text.replacingOccurrences(of: taskBoxPattern, with: "", options: .regularExpression)
            if isListItem {
                // Each item reads as its own sentence.
                flush()
                current.append(inline(text, options: options))
                flush()
            } else {
                current.append(inline(text, options: options))
            }
        }
        // An unclosed fence is code to the end.
        if inFence, includeCode {
            let code = codeLines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                .joined(separator: ". ")
            if !code.isEmpty { paragraphs.append(sentence(code)) }
        }
        flush()
        return paragraphs.joined(separator: "\n")
    }

    // Line patterns, shared with the streaming reader (IncrementalSpeechText).
    static let horizontalRulePattern = #"^([-*_])(\s*\1){2,}$"#
    static let tableSeparatorPattern = #"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$"#
    static let headingPattern = #"^#{1,6}\s+"#
    static let blockQuotePattern = #"^(>\s*)+"#
    static let listMarkerPattern = #"^([-*+]|\d{1,3}[.)])\s+"#
    static let taskBoxPattern = #"^\[[ xX]\]\s+"#

    /// Inline Markdown: images and links keep their text, URLs drop, inline
    /// code keeps its content, emphasis markers and HTML tags go.
    static func inline(_ text: String) -> String {
        inline(text, options: MarkdownOptions())
    }

    /// ``inline(_:)`` with the reading choices in `options`.
    static func inline(_ text: String, options: MarkdownOptions) -> String {
        inline(text, options: options, protectingCode: false)
    }

    /// `protectingCode` keeps the sentence punctuation inside inline code as
    /// stand-ins (``restoreProtected(_:)`` puts it back), so a reader that
    /// splits sentences never splits inside code. `hebrewLine` says whether
    /// the whole line holds Hebrew when `text` is only part of it (it picks
    /// the word a URL becomes).
    static func inline(_ text: String, options: MarkdownOptions, protectingCode: Bool,
                       hebrewLine: Bool? = nil) -> String {
        var s = options.cleanHebrew ? HebrewText.forSpeech(text) : text
        func apply(_ pattern: String, _ template: String) {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        apply(#"!\[([^\]]*)\]\([^)]*\)"#, "$1")            // images → alt text
        apply(#"\[([^\]]+)\]\([^)]*\)"#, "$1")              // links → text
        if options.talkLinks {
            // A URL becomes a word in the line's language; the sentence
            // punctuation after it stays.
            let word = (hebrewLine ?? HebrewText.containsHebrew(s)) ? options.hebrewLinkWord : options.linkWord
            let template = NSRegularExpression.escapedTemplate(for: word)
            apply(#"<(https?://[^>]+)>"#, template)
            apply(talkURLPattern, template)
        } else {
            apply(#"<(https?://[^>]+)>"#, "")                    // autolinks
            apply(#"https?://\S+"#, "a link")                   // bare URLs
        }
        if options.shortenPaths { s = shortenPaths(s) }
        if options.dropHexRuns { s = dropHexRuns(s) }
        if protectingCode {
            s = protectInlineCode(s)                             // inline code → content, marked
        } else {
            apply(#"`+([^`]+)`+"#, "$1")                         // inline code → content
        }
        apply(#"(\*\*|__)(.+?)\1"#, "$2")                       // bold
        apply(#"(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])"#, "$1")  // *italic*
        apply(#"(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])"#, "$1")    // _italic_
        apply(#"~~(.+?)~~"#, "$1")                               // strikethrough
        apply(#"</?[A-Za-z][^>]*>"#, " ")                        // HTML tags
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// End with sentence punctuation so the synthesizer pauses.
    static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return trimmed }
        return ".!?:;…".contains(last) ? trimmed : trimmed + "."
    }

    // MARK: - Reading options

    /// How ``fromMarkdown(_:options:)`` reads the parts of a reply that don't
    /// speak well. The defaults are what ``fromMarkdown(_:includeCode:)``
    /// has always done (Read Aloud); ``talk`` is how Talk reads a reply.
    struct MarkdownOptions: Equatable, Sendable {
        /// Read fenced code blocks.
        var includeCode = false
        /// Skip tables instead of reading their cells.
        var skipTables = false
        /// Said once in place of a skipped code block or table.
        var screenCue: ScreenCue?
        /// A URL becomes ``linkWord``, or ``hebrewLinkWord`` in a line with
        /// Hebrew, keeping the punctuation after it (Read Aloud says "a link"
        /// and drops autolinks).
        var talkLinks = false
        var linkWord = "a link"
        var hebrewLinkWord = "קישור"
        /// Read a file path as its last component.
        var shortenPaths = false
        /// Drop runs of 12 or more hex digits (commit hashes, ids).
        var dropHexRuns = false
        /// Strip nikud and bidi marks, and normalize geresh and gershayim.
        var cleanHebrew = false

        /// Talk: code and tables are on the screen, not read.
        static let talk = MarkdownOptions(skipTables: true, screenCue: .standard, talkLinks: true,
                                          shortenPaths: true, dropHexRuns: true, cleanHebrew: true)
    }

    /// The cue that stands in for what is only on the screen. It is said in
    /// the language of the prose before it, else in Hebrew when
    /// `hebrewByDefault`.
    struct ScreenCue: Equatable, Sendable {
        var hebrew: String
        var english: String
        var hebrewByDefault = true

        static let standard = ScreenCue(hebrew: "שמתי את זה על המסך", english: "It's on the screen")
    }

    /// When a screen cue is said: once for each code block or table, not
    /// twice in a row, and not right after prose that already mentions the
    /// screen.
    struct ScreenCueTracker: Equatable, Sendable {
        var cue: ScreenCue?
        private(set) var inTable = false
        private(set) var lastWasCue = false
        /// Whether the last prose paragraph was Hebrew (nil before any).
        private(set) var proseHebrew: Bool?
        private(set) var proseMentionsScreen = false

        init(cue: ScreenCue?) { self.cue = cue }

        mutating func prose(_ paragraph: String) {
            lastWasCue = false
            if HebrewText.containsHebrew(paragraph) {
                proseHebrew = true
            } else if HebrewText.containsLatin(paragraph) {
                proseHebrew = false
            }
            proseMentionsScreen = SpeechText.mentionsScreen(paragraph)
        }

        mutating func leaveTable() { inTable = false }

        /// A table row; true when it starts a table.
        mutating func enterTable() -> Bool {
            defer { inTable = true }
            return !inTable
        }

        /// The cue to say now, if one is due.
        mutating func next() -> String? {
            guard let cue, !lastWasCue, !proseMentionsScreen else { return nil }
            lastWasCue = true
            return (proseHebrew ?? cue.hebrewByDefault) ? cue.hebrew : cue.english
        }

        /// Whether a cue now would be in Hebrew.
        var cueIsHebrew: Bool { proseHebrew ?? cue?.hebrewByDefault ?? true }
    }

    /// A bare URL without the sentence punctuation after it.
    static let talkURLPattern = #"https?://[^\s<>]*[^\s<>.,;:!?'"’”)\]}]"#

    /// Read a file path as its last component: `src/auth/login.ts` →
    /// `login.ts`, `~/Work/codeg/` → `codeg`. A path starts with `/`, `~/`,
    /// `./` or `../`, or has two slashes, or ends in a file name with an
    /// extension; `and/or` and dates are left alone.
    static func shortenPaths(_ text: String) -> String {
        guard text.contains("/"), let regex = pathRegex else { return text }
        let ns = text as NSString
        var out = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            func group(_ i: Int) -> String? {
                let r = match.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
            let lead = group(1)
            let rootSlash = group(2) != nil
            let directories = group(3) ?? ""
            var last = group(4) ?? ""
            var trailing = ""
            while let end = last.last, end == "." || end == "-" {
                trailing = String(end) + trailing
                last.removeLast()
            }
            let segments = directories.split(separator: "/").map(String.init)
            let slashes = segments.count + (rootSlash ? 1 : 0)
            let hasExtension = last.range(of: #"^[^.]+\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$"#,
                                          options: .regularExpression) != nil
            guard lead != nil || rootSlash || slashes >= 2 || hasExtension else { continue }
            let parts = segments + (last.isEmpty ? [] : [last])
            if parts.allSatisfy({ $0.allSatisfy(\.isNumber) }) { continue }
            guard let name = last.isEmpty ? segments.last : last, !name.isEmpty,
                  let range = Range(match.range, in: out) else { continue }
            out.replaceSubrange(range, with: name + trailing)
        }
        return out
    }

    private static let pathRegex = try? NSRegularExpression(
        pattern: #"(?<![A-Za-z0-9_@:/.~\\])(~|\.{1,2})?(/)?((?:[A-Za-z0-9_@+.][A-Za-z0-9_@+.\-]*/)+)((?:[A-Za-z0-9_@+.][A-Za-z0-9_@+.\-]*)?)"#)

    /// Drop runs of 12 or more hex digits (and the brackets around one). Only
    /// characters next to the run are touched, so a line read in pieces reads
    /// the same.
    static func dropHexRuns(_ text: String) -> String {
        let dropped = text.replacingOccurrences(of: #"(?<![A-Za-z0-9])(?:0x)?[0-9A-Fa-f]{12,}(?![A-Za-z0-9])"#,
                                                with: "", options: .regularExpression)
        guard dropped != text else { return text }
        return dropped.replacingOccurrences(of: #"\(\)|\[\]"#, with: "", options: .regularExpression)
    }

    /// Whether the text speaks of the screen (המסך, על המסך, on the screen).
    static func mentionsScreen(_ text: String) -> Bool {
        HebrewText.words(text).contains { word in
            (word.hasSuffix("מסך") && word.count <= 6) || (word.hasSuffix("מסכים") && word.count <= 8)
                || word == "screen" || word == "screens" || word == "onscreen"
        }
    }

    // Stand-ins for the sentence punctuation inside inline code, from the
    // supplementary private use area (never in a reply).
    private static let protectedPunctuation: [(Character, Character)] = [
        (".", "\u{F0000}"), ("!", "\u{F0001}"), ("?", "\u{F0002}"), ("…", "\u{F0003}"),
    ]

    private static let inlineCodeRegex = try? NSRegularExpression(pattern: #"`+([^`]+)`+"#)

    private static func protectInlineCode(_ text: String) -> String {
        guard text.contains("`"), let regex = inlineCodeRegex else { return text }
        let ns = text as NSString
        var out = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            var content = ns.substring(with: match.range(at: 1))
            for (plain, standIn) in protectedPunctuation {
                content = content.replacingOccurrences(of: String(plain), with: String(standIn))
            }
            if let range = Range(match.range, in: out) { out.replaceSubrange(range, with: content) }
        }
        return out
    }

    /// Undo the stand-ins of ``inline(_:options:protectingCode:)``.
    static func restoreProtected(_ text: String) -> String {
        guard text.unicodeScalars.contains(where: { (0xF0000...0xF0003).contains($0.value) }) else { return text }
        var out = text
        for (plain, standIn) in protectedPunctuation {
            out = out.replacingOccurrences(of: String(standIn), with: String(plain))
        }
        return out
    }

    // MARK: - Script runs (system-voice fallback)

    /// A run of text in one script, for picking a system voice per span.
    struct Run: Equatable, Sendable {
        var text: String
        var isHebrew: Bool
    }

    /// Split into Hebrew and non-Hebrew runs. Digits, spaces and punctuation
    /// stay with the run they sit in; a Latin span only splits off when it
    /// holds a letter.
    static func scriptRuns(_ text: String) -> [Run] {
        var runs: [Run] = []
        var current = ""
        var currentHebrew: Bool?

        for ch in text {
            let script = Self.script(of: ch)
            guard let isHebrew = script else {
                current.append(ch)
                continue
            }
            if currentHebrew == nil {
                currentHebrew = isHebrew
            } else if currentHebrew != isHebrew {
                // Leave trailing neutral characters with the run that ends.
                let piece = current.trimmingCharacters(in: .whitespaces)
                if !piece.isEmpty { runs.append(Run(text: piece, isHebrew: currentHebrew ?? false)) }
                current = ""
                currentHebrew = isHebrew
            }
            current.append(ch)
        }
        let piece = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !piece.isEmpty { runs.append(Run(text: piece, isHebrew: currentHebrew ?? false)) }
        return runs
    }

    /// true = Hebrew letter, false = Latin letter, nil = neutral.
    private static func script(of ch: Character) -> Bool? {
        for scalar in ch.unicodeScalars {
            switch scalar.value {
            case 0x0590...0x05FF, 0xFB1D...0xFB4F: return true
            case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F: return false
            default: continue
            }
        }
        return nil
    }

    /// Whether the text contains any Hebrew letter.
    static func containsHebrew(_ text: String) -> Bool {
        text.unicodeScalars.contains { (0x0590...0x05FF).contains($0.value) || (0xFB1D...0xFB4F).contains($0.value) }
    }
}
