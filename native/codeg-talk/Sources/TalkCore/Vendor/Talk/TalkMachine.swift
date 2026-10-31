import Foundation

/// Why Talk is paused.
enum TalkPauseReason: String, Equatable, Sendable {
    case phoneCall
    case siri
    case interruption
}

/// The short sounds Talk plays.
enum TalkCue: String, Equatable, Sendable {
    /// Talk is listening (started, unmuted, resumed).
    case listening
    /// The utterance was taken.
    case gotIt
    case error
}

enum TalkTimer: String, Equatable, Hashable, Sendable {
    /// No answer to "cancel the agent?" means no.
    case cancelConfirmation

    var seconds: TimeInterval {
        switch self {
        case .cancelConfirmation: 8
        }
    }
}

/// How an utterance began.
enum TalkUtteranceStart: Equatable, Sendable {
    /// Voice detection opened (hands-free).
    case speech
    /// The person talked over the speech: the utterance starts with the
    /// barge-in candidate's audio.
    case bargeIn
    /// Push to talk (1.5 s of pre-roll).
    case pushToTalk
}

/// What the integration does for the machine. Abstract: the controller maps
/// these to the audio engine, the speech models and the session.
enum TalkEffect: Equatable, Sendable {
    /// Load the engines and claim the audio session.
    case prepare
    /// Stop everything and release the audio session (Talk is ending).
    case release
    case startListening(handsFree: Bool)
    case stopListening
    /// Muted: only "unmute" and "end" are listened for.
    case micMuted(Bool)
    case beginUtterance(TalkUtteranceStart)
    case cancelUtterance
    /// Start the final (Whisper) decode of the utterance so far.
    case startFinalDecode
    case cancelFinalDecode
    /// The utterance is complete: end it and produce its final text.
    case commitUtterance
    /// Route this final text (``TalkRouter``) and send back `.routed`.
    case route(String)
    /// Append to what is being spoken.
    case speak([SpeechUnit])
    /// Lower the speech to ``BargeInConfig/duckVolume`` (or bring it back).
    /// Stopping or finishing the speech brings it back too.
    case duck(Bool)
    /// Stop speaking now and drop what was handed to the speaker.
    case stopSpeech
    /// Finish the sentence being spoken, then stop.
    case stopSpeechAfterCurrent
    case playCue(TalkCue)
    /// Act on the session.
    case sendAction(TalkAction)
    case startTimer(TalkTimer, seconds: TimeInterval)
    case cancelTimer(TalkTimer)
}

/// What happens to Talk.
enum TalkEvent: Equatable, Sendable {
    // Lifecycle
    case start(handsFree: Bool, voice: TalkVoice)
    /// The engines are loaded and the audio session is Talk's.
    case ready
    case failed
    /// The person ended Talk (button, AirPods, Lock Screen).
    case end
    /// Everything was released.
    case ended
    case interrupted(TalkPauseReason)
    case resumed
    // Controls
    case setMuted(Bool)
    case setHandsFree(Bool)
    case setVoice(TalkVoice)
    case pushToTalk(pressed: Bool)
    /// A tap on the orb (or the Camera Control) while Talk speaks.
    case tapInterrupt
    /// An action from a control instead of words: the Skip button, a choice
    /// button, the AirPods' "previous" (repeat). Speech in progress stops
    /// first (a reply's rest is kept, as when talked over). Ignored while
    /// the person has the floor.
    case perform(TalkAction)
    // Listening (EndOfTurnPolicy)
    case speechStarted
    case pause
    case speechResumed
    case commit
    case discard
    /// The utterance's final text (FinalTranscriptChoice).
    case transcript(String)
    case routed(TalkAction)
    /// The session didn't take an action (a send failed).
    case actionFailed
    // Speaking
    /// Agent speech from ``TalkFeed``.
    case reply([SpeechUnit])
    case unitStarted(SpeechUnit.ID)
    /// Everything handed to the speaker was spoken (or stopped).
    case speechFinished
    // Interrupting (BargeInPolicy)
    case bargeInCandidate
    case bargeInConfirmed
    case bargeInRejected
    // The session
    case agentRunning(Bool)
    /// Something the agent waits on (built with ``SpokenPrompts``).
    case ask(TalkAsk)
    /// It was answered elsewhere, or it is gone.
    case askResolved(id: String)
    case timerFired(TalkTimer)
}

