@testable import TalkHost
import AVFoundation

/// The microphone tap on the Mac, on the audio thread: channel 0 of the
/// input (with voice processing the input node can deliver several channels,
/// and only the first carries the processed voice), then the iPhone's tap
/// (``TalkMicTap``: ``MicrophoneConverter`` to 16 kHz mono, 512-sample
/// frames).
///
/// Frames are dropped while muted (the Mute button) or gated (Talk speaks on
/// speakers without echo cancellation, see ``MacEchoPolicy/halfDuplex(route:echo:)``).
final class MacMicTap: @unchecked Sendable {
    let inputFormat: AVAudioFormat
    private let monoFormat: AVAudioFormat
    private let tap: TalkMicTap
    private let lock = NSLock()
    private var muted = false
    private var gated = false

    /// nil when the input format can't be converted.
    init?(inputFormat: AVAudioFormat, sink: AsyncStream<MicFrame>.Continuation) {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputFormat.sampleRate,
                                       channels: 1, interleaved: false),
              let converter = MicrophoneConverter(inputFormat: mono) else { return nil }
        self.inputFormat = inputFormat
        monoFormat = mono
        tap = TalkMicTap(converter: converter, sink: sink)
    }

    func consume(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        guard let mono = Self.channelZero(of: buffer, as: monoFormat) else { return }
        tap.consume(mono, at: time)
    }

    /// The Mute button.
    func setMuted(_ on: Bool) {
        lock.lock()
        muted = on
        let drop = muted || gated
        lock.unlock()
        tap.setMuted(drop)
    }

    /// Talk speaks on speakers without echo cancellation.
    func setGated(_ on: Bool) {
        lock.lock()
        guard gated != on else {
            lock.unlock()
            return
        }
        gated = on
        let drop = muted || gated
        lock.unlock()
        tap.setMuted(drop)
    }

    func close() {
        tap.close()
    }

    /// `buffer`'s first channel as a mono buffer in `format` (Float32 at the
    /// buffer's rate); the buffer itself when it is mono already. nil for an
    /// empty buffer or one in another format (the route changed under the
    /// tap).
    static func channelZero(of buffer: AVAudioPCMBuffer, as format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = Int(buffer.frameLength)
        guard frames > 0, abs(buffer.format.sampleRate - format.sampleRate) < 1,
              buffer.format.commonFormat == .pcmFormatFloat32,
              let data = buffer.floatChannelData else { return nil }
        let channels = Int(buffer.format.channelCount)
        if channels == 1, !buffer.format.isInterleaved { return buffer }
        let samples = ChannelZero.extract(data[0], frames: frames, channels: channels,
                                          interleaved: buffer.format.isInterleaved)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let dst = out.floatChannelData?[0] else { return nil }
        samples.withUnsafeBufferPointer { dst.update(from: $0.baseAddress!, count: frames) }
        out.frameLength = AVAudioFrameCount(frames)
        return out
    }
}

/// A level written on the audio thread and read on the main one.
final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var level: Float = 0

    var value: Float {
        lock.lock()
        defer { lock.unlock() }
        return level
    }

    func set(_ value: Float) {
        lock.lock()
        level = value
        lock.unlock()
    }
}
