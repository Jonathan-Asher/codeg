import Accelerate
import Foundation

/// Whisper's log-mel front end at Smart Turn's settings, in Accelerate.
///
/// The same computation as transformers' `WhisperFeatureExtractor(chunk_length: 8)`
/// called the way pipecat-ai/smart-turn's `inference.py` calls it
/// (`padding: "max_length", max_length: 128_000, truncation: true,
/// do_normalize: true`):
///
/// 1. the last 8 s of 16 kHz mono audio, zero-padded at the front;
/// 2. zero mean and unit variance over all 128,000 samples, the padding
///    included: `(x - mean) / sqrt(var + 1e-7)`;
/// 3. a centered STFT: reflect padding of 200 samples on each side, a
///    400-sample periodic Hann window, hop 160, a 400-point DFT (201 bins),
///    power spectrum; the last of the 801 frames is dropped;
/// 4. 80 Slaney mel filters (Slaney scale, 0–8 kHz, area-normalized);
/// 5. `log10(max(mel, 1e-10))`, floored at the maximum minus 8, then
///    `(x + 4) / 4`.
///
/// The output is `melCount × frameCount` (80 × 800) Float32, mel-major: the
/// model's `input_features` tensor without the batch dimension.
///
/// 400 is not a length vDSP's FFT supports, so the DFT is a matrix product
/// with a precomputed basis (the window folded in): about 130 M
/// multiply-adds per call, a few milliseconds.
public struct WhisperLogMel: Sendable {
    public static let sampleRate = 16_000
    public static let fftLength = 400
    public static let hopLength = 160
    public static let melCount = 80
    public static let binCount = fftLength / 2 + 1

    /// Length of the window the model sees.
    public let seconds: Int
    public var sampleCount: Int { seconds * Self.sampleRate }
    public var frameCount: Int { sampleCount / Self.hopLength }

    /// `window[n] * cos(2πkn/N)` at `[n * binCount + k]`.
    private let cosBasis: [Float]
    /// `window[n] * sin(2πkn/N)` at `[n * binCount + k]` (the sign drops out
    /// of the power spectrum).
    private let sinBasis: [Float]
    /// The mel filter bank at `[k * melCount + m]`, laid out as transformers'
    /// `mel_filters` (201 × 80).
    public let melFilters: [Float]

