import Foundation
import SherpaOnnxC

public enum SherpaOnnxError: Error, CustomStringConvertible, Equatable {
    case modelFileMissing(String)
    case missingPart(String)
    case recognizerCreationFailed(String)
    case streamCreationFailed

    public var description: String {
        switch self {
        case .modelFileMissing(let path): return "model file not found: \(path)"
        case .missingPart(let part): return "the model lists no \(part) file"
        case .recognizerCreationFailed(let detail): return "sherpa-onnx could not load the model: \(detail)"
        case .streamCreationFailed: return "sherpa-onnx could not create a stream"
        }
    }
}

/// The four files of a streaming transducer.
public struct TransducerModelFiles: Sendable, Equatable {
    public var encoder: URL
    public var decoder: URL
    public var joiner: URL
    public var tokens: URL

    public init(encoder: URL, decoder: URL, joiner: URL, tokens: URL) {
        self.encoder = encoder
        self.decoder = decoder
        self.joiner = joiner
        self.tokens = tokens
    }

    /// The parts in `directory`, by the file names a model manifest maps
    /// `encoder`, `decoder`, `joiner` and `tokens` to.
    public init(directory: URL, parts: [String: String]) throws {
        func part(_ key: String) throws -> URL {
            guard let name = parts[key], !name.isEmpty else { throw SherpaOnnxError.missingPart(key) }
            return directory.appendingPathComponent(name)
        }
        self.init(encoder: try part("encoder"), decoder: try part("decoder"),
                  joiner: try part("joiner"), tokens: try part("tokens"))
    }

    var all: [URL] { [encoder, decoder, joiner, tokens] }
}

/// A streaming transducer (zipformer2) recognizer for one utterance at a
/// time: feed 16 kHz mono audio as it arrives, read the partial text, flush
/// at the end, read the final text, reset for the next utterance.
///
/// Every method may be called from any thread; calls are serialized inside
/// (one decode at a time). Decoding is CPU work, tens of milliseconds per
/// 1.28 s chunk on a phone, so drive it from a background queue, not the
/// main thread. `partialText` and `finalText` never wait for a decode.
public final class StreamingTransducerRecognizer: @unchecked Sendable {
    public static let sampleRate = 16_000

    public let files: TransducerModelFiles
    public let threads: Int
    /// Silence appended by ``inputFinished()`` so the last chunk is decoded
    /// (the model decodes 1.28 s chunks).
    public let tailPaddingSeconds: Double

    private let recognizer: OpaquePointer
    private var stream: OpaquePointer
    private let engine = NSLock()

    private struct State {
        var partial = ""
        var final: String?
        var acceptedSamples = 0
    }
    private var state = State()
    private let stateLock = NSLock()

    /// Loads the model (a fraction of a second; do it off the main thread).
    /// `threads` is ONNX Runtime's intra-op thread count. `modelType` skips
    /// sherpa-onnx's guess from the encoder's metadata.
    public init(files: TransducerModelFiles, threads: Int = 2, modelType: String = "zipformer2",
                tailPaddingSeconds: Double = 1.5) throws {
        for url in files.all where !FileManager.default.fileExists(atPath: url.path) {
            throw SherpaOnnxError.modelFileMissing(url.path)
        }
        self.files = files
        self.threads = max(1, threads)
        self.tailPaddingSeconds = max(0, tailPaddingSeconds)

        var strings: [UnsafeMutablePointer<CChar>] = []
        defer { strings.forEach { free($0) } }
        func c(_ s: String) -> UnsafePointer<CChar> {
            let p = strdup(s)!
            strings.append(p)
            return UnsafePointer(p)
        }

        var config = SherpaOnnxOnlineRecognizerConfig()
        config.feat_config.sample_rate = Int32(Self.sampleRate)
        config.feat_config.feature_dim = 80
        config.model_config.transducer.encoder = c(files.encoder.path)
        config.model_config.transducer.decoder = c(files.decoder.path)
        config.model_config.transducer.joiner = c(files.joiner.path)
        config.model_config.tokens = c(files.tokens.path)
        config.model_config.num_threads = Int32(self.threads)
        config.model_config.provider = c("cpu")
        config.model_config.debug = 0
        config.model_config.model_type = c(modelType)
        config.decoding_method = c("greedy_search")
        config.max_active_paths = 4
        // Talk decides the end of a turn itself (VAD and silence).
        config.enable_endpoint = 0

        guard let recognizer = SherpaOnnxCreateOnlineRecognizer(&config) else {
            throw SherpaOnnxError.recognizerCreationFailed(files.encoder.lastPathComponent)
        }
        guard let stream = SherpaOnnxCreateOnlineStream(recognizer) else {
            SherpaOnnxDestroyOnlineRecognizer(recognizer)
            throw SherpaOnnxError.streamCreationFailed
        }
        self.recognizer = recognizer
        self.stream = stream
    }

