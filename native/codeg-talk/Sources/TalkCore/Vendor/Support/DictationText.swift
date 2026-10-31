import Foundation

/// Pure text handling for dictation: cleaning whisper's output, inserting it
/// at the cursor, and the prompt that biases whisper toward the session's
/// vocabulary.
enum DictationText {
    // MARK: - Cleaning

    /// Trim, and treat output made only of non-speech markers ("[BLANK_AUDIO]",
    /// "(מוזיקה)") as nothing. Port of Speakly's `postprocess`.
    static func clean(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }
        let words = text.split(whereSeparator: \.isWhitespace)
        let isMarker: (Substring) -> Bool = { word in
            (word.hasPrefix("[") && word.hasSuffix("]")) || (word.hasPrefix("(") && word.hasSuffix(")"))
        }
        if words.allSatisfy(isMarker) { return "" }
        return words.joined(separator: " ")
    }

    // MARK: - Insertion

    /// Insert `transcript` into `text`, replacing `selection` (UTF-16 offsets,
    /// as the text field reports them) or appending when there is none.
    /// A space is added where the transcript would otherwise touch a word.
    /// Returns the new text and the UTF-16 offset just after the inserted
    /// words, where the cursor belongs.
    static func insert(_ transcript: String, into text: String,
                       selection: Range<Int>?) -> (text: String, cursor: Int) {
        let words = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let utf16Count = text.utf16.count
        let lowerOffset = min(max(0, selection?.lowerBound ?? utf16Count), utf16Count)
        let upperOffset = min(max(lowerOffset, selection?.upperBound ?? utf16Count), utf16Count)
        guard !words.isEmpty else { return (text, upperOffset) }

        let lower = characterAligned(String.Index(utf16Offset: lowerOffset, in: text), in: text)
        let upper = max(lower, characterAligned(String.Index(utf16Offset: upperOffset, in: text), in: text))
        let before = text[..<lower]
        let after = text[upper...]

        var inserted = ""
        if let last = before.last, !last.isWhitespace, !(words.first.map(isClosingPunctuation) ?? false) {
            inserted += " "
        }
        inserted += words
        let cursor = before.utf16.count + inserted.utf16.count
        if let next = after.first, !next.isWhitespace, !isClosingPunctuation(next) {
            inserted += " "
        }
        return (String(before) + inserted + String(after), cursor)
    }

    private static func characterAligned(_ index: String.Index, in text: String) -> String.Index {
        // Round down onto a Character boundary (an offset may point inside a
        // grapheme cluster such as an emoji or a letter with niqqud).
        var i = text.startIndex
        while i < text.endIndex {
            let next = text.index(after: i)
            if next > index { return i }
            i = next
        }
        return text.endIndex
    }

    private static func isClosingPunctuation(_ c: Character) -> Bool {
        ".,!?:;)]}״׳'\"…".contains(c)
    }

    // MARK: - Prompt

    /// Whisper reads the prompt as the text that came before. A Hebrew
    /// sentence with code words in Latin letters, then an English one, keeps
    /// terms like README or push in English letters without pulling English
    /// speech into Hebrew. Measured on the test clips (docs/FORK.md): a
    /// Hebrew-only sentence made the model translate English speech into
    /// Hebrew; this mixed one did not.
    static let hebrewStyle = "עדכנתי את ה-README ועשיתי push ל-main. The build passes."
    static let englishStyle = "I updated the README and pushed to main. The build passes."

    /// Longest prompt passed to whisper, in characters. Whisper keeps at most
    /// 224 prompt tokens and a long prompt slows the decode.
    static let maxPromptLength = 240

    /// The initial prompt: the workspace folder and session title, then a
    /// style sentence with common code words. `language` is the whisper code
    /// the decode uses ("en" gets the English sentence; Hebrew and detection
    /// get the mixed one).
    static func prompt(folder: String?, session: String?, language: String?) -> String {
        var context: [String] = []
        for part in [folder, session] {
            let trimmed = (part ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !context.contains(trimmed) { context.append(String(trimmed.prefix(80))) }
        }
        let style = language == "en" ? englishStyle : hebrewStyle
        let head = context.isEmpty ? "" : context.joined(separator: " · ") + ". "
        let prompt = head + style
        return prompt.count <= maxPromptLength ? prompt : String(prompt.suffix(maxPromptLength))
    }
}

/// Tap-or-hold behaviour of the mic button. A press that lifts quickly latches
/// recording on (tap to start, tap again to stop); a press held longer than
/// ``holdThreshold`` is push-to-talk and stops on release.
struct DictationPress: Equatable, Sendable {
    static let holdThreshold: TimeInterval = 0.35

    enum Action: Equatable, Sendable {
        case none
        case start
        case stop
    }

    private enum Phase: Equatable {
        case idle
        /// Finger down on a fresh press, recording started at `since`.
        case pressing(since: TimeInterval)
        /// Tapped: recording until the next tap.
        case latched
        /// The stopping tap is down; ignore its release.
        case stopping
    }

    private var phase = Phase.idle

    var isRecording: Bool {
        switch phase {
        case .pressing, .latched: true
        case .idle, .stopping: false
        }
    }

    mutating func down(at time: TimeInterval) -> Action {
        switch phase {
        case .idle:
            phase = .pressing(since: time)
            return .start
        case .latched:
            phase = .stopping
            return .stop
        case .pressing, .stopping:
            return .none
        }
    }

    mutating func up(at time: TimeInterval) -> Action {
        switch phase {
        case .pressing(let since):
            if time - since < Self.holdThreshold {
                phase = .latched
                return .none
            }
            phase = .idle
            return .stop
        case .stopping:
            phase = .idle
            return .none
        case .idle, .latched:
            return .none
        }
    }

    /// Recording ended some other way (cancel, error, interruption).
    mutating func reset() { phase = .idle }

    /// Line up with what the recorder is actually doing before a new touch:
    /// a start can fail (no model, no permission) or finish after the finger
    /// lifted (the permission prompt), and the next tap must still do the
    /// obvious thing: start when idle, stop when recording.
    mutating func sync(isRecording recording: Bool) {
        guard recording != isRecording else { return }
        phase = recording ? .latched : .idle
    }
}
