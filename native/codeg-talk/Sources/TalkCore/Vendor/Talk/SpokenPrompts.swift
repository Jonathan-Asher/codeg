import Foundation

/// How a person is addressed in Hebrew (the server's Talk "address"
/// setting; its "auto" is ``neutral``).
enum TalkAddress: String, CaseIterable, Equatable, Hashable, Sendable {
    case neutral
    case masculine
    case feminine
}

/// How Talk words what it says itself.
enum TalkVoice: Equatable, Hashable, Sendable {
    case hebrew(TalkAddress)
    case english

    var isHebrew: Bool {
        if case .hebrew = self { return true }
        return false
    }

    var language: SpeechUnit.Language { isHebrew ? .hebrew : .english }

    /// From the server's Talk settings (`language`: auto, he or en;
    /// `address`: auto, masculine or feminine). With auto, Talk answers in
    /// the language the person last spoke, Hebrew when unsure.
    static func resolve(language: String?, address: String?, lastHeardHebrew: Bool? = nil) -> TalkVoice {
        let form = TalkAddress(rawValue: address ?? "") ?? .neutral
        switch language {
        case "en": return .english
        case "he": return .hebrew(form)
        default: return lastHeardHebrew == false ? .english : .hebrew(form)
        }
    }
}

/// One answer a prompt takes.
struct TalkChoice: Equatable, Hashable, Sendable {
    enum Meaning: Equatable, Hashable, Sendable {
        case allowOnce, allowAlways, rejectOnce, rejectAlways
        case approve, requestChanges, abandon
        /// One of a question's options.
        case option
    }

    /// The permission option id, the plan decision, or the option's label.
    var id: String
    /// What the screen shows.
    var label: String
    var meaning: Meaning
    /// Normalized phrases that pick it outright when said alone.
    var phrases: [String] = []
}

/// A question set asked one question at a time; the answers are sent
/// together once the last one is answered.
struct QuestionProgress: Equatable, Sendable {
    var questions: [QuestionSpec]
    var index = 0
    /// The labels chosen so far, by question id.
    var answers: [String: [String]] = [:]

    var current: QuestionSpec { questions[index] }
    var isLast: Bool { index >= questions.count - 1 }

    /// The reply for the whole set.
    var answer: QuestionAnswer {
        QuestionAnswer(answers: questions.map { QuestionAnswerItem(questionId: $0.id, labels: answers[$0.id] ?? []) },
                       declined: false)
    }
}

/// Something the agent is waiting on, as Talk asks it: a permission, a
/// question (one at a time) or a plan to approve.
struct TalkAsk: Equatable, Sendable, Identifiable {
    enum Kind: String, Equatable, Sendable {
        case permission, question, plan
    }

    /// Where the item came from, so the answer reaches it.
    enum Source: Equatable, Hashable, Sendable {
        /// The session's permission card (also a plan approved through its
        /// options).
        case permission(requestId: String)
        /// The session's question card.
        case question(questionId: String)
        /// The session's plan approval card (its own request, with three decisions).
        case planApproval(approvalId: String)
        /// An item from the pending list (a sub-agent's).
        case pendingItem(id: String)
    }

    /// How an answer is sent.
    enum Channel: Equatable, Sendable {
        case permissionOption
        case questionAnswer
        case planDecision
    }

    var id: String
    var source: Source
    var kind: Kind
    var channel: Channel
    /// What Talk says to ask it (or, when it can't be answered by voice, the
    /// line that says it is waiting on the screen).
    var prompt: String
    var voice: TalkVoice
    /// The answers it takes, in the order they are offered (ordinals count
    /// in this order).
    var choices: [TalkChoice] = []
    var multiSelect = false
    /// A question that also takes an answer in the person's own words.
    var acceptsOwnWords = false
    /// A secret answer (a key, a password): never spoken or listened for.
    var isSecret = false
    /// False when the item is only shown on the screen (secret, or a set of
    /// questions Talk can't see in full).
    var answerableByVoice = true
    var questions: QuestionProgress?

    /// What is said to ask it; a second attempt starts with "I didn't catch
    /// that".
    func promptUnit(attempt: Int = 0) -> SpeechUnit {
        let text = attempt > 0 ? SpokenPrompts.didntCatch(voice) + " " + prompt : prompt
        return SpeechUnit.standalone(text, name: "ask:\(id):\(questions?.index ?? 0):\(attempt)", kind: .cue,
                                     language: voice.language)
    }
}

