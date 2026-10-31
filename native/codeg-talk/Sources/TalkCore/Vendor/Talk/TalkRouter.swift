import Foundation

/// What an utterance asks Talk to do.
enum TalkAction: Sendable {
    /// Words for the session: inserted into the running turn, or a new prompt.
    case sendSpoken(String)
    /// Answer a permission (or a plan approved through permission options).
    /// `feedback` is sent as a spoken message right after it (the reason
    /// for a no, or the changes to a plan).
    case respondPermission(askID: String, optionId: String, feedback: String?)
    case answerQuestion(askID: String, answer: QuestionAnswer)
    case answerPlan(askID: String, decision: PlanApprovalDecision, feedback: String?)
    /// A question set moved on: ask its next question.
    case askNext(TalkAsk)
    case stopSpeech
    case repeatLast
    case continueSpeech
    case skip
    case mute(Bool)
    case endTalk
    /// "Cancel the agent": ask first.
    case askConfirmCancel
    case cancelAgent
    /// The cancel question got anything but yes.
    case keepAgent
    /// The answer wasn't clear: ask again.
    case reAsk
    /// Still not clear (or skipped): stop asking; the item stays on the screen.
    case leaveOnScreen
    /// "Wait": keep listening for the answer.
    case wait
    /// Nothing to act on.
    case ignore
}

extension TalkAction: Equatable {
    static func == (lhs: TalkAction, rhs: TalkAction) -> Bool {
        switch (lhs, rhs) {
        case let (.sendSpoken(a), .sendSpoken(b)): return a == b
        case let (.respondPermission(a1, a2, a3), .respondPermission(b1, b2, b3)): return a1 == b1 && a2 == b2 && a3 == b3
        case let (.answerQuestion(a1, a2), .answerQuestion(b1, b2)): return a1 == b1 && same(a2, b2)
        case let (.answerPlan(a1, a2, a3), .answerPlan(b1, b2, b3)): return a1 == b1 && a2 == b2 && a3 == b3
        case let (.askNext(a), .askNext(b)): return a == b
        case let (.mute(a), .mute(b)): return a == b
        case (.stopSpeech, .stopSpeech), (.repeatLast, .repeatLast), (.continueSpeech, .continueSpeech),
             (.skip, .skip), (.endTalk, .endTalk), (.askConfirmCancel, .askConfirmCancel),
             (.cancelAgent, .cancelAgent), (.keepAgent, .keepAgent), (.reAsk, .reAsk),
             (.leaveOnScreen, .leaveOnScreen), (.wait, .wait), (.ignore, .ignore):
            return true
        default:
            return false
        }
    }

    private static func same(_ a: QuestionAnswer, _ b: QuestionAnswer) -> Bool {
        a.declined == b.declined && a.answers.count == b.answers.count
            && zip(a.answers, b.answers).allSatisfy { $0.questionId == $1.questionId && $0.labels == $1.labels }
    }
}

/// What the router needs to know about the moment an utterance was heard.
struct TalkRouteContext: Equatable, Sendable {
    /// The item being asked, when it is answered by voice.
    var ask: TalkAsk?
    /// How many times it was asked again.
    var askAttempt = 0
    /// Speech was stopped before its end ("continue" resumes it).
    var speechHeld = false
    var confirmingCancel = false
    var muted = false
}

