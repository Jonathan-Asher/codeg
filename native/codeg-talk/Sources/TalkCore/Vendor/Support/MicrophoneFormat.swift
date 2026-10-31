import AVFoundation

/// A format's sample rate and channel count: all the microphone checks need.
struct AudioFormatShape: Equatable, Sendable {
    let sampleRate: Double
    let channelCount: UInt32

    init(sampleRate: Double, channelCount: UInt32) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
    }

    init(_ format: AVAudioFormat) {
        self.init(sampleRate: format.sampleRate, channelCount: format.channelCount)
    }

    var isUsable: Bool { sampleRate > 0 && sampleRate.isFinite && channelCount > 0 }
}

/// Whether the input node's formats can take a tap, checked before
/// `installTap`, which raises (and used to end the app) when they can't.
///
/// `hardware` is the node's input side (`inputFormat(forBus: 0)`), `output`
/// the format the tap would get (`outputFormat(forBus: 0)`), `session` what
/// `AVAudioSession` reports for the route now. A long-lived engine keeps the
/// formats it saw the last time it ran; after read aloud, a video or AirPods
/// switching profile changed the route, they no longer match the hardware and
/// `installTap` raises. The recorder therefore builds a fresh engine for
/// every cold start, and this check catches what is left: a route still
/// settling as the session activates.
enum MicrophoneFormatCheck: Equatable {
    /// Install the tap with the output format.
    case ready
    /// No usable input: don't call `installTap`.
    case unavailable(Problem)

    enum Problem: Equatable {
        /// The session reports no input (none connected, or the category has none).
        case noInput
        /// A format with no sample rate or no channels.
        case emptyFormat
        /// The node's input and output sides disagree: the route changed
        /// while the engine was being set up.
        case formatChanging
    }

    static func evaluate(hardware: AudioFormatShape, output: AudioFormatShape,
                         inputAvailable: Bool) -> MicrophoneFormatCheck {
        guard inputAvailable else { return .unavailable(.noInput) }
        guard hardware.isUsable, output.isUsable else { return .unavailable(.emptyFormat) }
        // The input node converts channels and sample format, never the rate.
        guard abs(hardware.sampleRate - output.sampleRate) < 1 else { return .unavailable(.formatChanging) }
        return .ready
    }

    /// The session's rate disagrees with what a reused engine's node says:
    /// that node's formats are stale.
    static func isStale(node: AudioFormatShape, sessionSampleRate: Double) -> Bool {
        sessionSampleRate > 0 && node.sampleRate > 0 && abs(node.sampleRate - sessionSampleRate) >= 1
    }
}
