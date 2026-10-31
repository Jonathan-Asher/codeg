import Foundation

// What ``TalkController`` runs on. The app's implementations are in
// TalkLive.swift, TalkAudioEngine.swift and TalkEngineAdapters.swift; the
// tests drive fakes.

/// The engines one Talk listens and speaks with.
struct TalkEngineSet {
    var vad: SpeechActivity
    var live: LiveTranscriber
    /// Smart Turn; nil when it didn't load (Talk goes on without it).
    var turn: TurnEndClassifier?
    var synthesizer: Synthesizer
    /// BlueTTS speaks; false: the system's own voices.
    var naturalVoice: Bool
}

/// Why Talk couldn't start, in words for the sheet.
struct TalkStartError: LocalizedError, Equatable {
    let message: String

    init(_ message: String) { self.message = message }

    var errorDescription: String? { message }
}

/// What happened to the app around Talk.
enum TalkSystemEvent: Sendable, Equatable {
    case memoryWarning
    case enteredBackground
    case willEnterForeground
}

/// The device side of Talk: the engines and their leases, whisper, memory,
/// the screen, the Lock Screen.
@MainActor
protocol TalkSystem: AnyObject {
    /// Set by the controller: memory warnings and the app's moves.
    var onEvent: ((TalkSystemEvent) -> Void)? { get set }

    /// Take the engines' leases and load what Talk listens and speaks with.
    func loadEngines() async throws -> TalkEngineSet
    /// Give the leases back (the engines unload once nobody holds them).
    func releaseEngines()

    /// whisper for the final transcript; nil when its model isn't downloaded.
    var finalTranscriber: FinalTranscriber? { get }
    var isWhisperLoaded: Bool { get }
    /// Load whisper's weights now; false when it couldn't.
    func loadWhisper() async -> Bool
    func unloadWhisper()

    /// `os_proc_available_memory()`, in bytes.
    var availableMemory: UInt64 { get }
    /// "nominal", "fair", "serious" or "critical".
    var thermalState: String { get }
    var isInBackground: Bool { get }
    /// A phone call is in progress (an interruption is a call, not Siri).
    var callActive: Bool { get }

    func setIdleTimerDisabled(_ disabled: Bool)
    /// "Talk · ‹session›" on the Lock Screen; nil clears it.
    func setNowPlaying(title: String?)
    /// Who gets the Lock Screen's and the AirPods' commands; nil lets go.
    func setRemoteTarget(_ target: TalkRemoteTarget?)

    /// The app and device the Talk's `talk_lab` reports name.
    var reportEnvironment: TalkReportEnvironment { get }
}

/// The Lock Screen and AirPods commands, as Talk takes them.
@MainActor
protocol TalkRemoteTarget: AnyObject {
    /// Play/pause (an AirPods stem press): mute or unmute.
    func remoteToggleMute()
    func remoteSetMuted(_ muted: Bool)
    /// Next track: stop the speech.
    func remoteStopSpeech()
    /// Previous track: say the last reply again.
    func remoteRepeat()
}

/// The server and session side of Talk that isn't the session's model.
@MainActor
protocol TalkBackend: AnyObject {
    /// Keep the session's model (and its socket) while Talk runs, whatever
    /// the screen does (a `SessionModelStore` lease).
    func holdSession(_ hold: Bool)
    /// `set_conversation_talk_mode`.
    func setTalkMode(conversationID: Int, enabled: Bool) async throws
    /// The server's Talk settings as last seen (kept on the phone).
    var cachedSettings: TalkSettings? { get }
    /// The server's Talk settings now (nil when it can't say).
    func fetchSettings() async -> TalkSettings?

    /// What the session's sub-agents wait on (the pending list, filtered to
    /// this conversation's sub-agents).
    var subAgentItems: [PendingItem] { get }
    /// Called when ``subAgentItems`` may have changed.
    var onItemsChanged: (() -> Void)? { get set }
    func respond(item: PendingItem, optionId: String) async throws
    func answer(item: PendingItem, answer: QuestionAnswer) async throws
    func answerPlan(item: PendingItem, decision: PlanApprovalDecision, feedback: String?) async throws

    /// One `talk_lab` report (`report_client_diagnostic`).
    func upload(report: Data) async throws
}

/// Something scheduled; cancel it to keep it from running.
@MainActor
protocol TalkScheduled: AnyObject {
    func cancel()
}

/// Talk's timers. Tests fire them by hand.
@MainActor
protocol TalkScheduler: AnyObject {
    func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> TalkScheduled
}

/// Timers on `Task.sleep`.
@MainActor
final class TaskTalkScheduler: TalkScheduler {
    private final class Scheduled: TalkScheduled {
        var task: Task<Void, Never>?
        func cancel() { task?.cancel() }
    }

    func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> TalkScheduled {
        let scheduled = Scheduled()
        scheduled.task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(max(0, seconds) * 1000)))
            guard !Task.isCancelled else { return }
            action()
        }
        return scheduled
    }
}

/// Everything ``TalkController`` runs on.
@MainActor
struct TalkDependencies {
    var audio: TalkAudioIO
    var system: TalkSystem
    var backend: TalkBackend
    var clock: TalkClock = SystemTalkClock()
    var scheduler: TalkScheduler = TaskTalkScheduler()
    var worker: TalkWorker = SerialTalkWorker()
    var prefs = TalkPrefs()
}
