import XCTest
@testable import Codeg

// TalkController over fakes: the audio engine, the VAD, the live and final
// transcribers, the synthesizer, the session, the device, the server and the
// clock. Frames are fed by hand (32 ms each, on the fake clock); a "speech"
// frame is one the fake VAD hears as voice.

// MARK: - Fakes

final class TalkTestClock: TalkClock, @unchecked Sendable {
    var time: TimeInterval = 1000
    func now() -> TimeInterval { time }
}

struct TalkInlineWorker: TalkWorker {
    func enqueue(_ work: @escaping @Sendable () -> Void) { work() }
}

@MainActor
final class TalkTestScheduler: TalkScheduler {
    final class Item: TalkScheduled {
        let due: TimeInterval
        let action: @MainActor () -> Void
        var cancelled = false
        init(due: TimeInterval, action: @escaping @MainActor () -> Void) {
            self.due = due
            self.action = action
        }
        func cancel() { cancelled = true }
    }

    let clock: TalkTestClock
    private(set) var items: [Item] = []

    init(clock: TalkTestClock) { self.clock = clock }

    func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> TalkScheduled {
        let item = Item(due: clock.time + seconds, action: action)
        items.append(item)
        return item
    }

    /// Run what is due by now, in order.
    func fireDue() {
        while let index = items.indices.filter({ !items[$0].cancelled && items[$0].due <= clock.time + 1e-9 })
            .min(by: { items[$0].due < items[$1].due }) {
            let item = items.remove(at: index)
            item.action()
        }
        items.removeAll { $0.cancelled }
    }
}

@MainActor
final class FakeTalkAudio: TalkAudioIO {
    struct Queued {
        let samples: [Float]
        let rate: Double
        let onPlayed: @Sendable () -> Void
    }

    let frames: AsyncStream<MicFrame>
    let events: AsyncStream<TalkAudioEvent>
    private let eventSink: AsyncStream<TalkAudioEvent>.Continuation
    var route: TalkRoute = .builtIn
    var echoMode: TalkEchoMode = .echoCancelledInput
    var isSpeaking: Bool { !queued.isEmpty }
    var starts: [TalkEchoMode?] = []
    var stops = 0
    var failStarts = 0
    var queued: [Queued] = []
    var ducks: [Bool] = []
    var earcons: [Earcon] = []
    var speechStops = 0
    var inputMutes: [Bool] = []
    var running = false

    init() {
        frames = AsyncStream { _ in }
        let made = AsyncStream.makeStream(of: TalkAudioEvent.self)
        events = made.stream
        eventSink = made.continuation
    }

    struct StartFailure: Error {}

    func start(preferring: TalkEchoMode?) throws {
        starts.append(preferring)
        if failStarts > 0 {
            failStarts -= 1
            throw StartFailure()
        }
        running = true
    }

    func stop() {
        stops += 1
        running = false
        queued = []
    }

    func schedule(_ samples: [Float], sampleRate: Double, onPlayed: @escaping @Sendable () -> Void) {
        queued.append(Queued(samples: samples, rate: sampleRate, onPlayed: onPlayed))
    }

    func duck(_ on: Bool) { ducks.append(on) }

    func stopSpeech() {
        speechStops += 1
        queued = []
    }

    func play(_ earcon: Earcon) { earcons.append(earcon) }

    func setInputMuted(_ muted: Bool) { inputMutes.append(muted) }

    /// The oldest queued chunk was heard.
    func playOne() {
        guard !queued.isEmpty else { return }
        queued.removeFirst().onPlayed()
    }

    /// The engine was rebuilt: what was queued is gone.
    func dropQueued() { queued = [] }
}

/// Voice when a frame's first sample is loud.
final class FakeTalkVAD: SpeechActivity {
    var resets = 0
    func probability(_ frame: [Float]) -> Float { (frame.first ?? 0) > 0.05 ? 0.95 : 0.02 }
    func reset() { resets += 1 }
}

final class FakeLiveTranscriber: LiveTranscriber, @unchecked Sendable {
    /// What it "hears" for the utterance being fed.
    var text = ""
    /// What a fresh pass over a clip hears (a voice over the speech).
    var onceText = ""
    var begins = 0
    var finishes = 0
    var resets = 0
    var accepted = 0
    private var lastPartial = ""

    func begin(preRoll: [Float]) {
        begins += 1
        lastPartial = ""
        accepted = preRoll.count
    }

    func accept(_ samples: [Float]) -> String? {
        accepted += samples.count
        guard text != lastPartial else { return nil }
        lastPartial = text
        return text
    }

    func flushTail() -> String { text }

    func finish() -> String {
        finishes += 1
        return text
    }

    func reset() { resets += 1 }

    func transcribeOnce(_ clip: [Float]) -> String { onceText }
}

