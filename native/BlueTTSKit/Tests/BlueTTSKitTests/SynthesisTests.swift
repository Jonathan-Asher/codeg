import Foundation
import Testing
@testable import BlueTTSKit

struct SynthGolden: Decodable {
    let text: String
    let seed: UInt32
    let sampleRate: Int
    let samples: Int
    let rms: Double
}

@Suite("Synthesis")
struct SynthesisTests {
    /// `np.random.seed(1234); np.random.randn(6)`.
    @Test func numpyRandomMatchesNumpy() {
        var r = NumpyRandom(seed: 1234)
        let want: [Float] = [0.47143515944480896, -1.1909756660461426, 1.4327069520950317,
                             -0.3126519024372101, -0.720588743686676, 0.8871629238128662]
        #expect(r.randn(6) == want)
    }

    @Test func npzReader() throws {
        let paths = try #require(TestModels.paths)
        let stats = try NPZ.load(paths.blueDirectory.appendingPathComponent("stats.npz"))
        #expect(stats["mean"]?.shape == [1, 144, 1])
        #expect(stats["normalizer_scale"]?.data.count == 1)
        let uncond = try NPZ.load(paths.blueDirectory.appendingPathComponent("uncond.npz"))
        #expect(uncond["u_ref"]?.shape == [1, 50, 256])
    }

    @Test func vocoderInputShape() throws {
        let paths = try #require(TestModels.paths)
        let shapes = try OnnxMetadataReader.inputShapes(paths.blueDirectory.appendingPathComponent("vocoder.onnx"))
        #expect(shapes["latent"] == [1, 24, nil])
    }

    /// Same seed as Python => same noise => the same waveform, up to ONNX Runtime
    /// float noise and 16-bit quantization of the stored reference.
    @Test(.enabled(if: TestModels.available, "model files not found"))
    func seededSynthesisMatchesPython() async throws {
        let tts = try #require(TestModels.tts)
        let g = try Golden.load("synth-seed1234.json", as: SynthGolden.self)
        let raw = try Data(contentsOf: Golden.dir.appendingPathComponent("synth-seed1234.pcm16"))
        let ref = raw.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Float($0) / 32767 }
        var o = SynthesisOptions()
        o.seed = g.seed
        let audio = try await tts.synthesize(g.text, options: o)
        #expect(audio.sampleRate == g.sampleRate)
        #expect(audio.samples.count == g.samples)
        let n = min(ref.count, audio.samples.count)
        var maxDiff: Float = 0, dot = 0.0, na = 0.0, nb = 0.0
        for i in 0..<n {
            maxDiff = max(maxDiff, abs(ref[i] - audio.samples[i]))
            dot += Double(ref[i]) * Double(audio.samples[i])
            na += Double(ref[i]) * Double(ref[i])
            nb += Double(audio.samples[i]) * Double(audio.samples[i])
        }
        let corr = dot / (na.squareRoot() * nb.squareRoot())
        #expect(maxDiff < 2e-3, "max |diff| \(maxDiff)")
        #expect(corr > 0.9999, "correlation \(corr)")
    }

    @Test(.enabled(if: TestModels.available, "model files not found"))
    func streamingYieldsSentences() async throws {
        let tts = try #require(TestModels.tts)
        var o = SynthesisOptions()
        o.seed = 7
        var chunks: [AudioChunk] = []
        for try await c in tts.synthesizeStream("בדקתי את זה. הכל עובד עם CI ירוק!", options: o) {
            chunks.append(c)
        }
        #expect(chunks.count == 2)
        #expect(chunks.map(\.index) == Array(0..<chunks.count))
        #expect(chunks.last?.isFinal == true)
        #expect(chunks.dropLast().allSatisfy { !$0.isFinal })
        #expect(chunks.allSatisfy { $0.duration > 0.3 && $0.samples.allSatisfy { abs($0) <= 0.95 + 1e-6 } })
    }

    @Test func firstChunkSplitsAtComma() {
        let long = "ʔidkˈanti ʔˈet hˈa dˈɑːkɚfˌaɪl kedˈej livnˈot ʔˈam bˈɪldks laplatfˈoʁma lˈɪnʌks slˈæʃ , vehaʔimˈadʒ ʔalˈa lˈe ɹˈɛdʒɪstɹi behatslaχˈa."
        let parts = BlueTTS.splitFirstChunk(long, maxChars: 90)
        #expect(parts.count == 2)
        #expect(parts.joined(separator: " ") == long)
        #expect(BlueTTS.splitFirstChunk("short one.", maxChars: 90) == ["short one."])
    }
}
