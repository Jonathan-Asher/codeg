import Foundation

/// The last stretch of microphone audio, by capture time: where an utterance
/// takes its pre-roll from (the words said before speech was detected, a
/// voice that talked over the speech, push to talk's 1.5 s).
struct TalkAudioRing: Sendable {
    /// Seconds kept.
    let capacity: TimeInterval
    private var frames: [MicFrame] = []
    private var head = 0

    init(capacity: TimeInterval = 30) {
        self.capacity = capacity
    }

    var isEmpty: Bool { head >= frames.count }

    /// The capture time of the newest frame's end.
    var end: TimeInterval? {
        frames.last.map { $0.time + Self.duration(of: $0) }
    }

    /// The capture time of the newest frame.
    var lastFrameTime: TimeInterval? { frames.last?.time }

    mutating func append(_ frame: MicFrame) {
        frames.append(frame)
        let oldest = frame.time - capacity
        while head < frames.count, frames[head].time < oldest { head += 1 }
        if head > 2048 {
            frames.removeFirst(head)
            head = 0
        }
    }

    mutating func removeAll() {
        frames = []
        head = 0
    }

    /// The samples of every frame that ends after `start`, in order.
    func samples(from start: TimeInterval) -> [Float] {
        var out: [Float] = []
        var index = frames.count
        while index > head, frames[index - 1].time + Self.duration(of: frames[index - 1]) > start { index -= 1 }
        for frame in frames[index...] { out.append(contentsOf: frame.samples) }
        return out
    }

    static func duration(of frame: MicFrame) -> TimeInterval {
        Double(frame.samples.count) / MicFrameAssembler.sampleRate
    }
}

/// An utterance being heard: its audio from where it began (pre-roll
/// included) and the transcript so far.
struct TalkUtterance: Sendable {
    let id: Int
    let start: TalkUtteranceStart
    /// Capture time where its audio begins.
    let audioStart: TimeInterval
    /// 16 kHz mono from `audioStart` on.
    var audio: [Float]
    /// The newest frame its audio (and the live transcriber) has.
    var fedThrough: TimeInterval
    /// The live transcript so far.
    var partial = ""
    /// When it was committed (capture time).
    var committedAt: TimeInterval?
    /// Which text it ends with.
    var choice: FinalTranscriptChoice
    /// The live transcriber's final text, once back.
    var liveText: String?
    /// whisper's text, once back.
    var finalText: String?

    var seconds: TimeInterval { Double(audio.count) / MicFrameAssembler.sampleRate }

    /// Its last `seconds` of audio.
    func tail(_ seconds: TimeInterval) -> [Float] {
        let count = Int(seconds * MicFrameAssembler.sampleRate)
        return audio.count <= count ? audio : Array(audio.suffix(count))
    }
}

/// Talk's mute: said ("השתק", or an AirPods stem press), which keeps
/// listening on this iPhone for "unmute" and "end" and sends nothing; or the
/// Mute button, which stops the microphone until it is tapped again.
enum TalkMute: String, Equatable, Sendable {
    case none
    case soft
    case hard
}