final class FakeFinalTranscriber: FinalTranscriber, @unchecked Sendable {
    var text = ""
    var fails = false
    var calls = 0
    var cancels = 0

    func transcribe(_ clip: [Float]) async throws -> String {
        calls += 1
        if fails { throw FakeTalkAudio.StartFailure() }
        return text
    }

    func cancel() { cancels += 1 }
}

@MainActor
final class FakeSynthesizer: Synthesizer {
    var spoken: [String] = []

    func synthesize(_ unit: SpeechUnit) -> AsyncThrowingStream<SpeechChunk, Error> {
        spoken.append(unit.text)
        let samples = [Float](repeating: 0.2, count: max(441, unit.text.count * 441))
        return AsyncThrowingStream { continuation in
            continuation.yield(SpeechChunk(samples: samples, sampleRate: 44_100))
            continuation.finish()
        }
    }
}

@MainActor
final class FakeTalkSystem: TalkSystem {
    var onEvent: ((TalkSystemEvent) -> Void)?
    let vad = FakeTalkVAD()
    let live = FakeLiveTranscriber()
    let final = FakeFinalTranscriber()
    let synthesizer = FakeSynthesizer()
    var whisperDownloaded = true
    var isWhisperLoaded = false
    var whisperLoads = 0
    var whisperUnloads = 0
    var engineLoads = 0
    var engineReleases = 0
    var availableMemory: UInt64 = 3_000 * 1_048_576
    var thermalState = "nominal"
    var isInBackground = false
    var callActive = false
    var idleTimerDisabled = false
    var nowPlaying: String?
    weak var remote: TalkRemoteTarget?
    var remoteSet = false

    var finalTranscriber: FinalTranscriber? { whisperDownloaded ? final : nil }

    func loadEngines() async throws -> TalkEngineSet {
        engineLoads += 1
        return TalkEngineSet(vad: vad, live: live, turn: nil, synthesizer: synthesizer, naturalVoice: true)
    }

    func releaseEngines() { engineReleases += 1 }

    func loadWhisper() async -> Bool {
        whisperLoads += 1
        isWhisperLoaded = true
        return true
    }

    func unloadWhisper() {
        whisperUnloads += 1
        isWhisperLoaded = false
    }

    func setIdleTimerDisabled(_ disabled: Bool) { idleTimerDisabled = disabled }
    func setNowPlaying(title: String?) { nowPlaying = title }
    func setRemoteTarget(_ target: TalkRemoteTarget?) {
        remote = target
        remoteSet = target != nil
    }

    var reportEnvironment = TalkReportEnvironment(app: ["version": "1.0", "build": "1"],
                                                  device: ["model": "Test1,1", "os": "Test 1.0"])
}

@MainActor
final class FakeTalkBackend: TalkBackend {
    var held = false
    var holds: [Bool] = []
    var talkModes: [Bool] = []
    var cachedSettings: TalkSettings? = TalkSettings(language: .hebrew, address: .masculine)
    var fetched: TalkSettings?
    var subAgentItems: [PendingItem] = []
    var onItemsChanged: (() -> Void)?
    var responses: [(String, String)] = []
    var answers: [(String, QuestionAnswer)] = []
    var uploads: [Data] = []

    func holdSession(_ hold: Bool) {
        held = hold
        holds.append(hold)
    }

    func setTalkMode(conversationID: Int, enabled: Bool) async throws { talkModes.append(enabled) }
    func fetchSettings() async -> TalkSettings? { fetched }
    func respond(item: PendingItem, optionId: String) async throws { responses.append((item.id, optionId)) }
    func answer(item: PendingItem, answer: QuestionAnswer) async throws { answers.append((item.id, answer)) }
    func answerPlan(item: PendingItem, decision: PlanApprovalDecision, feedback: String?) async throws {}
    func upload(report: Data) async throws { uploads.append(report) }
}

@MainActor
final class FakeTalkPort: TalkSessionPort {
    /// Setting the observer replays the live turn, as the session's model does.
    weak var talkObserver: SessionTalkObserver? {
        didSet {
            guard let observer = talkObserver, observer !== oldValue else { return }
            if let live = liveTurn { observer.talkLiveText(turnID: live.id, text: live.text, isStreaming: live.streaming) }
            observer.talkAwaitingBackground(awaitingBackground)
            observer.talkPendingChanged()
        }
    }
    var liveTurn: (id: String, text: String, streaming: Bool)?
    var canInsertIntoTurn = false
    var keepsStreamAttached = false
    var isTalking = false
    var sent: [String] = []
    var sendRoute: SpokenSendRoute = .prompt
    var conversationID: Int? = 42
    var talkTitle: String?
    var isInFlight = false
    var awaitingBackground = false
    var backgroundOutstanding = 0
    var pendingPermission: PendingPermission?
    var pendingQuestion: PendingQuestion?
    var pendingPlanApproval: PendingPlanApproval?
    var permissionAnswers: [String] = []
    var questionAnswers: [QuestionAnswer] = []
    var planAnswers: [PlanApprovalDecision] = []
    var cancels = 0