/// Talk's state: the phase, and what waits to be said or answered.
struct TalkState: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case off
        case preparing
        case listening
        /// The person is speaking.
        case hearing
        /// They paused; waiting to see whether they go on.
        case deciding
        /// Committed; waiting for the final text.
        case finalizing
        /// Waiting for the router's decision.
        case routing
        /// The agent is working and has nothing to say yet.
        case agentWorking
        /// Talk is speaking; ducked while a barge-in is checked.
        case speaking(ducked: Bool)
        /// The question was asked; waiting for the answer.
        case asking(TalkAsk, attempt: Int)
        /// "Cancel the agent?" was asked.
        case confirmingCancel
        case paused(TalkPauseReason)
        case ending
    }

    /// Speech that began while the previous utterance was finalized or
    /// routed, and how far it got. It is begun as soon as the routing ends
    /// (the controller keeps its audio meanwhile).
    enum DeferredSpeech: Equatable, Sendable {
        case hearing
        case deciding
        case committed
    }

    /// What the units handed to the speaker are.
    enum Speaking: Equatable, Sendable {
        case reply
        /// An ask's prompt.
        case prompt
        /// A line Talk says itself (a cue, the cancel question).
        case notice
    }

    var phase: Phase = .off
    var muted = false
    var handsFree = true
    var voice: TalkVoice = .hebrew(.neutral)
    var agentRunning = false
    /// Units handed to the speaker and not finished; the first is playing.
    var playing: [SpeechUnit] = []
    var speaking: Speaking = .reply
    /// What was being said when the person talked over it: if nothing came
    /// of the utterance, a reply goes on and a prompt is said again.
    var interrupted: Speaking?
    /// A final text is being routed (its action is applied even if Talk is
    /// paused meanwhile).
    var routePending = false
    var deferredSpeech: DeferredSpeech?
    /// Lines Talk says itself, before anything else.
    var notices: [SpeechUnit] = []
    /// Agent speech waiting its turn.
    var queued: [SpeechUnit] = []
    /// Speech that was stopped, for "continue".
    var held: [SpeechUnit] = []
    /// The latest reply, for "repeat" (its last 20 units).
    var lastReply: [SpeechUnit] = []
    /// Replies the person stopped or skipped: more of them is held (or
    /// dropped) until they say or answer something.
    var stoppedReplies: Set<String> = []
    var skippedReplies: Set<String> = []
    /// The item being asked, how many times it was asked again, and
    /// whether its prompt was said.
    var ask: TalkAsk?
    var askAttempt = 0
    var askSpoken = false
    /// Items waiting behind it.
    var waitingAsks: [TalkAsk] = []
    /// Items left on the screen (or announced there): not asked by voice.
    var onScreen: Set<String> = []
    var confirmingCancel = false

    /// The most units kept for "repeat".
    static let repeatLimit = 20

    var isActive: Bool {
        switch phase {
        case .off, .ending: false
        default: true
        }
    }

    /// The person has the floor: agent speech waits.
    var userHasFloor: Bool {
        switch phase {
        case .hearing, .deciding, .finalizing, .routing: true
        default: false
        }
    }

    var isSpeaking: Bool {
        if case .speaking = phase { return true }
        return false
    }

    /// What the router needs for the utterance being routed. An ask counts
    /// once its prompt was said (or begun): words that started before it
    /// are for the session.
    var routeContext: TalkRouteContext {
        TalkRouteContext(ask: askSpoken ? ask : nil, askAttempt: askAttempt, speechHeld: !held.isEmpty,
                         confirmingCancel: confirmingCancel, muted: muted)
    }
}

/// Talk's conversation logic as a pure reducer: `(state, event) → (state,
/// effects)`. It never touches audio, models or the network.
///
/// - The agent's speech waits while the person has the floor.
/// - Something the agent waits on takes over after the sentence being
///   spoken; the rest of the reply is kept for "continue".
/// - Muted, only "unmute" and "end" are acted on.
struct TalkMachine: Sendable {
    private(set) var state: TalkState

    init(state: TalkState = TalkState()) {
        self.state = state
    }

    mutating func handle(_ event: TalkEvent) -> [TalkEffect] {
        let (next, effects) = Self.reduce(state, event)
        state = next
        return effects
    }

    static func reduce(_ state: TalkState, _ event: TalkEvent) -> (TalkState, [TalkEffect]) {
        var reducer = Reducer(state: state)
        reducer.handle(event)
        return (reducer.state, reducer.effects)
    }
}

private struct Reducer {
    var state: TalkState
    var effects: [TalkEffect] = []

    private mutating func emit(_ effect: TalkEffect) { effects.append(effect) }

