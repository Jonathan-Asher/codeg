import Foundation

/// The words Talk listens for, in Hebrew and English: spoken commands, yes
/// and no, ordinals, and the words that leave a sentence hanging. Every
/// phrase is written the way ``HebrewText/words(_:)`` normalizes speech
/// (lowercase, no punctuation, words joined by single spaces).
enum TalkLexicon {
    // MARK: - Commands

    /// A command spoken as a whole utterance.
    enum Command: String, CaseIterable, Sendable {
        case stop
        case repeatLast
        case continueSpeech
        case skip
        case mute
        case unmute
        case end
        case cancelAgent
    }

    /// The most words a command can have (after fillers are dropped).
    static let maxCommandWords = 4

    static let commandPhrases: [Command: [String]] = [
        .stop: [
            "די", "די כבר", "שקט", "עצור", "עצרי", "תעצור", "תעצרי", "תפסיק", "תפסיקי", "הפסק", "שתוק", "שתקי",
            "מספיק", "סטופ", "רגע", "חכה", "חכי", "stop", "stop it", "stop talking", "quiet", "be quiet", "enough",
            "shut up", "wait", "hold on",
        ],
        .repeatLast: [
            "תחזור", "תחזרי", "חזור", "תחזור על זה", "תחזרי על זה", "שוב", "עוד פעם", "עוד הפעם", "מה", "מה אמרת",
            "לא שמעתי", "לא הבנתי", "repeat", "repeat that", "say again", "say that again", "again", "come again",
            "what", "pardon", "sorry what", "what did you say",
        ],
        .continueSpeech: [
            "תמשיך", "תמשיכי", "המשך", "המשיכי", "תמשיך לדבר", "תמשיכי לדבר", "continue", "go on", "keep going",
            "resume",
        ],
        .skip: ["דלג", "תדלג", "תדלגי", "דלגי", "דלג על זה", "תדלג על זה", "הבא", "skip", "skip it", "skip that", "next"],
        .mute: ["השתק", "תשתיק", "השתיקי", "תשתיקי", "השתק מיקרופון", "mute", "mute the mic", "mute yourself"],
        .unmute: ["תקשיב", "תקשיבי", "הקשב", "בטל השתקה", "unmute", "listen", "listen again"],
        .end: [
            "סיים שיחה", "תסיים שיחה", "סיימי שיחה", "תסיימי שיחה", "סיום שיחה", "סוף שיחה", "סיים", "תסיים",
            "ביי", "להתראות", "end", "end talk", "end the conversation", "end conversation", "bye", "goodbye",
        ],
        .cancelAgent: [
            "בטל", "תבטל", "תבטלי", "בטל את הסוכן", "תבטל את הסוכן", "תבטלי את הסוכן", "עצור את הסוכן",
            "תעצור את הסוכן", "תעצרי את הסוכן", "בטל את העבודה", "תבטל את העבודה", "עצור את העבודה",
            "cancel", "cancel it", "cancel the agent", "stop the agent", "abort", "cancel the work",
        ],
    ]

    /// "Cancel" names the agent's work with one of these ("בטל את הסוכן"),
    /// which makes it a command even while a question waits for a no.
    static let agentWords: Set<String> = ["הסוכן", "העבודה", "agent", "work"]

    /// Words around a command that don't change it ("די בבקשה", "um stop").
    static let fillers: Set<String> = [
        "בבקשה", "נו", "אה", "אהה", "אמ", "אממ", "היי", "הי", "תודה", "please", "um", "umm", "uh", "uhh", "er",
        "hey", "thanks", "thank",
    ]

    /// Openers dropped before a command when the rest is one ("אוקיי, תעצור").
    static let commandOpeners: Set<String> = ["אוקיי", "אוקי", "טוב", "יאללה", "ok", "okay", "alright", "so", "אז"]

    /// The command an utterance is, if it is nothing but one.
    static func command(in words: [String]) -> Command? {
        var rest = words.filter { !fillers.contains($0) }
        guard !rest.isEmpty, rest.count <= maxCommandWords + 1 else { return nil }
        if let found = commandIndex[rest.joined(separator: " ")], rest.count <= maxCommandWords { return found }
        if rest.count > 1, commandOpeners.contains(rest[0]) {
            rest.removeFirst()
            if rest.count <= maxCommandWords, let found = commandIndex[rest.joined(separator: " ")] { return found }
        }
        return nil
    }

    private static let commandIndex: [String: Command] = {
        var index: [String: Command] = [:]
        for (command, phrases) in commandPhrases {
            for phrase in phrases { index[phrase] = command }
        }
        return index
    }()

    // MARK: - Answers