/// The words Talk says when the agent waits on the person, built on the
/// phone from what the agent wrote (the Talk rules have the agent describe
/// each command in plain words and open each plan with a one-sentence
/// summary), and the short lines Talk says itself.
enum SpokenPrompts {
    // MARK: - Asks

    /// The session's permission card. A plan approval (ExitPlanMode) arrives
    /// this way too and is asked as a plan.
    static func ask(permission: PendingPermission, voice: TalkVoice) -> TalkAsk {
        let toolCall = AnyJSON.parse(jsonString: permission.parsed.jsonPreview)
        return ask(parsed: permission.parsed, toolCall: toolCall, options: permission.options,
                   source: .permission(requestId: permission.requestId), id: "permission:\(permission.requestId)",
                   voice: voice)
    }

    /// A permission from its raw tool call (an event or a snapshot).
    static func ask(toolCall: AnyJSON, requestId: String, options: [PermissionOption], voice: TalkVoice) -> TalkAsk {
        ask(parsed: ParsedPermission.parse(toolCall), toolCall: toolCall, options: options,
            source: .permission(requestId: requestId), id: "permission:\(requestId)", voice: voice)
    }

    /// The session's question card, from its first question.
    static func ask(question: PendingQuestion, voice: TalkVoice) -> TalkAsk {
        let id = "question:\(question.questionId)"
        let source = TalkAsk.Source.question(questionId: question.questionId)
        guard !question.questions.isEmpty else {
            return waitingOnScreen(id: id, source: source, kind: .question, channel: .questionAnswer, voice: voice)
        }
        if question.questions.contains(where: \.isSecret) {
            var ask = waitingOnScreen(id: id, source: source, kind: .question, channel: .questionAnswer, voice: voice)
            ask.isSecret = true
            ask.prompt = secretWaiting(voice)
            return ask
        }
        return questionAsk(id: id, source: source, progress: QuestionProgress(questions: question.questions),
                           voice: voice)
    }

    /// The session's plan approval card (approve, request changes, abandon).
    static func ask(plan: PendingPlanApproval, voice: TalkVoice) -> TalkAsk {
        TalkAsk(id: "plan:\(plan.approvalId)", source: .planApproval(approvalId: plan.approvalId), kind: .plan,
                channel: .planDecision, prompt: planText(markdown: plan.planMarkdown, voice: voice), voice: voice,
                choices: planChoices(approve: PlanApprovalDecision.approve.rawValue,
                                     requestChanges: PlanApprovalDecision.requestChanges.rawValue,
                                     abandon: PlanApprovalDecision.abandon.rawValue))
    }

    /// An item from the pending list: what a sub-agent waits on.
    static func ask(item: PendingItem, voice: TalkVoice) -> TalkAsk {
        let id = "item:\(item.id)"
        let source = TalkAsk.Source.pendingItem(id: item.id)
        switch item.source {
        case "question":
            guard let detail = item.question, !item.options.isEmpty || !item.text.isEmpty else {
                return waitingOnScreen(id: id, source: source, kind: .question, channel: .questionAnswer, voice: voice)
            }
            if detail.secret {
                var ask = waitingOnScreen(id: id, source: source, kind: .question, channel: .questionAnswer,
                                          voice: voice)
                ask.isSecret = true
                ask.prompt = secretWaiting(voice)
                return ask
            }
            guard detail.count <= 1 else {
                // Only the first question of the set is known here.
                return waitingOnScreen(id: id, source: source, kind: .question, channel: .questionAnswer, voice: voice)
            }
            let spec = QuestionSpec(id: detail.itemId, question: item.text, header: detail.header,
                                    multiSelect: detail.multiSelect,
                                    options: item.options.map { QuestionOption(label: $0.label, description: "") })
            return questionAsk(id: id, source: source, progress: QuestionProgress(questions: [spec]), voice: voice)
        case "plan_approval":
            return TalkAsk(id: id, source: source, kind: .plan, channel: .planDecision,
                           prompt: planText(markdown: item.text, voice: voice), voice: voice,
                           choices: planChoices(approve: PlanApprovalDecision.approve.rawValue,
                                                requestChanges: PlanApprovalDecision.requestChanges.rawValue,
                                                abandon: PlanApprovalDecision.abandon.rawValue))
        default:
            let options = item.options.map { PermissionOption(optionId: $0.id, name: $0.label, kind: $0.kind ?? "") }
            if item.knownKind == .plan, let choices = permissionPlanChoices(options) {
                return TalkAsk(id: id, source: source, kind: .plan, channel: .permissionOption,
                               prompt: planText(markdown: item.text, voice: voice), voice: voice, choices: choices)
            }
            return TalkAsk(id: id, source: source, kind: .permission, channel: .permissionOption,
                           prompt: subAgentPermissionText(item.text, voice: voice), voice: voice,
                           choices: permissionChoices(options))
        }
    }

