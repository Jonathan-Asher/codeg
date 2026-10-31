import AVFAudio
import Accelerate
import Foundation

extension Notification.Name {
    /// Talk is about to set the audio session up for itself. Posted on the
    /// main thread, before the session changes: the Camera Control's
    /// standing-by microphone and read aloud step aside until
    /// ``talkDidReleaseAudio``, as they do for read aloud and session media.
    static let talkWillClaimAudio = Notification.Name("codeg.talk.willClaimAudio")
    /// Talk stopped and let go of the audio session. Main thread.
    static let talkDidReleaseAudio = Notification.Name("codeg.talk.didReleaseAudio")
}

/// 32 ms of microphone audio as Talk's listening reads it.
struct MicFrame: Sendable {
    /// 512 samples, 16 kHz mono.
    let samples: [Float]
    /// The samples' root mean square (linear, 0…1).
    let rms: Float
    /// When the first sample was captured, in seconds on the clock of
    /// `ProcessInfo.systemUptime`.
    let time: TimeInterval
}

/// The kind of audio route Talk runs on.
enum TalkRoute: Sendable, Equatable { case builtIn, bluetoothHFP, wired, other }

/// How Talk keeps its own speech out of the microphone (see ``TalkEchoPolicy``).
enum TalkEchoMode: Sendable, Equatable { case echoCancelledInput, voiceProcessing, none }

/// What happened to Talk's audio.
enum TalkAudioEvent: Sendable {
    /// A call, Siri or an alarm took the audio: the engine stopped.
    case interruptionBegan
    /// It's over; `shouldResume` when iOS says to carry on. Call
    /// ``TalkAudioIO/start(preferring:)`` to resume.
    case interruptionEnded(shouldResume: Bool)
    /// The engine was rebuilt for the route now in use (AirPods in or out, a
    /// configuration change). Speech scheduled before it was dropped.
    case routeChanged(TalkRoute)
    /// The iPhone's audio services restarted; the engine is being rebuilt.
    case mediaServicesReset
    /// The engine stopped and couldn't be started again; the message says why
    /// in plain words.
    case engineFailed(String)
}

/// Short tones Talk plays between turns.
enum Earcon: Sendable { case listening, gotIt, error }

/// Talk's audio: one engine for the microphone and the agent's speech, so
/// echo cancellation sees both. ``TalkAudioEngine`` in the app.
@MainActor
protocol TalkAudioIO: AnyObject {
    /// The microphone, 16 kHz mono, 512 samples a frame, while running.
    var frames: AsyncStream<MicFrame> { get }
    var events: AsyncStream<TalkAudioEvent> { get }
    var route: TalkRoute { get }
    var echoMode: TalkEchoMode { get }
    /// Speech is queued and not yet played to its end.
    var isSpeaking: Bool { get }
    /// Take the audio session and start, preferring `preferring` (the Lab's
    /// override) over ``TalkEchoPolicy``'s choice. Throws when the audio
    /// can't start (see ``AudioErrorText``).
    func start(preferring: TalkEchoMode?) throws
    /// Stop and give the audio session back.
    func stop()
    /// Queue mono speech samples at `sampleRate`. `onPlayed` runs once they
    /// have been heard to the end; never for audio cut off by ``stopSpeech()``,
    /// ``stop()`` or a rebuild, nor when the engine isn't running (then the
    /// samples are dropped).
    func schedule(_ samples: [Float], sampleRate: Double, onPlayed: @escaping @Sendable () -> Void)
    /// Lower the speech while a voice may be interrupting it, or bring it back.
    func duck(_ on: Bool)
    /// Stop the speech now and drop what is queued.
    func stopSpeech()
    func play(_ earcon: Earcon)
    /// The Mute button: no microphone frame comes until it is lifted (the
    /// app's input is muted as well), while the speech goes on playing.
    func setInputMuted(_ muted: Bool)
}

// MARK: - Frames

/// Cuts 16 kHz audio into ``MicFrame``s of 512 samples, keeping the rest for
/// the next chunk. Pure.
struct MicFrameAssembler: Sendable {
    static let frameSamples = 512
    static let sampleRate: Double = 16_000