/// Decides what an utterance means: a short command, an answer to what the
/// agent is waiting on, or words for the session.
enum TalkRouter {
    static func route(_ transcript: String, context: TalkRouteContext) -> TalkAction {
        let heard = Heard(transcript)
        guard !heard.words.isEmpty else { return .ignore }
        if context.confirmingCancel {
            return confirmsCancel(heard) ? .cancelAgent : .keepAgent
        }
        let command = TalkLexicon.command(in: heard.words)
        if context.muted {
            switch command {
            case .unmute?: return .mute(false)
            case .end?: return .endTalk
            default: return .ignore
            }
        }
        if let ask = context.ask, ask.answerableByVoice, !ask.isSecret {
            // Commands that can't be answers. "Stop" and "continue" are no
            // and yes here, and "cancel" is a no unless it names the agent.
            switch command {
            case .repeatLast?: return .repeatLast
            case .skip?: return .leaveOnScreen
            case .mute?: return .mute(true)
            case .end?: return .endTalk
            case .cancelAgent? where heard.content.contains(where: { TalkLexicon.agentWords.contains($0) }):
                return .askConfirmCancel
            default: break
            }
            return answer(heard, to: ask, attempt: context.askAttempt)
        }
        switch command {
        case .stop?: return .stopSpeech
        case .repeatLast?: return .repeatLast
        case .continueSpeech?: return context.speechHeld ? .continueSpeech : .sendSpoken(heard.original)
        case .skip?: return .skip
        case .mute?: return .mute(true)
        case .unmute?: return .ignore
        case .end?: return .endTalk
        case .cancelAgent?: return .askConfirmCancel
        case nil: return .sendSpoken(heard.original)
        }
    }

    /// The answer `transcript` gives to `ask`.
    static func answer(_ transcript: String, to ask: TalkAsk, attempt: Int = 0) -> TalkAction {
        answer(Heard(transcript), to: ask, attempt: attempt)
    }

    // MARK: - Answers

    private static func answer(_ heard: Heard, to ask: TalkAsk, attempt: Int) -> TalkAction {
        let result: TalkAction?
        switch ask.kind {
        case .permission: result = permissionAnswer(heard, ask: ask)
        case .plan: result = planAnswer(heard, ask: ask)
        case .question: result = questionAnswer(heard, ask: ask)
        }
        return result ?? (attempt == 0 ? .reAsk : .leaveOnScreen)
    }

    /// Choice words, then never, no, always, yes, ordinals and similar labels.
    private static func permissionAnswer(_ heard: Heard, ask: TalkAsk) -> TalkAction? {
        guard !heard.isUnclear else { return nil }
        func respond(_ choice: TalkChoice?, feedback: String? = nil) -> TalkAction? {
            choice.map { .respondPermission(askID: ask.id, optionId: $0.id, feedback: feedback) }
        }
        func first(_ meanings: TalkChoice.Meaning...) -> TalkChoice? {
            for meaning in meanings {
                if let choice = ask.choices.first(where: { $0.meaning == meaning }) { return choice }
            }
            return nil
        }
        if let exact = heard.exactChoice(in: ask.choices) { return respond(exact) }
        if heard.has(.never) { return respond(first(.rejectAlways, .rejectOnce)) }
        if heard.has(.no) {
            return respond(first(.rejectOnce, .rejectAlways), feedback: heard.restAfterSignal(.no))
        }
        if heard.has(.always) { return respond(first(.allowAlways, .allowOnce)) }
        if heard.has(.yes) {
            guard !heard.yesBut else { return nil }
            return respond(first(.allowOnce, .allowAlways))
        }
        if let index = heard.singleOrdinal(count: ask.choices.count) { return respond(ask.choices[index]) }
        return respond(heard.similarChoice(in: ask.choices))
    }