    /// What a word or phrase says about a pending question.
    enum Signal: String, CaseIterable, Sendable {
        case yes
        case no
        case always
        case never
        /// "I don't know", "maybe": not an answer.
        case unclear
    }

    static let signalPhrases: [Signal: [String]] = [
        .yes: [
            "כן", "כן כן", "בטח", "סבבה", "יאללה", "תמשיך", "תמשיכי", "אשר", "תאשר", "תאשרי", "מאשר", "מאשרת",
            "בטוח", "בטוחה", "כן בטוח",
            "נכון", "אוקיי", "אוקי", "אוקיה", "בסדר", "טוב", "ברור", "כמובן", "בהחלט", "יופי", "מעולה", "קדימה",
            "לך על זה", "לכי על זה", "תעשה את זה", "תעשי את זה", "תעשה", "תעשי", "תריץ", "תריצי", "אין בעיה",
            "בלי בעיה", "למה לא", "ודאי", "בוודאי", "לאשר", "תאשר את זה", "yes", "yeah", "yep", "yup", "ya", "sure",
            "ok", "okay", "go ahead", "go for it", "do it", "of course", "approve", "approved", "fine", "alright",
            "all right", "correct", "absolutely", "definitely", "no problem", "why not", "please do", "sounds good",
            "go", "proceed", "continue", "yes please", "run it", "תריץ את זה", "תריצי את זה", "תמשיך עם זה",
        ],
        .no: [
            "לא", "לא לא", "עצור", "עצרי", "תעצור", "תעצרי", "חכה", "חכי", "רגע", "די", "תפסיק", "תפסיקי", "הפסק",
            "בטל", "תבטל", "תבטלי", "אל", "אל תעשה", "אל תעשי", "אל תעשה את זה", "אל תעשי את זה", "אל תריץ", "אל תריצי", "ממש לא", "בשום אופן",
            "לא עכשיו", "עזוב", "עזבי", "לא בסדר", "לא טוב", "לא נכון", "לא כדאי", "לא לאשר", "אל תאשר", "אסור",
            "no", "nope", "nah", "don't", "dont", "do not", "wait", "cancel", "stop", "hold on", "not now", "no way",
            "never mind", "nevermind", "reject", "deny", "not ok", "not okay", "don't do it", "dont do it",
            "not good", "not right", "negative", "cancel it", "cancel that", "stop it", "stop that", "בטל את זה",
            "תבטל את זה", "תבטלי את זה", "עצור את זה", "תעצור את זה",
        ],
        .always: [
            "תמיד", "תמיד תאשר", "מעכשיו תמיד", "אל תשאל שוב", "אל תשאל יותר", "אל תשאלי שוב", "always",
            "always allow", "from now on", "don't ask again", "dont ask again", "every time",
        ],
        .never: ["אף פעם", "אף פעם לא", "לעולם לא", "never", "never allow", "never again", "not ever"],
        .unclear: [
            "לא יודע", "לא יודעת", "לא בטוח", "לא בטוחה", "אולי", "תלוי", "not sure", "i don't know", "i dont know",
            "don't know", "dont know", "dunno", "maybe", "perhaps", "depends",
        ],
    ]

    /// Verbs that answer only when they are the whole answer ("תריץ" is a
    /// yes, but in "לא, תריץ קודם את הבדיקות" it is part of what to do).
    static let standaloneOnlyPhrases: Set<String> = [
        "תמשיך", "תמשיכי", "תעשה", "תעשי", "תעשה את זה", "תעשי את זה", "תריץ", "תריצי", "לך על זה", "לכי על זה",
        "קדימה", "יאללה", "go", "proceed", "continue", "do it", "go ahead", "go for it", "עצור", "עצרי", "תעצור",
        "תעצרי", "חכה", "חכי", "רגע", "די", "תפסיק", "תפסיקי", "הפסק", "בטל", "תבטל", "תבטלי", "עזוב", "עזבי",
        "wait", "cancel", "stop", "hold on", "run it", "תריץ את זה", "תריצי את זה", "תמשיך עם זה", "cancel it",
        "cancel that", "stop it", "stop that", "בטל את זה", "תבטל את זה", "תבטלי את זה", "עצור את זה", "תעצור את זה",
    ]

    /// "Wait, let me think": only these words keep a question waiting.
    static let waitPhrases: [String] = [
        "רגע", "חכה", "חכי", "שנייה", "שניה", "רגע אחד", "רק רגע", "שנייה אחת", "wait", "hold on", "one sec",
        "one second", "just a sec", "just a second", "hang on",
    ]

    /// "Yes, but…": a yes followed by one of these isn't a plain yes.
    static let butWords: Set<String> = ["אבל", "רק", "חוץ", "but", "only", "except", "although"]

