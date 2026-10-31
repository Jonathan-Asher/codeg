@testable import TalkCore
import Foundation

/// Talk's server side on the Mac, carried out by the window: the session's
/// hold, Talk mode, the server's Talk settings, the sub-agents' waiting items
/// and the reports (the iPhone's `LiveTalkBackend`, over the wire).
@MainActor
final class BridgeBackend: TalkBackend {
    enum Failure: Error, Equatable, CustomStringConvertible {
        case noAnswer(String)
        case refused(String, String?)

        var description: String {
            switch self {
            case .noAnswer(let op): "the window didn't answer \(op)"
            case .refused(let op, let why): "the window refused \(op)\(why.map { ": \($0)" } ?? "")"
            }
        }
    }

    var onItemsChanged: (() -> Void)?
    private(set) var cachedSettings: TalkSettings?

    private let conversationID: Int
    private let requests: WireRequests
    private let flags: WireFlags
    private let kept: KeptReports
    private var items: [PendingItem] = []

    init(conversationID: Int, settings: TalkSettings?, items: [PendingItem], requests: WireRequests,
         flags: WireFlags, kept: KeptReports? = nil) {
        self.conversationID = conversationID
        cachedSettings = settings
        self.items = items
        self.requests = requests
        self.flags = flags
        self.kept = kept ?? .shared
    }

    func holdSession(_ hold: Bool) {
        flags.holdSession = hold
    }

    func setTalkMode(conversationID: Int, enabled: Bool) async throws {
        try await expect(.setTalkMode(enabled: enabled))
    }

    func fetchSettings() async -> TalkSettings? {
        guard let response = await requests.request(.fetchSettings), response.ok,
              let value = response.value, !value.isNull,
              let data = try? JSONEncoder().encode(value),
              let settings = try? Inbound.decoder.decode(TalkSettings.self, from: data) else { return nil }
        cachedSettings = settings
        return settings
    }

    /// `settings`: the server's Talk settings changed. The controller reads
    /// them when a Talk starts, so they apply from the next one.
    func updateSettings(_ settings: TalkSettings) {
        cachedSettings = settings
    }

    /// The items the session's sub-agents wait on (the iPhone's filter: this
    /// conversation's tree, not its own cards).
    var subAgentItems: [PendingItem] {
        items.filter { $0.rootConversationId == conversationID && $0.conversationId != conversationID }
    }

    /// `items`: the server's pending list.
    func setItems(_ items: [PendingItem]) {
        self.items = items
        onItemsChanged?()
    }

    func respond(item: PendingItem, optionId: String) async throws {
        try await expect(.respondItem(item: WireItemRef(item), optionId: optionId))
    }

    func answer(item: PendingItem, answer: QuestionAnswer) async throws {
        try await expect(.answerItem(item: WireItemRef(item), answer: answer))
    }

    func answerPlan(item: PendingItem, decision: PlanApprovalDecision, feedback: String?) async throws {
        try await expect(.answerItemPlan(item: WireItemRef(item), decision: decision, feedback: feedback))
    }

    /// A Talk's `talk_lab` reports, kept until the window has passed them
    /// on (for the helper's life: a report the window didn't answer goes
    /// with the next Talk's).
    func keep(reports: [Data]) {
        kept.keep(reports)
    }

    /// Each kept report as an `uploadReport` request; the window posts
    /// `{"report": report}` to `report_client_diagnostic`. A report the
    /// window took or refused is let go; one it didn't answer is kept.
    func sendKeptReports() async {
        await kept.send { report in
            guard let object = try? JSONSerialization.jsonObject(with: report) else { return true }
            guard let response = await self.requests.request(.uploadReport(report: AnyJSON(any: object))) else {
                return false
            }
            if !response.succeeded {
                TalkLog.write("the window refused a Talk report: \(response.error ?? "no reason")")
            }
            return true
        }
    }

    private func expect(_ op: WireRequest.Op) async throws {
        guard let response = await requests.request(op) else { throw Failure.noAnswer(op.name) }
        guard response.succeeded else { throw Failure.refused(op.name, response.error) }
    }
}

/// The Talk reports the helper still has to hand over, across Talks. One
/// send at a time; a report added meanwhile goes with the next.
@MainActor
final class KeptReports {
    static let shared = KeptReports()

    private(set) var reports: [Data] = []
    private var sending = false

    func keep(_ more: [Data]) {
        reports.append(contentsOf: more)
    }

    /// Offer each report to `deliver`, in order; true lets it go.
    func send(_ deliver: (Data) async -> Bool) async {
        guard !sending else { return }
        sending = true
        defer { sending = false }
        var offered = 0
        while offered < reports.count {
            let report = reports[offered]
            if await deliver(report), let index = reports.firstIndex(of: report) {
                reports.remove(at: index)
            } else {
                offered += 1
            }
        }
    }

    func removeAll() {
        reports = []
    }
}
