@testable import TalkCore
import Foundation

/// The session as Talk drives it on the Mac: a local mirror of what the
/// window's conversation shows, kept current by the window's messages, behind
/// the controller's synchronous ``TalkSessionPort``.
///
/// It tells the controller what changed exactly as the iPhone's session model
/// (`SessionDetailViewModel`) does:
/// - setting ``talkObserver`` replays the state: the live turn's text (if a
///   turn is live), the background hold, then the waiting cards;
/// - the live text is sent again only when it changed;
/// - a turn's end is sent once, after its final live text;
/// - the background hold only when it flips, the cards only when a card's id
///   changed.
///
/// Sending and answering become `req`s the window carries out.
@MainActor
final class MirrorPort: TalkSessionPort {
    let conversationID: Int?
    private(set) var snapshot: PortSnapshot
    /// The live turn, if one is in progress.
    private(set) var live: WireLive?

    private let requests: WireRequests
    private let flags: WireFlags
    private let sink: WireSink
    /// The last live signal sent (the iPhone's `lastTalkLive`).
    private var lastSignal: WireLive?
    /// The turn whose end was sent.
    private var endedTurnID: String?

    init(conversationID: Int, snapshot: PortSnapshot, live: WireLive?, requests: WireRequests, flags: WireFlags,
         sink: WireSink) {
        self.conversationID = conversationID
        self.snapshot = snapshot
        self.live = live
        self.requests = requests
        self.flags = flags
        self.sink = sink
    }

    // MARK: - TalkSessionPort

    weak var talkObserver: SessionTalkObserver? {
        didSet {
            guard talkObserver !== oldValue else { return }
            lastSignal = nil
            endedTurnID = nil
            guard let observer = talkObserver else { return }
            if live != nil { signalLive() }
            observer.talkAwaitingBackground(snapshot.awaitingBackground)
            observer.talkPendingChanged()
        }
    }

    var canInsertIntoTurn: Bool { snapshot.canInsertIntoTurn }

    var keepsStreamAttached: Bool {
        get { flags.keepsStreamAttached }
        set { flags.keepsStreamAttached = newValue }
    }

    var isTalking: Bool {
        get { flags.isTalking }
        set { flags.isTalking = newValue }
    }

    var talkTitle: String? {
        let t = (snapshot.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    var isInFlight: Bool { snapshot.isInFlight }
    var awaitingBackground: Bool { snapshot.awaitingBackground }
    var backgroundOutstanding: Int { snapshot.backgroundOutstanding }
    var pendingPermission: PendingPermission? { snapshot.pendingPermission }
    var pendingQuestion: PendingQuestion? { snapshot.pendingQuestion }
    var pendingPlanApproval: PendingPlanApproval? { snapshot.pendingPlanApproval }

    func sendSpoken(_ text: String) async -> SpokenSendRoute {
        guard let response = await requests.request(.sendSpoken(text: text)), response.ok else { return .queued }
        switch response.value?.string {
        case "prompt": return .prompt
        case "insert": return .insert
        default: return .queued
        }
    }

    func respondPermission(optionId: String) async -> Bool {
        let requestId = snapshot.pendingPermission?.requestId
        return await requests.request(.respondPermission(requestId: requestId, optionId: optionId))?.succeeded ?? false
    }

    func answerQuestion(_ answer: QuestionAnswer) async -> Bool {
        let questionId = snapshot.pendingQuestion?.questionId
        return await requests.request(.answerQuestion(questionId: questionId, answer: answer))?.succeeded ?? false
    }

    func declineQuestion() async -> Bool {
        let questionId = snapshot.pendingQuestion?.questionId
        return await requests.request(.declineQuestion(questionId: questionId))?.succeeded ?? false
    }

    func answerPlanApproval(decision: PlanApprovalDecision, feedback: String?) async -> Bool {
        let approvalId = snapshot.pendingPlanApproval?.approvalId
        return await requests.request(.answerPlanApproval(approvalId: approvalId, decision: decision,
                                                          feedback: feedback))?.succeeded ?? false
    }

    func cancel() {
        sink.send(.cmd(op: "cancel"))
    }

    // MARK: - The window's messages

    /// `port`: the fields that changed. The background hold is told when it
    /// flips, the cards when one's id changed.
    func apply(_ change: PortChange) {
        let before = Self.cardIDs(snapshot)
        let wasAwaiting = snapshot.awaitingBackground
        snapshot.apply(change)
        if snapshot.awaitingBackground != wasAwaiting {
            talkObserver?.talkAwaitingBackground(snapshot.awaitingBackground)
        }
        if Self.cardIDs(snapshot) != before {
            talkObserver?.talkPendingChanged()
        }
    }

    /// `awaiting`.
    func setAwaitingBackground(_ value: Bool) {
        var change = PortChange()
        change.awaitingBackground = value
        apply(change)
    }

    /// `live`: the live turn's text so far.
    func setLive(_ live: WireLive) {
        self.live = live
        signalLive()
    }

    /// `turnEnded`: once per turn, after its final text.
    func turnEnded(turnID: String, stopReason: String?) {
        if live?.turnId == turnID { live?.streaming = false }
        guard let observer = talkObserver, endedTurnID != turnID else { return }
        endedTurnID = turnID
        if live?.turnId == turnID { signalLive() }
        observer.talkTurnEnded(turnID: turnID, stopReason: stopReason)
    }

    /// `bgTurns`: turns written outside a turn.
    func backgroundTurns(_ turns: [MessageTurn]) {
        guard !turns.isEmpty else { return }
        talkObserver?.talkBackgroundTurns(turns)
    }

    private func signalLive() {
        guard let observer = talkObserver, let live, live != lastSignal else { return }
        lastSignal = live
        observer.talkLiveText(turnID: live.turnId, text: live.text, isStreaming: live.streaming)
    }

    private static func cardIDs(_ s: PortSnapshot) -> [String?] {
        [s.pendingPermission?.requestId, s.pendingQuestion?.questionId, s.pendingPlanApproval?.approvalId]
    }
}
