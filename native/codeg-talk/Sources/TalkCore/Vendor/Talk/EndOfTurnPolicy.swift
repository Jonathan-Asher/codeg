import Foundation

/// How long Talk waits before deciding the person finished (Settings ›
/// Voice › Talk › Patience): a multiplier on the silence before committing.
enum TalkPatience: String, CaseIterable, Equatable, Sendable {
    case short
    case normal
    case long

    var multiplier: Double {
        switch self {
        case .short: 0.7
        case .normal: 1.0
        case .long: 1.5
        }
    }
}

/// Smart Turn (a model that guesses from the audio whether a turn ended):
/// off, logged only (shadow), or allowed to commit (active).
enum SmartTurnMode: String, CaseIterable, Equatable, Sendable {
    case off
    case shadow
    case active
}

struct EndOfTurnConfig: Equatable, Sendable {
    /// One VAD frame: 512 samples at 16 kHz.
    var frameDuration: TimeInterval = 0.032
    /// Speech opens at this probability…
    var openThreshold: Float = 0.5
    /// …held for this many frames.
    var openFrames = 2
    /// Audio before the opening kept with the utterance.
    var preRoll: TimeInterval = 0.3
    /// Below this probability a frame is quiet.
    var pauseThreshold: Float = 0.35
    /// Quiet this long is a pause…
    var pauseAfter: TimeInterval = 0.15
    /// …once there was at least this much speech (less is a blip).
    var minSpeechBeforePause: TimeInterval = 0.25
    /// Silence after speech before committing.
    var commitSilence: TimeInterval = 0.8
    /// The same after a dangling last word ("של", "and").
    var danglingCommitSilence: TimeInterval = 1.6
    var patience: TalkPatience = .normal
    var smartTurn: SmartTurnMode = .shadow
    /// Smart Turn's probability that commits at once (active, not dangling).
    var smartTurnThreshold: Float = 0.5
    /// Speech shorter than this is dropped.
    var minUtterance: TimeInterval = 0.3
    /// An utterance is committed at this length.
    var maxUtterance: TimeInterval = 60
    /// The final (Whisper) text is used if it is ready this long after the
    /// commit; otherwise the live text.
    var finalGrace: TimeInterval = 0.5

    static let standard = EndOfTurnConfig()
}

/// Why an utterance was committed.
enum TalkCommitReason: String, Equatable, Sendable {
    case silence
    case smartTurn
    case maxLength
}

/// What the end-of-turn policy decided on a frame. Times are the audio
/// clock's, in seconds.
enum EndOfTurnDecision: Equatable, Sendable {
    /// Speech opened; it started at `at` (keep ``EndOfTurnConfig/preRoll``
    /// before it).
    case speechStarted(at: TimeInterval)
    /// A pause: flush the live transcript and pass it to
    /// ``EndOfTurnPolicy/pauseTranscript(_:)``, start the speculative final
    /// decode, ask Smart Turn.
    case pause(at: TimeInterval)
    /// The person went on speaking after a pause.
    case resumed(at: TimeInterval)
    case commit(at: TimeInterval, reason: TalkCommitReason)
    /// The speech was too short to be an utterance.
    case discard(at: TimeInterval)
}

/// One utterance as the policy saw it, for Talk's telemetry.
struct EndOfTurnTrace: Equatable, Sendable {
    struct Pause: Equatable, Sendable {
        var at: TimeInterval
        /// When the speech before it ended.
        var speechEnd: TimeInterval
        var dangling = false
        var smartTurn: Float?
        var resumed = false
    }

    var startedAt: TimeInterval
    var pauses: [Pause] = []
    var endedAt: TimeInterval?
    var commitReason: TalkCommitReason?
    var discarded = false
    /// Smart Turn's shadow verdict at the last pause: it would have
    /// committed (≥ threshold and not dangling) before the silence did.
    var smartTurnWouldCommit: Bool?
}