    public init(seconds: Int = 8) {
        precondition(seconds > 0)
        self.seconds = seconds
        let n = Self.fftLength, bins = Self.binCount
        var cosBasis = [Float](repeating: 0, count: n * bins)
        var sinBasis = [Float](repeating: 0, count: n * bins)
        for i in 0..<n {
            // Periodic Hann, as np.hanning(N + 1)[:-1] and torch.hann_window(N).
            let w = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n))
            for k in 0..<bins {
                // (k * i) mod n keeps the angle small, so cos/sin stay exact.
                let angle = 2 * Double.pi * Double((k * i) % n) / Double(n)
                cosBasis[i * bins + k] = Float(w * cos(angle))
                sinBasis[i * bins + k] = Float(w * sin(angle))
            }
        }
        self.cosBasis = cosBasis
        self.sinBasis = sinBasis
        melFilters = Self.slaneyMelFilters(
            binCount: bins, melCount: Self.melCount, sampleRate: Double(Self.sampleRate), maxFrequency: 8_000)
    }

    /// The last `seconds` of `audio`, zero-padded at the front to exactly
    /// `sampleCount` samples, as smart-turn's `truncate_audio_to_last_n_seconds`.
    public func window(_ audio: [Float]) -> [Float] {
        let n = sampleCount
        if audio.count >= n { return Array(audio.suffix(n)) }
        return [Float](repeating: 0, count: n - audio.count) + audio
    }

    /// Features for up to `seconds` of 16 kHz mono audio (longer input keeps
    /// its end). `melCount × frameCount` values, mel-major.
    public func features(_ audio: [Float]) -> [Float] {
        let samples = Self.normalized(window(audio))
        let n = Self.fftLength, bins = Self.binCount, hop = Self.hopLength
        let frames = frameCount
        let pad = n / 2

        // Reflect padding (numpy's "reflect": the edge sample is not repeated).
        var padded = [Float](repeating: 0, count: samples.count + 2 * pad)
        for i in 0..<pad {
            padded[pad - 1 - i] = samples[i + 1]
            padded[pad + samples.count + i] = samples[samples.count - 2 - i]
        }
        padded.withUnsafeMutableBufferPointer { dst in
            samples.withUnsafeBufferPointer { src in
                (dst.baseAddress! + pad).update(from: src.baseAddress!, count: src.count)
            }
        }

        // Frames as rows (frames × n); the window lives in the basis.
        var framed = [Float](repeating: 0, count: frames * n)
        framed.withUnsafeMutableBufferPointer { dst in
            padded.withUnsafeBufferPointer { src in
                for t in 0..<frames {
                    (dst.baseAddress! + t * n).update(from: src.baseAddress! + t * hop, count: n)
                }
            }
        }

        // Power spectrum (frames × bins) = (F·C)² + (F·S)².
        var re = [Float](repeating: 0, count: frames * bins)
        var im = [Float](repeating: 0, count: frames * bins)
        vDSP_mmul(framed, 1, cosBasis, 1, &re, 1, vDSP_Length(frames), vDSP_Length(bins), vDSP_Length(n))
        vDSP_mmul(framed, 1, sinBasis, 1, &im, 1, vDSP_Length(frames), vDSP_Length(bins), vDSP_Length(n))
        var power = [Float](repeating: 0, count: frames * bins)
        power.withUnsafeMutableBufferPointer { p in
            let n = vDSP_Length(p.count)
            vDSP_vsq(re, 1, p.baseAddress!, 1, n)
            vDSP_vma(im, 1, im, 1, p.baseAddress!, 1, p.baseAddress!, 1, n)
        }

        // Mel energies: (frames × bins)·(bins × mels), then mel-major.
        let mels = Self.melCount
        var melByFrame = [Float](repeating: 0, count: frames * mels)
        vDSP_mmul(power, 1, melFilters, 1, &melByFrame, 1, vDSP_Length(frames), vDSP_Length(mels), vDSP_Length(bins))
        var out = [Float](repeating: 0, count: mels * frames)
        vDSP_mtrans(melByFrame, 1, &out, 1, vDSP_Length(mels), vDSP_Length(frames))

        // log10(max(mel, 1e-10)), floor at max - 8, then (x + 4) / 4.
        out.withUnsafeMutableBufferPointer { p in
            let x = p.baseAddress!, count = vDSP_Length(p.count)
            var floor: Float = 1e-10
            vDSP_vthr(x, 1, &floor, x, 1, count)
            var n32 = Int32(p.count)
            vvlog10f(x, x, &n32)
            var top: Float = 0
            vDSP_maxv(x, 1, &top, count)
            var low = top - 8
            vDSP_vthr(x, 1, &low, x, 1, count)
            var scale: Float = 0.25, offset: Float = 1
            vDSP_vsmsa(x, 1, &scale, &offset, x, 1, count)
        }
        return out
    }

    /// `(x - mean) / sqrt(var + 1e-7)` over the whole window, as transformers'
    /// `zero_mean_unit_var_norm` (population variance), in double precision.
    static func normalized(_ x: [Float]) -> [Float] {
        guard !x.isEmpty else { return x }
        var sum = 0.0
        for v in x { sum += Double(v) }
        let mean = sum / Double(x.count)
        var squares = 0.0
        for v in x {
            let d = Double(v) - mean
            squares += d * d
        }
        let scale = 1 / (squares / Double(x.count) + 1e-7).squareRoot()
        return x.map { Float((Double($0) - mean) * scale) }
    }

    // MARK: - Mel filter bank (transformers' mel_filter_bank, norm and scale "slaney")

    static func hertzToMel(_ f: Double) -> Double {
        let minLogHertz = 1_000.0, minLogMel = 15.0, logStep = 27.0 / log(6.4)
        return f >= minLogHertz ? minLogMel + log(f / minLogHertz) * logStep : 3 * f / 200
    }

    static func melToHertz(_ m: Double) -> Double {
        let minLogHertz = 1_000.0, minLogMel = 15.0, logStep = log(6.4) / 27.0
        return m >= minLogMel ? minLogHertz * exp(logStep * (m - minLogMel)) : 200 * m / 3
    }

    /// `[k * melCount + m]`: weight of DFT bin k in mel filter m.
    static func slaneyMelFilters(binCount: Int, melCount: Int, sampleRate: Double, maxFrequency: Double) -> [Float] {
        let melMin = hertzToMel(0), melMax = hertzToMel(maxFrequency)
        let edges = (0..<(melCount + 2)).map { i in
            melToHertz(melMin + (melMax - melMin) * Double(i) / Double(melCount + 1))
        }
        let nyquist = Double(Int(sampleRate) / 2)
        let fftFreqs = (0..<binCount).map { nyquist * Double($0) / Double(binCount - 1) }
        var filters = [Float](repeating: 0, count: binCount * melCount)
        for k in 0..<binCount {
            for m in 0..<melCount {
                let down = (fftFreqs[k] - edges[m]) / (edges[m + 1] - edges[m])
                let up = (edges[m + 2] - fftFreqs[k]) / (edges[m + 2] - edges[m + 1])
                let weight = max(0, min(down, up))
                let enorm = 2 / (edges[m + 2] - edges[m])
                filters[k * melCount + m] = Float(weight * enorm)
            }
        }
        return filters
    }
}