    private var running: Bool {
        switch state.phase {
        case .off, .ending, .preparing, .paused: false
        default: true
        }
    }

    mutating func handle(_ event: TalkEvent) {
        switch event {
        case .start(let handsFree, let voice):
            guard state.phase == .off else { return }
            state = TalkState(phase: .preparing, handsFree: handsFree, voice: voice)
            emit(.prepare)

        case .ready:
            guard state.phase == .preparing else { return }
            state.phase = .listening
            emit(.startListening(handsFree: state.handsFree))
            if state.muted { emit(.micMuted(true)) }
            emit(.playCue(.listening))
            settle()

        case .failed:
            guard state.isActive else { return }
            end(cue: .error)

        case .end:
            guard state.isActive else { return }
            end(cue: nil)

        case .ended:
            guard state.phase == .ending else { return }
            state = TalkState(handsFree: state.handsFree, voice: state.voice)

        case .interrupted(let reason):
            guard running else { return }
            if state.isSpeaking { stopSpeaking(holding: true) }
            // An utterance being routed still counts; one being heard doesn't.
            if state.phase != .routing { dropUtterance() }
            state.deferredSpeech = nil
            emit(.stopListening)
            state.phase = .paused(reason)

        case .resumed:
            guard case .paused = state.phase else { return }
            state.phase = .listening
            emit(.startListening(handsFree: state.handsFree))
            emit(.playCue(.listening))
            settle()

        case .setMuted(let muted):
            setMuted(muted)
            if running, !state.userHasFloor, !state.isSpeaking { settle() }

        case .setHandsFree(let handsFree):
            guard state.handsFree != handsFree else { return }
            state.handsFree = handsFree
            guard running else { return }
            emit(.startListening(handsFree: handsFree))
            state.deferredSpeech = nil
            if state.phase == .hearing || state.phase == .deciding {
                dropUtterance()
                state.phase = .listening
                settle()
            }

        case .setVoice(let voice):
            state.voice = voice

        case .pushToTalk(let pressed):
            guard running else { return }
            if pressed {
                guard !state.userHasFloor else { return }
                if state.isSpeaking { stopSpeaking(holding: true) }
                state.phase = .hearing
                emit(.beginUtterance(.pushToTalk))
            } else if state.phase == .hearing || state.phase == .deciding {
                commit()
            }

        case .tapInterrupt:
            guard state.isSpeaking else { return }
            stopSpeaking(holding: true)
            if state.speaking == .prompt { state.askSpoken = true }
            state.phase = .listening
            settle()

        case .perform(let action):
            guard running, !state.userHasFloor else { return }
            if state.isSpeaking {
                let kind = state.speaking
                stopSpeaking(holding: true)
                if kind == .prompt { state.askSpoken = true }
            }
            apply(action)

        case .speechStarted:
            guard state.handsFree else { return }
            switch state.phase {
            case .listening, .agentWorking, .asking, .confirmingCancel:
                state.phase = .hearing
                emit(.beginUtterance(.speech))
            case .finalizing, .routing:
                state.deferredSpeech = .hearing
            default:
                break
            }

        case .pause:
            if state.phase == .hearing {
                state.phase = .deciding
                emit(.startFinalDecode)
            } else if state.deferredSpeech == .hearing {
                state.deferredSpeech = .deciding
            }

        case .speechResumed:
            if state.phase == .deciding {
                state.phase = .hearing
                emit(.cancelFinalDecode)
            } else if state.deferredSpeech == .deciding {
                state.deferredSpeech = .hearing
            }

        case .commit:
            if state.phase == .hearing || state.phase == .deciding {
                commit()
            } else if state.deferredSpeech == .hearing || state.deferredSpeech == .deciding {
                state.deferredSpeech = .committed
            }

        case .discard:
            if state.phase == .hearing || state.phase == .deciding {
                dropUtterance()
                nothingCameOfIt()
            } else if state.deferredSpeech != nil {
                state.deferredSpeech = nil
            }

        case .transcript(let text):
            guard state.phase == .finalizing else { return }
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty else { return nothingCameOfIt() }
            state.phase = .routing
            state.routePending = true
            emit(.route(words))

        case .routed(let action):
            guard state.routePending else { return }
            state.routePending = false
            if case .paused = state.phase {
                applyWhilePaused(action)
            } else if state.phase == .routing {
                apply(action)
            }

        case .actionFailed:
            emit(.playCue(.error))

        case .reply(let units):
            receive(units)

        case .unitStarted(let id):
            guard state.isSpeaking, let index = state.playing.firstIndex(where: { $0.id == id }) else { return }
            state.playing.removeFirst(index)

        case .speechFinished:
            guard state.isSpeaking else { return }
            state.playing = []
            if state.speaking == .prompt { state.askSpoken = true }
            state.phase = .listening
            settle()

        case .bargeInCandidate:
            guard case .speaking(ducked: false) = state.phase, !state.muted, state.handsFree else { return }
            state.phase = .speaking(ducked: true)
            emit(.duck(true))

        case .bargeInRejected:
            guard case .speaking(ducked: true) = state.phase else { return }
            state.phase = .speaking(ducked: false)
            emit(.duck(false))

        case .bargeInConfirmed:
            guard state.isSpeaking, !state.muted, state.handsFree else { return }
            let kind = state.speaking
            stopSpeaking(holding: true)
            if kind == .prompt { state.askSpoken = true }
            state.interrupted = kind
            state.phase = .hearing
            emit(.beginUtterance(.bargeIn))

        case .agentRunning(let isRunning):
            state.agentRunning = isRunning
            if !isRunning, state.phase == .agentWorking { state.phase = .listening }
            if isRunning, state.phase == .listening { state.phase = .agentWorking }

        case .ask(let ask):
            receive(ask)

        case .askResolved(let id):
            state.waitingAsks.removeAll { $0.id == id }
            state.onScreen.remove(id)
            guard state.ask?.id == id else { return }
            let prompting = state.isSpeaking && state.speaking == .prompt
            clearAsk()
            if prompting {
                emit(.stopSpeech)
                state.playing = []
                state.phase = .listening
                settle()
            } else if case .asking = state.phase {
                settle()
            }

        case .timerFired(let timer):
            switch timer {
            case .cancelConfirmation:
                guard state.confirmingCancel, !state.userHasFloor else { return }
                state.confirmingCancel = false
                say(SpokenPrompts.notCancelled(state.voice), name: "not-cancelled")
                if !state.isSpeaking { settle() }
            }
        }
    }

