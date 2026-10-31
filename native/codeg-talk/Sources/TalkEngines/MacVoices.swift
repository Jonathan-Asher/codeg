import AVFoundation
import BlueTTSKit
import Foundation

/// BlueTTS speaks Talk's replies, with read aloud's voice and speed. A
/// reply's first unit gets a short first chunk, so the first sound comes
/// sooner (the iPhone's `BlueVoiceSynthesizer`).
@MainActor
final class MacBlueSynthesizer: Synthesizer {
    private let tts: BlueTTS
    private let voice: String?
    private let speed: Double

    init(tts: BlueTTS, voice: String?, speed: Double) {
        self.tts = tts
        self.voice = voice
        self.speed = min(2, max(0.5, speed.isFinite ? speed : 1))
    }

    func synthesize(_ unit: SpeechUnit) -> AsyncThrowingStream<SpeechChunk, Error> {
        var options = SynthesisOptions()
        options.voice = voice
        options.speed = speed
        switch unit.language {
        case .hebrew: options.language = .hebrew
        case .english: options.language = .english
        case .auto: options.language = .auto
        }
        let stream = tts.synthesizeStream(unit.text, options: options,
                                          firstChunkMaxChars: unit.isFirstOfReply ? 90 : 400)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await chunk in stream {
                        continuation.yield(SpeechChunk(samples: chunk.samples, sampleRate: Double(chunk.sampleRate)))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// The Mac's own Hebrew and English voices, when BlueTTS isn't downloaded:
/// rendered to samples (`AVSpeechSynthesizer.write`) and played on Talk's
/// engine, so echo cancellation still hears them (the iPhone's
/// `SystemVoiceSynthesizer`).
@MainActor
final class MacSystemVoiceSynthesizer: Synthesizer {
    private let speed: Double
    private var synthesizers: [AVSpeechSynthesizer] = []

    init(speed: Double) {
        self.speed = speed
    }

    func synthesize(_ unit: SpeechUnit) -> AsyncThrowingStream<SpeechChunk, Error> {
        let rate = AVSpeechUtteranceDefaultSpeechRate * Float(min(1.4, max(0.7, speed)))
        let runs = SpeechText.scriptRuns(unit.text).filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        let synthesizer = AVSpeechSynthesizer()
        synthesizers.append(synthesizer)
        return AsyncThrowingStream { continuation in
            Task { @MainActor [weak self] in
                for run in runs {
                    let utterance = AVSpeechUtterance(string: run.text)
                    utterance.voice = AVSpeechSynthesisVoice(language: run.isHebrew ? "he-IL" : "en-US")
                    utterance.rate = rate
                    for chunk in await Self.render(utterance, with: synthesizer) {
                        continuation.yield(chunk)
                    }
                }
                continuation.finish()
                self?.synthesizers.removeAll { $0 === synthesizer }
            }
        }
    }

    /// What a render collected, filled on the synthesizer's thread.
    private final class Render: @unchecked Sendable {
        let lock = NSLock()
        var chunks: [SpeechChunk] = []
        var done = false
    }

    /// One utterance as mono float chunks (none when there is no voice for
    /// its language).
    private static func render(_ utterance: AVSpeechUtterance, with synthesizer: AVSpeechSynthesizer) async -> [SpeechChunk] {
        guard utterance.voice != nil else { return [] }
        let render = Render()
        return await withCheckedContinuation { continuation in
            synthesizer.write(utterance) { buffer in
                render.lock.lock()
                guard !render.done else {
                    render.lock.unlock()
                    return
                }
                if let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 {
                    if let chunk = Self.chunk(pcm) { render.chunks.append(chunk) }
                    render.lock.unlock()
                } else {
                    // An empty buffer ends the utterance.
                    render.done = true
                    let chunks = render.chunks
                    render.lock.unlock()
                    continuation.resume(returning: chunks)
                }
            }
        }
    }

    nonisolated private static func chunk(_ buffer: AVAudioPCMBuffer) -> SpeechChunk? {
        let count = Int(buffer.frameLength)
        let rate = buffer.format.sampleRate
        if let data = buffer.floatChannelData?[0] {
            return SpeechChunk(samples: Array(UnsafeBufferPointer(start: data, count: count)), sampleRate: rate)
        }
        if let data = buffer.int16ChannelData?[0] {
            let samples = UnsafeBufferPointer(start: data, count: count).map { Float($0) / 32_768 }
            return SpeechChunk(samples: samples, sampleRate: rate)
        }
        return nil
    }
}
