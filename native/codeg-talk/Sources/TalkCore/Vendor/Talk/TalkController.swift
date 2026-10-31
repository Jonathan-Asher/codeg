import Foundation
import Observation

/// One Talk: a hands-free voice conversation with one session. It runs
/// ``TalkMachine``'s effects over the real engines:
///
/// - **Listening.** Every microphone frame goes to the streaming VAD, then to
///   ``EndOfTurnPolicy`` (or, while Talk speaks, ``BargeInPolicy``), and while
///   an utterance is heard to the live transcriber (captions, the
///   dangling-word check at a pause, a barge-in's confirmation). At a pause
///   whisper starts on the utterance (speculatively) and Smart Turn is asked
///   (logged unless active). On commit ``FinalTranscriptChoice`` picks the
///   text, ``TalkRouter`` decides what it means, and the session acts.
/// - **Speaking.** The session's text arrives through ``SessionTalkObserver``
///   and ``TalkFeed``; ``SentenceSpeaker`` synthesizes ahead and plays it.
/// - **Asking.** The session's cards, and its sub-agents' waiting items, are
///   asked with ``SpokenPrompts``.
/// - **Lifecycle.** Leases on the session's model and the engines, the idle
///   timer, the server's Talk mode and presence; Talk ends after 10 minutes
///   with nothing said and nothing running.
/// - **Memory.** whisper loads only with 1.5 GB to spare; the first memory
///   warning drops it ("Fast mode"), the second keeps one sentence ahead.
@MainActor
@Observable
final class TalkController {
    /// What the sheet shows, from the machine's phase.
    enum Status: Equatable {
        case starting
        case listening
        /// The person is speaking (or paused mid-thought).
        case hearing
        /// What they said is being transcribed and routed.
        case thinking
        /// The agent works and has nothing to say yet.
        case working
        case speaking
        case asking
        case confirmingCancel
        case paused(TalkPauseReason)
        case ended
        case failed(String)
    }

    /// A line in the "Agent" captions.
    struct SpokenLine: Identifiable, Equatable {
        let id: SpeechUnit.ID
        let text: String
    }

    // MARK: - What the sheet reads

    let conversationID: Int
    private(set) var title: String
    private(set) var status: Status = .starting
    private(set) var phase: TalkState.Phase = .off
    /// The microphone's level, 0…1.
    private(set) var inputLevel: Float = 0
    /// The speech's level, 0…1.
    private(set) var outputLevel: Float = 0
    /// What the person is saying (live), or last said (final).
    private(set) var heardText = ""
    private(set) var heardIsFinal = false
    /// The last units spoken (at most 20), and the one playing.
    private(set) var spokenLog: [SpokenLine] = []
    private(set) var currentSpokenID: SpeechUnit.ID?
    /// What is being asked (big buttons for its choices).
    private(set) var ask: TalkAsk?
    private(set) var mute: TalkMute = .none
    private(set) var handsFree: Bool
    /// Background work the session waits on.
    private(set) var backgroundOutstanding = 0
    private(set) var awaitingBackground = false
    /// whisper was dropped for memory: finals come from the live transcriber.
    private(set) var fastMode = false
    /// BlueTTS speaks (false: the iPhone's own voices).
    private(set) var naturalVoice = true
    private(set) var errorMessage: String?
    /// The last utterance can be reported as cut off (for a while after it).
    private(set) var canReportCutOff = false
    private(set) var route: TalkRoute = .builtIn
    private(set) var echoMode: TalkEchoMode = .voiceProcessing
    /// Called once Talk has ended and let go of everything.
    @ObservationIgnored var onEnded: (() -> Void)?

    var isActive: Bool {
        switch status {
        case .ended, .failed: false
        default: true
        }
    }

    /// Talk speaks Hebrew (the sheet's status follows it).
    private(set) var speaksHebrew = true

    // MARK: - Configuration

    /// Talk ends after this long with nothing said and nothing running.
    static let inactivityLimit: TimeInterval = 600
    /// whisper loads only with this much memory to spare.
    static let whisperMemoryFloor: UInt64 = 1_500 * 1_048_576
    /// More than this much of one reply is left on the screen.
    static let replySpeechLimit: TimeInterval = 90
    /// Characters per second, to guess how long a sentence takes to say.
    static let charactersPerSecond = 14.0
    /// A progress phrase at most this often.
    static let progressInterval: TimeInterval = 20
    /// Push to talk keeps this much audio from before the press.
    static let pushToTalkPreRoll: TimeInterval = 1.5
    /// A press shorter than this is a click, not speech.
    static let minimumHold: TimeInterval = 0.3
    /// How often a candidate's fresh transcript is checked.
    static let bargeInCheckInterval: TimeInterval = 0.25
    /// The cut-off report stays offered this long after an utterance.
    static let cutOffWindow: TimeInterval = 20

    // MARK: - Dependencies

    @ObservationIgnored private let port: TalkSessionPort
    @ObservationIgnored private let audio: TalkAudioIO
    @ObservationIgnored private let system: TalkSystem
    @ObservationIgnored private let backend: TalkBackend
    @ObservationIgnored private let clock: TalkClock
    @ObservationIgnored private let scheduler: TalkScheduler
    @ObservationIgnored private let worker: TalkWorker
    @ObservationIgnored private let prefs: TalkPrefs

    // MARK: - State

    @ObservationIgnored private var machine = TalkMachine()
    @ObservationIgnored private var events: [TalkEvent] = []
    @ObservationIgnored private var handling = false
    @ObservationIgnored private var feed: TalkFeed
    @ObservationIgnored private var engines: TalkEngineSet?
    @ObservationIgnored private var speaker: SentenceSpeaker?
    @ObservationIgnored private var endOfTurn: EndOfTurnPolicy
    @ObservationIgnored private var bargeIn: BargeInPolicy
    @ObservationIgnored private var ring = TalkAudioRing()
    @ObservationIgnored private var capture: TalkUtterance?
    @ObservationIgnored private var finalizing: TalkUtterance?
    @ObservationIgnored private var utteranceSerial = 0
    @ObservationIgnored private var finalGeneration = 0
    @ObservationIgnored private var finalTask: Task<Void, Never>?
    @ObservationIgnored private var listening = false
    @ObservationIgnored private var hardMuted = false
    @ObservationIgnored private var started = false
    @ObservationIgnored private var released = false
    @ObservationIgnored private var replaying = false
    @ObservationIgnored private var inBackground = false
    @ObservationIgnored private var memoryWarnings = 0
    @ObservationIgnored private var settings: TalkSettings?
    @ObservationIgnored private var lastHeardHebrew: Bool?
    @ObservationIgnored private var voice: TalkVoice = .hebrew(.neutral)
    @ObservationIgnored private var knownAsks: [String: TalkAsk] = [:]
    @ObservationIgnored private var pendingItems: [String: PendingItem] = [:]
    @ObservationIgnored private var timers: [TalkTimer: TalkScheduled] = [:]
    @ObservationIgnored private var graceTimer: TalkScheduled?
    @ObservationIgnored private var heartbeat: TalkScheduled?
    @ObservationIgnored private var cutOffTimer: TalkScheduled?
    @ObservationIgnored private var frameTask: Task<Void, Never>?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var tasks: [Int: Task<Void, Never>] = [:]
    @ObservationIgnored private var taskSerial = 0
    @ObservationIgnored private var currentFrameTime: TimeInterval?
    @ObservationIgnored private var lastCandidateStart: TimeInterval?
    @ObservationIgnored private var bargeInCheckAt: TimeInterval = 0
    @ObservationIgnored private var bargeInChecking = false
    @ObservationIgnored private var voiceRun = 0
    @ObservationIgnored private var pressStart: TimeInterval?
    @ObservationIgnored private var lastActivity: TimeInterval = 0
    @ObservationIgnored private var lastSpokeAt: TimeInterval = 0
    @ObservationIgnored private var lastProgressAt: TimeInterval = 0
    @ObservationIgnored private var progressSerial = 0
    @ObservationIgnored private var replySeconds: [String: TimeInterval] = [:]
    @ObservationIgnored private var cappedReplies: Set<String> = []
    @ObservationIgnored private var startedWallClock = Date()
    @ObservationIgnored private var speechStartedAt: TimeInterval?
    @ObservationIgnored private var interruptionRetries = 0
    @ObservationIgnored private var lastMemorySample: TimeInterval = 0
    @ObservationIgnored private(set) var telemetry: TalkTelemetry

