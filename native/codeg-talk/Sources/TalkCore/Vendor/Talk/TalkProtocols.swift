import Foundation

// The seams between Talk's pure logic and the engines that run on the device.
// The logic in this folder only sees these protocols; the audio engine, the
// speech models and the session wiring implement them.

/// Streaming voice activity detection: one speech probability for each frame
/// of 512 samples at 16 kHz (32 ms). Keeps its state between frames until
/// ``reset()``.
protocol SpeechActivity {
    func probability(_ frame: [Float]) -> Float
    func reset()
}

/// Live (streaming) transcription of the utterance being heard. `begin`
/// starts an utterance with the audio just before speech was detected;
/// `accept` returns the partial text when it changed; `flushTail` decodes
/// what is buffered at a pause without ending the utterance; `finish` ends
/// it and returns the final text. `transcribeOnce` decodes a clip on a
/// stream of its own (the check of a voice talking over the speech) and
/// leaves the utterance alone.
///
/// The calls are CPU work: Talk makes them in order on its own queue
/// (``TalkWorker``), never on the main thread.
protocol LiveTranscriber: AnyObject, Sendable {
    func begin(preRoll: [Float])
    func accept(_ samples: [Float]) -> String?
    func flushTail() -> String
    func finish() -> String
    func reset()
    func transcribeOnce(_ clip: [Float]) -> String
}

/// The more accurate transcription of a whole utterance (16 kHz mono),
/// started speculatively at a pause.
protocol FinalTranscriber: AnyObject, Sendable {
    func transcribe(_ clip: [Float]) async throws -> String
    func cancel()
}

/// The probability that the speaker finished their turn, from the last 8 s
/// of audio. `nil` when the model isn't available.
protocol TurnEndClassifier {
    func probability(last8s: [Float]) async -> Float?
}

/// A piece of synthesized speech: mono samples at their own rate.
struct SpeechChunk: Sendable, Equatable {
    var samples: [Float]
    var sampleRate: Double

    var duration: TimeInterval { sampleRate > 0 ? Double(samples.count) / sampleRate : 0 }
}

/// Speech for one unit, in chunks (the first can be short, so the first
/// sound comes sooner).
@MainActor
protocol Synthesizer: AnyObject {
    func synthesize(_ unit: SpeechUnit) -> AsyncThrowingStream<SpeechChunk, Error>
}

/// Monotonic seconds. Tests drive a fake one.
protocol TalkClock: Sendable {
    func now() -> TimeInterval
}

/// The clock Talk runs on: seconds since the device booted.
struct SystemTalkClock: TalkClock {
    func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
}

/// Runs Talk's CPU work (the live transcriber) in the order it was handed
/// over, off the main thread. The work is queued at once, so what the main
/// actor hands over in order runs in that order.
protocol TalkWorker: Sendable {
    func enqueue(_ work: @escaping @Sendable () -> Void)
}

extension TalkWorker {
    /// Queue `work` now; its result arrives through the promise.
    func submit<T: Sendable>(_ work: @escaping @Sendable () -> T) -> TalkPromise<T> {
        let promise = TalkPromise<T>()
        enqueue { promise.fulfill(work()) }
        return promise
    }
}

/// Talk's queue in the app: one serial queue at user-initiated priority.
final class SerialTalkWorker: TalkWorker, @unchecked Sendable {
    private let queue = DispatchQueue(label: "io.ashurov.codeg.talk.worker", qos: .userInitiated)

    func enqueue(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }
}

/// A value computed on a ``TalkWorker``, awaited later.
final class TalkPromise<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: T?
    private var waiting: [CheckedContinuation<T, Never>] = []

    func fulfill(_ value: T) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = value
        let waiters = waiting
        waiting = []
        lock.unlock()
        for waiter in waiters { waiter.resume(returning: value) }
    }

    var value: T {
        get async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if let result {
                    lock.unlock()
                    continuation.resume(returning: result)
                } else {
                    waiting.append(continuation)
                    lock.unlock()
                }
            }
        }
    }
}

/// One piece of speech: a sentence of the agent's reply, or a short cue
/// ("It's on the screen") that stands in for something that isn't read.
struct SpeechUnit: Equatable, Hashable, Sendable, Identifiable {
    /// The language the text is in, as a hint for the synthesizer.
    enum Language: String, Equatable, Hashable, Sendable {
        case hebrew = "he"
        case english = "en"
        /// Neither is clear (only digits and symbols, or both).
        case auto
    }

    enum Kind: Equatable, Hashable, Sendable {
        case sentence
        case cue
    }

    /// The reply a unit belongs to (a turn id, or a cue's own name) and its
    /// place in it.
    struct ID: Hashable, Sendable, CustomStringConvertible {
        var reply: String
        var index: Int

        var description: String { "\(reply)#\(index)" }
    }

    var id: ID
    var text: String
    var language: Language
    /// The first unit of a reply: the speaker starts it with a short first
    /// chunk, so the first sound comes sooner.
    var isFirstOfReply: Bool
    var kind: Kind

    init(id: ID, text: String, language: Language? = nil, isFirstOfReply: Bool = false, kind: Kind = .sentence) {
        self.id = id
        self.text = text
        self.language = language ?? Self.language(of: text)
        self.isFirstOfReply = isFirstOfReply
        self.kind = kind
    }

    /// A unit with no reply of its own: a prompt or a cue Talk says itself.
    static func standalone(_ text: String, name: String, kind: Kind = .cue,
                           language: Language? = nil) -> SpeechUnit {
        SpeechUnit(id: ID(reply: name, index: 0), text: text, language: language, isFirstOfReply: true, kind: kind)
    }

    /// Hebrew when the text holds a Hebrew letter, English when it holds
    /// only Latin letters, otherwise auto.
    static func language(of text: String) -> Language {
        if HebrewText.containsHebrew(text) { return .hebrew }
        if HebrewText.containsLatin(text) { return .english }
        return .auto
    }
}
