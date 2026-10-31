import Foundation

// What waits on the user across a server's sessions (codeg fork
// `crate::pending`, `docs/ios-push.md` §9): `list_pending_items`, the
// `app://pending-items` event, and the reminder settings.

/// One choice of an item: a permission option (`id` is its option id, `kind`
/// its ACP kind) or a question's option (`id` is the label).
struct PendingOption: Decodable, Hashable, Sendable {
    let id: String
    let label: String
    var kind: String?

    init(id: String, label: String, kind: String? = nil) {
        self.id = id
        self.label = label
        self.kind = kind
    }
}

/// The first question of a question set.
struct PendingQuestionDetail: Decodable, Hashable, Sendable {
    /// This question's id inside the set: the answer item's `questionId`.
    let itemId: String
    var header: String = ""
    var multiSelect: Bool = false
    /// How many questions the set holds.
    var count: Int = 1
    /// The answer is a secret the session's card masks (present only when
    /// true): never asked for here or in a notification.
    var secret: Bool = false

    private enum CodingKeys: String, CodingKey { case itemId, header, multiSelect, count, secret }

    init(itemId: String, header: String = "", multiSelect: Bool = false, count: Int = 1, secret: Bool = false) {
        self.itemId = itemId
        self.header = header
        self.multiSelect = multiSelect
        self.count = count
        self.secret = secret
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? 1
        secret = (try? c.decodeIfPresent(Bool.self, forKey: .secret)) ?? false
    }
}

/// One item of `list_pending_items` (Rust `PendingItem`).
struct PendingItem: Decodable, Hashable, Sendable, Identifiable {
    enum Kind: String, Sendable {
        case permission, question, plan
    }

    let id: String
    /// `permission`, `question` or `plan` (kept raw: a newer server may add one).
    let kind: String
    /// How it is answered: `permission`, `question` or `plan_approval`.
    let source: String
    /// The session that asked (a delegated sub-agent's own session).
    let conversationId: Int
    /// The session to open: the parent of a delegated sub-agent.
    let rootConversationId: Int
    var folderId: Int?
    var folderName: String?
    var title: String?
    var agentType: String?
    var agentLabel: String = ""
    let connectionId: String
    let requestId: String
    let askedAt: Date
    /// The question, the tool call's title, or the plan's first line.
    var text: String = ""
    var options: [PendingOption] = []
    var question: PendingQuestionDetail?
    var remindersSent: Int = 0
    var nextReminderAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, kind, source, conversationId, rootConversationId, folderId, folderName, title, agentType
        case agentLabel, connectionId, requestId, askedAt, text, options, question, remindersSent, nextReminderAt
    }

    init(id: String, kind: String, source: String, conversationId: Int, rootConversationId: Int? = nil,
         connectionId: String, requestId: String, askedAt: Date, text: String = "",
         options: [PendingOption] = [], question: PendingQuestionDetail? = nil,
         title: String? = nil, folderName: String? = nil, agentLabel: String = "") {
        self.id = id
        self.kind = kind
        self.source = source
        self.conversationId = conversationId
        self.rootConversationId = rootConversationId ?? conversationId
        self.connectionId = connectionId
        self.requestId = requestId
        self.askedAt = askedAt
        self.text = text
        self.options = options
        self.question = question
        self.title = title
        self.folderName = folderName
        self.agentLabel = agentLabel
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "question"
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? kind
        conversationId = try c.decode(Int.self, forKey: .conversationId)
        rootConversationId = (try? c.decodeIfPresent(Int.self, forKey: .rootConversationId)) ?? conversationId
        folderId = (try? c.decodeIfPresent(Int.self, forKey: .folderId)) ?? nil
        folderName = (try? c.decodeIfPresent(String.self, forKey: .folderName)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        agentType = (try? c.decodeIfPresent(String.self, forKey: .agentType)) ?? nil
        agentLabel = (try? c.decodeIfPresent(String.self, forKey: .agentLabel)) ?? ""
        connectionId = (try? c.decodeIfPresent(String.self, forKey: .connectionId)) ?? ""
        requestId = (try? c.decodeIfPresent(String.self, forKey: .requestId)) ?? ""
        askedAt = (try? c.decodeIfPresent(Date.self, forKey: .askedAt)) ?? Date()
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        options = (try? c.decodeIfPresent([PendingOption].self, forKey: .options)) ?? []
        question = (try? c.decodeIfPresent(PendingQuestionDetail.self, forKey: .question)) ?? nil
        remindersSent = (try? c.decodeIfPresent(Int.self, forKey: .remindersSent)) ?? 0
        nextReminderAt = (try? c.decodeIfPresent(Date.self, forKey: .nextReminderAt)) ?? nil
    }

    var knownKind: Kind? { Kind(rawValue: kind) }

    /// Asked by a delegated sub-agent, filed under its parent session.
    var isSubAgent: Bool { conversationId != rootConversationId }

    /// The session title, else the folder's name.
    var displayTitle: String? {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        if let folderName, !folderName.isEmpty { return folderName }
        return nil
    }

    /// The labels to answer with right in the list: one single-choice question
    /// with a few short options. Nil for anything else (a permission, a plan,
    /// several questions, multiple choice, free text, a secret), which opens
    /// instead.
    var quickAnswers: [String]? {
        guard source == "question", let question, !question.secret, !question.multiSelect, question.count <= 1,
              !connectionId.isEmpty, !requestId.isEmpty else { return nil }
        let labels = options.map(\.label)
        guard !labels.isEmpty, labels.count <= Self.maxQuickAnswers,
              labels.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0.count <= 60 })
        else { return nil }
        return labels
    }

    static let maxQuickAnswers = 6

    /// The `acp_answer_question` answer for `label` (`questionId` of the item
    /// is the set's `request_id`; the answer item's is the question's own id).
    func answer(label: String) -> QuestionAnswer? {
        guard let question else { return nil }
        return QuestionAnswer(answers: [QuestionAnswerItem(questionId: question.itemId, labels: [label])],
                              declined: false)
    }
}