    init(conversationID: Int, title: String?, port: TalkSessionPort, dependencies: TalkDependencies) {
        let prefs = dependencies.prefs
        self.conversationID = conversationID
        self.title = title ?? ""
        self.port = port
        audio = dependencies.audio
        system = dependencies.system
        backend = dependencies.backend
        clock = dependencies.clock
        scheduler = dependencies.scheduler
        worker = dependencies.worker
        self.prefs = prefs
        handsFree = prefs.handsFree
        endOfTurn = EndOfTurnPolicy(config: prefs.endOfTurnConfig)
        bargeIn = BargeInPolicy(config: prefs.bargeInConfig)
        let settings = dependencies.backend.cachedSettings
        self.settings = settings
        feed = TalkFeed(language: Self.feedLanguage(settings))
        telemetry = TalkTelemetry(conversationID: conversationID, origin: dependencies.clock.now(),
                                  settings: TalkTelemetry.Settings(
                                    handsFree: prefs.handsFree, patience: prefs.patience.rawValue,
                                    interruptBySpeaking: prefs.interruptBySpeaking,
                                    smartTurn: prefs.endOfTurnConfig.smartTurn.rawValue,
                                    echoSetting: prefs.echoMode.rawValue, naturalVoice: true,
                                    language: settings?.language.rawValue, address: settings?.address.rawValue))
        voice = Self.voice(settings, lastHeardHebrew: nil)
    }

    // MARK: - Start and end

    /// Start Talk: hold the session, hear what it says, turn the server's
    /// Talk mode on and say so in presence, and load the engines.
    func start() {
        guard !started else { return }
        started = true
        startedWallClock = Date()
        lastActivity = clock.now()
        backend.holdSession(true)
        system.setIdleTimerDisabled(true)
        system.onEvent = { [weak self] event in self?.systemEvent(event) }
        backend.onItemsChanged = { [weak self] in self?.pendingChanged() }
        telemetry.event("start", nil, at: clock.now())
        send(.start(handsFree: handsFree, voice: voice))
        // The observer replays the session as it is: the turn in progress is
        // taken as heard.
        replaying = true
        port.talkObserver = self
        replaying = false
        port.keepsStreamAttached = true
        refreshSession()
        let conversationID = conversationID
        track { [weak self] in
            guard let self else { return }
            do {
                try await self.backend.setTalkMode(conversationID: conversationID, enabled: true)
            } catch {
                self.telemetry.event("talk_mode_failed", String(describing: error), at: self.clock.now())
            }
            // After the server took Talk mode, so presence carries `talking`.
            guard !self.released else { return }
            self.port.isTalking = true
            if let fetched = await self.backend.fetchSettings(), !self.released {
                self.apply(settings: fetched)
            }
        }
        scheduleHeartbeat()
    }

    /// End Talk (the End button, "end the conversation", inactivity).
    func end() {
        guard started, !released else { return }
        if machine.state.isActive {
            send(.end)
        } else {
            release()
        }
    }

    // MARK: - Controls

    /// The Mute button: the microphone stops until it is tapped again. A tap
    /// while muted (either way) unmutes.
    func toggleMuteButton() {
        if mute == .none {
            hardMuted = true
            audio.setInputMuted(true)
            cancelCandidate()
            send(.setMuted(true))
        } else {
            unmute()
        }
        syncUI()
    }

    /// The Skip button: stop the speech and drop the rest of this reply.
    func skip() {
        send(.perform(.skip))
    }

    /// A tap on the orb while Talk speaks: stop and listen.
    func tapOrb() {
        guard machine.state.isSpeaking else { return }
        send(.tapInterrupt)
    }

    /// Holding the orb (push to talk) or the Camera Control.
    func press(_ down: Bool) {
        let now = clock.now()
        if down {
            pressStart = now
            send(.pushToTalk(pressed: true))
        } else {
            let held = pressStart.map { now - $0 } ?? 0
            pressStart = nil
            if held < Self.minimumHold {
                // A click: what was heard is dropped; hands-free goes on
                // listening.
                if capture?.start == .pushToTalk { send(.discard) }
            } else {
                send(.pushToTalk(pressed: false))
            }
        }
    }

    /// A press was cancelled (the screen went away): drop what it heard.
    func cancelPress() {
        pressStart = nil
        if capture?.start == .pushToTalk { send(.discard) }
    }

    /// A choice button while Talk asks.
    func choose(_ choice: TalkChoice) {
        guard let ask = machine.state.ask else { return }
        guard let action = Self.action(for: choice, of: ask) else { return }
        telemetry.event("choice", choice.label, at: clock.now())
        send(.perform(action))
    }

    /// "You cut me off": the last utterance ended too early.
    func reportCutOff() {
        guard canReportCutOff else { return }
        if let id = telemetry.cutOff() { telemetry.event("cut_off", "\(id)", at: clock.now()) }
        canReportCutOff = false
        cutOffTimer?.cancel()
    }

    func setHandsFree(_ on: Bool) {
        prefs.handsFree = on
        handsFree = on
        send(.setHandsFree(on))
    }

    /// The action a choice button stands for (the same answer the router
    /// gives for the choice's words).
    static func action(for choice: TalkChoice, of ask: TalkAsk) -> TalkAction? {
        switch ask.channel {
        case .permissionOption:
            return .respondPermission(askID: ask.id, optionId: choice.id, feedback: nil)
        case .planDecision:
            let decision: PlanApprovalDecision
            switch choice.meaning {
            case .approve: decision = .approve
            case .abandon: decision = .abandon
            default: decision = .requestChanges
            }
            return .answerPlan(askID: ask.id, decision: decision, feedback: nil)
        case .questionAnswer:
            guard let step = SpokenPrompts.advancing(ask, with: [choice.id]) else {
                return .answerQuestion(askID: ask.id, answer: QuestionAnswer(
                    answers: [QuestionAnswerItem(questionId: ask.questions?.current.id ?? ask.id, labels: [choice.id])],
                    declined: false))
            }
            if let next = step.next { return .askNext(next) }
            return .answerQuestion(askID: ask.id, answer: step.progress.answer)
        }
    }