    // MARK: - Routing

    private mutating func apply(_ action: TalkAction) {
        if action != .ignore { state.interrupted = nil }
        switch action {
        case .sendSpoken:
            emit(.sendAction(action))
            freshStart()
            state.agentRunning = true
        case .respondPermission, .answerQuestion, .answerPlan:
            emit(.sendAction(action))
            clearAsk()
            freshStart()
            state.agentRunning = true
        case .askNext(let next):
            state.ask = next
            state.askAttempt = 0
            state.askSpoken = false
        case .stopSpeech:
            // The speech already stopped to hear this; what came meanwhile
            // (or was waiting) is held for "continue" too.
            for unit in state.queued { state.stoppedReplies.insert(unit.id.reply) }
            holdQueuedStoppedReplies()
        case .repeatLast:
            if state.ask != nil {
                state.askSpoken = false
            } else if let reply = state.lastReply.first?.id.reply {
                state.held.removeAll { $0.id.reply == reply }
                state.queued.removeAll { $0.id.reply == reply }
                state.stoppedReplies.remove(reply)
                state.queued.insert(contentsOf: state.lastReply, at: 0)
            } else {
                emit(.playCue(.error))
            }
        case .continueSpeech:
            let resumed = state.held
            state.held = []
            state.stoppedReplies = []
            state.queued.insert(contentsOf: resumed, at: 0)
        case .skip:
            // The reply being said (stopped to hear this, or next in line)
            // is dropped, with whatever more of it comes.
            state.skippedReplies.formUnion(state.stoppedReplies)
            state.skippedReplies.formUnion(state.held.map(\.id.reply))
            if let next = state.queued.first { state.skippedReplies.insert(next.id.reply) }
            state.stoppedReplies = []
            state.held = []
            state.queued.removeAll { state.skippedReplies.contains($0.id.reply) }
        case .mute(let muted):
            setMuted(muted)
        case .endTalk:
            return end(cue: nil)
        case .askConfirmCancel:
            state.confirmingCancel = true
            emit(.startTimer(.cancelConfirmation, seconds: TalkTimer.cancelConfirmation.seconds))
            say(SpokenPrompts.confirmCancel(state.voice), name: "confirm-cancel")
        case .cancelAgent:
            state.confirmingCancel = false
            emit(.cancelTimer(.cancelConfirmation))
            emit(.sendAction(.cancelAgent))
            state.held = []
            state.queued = []
            state.stoppedReplies = []
            say(SpokenPrompts.cancelled(state.voice), name: "cancelled")
        case .keepAgent:
            state.confirmingCancel = false
            emit(.cancelTimer(.cancelConfirmation))
            say(SpokenPrompts.notCancelled(state.voice), name: "not-cancelled")
        case .reAsk:
            state.askAttempt += 1
            state.askSpoken = false
        case .leaveOnScreen:
            if let ask = state.ask { state.onScreen.insert(ask.id) }
            clearAsk()
            say(SpokenPrompts.leftOnScreen(state.voice), name: "left-on-screen")
        case .wait:
            break
        case .ignore:
            return nothingCameOfIt()
        }
        state.phase = .listening
        if beginDeferredSpeech() { return }
        settle()
    }

