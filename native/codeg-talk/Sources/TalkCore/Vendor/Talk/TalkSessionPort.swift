import Foundation

/// What Talk hears from the session it drives. Called on the main actor,
/// synchronously, while the session's state changes: read the session from
/// here, but send or answer from a task of your own.
@MainActor
protocol SessionTalkObserver: AnyObject {
    /// The live turn's main-thread text runs, joined in order, with "\n\n"
    /// where a tool ran or a message of the person's came in; sub-agent text
    /// and reasoning left out. It only grows at the end while `isStreaming`;
    /// `turnID` stays the same through a reconnect that rebuilds the turn
    /// and changes for every new turn. Sent again only when something changed.
    func talkLiveText(turnID: String, text: String, isStreaming: Bool)
    /// The turn ended: `stopReason` from the agent (`end_turn`, ...),
    /// `cancelled`, `error`, or nil when the reply landed while the socket
    /// was down (the transcript holds it). Once per turn, after its final
    /// ``talkLiveText(turnID:text:isStreaming:)``.
    func talkTurnEnded(turnID: String, stopReason: String?)
    /// The turn is held open only for background work: the agent answered and
    /// waits (true), or picked up again (false).
    func talkAwaitingBackground(_ awaiting: Bool)
    /// Turns the agent wrote outside a turn (background work finishing),
    /// upserted by id: a still-growing turn comes again, whole.
    func talkBackgroundTurns(_ turns: [MessageTurn])
    /// A permission, question or plan approval appeared, was answered or went
    /// away (``TalkSessionPort/pendingPermission`` and the others say which).
    func talkPendingChanged()
}

/// Where ``TalkSessionPort/sendSpoken(_:)`` sent what the person said.
enum SpokenSendRoute: Sendable, Equatable {
    /// An ordinary prompt: the session was idle.
    case prompt
    /// Into the running turn (native steering): the agent has it now.
    case insert
    /// Waiting for the turn to end (or kept as "Not sent").
    case queued
}

/// The session as Talk drives it. In the app, the open session's model
/// (``SessionDetailViewModel``, SessionDetailViewModel+Talk.swift), under
/// the names it already has.
@MainActor
protocol TalkSessionPort: AnyObject {
    /// Told what the session says and does. Setting it replays the current
    /// state: the live turn's text, the background hold, the waiting cards.
    var talkObserver: SessionTalkObserver? { get set }
    /// A message can go into the running turn right now.
    var canInsertIntoTurn: Bool { get }
    /// Keep the event socket attached while the session is idle, so turns
    /// written outside a turn reach ``SessionTalkObserver/talkBackgroundTurns(_:)``
    /// and a turn that starts is followed at once.
    var keepsStreamAttached: Bool { get set }
    /// The person talks with this session: presence says so (to a server
    /// with Talk), so the server doesn't push about it meanwhile.
    var isTalking: Bool { get set }

    /// Send what the person said: a prompt when idle, into the turn when
    /// ``canInsertIntoTurn``, queued otherwise, marked spoken. Never touches
    /// the draft or the attachments.
    func sendSpoken(_ text: String) async -> SpokenSendRoute

    // The session as the screen shows it.
    var conversationID: Int? { get }
    /// The session's title, nil while it has none (blank counts as none).
    var talkTitle: String? { get }
    var isInFlight: Bool { get }
    var awaitingBackground: Bool { get }
    var backgroundOutstanding: Int { get }
    var pendingPermission: PendingPermission? { get }
    var pendingQuestion: PendingQuestion? { get }
    var pendingPlanApproval: PendingPlanApproval? { get }

    // Answering and cancelling, as the cards do.
    func respondPermission(optionId: String) async -> Bool
    func answerQuestion(_ answer: QuestionAnswer) async -> Bool
    func declineQuestion() async -> Bool
    func answerPlanApproval(decision: PlanApprovalDecision, feedback: String?) async -> Bool
    func cancel()
}
