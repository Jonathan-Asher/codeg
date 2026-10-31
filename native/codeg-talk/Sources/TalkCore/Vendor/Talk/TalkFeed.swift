import Foundation

/// What of the session Talk speaks, from what the session shows: the live
/// turn's main-thread text and the turns background work adds, each spoken
/// past its own cursor so nothing is said twice.
///
/// - Each call passes the whole text so far; only what lies past the cursor
///   is read. After a reconnect the text may be rebuilt: reading resumes at
///   the longer of the common prefix and the cursor.
/// - When Talk starts in the middle of a turn, what is already there is not
///   spoken (nor the rest of the sentence in progress).
/// - The turn being held for background work gives one cue, after the
///   reply's last sentence.
/// - Background turns are upserted by id, each with its own cursor.
struct TalkFeed: Sendable {
    let options: SpeechText.MarkdownOptions

    private var live: Stream?
    private var background: [String: Stream] = [:]
    private var awaiting = false
    /// Live turns that already gave the background cue.
    private var cuedTurns: Set<String> = []

    /// `language`: Talk's language setting; with auto, cues before any
    /// prose are Hebrew.
    init(language: SpeechUnit.Language = .auto) {
        var options = SpeechText.MarkdownOptions.talk
        options.screenCue?.hebrewByDefault = language != .english
        self.options = options
    }

    /// Talk starts: the live turn and the background turns as they are now
    /// are taken as heard.
    mutating func start(liveTurnID: String?, liveText: String, backgroundTurns turns: [MessageTurn]) {
        if let liveTurnID {
            var stream = Stream(reply: liveTurnID, options: options)
            stream.takeAsHeard(liveText)
            live = stream
        } else {
            live = nil
        }
        background = [:]
        for turn in turns where turn.role == .assistant {
            var stream = Stream(reply: turn.id, options: options)
            stream.takeAsHeard(Self.spokenText(of: turn))
            background[turn.id] = stream
        }
    }

    /// The live turn's text: its main-thread text runs joined in order, with
    /// "\n\n" where a tool ran (sub-agents' text is not in it).
    mutating func liveText(turnID: String, text: String, isStreaming: Bool) -> [SpeechUnit] {
        var units: [SpeechUnit] = []
        if live?.reply != turnID {
            // A new turn. One whose end was missed says its last sentence.
            if var previous = live, !previous.finished {
                units += previous.finish()
            }
            live = Stream(reply: turnID, options: options)
        }
        guard var stream = live else { return units }
        units += stream.update(text)
        if !isStreaming { units += stream.finish() }
        live = stream
        return units
    }

    /// The live turn ended; a cancelled one doesn't finish its sentence.
    mutating func turnEnded(turnID: String, stopReason: String?) -> [SpeechUnit] {
        awaiting = false
        guard var stream = live, stream.reply == turnID else { return [] }
        let units = stopReason == "cancelled" ? stream.drop() : stream.finish()
        live = stream
        return units
    }

    /// The turn is held only for background work (or no longer is).
    mutating func awaitingBackground(_ isAwaiting: Bool) -> [SpeechUnit] {
        defer { awaiting = isAwaiting }
        guard isAwaiting, !awaiting else { return [] }
        var units: [SpeechUnit] = []
        var hebrew = options.screenCue?.hebrewByDefault ?? true
        var reply = "background"
        if var stream = live {
            units += stream.finish()
            hebrew = stream.contextIsHebrew
            reply = stream.reply
            live = stream
        }
        guard !cuedTurns.contains(reply) else { return units }
        cuedTurns.insert(reply)
        units.append(SpeechUnit(id: SpeechUnit.ID(reply: "\(reply):background", index: 0),
                                text: SpokenPrompts.backgroundWork(hebrew: hebrew), isFirstOfReply: true, kind: .cue))
        return units
    }

    /// The turns background work added (whole turns, upserted by id).
    mutating func backgroundTurns(_ turns: [MessageTurn]) -> [SpeechUnit] {
        var units: [SpeechUnit] = []
        for turn in turns where turn.role == .assistant {
            var stream = background[turn.id] ?? Stream(reply: turn.id, options: options)
            units += stream.update(Self.spokenText(of: turn))
            background[turn.id] = stream
        }
        return units
    }

    /// Background turns written before Talk started: what they hold is taken
    /// as heard, and only what they gain from now on is spoken. A turn
    /// already followed is left as it is.
    mutating func takeAsHeard(backgroundTurns turns: [MessageTurn]) {
        for turn in turns where turn.role == .assistant && background[turn.id] == nil {
            var stream = Stream(reply: turn.id, options: options)
            stream.takeAsHeard(Self.spokenText(of: turn))
            background[turn.id] = stream
        }
    }

    /// Whether a background turn is followed already.
    func follows(backgroundTurn id: String) -> Bool { background[id] != nil }

    /// A turn's text blocks, each a finished paragraph.
    static func spokenText(of turn: MessageTurn) -> String {
        var text = ""
        for block in turn.blocks {
            if case .text(let run) = block, !run.isEmpty { text += run + "\n\n" }
        }
        return text
    }

    /// One reply read past a cursor.
    private struct Stream: Sendable {
        let reply: String
        var reader: IncrementalSpeechText
        /// The text last seen, as scalars (a combining mark never merges
        /// across a cut).
        var seen: [Unicode.Scalar] = []
        /// How much of it was read.
        var cursor = 0
        var finished = false

        init(reply: String, options: SpeechText.MarkdownOptions) {
            self.reply = reply
            self.reader = IncrementalSpeechText(reply: reply, options: options)
        }

        var contextIsHebrew: Bool { reader.contextIsHebrew }

        mutating func update(_ text: String) -> [SpeechUnit] {
            let scalars = Array(text.unicodeScalars)
            var common = 0
            let limit = min(seen.count, scalars.count)
            while common < limit, seen[common] == scalars[common] { common += 1 }
            let from = max(common, cursor)
            seen = scalars
            guard from < scalars.count else { return [] }
            cursor = scalars.count
            finished = false
            var piece = String.UnicodeScalarView()
            piece.append(contentsOf: scalars[from...])
            return reader.append(String(piece))
        }

        /// What is there is taken as already heard.
        mutating func takeAsHeard(_ text: String) {
            seen = Array(text.unicodeScalars)
            cursor = seen.count
            _ = reader.append(text)
            reader.skipCurrentSentence()
        }

        mutating func finish() -> [SpeechUnit] {
            guard !finished else { return [] }
            finished = true
            return reader.finish()
        }

        /// End without saying the sentence in progress.
        mutating func drop() -> [SpeechUnit] {
            guard !finished else { return [] }
            finished = true
            reader.skipCurrentSentence()
            return reader.finish()
        }
    }
}
