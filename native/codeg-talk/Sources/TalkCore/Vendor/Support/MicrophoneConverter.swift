import AVFAudio
import Accelerate
import Foundation

/// Converts microphone buffers to the 16 kHz mono Float32 the speech engines
/// read, and measures them. Shared by voice typing (``DictationRecorder``) and
/// Talk (``TalkAudioEngine``). One converter per tap format: a buffer in another
/// format (the route changed under the tap) is dropped, not converted.
final class MicrophoneConverter: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    /// What one microphone buffer gave.
    struct Converted: Sendable {
        /// 16 kHz mono.
        let samples: [Float]
        /// The input buffer's root mean square (its first channel, linear).
        let inputRMS: Float
    }

    /// The tap's format the converter was built for.
    let inputFormat: AVAudioFormat
    /// 16 kHz mono Float32, deinterleaved.
    let outputFormat: AVAudioFormat
    private let converter: AVAudioConverter

    init?(inputFormat: AVAudioFormat) {
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate,
                                         channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: target) else { return nil }
        self.inputFormat = inputFormat
        outputFormat = target
        self.converter = converter
    }

    /// Convert one buffer, on the audio thread. Nil for a buffer in another
    /// format than the converter's, or one that didn't convert.
    func convert(_ input: AVAudioPCMBuffer) -> Converted? {
        guard input.format.sampleRate == inputFormat.sampleRate,
              input.format.channelCount == inputFormat.channelCount else { return nil }
        var rms: Float = 0
        if let channel = input.floatChannelData?[0], input.frameLength > 0 {
            vDSP_rmsqv(channel, 1, &rms, vDSP_Length(input.frameLength))
        }
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        // The converter keeps its filter state from buffer to buffer (`.noDataNow`,
        // never the end of the stream), so the audio joins up seamlessly.
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, let data = out.floatChannelData?[0], out.frameLength > 0 else { return nil }
        return Converted(samples: Array(UnsafeBufferPointer(start: data, count: Int(out.frameLength))), inputRMS: rms)
    }

    /// The meter's level for an RMS: −55 dBFS … 0 dBFS as 0…1.
    static func meterLevel(rms: Float) -> Float {
        let db = 20 * log10(max(rms, 1e-7))
        return min(1, max(0, (db + 55) / 55))
    }
}