    // MARK: - Permission wording

    /// "I want to ‹what›. Approve?" from what the tool call says.
    static func permissionText(parsed: ParsedPermission, toolCall: AnyJSON?, voice: TalkVoice) -> String {
        let input = rawInput(of: toolCall)
        let kind = parsed.kind.lowercased()
        if let tool = mcpToolName(parsed: parsed, toolCall: toolCall) {
            return want("להשתמש ב-\(tool)", "use \(tool)", voice: voice)
        }
        if kind == "execute" || (parsed.command != nil && parsed.diffFiles.isEmpty) {
            let description = (input?["description"]?.nonEmptyString).map(speakable)
            guard let description, !description.isEmpty else {
                return voice.isHebrew ? "אני רוצה להריץ פקודה, היא על המסך. \(approveQuestion(voice))"
                    : "I want to run a command; it's on the screen. \(approveQuestion(voice))"
            }
            return describedCommand(description, voice: voice)
        }
        let paths = parsed.diffFiles.map(\.path)
            + (["file_path", "filePath", "notebook_path", "notebookPath", "path"].compactMap {
                input?[$0]?.nonEmptyString
            })
        if kind == "edit" || kind == "delete" || kind == "move" || !parsed.diffFiles.isEmpty, let first = paths.first {
            let names = Set(paths.map(basename))
            if names.count > 1 {
                return want("לערוך \(names.count) קבצים", "edit \(names.count) files", voice: voice)
            }
            let name = basename(first)
            return want("לערוך את \(name)", "edit \(name)", voice: voice)
        }
        if kind == "read", let first = paths.first {
            let name = basename(first)
            return want("לקרוא את \(name)", "read \(name)", voice: voice)
        }
        if let url = parsed.url {
            let host = URL(string: url)?.host ?? speakable(url)
            return want("לפתוח דף מ-\(host)", "open a page from \(host)", voice: voice)
        }
        if let query = parsed.query {
            let spoken = speakable(query)
            return want("לחפש ברשת: \(spoken)", "search the web for: \(spoken)", voice: voice)
        }
        let title = speakable(parsed.title.replacingOccurrences(of: "`", with: ""))
        if !title.isEmpty, title.count <= 60 {
            return want("להשתמש ב-\(title)", "use \(title)", voice: voice)
        }
        // Impersonal in Hebrew: "I need" is gendered there (צריך / צריכה).
        return voice.isHebrew ? "צריך אישור, הפרטים על המסך. \(approveQuestion(voice))"
            : "I need your OK; the details are on the screen. \(approveQuestion(voice))"
    }

    /// A command's description: a Hebrew infinitive reads after "I want"
    /// (אני רוצה למחוק…), anything else is read as it is.
    static func describedCommand(_ description: String, voice: TalkVoice) -> String {
        let text = description.trimmingCharacters(in: CharacterSet(charactersIn: " .")).trimmingCharacters(in: .whitespaces)
        if voice.isHebrew {
            if HebrewText.containsHebrew(text), text.hasPrefix("ל") {
                return "אני רוצה \(text). \(approveQuestion(voice))"
            }
            return "\(text). \(approveQuestion(voice))"
        }
        if !HebrewText.containsHebrew(text), let first = text.first, first.isUppercase,
           text.dropFirst().first?.isLowercase ?? true {
            return "I want to \(first.lowercased())\(text.dropFirst()). \(approveQuestion(voice))"
        }
        return "\(text). \(approveQuestion(voice))"
    }