    func sendSpoken(_ text: String) async -> SpokenSendRoute {
        sent.append(text)
        isInFlight = true
        return sendRoute
    }

    func respondPermission(optionId: String) async -> Bool {
        permissionAnswers.append(optionId)
        pendingPermission = nil
        return true
    }

    func answerQuestion(_ answer: QuestionAnswer) async -> Bool {
        questionAnswers.append(answer)
        pendingQuestion = nil
        return true
    }

    func declineQuestion() async -> Bool { true }

    func answerPlanApproval(decision: PlanApprovalDecision, feedback: String?) async -> Bool {
        planAnswers.append(decision)
        return true
    }

    func cancel() { cancels += 1 }
}

// MARK: - The harness

@MainActor
final class TalkHarness {
    let clock = TalkTestClock()
    let scheduler: TalkTestScheduler
    let audio = FakeTalkAudio()
    let system = FakeTalkSystem()
    let backend = FakeTalkBackend()
    let port = FakeTalkPort()
    let defaults: UserDefaults
    let suite = "talk-controller-tests-\(UUID().uuidString)"
    let controller: TalkController
    var ended = false

    init(handsFree: Bool = true) {
        scheduler = TalkTestScheduler(clock: clock)
        defaults = UserDefaults(suiteName: suite)!
        let prefs = TalkPrefs(defaults: defaults)
        prefs.handsFree = handsFree
        prefs.shareTelemetry = true
        port.talkTitle = "Fix the build"
        controller = TalkController(conversationID: 42, title: "Fix the build", port: port, dependencies: TalkDependencies(
            audio: audio, system: system, backend: backend, clock: clock, scheduler: scheduler,
            worker: TalkInlineWorker(), prefs: prefs))
        controller.onEnded = { [weak self] in self?.ended = true }
    }

    deinit {
        UserDefaults.standard.removePersistentDomain(forName: suite)
    }

    var live: FakeLiveTranscriber { system.live }
    var final: FakeFinalTranscriber { system.final }
    var spoken: [String] { system.synthesizer.spoken }
    var phase: TalkState.Phase { controller.phase }

    /// Start, and wait until Talk listens.
    func start() async {
        controller.start()
        await settle()
    }

    func settle() async {
        await controller.drain()
        for _ in 0..<20 { await Task.yield() }
        await controller.drain()
    }

    /// Feed frames of voice, then of silence (32 ms each), advancing the clock
    /// and firing timers as it goes.
    func frames(speech: TimeInterval = 0, silence: TimeInterval = 0, rms: Float = 0.08) async {
        let speechFrames = Int((speech / 0.032).rounded())
        let silenceFrames = Int((silence / 0.032).rounded())
        for index in 0..<(speechFrames + silenceFrames) {
            let voiced = index < speechFrames
            let samples = [Float](repeating: voiced ? 0.1 : 0, count: 512)
            let frame = MicFrame(samples: samples, rms: voiced ? rms : 0.002, time: clock.time)
            await controller.handleFrame(frame)
            clock.time += 0.032
            scheduler.fireDue()
            await settle()
        }
    }

    /// Advance the clock without frames (the microphone is off).
    func advance(_ seconds: TimeInterval) async {
        let steps = Int((seconds / 0.1).rounded(.up))
        for _ in 0..<steps {
            clock.time += seconds / Double(steps)
            scheduler.fireDue()
            await settle()
        }
    }

    /// Play every chunk queued so far, one by one.
    func playAll() async {
        for _ in 0..<200 {
            guard !audio.queued.isEmpty else { break }
            audio.playOne()
            await settle()
        }
    }

    /// The agent's reply streams in and its turn ends.
    func reply(_ text: String, turn: String = "turn-1") async {
        port.isInFlight = true
        controller.talkLiveText(turnID: turn, text: text, isStreaming: true)
        port.isInFlight = false
        controller.talkLiveText(turnID: turn, text: text, isStreaming: false)
        controller.talkTurnEnded(turnID: turn, stopReason: "end_turn")
        await settle()
    }

    /// Say something: voice, then the silence that commits it.
    func say(_ text: String, final finalText: String? = nil) async {
        live.text = text
        final.text = finalText ?? text
        await frames(speech: 0.9, silence: 1.2)
    }
}

// MARK: - Tests

