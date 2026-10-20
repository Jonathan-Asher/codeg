import Foundation

/// Mono Float32 PCM.
public struct AudioBuffer: Sendable {
    public var samples: [Float]
    public var sampleRate: Int

    public var duration: TimeInterval { Double(samples.count) / Double(sampleRate) }

    public init(samples: [Float], sampleRate: Int) {
        self.samples = samples
        self.sampleRate = sampleRate
    }
}

/// One streamed piece of an utterance (a sentence, or a slow-read span).
public struct AudioChunk: Sendable {
    /// 0-based position in the stream.
    public var index: Int
    /// The phoneme string this chunk was synthesized from.
    public var phonemes: String
    /// Mono Float32 PCM, including any pause that precedes this chunk.
    public var samples: [Float]
    public var sampleRate: Int
    /// True for the last chunk of the utterance.
    public var isFinal: Bool

    public var duration: TimeInterval { Double(samples.count) / Double(sampleRate) }
}

/// Language of the input text.
public enum TextLanguage: String, Sendable {
    /// Hebrew when the text has a Hebrew letter (Latin runs get `<en>` tags), else English.
    case auto
    case hebrew = "he"
    case english = "en"
}

/// Per-call synthesis options. Defaults are the reference `BlueTTS.synthesize` defaults.
public struct SynthesisOptions: Sendable {
    /// Voice file name in the voices directory, without `.json` (default `noa`).
    public var voice: String?
    /// Speaking rate multiplier (> 1 is faster). Python default 1.0.
    public var speed: Double = 1.0
    /// Flow-matching steps. Python default 5.
    public var totalSteps: Int = 5
    /// Classifier-free guidance scale. Python default 4.0.
    public var cfgScale: Float = 4.0
    /// Silence between chunks, seconds. Python default 0.
    public var silenceBetweenChunks: Double = 0.0
    /// Duration pace blend; nil = 0.25 for mixed-language text, else 0.
    public var paceBlend: Double?
    public var paceDptRef: Double?
    /// Scale output down so |x| <= limit; nil = raw vocoder output.
    public var peakLimit: Float? = 0.95
    /// Run the text normalizer (numbers, dates, symbols, codes).
    public var normalizeText: Bool = true
    /// Wrap Latin runs in `<en>…</en>` automatically (Hebrew text only).
    public var autoTagEnglish: Bool = true
    public var language: TextLanguage = .auto
    /// Seed for the flow-matching noise; same seed as `np.random.seed` gives
    /// Python's noise. nil = random.
    public var seed: UInt32?

    public init() {}
}

/// Load-time configuration.
public struct BlueTTSConfiguration: Sendable {
    /// ONNX Runtime intra-op threads (Python uses min(8, cores)).
    public var threads: Int = min(8, ProcessInfo.processInfo.activeProcessorCount)
    /// Execution providers per graph. CPU everywhere is the reference and the
    /// fastest on M1 (see README "CoreML"). The duration predictor is always
    /// CPU: ORT 1.30's CoreML EP aborts the process on that graph.
    public var textEncoderProvider: ExecutionProvider = .cpu
    public var vectorEstimatorProvider: ExecutionProvider = .cpu
    public var vocoderProvider: ExecutionProvider = .cpu
    public var g2pProvider: ExecutionProvider = .cpu
    /// Voice used when `SynthesisOptions.voice` is nil.
    public var defaultVoice: String = "noa"

    public init() {}
}

/// Where the model files live. `BlueTTSModelPaths(root:)` expects the layout in
/// the README (`bluetts/`, `voices/`, `renikud/`).
public struct BlueTTSModelPaths: Sendable {
    public var blueDirectory: URL
    public var voicesDirectories: [URL]
    public var renikudModel: URL

    public init(blueDirectory: URL, voicesDirectories: [URL], renikudModel: URL) {
        self.blueDirectory = blueDirectory
        self.voicesDirectories = voicesDirectories
        self.renikudModel = renikudModel
    }

    public init(root: URL) {
        blueDirectory = root.appendingPathComponent("bluetts")
        voicesDirectories = [root.appendingPathComponent("voices")]
        renikudModel = root.appendingPathComponent("renikud").appendingPathComponent("model_int8.onnx")
    }
}

