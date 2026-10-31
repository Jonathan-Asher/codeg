import Foundation
import whisper

/// Speech in a live microphone stream, one probability per 32 ms frame, with
/// what the model remembers carried from frame to frame (unlike
/// ``VoiceActivityDetector``, whose every call starts afresh).
protocol StreamingVoiceActivityDetector: AnyObject, Sendable {
    /// The speech probability of each 512-sample frame of 16 kHz mono
    /// `samples`, in order (a shorter last frame is padded with silence), or
    /// nil on failure.
    func probabilities(_ samples: [Float]) -> [Float]?
    /// Forget what the frames so far left in the model's memory (between
    /// utterances).
    func reset()
}

extension StreamingVoiceActivityDetector {
    /// The speech probability of one frame (512 samples, 32 ms).
    func probability(of frame: [Float]) -> Float? {
        probabilities(frame)?.last
    }
}

/// Silero VAD for a live microphone (Talk): whisper.cpp v1.9.1's
/// `whisper_vad_detect_speech_no_reset`, which keeps the LSTM state between
/// calls, and `whisper_vad_reset_state` between utterances. A context of its
/// own, apart from the batch detector dictation trims with (``SileroVAD``),
/// whose every call resets the state. CPU, one thread.
final class StreamingSileroVAD: StreamingVoiceActivityDetector, @unchecked Sendable {
    static let frameSamples = 512

    private let context: OpaquePointer
    private let lock = NSLock()

    init?(modelURL: URL, threads: Int32 = 1) {
        guard FileManager.default.fileExists(atPath: modelURL.path) else { return nil }
        var params = whisper_vad_default_context_params()
        params.use_gpu = false
        params.n_threads = threads
        guard let context = whisper_vad_init_from_file_with_params(modelURL.path, params) else { return nil }
        self.context = context
    }

    deinit { whisper_vad_free(context) }

    func probabilities(_ samples: [Float]) -> [Float]? {
        lock.lock()
        defer { lock.unlock() }
        guard !samples.isEmpty else { return [] }
        let ok = samples.withUnsafeBufferPointer { buffer in
            whisper_vad_detect_speech_no_reset(context, buffer.baseAddress, Int32(buffer.count))
        }
        guard ok else { return nil }
        let count = Int(whisper_vad_n_probs(context))
        guard count > 0, let probs = whisper_vad_probs(context) else { return [] }
        return Array(UnsafeBufferPointer(start: probs, count: count))
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        whisper_vad_reset_state(context)
    }
}