    /// Changes first (the rest is the feedback), then choice words, never
    /// (drop), no (keep planning, with what follows as feedback), always and
    /// yes (approve, unless "yes but…"), ordinals, similar words, and a longer
    /// answer in the person's own words as changes.
    private static func planAnswer(_ heard: Heard, ask: TalkAsk) -> TalkAction? {
        guard !heard.isUnclear else { return nil }
        func decide(_ meaning: TalkChoice.Meaning, feedback: String? = nil) -> TalkAction? {
            guard let choice = ask.choices.first(where: { $0.meaning == meaning }) else { return nil }
            switch ask.channel {
            case .planDecision:
                let decision: PlanApprovalDecision
                switch meaning {
                case .approve: decision = .approve
                case .abandon: decision = .abandon
                default: decision = .requestChanges
                }
                return .answerPlan(askID: ask.id, decision: decision, feedback: feedback)
            case .permissionOption, .questionAnswer:
                return .respondPermission(askID: ask.id, optionId: choice.id, feedback: feedback)
            }
        }
        if let feedback = heard.afterLeading(SpokenPrompts.changesPhrases) {
            return decide(.requestChanges, feedback: feedback.isEmpty ? nil : feedback)
        }
        if let verb = heard.content.first, SpokenPrompts.changeVerbs.contains(verb), heard.content.count > 1 {
            return decide(.requestChanges, feedback: heard.original)
        }
        if let exact = heard.exactChoice(in: ask.choices) { return decide(exact.meaning) }
        if heard.has(.never) { return decide(.abandon) }
        if heard.has(.no) { return decide(.requestChanges, feedback: heard.restAfterSignal(.no)) }
        if heard.has(.always) || heard.has(.yes) {
            if heard.yesBut {
                return decide(.requestChanges, feedback: heard.restAfterBut)
            }
            return decide(.approve)
        }
        if let index = heard.singleOrdinal(count: ask.choices.count) { return decide(ask.choices[index].meaning) }
        if let similar = heard.similarChoice(in: ask.choices) { return decide(similar.meaning) }
        if heard.content.count >= 3 { return decide(.requestChanges, feedback: heard.original) }
        return nil
    }

    /// "Wait", then choice words, the yes/no/always/never an option starts
    /// with, ordinals, similar labels, and the person's own words.
    private static func questionAnswer(_ heard: Heard, ask: TalkAsk) -> TalkAction? {
        if TalkLexicon.isOnlyWait(heard.words) { return .wait }
        guard !heard.isUnclear else { return nil }
        let labels: [String]
        if let picked = pickOptions(heard, ask: ask) {
            labels = picked
        } else if ask.acceptsOwnWords, !heard.isOnlySignals, !heard.original.isEmpty {
            labels = [heard.original]
        } else {
            return nil
        }
        guard let step = SpokenPrompts.advancing(ask, with: labels) else {
            return .answerQuestion(askID: ask.id, answer: QuestionAnswer(
                answers: [QuestionAnswerItem(questionId: ask.questions?.current.id ?? ask.id, labels: labels)],
                declined: false))
        }
        if let next = step.next { return .askNext(next) }
        return .answerQuestion(askID: ask.id, answer: step.progress.answer)
    }

    private static func pickOptions(_ heard: Heard, ask: TalkAsk) -> [String]? {
        let choices = ask.choices
        guard !choices.isEmpty else { return nil }
        if ask.multiSelect {
            if TalkLexicon.allPhrases.contains(heard.content.joined(separator: " ")) { return choices.map(\.id) }
            let parts = heard.parts()
            if parts.count > 1 {
                var picked: [String] = []
                for part in parts {
                    guard let index = match(part, choices: choices) else { return nil }
                    if !picked.contains(choices[index].id) { picked.append(choices[index].id) }
                }
                return picked
            }
        }
        if let exact = heard.exactChoice(in: choices) { return [exact.id] }
        if heard.hasSignals, !heard.mixed {
            for signal in [TalkLexicon.Signal.never, .no, .always, .yes] where heard.has(signal) {
                let starting = choices.filter { Heard.startsWith(signal, label: $0.label) }
                if starting.count == 1 { return [starting[0].id] }
            }
            if heard.has(.yes), !heard.has(.no), choices.count == 1 { return [choices[0].id] }
        }
        let ordinals = heard.ordinals(count: choices.count)
        if ask.multiSelect, ordinals.count > 1 { return ordinals.map { choices[$0].id } }
        if ordinals.count == 1 { return [choices[ordinals[0]].id] }
        if let similar = heard.similarChoice(in: choices) { return [similar.id] }
        return nil
    }

    /// One part of a multiple choice: an exact label, an ordinal, or a
    /// similar label.
    private static func match(_ part: [String], choices: [TalkChoice]) -> Int? {
        let joined = part.filter { !TalkLexicon.fillers.contains($0) }.joined(separator: " ")
        if let exact = choices.firstIndex(where: { $0.phrases.contains(joined) }) { return exact }
        let ordinals = Heard.ordinalIndices(TalkLexicon.ordinals(in: part), count: choices.count)
        if ordinals.count == 1 { return ordinals[0] }
        return Heard.similarIndex(part, choices: choices)
    }