    // MARK: - The machine

    /// Hand an event to the machine and run its effects. Events raised while
    /// effects run wait their turn.
    func send(_ event: TalkEvent) {
        events.append(event)
        guard !handling else { return }
        handling = true
        while !events.isEmpty {
            let next = events.removeFirst()
            let effects = machine.handle(next)
            for effect in effects { perform(effect) }
            syncUI()
        }
        handling = false
    }

    private func perform(_ effect: TalkEffect) {
        switch effect {
        case .prepare:
            track { [weak self] in await self?.prepare() }
        case .release:
            release()
        case .startListening(let handsFree):
            listening = true
            self.handsFree = handsFree
            if !handsFree { endOfTurn.reset() }
            lastActivity = clock.now()
        case .stopListening:
            listening = false
            endOfTurn.reset()
            cancelCandidate()
        case .micMuted(let muted):
            if !muted, hardMuted {
                hardMuted = false
                audio.setInputMuted(false)
            }
            telemetry.event(muted ? "muted" : "unmuted", hardMuted ? "hard" : "soft", at: clock.now())
        case .beginUtterance(let start):
            beginUtterance(start)
        case .cancelUtterance:
            cancelUtterance()
        case .startFinalDecode:
            startFinalDecode()
        case .cancelFinalDecode:
            cancelFinalDecode()
        case .commitUtterance:
            commitUtterance()
        case .route(let text):
            route(text)
        case .speak(let units):
            speaker?.enqueue(units)
        case .duck(let on):
            audio.duck(on)
        case .stopSpeech:
            speaker?.stop()
            speechEnded()
        case .stopSpeechAfterCurrent:
            speaker?.stopAfterCurrent()
        case .playCue(let cue):
            audio.play(Self.earcon(cue))
        case .sendAction(let action):
            track { [weak self] in await self?.act(action) }
        case .startTimer(let timer, let seconds):
            timers[timer]?.cancel()
            timers[timer] = scheduler.schedule(after: seconds) { [weak self] in
                self?.timers[timer] = nil
                self?.send(.timerFired(timer))
            }
        case .cancelTimer(let timer):
            timers.removeValue(forKey: timer)?.cancel()
        }
    }

    // MARK: - Preparing

    private func prepare() async {
        do {
            let loaded = try await system.loadEngines()
            guard !released else { return }
            engines = loaded
            naturalVoice = loaded.naturalVoice
            telemetry.settings.naturalVoice = loaded.naturalVoice
            loaded.vad.reset()
            let speaker = SentenceSpeaker(audio: audio, synthesizer: loaded.synthesizer, clock: clock)
            speaker.onUnitStarted = { [weak self] unit in self?.unitStarted(unit) }
            speaker.onFinished = { [weak self] in self?.speechFinished() }
            speaker.onFirstAudio = { [weak self] _, latency in self?.telemetry.firstAudio(latency: latency) }
            speaker.onFailure = { [weak self] unit, error in
                guard let self else { return }
                self.telemetry.event("synthesis_failed", "\(unit.id) \(error)", at: self.clock.now())
            }
            self.speaker = speaker
            sampleMemory("engines loaded")
            await loadWhisperIfRoom()
            guard !released else { return }
            try startAudio()
            listenToAudio()
            system.setNowPlaying(title: nowPlayingTitle)
            system.setRemoteTarget(self)
            send(.ready)
        } catch {
            guard !released else { return }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            telemetry.event("start_failed", errorMessage, at: clock.now())
            send(.failed)
        }
    }

    /// Start the audio with the Lab's echo setting; when that fails (voice
    /// processing didn't start), once more with none.
    private func startAudio() throws {
        let preferred = prefs.echoMode.preferredMode
        do {
            try audio.start(preferring: preferred)
        } catch {
            guard preferred != TalkEchoMode.none else { throw error }
            telemetry.event("audio_retry_without_echo_cancellation", String(describing: error), at: clock.now())
            try audio.start(preferring: TalkEchoMode.none)
        }
        route = audio.route
        echoMode = audio.echoMode
        telemetry.event("audio", "\(Self.name(route)) \(Self.name(echoMode))", at: clock.now())
    }

    private func listenToAudio() {
        frameTask?.cancel()
        eventTask?.cancel()
        let frames = audio.frames
        let audioEvents = audio.events
        frameTask = Task { [weak self] in
            for await frame in frames {
                guard let self, !Task.isCancelled else { return }
                await self.handleFrame(frame)
            }
        }
        eventTask = Task { [weak self] in
            for await event in audioEvents {
                guard let self, !Task.isCancelled else { return }
                self.handleAudioEvent(event)
            }
        }
    }

    /// whisper, when it is downloaded, the app is in front, it wasn't dropped
    /// for memory, and 1.5 GB is left with everything else loaded.
    private func loadWhisperIfRoom() async {
        guard system.finalTranscriber != nil, !system.isWhisperLoaded, !fastMode, !inBackground else { return }
        let available = system.availableMemory
        guard available >= Self.whisperMemoryFloor else {
            telemetry.event("whisper_skipped", "\(available / 1_048_576) MB free", at: clock.now())
            return
        }
        let loaded = await system.loadWhisper()
        telemetry.event(loaded ? "whisper_loaded" : "whisper_failed", nil, at: clock.now())
        sampleMemory(loaded ? "whisper loaded" : "whisper failed")
    }

    // MARK: - Releasing

    private func release() {
        guard !released else { return }
        released = true
        // With the iPhone locked, the audio is all that keeps the app
        // running: iOS suspends it as soon as the audio stops. So the time
        // to finish is taken and the reports are kept before it stops (1.4.0
        // stopped it first, and its reports and Talk mode off never went).
        let background = system.beginBackgroundWork("Talk end")
        telemetry.end(at: clock.now())
        telemetry.event("end", nil, at: clock.now())
        let sharing = prefs.shareTelemetry
        if sharing {
            let environment = system.reportEnvironment
            backend.keep(reports: telemetry.reports(app: environment.app, device: environment.device))
        }
        frameTask?.cancel()
        eventTask?.cancel()
        finalTask?.cancel()
        heartbeat?.cancel()
        graceTimer?.cancel()
        cutOffTimer?.cancel()
        for timer in timers.values { timer.cancel() }
        timers = [:]
        speaker?.stop()
        audio.stop()
        system.setRemoteTarget(nil)
        system.setNowPlaying(title: nil)
        system.releaseEngines()
        system.setIdleTimerDisabled(false)
        system.onEvent = nil
        backend.onItemsChanged = nil
        port.isTalking = false
        port.keepsStreamAttached = false
        if port.talkObserver === self { port.talkObserver = nil }
        capture = nil
        finalizing = nil
        listening = false
        hardMuted = false
        let conversationID = conversationID
        let backend = backend
        // The kept reports go while the server's Talk mode goes off, then
        // the session is let go; the time is given back once both are done.
        track {
            let reports = Task { @MainActor in
                if sharing { await backend.sendKeptReports() }
            }
            try? await backend.setTalkMode(conversationID: conversationID, enabled: false)
            backend.holdSession(false)
            await reports.value
            background.end()
        }
        if machine.state.phase == .ending { send(.ended) }
        syncUI()
        onEnded?()
    }