public enum BlueTTSError: Error, CustomStringConvertible {
    case voiceNotFound(String)
    case englishPhonemizerMissing

    public var description: String {
        switch self {
        case .voiceNotFound(let v): return "voice \(v) not found"
        case .englishPhonemizerMissing: return "text has English spans but no EnglishPhonemizer was supplied"
        }
    }
}

/// What the text front end produced, for inspection and golden tests.
public struct PhonemizationResult: Sendable, Equatable {
    /// Input after auto-tagging.
    public var tagged: String
    /// After `prepare_text_for_synthesis` (with slow markers).
    public var normalized: String
    /// Language code the utterance is synthesized as.
    public var language: String
    /// One entry per slow/normal segment: G2P output with `<he>`/`<en>` tags.
    public var segments: [Segment]

    public struct Segment: Sendable, Equatable {
        public var text: String
        public var isSlow: Bool
        public var phonemes: String
        /// `chunk_text` output (tags stripped) — what the acoustic model reads.
        public var chunks: [String]
    }

    /// All segments' phonemes joined (the spike's `PHON` line for unmarked text).
    public var phonemes: String { segments.map(\.phonemes).joined(separator: " ") }
}

/// BlueTTS 2.5 + RenikudPlus on-device text-to-speech.
///
/// Thread-safe. Models load lazily on first use (or call `load()`), and all
/// inference runs on one serial background queue, never on the caller's
/// executor.
public final class BlueTTS: @unchecked Sendable {
    public let paths: BlueTTSModelPaths
    public let configuration: BlueTTSConfiguration
    public let englishPhonemizer: (any EnglishPhonemizer)?

    private let queue = DispatchQueue(label: "BlueTTSKit.inference", qos: .userInitiated)
    // Touched only on `queue`.
    private var synth: BlueSynthesizer?
    private var g2p: PhonemeTextProcessor?
    private var voices: [String: VoiceStyle] = [:]

    public convenience init(modelDirectory: URL, englishPhonemizer: (any EnglishPhonemizer)? = nil,
                            configuration: BlueTTSConfiguration = BlueTTSConfiguration()) {
        self.init(paths: BlueTTSModelPaths(root: modelDirectory), englishPhonemizer: englishPhonemizer,
                  configuration: configuration)
    }

    public init(paths: BlueTTSModelPaths, englishPhonemizer: (any EnglishPhonemizer)? = nil,
                configuration: BlueTTSConfiguration = BlueTTSConfiguration()) {
        self.paths = paths
        self.englishPhonemizer = englishPhonemizer
        self.configuration = configuration
    }

