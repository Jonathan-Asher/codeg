import Foundation

/// Port of `blue_onnx.TextToSpeech` (BlueTTS 2.5, style-vector duration head,
/// classifier-free guidance from `uncond.npz`, de-normalizing vocoder input).
final class BlueSynthesizer: @unchecked Sendable {
    static let durationPaceDptRef = 0.0625
    static let defaultMixedPaceBlend = 0.25
    static let defaultCfgScale: Float = 4.0

    let sampleRate: Int
    let baseChunkSize: Int
    let chunkCompressFactor: Int
    let latentDim: Int

    private let dp: OrtSession
    private let textEncoder: OrtSession
    private let vectorEstimator: OrtSession
    private let vocoder: OrtSession
    let unicode: UnicodeProcessor
    private let uText: Tensor<Float>?
    private let uRef: Tensor<Float>?
    private let latentMean: [Float]?
    private let latentStd: [Float]?
    private let normalizerScale: Double
    private let vfHasCfgInput: Bool
    private let vocoderInputChannels: Int?

    struct Paths {
        var durationPredictor: URL
        var textEncoder: URL
        var vectorEstimator: URL
        var vocoder: URL
        var config: URL
        var vocab: URL
        var stats: URL?
        var uncond: URL?
    }

    struct Providers {
        var durationPredictor: ExecutionProvider = .cpu
        var textEncoder: ExecutionProvider = .cpu
        var vectorEstimator: ExecutionProvider = .cpu
        var vocoder: ExecutionProvider = .cpu
    }

    init(paths: Paths, threads: Int, providers: Providers = Providers()) throws {
        let cfg = try JSONSerialization.jsonObject(with: Data(contentsOf: paths.config)) as? [String: Any] ?? [:]
        let ae = cfg["ae"] as? [String: Any] ?? [:]
        let ttl = cfg["ttl"] as? [String: Any] ?? [:]
        sampleRate = ae["sample_rate"] as? Int ?? 44100
        baseChunkSize = ae["base_chunk_size"] as? Int ?? 512
        chunkCompressFactor = ttl["chunk_compress_factor"] as? Int ?? 6
        latentDim = ttl["latent_dim"] as? Int ?? 24

        dp = try OrtSession(path: paths.durationPredictor, threads: threads, provider: providers.durationPredictor)
        textEncoder = try OrtSession(path: paths.textEncoder, threads: threads, provider: providers.textEncoder)
        vectorEstimator = try OrtSession(path: paths.vectorEstimator, threads: threads, provider: providers.vectorEstimator)
        vocoder = try OrtSession(path: paths.vocoder, threads: threads, provider: providers.vocoder)
        unicode = try UnicodeProcessor(vocabURL: paths.vocab)
        vfHasCfgInput = vectorEstimator.inputNames.contains("cfg_scale")
        let vocShapes = try OnnxMetadataReader.inputShapes(paths.vocoder)
        let firstInput = vocoder.inputNames.contains("latent") ? "latent" : (vocoder.inputNames.first ?? "latent")
        vocoderInputChannels = (vocShapes[firstInput]?.count ?? 0) > 1 ? vocShapes[firstInput]![1] : nil

        if let u = paths.uncond, FileManager.default.fileExists(atPath: u.path) {
            let z = try NPZ.load(u)
            uText = z["u_text"]
            uRef = z["u_ref"]
        } else {
            uText = nil
            uRef = nil
        }
        if let s = paths.stats, FileManager.default.fileExists(atPath: s.path) {
            let z = try NPZ.load(s)
            latentMean = z["mean"]?.data
            latentStd = z["std"]?.data
            normalizerScale = z["normalizer_scale"].map { Double($0.data[0]) } ?? 1.0
        } else {
            latentMean = nil
            latentStd = nil
            normalizerScale = 1.0
        }
    }

    /// `blend_duration_pace` for a batch of one.
    static func blendDurationPace(_ dur: Float, tokens: Int, paceBlend: Double, paceDptRef: Double) -> Float {
        let b = min(max(paceBlend, 0.0), 1.0)
        if b <= 0 { return dur }
        let n = max(Double(tokens), 1.0)
        let dpt = Double(dur) / n
        let dpt2 = (1.0 - b) * dpt + b * paceDptRef
        return Float(dpt2 * n)
    }

    /// `latent_frames_for_duration`.
    func latentFrames(_ seconds: Float) -> Int {
        let frameLen = baseChunkSize * chunkCompressFactor
        return max(0, (Int(Double(seconds) * Double(sampleRate)) + frameLen - 1) / frameLen)
    }

    /// `_prepare_vocoder_latent`: undo latent normalization and the channel-major
    /// compression, (1, ldim*f, T) -> (1, ldim, T*f), when the vocoder wants it.
    private func vocoderLatent(_ xt: [Float], frames t: Int, vocoderChannels: Int?) throws -> Tensor<Float> {
        let f = chunkCompressFactor, ldim = latentDim
        if vocoderChannels != ldim {
            return Tensor(shape: [1, ldim * f, t], data: xt)
        }
        guard let mean = latentMean, let std = latentStd else {
            throw OrtError.badOutputType("vocoder takes \(ldim)-channel latents but stats.npz is missing")
        }
        let scale = Float(normalizerScale)
        var out = [Float](repeating: 0, count: ldim * f * t)
        for c in 0..<ldim {
            for ff in 0..<f {
                let ch = c * f + ff
                let m = mean[ch], s = std[ch]
                for tt in 0..<t {
                    let z = (xt[ch * t + tt] / scale) * s + m
                    out[c * (t * f) + tt * f + ff] = z
                }
            }
        }
        return Tensor(shape: [1, ldim, t * f], data: out)
    }