    // MARK: - Frames

    /// One microphone frame (32 ms at 16 kHz).
    func handleFrame(_ frame: MicFrame) async {
        guard listening, !hardMuted, let engines else { return }
        currentFrameTime = frame.time
        defer { currentFrameTime = nil }
        let p = engines.vad.probability(frame.samples)
        inputLevel = inputLevel * 0.6 + min(1, frame.rms * 12) * 0.4
        ring.append(frame)
        if capture != nil, capture!.fedThrough < frame.time { capture!.audio.append(contentsOf: frame.samples) }

        // Talking over the speech.
        if let decision = bargeIn.frame(probability: p, rms: frame.rms, at: frame.time) {
            handleBargeIn(decision, at: frame.time)
        }
        if machine.state.isSpeaking {
            noteVoiceWhileSpeaking(p)
            if case .candidate = bargeIn.phase { checkCandidate(at: frame.time) }
            endOfTurn.reset()
        } else {
            voiceRun = 0
            if handsFree, capture?.start != .pushToTalk,
               let decision = endOfTurn.frame(probability: p, at: frame.time) {
                handleTurn(decision, frame: frame)
            }
            await feedLive(frame)
        }
        if p >= 0.5 { lastActivity = clock.now() }
        tickChoice(at: clock.now())
    }

    /// Feed the utterance being heard to the live transcriber (captions).
    private func feedLive(_ frame: MicFrame) async {
        guard let utterance = capture, utterance.fedThrough < frame.time, let live = engines?.live else { return }
        capture?.fedThrough = frame.time
        let samples = frame.samples
        let id = utterance.id
        let partial = await worker.submit { live.accept(samples) }.value
        guard let partial, capture?.id == id else { return }
        capture?.partial = partial
        heardText = partial
        heardIsFinal = false
    }

    private func handleTurn(_ decision: EndOfTurnDecision, frame: MicFrame) {
        switch decision {
        case .speechStarted:
            guard bargeIn.allowsSpeechStart(rms: frame.rms, at: frame.time) else {
                // The tail of the speech, or the room: not the person yet.
                endOfTurn.reset()
                telemetry.route(Self.name(route), echo: Self.name(echoMode)) { $0.gatedStarts += 1 }
                return
            }
            lastActivity = clock.now()
            send(.speechStarted)
        case .pause:
            send(.pause)
            checkPause()
        case .resumed:
            send(.speechResumed)
        case .commit:
            send(.commit)
        case .discard:
            send(.discard)
        }
    }

    /// At a pause: the last words decide how long to wait (a dangling "של"
    /// waits longer), and Smart Turn is asked.
    private func checkPause() {
        guard let utterance = capture, let engines else { return }
        let id = utterance.id
        let live = engines.live
        let turn = engines.turn
        let clip = utterance.tail(8)
        let flushed = worker.submit { live.flushTail() }
        track { [weak self] in
            let text = await flushed.value
            guard let self, self.capture?.id == id else { return }
            self.endOfTurn.pauseTranscript(text)
            // Smart Turn after the last words are known (a dangling word
            // keeps it from committing).
            guard let turn else { return }
            let probability = await turn.probability(last8s: clip)
            guard self.capture?.id == id else { return }
            if let decision = self.endOfTurn.smartTurn(probability: probability, at: self.clock.now()),
               case .commit = decision {
                self.send(.commit)
            }
        }
    }

    // MARK: - Barge-in

    private func handleBargeIn(_ decision: BargeInDecision, at time: TimeInterval) {
        let routeName = Self.name(route)
        switch decision {
        case .candidate:
            lastCandidateStart = bargeIn.candidateStart
            // The first fresh transcript is taken at once.
            bargeInCheckAt = time - Self.bargeInCheckInterval
            telemetry.route(routeName, echo: Self.name(echoMode)) { $0.bargeInCandidates += 1 }
            send(.bargeInCandidate)
        case .rejected:
            telemetry.route(routeName, echo: Self.name(echoMode)) { $0.bargeInRejected += 1 }
            send(.bargeInRejected)
        case .confirmed:
            telemetry.route(routeName, echo: Self.name(echoMode)) { $0.bargeInConfirmed += 1 }
            send(.bargeInConfirmed)
        }
    }

    /// While a candidate is checked: a fresh transcript of its audio, at most
    /// every 250 ms, one at a time.
    private func checkCandidate(at time: TimeInterval) {
        guard !bargeInChecking, time - bargeInCheckAt >= Self.bargeInCheckInterval,
              let start = lastCandidateStart, let live = engines?.live else { return }
        bargeInCheckAt = time
        bargeInChecking = true
        let clip = ring.samples(from: start)
        let pass = worker.submit { live.transcribeOnce(clip) }
        track { [weak self] in
            let text = await pass.value
            guard let self else { return }
            self.bargeInChecking = false
            guard case .candidate = self.bargeIn.phase else { return }
            if let decision = self.bargeIn.transcript(text, at: self.currentFrameTime ?? self.clock.now()) {
                self.handleBargeIn(decision, at: self.clock.now())
            }
        }
    }

    private func cancelCandidate() {
        if case .candidate = bargeIn.phase { send(.bargeInRejected) }
        bargeIn.speechEnded(at: clock.now())
    }

    /// A voice heard while Talk speaks (echo, or the person): counted per
    /// route.
    private func noteVoiceWhileSpeaking(_ p: Float) {
        if p >= 0.5 {
            voiceRun += 1
            if voiceRun == 2 {
                telemetry.route(Self.name(route), echo: Self.name(echoMode)) { $0.voiceOnsetsWhileSpeaking += 1 }
            }
        } else {
            voiceRun = 0
        }
    }

    // MARK: - Utterances