    /// A sub-agent's permission: only its title is known (a command line or
    /// a tool name), read when it is short and plain.
    static func subAgentPermissionText(_ title: String, voice: TalkVoice) -> String {
        let text = speakable(title.replacingOccurrences(of: "`", with: ""))
        let shellish = ["&&", "||", "|", ";", ">", "<", "$(", "`"].contains { title.contains($0) }
        if text.isEmpty || shellish || text.count > 60 {
            return voice.isHebrew ? "סוכן ברקע מבקש אישור, הפרטים על המסך. \(approveQuestion(voice))"
                : "A background agent needs your OK; the details are on the screen. \(approveQuestion(voice))"
        }
        return voice.isHebrew ? "סוכן ברקע מבקש אישור: \(text). \(approveQuestion(voice))"
            : "A background agent asks to: \(text). \(approveQuestion(voice))"
    }

    static func approveQuestion(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "לאשר?" : "OK?"
    }

    private static func want(_ hebrew: String, _ english: String, voice: TalkVoice) -> String {
        voice.isHebrew ? "אני רוצה \(hebrew). \(approveQuestion(voice))" : "I want to \(english). \(approveQuestion(voice))"
    }

    // MARK: - Question wording

    /// The question, then up to four options ("Postgres, SQLite או MySQL?").
    static func questionText(_ question: QuestionSpec, voice: TalkVoice, position: Int = 0, count: Int = 1) -> String {
        var parts: [String] = []
        if count > 1, position == 0 {
            parts.append(voice.isHebrew ? "יש לי \(count) שאלות." : "I have \(count) questions.")
        }
        let text = speakableMarkdown(question.question)
        if !text.isEmpty { parts.append(text) }
        let labels = question.options.map { speakable($0.label) }.filter { !$0.isEmpty }
        if !labels.isEmpty {
            let shown = Array(labels.prefix(maxOptionsRead))
            var list = shown
            if labels.count > maxOptionsRead {
                list.append(voice.isHebrew ? "משהו אחר מהמסך" : "something else on the screen")
            }
            parts.append(listed(list, voice: voice) + "?")
        }
        if question.multiSelect { parts.append(multiSelectHint(voice)) }
        return parts.joined(separator: " ")
    }

    /// The most options read aloud; the rest are only on the screen.
    static let maxOptionsRead = 4

    static func multiSelectHint(_ voice: TalkVoice) -> String {
        switch voice {
        case .hebrew(.masculine): return "אתה יכול לבחור כמה."
        case .hebrew(.feminine): return "את יכולה לבחור כמה."
        case .hebrew(.neutral): return "אפשר לבחור כמה."
        case .english: return "You can pick more than one."
        }
    }

    /// "a, b או c" / "a, b, or c".
    static func listed(_ items: [String], voice: TalkVoice) -> String {
        guard let last = items.last else { return "" }
        guard items.count > 1 else { return last }
        let head = items.dropLast().joined(separator: ", ")
        return voice.isHebrew ? "\(head) או \(last)" : (items.count == 2 ? "\(head) or \(last)" : "\(head), or \(last)")
    }

    // MARK: - Plan wording

    /// "There's a plan: ‹its first sentence›. Approve, ask for changes, or
    /// drop it?"
    static func planText(markdown: String, voice: TalkVoice) -> String {
        var reader = IncrementalSpeechText(reply: "plan")
        let units = (reader.append(markdown) + reader.finish()).filter { $0.kind == .sentence }
        var first = units.first?.text ?? ""
        for lead in ["Plan:", "The plan:", "תוכנית:", "התוכנית:"] where first.hasPrefix(lead) {
            first = first.dropFirst(lead.count).trimmingCharacters(in: .whitespaces)
        }
        let question = voice.isHebrew ? "לאשר, לבקש שינויים או לוותר?" : "Approve it, ask for changes, or drop it?"
        if first.isEmpty {
            return voice.isHebrew ? "יש תוכנית על המסך. \(question)" : "There's a plan on the screen. \(question)"
        }
        return voice.isHebrew ? "יש תוכנית: \(first) \(question)" : "There's a plan: \(first) \(question)"
    }

    /// Words that ask for changes; said first, what follows is the feedback.
    static let changesPhrases = [
        "שינויים", "לבקש שינויים", "בקשת שינויים", "יש לי שינויים", "יש שינויים", "שינוי", "changes",
        "request changes", "ask for changes", "change request", "some changes", "i have changes",
    ]

    /// Verbs that ask for a change; the whole answer is the feedback.
    static let changeVerbs = ["לשנות", "תשנה", "תשני", "שנה", "change", "edit", "revise", "תוסיף", "תוסיפי", "add"]