@MainActor
final class TalkControllerTests: XCTestCase {
    func testStartTakesTheSessionTheEnginesAndTheServerTalkModeInOrder() async {
        let h = TalkHarness()
        await h.start()
        XCTAssertEqual(h.backend.holds, [true])
        XCTAssertTrue(h.port.talkObserver === h.controller)
        XCTAssertTrue(h.port.keepsStreamAttached)
        XCTAssertEqual(h.backend.talkModes, [true])
        XCTAssertTrue(h.port.isTalking, "presence says talking once the server took Talk mode")
        XCTAssertEqual(h.system.engineLoads, 1)
        XCTAssertTrue(h.system.idleTimerDisabled)
        XCTAssertEqual(h.system.nowPlaying, "Talk · Fix the build")
        XCTAssertTrue(h.system.remoteSet)
        XCTAssertEqual(h.audio.starts.count, 1)
        XCTAssertEqual(h.phase, .listening)
        XCTAssertEqual(h.audio.earcons, [.listening])
        XCTAssertEqual(h.system.whisperLoads, 1, "whisper loads with memory to spare")
    }

    func testAFullLoopSendsWhatWasSaidAndSpeaksTheReply() async {
        let h = TalkHarness()
        await h.start()
        await h.say("תבדוק למה הבילד נופל", final: "תבדוק למה ה-build נופל")
        XCTAssertEqual(h.port.sent, ["תבדוק למה ה-build נופל"], "whisper's text wins when it is back in time")
        XCTAssertTrue(h.audio.earcons.contains(.gotIt))
        XCTAssertEqual(h.final.calls, 1, "one speculative decode at the pause")
        XCTAssertEqual(h.controller.heardText, "תבדוק למה ה-build נופל")
        XCTAssertTrue(h.controller.heardIsFinal)

        await h.reply("בדקתי. הבדיקות של ה-API נופלות בגלל משתנה סביבה חסר.")
        XCTAssertEqual(h.phase, .speaking(ducked: false))
        XCTAssertFalse(h.audio.queued.isEmpty)
        await h.playAll()
        XCTAssertEqual(h.phase, .listening)
        XCTAssertEqual(h.spoken.count, 2)
        XCTAssertEqual(h.controller.spokenLog.count, 2)

        // The telemetry has the stages.
        let record = h.controller.telemetry.utterances.first
        XCTAssertEqual(record?.source, "final")
        XCTAssertEqual(record?.action, "sendSpoken")
        XCTAssertEqual(record?.sentRoute, "prompt")
        XCTAssertNotNil(record?.committed)
        XCTAssertNotNil(record?.decided)
        XCTAssertNotNil(record?.sent)
        XCTAssertNotNil(record?.firstToken)
        XCTAssertNotNil(record?.firstAudio)
    }

    func testWithoutWhisperTheLiveTextIsSent() async {
        let h = TalkHarness()
        h.system.whisperDownloaded = false
        await h.start()
        await h.say("תריץ את הטסטים")
        XCTAssertEqual(h.final.calls, 0)
        XCTAssertEqual(h.port.sent, ["תריץ את הטסטים"])
        XCTAssertEqual(h.controller.telemetry.utterances.first?.source, "live")
    }

    func testAFailedWhisperFallsBackToTheLiveText() async {
        let h = TalkHarness()
        await h.start()
        h.final.fails = true
        await h.say("תריץ את הטסטים")
        XCTAssertEqual(h.port.sent, ["תריץ את הטסטים"])
    }

    func testTalkingOverTheSpeechStopsItAndIsHeard() async {
        let h = TalkHarness()
        await h.start()
        await h.frames(silence: 1)
        await h.reply("אני עובר על הלוגים עכשיו. זה ייקח רגע.")
        XCTAssertTrue(h.controller.phase.isSpeakingPhase)
        // Past the arm delay, a loud voice: a candidate, the speech ducks.
        h.live.onceText = "רגע תעצור"
        h.live.text = "רגע תעצור את זה"
        h.final.text = "רגע, תעצור את זה"
        await h.frames(silence: 0.3)
        await h.frames(speech: 0.5, rms: 0.2)
        XCTAssertEqual(h.audio.ducks.first, true)
        XCTAssertEqual(h.phase, .hearing, "confirmed: the speech stopped and Talk hears")
        XCTAssertGreaterThanOrEqual(h.audio.speechStops, 1)
        await h.frames(speech: 0.4, silence: 1.2)
        XCTAssertEqual(h.port.sent, ["רגע, תעצור את זה"])
        XCTAssertEqual(h.controller.telemetry.routes["builtIn"]?.bargeInConfirmed, 1)
        XCTAssertEqual(h.controller.telemetry.utterances.last?.start, "bargeIn")
    }

    func testEchoOfTheSpeechIsNotAnInterruption() async {
        let h = TalkHarness()
        await h.start()
        await h.frames(silence: 1)
        await h.reply("הבנייה עברה בהצלחה")
        // The speech's own words come back through the microphone.
        h.live.onceText = "הבנייה עברה בהצלחה"
        await h.frames(silence: 0.3)
        await h.frames(speech: 0.5, rms: 0.2)
        XCTAssertEqual(h.audio.ducks.first, true, "a candidate ducks the speech")
        XCTAssertTrue(h.controller.phase.isSpeakingPhase, "echo is not confirmed")
        // No confirmation within 1.5 s: the volume comes back.
        await h.frames(silence: 1.6)
        XCTAssertEqual(h.audio.ducks.last, false)
        XCTAssertEqual(h.controller.telemetry.routes["builtIn"]?.bargeInRejected, 1)
        XCTAssertTrue(h.port.sent.isEmpty)
    }

