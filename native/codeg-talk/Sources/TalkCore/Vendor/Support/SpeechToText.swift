import Foundation

/// An on-device speech-to-text engine. The app talks to this protocol only,
/// so the engine (whisper.cpp today, see ``WhisperCppEngine``) can be swapped
/// for another (for example WhisperKit on the Neural Engine) later.
protocol SpeechToText: AnyObject, Sendable {
    /// The manifest id of the loaded model.
    var modelID: String { get }
    /// Load the weights ahead of the first request. `transcribe` loads on
    /// demand too; calling this when recording starts hides the load time
    /// behind the speech.
    func prepare() async throws
    /// Transcribe 16 kHz mono samples.
    func transcribe(_ samples: [Float], options: TranscriptionOptions) async throws -> Transcription
    /// Ask a running `transcribe` to stop early; it then throws ``SpeechToTextError/cancelled``.
    func cancel()
    /// Free the weights.
    func unload() async
}

/// Finds speech in a recording, one probability per short frame.
protocol VoiceActivityDetector: AnyObject, Sendable {
    /// Speech probabilities for 16 kHz mono samples, or `nil` on failure.
    func speechProbabilities(_ samples: [Float]) -> [Float]?
}

/// Tells which language a recording is in. ``WhisperLanguageIdentifier`` runs
/// a small multilingual whisper model for this: the encoder and one decoder
/// step, no transcription.
protocol SpokenLanguageIdentifier: AnyObject, Sendable {
    func prepare() async throws
    /// The probability of each of `candidates` (whisper codes such as "he"),
    /// renormalized so that they add up to 1. A candidate whisper doesn't
    /// know is left out.
    func probabilities(_ samples: [Float], among candidates: [String]) async throws -> [String: Float]
    func unload() async
}

struct TranscriptionOptions: Equatable, Sendable {
    /// Whisper language code, or `nil` to detect the language.
    var language: String?
    /// Text the decoder treats as what came before (biases spelling and vocabulary).
    var prompt: String?
    var threads: Int = TranscriptionOptions.defaultThreads
    /// Encoder context override (`nil` = the full 1500 positions, 30 s).
    /// Smaller values encode short audio faster, at some risk to accuracy.
    var audioContext: Int32?

    static var defaultThreads: Int {
        min(4, max(1, ProcessInfo.processInfo.activeProcessorCount - 2))
    }

    /// Speakly's `scaled_audio_ctx`: one encoder position per 320 samples
    /// (20 ms) plus 128 spare, capped at the full 1500.
    static func scaledAudioContext(sampleCount: Int) -> Int32 {
        Int32(min(1500, (sampleCount + 319) / 320 + 128))
    }
}

struct Transcription: Equatable, Sendable {
    let text: String
    /// The language whisper used (the forced one, or the detected one).
    let language: String?
    /// Wall time of the decode.
    let seconds: Double
}

enum SpeechToTextError: LocalizedError, Equatable {
    case modelMissing
    case loadFailed
    case decodeFailed(Int32)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .modelMissing: "The speech model isn't downloaded. Download it in Settings › Voice."
        case .loadFailed: "The speech model couldn't be loaded. Delete it in Settings › Voice and download it again."
        case .decodeFailed(let code): "Transcription failed (whisper error \(code))."
        case .cancelled: "Transcription was cancelled."
        }
    }
}