    // MARK: - Cancelling

    /// Yes (or "cancel" itself) cancels; anything else keeps the agent going.
    private static func confirmsCancel(_ heard: Heard) -> Bool {
        let cancelWords: Set<String> = ["בטל", "תבטל", "תבטלי", "לבטל", "cancel", "it", "את", "זה", "הסוכן", "העבודה",
                                        "the", "agent", "work", "כן", "yes"]
        let rest = heard.content.filter { !cancelWords.contains($0) }
        let saidCancel = heard.content.contains { ["בטל", "תבטל", "תבטלי", "לבטל", "cancel"].contains($0) }
        let saidYes = heard.content.contains { $0 == "כן" || $0 == "yes" }
        if rest.isEmpty { return saidCancel || saidYes }
        let signals = TalkLexicon.signals(in: rest)
        return !signals.isEmpty && signals.allSatisfy { $0.signal == .yes }
    }
}

/// An utterance, normalized and scanned once.
private struct Heard {
    /// The transcript as heard, trimmed (what is sent as words).
    let original: String
    let tokens: [HebrewText.Token]
    let cleaned: String
    let words: [String]
    /// The words without fillers.
    let content: [String]
    let hits: [TalkLexicon.SignalHit]

    init(_ transcript: String) {
        original = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        cleaned = HebrewText.forSpeech(original)
        tokens = HebrewText.tokens(cleaned)
        words = tokens.map(\.word)
        content = words.filter { !TalkLexicon.fillers.contains($0) }
        hits = TalkLexicon.signals(in: words)
    }

    func has(_ signal: TalkLexicon.Signal) -> Bool { hits.contains { $0.signal == signal } }

    var hasSignals: Bool { !hits.isEmpty }

    /// Yes and no at once.
    var mixed: Bool { (has(.yes) || has(.always)) && (has(.no) || has(.never)) }

    /// "I don't know", or yes and no together.
    var isUnclear: Bool { has(.unclear) || mixed }

    /// Only yes/no words (and fillers).
    var isOnlySignals: Bool {
        let covered = hits.reduce(0) { $0 + $1.range.count }
        let fillers = words.filter { TalkLexicon.fillers.contains($0) }.count
        return !hits.isEmpty && covered + fillers == words.count
    }

    /// "Yes, but…".
    var yesBut: Bool {
        guard let yes = hits.first(where: { $0.signal == .yes || $0.signal == .always }) else { return false }
        return words[yes.range.upperBound...].contains { TalkLexicon.butWords.contains($0) }
    }

    /// The words after the first "but", as said.
    var restAfterBut: String? {
        guard let index = words.firstIndex(where: { TalkLexicon.butWords.contains($0) }) else { return nil }
        return text(after: index)
    }

    /// What follows a signal when it says more than a word or two ("no, run
    /// the tests first" → "run the tests first").
    func restAfterSignal(_ signal: TalkLexicon.Signal) -> String? {
        guard let hit = hits.first(where: { $0.signal == signal }) else { return nil }
        let after = words[hit.range.upperBound...].filter {
            !TalkLexicon.fillers.contains($0) && !TalkLexicon.stopWords.contains($0)
        }
        guard after.count >= 2 else { return nil }
        return text(after: hit.range.upperBound - 1)
    }

    /// The rest of the utterance when it starts with one of `phrases`
    /// ("" when nothing follows); nil when it doesn't start with one.
    func afterLeading(_ phrases: [String]) -> String? {
        let lists = phrases.map { $0.split(separator: " ").map(String.init) }.sorted { $0.count > $1.count }
        let start = words.firstIndex { !TalkLexicon.fillers.contains($0) } ?? 0
        for phrase in lists where start + phrase.count <= words.count {
            if Array(words[start..<(start + phrase.count)]) == phrase {
                return text(after: start + phrase.count - 1) ?? ""
            }
        }
        return nil
    }