    private func beginUtterance(_ start: TalkUtteranceStart) {
        let now = currentFrameTime ?? ring.end ?? clock.now()
        let audioStart: TimeInterval
        switch start {
        case .speech:
            audioStart = endOfTurn.utteranceStart
                ?? endOfTurn.trace.map { max(0, $0.startedAt - endOfTurn.config.preRoll) }
                ?? now - endOfTurn.config.preRoll
        case .bargeIn:
            let began = lastCandidateStart ?? now - 0.3
            endOfTurn.begin(at: began, speechUntil: now)
            audioStart = endOfTurn.utteranceStart ?? began
        case .pushToTalk:
            endOfTurn.reset()
            audioStart = now - Self.pushToTalkPreRoll
        }
        utteranceSerial += 1
        let preRoll = ring.samples(from: audioStart)
        let expectsFinal = finalAvailable
        capture = TalkUtterance(id: utteranceSerial, start: start, audioStart: audioStart, audio: preRoll,
                                fedThrough: currentFrameTime ?? ring.lastFrameTime ?? now,
                                choice: FinalTranscriptChoice(grace: endOfTurn.config.finalGrace,
                                                              expectsFinal: expectsFinal))
        heardText = ""
        heardIsFinal = false
        canReportCutOff = false
        lastActivity = clock.now()
        if let live = engines?.live { worker.enqueue { live.begin(preRoll: preRoll) } }
        telemetry.began(id: utteranceSerial, start: start, route: Self.name(route), echo: Self.name(echoMode),
                        inBackground: inBackground, whisperLoaded: system.isWhisperLoaded, at: clock.now())
    }

    private func cancelUtterance() {
        if let capture { telemetry.update(capture.id) { $0.discarded = true } }
        if let trace = endOfTurn.trace, let capture { telemetry.trace(capture.id, trace) }
        capture = nil
        finalizing = nil
        graceTimer?.cancel()
        endOfTurn.reset()
        if let live = engines?.live { worker.enqueue { live.reset() } }
    }

    /// Whether whisper can give this utterance's final text.
    private var finalAvailable: Bool {
        system.finalTranscriber != nil && system.isWhisperLoaded && !inBackground && !fastMode
    }

    /// whisper on the utterance so far (at a pause, or at the commit).
    private func startFinalDecode() {
        finalGeneration += 1
        finalTask?.cancel()
        guard let utterance = capture else { return }
        guard finalAvailable, let final = system.finalTranscriber else {
            capture?.choice = FinalTranscriptChoice(grace: endOfTurn.config.finalGrace, expectsFinal: false)
            return
        }
        // A new decode replaces an earlier one (the person went on).
        capture?.choice = FinalTranscriptChoice(grace: endOfTurn.config.finalGrace, expectsFinal: true)
        let generation = finalGeneration
        let id = utterance.id
        let clip = utterance.audio
        let startedAt = telemetry.time(clock.now())
        telemetry.update(id) { $0.finalStarted = startedAt }
        finalTask = Task { [weak self] in
            do {
                let text = try await final.transcribe(clip)
                self?.finalArrived(text, id: id, generation: generation)
            } catch {
                self?.finalFailed(id: id, generation: generation)
            }
        }
    }

    private func cancelFinalDecode() {
        finalGeneration += 1
        finalTask?.cancel()
        finalTask = nil
        if capture != nil {
            capture?.choice = FinalTranscriptChoice(grace: endOfTurn.config.finalGrace, expectsFinal: finalAvailable)
        }
    }

    private func finalArrived(_ text: String, id: Int, generation: Int) {
        guard generation == finalGeneration else { return }
        let now = clock.now()
        let at = telemetry.time(now)
        telemetry.update(id) {
            $0.finalText = text
            $0.finalAt = at
        }
        if capture?.id == id {
            capture?.finalText = text
            _ = capture?.choice.finalReady(text, at: now)
        } else if finalizing?.id == id {
            finalizing?.finalText = text
            if let result = finalizing?.choice.finalReady(text, at: now) { decide(result) }
        }
    }

    private func finalFailed(id: Int, generation: Int) {
        guard generation == finalGeneration else { return }
        telemetry.update(id) { $0.finalFailed = true }
        if capture?.id == id {
            _ = capture?.choice.finalFailed()
        } else if finalizing?.id == id, let result = finalizing?.choice.finalFailed() {
            decide(result)
        }
    }

    /// The utterance is complete: end the live transcript, then pick the
    /// text (whisper's if it is back within the grace, else the live one).
    private func commitUtterance() {
        guard var utterance = capture else { return }
        capture = nil
        let committedAt = currentFrameTime ?? clock.now()
        utterance.committedAt = committedAt
        finalizing = utterance
        let id = utterance.id
        if let trace = endOfTurn.trace, utterance.start != .pushToTalk { telemetry.trace(id, trace) }
        let at = telemetry.time(committedAt)
        telemetry.update(id) {
            $0.committed = at
            if $0.speechEnd == nil { $0.speechEnd = at }
        }
        lastActivity = clock.now()
        guard let live = engines?.live else {
            decide(FinalTranscriptChoice.Result(text: "", source: .live))
            return
        }
        let finished = worker.submit { live.finish() }
        track { [weak self] in
            let text = await finished.value
            self?.liveFinished(text, id: id)
        }
        graceTimer?.cancel()
        graceTimer = scheduler.schedule(after: endOfTurn.config.finalGrace + 0.05) { [weak self] in
            guard let self else { return }
            self.tickChoice(at: self.clock.now())
        }
    }

    private func liveFinished(_ text: String, id: Int) {
        let now = clock.now()
        let at = telemetry.time(now)
        telemetry.update(id) {
            $0.liveText = text
            $0.liveAt = at
        }
        guard var utterance = finalizing, utterance.id == id else { return }
        utterance.liveText = text
        heardText = text
        let result = utterance.choice.committed(liveText: text, at: utterance.committedAt ?? now)
        finalizing = utterance
        if let result {
            decide(result)
        } else {
            // The grace may have run out while the live text was finished.
            tickChoice(at: now)
        }
    }

    /// Past the grace: the live text is used.
    private func tickChoice(at time: TimeInterval) {
        guard finalizing?.liveText != nil, let result = finalizing?.choice.tick(at: time) else { return }
        decide(result)
    }

    private func decide(_ result: FinalTranscriptChoice.Result) {
        guard let utterance = finalizing else { return }
        finalizing = nil
        graceTimer?.cancel()
        let now = clock.now()
        let at = telemetry.time(now)
        telemetry.update(utterance.id) {
            $0.text = result.text
            $0.source = result.source.rawValue
            $0.decided = at
        }
        heardText = result.text
        heardIsFinal = true
        if !result.text.isEmpty {
            let hebrew = HebrewText.containsHebrew(result.text)
            if lastHeardHebrew != hebrew {
                lastHeardHebrew = hebrew
                let resolved = Self.voice(settings, lastHeardHebrew: hebrew)
                if resolved != voice {
                    voice = resolved
                    send(.setVoice(resolved))
                }
            }
            offerCutOffReport()
        }
        lastUtteranceID = utterance.id
        send(.transcript(result.text))
    }

    @ObservationIgnored private var lastUtteranceID: Int?

    private func offerCutOffReport() {
        canReportCutOff = true
        cutOffTimer?.cancel()
        cutOffTimer = scheduler.schedule(after: Self.cutOffWindow) { [weak self] in self?.canReportCutOff = false }
    }

    private func route(_ text: String) {
        let action = TalkRouter.route(text, context: machine.state.routeContext)
        let name = Self.name(action)
        if let id = lastUtteranceID { telemetry.update(id) { $0.action = name } }
        routedUtteranceID = lastUtteranceID
        send(.routed(action))
    }