    /// The utterance came to nothing: if it interrupted the speech, a reply
    /// goes on and a prompt is said again.
    private mutating func nothingCameOfIt() {
        switch state.interrupted {
        case .reply?:
            let resumed = state.held
            state.held = []
            state.stoppedReplies = []
            state.queued.insert(contentsOf: resumed, at: 0)
        case .prompt?:
            state.askSpoken = false
        case .notice?, nil:
            break
        }
        state.interrupted = nil
        state.phase = .listening
        if beginDeferredSpeech() { return }
        settle()
    }

    /// Speech that began during the routing gets the floor now; true when
    /// it did.
    private mutating func beginDeferredSpeech() -> Bool {
        guard let deferred = state.deferredSpeech else { return false }
        state.deferredSpeech = nil
        guard running else { return false }
        state.phase = .hearing
        emit(.beginUtterance(.speech))
        switch deferred {
        case .hearing:
            break
        case .deciding:
            state.phase = .deciding
            emit(.startFinalDecode)
        case .committed:
            commit()
        }
        return true
    }

    /// A routed utterance whose action lands while Talk is paused: what it
    /// asks of the session still happens; speech waits for the resume.
    private mutating func applyWhilePaused(_ action: TalkAction) {
        state.interrupted = nil
        switch action {
        case .sendSpoken:
            emit(.sendAction(action))
            freshStart()
            state.agentRunning = true
        case .respondPermission, .answerQuestion, .answerPlan:
            emit(.sendAction(action))
            clearAsk()
            freshStart()
            state.agentRunning = true
        case .askNext(let next):
            state.ask = next
            state.askAttempt = 0
            state.askSpoken = false
        case .endTalk:
            end(cue: nil)
        case .mute(let muted):
            state.muted = muted
        default:
            break
        }
    }

    /// A new message or answer: stopped and skipped replies are forgotten,
    /// so what the agent says next is spoken.
    private mutating func freshStart() {
        state.held = []
        state.stoppedReplies = []
        state.skippedReplies = []
        state.interrupted = nil
    }

    private mutating func clearAsk() {
        state.ask = nil
        state.askAttempt = 0
        state.askSpoken = false
    }

    // MARK: - Speaking

    private mutating func receive(_ incoming: [SpeechUnit]) {
        guard state.isActive else { return }
        var units = incoming.filter { !state.skippedReplies.contains($0.id.reply) }
        for unit in units {
            if unit.isFirstOfReply || state.lastReply.first?.id.reply != unit.id.reply { state.lastReply = [] }
            state.lastReply.append(unit)
        }
        if state.lastReply.count > TalkState.repeatLimit {
            state.lastReply.removeFirst(state.lastReply.count - TalkState.repeatLimit)
        }
        let stopped = units.filter { state.stoppedReplies.contains($0.id.reply) }
        state.held += stopped
        units.removeAll { state.stoppedReplies.contains($0.id.reply) }
        guard !units.isEmpty else { return }
        switch state.phase {
        case .speaking where state.speaking == .reply && state.ask == nil:
            state.playing += units
            emit(.speak(units))
        case .listening, .agentWorking:
            state.queued += units
            settle()
        default:
            state.queued += units
        }
    }