/// When the person has finished speaking, from 32 ms speech probabilities:
///
/// - speech opens at p ≥ 0.5 held for 2 frames;
/// - a pause is p < 0.35 for 150 ms after at least 250 ms of speech;
/// - the utterance commits after 800 ms of silence (1,600 ms after a
///   dangling last word), times the patience (0.7, 1.0 or 1.5);
/// - active Smart Turn at ≥ 0.5 commits at once unless the last word dangles
///   (shadow mode only records it);
/// - under 300 ms of speech is dropped, and 60 s commits.
///
/// Pure: the caller feeds frames and the transcript, and acts on the
/// decisions.
struct EndOfTurnPolicy: Sendable {
    enum Phase: Equatable, Sendable {
        case idle
        case speaking
        case paused
    }

    var config: EndOfTurnConfig
    private(set) var phase: Phase = .idle
    /// The utterance in progress (or the last one, once it ended).
    private(set) var trace: EndOfTurnTrace?

    private var openRun = 0
    private var openRunStart: TimeInterval = 0
    private var start: TimeInterval = 0
    private var speechEnd: TimeInterval = 0
    private var quietStart: TimeInterval?
    private var dangling = false

    init(config: EndOfTurnConfig = .standard) {
        self.config = config
    }

    /// When a pause commits if nothing else happens (nil unless paused).
    var commitDeadline: TimeInterval? {
        guard phase == .paused else { return nil }
        let silence = dangling ? config.danglingCommitSilence : config.commitSilence
        return speechEnd + silence * config.patience.multiplier
    }

    /// The speech heard so far in the utterance.
    var speechDuration: TimeInterval { phase == .idle ? 0 : speechEnd - start }

    /// Where the utterance's audio begins, pre-roll included.
    var utteranceStart: TimeInterval? { phase == .idle ? nil : max(0, start - config.preRoll) }

    mutating func reset() {
        phase = .idle
        openRun = 0
        quietStart = nil
        dangling = false
    }

    /// Start an utterance that began without the opening (talking over the
    /// speech: it began at the barge-in candidate, and speech was heard until
    /// `speechUntil`). Pauses and the commit then follow as usual.
    mutating func begin(at start: TimeInterval, speechUntil: TimeInterval) {
        phase = .speaking
        self.start = start
        speechEnd = max(start, speechUntil)
        quietStart = nil
        openRun = 0
        dangling = false
        trace = EndOfTurnTrace(startedAt: start)
    }

    /// One frame covering `[time, time + frameDuration)`.
    mutating func frame(probability p: Float, at time: TimeInterval) -> EndOfTurnDecision? {
        let end = time + config.frameDuration
        switch phase {
        case .idle:
            guard let opened = opening(p, at: time) else { return nil }
            phase = .speaking
            start = opened
            speechEnd = end
            quietStart = nil
            dangling = false
            trace = EndOfTurnTrace(startedAt: opened)
            return .speechStarted(at: opened)
        case .speaking:
            if end - start >= config.maxUtterance { return commit(at: end, reason: .maxLength) }
            if p < config.pauseThreshold {
                let quiet = quietStart ?? time
                quietStart = quiet
                guard end - quiet >= config.pauseAfter - 1e-9 else { return nil }
                if speechEnd - start < config.minSpeechBeforePause { return discard(at: end) }
                phase = .paused
                openRun = 0
                trace?.pauses.append(EndOfTurnTrace.Pause(at: end, speechEnd: speechEnd))
                return .pause(at: end)
            }
            quietStart = nil
            speechEnd = end
            return nil
        case .paused:
            if end - start >= config.maxUtterance { return commit(at: end, reason: .maxLength) }
            if opening(p, at: time) != nil {
                phase = .speaking
                speechEnd = end
                quietStart = nil
                dangling = false
                if var last = trace?.pauses.popLast() {
                    last.resumed = true
                    trace?.pauses.append(last)
                }
                return .resumed(at: time)
            }
            if let deadline = commitDeadline, end >= deadline - 1e-9 {
                return commit(at: end, reason: .silence)
            }
            return nil
        }
    }