    /// The utterance whose action is on its way to the session.
    @ObservationIgnored private var routedUtteranceID: Int?

    // MARK: - Acting on the session

    private func act(_ action: TalkAction) async {
        let id = routedUtteranceID
        routedUtteranceID = nil
        let at = telemetry.time(clock.now())
        if let id { telemetry.update(id) { $0.sent = at } }
        var ok = true
        switch action {
        case .sendSpoken(let text):
            let route = await port.sendSpoken(text)
            let routeName = Self.name(route)
            if let id { telemetry.update(id) { $0.sentRoute = routeName } }
        case .respondPermission(let askID, let optionId, let feedback):
            ok = await respondPermission(askID: askID, optionId: optionId)
            if ok, let feedback, !feedback.isEmpty { _ = await port.sendSpoken(feedback) }
        case .answerQuestion(let askID, let answer):
            ok = await answerQuestion(askID: askID, answer: answer)
        case .answerPlan(let askID, let decision, let feedback):
            ok = await answerPlan(askID: askID, decision: decision, feedback: feedback)
        case .cancelAgent:
            port.cancel()
        default:
            break
        }
        guard !released else { return }
        if !ok { send(.actionFailed) }
        refreshSession()
    }

    private func respondPermission(askID: String, optionId: String) async -> Bool {
        switch knownAsks[askID]?.source {
        case .pendingItem(let itemID)?:
            guard let item = pendingItems[itemID] else { return false }
            do {
                try await backend.respond(item: item, optionId: optionId)
                return true
            } catch {
                return false
            }
        default:
            return await port.respondPermission(optionId: optionId)
        }
    }

    private func answerQuestion(askID: String, answer: QuestionAnswer) async -> Bool {
        switch knownAsks[askID]?.source {
        case .pendingItem(let itemID)?:
            guard let item = pendingItems[itemID] else { return false }
            do {
                try await backend.answer(item: item, answer: answer)
                return true
            } catch {
                return false
            }
        default:
            return await port.answerQuestion(answer)
        }
    }

    private func answerPlan(askID: String, decision: PlanApprovalDecision, feedback: String?) async -> Bool {
        switch knownAsks[askID]?.source {
        case .pendingItem(let itemID)?:
            guard let item = pendingItems[itemID] else { return false }
            do {
                try await backend.answerPlan(item: item, decision: decision, feedback: feedback)
                return true
            } catch {
                return false
            }
        default:
            return await port.answerPlanApproval(decision: decision, feedback: feedback)
        }
    }

    // MARK: - Speaking

    private func unitStarted(_ unit: SpeechUnit) {
        let now = clock.now()
        lastActivity = now
        lastSpokeAt = now
        if speechStartedAt == nil { speechStartedAt = now }
        currentSpokenID = unit.id
        spokenLog.append(SpokenLine(id: unit.id, text: unit.text))
        if spokenLog.count > TalkState.repeatLimit { spokenLog.removeFirst(spokenLog.count - TalkState.repeatLimit) }
        outputLevel = min(1, (speaker?.level ?? 0) * 6)
        bargeIn.sentenceStarted(unit.text, at: currentFrameTime ?? ring.end ?? now)
        if Self.isAgentSpeech(unit) { telemetry.reply(firstAudio: now) }
        send(.unitStarted(unit.id))
    }

    private func speechFinished() {
        speechEnded()
        send(.speechFinished)
    }

    /// The speech stopped or ended: the gate after it, the counts.
    private func speechEnded() {
        let now = clock.now()
        if let started = speechStartedAt {
            telemetry.route(Self.name(route), echo: Self.name(echoMode)) { $0.speechSeconds += now - started }
        }
        speechStartedAt = nil
        currentSpokenID = nil
        outputLevel = 0
        lastSpokeAt = now
        bargeIn.speechEnded(at: currentFrameTime ?? ring.end ?? now)
    }

    /// Agent speech for the machine, with more than 90 s of one reply left on
    /// the screen.
    private func deliver(_ units: [SpeechUnit]) {
        guard !units.isEmpty else { return }
        var out: [SpeechUnit] = []
        for unit in units {
            let reply = unit.id.reply
            if cappedReplies.contains(reply) { continue }
            let seconds = (replySeconds[reply] ?? 0) + Double(unit.text.count) / Self.charactersPerSecond
            replySeconds[reply] = seconds
            if seconds > Self.replySpeechLimit, unit.kind == .sentence {
                cappedReplies.insert(reply)
                out.append(SpeechUnit(id: SpeechUnit.ID(reply: reply, index: unit.id.index), text: SpokenPrompts.restOnScreen(voice),
                                      language: voice.language, isFirstOfReply: false, kind: .cue))
                continue
            }
            out.append(unit)
        }
        guard !out.isEmpty else { return }
        send(.reply(out))
    }

    // MARK: - The session (SessionTalkObserver)

    /// Whether the agent is running, the background work, the inactivity
    /// clock. Called on every session signal and once a second.
    func refreshSession() {
        let running = port.isInFlight
        if running != machine.state.agentRunning, !released { send(.agentRunning(running)) }
        if backgroundOutstanding != port.backgroundOutstanding { backgroundOutstanding = port.backgroundOutstanding }
        if awaitingBackground != port.awaitingBackground { awaitingBackground = port.awaitingBackground }
        if running || awaitingBackground || backgroundOutstanding > 0 { lastActivity = max(lastActivity, clock.now()) }
        if let name = port.talkTitle, name != title {
            title = name
            system.setNowPlaying(title: nowPlayingTitle)
        }
    }

    /// The session's cards and its sub-agents' waiting items, asked as they
    /// come and dropped as they go.
    func pendingChanged() {
        guard started, !released else { return }
        var current: [TalkAsk] = []
        if let permission = port.pendingPermission { current.append(SpokenPrompts.ask(permission: permission, voice: voice)) }
        if let question = port.pendingQuestion { current.append(SpokenPrompts.ask(question: question, voice: voice)) }
        if let plan = port.pendingPlanApproval { current.append(SpokenPrompts.ask(plan: plan, voice: voice)) }
        for item in backend.subAgentItems where item.rootConversationId == conversationID
            && item.conversationId != conversationID {
            pendingItems[item.id] = item
            current.append(SpokenPrompts.ask(item: item, voice: voice))
        }
        let ids = Set(current.map(\.id))
        for gone in knownAsks.keys.sorted() where !ids.contains(gone) {
            knownAsks.removeValue(forKey: gone)
            send(.askResolved(id: gone))
        }
        for ask in current where knownAsks[ask.id] == nil {
            knownAsks[ask.id] = ask
            lastActivity = clock.now()
            send(.ask(ask))
        }
        pendingItems = pendingItems.filter { ids.contains("item:\($0.key)") }
    }

    // MARK: - Audio events