    func testAQuestionIsAskedAndAnsweredByVoice() async {
        let h = TalkHarness()
        await h.start()
        h.port.pendingQuestion = PendingQuestion(questionId: "q1", questions: [
            QuestionSpec(id: "db", question: "Which database?", header: "DB", multiSelect: false,
                         options: [QuestionOption(label: "Postgres", description: ""),
                                   QuestionOption(label: "SQLite", description: "")]),
        ])
        h.controller.talkPendingChanged()
        await h.settle()
        XCTAssertEqual(h.controller.ask?.id, "question:q1")
        XCTAssertTrue(h.spoken.last?.contains("Postgres") ?? false)
        await h.playAll()
        XCTAssertEqual(h.phase, .asking(h.controller.ask!, attempt: 0))
        await h.say("השני")
        XCTAssertEqual(h.port.questionAnswers.count, 1)
        XCTAssertEqual(h.port.questionAnswers.first?.answers.first?.labels, ["SQLite"])
        XCTAssertTrue(h.port.sent.isEmpty, "an answer is not a message")
    }

    func testAPermissionIsAnsweredByVoice() async {
        let h = TalkHarness()
        await h.start()
        h.port.isInFlight = true
        h.controller.refreshSession()
        h.port.pendingPermission = PendingPermission(
            requestId: "r1",
            toolCall: AnyJSON.parse(jsonString: #"{"kind":"execute","title":"rm -rf build","rawInput":{"command":"rm -rf build","description":"למחוק את תיקיית הבילד"}}"#)!,
            options: [PermissionOption(optionId: "allow", name: "Allow", kind: "allow_once"),
                      PermissionOption(optionId: "deny", name: "Reject", kind: "reject_once")])
        h.controller.talkPendingChanged()
        await h.settle()
        XCTAssertEqual(h.spoken.last, "אני רוצה למחוק את תיקיית הבילד. לאשר?")
        await h.playAll()
        await h.say("כן")
        XCTAssertEqual(h.port.permissionAnswers, ["allow"])
    }

    func testAChoiceButtonAnswersThroughTheSameActions() async {
        let h = TalkHarness()
        await h.start()
        h.port.pendingPermission = PendingPermission(
            requestId: "r2",
            toolCall: AnyJSON.parse(jsonString: #"{"kind":"edit","title":"Edit login.ts","rawInput":{"file_path":"/src/auth/login.ts"}}"#)!,
            options: [PermissionOption(optionId: "allow", name: "Allow", kind: "allow_once"),
                      PermissionOption(optionId: "deny", name: "Reject", kind: "reject_once")])
        h.controller.talkPendingChanged()
        await h.settle()
        let reject = h.controller.ask?.choices.first { $0.id == "deny" }
        XCTAssertNotNil(reject)
        if let reject { h.controller.choose(reject) }
        await h.settle()
        XCTAssertEqual(h.port.permissionAnswers, ["deny"])
    }

    func testASubAgentsPermissionIsAnsweredThroughTheServer() async {
        let h = TalkHarness()
        await h.start()
        h.backend.subAgentItems = [PendingItem(
            id: "p9", kind: "permission", source: "permission", conversationId: 77, rootConversationId: 42,
            connectionId: "c77", requestId: "req9", askedAt: Date(), text: "npm test",
            options: [PendingOption(id: "ok", label: "Allow", kind: "allow_once"),
                      PendingOption(id: "no", label: "Reject", kind: "reject_once")])]
        h.backend.onItemsChanged?()
        await h.settle()
        XCTAssertEqual(h.controller.ask?.id, "item:p9")
        await h.playAll()
        await h.say("כן")
        XCTAssertEqual(h.backend.responses.map(\.1), ["ok"])
    }

    func testABackgroundResultIsSpoken() async {
        let h = TalkHarness()
        await h.start()
        let old = MessageTurn(id: "bg-old", role: .assistant, blocks: [.text("Earlier result.")],
                              timestamp: Date(timeIntervalSinceNow: -3600), usage: nil, durationMs: nil, model: nil,
                              completedAt: nil, serverMillis: nil)
        h.controller.talkBackgroundTurns([old])
        await h.settle()
        XCTAssertTrue(h.spoken.isEmpty, "a turn from before Talk was read on the screen")
        let fresh = MessageTurn(id: "bg-1", role: .assistant, blocks: [.text("הסוכן ברקע סיים. כל הבדיקות עברו.")],
                                timestamp: Date(), usage: nil, durationMs: nil, model: nil, completedAt: nil,
                                serverMillis: nil)
        h.controller.talkBackgroundTurns([fresh])
        await h.settle()
        XCTAssertEqual(h.spoken, ["הסוכן ברקע סיים.", "כל הבדיקות עברו."])
    }

    func testTheBackgroundUnloadsWhisperAndTheForegroundBringsItBack() async {
        let h = TalkHarness()
        await h.start()
        XCTAssertTrue(h.system.isWhisperLoaded)
        h.system.isWhisperLoaded = false
        h.system.onEvent?(.enteredBackground)
        await h.say("מה המצב", final: "should not be used")
        XCTAssertEqual(h.final.calls, 0, "no whisper in the background")
        XCTAssertEqual(h.port.sent, ["מה המצב"])
        XCTAssertEqual(h.controller.telemetry.utterances.last?.inBackground, true)
        h.system.onEvent?(.willEnterForeground)
        await h.settle()
        XCTAssertTrue(h.system.isWhisperLoaded)
        XCTAssertEqual(h.system.whisperLoads, 2)
    }

    func testAnInterruptionPausesAndResumes() async {
        let h = TalkHarness()
        await h.start()
        await h.reply("משפט ראשון. משפט שני.")
        XCTAssertTrue(h.controller.phase.isSpeakingPhase)
        h.controller.handleAudioEvent(.interruptionBegan)
        await h.settle()
        XCTAssertEqual(h.phase, .paused(.interruption))
        XCTAssertEqual(h.controller.status, .paused(.interruption))
        h.controller.handleAudioEvent(.interruptionEnded(shouldResume: true))
        await h.settle()
        XCTAssertEqual(h.audio.starts.count, 2, "the audio starts again")
        XCTAssertEqual(h.phase, .listening)
    }

    func testARouteChangeSaysTheCurrentSentenceAgain() async {
        let h = TalkHarness()
        await h.start()
        await h.reply("משפט ראשון. משפט שני.")
        let queuedBefore = h.audio.queued.count
        XCTAssertGreaterThan(queuedBefore, 0)
        h.audio.dropQueued()
        h.audio.route = .bluetoothHFP
        h.audio.echoMode = .none
        h.controller.handleAudioEvent(.routeChanged(.bluetoothHFP))
        await h.settle()
        XCTAssertEqual(h.audio.queued.count, queuedBefore, "what was queued is queued again")
        XCTAssertEqual(h.controller.route, .bluetoothHFP)
        await h.playAll()
        XCTAssertEqual(h.phase, .listening)
    }

    func testMemoryWarningsDropWhisperThenTheLookAhead() async {
        let h = TalkHarness()
        await h.start()
        h.system.onEvent?(.memoryWarning)
        await h.settle()
        XCTAssertTrue(h.controller.fastMode)
        XCTAssertEqual(h.system.whisperUnloads, 1)
        await h.say("עוד משהו", final: "unused")
        XCTAssertEqual(h.final.calls, 0)
        XCTAssertEqual(h.port.sent, ["עוד משהו"])
        h.system.onEvent?(.memoryWarning)
        await h.settle()
        XCTAssertEqual(h.controller.telemetry.memoryWarnings, 2)
    }

    func testTooLittleMemoryKeepsWhisperUnloaded() async {
        let h = TalkHarness()
        h.system.availableMemory = 900 * 1_048_576
        await h.start()
        XCTAssertEqual(h.system.whisperLoads, 0)
    }

    func testSoftMuteListensOnlyForUnmute() async {
        let h = TalkHarness()
        await h.start()
        await h.say("השתק")
        XCTAssertEqual(h.controller.mute, .soft)
        await h.say("תריץ את הבילד")
        XCTAssertTrue(h.port.sent.isEmpty, "muted: nothing is sent")
        await h.say("תקשיב")
        XCTAssertEqual(h.controller.mute, TalkMute.none)
    }

    func testTheMuteButtonStopsTheMicrophone() async {
        let h = TalkHarness()
        await h.start()
        h.controller.toggleMuteButton()
        XCTAssertEqual(h.controller.mute, .hard)
        XCTAssertEqual(h.audio.inputMutes, [true])
        h.live.text = "לא אמור להישמע"
        await h.frames(speech: 0.9, silence: 1.2)
        XCTAssertEqual(h.live.begins, 0, "no frame is heard")
        h.controller.toggleMuteButton()
        XCTAssertEqual(h.controller.mute, TalkMute.none)
        XCTAssertEqual(h.audio.inputMutes, [true, false])
    }

    func testPushToTalkCommitsOnRelease() async {
        let h = TalkHarness(handsFree: false)
        await h.start()
        h.live.text = "תעשה commit"
        h.final.text = "תעשה commit"
        await h.frames(speech: 0.5)
        XCTAssertTrue(h.port.sent.isEmpty, "push to talk: voice alone starts nothing")
        h.controller.press(true)
        await h.frames(speech: 0.8, silence: 1.2)
        XCTAssertTrue(h.port.sent.isEmpty, "a pause doesn't commit while held")
        h.controller.press(false)
        await h.frames(silence: 0.6)
        XCTAssertEqual(h.port.sent, ["תעשה commit"])
        XCTAssertEqual(h.controller.telemetry.utterances.last?.start, "pushToTalk")
    }

    func testAClickOnTheCameraControlStopsTheSpeech() async {
        let h = TalkHarness()
        await h.start()
        await h.reply("משפט ארוך שמדברים עליו. ועוד אחד.")
        XCTAssertTrue(h.controller.phase.isSpeakingPhase)
        h.controller.press(true)
        await h.advance(0.1)
        h.controller.press(false)
        await h.settle()
        XCTAssertFalse(h.controller.phase.isSpeakingPhase)
        XCTAssertTrue(h.port.sent.isEmpty)
    }

    func testTheSkipButtonDropsTheReply() async {
        let h = TalkHarness()
        await h.start()
        await h.reply("משפט ראשון. משפט שני. משפט שלישי.")
        h.controller.skip()
        await h.settle()
        XCTAssertEqual(h.phase, .listening)
        XCTAssertTrue(h.audio.queued.isEmpty)
    }

    func testRepeatFromTheAirPodsSaysTheReplyAgain() async {
        let h = TalkHarness()
        await h.start()
        await h.reply("זה הסיכום.")
        await h.playAll()
        let before = h.spoken.count
        h.system.remote?.remoteRepeat()
        await h.settle()
        XCTAssertEqual(h.spoken.count, before + 1)
        XCTAssertEqual(h.spoken.last, "זה הסיכום.")
    }

    func testEndingRestoresEverything() async {
        let h = TalkHarness()
        await h.start()
        await h.say("שלום")
        h.controller.end()
        await h.settle()
        XCTAssertTrue(h.ended)
        XCTAssertEqual(h.controller.status, .ended)
        XCTAssertEqual(h.backend.talkModes, [true, false], "talk mode off")
        XCTAssertFalse(h.port.isTalking, "presence off")
        XCTAssertFalse(h.port.keepsStreamAttached)
        XCTAssertNil(h.port.talkObserver)
        XCTAssertEqual(h.backend.holds, [true, false], "the session is let go")
        XCTAssertEqual(h.system.engineReleases, 1, "the engine leases are released")
        XCTAssertFalse(h.system.idleTimerDisabled)
        XCTAssertNil(h.system.nowPlaying)
        XCTAssertFalse(h.system.remoteSet)
        XCTAssertEqual(h.audio.stops, 1)
        XCTAssertFalse(h.backend.uploads.isEmpty, "the telemetry went to the server")
        let report = h.backend.uploads.first.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual(report?["kind"] as? String, "talk_lab")
        XCTAssertLessThan(h.backend.uploads.first?.count ?? .max, 1_048_576)
    }

    func testSayingEndEndsTalk() async {
        let h = TalkHarness()
        await h.start()
        await h.say("סיים שיחה")
        XCTAssertTrue(h.ended)
        XCTAssertEqual(h.backend.talkModes.last, false)
    }

    func testTenQuietMinutesEndTalk() async {
        let h = TalkHarness()
        await h.start()
        await h.advance(TalkController.inactivityLimit - 30)
        XCTAssertFalse(h.ended)
        await h.advance(40)
        XCTAssertTrue(h.ended)
    }

    func testRunningWorkKeepsTalkOpen() async {
        let h = TalkHarness()
        await h.start()
        h.port.isInFlight = true
        h.port.awaitingBackground = true
        h.port.backgroundOutstanding = 1
        await h.advance(TalkController.inactivityLimit + 60)
        XCTAssertFalse(h.ended)
        XCTAssertEqual(h.controller.backgroundOutstanding, 1)
    }

    func testAFailedStartEndsWithTheReason() async {
        let h = TalkHarness()
        h.audio.failStarts = 2
        await h.start()
        XCTAssertEqual(h.audio.starts.count, 2, "once more with no echo cancellation")
        XCTAssertEqual(h.audio.starts.last ?? nil, TalkEchoMode.none)
        if case .failed = h.controller.status {} else { XCTFail("status \(h.controller.status)") }
        XCTAssertTrue(h.ended)
        XCTAssertEqual(h.backend.holds, [true, false])
    }

    func testVoiceProcessingThatFailsFallsBackToNoEchoCancellation() async {
        let h = TalkHarness()
        h.audio.failStarts = 1
        await h.start()
        XCTAssertEqual(h.audio.starts.count, 2)
        XCTAssertEqual(h.phase, .listening)
    }

    func testAMidTurnStartDoesNotSayWhatWasAlreadyThere() async {
        let h = TalkHarness()
        // The session is mid-reply when Talk starts: the replay is taken as heard.
        h.port.isInFlight = true
        h.port.liveTurn = (id: "t9", text: "כבר נאמר על המסך. ", streaming: true)
        await h.start()
        XCTAssertTrue(h.spoken.isEmpty)
        h.controller.talkLiveText(turnID: "t9", text: "כבר נאמר על המסך. ועכשיו משהו חדש.", isStreaming: false)
        await h.settle()
        XCTAssertEqual(h.spoken, ["ועכשיו משהו חדש."])
    }

    func testALongReplyIsLeftOnTheScreenAfterNinetySeconds() async {
        let h = TalkHarness()
        await h.start()
        let sentence = String(repeating: "מילה ", count: 60).trimmingCharacters(in: .whitespaces) + "."
        let text = Array(repeating: sentence, count: 8).joined(separator: " ")
        await h.reply(text)
        while !h.audio.queued.isEmpty { await h.playAll() }
        XCTAssertEqual(h.spoken.last, SpokenPrompts.restOnScreen(.hebrew(.masculine)))
        XCTAssertLessThan(h.spoken.count, 8)
    }

    func testSpeakProgressSaysAPhraseWhileTheAgentWorks() async {
        let h = TalkHarness()
        TalkPrefs(defaults: h.defaults).speakProgress = true
        await h.start()
        h.port.isInFlight = true
        await h.advance(25)
        XCTAssertEqual(h.spoken.first, SpokenPrompts.stillWorking(.hebrew(.masculine)))
    }

    func testAPlanIsApprovedByVoice() async {
        let h = TalkHarness()
        await h.start()
        h.port.pendingPlanApproval = PendingPlanApproval(approvalId: "a1", toolCallId: "t1",
                                                         planMarkdown: "Add a retry around the upload. Then test it.")
        h.controller.talkPendingChanged()
        await h.settle()
        XCTAssertTrue(h.spoken.last?.hasPrefix("יש תוכנית:") ?? false)
        await h.playAll()
        await h.say("מאשר")
        XCTAssertEqual(h.port.planAnswers, [.approve])
    }

    func testASecretQuestionIsOnlyAnnounced() async {
        let h = TalkHarness()
        await h.start()
        h.port.pendingQuestion = PendingQuestion(questionId: "q2", questions: [
            QuestionSpec(id: "key", question: "API key?", header: "Key", multiSelect: false, options: [],
                         isSecret: true),
        ])
        h.controller.talkPendingChanged()
        await h.settle()
        XCTAssertEqual(h.spoken.last, SpokenPrompts.secretWaiting(.hebrew(.masculine)))
        XCTAssertNil(h.controller.ask, "never asked or listened for")
        await h.playAll()
        await h.say("הסיסמה היא אחת שתיים שלוש")
        XCTAssertTrue(h.port.questionAnswers.isEmpty)
    }

    func testCancellingTheAgentAsksFirst() async {
        let h = TalkHarness()
        await h.start()
        h.port.isInFlight = true
        h.controller.refreshSession()
        await h.say("בטל את הסוכן")
        XCTAssertEqual(h.port.cancels, 0)
        XCTAssertEqual(h.spoken.last, SpokenPrompts.confirmCancel(.hebrew(.masculine)))
        await h.playAll()
        await h.say("כן")
        XCTAssertEqual(h.port.cancels, 1)
    }

    func testTelemetrySplitsIntoReportsUnderTheLimit() {
        var telemetry = TalkTelemetry(conversationID: 1, origin: 0, settings: TalkTelemetry.Settings(
            handsFree: true, patience: "normal", interruptBySpeaking: true, smartTurn: "shadow",
            echoSetting: "automatic", naturalVoice: true, language: "he", address: "masculine"))
        for id in 0..<300 {
            telemetry.began(id: id, start: .speech, route: "builtIn", echo: "none", inBackground: false,
                            whisperLoaded: true, at: Double(id))
            telemetry.update(id) { $0.text = String(repeating: "שלום עולם ", count: 60) }
        }
        let reports = telemetry.reports(app: ["version": "1.4.0"], device: ["model": "iPhone"], maxBytes: 64 * 1024)
        XCTAssertGreaterThan(reports.count, 1)
        for report in reports { XCTAssertLessThan(report.count, 64 * 1024) }
        let parts = reports.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let total = parts.compactMap { ($0["talk"] as? [String: Any])?["utterances"] as? [Any] }.map(\.count).reduce(0, +)
        XCTAssertEqual(total, 300)
        XCTAssertTrue(parts.allSatisfy { $0["kind"] as? String == "talk_lab" })
    }
}

private extension TalkState.Phase {
    var isSpeakingPhase: Bool {
        if case .speaking = self { return true }
        return false
    }
}