    private mutating func receive(_ ask: TalkAsk) {
        guard state.isActive, !state.onScreen.contains(ask.id) else { return }
        guard ask.answerableByVoice, !ask.isSecret else {
            // Only announced, once.
            state.onScreen.insert(ask.id)
            state.notices.append(ask.promptUnit())
            if !state.isSpeaking, !state.userHasFloor, running { settle() }
            return
        }
        if state.ask?.id == ask.id { return }
        if state.ask != nil {
            if !state.waitingAsks.contains(where: { $0.id == ask.id }) { state.waitingAsks.append(ask) }
            return
        }
        state.ask = ask
        state.askAttempt = 0
        state.askSpoken = false
        switch state.phase {
        case .speaking where state.speaking == .reply:
            // After the sentence being spoken; the rest is kept for "continue".
            let rest = Array(state.playing.dropFirst())
            state.held += rest
            for unit in rest { state.stoppedReplies.insert(unit.id.reply) }
            if let current = state.playing.first { state.stoppedReplies.insert(current.id.reply) }
            state.playing = Array(state.playing.prefix(1))
            emit(.stopSpeechAfterCurrent)
        case .listening, .agentWorking:
            settle()
        default:
            break
        }
    }

    /// Stop the speech now. A reply's rest (from the sentence being spoken)
    /// is kept for "continue", and more of it is held.
    private mutating func stopSpeaking(holding: Bool) {
        emit(.stopSpeech)
        if holding, state.speaking == .reply {
            state.held = state.playing + state.held
            for unit in state.playing { state.stoppedReplies.insert(unit.id.reply) }
        }
        state.playing = []
        holdQueuedStoppedReplies()
    }

    private mutating func holdQueuedStoppedReplies() {
        let stopped = state.queued.filter { state.stoppedReplies.contains($0.id.reply) }
        state.held += stopped
        state.queued.removeAll { state.stoppedReplies.contains($0.id.reply) }
    }

    /// Say a line of Talk's own, before anything else.
    private mutating func say(_ text: String, name: String) {
        state.notices.append(SpeechUnit.standalone(text, name: name, language: state.voice.language))
    }

    private mutating func speak(_ units: [SpeechUnit], as kind: TalkState.Speaking) {
        state.playing = units
        state.speaking = kind
        state.phase = .speaking(ducked: false)
        emit(.speak(units))
    }

    /// The floor is free: say what is due (Talk's own lines, then an ask's
    /// prompt, then queued speech), or rest in the phase that fits.
    private mutating func settle() {
        guard running, !state.userHasFloor, !state.isSpeaking else { return }
        if !state.notices.isEmpty {
            let notices = state.notices
            state.notices = []
            return speak(notices, as: .notice)
        }
        if state.ask == nil, !state.confirmingCancel, !state.waitingAsks.isEmpty {
            state.ask = state.waitingAsks.removeFirst()
            state.askAttempt = 0
            state.askSpoken = false
        }
        if let ask = state.ask, !state.askSpoken, !state.confirmingCancel {
            return speak([ask.promptUnit(attempt: state.askAttempt)], as: .prompt)
        }
        if state.ask == nil, !state.confirmingCancel, !state.queued.isEmpty {
            let units = state.queued
            state.queued = []
            return speak(units, as: .reply)
        }
        if let ask = state.ask {
            state.phase = .asking(ask, attempt: state.askAttempt)
        } else if state.confirmingCancel {
            state.phase = .confirmingCancel
        } else if state.agentRunning {
            state.phase = .agentWorking
        } else {
            state.phase = .listening
        }
    }

    // MARK: - Listening

    private mutating func commit() {
        let speculative = state.phase == .deciding
        state.phase = .finalizing
        if !speculative { emit(.startFinalDecode) }
        emit(.commitUtterance)
        if !state.muted { emit(.playCue(.gotIt)) }
    }

    private mutating func dropUtterance() {
        switch state.phase {
        case .deciding, .finalizing:
            emit(.cancelFinalDecode)
            emit(.cancelUtterance)
        case .hearing:
            emit(.cancelUtterance)
        default:
            break
        }
    }

    private mutating func setMuted(_ muted: Bool) {
        guard state.muted != muted else { return }
        state.muted = muted
        guard running else { return }
        emit(.micMuted(muted))
        if muted {
            state.deferredSpeech = nil
            if state.phase == .hearing || state.phase == .deciding {
                dropUtterance()
                state.phase = .listening
            }
        } else {
            emit(.playCue(.listening))
        }
    }

    private mutating func end(cue: TalkCue?) {
        if state.isSpeaking { emit(.stopSpeech) }
        dropUtterance()
        if state.confirmingCancel { emit(.cancelTimer(.cancelConfirmation)) }
        if let cue { emit(.playCue(cue)) }
        if state.phase != .preparing { emit(.stopListening) }
        emit(.release)
        let handsFree = state.handsFree
        let voice = state.voice
        state = TalkState(phase: .ending, handsFree: handsFree, voice: voice)
    }
}