    func handleAudioEvent(_ event: TalkAudioEvent) {
        let now = clock.now()
        switch event {
        case .interruptionBegan:
            let reason: TalkPauseReason = system.callActive ? .phoneCall : .interruption
            telemetry.event("interrupted", reason.rawValue, at: now)
            speaker?.stop()
            speechEnded()
            send(.interrupted(reason))
        case .interruptionEnded:
            telemetry.event("interruption_ended", nil, at: now)
            resumeAudio()
        case .routeChanged(let newRoute):
            route = newRoute
            echoMode = audio.echoMode
            telemetry.event("route", "\(Self.name(newRoute)) \(Self.name(echoMode))", at: now)
            // The engine was rebuilt: what was queued is gone. The sentence
            // being said starts again. The VAD starts afresh on the new input.
            engines?.vad.reset()
            if machine.state.isSpeaking { speaker?.respeak() }
        case .mediaServicesReset:
            telemetry.event("media_services_reset", nil, at: now)
        case .engineFailed(let message):
            telemetry.event("audio_failed", message, at: now)
            do {
                try startAudio()
                if machine.state.isSpeaking { speaker?.respeak() }
            } catch {
                errorMessage = message
                send(.failed)
            }
        }
    }

    /// After a call or Siri: start the audio again and carry on.
    private func resumeAudio() {
        guard !released else { return }
        do {
            try startAudio()
            interruptionRetries = 0
            engines?.vad.reset()
            send(.resumed)
        } catch {
            interruptionRetries += 1
            guard interruptionRetries <= 5 else {
                errorMessage = "Talk couldn't get the audio back after the interruption."
                send(.failed)
                return
            }
            _ = scheduler.schedule(after: 1) { [weak self] in self?.resumeAudio() }
        }
    }

    // MARK: - The app and the device

    func systemEvent(_ event: TalkSystemEvent) {
        let now = clock.now()
        switch event {
        case .memoryWarning:
            memoryWarnings += 1
            telemetry.memoryWarning(at: now)
            sampleMemory("memory warning \(memoryWarnings)")
            if memoryWarnings == 1 {
                fastMode = true
                system.unloadWhisper()
            } else {
                speaker?.lookAheadUnits = 1
            }
        case .enteredBackground:
            inBackground = true
            telemetry.event("background", nil, at: now)
            sampleMemory("background")
        case .willEnterForeground:
            inBackground = false
            telemetry.event("foreground", nil, at: now)
            track { [weak self] in await self?.loadWhisperIfRoom() }
        }
    }

    private func sampleMemory(_ note: String?) {
        telemetry.sample(availableMemory: system.availableMemory, thermal: system.thermalState, note: note, at: clock.now())
    }

    // MARK: - Heartbeat

    private func scheduleHeartbeat() {
        heartbeat?.cancel()
        heartbeat = scheduler.schedule(after: 1) { [weak self] in
            guard let self, !self.released else { return }
            self.beat()
            self.scheduleHeartbeat()
        }
    }

    /// Once a second: the session's state, a progress phrase, the end after
    /// ten quiet minutes, a memory sample now and then.
    private func beat() {
        refreshSession()
        let now = clock.now()
        let state = machine.state
        if prefs.speakProgress, state.phase == .agentWorking, now - lastSpokeAt >= Self.progressInterval,
           now - lastProgressAt >= Self.progressInterval {
            lastProgressAt = now
            progressSerial += 1
            send(.reply([SpeechUnit.standalone(SpokenPrompts.stillWorking(voice), name: "progress-\(progressSerial)",
                                               language: voice.language)]))
        }
        let quiet = !state.agentRunning && !awaitingBackground && backgroundOutstanding == 0 && state.ask == nil
            && !state.isSpeaking && !state.userHasFloor
        if quiet, state.isActive, now - lastActivity >= Self.inactivityLimit {
            telemetry.event("inactive_end", nil, at: now)
            end()
            return
        }
        if now - lastMemorySample >= 60 {
            lastMemorySample = now
            sampleMemory(nil)
        }
    }

    // MARK: - The sheet's state

    private func syncUI() {
        let state = machine.state
        phase = state.phase
        if speaksHebrew != state.voice.isHebrew { speaksHebrew = state.voice.isHebrew }
        ask = state.ask
        handsFree = state.handsFree
        mute = hardMuted ? .hard : (state.muted ? .soft : .none)
        if released {
            status = errorMessage.map { .failed($0) } ?? .ended
            return
        }
        switch state.phase {
        case .off: status = .starting
        case .preparing: status = .starting
        case .listening: status = .listening
        case .hearing, .deciding: status = .hearing
        case .finalizing, .routing: status = .thinking
        case .agentWorking: status = .working
        case .speaking: status = .speaking
        case .asking: status = .asking
        case .confirmingCancel: status = .confirmingCancel
        case .paused(let reason): status = .paused(reason)
        case .ending:
            status = errorMessage.map { .failed($0) } ?? .ended
        }
    }

    private func unmute() {
        if hardMuted {
            hardMuted = false
            audio.setInputMuted(false)
        }
        send(.setMuted(false))
    }

    private func apply(settings fetched: TalkSettings) {
        settings = fetched
        telemetry.settings.language = fetched.language.rawValue
        telemetry.settings.address = fetched.address.rawValue
        let resolved = Self.voice(fetched, lastHeardHebrew: lastHeardHebrew)
        if resolved != voice {
            voice = resolved
            send(.setVoice(resolved))
        }
    }

    private var nowPlayingTitle: String {
        title.isEmpty ? "Talk" : "Talk · \(title)"
    }

    /// Keep a task until it finishes (``drain()`` waits for them).
    private func track(_ work: @escaping @MainActor () async -> Void) {
        taskSerial += 1
        let serial = taskSerial
        tasks[serial] = Task { @MainActor [weak self] in
            await work()
            self?.tasks[serial] = nil
        }
    }

    /// Wait until the work started so far (and what it starts) is done.
    /// Tests use it to settle after an event.
    func drain() async {
        for _ in 0..<200 {
            if let task = tasks.values.first {
                await task.value
                continue
            }
            for _ in 0..<8 { await Task.yield() }
            if tasks.isEmpty { return }
        }
    }

    #if DEBUG
    /// The sheet's states for the screenshot tests, without a microphone.
    enum ScreenshotState: String, CaseIterable {
        case listening, hearing, speaking, asking, background, softMuted, error
    }