    static let approvePhrases = ["לאשר", "תאשר", "תאשרי", "אשר", "מאשר", "מאשרת", "אישור", "approve", "approve it",
                                 "accept", "accept it", "go with it", "approved"]
    static let abandonPhrases = ["לוותר", "תוותר", "תוותרי", "וותר", "ותר", "עזוב", "עזבי", "תעזוב", "תעזבי",
                                 "abandon", "abandon it", "drop it", "give up", "forget it", "scrap it",
                                 "cancel the plan"]

    static func planChoices(approve: String, requestChanges: String, abandon: String) -> [TalkChoice] {
        [
            TalkChoice(id: approve, label: "Approve", meaning: .approve, phrases: approvePhrases),
            TalkChoice(id: requestChanges, label: "Request changes", meaning: .requestChanges,
                       phrases: changesPhrases + changeVerbs),
            TalkChoice(id: abandon, label: "Abandon", meaning: .abandon, phrases: abandonPhrases),
        ]
    }

    /// A plan approved through permission options (ExitPlanMode): approve
    /// with the first "yes" that keeps the context (not one that clears it);
    /// changes and drop both keep planning.
    static func permissionPlanChoices(_ options: [PermissionOption]) -> [TalkChoice]? {
        let allows = options.filter { $0.kind.lowercased().hasPrefix("allow") }
        guard let reject = options.first(where: \.isReject),
              let approve = allows.first(where: { !$0.name.lowercased().contains("clear") }) ?? allows.first
        else { return nil }
        return [
            TalkChoice(id: approve.optionId, label: approve.name, meaning: .approve, phrases: approvePhrases),
            TalkChoice(id: reject.optionId, label: reject.name, meaning: .requestChanges,
                       phrases: changesPhrases + changeVerbs),
            TalkChoice(id: reject.optionId, label: reject.name, meaning: .abandon, phrases: abandonPhrases),
        ]
    }

    static func permissionChoices(_ options: [PermissionOption]) -> [TalkChoice] {
        options.map { option in
            let meaning: TalkChoice.Meaning
            switch option.kind.lowercased() {
            case "allow_always": meaning = .allowAlways
            case "reject_once": meaning = .rejectOnce
            case "reject_always": meaning = .rejectAlways
            case let other where other.hasPrefix("reject"): meaning = .rejectOnce
            default: meaning = .allowOnce
            }
            return TalkChoice(id: option.optionId, label: option.name, meaning: meaning,
                              phrases: [HebrewText.normalized(option.name)])
        }
    }

    // MARK: - Lines Talk says itself

    /// Before asking again.
    static func didntCatch(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "לא הבנתי." : "Sorry, I didn't catch that."
    }

    /// After asking twice without a clear answer, or when skipped.
    static func leftOnScreen(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "השארתי את זה על המסך." : "I left it on the screen."
    }

    /// "Cancel the agent": asked before cancelling.
    static func confirmCancel(_ voice: TalkVoice) -> String {
        switch voice {
        case .hebrew(.masculine): return "בטוח? לבטל את העבודה?"
        case .hebrew(.feminine): return "בטוחה? לבטל את העבודה?"
        case .hebrew(.neutral): return "לבטל באמת את העבודה?"
        case .english: return "Are you sure? Cancel the work?"
        }
    }

    static func notCancelled(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "בסדר, לא ביטלתי." : "OK, I didn't cancel."
    }

    static func cancelled(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "ביטלתי." : "Cancelled."
    }

    /// A secret question: it is never read, only announced.
    static func secretWaiting(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "יש שאלה שמחכה על המסך." : "There's a question waiting on the screen."
    }

    /// Something only the screen can answer.
    static func waitingOnScreenText(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "יש משהו שמחכה לתשובה על המסך." : "Something is waiting for you on the screen."
    }

    /// The turn is held for background work.
    static func backgroundWork(hebrew: Bool) -> String {
        hebrew ? "העבודה ממשיכה ברקע." : "It's running in the background."
    }

    /// Said now and then while the agent works (Speak progress).
    static func stillWorking(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "העבודה עוד נמשכת." : "Still working on it."
    }

    /// The reply ran past what is read aloud.
    static func restOnScreen(_ voice: TalkVoice) -> String {
        voice.isHebrew ? "את השאר שמתי על המסך." : "The rest is on the screen."
    }

    // MARK: - Helpers