    /// A signal phrase found in an utterance: its words are `range`.
    struct SignalHit: Equatable, Sendable {
        var signal: Signal
        var range: Range<Int>
        /// One of ``standaloneOnlyPhrases``.
        var standaloneOnly = false
    }

    /// The signal phrases in `words`, longest first at each position, so
    /// "לא בטוח" is unclear rather than no then yes, and "no problem" is yes.
    /// A verb from ``standaloneOnlyPhrases`` counts only when every other
    /// word is a signal or a filler.
    static func signals(in words: [String]) -> [SignalHit] {
        let hits = scan(words, table: signalTable).map { hit -> SignalHit in
            var phrase = words[hit.range].joined(separator: " ")
            if phrase.hasPrefix("ו"), !standaloneOnlyPhrases.contains(phrase) { phrase.removeFirst() }
            return SignalHit(signal: hit.value, range: hit.range, standaloneOnly: standaloneOnlyPhrases.contains(phrase))
        }
        var covered = Set<Int>()
        for hit in hits { covered.formUnion(hit.range) }
        let alone = words.indices.allSatisfy { covered.contains($0) || fillers.contains(words[$0]) }
        return alone ? hits : hits.filter { !$0.standaloneOnly }
    }

    /// The signal a label starts with ("No, skip it" starts with no; "Stop
    /// the server" doesn't).
    static func leadingSignal(ofLabel label: String) -> Signal? {
        let words = HebrewText.words(label)
        guard let hit = scan(words, table: signalTable).first, hit.range.lowerBound == 0 else { return nil }
        let phrase = words[hit.range].joined(separator: " ")
        return standaloneOnlyPhrases.contains(phrase) ? nil : hit.value
    }

    /// Whether the utterance is only "wait" (and fillers).
    static func isOnlyWait(_ words: [String]) -> Bool {
        let rest = words.filter { !fillers.contains($0) }
        guard !rest.isEmpty else { return false }
        let hits = scan(rest, table: waitTable)
        return hits.reduce(0) { $0 + $1.range.count } == rest.count
    }

    // MARK: - Ordinals

    enum Ordinal: Equatable, Hashable, Sendable {
        /// Zero-based.
        case index(Int)
        case last
    }

    static let ordinalWords: [String: Ordinal] = {
        var words: [String: Ordinal] = [:]
        let table: [(Ordinal, [String])] = [
            (.index(0), ["ראשון", "ראשונה", "הראשון", "הראשונה", "first", "1", "1st"]),
            (.index(1), ["שני", "השני", "השנייה", "השניה", "שתיים", "שניים", "השתיים", "second", "two", "2", "2nd"]),
            (.index(2), ["שלישי", "שלישית", "השלישי", "השלישית", "שלוש", "שלושה", "third", "three", "3", "3rd"]),
            (.index(3), ["רביעי", "רביעית", "הרביעי", "הרביעית", "ארבע", "ארבעה", "fourth", "four", "4", "4th"]),
            (.index(4), ["חמישי", "חמישית", "החמישי", "החמישית", "חמש", "חמישה", "fifth", "five", "5", "5th"]),
            (.index(5), ["שישי", "שישית", "השישי", "השישית", "שש", "שישה", "sixth", "six", "6", "6th"]),
            (.last, ["אחרון", "אחרונה", "האחרון", "האחרונה", "last", "the last"]),
        ]
        for (ordinal, list) in table {
            for word in list { words[word] = ordinal }
        }
        return words
    }()

    /// "One": an ordinal only when nothing else in the answer is ("the
    /// second one" is the second).
    static let weakOrdinalWords: [String: Ordinal] = [
        "אחת": .index(0), "אחד": .index(0), "האחת": .index(0), "האחד": .index(0), "one": .index(0),
    ]

    /// "Second" without the article is also "a second" (wait); it counts after
    /// one of these.
    static let ordinalLeads: Set<String> = ["אפשרות", "האפשרות", "תשובה", "התשובה", "מספר", "option", "number"]

    /// The ordinals in an answer, in order.
    static func ordinals(in words: [String]) -> [Ordinal] {
        var strong: [Ordinal] = []
        var weak: [Ordinal] = []
        for (i, raw) in words.enumerated() {
            let candidates = raw.hasPrefix("ו") && raw.count > 2 ? [raw, String(raw.dropFirst())] : [raw]
            for word in candidates {
                if let ordinal = ordinalWords[word] {
                    strong.append(ordinal)
                    break
                }
                if word == "שנייה" || word == "שניה", i > 0, ordinalLeads.contains(words[i - 1]) {
                    strong.append(.index(1))
                    break
                }
                if let ordinal = weakOrdinalWords[word] {
                    weak.append(ordinal)
                    break
                }
            }
        }
        return strong.isEmpty ? weak : strong
    }