    struct ChunkResult {
        var wav: [Float]
        var duration: Float
    }

    /// `_infer` for one chunk of phonemes.
    func infer(_ chunk: String, lang: String, style: VoiceStyle, totalSteps: Int, speed: Double,
               cfgScale: Float, paceBlend: Double, paceDptRef: Double?, rng: inout NumpyRandom,
               noiseOverride: [Float]? = nil) throws -> ChunkResult {
        let ids = unicode.encode(chunk, lang: lang)
        let T = ids.count
        let textIds = Tensor<Int64>(shape: [1, T], data: ids)
        let textMask = Tensor<Float>(shape: [1, 1, T], data: [Float](repeating: 1, count: T))
        let durOut = try dp.run([
            "text_ids": .int64(textIds), "style_dp": .float(style.dp), "text_mask": .float(textMask),
        ])
        var dur = durOut.values.first!.data[0]
        dur = Self.blendDurationPace(dur, tokens: T, paceBlend: paceBlend,
                                     paceDptRef: paceDptRef ?? Self.durationPaceDptRef)
        dur = dur / Float(max(speed, 1e-6))

        let textEmb = try textEncoder.run([
            "text_ids": .int64(textIds), "style_ttl": .float(style.ttl), "text_mask": .float(textMask),
        ]).values.first!

        // sample_noisy_latent
        let wavLength = Int(dur * Float(sampleRate))  // float32 product, truncated (astype int64)
        let latentLen = latentFrames(dur)
        let latentCh = latentDim * chunkCompressFactor
        let frameLen = baseChunkSize * chunkCompressFactor
        var xt = noiseOverride ?? rng.randn(latentCh * latentLen)
        let validFrames = (wavLength + frameLen - 1) / frameLen
        var latentMaskData = [Float](repeating: 0, count: latentLen)
        for i in 0..<min(validFrames, latentLen) { latentMaskData[i] = 1 }
        for c in 0..<latentCh {
            for i in 0..<latentLen { xt[c * latentLen + i] *= latentMaskData[i] }
        }
        let latentMask = Tensor<Float>(shape: [1, 1, latentLen], data: latentMaskData)
        let totalStep = Tensor<Float>(shape: [1], data: [Float(totalSteps)])
        let useCfg = cfgScale != 1.0 && uText != nil && uRef != nil
        let uMask = Tensor<Float>(shape: [1, 1, 1], data: [1])

        for step in 0..<totalSteps {
            let cur = Tensor<Float>(shape: [1], data: [Float(step)])
            let noisy = Tensor<Float>(shape: [1, latentCh, latentLen], data: xt)
            var cond: [String: OrtSession.Input] = [
                "noisy_latent": .float(noisy), "text_emb": .float(textEmb), "style_ttl": .float(style.ttl),
                "text_mask": .float(textMask), "latent_mask": .float(latentMask),
                "current_step": .float(cur), "total_step": .float(totalStep),
            ]
            if vfHasCfgInput {
                cond["cfg_scale"] = .float(Tensor(shape: [1], data: [cfgScale]))
                xt = try vectorEstimator.run(cond).values.first!.data
            } else if useCfg, let uText, let uRef {
                let vCond = try vectorEstimator.run(cond).values.first!.data
                let uncond: [String: OrtSession.Input] = [
                    "noisy_latent": .float(noisy), "text_emb": .float(uText), "style_ttl": .float(uRef),
                    "text_mask": .float(uMask), "latent_mask": .float(latentMask),
                    "current_step": .float(cur), "total_step": .float(totalStep),
                ]
                let vUncond = try vectorEstimator.run(uncond).values.first!.data
                for i in xt.indices { xt[i] = vUncond[i] + cfgScale * (vCond[i] - vUncond[i]) }
            } else {
                xt = try vectorEstimator.run(cond).values.first!.data
            }
        }
        let vocIn = try vocoderLatent(xt, frames: latentLen, vocoderChannels: vocoderInputChannels)
        var wav = try vocoder.run(["latent": .float(vocIn)]).values.first!.data
        if wav.count > 2 * frameLen {
            wav = Array(wav[frameLen..<(wav.count - frameLen)])
        }
        return ChunkResult(wav: wav, duration: dur)
    }

    /// `limit_peak`.
    static func limitPeak(_ audio: inout [Float], _ limit: Float) {
        guard !audio.isEmpty, audio.allSatisfy({ $0.isFinite }) else { return }
        var peak: Float = 0
        for x in audio { peak = max(peak, abs(x)) }
        if peak <= limit || peak < 1e-9 { return }
        let k = limit / peak
        for i in audio.indices { audio[i] *= k }
    }
}