    private func onQueue<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            queue.async { cont.resume(with: Result { try work() }) }
        }
    }

    // MARK: loading (queue only)

    private func g2pLocked() -> PhonemeTextProcessor {
        if let g = g2p { return g }
        let url = paths.renikudModel, threads = configuration.threads, prov = configuration.g2pProvider
        let g = PhonemeTextProcessor(renikud: { try RenikudG2P(modelURL: url, threads: threads, provider: prov) },
                                     english: englishPhonemizer)
        g2p = g
        return g
    }

    private func synthLocked() throws -> BlueSynthesizer {
        if let s = synth { return s }
        let d = paths.blueDirectory
        func file(_ n: String) -> URL { d.appendingPathComponent(n) }
        var dpURL = file("duration_predictor_style.onnx")
        if !FileManager.default.fileExists(atPath: dpURL.path) { dpURL = file("duration_predictor.onnx") }
        let p = BlueSynthesizer.Paths(
            durationPredictor: dpURL, textEncoder: file("text_encoder.onnx"),
            vectorEstimator: file("vector_estimator.onnx"), vocoder: file("vocoder.onnx"),
            config: file("tts.json"), vocab: file("vocab.json"), stats: file("stats.npz"), uncond: file("uncond.npz"))
        var prov = BlueSynthesizer.Providers()
        prov.textEncoder = configuration.textEncoderProvider
        prov.vectorEstimator = configuration.vectorEstimatorProvider
        prov.vocoder = configuration.vocoderProvider
        let s = try BlueSynthesizer(paths: p, threads: configuration.threads, providers: prov)
        synth = s
        return s
    }

    private func voiceLocked(_ name: String?) throws -> VoiceStyle {
        let n = name ?? configuration.defaultVoice
        if let v = voices[n] { return v }
        for dir in paths.voicesDirectories {
            let u = dir.appendingPathComponent("\(n).json")
            if FileManager.default.fileExists(atPath: u.path) {
                let v = try VoiceStyle(contentsOf: u)
                voices[n] = v
                return v
            }
        }
        throw BlueTTSError.voiceNotFound(n)
    }

    /// Load every graph now (acoustic model, G2P, default voice) instead of on first use.
    public func load() async throws {
        try await onQueue {
            _ = try self.synthLocked()
            _ = try self.g2pLocked().loadRenikud()
            _ = try self.voiceLocked(nil)
        }
    }

    /// Voice names found in the voices directories.
    public func availableVoices() -> [String] {
        var names = Set<String>()
        for dir in paths.voicesDirectories {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            for f in items where f.hasSuffix(".json") { names.insert(String(f.dropLast(5))) }
        }
        return names.sorted()
    }

    public var sampleRate: Int { 44100 }

    // MARK: text front end

    private func frontEndLocked(_ text: String, _ options: SynthesisOptions) throws -> PhonemizationResult {
        let lang: String
        switch options.language {
        case .auto: lang = EnglishAutoTagger.containsHebrew(text) ? "he" : "en"
        case .hebrew: lang = "he"
        case .english: lang = "en"
        }
        let tagged = (lang == "he" && options.autoTagEnglish) ? EnglishAutoTagger.tag(text) : text
        let normalized = options.normalizeText
            ? TextNormalizer.prepareTextForSynthesis(tagged, lang: lang, markSlow: true) : tagged
        let g = g2pLocked()
        var segments: [PhonemizationResult.Segment] = []
        for (segText, isSlow) in TextNormalizer.splitSlowSegments(normalized) {
            let ph = try g.phonemize(segText, lang: lang)
            let stripped = PhonemeTextProcessor.stripLangTags(ph)
            segments.append(.init(text: segText, isSlow: isSlow, phonemes: ph,
                                  chunks: TextChunker.chunk(stripped, maxLen: 300)))
        }
        return PhonemizationResult(tagged: tagged, normalized: normalized, language: lang, segments: segments)
    }

    /// Run only the text front end (tagging, normalization, G2P, chunking).
    public func phonemize(_ text: String, options: SynthesisOptions = SynthesisOptions()) async throws -> PhonemizationResult {
        try await onQueue { try self.frontEndLocked(text, options) }
    }

    // MARK: synthesis

    /// Synthesize `text` in one pass, mirroring `BlueTTS.synthesize` in Python.
    public func synthesize(_ text: String, options: SynthesisOptions = SynthesisOptions()) async throws -> AudioBuffer {
        try await onQueue {
            let synth = try self.synthLocked()
            let fe = try self.frontEndLocked(text, options)
            let style = try self.voiceLocked(options.voice)
            var rng = options.seed.map { NumpyRandom(seed: $0) } ?? NumpyRandom()
            var samples: [Float] = []
            var started = false
            var prevIsSlow = false
            let paceDefault = PhonemeTextProcessor.inlineLangPair.search(fe.normalized) != nil
                ? BlueSynthesizer.defaultMixedPaceBlend : 0.0
            for seg in fe.segments {
                for chunk in seg.chunks {
                    let r = try self.inferChunk(synth, chunk, fe.language, style, seg.isSlow, options, paceDefault, &rng)
                    if started {
                        let gap = (seg.isSlow || prevIsSlow) ? Double(TextNormalizer.slowSilence) : options.silenceBetweenChunks
                        samples += [Float](repeating: 0, count: Int(gap * Double(synth.sampleRate)))
                    }
                    samples += r.wav
                    started = true
                }
                prevIsSlow = seg.isSlow
            }
            if let lim = options.peakLimit { BlueSynthesizer.limitPeak(&samples, lim) }
            return AudioBuffer(samples: samples, sampleRate: synth.sampleRate)
        }
    }

    private func inferChunk(_ synth: BlueSynthesizer, _ chunk: String, _ lang: String, _ style: VoiceStyle,
                            _ isSlow: Bool, _ o: SynthesisOptions, _ paceDefault: Double,
                            _ rng: inout NumpyRandom) throws -> BlueSynthesizer.ChunkResult {
        let speed = isSlow ? o.speed * Double(TextNormalizer.slowSpeedScale) : o.speed
        let pace = isSlow ? Double(TextNormalizer.slowPaceBlend) : (o.paceBlend ?? paceDefault)
        let ref = isSlow ? Double(TextNormalizer.slowPaceDptRef) : o.paceDptRef
        return try synth.infer(chunk, lang: lang, style: style, totalSteps: o.totalSteps, speed: speed,
                               cfgScale: o.cfgScale, paceBlend: pace, paceDptRef: ref, rng: &rng)
    }

    /// Streaming plan: tag + normalize the whole text, split slow segments,
    /// then split every segment into source sentences (never inside a
    /// `<xx>…</xx>` span). Each sentence is phonemized on its own when its turn
    /// comes, so the first audio waits for one sentence of G2P + synthesis, not
    /// for G2P over the whole text.
    static let sourceSentenceRe = PyRegex(
        "(?<!Mr\\.)(?<!Mrs\\.)(?<!Ms\\.)(?<!Dr\\.)(?<!Prof\\.)(?<!etc\\.)(?<!e\\.g\\.)(?<!i\\.e\\.)(?<!vs\\.)"
            + "(?<=[.!?])\\s+(?![^<]*</\\w+>)"
    )
    static let clauseRe = PyRegex("(?<=,)\\s+")

    /// Split an over-long first chunk at a comma so the first audio is short.
    static func splitFirstChunk(_ phonemes: String, maxChars: Int) -> [String] {
        guard maxChars > 0, Py.len(phonemes) > maxChars else { return [phonemes] }
        let pieces = clauseRe.split(phonemes)
        guard pieces.count > 1 else { return [phonemes] }
        // Take clauses until the head is at least a third of the limit, keep the rest whole.
        var head = ""
        var i = 0
        while i < pieces.count - 1 {
            head += (head.isEmpty ? "" : " ") + pieces[i]
            i += 1
            if Py.len(head) >= maxChars / 3 { break }
        }
        let tail = pieces[i...].joined(separator: " ")
        // A comma-only remainder ("x ,") is not worth a chunk.
        if Py.len(Py.strip(tail, " ,.")) == 0 { return [phonemes] }
        return [head, tail]
    }

    /// Synthesize sentence by sentence. The first chunk arrives after one
    /// sentence's G2P and synthesis (a long first sentence is cut at a comma).
    /// Each chunk is peak-limited on its own (the one-pass path limits the
    /// whole utterance at once). Phonemes can differ from `synthesize` where
    /// RenikudPlus uses cross-sentence context (1 word in the 45 golden
    /// segments).
    public func synthesizeStream(_ text: String, options: SynthesisOptions = SynthesisOptions(),
                                 firstChunkMaxChars: Int = 90) -> AsyncThrowingStream<AudioChunk, Error> {
        AsyncThrowingStream { continuation in
            let cancelled = CancelFlag()
            continuation.onTermination = { _ in cancelled.set() }
            queue.async {
                do {
                    let synth = try self.synthLocked()
                    let style = try self.voiceLocked(options.voice)
                    let g = self.g2pLocked()
                    let lang: String
                    switch options.language {
                    case .auto: lang = EnglishAutoTagger.containsHebrew(text) ? "he" : "en"
                    case .hebrew: lang = "he"
                    case .english: lang = "en"
                    }
                    let tagged = (lang == "he" && options.autoTagEnglish) ? EnglishAutoTagger.tag(text) : text
                    let normalized = options.normalizeText
                        ? TextNormalizer.prepareTextForSynthesis(tagged, lang: lang, markSlow: true) : tagged
                    let paceDefault = PhonemeTextProcessor.inlineLangPair.search(normalized) != nil
                        ? BlueSynthesizer.defaultMixedPaceBlend : 0.0
                    var rng = options.seed.map { NumpyRandom(seed: $0) } ?? NumpyRandom()
                    var sentences: [(String, Bool)] = []
                    for (seg, isSlow) in TextNormalizer.splitSlowSegments(normalized) {
                        if isSlow {
                            sentences.append((seg, true))
                        } else {
                            for s in Self.sourceSentenceRe.split(seg) where !Py.strip(s).isEmpty {
                                sentences.append((s, false))
                            }
                        }
                    }
                    var index = 0
                    var prevSlow = false
                    for (si, (sentence, isSlow)) in sentences.enumerated() {
                        if cancelled.isSet { break }
                        let tG2P = DispatchTime.now().uptimeNanoseconds
                        let ph = PhonemeTextProcessor.stripLangTags(try g.phonemize(sentence, lang: lang))
                        Trace.log("g2p", tG2P, Py.len(sentence))
                        var pieces = TextChunker.chunk(ph, maxLen: 300)
                        if index == 0, let first = pieces.first {
                            pieces = Self.splitFirstChunk(first, maxChars: firstChunkMaxChars) + pieces.dropFirst()
                        }
                        for (pi, piece) in pieces.enumerated() {
                            if cancelled.isSet { break }
                            let tSyn = DispatchTime.now().uptimeNanoseconds
                            var r = try self.inferChunk(synth, piece, lang, style, isSlow, options, paceDefault, &rng)
                            Trace.log("synth", tSyn, Py.len(piece))
                            var samples: [Float] = []
                            if index > 0 {
                                let gap = (isSlow || prevSlow) ? Double(TextNormalizer.slowSilence)
                                    : options.silenceBetweenChunks
                                samples = [Float](repeating: 0, count: Int(gap * Double(synth.sampleRate)))
                            }
                            if let lim = options.peakLimit { BlueSynthesizer.limitPeak(&r.wav, lim) }
                            samples += r.wav
                            let isFinal = si == sentences.count - 1 && pi == pieces.count - 1
                            continuation.yield(AudioChunk(index: index, phonemes: piece, samples: samples,
                                                          sampleRate: synth.sampleRate, isFinal: isFinal))
                            index += 1
                        }
                        prevSlow = isSlow
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}

/// `BLUETTS_TRACE=1` prints per-step timings to stderr (benchmarking aid).
enum Trace {
    static let enabled = ProcessInfo.processInfo.environment["BLUETTS_TRACE"] == "1"

    static func log(_ what: String, _ start: UInt64, _ size: Int) {
        guard enabled else { return }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        FileHandle.standardError.write("[trace] \(what) \(size) chars \(String(format: "%.0f", ms)) ms\n".data(using: .utf8)!)
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}

// MARK: - Testing hooks

extension BlueTTS {
    /// Synthesize one already-phonemized chunk with injected noise
    /// (`[144 * frames]`, channel-major). Used to compare against Python with
    /// identical noise; not part of the app-facing API.
    public func _synthesizeChunkForTesting(phonemes: String, language: String = "he", voice: String? = nil,
                                           noise: [Float]?, seed: UInt32 = 0,
                                           options: SynthesisOptions = SynthesisOptions()) async throws -> [Float] {
        try await onQueue {
            let synth = try self.synthLocked()
            let style = try self.voiceLocked(voice)
            var rng = NumpyRandom(seed: seed)
            let r = try synth.infer(phonemes, lang: language, style: style, totalSteps: options.totalSteps,
                                    speed: options.speed, cfgScale: options.cfgScale,
                                    paceBlend: options.paceBlend ?? 0, paceDptRef: options.paceDptRef,
                                    rng: &rng, noiseOverride: noise)
            return r.wav
        }
    }

    /// Token ids the acoustic model would see for a phoneme chunk.
    public func _tokenIdsForTesting(phonemes: String, language: String = "he") async throws -> [Int64] {
        try await onQueue { try self.synthLocked().unicode.encode(phonemes, lang: language) }
    }
}