    // MARK: - Choosing several

    /// Every option ("כולם", "all of them").
    static let allPhrases: Set<String> = [
        "כולם", "כולן", "הכל", "את כולם", "את כולן", "את הכל", "כל האפשרויות", "שניהם", "שתיהן", "all",
        "all of them", "everything", "both", "every one", "all options",
    ]

    /// Words that join several choices ("the first and the third").
    static let joiningWords: Set<String> = ["and", "plus", "וגם", "גם", "also"]

    // MARK: - Matching labels

    /// Words that carry no meaning when an answer is compared with option
    /// labels ("I want Postgres please" is "Postgres").
    static let stopWords: Set<String> = [
        "את", "של", "על", "עם", "אני", "אנחנו", "רוצה", "רוצים", "בוא", "בואו", "נלך", "לך", "תלך", "תבחר", "תבחרי",
        "בחר", "בחרי", "בבקשה", "זה", "זאת", "הזה", "הזאת", "ה", "ו", "גם", "אז", "נו", "אפשרות", "האפשרות", "עדיף",
        "תעשה", "תעשי", "the", "a", "an", "i", "i'd", "i'll", "want", "like", "let's", "lets", "go", "with", "for",
        "please", "pick", "choose", "use", "option", "take", "it", "that", "this", "we", "should", "do", "to",
    ]

    // MARK: - End of turn

    /// Words a sentence doesn't end on: after one, the speaker likely goes
    /// on, so the pause before committing is longer.
    static let danglingWords: Set<String> = [
        "של", "את", "עם", "על", "או", "אבל", "כי", "אם", "ואז", "כמו", "the", "a", "an", "of", "to", "and", "but",
        "because", "if", "with", "or", "from",
    ]

    /// Whether `text` ends on a dangling word, or on a lone Hebrew letter
    /// (a prefix like ו or ש with nothing after it).
    static func endsDangling(_ text: String) -> Bool {
        guard let last = HebrewText.words(text).last else { return false }
        if danglingWords.contains(last) { return true }
        return last.count == 1 && last.first.map(HebrewText.isHebrewLetter) == true
    }

    // MARK: - Interrupting

    /// One of these is enough to confirm an interruption, even alone.
    static let interruptWords: Set<String> = [
        "די", "עצור", "עצרי", "תעצור", "תעצרי", "תפסיק", "תפסיקי", "הפסק", "שקט", "שתוק", "שתקי", "רגע", "חכה",
        "חכי", "מספיק", "stop", "wait", "quiet", "enough", "hold", "hey",
    ]

    // MARK: - Phrase scanning

    struct Hit<Value: Sendable>: Sendable {
        var value: Value
        var range: Range<Int>
    }

    private struct Table<Value: Sendable>: Sendable {
        /// Phrases by first word, longest first.
        var byFirstWord: [String: [([String], Value)]]
    }

    private static func table<Value: Sendable>(_ phrases: [(String, Value)]) -> Table<Value> {
        var byFirst: [String: [([String], Value)]] = [:]
        for (phrase, value) in phrases {
            let words = phrase.split(separator: " ").map(String.init)
            guard let first = words.first else { continue }
            byFirst[first, default: []].append((words, value))
        }
        for key in byFirst.keys { byFirst[key]?.sort { $0.0.count > $1.0.count } }
        return Table(byFirstWord: byFirst)
    }

    private static let signalTable: Table<Signal> = table(signalPhrases.flatMap { signal, phrases in
        phrases.map { ($0, signal) }
    })

    private static let waitTable: Table<Bool> = table(waitPhrases.map { ($0, true) })

    /// Phrases found left to right, the longest at each position; a first
    /// word may carry a leading ו ("וכן", "ולא").
    private static func scan<Value: Sendable>(_ words: [String], table: Table<Value>) -> [Hit<Value>] {
        var hits: [Hit<Value>] = []
        var i = 0
        while i < words.count {
            var found: Hit<Value>?
            var firstForms = [words[i]]
            if words[i].hasPrefix("ו"), words[i].count > 1 { firstForms.append(String(words[i].dropFirst())) }
            search: for first in firstForms {
                for (phrase, value) in table.byFirstWord[first] ?? [] {
                    let end = i + phrase.count
                    guard end <= words.count else { continue }
                    if phrase.count == 1 || Array(words[(i + 1)..<end]) == Array(phrase.dropFirst()) {
                        found = Hit(value: value, range: i..<end)
                        break search
                    }
                }
            }
            if let found {
                hits.append(found)
                i = found.range.upperBound
            } else {
                i += 1
            }
        }
        return hits
    }
}