    private static func questionAsk(id: String, source: TalkAsk.Source, progress: QuestionProgress,
                                    voice: TalkVoice) -> TalkAsk {
        let question = progress.current
        return TalkAsk(id: id, source: source, kind: .question, channel: .questionAnswer,
                       prompt: questionText(question, voice: voice, position: progress.index,
                                            count: progress.questions.count),
                       voice: voice,
                       choices: question.options.map {
                           TalkChoice(id: $0.label, label: $0.label, meaning: .option,
                                      phrases: [HebrewText.normalized($0.label)])
                       },
                       multiSelect: question.multiSelect, acceptsOwnWords: true, questions: progress)
    }

    /// The ask for the next question of a set, once `labels` answered the
    /// current one; nil after the last.
    static func advancing(_ ask: TalkAsk, with labels: [String]) -> (next: TalkAsk?, progress: QuestionProgress)? {
        guard var progress = ask.questions else { return nil }
        progress.answers[progress.current.id] = labels
        guard !progress.isLast else { return (nil, progress) }
        progress.index += 1
        return (questionAsk(id: ask.id, source: ask.source, progress: progress, voice: ask.voice), progress)
    }

    private static func waitingOnScreen(id: String, source: TalkAsk.Source, kind: TalkAsk.Kind,
                                        channel: TalkAsk.Channel, voice: TalkVoice) -> TalkAsk {
        TalkAsk(id: id, source: source, kind: kind, channel: channel, prompt: waitingOnScreenText(voice),
                voice: voice, answerableByVoice: false)
    }

    private static func ask(parsed: ParsedPermission, toolCall: AnyJSON?, options: [PermissionOption],
                            source: TalkAsk.Source, id: String, voice: TalkVoice) -> TalkAsk {
        if parsed.isPlan, let choices = permissionPlanChoices(options) {
            let markdown = parsed.planMarkdown ?? parsed.planEntries.map(\.text).joined(separator: "\n")
            return TalkAsk(id: id, source: source, kind: .plan, channel: .permissionOption,
                           prompt: planText(markdown: markdown, voice: voice), voice: voice, choices: choices)
        }
        return TalkAsk(id: id, source: source, kind: .permission, channel: .permissionOption,
                       prompt: permissionText(parsed: parsed, toolCall: toolCall, voice: voice), voice: voice,
                       choices: permissionChoices(options))
    }

    /// The tool call's input object (its keys may come in either case).
    private static func rawInput(of toolCall: AnyJSON?) -> [String: AnyJSON]? {
        guard let object = toolCall?.object else { return nil }
        for key in ["rawInput", "raw_input", "input", "arguments"] {
            switch object[key] {
            case .object(let input)?: return input
            case .string(let text)?: if let input = AnyJSON.parse(jsonString: text)?.object { return input }
            default: continue
            }
        }
        return nil
    }

    /// `mcp__server__tool` → "tool" (underscores read as spaces), from the
    /// tool call's name fields or any name in its metadata.
    private static func mcpToolName(parsed: ParsedPermission, toolCall: AnyJSON?) -> String? {
        let object = toolCall?.object
        var candidates = [object?["toolName"]?.string, object?["tool_name"]?.string, object?["name"]?.string,
                          parsed.title, parsed.kind].compactMap { $0 }
        if let meta = object?["_meta"] ?? object?["meta"] { candidates += strings(in: meta, depth: 3) }
        for name in candidates where name.hasPrefix("mcp__") {
            let rest = name.dropFirst(5)
            guard let separator = rest.range(of: "__") else { continue }
            let tool = rest[separator.upperBound...]
            guard !tool.isEmpty else { continue }
            return tool.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        }
        return nil
    }

    /// Every string in a JSON value, a few levels deep.
    private static func strings(in value: AnyJSON, depth: Int) -> [String] {
        switch value {
        case .string(let text): return [text]
        case .object(let object) where depth > 0: return object.values.flatMap { strings(in: $0, depth: depth - 1) }
        case .array(let array) where depth > 0: return array.flatMap { strings(in: $0, depth: depth - 1) }
        default: return []
        }
    }

    private static func basename(_ path: String) -> String {
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    }

    /// One line of agent text as Talk reads it.
    static func speakable(_ text: String) -> String {
        SpeechText.inline(text, options: .talk).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// Markdown as Talk reads it, as one line.
    static func speakableMarkdown(_ text: String) -> String {
        SpeechText.fromMarkdown(text, options: .talk).replacingOccurrences(of: "\n", with: " ")
    }
}