    private var pending: [Float] = []
    /// When the first pending sample was captured.
    private var pendingStart: TimeInterval = 0

    init() {}

    /// Add `samples`, captured from `time` on; returns the frames completed.
    mutating func append(_ samples: [Float], startingAt time: TimeInterval) -> [MicFrame] {
        if pending.isEmpty { pendingStart = time }
        pending.append(contentsOf: samples)
        var frames: [MicFrame] = []
        while pending.count >= Self.frameSamples {
            let frame = Array(pending[..<Self.frameSamples])
            pending.removeFirst(Self.frameSamples)
            frames.append(MicFrame(samples: frame, rms: Self.rms(frame), time: pendingStart))
            pendingStart += Double(Self.frameSamples) / Self.sampleRate
        }
        return frames
    }

    mutating func reset() {
        pending = []
        pendingStart = 0
    }

    static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var value: Float = 0
        samples.withUnsafeBufferPointer { vDSP_rmsqv($0.baseAddress!, 1, &value, vDSP_Length($0.count)) }
        return value
    }
}

// MARK: - Earcons

/// The earcons, made in code: soft sine tones at about −20 dBFS with 5 ms
/// fades. Listening rises (660 then 880 Hz), "got it" is one short 880 Hz
/// tick, an error falls (330 then 220 Hz). Pure.
enum EarconTone {
    /// −20 dBFS.
    static let peak: Float = 0.1
    static let fadeSeconds = 0.005

    static func tones(_ earcon: Earcon) -> [(hz: Double, seconds: Double)] {
        switch earcon {
        case .listening: return [(hz: 660, seconds: 0.07), (hz: 880, seconds: 0.09)]
        case .gotIt: return [(hz: 880, seconds: 0.04)]
        case .error: return [(hz: 330, seconds: 0.09), (hz: 220, seconds: 0.14)]
        }
    }

    static func samples(_ earcon: Earcon, sampleRate: Double) -> [Float] {
        var out: [Float] = []
        let fade = max(1, Int(fadeSeconds * sampleRate))
        for tone in tones(earcon) {
            let count = Int((tone.seconds * sampleRate).rounded())
            out.reserveCapacity(out.count + count)
            for index in 0..<count {
                var gain = 1.0
                if index < fade {
                    gain = 0.5 - 0.5 * cos(Double.pi * Double(index) / Double(fade))
                } else if index >= count - fade {
                    gain = 0.5 - 0.5 * cos(Double.pi * Double(count - 1 - index) / Double(fade))
                }
                let phase = 2 * Double.pi * tone.hz * Double(index) / sampleRate
                out.append(Float(sin(phase) * gain) * peak)
            }
        }
        return out
    }
}

// MARK: - The microphone tap

/// The microphone tap's work, on the audio thread: each buffer converted to
/// 16 kHz mono and cut into ``MicFrame``s.
final class TalkMicTap: @unchecked Sendable {
    private let converter: MicrophoneConverter
    private let sink: AsyncStream<MicFrame>.Continuation
    private let lock = NSLock()
    private var assembler = MicFrameAssembler()
    private var closed = false
    private var muted = false

    init(converter: MicrophoneConverter, sink: AsyncStream<MicFrame>.Continuation) {
        self.converter = converter
        self.sink = sink
    }

    func consume(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        guard let converted = converter.convert(buffer) else { return }
        let start = time.isHostTimeValid
            ? AVAudioTime.seconds(forHostTime: time.hostTime)
            : ProcessInfo.processInfo.systemUptime - Double(converted.samples.count) / MicrophoneConverter.sampleRate
        lock.lock()
        guard !closed, !muted else {
            lock.unlock()
            return
        }
        let frames = assembler.append(converted.samples, startingAt: start)
        lock.unlock()
        for frame in frames { sink.yield(frame) }
    }

    /// The Mute button: frames are dropped (and the half-filled one with
    /// them, so the next frame starts fresh) until it is lifted.
    func setMuted(_ on: Bool) {
        lock.lock()
        muted = on
        if on { assembler.reset() }
        lock.unlock()
    }

    /// The engine is going: nothing more is yielded.
    func close() {
        lock.lock()
        closed = true
        lock.unlock()
    }
}