    func showForScreenshot(_ shot: ScreenshotState) {
        started = true
        title = "Fix the flaky build"
        naturalVoice = true
        speaksHebrew = true
        heardText = ""
        heardIsFinal = false
        spokenLog = []
        currentSpokenID = nil
        ask = nil
        mute = .none
        backgroundOutstanding = 0
        awaitingBackground = false
        fastMode = false
        errorMessage = nil
        canReportCutOff = false
        inputLevel = 0
        outputLevel = 0
        let lines = [
            SpokenLine(id: SpeechUnit.ID(reply: "t1", index: 0), text: "בדקתי את הלוגים של ה-CI."),
            SpokenLine(id: SpeechUnit.ID(reply: "t1", index: 1), text: "הבדיקות של ה-API נופלות כי חסר משתנה סביבה."),
            SpokenLine(id: SpeechUnit.ID(reply: "t1", index: 2), text: "שמתי את השגיאה על המסך."),
        ]
        switch shot {
        case .listening:
            status = .listening
            phase = .listening
            inputLevel = 0.08
            heardText = "תבדוק למה הבילד נופל"
            heardIsFinal = true
            spokenLog = lines
        case .hearing:
            status = .hearing
            phase = .hearing
            inputLevel = 0.7
            heardText = "תוסיף את המשתנה ל-staging ותריץ שוב"
        case .speaking:
            status = .speaking
            phase = .speaking(ducked: false)
            outputLevel = 0.6
            heardText = "תבדוק למה הבילד נופל"
            heardIsFinal = true
            spokenLog = lines
            currentSpokenID = lines[1].id
            canReportCutOff = true
        case .asking:
            let options = [PermissionOption(optionId: "allow", name: "Allow", kind: "allow_once"),
                           PermissionOption(optionId: "always", name: "Always allow", kind: "allow_always"),
                           PermissionOption(optionId: "deny", name: "Reject", kind: "reject_once")]
            let asked = TalkAsk(id: "permission:r1", source: .permission(requestId: "r1"), kind: .permission,
                                channel: .permissionOption, prompt: "אני רוצה למחוק את תיקיית הבילד. לאשר?",
                                voice: .hebrew(.masculine), choices: SpokenPrompts.permissionChoices(options))
            status = .asking
            phase = .asking(asked, attempt: 0)
            ask = asked
            spokenLog = [SpokenLine(id: SpeechUnit.ID(reply: "ask:r1", index: 0), text: asked.prompt)]
            currentSpokenID = nil
        case .background:
            status = .working
            phase = .agentWorking
            backgroundOutstanding = 2
            awaitingBackground = true
            fastMode = true
            heardText = "תריץ את כל הבדיקות ברקע"
            heardIsFinal = true
            spokenLog = [SpokenLine(id: SpeechUnit.ID(reply: "t2", index: 0), text: "אני מתחיל לעבוד על זה ברקע."),
                         SpokenLine(id: SpeechUnit.ID(reply: "t2:background", index: 0), text: "העבודה ממשיכה ברקע.")]
        case .softMuted:
            status = .listening
            phase = .listening
            mute = .soft
            spokenLog = lines
        case .error:
            errorMessage = "Talk couldn't start the microphone: a call is using the audio."
            status = .failed(errorMessage!)
            phase = .off
        }
    }
    #endif

    // MARK: - Helpers

    /// Speech from the session (not a line Talk says itself).
    static func isAgentSpeech(_ unit: SpeechUnit) -> Bool {
        let reply = unit.id.reply
        let own = ["confirm-cancel", "not-cancelled", "cancelled", "left-on-screen"]
        return !reply.hasPrefix("ask:") && !reply.hasPrefix("progress-") && !own.contains(reply)
    }

    private static func voice(_ settings: TalkSettings?, lastHeardHebrew: Bool?) -> TalkVoice {
        TalkVoice.resolve(language: settings?.language.rawValue, address: settings?.address.rawValue,
                          lastHeardHebrew: lastHeardHebrew)
    }

    private static func feedLanguage(_ settings: TalkSettings?) -> SpeechUnit.Language {
        switch settings?.language {
        case .hebrew?: .hebrew
        case .english?: .english
        default: .auto
        }
    }

    static func earcon(_ cue: TalkCue) -> Earcon {
        switch cue {
        case .listening: .listening
        case .gotIt: .gotIt
        case .error: .error
        }
    }

    static func name(_ route: TalkRoute) -> String {
        switch route {
        case .builtIn: "builtIn"
        case .bluetoothHFP: "bluetoothHFP"
        case .wired: "wired"
        case .other: "other"
        }
    }

    static func name(_ echo: TalkEchoMode) -> String {
        switch echo {
        case .echoCancelledInput: "echoCancelledInput"
        case .voiceProcessing: "voiceProcessing"
        case .none: "none"
        }
    }

    static func name(_ route: SpokenSendRoute) -> String {
        switch route {
        case .prompt: "prompt"
        case .insert: "insert"
        case .queued: "queued"
        }
    }

    static func name(_ action: TalkAction) -> String {
        switch action {
        case .sendSpoken: "sendSpoken"
        case .respondPermission: "respondPermission"
        case .answerQuestion: "answerQuestion"
        case .answerPlan: "answerPlan"
        case .askNext: "askNext"
        case .stopSpeech: "stopSpeech"
        case .repeatLast: "repeatLast"
        case .continueSpeech: "continueSpeech"
        case .skip: "skip"
        case .mute: "mute"
        case .endTalk: "endTalk"
        case .askConfirmCancel: "askConfirmCancel"
        case .cancelAgent: "cancelAgent"
        case .keepAgent: "keepAgent"
        case .reAsk: "reAsk"
        case .leaveOnScreen: "leaveOnScreen"
        case .wait: "wait"
        case .ignore: "ignore"
        }
    }
}

// MARK: - SessionTalkObserver

extension TalkController: SessionTalkObserver {
    func talkLiveText(turnID: String, text: String, isStreaming: Bool) {
        if replaying {
            feed.start(liveTurnID: turnID, liveText: text, backgroundTurns: [])
            return
        }
        guard started, !released else { return }
        let units = feed.liveText(turnID: turnID, text: text, isStreaming: isStreaming)
        if !text.isEmpty { telemetry.reply(firstToken: clock.now()) }
        lastActivity = clock.now()
        deliver(units)
        refreshSession()
    }

    func talkTurnEnded(turnID: String, stopReason: String?) {
        guard started, !released, !replaying else { return }
        deliver(feed.turnEnded(turnID: turnID, stopReason: stopReason))
        refreshSession()
    }

    func talkAwaitingBackground(_ awaiting: Bool) {
        if replaying {
            _ = feed.awaitingBackground(awaiting)
            return
        }
        guard started, !released else { return }
        deliver(feed.awaitingBackground(awaiting))
        refreshSession()
    }

    func talkBackgroundTurns(_ turns: [MessageTurn]) {
        guard started, !released else { return }
        // Turns written before Talk started were read on the screen.
        let earlier = turns.filter {
            !feed.follows(backgroundTurn: $0.id) && $0.timestamp < startedWallClock.addingTimeInterval(-5)
        }
        feed.takeAsHeard(backgroundTurns: earlier)
        lastActivity = clock.now()
        deliver(feed.backgroundTurns(turns))
    }

    func talkPendingChanged() {
        pendingChanged()
    }
}

// MARK: - Lock Screen and AirPods

extension TalkController: TalkRemoteTarget {
    func remoteToggleMute() {
        if mute == .none { send(.setMuted(true)) } else { unmute() }
    }

    func remoteSetMuted(_ muted: Bool) {
        if muted {
            guard mute == .none else { return }
            send(.setMuted(true))
        } else {
            unmute()
        }
    }

    func remoteStopSpeech() {
        tapOrb()
    }

    func remoteRepeat() {
        send(.perform(.repeatLast))
    }
}