    /// The text after the word at `index`, as said, without leading
    /// punctuation; nil when nothing is left.
    func text(after index: Int) -> String? {
        guard index + 1 < tokens.count else { return nil }
        let rest = cleaned[tokens[index + 1].range.lowerBound...]
            .trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ",:;-–—.")))
        return rest.isEmpty ? nil : rest
    }

    /// A choice whose phrase is the whole answer.
    func exactChoice(in choices: [TalkChoice]) -> TalkChoice? {
        let joined = content.joined(separator: " ")
        guard !joined.isEmpty else { return nil }
        return choices.first { $0.phrases.contains(joined) }
    }

    func ordinals(count: Int) -> [Int] {
        Self.ordinalIndices(TalkLexicon.ordinals(in: words), count: count)
    }

    /// The one ordinal said, when it is in range.
    func singleOrdinal(count: Int) -> Int? {
        let found = ordinals(count: count)
        return found.count == 1 ? found[0] : nil
    }

    static func ordinalIndices(_ ordinals: [TalkLexicon.Ordinal], count: Int) -> [Int] {
        var out: [Int] = []
        for ordinal in ordinals {
            let index: Int
            switch ordinal {
            case .index(let i): index = i
            case .last: index = count - 1
            }
            if index >= 0, index < count, !out.contains(index) { out.append(index) }
        }
        return out
    }

    /// The choice whose label shares most of its words with the answer
    /// (Jaccard ≥ 0.6 after dropping stop words and Hebrew prefixes).
    func similarChoice(in choices: [TalkChoice]) -> TalkChoice? {
        Self.similarIndex(content, choices: choices).map { choices[$0] }
    }

    static func similarIndex(_ words: [String], choices: [TalkChoice]) -> Int? {
        let said = keys(words)
        guard !said.isEmpty else { return nil }
        var best: (index: Int, score: Double)?
        var tie = false
        for (index, choice) in choices.enumerated() {
            let label = keys(HebrewText.words(choice.label))
            guard !label.isEmpty else { continue }
            let score = Double(said.intersection(label).count) / Double(said.union(label).count)
            guard score >= similarityThreshold else { continue }
            if let current = best {
                if score > current.score {
                    best = (index, score)
                    tie = false
                } else if score == current.score {
                    tie = true
                }
            } else {
                best = (index, score)
            }
        }
        return tie ? nil : best?.index
    }

    static let similarityThreshold = 0.6

    /// Comparison keys: stop words dropped (unless nothing else is left),
    /// Hebrew prefixes stripped.
    static func keys(_ words: [String]) -> Set<String> {
        let meaningful = words.filter { !TalkLexicon.stopWords.contains($0) && !TalkLexicon.fillers.contains($0) }
        return Set((meaningful.isEmpty ? words : meaningful).map(HebrewText.matchKey))
    }

    /// Whether a label starts with a yes/no/always/never word ("No, skip it").
    static func startsWith(_ signal: TalkLexicon.Signal, label: String) -> Bool {
        TalkLexicon.leadingSignal(ofLabel: label) == signal
    }

    /// The answer split into the parts of a multiple choice: at commas, at
    /// "and" / "וגם", and before a word joined with ו.
    func parts() -> [[String]] {
        var parts: [[String]] = []
        var current: [String] = []
        for (i, token) in tokens.enumerated() {
            let between = i > 0 ? cleaned[tokens[i - 1].range.upperBound..<token.range.lowerBound] : ""
            if between.contains(",") || between.contains("&") || between.contains(";") {
                if !current.isEmpty { parts.append(current) }
                current = []
            }
            let word = token.word
            if TalkLexicon.joiningWords.contains(word) || word == "ו" {
                if !current.isEmpty { parts.append(current) }
                current = []
                continue
            }
            if word.hasPrefix("ו"), word.count > 2, !current.isEmpty {
                parts.append(current)
                current = [String(word.dropFirst())]
                continue
            }
            current.append(word)
        }
        if !current.isEmpty { parts.append(current) }
        return parts
    }
}