    /// The live transcript at a pause: a dangling last word waits longer.
    mutating func pauseTranscript(_ text: String) {
        guard phase == .paused else { return }
        dangling = TalkLexicon.endsDangling(text)
        if var last = trace?.pauses.popLast() {
            last.dangling = dangling
            trace?.pauses.append(last)
        }
    }

    /// Smart Turn's probability for the current pause. Recorded always; in
    /// active mode a confident verdict commits now unless the last word
    /// dangles.
    mutating func smartTurn(probability: Float?, at time: TimeInterval) -> EndOfTurnDecision? {
        guard phase == .paused, let probability else { return nil }
        let confident = probability >= config.smartTurnThreshold && !dangling
        if var last = trace?.pauses.popLast() {
            last.smartTurn = probability
            trace?.pauses.append(last)
        }
        trace?.smartTurnWouldCommit = confident
        guard config.smartTurn == .active, confident else { return nil }
        return commit(at: time, reason: .smartTurn)
    }

    private mutating func opening(_ p: Float, at time: TimeInterval) -> TimeInterval? {
        guard p >= config.openThreshold else {
            openRun = 0
            return nil
        }
        if openRun == 0 { openRunStart = time }
        openRun += 1
        guard openRun >= config.openFrames else { return nil }
        openRun = 0
        return openRunStart
    }

    private mutating func commit(at time: TimeInterval, reason: TalkCommitReason) -> EndOfTurnDecision {
        if speechEnd - start < config.minUtterance - 1e-9 { return discard(at: time) }
        phase = .idle
        quietStart = nil
        trace?.endedAt = time
        trace?.commitReason = reason
        return .commit(at: time, reason: reason)
    }

    private mutating func discard(at time: TimeInterval) -> EndOfTurnDecision {
        phase = .idle
        quietStart = nil
        trace?.endedAt = time
        trace?.discarded = true
        return .discard(at: time)
    }
}

/// Which text an utterance ends with: the final transcriber's (Whisper,
/// started at the pause) if it is ready within the grace after the commit,
/// else the live transcriber's.
struct FinalTranscriptChoice: Equatable, Sendable {
    enum Source: String, Equatable, Sendable {
        case final
        case live
    }

    struct Result: Equatable, Sendable {
        var text: String
        var source: Source
    }

    let grace: TimeInterval
    private(set) var committedAt: TimeInterval?
    private(set) var liveText: String?
    private(set) var finalText: String?
    private(set) var result: Result?
    /// No final text will come (the model isn't loaded, the app is in the
    /// background, or it failed).
    private var finalUnavailable = false

    init(grace: TimeInterval = EndOfTurnConfig.standard.finalGrace, expectsFinal: Bool = true) {
        self.grace = grace
        self.finalUnavailable = !expectsFinal
    }

    /// When the live text is taken if the final text hasn't come.
    var deadline: TimeInterval? { committedAt.map { $0 + grace } }

    /// The final transcriber finished.
    mutating func finalReady(_ text: String, at time: TimeInterval) -> Result? {
        guard result == nil else { return nil }
        if let committedAt, time > committedAt + grace + 1e-9 { return nil }
        finalText = text
        guard committedAt != nil else { return nil }
        return decide()
    }

    /// The final transcriber won't answer.
    mutating func finalFailed() -> Result? {
        finalUnavailable = true
        guard result == nil, committedAt != nil else { return nil }
        return decide()
    }

    /// The utterance was committed with this live text.
    mutating func committed(liveText text: String, at time: TimeInterval) -> Result? {
        guard committedAt == nil else { return nil }
        committedAt = time
        liveText = text
        if finalText != nil || finalUnavailable { return decide() }
        return nil
    }

    /// The clock moved: past the grace, the live text is used.
    mutating func tick(at time: TimeInterval) -> Result? {
        guard result == nil, let deadline, time >= deadline - 1e-9 else { return nil }
        finalUnavailable = true
        return decide()
    }

    private mutating func decide() -> Result? {
        let final = finalText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let live = liveText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !final.isEmpty {
            result = Result(text: final, source: .final)
        } else if finalText != nil || finalUnavailable {
            result = Result(text: live, source: .live)
        } else {
            return nil
        }
        return result
    }
}