/// `list_pending_items` and the `app://pending-items` event: every item,
/// oldest first, and how many there are (the icon badge).
struct PendingSnapshot: Decodable, Hashable, Sendable {
    var items: [PendingItem]
    var count: Int

    static let empty = PendingSnapshot(items: [], count: 0)

    init(items: [PendingItem], count: Int) {
        self.items = items
        self.count = count
    }

    private enum CodingKeys: String, CodingKey { case items, count }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One item a newer server shapes differently must not hide the rest.
        let raw = (try? c.decodeIfPresent([LenientItem].self, forKey: .items)) ?? []
        items = raw.compactMap(\.item).sorted { $0.askedAt < $1.askedAt }
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? items.count
    }

    private struct LenientItem: Decodable {
        let item: PendingItem?
        init(from decoder: Decoder) throws { item = try? PendingItem(from: decoder) }
    }
}

/// "Reminders" (Rust `ReminderSettings`): when the backend reminds about an
/// item still waiting. Decoded through the shared snake_case decoder; encoded
/// with the snake_case keys the server reads.
struct PendingReminderSettings: Codable, Hashable, Sendable {
    var enabled = true
    /// Seconds after the ask, ascending.
    var stepsSecs: [Int] = [5 * 60, 30 * 60, 120 * 60]
    /// After the last step, again this often; `0` stops after it.
    var repeatSecs = 240 * 60
    var quietHours = false
    /// Minutes after midnight, in `timezone`.
    var quietStartMin = 22 * 60
    var quietEndMin = 7 * 60
    /// IANA zone of the quiet hours; the phone sends its own when it saves.
    var timezone = ""

    init() {}

    private enum CodingKeys: String, CodingKey {
        case enabled, stepsSecs, repeatSecs, quietHours, quietStartMin, quietEndMin, timezone
    }

    private enum WireKeys: String, CodingKey {
        case enabled
        case stepsSecs = "steps_secs"
        case repeatSecs = "repeat_secs"
        case quietHours = "quiet_hours"
        case quietStartMin = "quiet_start_min"
        case quietEndMin = "quiet_end_min"
        case timezone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = PendingReminderSettings()
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? defaults.enabled
        stepsSecs = (try? c.decodeIfPresent([Int].self, forKey: .stepsSecs)) ?? defaults.stepsSecs
        repeatSecs = (try? c.decodeIfPresent(Int.self, forKey: .repeatSecs)) ?? defaults.repeatSecs
        quietHours = (try? c.decodeIfPresent(Bool.self, forKey: .quietHours)) ?? defaults.quietHours
        quietStartMin = (try? c.decodeIfPresent(Int.self, forKey: .quietStartMin)) ?? defaults.quietStartMin
        quietEndMin = (try? c.decodeIfPresent(Int.self, forKey: .quietEndMin)) ?? defaults.quietEndMin
        timezone = (try? c.decodeIfPresent(String.self, forKey: .timezone)) ?? ""
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: WireKeys.self)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(stepsSecs, forKey: .stepsSecs)
        try c.encode(repeatSecs, forKey: .repeatSecs)
        try c.encode(quietHours, forKey: .quietHours)
        try c.encode(quietStartMin, forKey: .quietStartMin)
        try c.encode(quietEndMin, forKey: .quietEndMin)
        try c.encode(timezone, forKey: .timezone)
    }

    /// The "Remind after" choices (seconds after the ask).
    static let stepPresets: [[Int]] = [
        [5 * 60, 30 * 60, 120 * 60],
        [15 * 60, 60 * 60, 240 * 60],
        [30 * 60, 120 * 60],
        [60 * 60],
    ]

    /// The "Then every" choices; `0` is never.
    static let repeatPresets: [Int] = [0, 60 * 60, 120 * 60, 240 * 60, 480 * 60, 1440 * 60]
}
