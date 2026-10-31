import Foundation

struct BargeInConfig: Equatable, Sendable {
    /// "Interrupt by speaking"; off, only a tap or the Camera Control
    /// interrupts.
    var enabled = true
    var frameDuration: TimeInterval = 0.032
    /// Interrupting is possible this long into each sentence.
    var armDelay: TimeInterval = 0.25
    /// A candidate is speech at this probability…
    var speechThreshold: Float = 0.5
    /// …held this long…
    var candidateDuration: TimeInterval = 0.3
    /// …at least this many times as loud as the noise floor.
    var floorMultiplier: Float = 2
    /// The speech volume while a candidate is checked.
    var duckVolume: Float = 0.12
    /// A candidate is confirmed within this long, or the volume comes back.
    var confirmWindow: TimeInterval = 1.5
    /// Confirmed by at least this many words…
    var minWords = 2
    /// …(or one stop word), fewer than this share of which were in the
    /// sentence being spoken or the one before (echo).
    var maxEchoShare: Double = 0.6
    /// After speech, new speech must wait this long…
    var postSpeechGate: TimeInterval = 0.6
    /// …unless it is this many times as loud as the noise floor.
    var postSpeechGateMultiplier: Float = 3
    /// The noise floor is a percentile of the RMS of the non-speech frames
    /// in this window before the speech starts.
    var noiseWindow: TimeInterval = 3
    var noisePercentile: Double = 0.2
    /// The floor before any quiet frame was heard.
    var defaultFloor: Float = 0.003

    static let standard = BargeInConfig()
}

/// What the barge-in policy decided.
enum BargeInDecision: Equatable, Sendable {
    /// Someone may be talking over the speech: duck it.
    case candidate
    /// They are: stop the speech (keep the rest) and hear them.
    case confirmed
    /// It was echo or noise: bring the volume back.
    case rejected
}

/// Interrupting the speech by talking over it:
///
/// - armed 250 ms into each sentence;
/// - a candidate is p ≥ 0.5 for 300 ms with RMS at least twice the noise
///   floor (the 20th-percentile RMS of the non-speech frames in the 3 s
///   before the speech started); the speech ducks;
/// - it is confirmed within 1.5 s when a fresh live transcript of it holds
///   at least 2 words, or a stop word, fewer than 60% of which were in the
///   sentence being spoken or the one before;
/// - after the speech, new speech waits 600 ms unless it is three times as
///   loud as the floor.
///
/// Pure: the caller feeds every microphone frame, the speech's progress and
/// the candidate's transcript.
struct BargeInPolicy: Sendable {
    enum Phase: Equatable, Sendable {
        /// Nothing is being spoken.
        case quiet
        case speaking
        /// A candidate is being checked (the speech is ducked).
        case candidate(since: TimeInterval)
    }

    var config: BargeInConfig
    private(set) var phase: Phase = .quiet
    /// The noise floor the current speech is checked against.
    private(set) var noiseFloor: Float
    /// Where the candidate's speech began: the start of its audio for the
    /// fresh transcript and for the utterance once confirmed.
    private(set) var candidateStart: TimeInterval?

    private var quietFrames: [(time: TimeInterval, rms: Float)] = []
    private var sentenceStart: TimeInterval = 0
    private var currentSentence: Set<String> = []
    private var previousSentence: Set<String> = []
    private var run = 0
    private var runStart: TimeInterval = 0
    private var gateUntil: TimeInterval?

    init(config: BargeInConfig = .standard) {
        self.config = config
        self.noiseFloor = config.defaultFloor
    }

    // MARK: - Speech

    /// The speech starts: the floor comes from the quiet just before it.
    mutating func speechStarted(at time: TimeInterval) {
        let window = quietFrames.filter { $0.time >= time - config.noiseWindow }.map(\.rms).sorted()
        if !window.isEmpty {
            let index = min(window.count - 1, Int((Double(window.count - 1) * config.noisePercentile).rounded()))
            noiseFloor = max(window[index], 1e-6)
        }
        phase = .speaking
        run = 0
        gateUntil = nil
        previousSentence = []
        currentSentence = []
    }

    /// A unit starts playing.
    mutating func sentenceStarted(_ text: String, at time: TimeInterval) {
        if phase == .quiet { speechStarted(at: time) }
        previousSentence = currentSentence
        currentSentence = Self.keys(text)
        sentenceStart = time
        if case .speaking = phase { run = 0 }
    }

    /// The speech ended or was stopped. The gate holds new speech for a
    /// moment, unless a candidate was being checked (then it is the person).
    mutating func speechEnded(at time: TimeInterval) {
        if case .candidate = phase {
            gateUntil = nil
        } else if phase == .speaking {
            gateUntil = time + config.postSpeechGate
        }
        phase = .quiet
        run = 0
        candidateStart = nil
    }

    // MARK: - Frames

    /// Every microphone frame. While nothing is spoken it only learns the
    /// noise floor.
    mutating func frame(probability p: Float, rms: Float, at time: TimeInterval) -> BargeInDecision? {
        switch phase {
        case .quiet:
            if p < config.speechThreshold {
                quietFrames.append((time, rms))
                let oldest = time - config.noiseWindow
                if let first = quietFrames.first, first.time < oldest {
                    quietFrames.removeAll { $0.time < oldest }
                }
            }
            return nil
        case .speaking:
            guard config.enabled, time >= sentenceStart + config.armDelay - 1e-9,
                  p >= config.speechThreshold, rms >= config.floorMultiplier * noiseFloor else {
                run = 0
                return nil
            }
            if run == 0 { runStart = time }
            run += 1
            guard time + config.frameDuration - runStart >= config.candidateDuration - 1e-9 else { return nil }
            run = 0
            phase = .candidate(since: time + config.frameDuration)
            candidateStart = runStart
            return .candidate
        case .candidate(let since):
            if time >= since + config.confirmWindow - 1e-9 {
                phase = .speaking
                candidateStart = nil
                run = 0
                return .rejected
            }
            return nil
        }
    }

    /// The fresh live transcript of the candidate's audio.
    mutating func transcript(_ text: String, at time: TimeInterval) -> BargeInDecision? {
        guard case .candidate(let since) = phase, time < since + config.confirmWindow + 1e-9 else { return nil }
        guard Self.confirms(text, current: currentSentence, previous: previousSentence, config: config) else {
            return nil
        }
        phase = .quiet
        gateUntil = nil
        return .confirmed
    }

    /// Whether speech heard now may open an utterance (the gate after the
    /// speech).
    func allowsSpeechStart(rms: Float, at time: TimeInterval) -> Bool {
        guard let gateUntil, time < gateUntil else { return true }
        return rms >= config.postSpeechGateMultiplier * noiseFloor
    }

    /// Enough words (or a stop word) that aren't an echo of what was said.
    static func confirms(_ text: String, current: Set<String>, previous: Set<String>,
                         config: BargeInConfig = .standard) -> Bool {
        let words = HebrewText.words(text)
        guard !words.isEmpty else { return false }
        let stopWord = words.contains { TalkLexicon.interruptWords.contains($0) }
        guard words.count >= config.minWords || stopWord else { return false }
        let echo = current.union(previous)
        let echoed = words.filter { echo.contains(HebrewText.matchKey($0)) }.count
        return Double(echoed) / Double(words.count) < config.maxEchoShare
    }

    static func keys(_ text: String) -> Set<String> {
        Set(HebrewText.words(text).map(HebrewText.matchKey))
    }
}
