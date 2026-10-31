import Foundation
import SherpaOnnx
import SmartTurn

// Talk's engines behind the protocols its logic sees (TalkProtocols.swift):
// Silero for the voice activity, the streaming Zipformer for the live
// transcript, whisper for the final one and Smart Turn for the turn's end.
// Loading them is the platform's (TalkLive.swift in the app).

/// Silero, streaming, as Talk's VAD.
final class SileroSpeechActivity: SpeechActivity {
    private let detector: StreamingVoiceActivityDetector

    init(_ detector: StreamingVoiceActivityDetector) {
        self.detector = detector
    }

    func probability(_ frame: [Float]) -> Float { detector.probability(of: frame) ?? 0 }

    func reset() { detector.reset() }
}

/// The Zipformer as Talk's live transcriber. It keeps the utterance's audio
/// for the check at a pause (a fresh pass over the last 3 s).
final class ZipformerTranscriber: LiveTranscriber, @unchecked Sendable {
    private let recognizer: StreamingTransducerRecognizer
    private let lock = NSLock()
    private var audio: [Float] = []
    private var lastPartial = ""

    /// The audio a pause's check reads.
    static let tailSeconds = 3.0

    init(recognizer: StreamingTransducerRecognizer) {
        self.recognizer = recognizer
    }

    func begin(preRoll: [Float]) {
        recognizer.reset()
        lock.withLock {
            audio = preRoll
            lastPartial = ""
        }
        if !preRoll.isEmpty { _ = accept(preRoll, keep: false) }
    }

    func accept(_ samples: [Float]) -> String? {
        accept(samples, keep: true)
    }

    private func accept(_ samples: [Float], keep: Bool) -> String? {
        if keep { lock.withLock { audio.append(contentsOf: samples) } }
        let text = recognizer.accept(samples: samples)
        return lock.withLock {
            guard text != lastPartial else { return nil }
            lastPartial = text
            return text
        }
    }

    func flushTail() -> String {
        let tail = lock.withLock {
            let count = Int(Self.tailSeconds * Double(StreamingTransducerRecognizer.sampleRate))
            return audio.count <= count ? audio : Array(audio.suffix(count))
        }
        return recognizer.transcribeOnce(samples: tail)
    }

    func finish() -> String {
        recognizer.inputFinished()
    }

    func reset() {
        recognizer.reset()
        lock.withLock {
            audio = []
            lastPartial = ""
        }
    }

    func transcribeOnce(_ clip: [Float]) -> String {
        recognizer.transcribeOnce(samples: clip)
    }
}

/// whisper for the final transcript, with voice typing's language plan and
/// its prompt (the folder, the session's title and code words).
final class WhisperFinalTranscriber: FinalTranscriber, @unchecked Sendable {
    private let engine: SpeechToText
    private let languageID: SpokenLanguageIdentifier?
    private let plan: DictationLanguagePlan
    private let prompt: @Sendable (String?) -> String?

    init(engine: SpeechToText, languageID: SpokenLanguageIdentifier?, plan: DictationLanguagePlan,
         prompt: @escaping @Sendable (String?) -> String?) {
        self.engine = engine
        self.languageID = languageID
        self.plan = plan
        self.prompt = prompt
    }

    func transcribe(_ clip: [Float]) async throws -> String {
        let language: String?
        switch plan {
        case .forced(let code): language = code
        case .detectAny: language = nil
        case .hebrewOrEnglish: language = await identify(clip)
        }
        let options = TranscriptionOptions(language: language, prompt: prompt(language))
        let result = try await engine.transcribe(clip, options: options)
        return DictationText.clean(result.text)
    }

    func cancel() { engine.cancel() }

    private func identify(_ clip: [Float]) async -> String {
        guard let languageID else { return "he" }
        let probabilities = try? await languageID.probabilities(SpokenLanguageDecision.window(of: clip),
                                                                among: SpokenLanguageDecision.candidates)
        return SpokenLanguageDecision.language(for: probabilities)
    }
}

/// Smart Turn as Talk's turn-end classifier.
final class SmartTurnTurnEnd: TurnEndClassifier {
    private let classifier: SmartTurnClassifier

    init(_ classifier: SmartTurnClassifier) {
        self.classifier = classifier
    }

    func probability(last8s: [Float]) async -> Float? {
        await classifier.probability(last8s: last8s)
    }
}