    deinit {
        SherpaOnnxDestroyOnlineStream(stream)
        SherpaOnnxDestroyOnlineRecognizer(recognizer)
    }

    /// The text so far: partial until ``inputFinished()``, then final.
    public var partialText: String { stateLock.withLock { state.final ?? state.partial } }

    /// The final text after ``inputFinished()``; nil before it.
    public var finalText: String? { stateLock.withLock { state.final } }

    /// Whether ``inputFinished()`` was called since the last ``reset()``.
    public var isFinished: Bool { finalText != nil }

    /// Seconds of audio accepted since the last ``reset()`` (without the tail
    /// padding).
    public var acceptedSeconds: Double {
        stateLock.withLock { Double(state.acceptedSamples) / Double(Self.sampleRate) }
    }

    /// Feeds 16 kHz mono samples and decodes every chunk that is ready.
    /// Returns the text so far. Ignored after ``inputFinished()`` until
    /// ``reset()``.
    @discardableResult
    public func accept(samples: [Float]) -> String {
        engine.withLock {
            if let final = stateLock.withLock({ state.final }) { return final }
            guard !samples.isEmpty else { return stateLock.withLock { state.partial } }
            feed(samples)
            let text = decodeReady()
            stateLock.withLock {
                state.acceptedSamples += samples.count
                state.partial = text
            }
            return text
        }
    }

    /// Flushes the tail: appends ``tailPaddingSeconds`` of silence, marks the
    /// input finished and decodes the rest. Returns the final text; calling it
    /// again returns the same text.
    @discardableResult
    public func inputFinished() -> String {
        engine.withLock {
            if let final = stateLock.withLock({ state.final }) { return final }
            let padding = Int(tailPaddingSeconds * Double(Self.sampleRate))
            if padding > 0 { feed([Float](repeating: 0, count: padding)) }
            SherpaOnnxOnlineStreamInputFinished(stream)
            let text = decodeReady()
            stateLock.withLock {
                state.partial = text
                state.final = text
            }
            return text
        }
    }

    /// Decodes `samples` (16 kHz mono) on a stream of its own, with the tail
    /// padding, and returns the text. The utterance being fed is left as it
    /// is. Talk uses it to check a voice that talks over the speech, and the
    /// last words at a pause.
    public func transcribeOnce(samples: [Float]) -> String {
        engine.withLock {
            guard !samples.isEmpty, let once = SherpaOnnxCreateOnlineStream(recognizer) else { return "" }
            defer { SherpaOnnxDestroyOnlineStream(once) }
            feed(samples, into: once)
            let padding = Int(tailPaddingSeconds * Double(Self.sampleRate))
            if padding > 0 { feed([Float](repeating: 0, count: padding), into: once) }
            SherpaOnnxOnlineStreamInputFinished(once)
            return decodeReady(once)
        }
    }

    /// Starts a new utterance: a fresh stream (encoder state, decoder context
    /// and text all cleared).
    public func reset() {
        engine.withLock {
            if let fresh = SherpaOnnxCreateOnlineStream(recognizer) {
                SherpaOnnxDestroyOnlineStream(stream)
                stream = fresh
            } else {
                // Keep the old stream rather than none; it still decodes.
                SherpaOnnxOnlineStreamReset(recognizer, stream)
            }
            stateLock.withLock { state = State() }
        }
    }

    /// sherpa-onnx's version and the ONNX Runtime version it runs on (the
    /// linked runtime's own report).
    public static var versions: (sherpaOnnx: String, onnxRuntime: String) {
        (String(cString: SherpaOnnxGetVersionStr()), String(cString: SherpaOnnxGetOnnxruntimeVersionStr()))
    }

    // MARK: - Engine (callers hold `engine`)

    private func feed(_ samples: [Float]) {
        feed(samples, into: stream)
    }

    private func feed(_ samples: [Float], into target: OpaquePointer) {
        samples.withUnsafeBufferPointer { p in
            SherpaOnnxOnlineStreamAcceptWaveform(target, Int32(Self.sampleRate), p.baseAddress, Int32(p.count))
        }
    }

    private func decodeReady() -> String {
        decodeReady(stream)
    }

    private func decodeReady(_ target: OpaquePointer) -> String {
        while SherpaOnnxIsOnlineStreamReady(recognizer, target) == 1 {
            SherpaOnnxDecodeOnlineStream(recognizer, target)
        }
        guard let result = SherpaOnnxGetOnlineStreamResult(recognizer, target) else { return "" }
        defer { SherpaOnnxDestroyOnlineRecognizerResult(result) }
        guard let text = result.pointee.text else { return "" }
        // SentencePiece word starts ("▁") come out as spaces.
        return String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
