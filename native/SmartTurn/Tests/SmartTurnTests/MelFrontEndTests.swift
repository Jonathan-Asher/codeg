import Foundation
import Testing
@testable import SmartTurn

/// The synthetic signal of scripts/mel_reference.py: three sines under a slow
/// envelope plus noise from a 32-bit LCG, built in double precision and
/// rounded to Float32 the same way.
enum TestSignal {
    static func make(seconds: Double, seed: UInt32) -> [Float] {
        let count = Int((seconds * 16_000).rounded())
        var state = seed
        var out = [Float](repeating: 0, count: count)
        for i in 0..<count {
            state = state &* 1_664_525 &+ 1_013_904_223
            let noise = Double(state >> 8) / 16_777_216.0 - 0.5
            let t = Double(i) / 16_000
            let envelope = 0.55 + 0.45 * sin(2 * Double.pi * 0.7 * t)
            let x = 0.30 * sin(2 * Double.pi * 220.0 * t)
                + 0.20 * sin(2 * Double.pi * 1375.0 * t + 0.5)
                + 0.10 * sin(2 * Double.pi * 3150.0 * t)
            out[i] = Float(envelope * x + 0.05 * noise)
        }
        return out
    }
}

/// Reference values from transformers' WhisperFeatureExtractor, called as
/// pipecat-ai/smart-turn's inference.py calls it (Fixtures/mel-reference.json,
/// written by scripts/mel_reference.py).
struct Reference: Decodable {
    struct Case: Decodable {
        let name: String
        let seconds: Double
        let seed: UInt32
        let values: [Float]
        let mean: Float
        let min: Float
        let max: Float
        let probability: Float?
    }

    let frames: [Int]
    let cases: [Case]
    let filterBins: [Int]
    let filterValues: [Float]
    let filterColumnSums: [Float]

    static let shared: Reference = {
        let url = Bundle.module.url(forResource: "mel-reference", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONDecoder().decode(Reference.self, from: Data(contentsOf: url))
    }()
}

struct MelFrontEndTests {
    let frontEnd = WhisperLogMel()

    @Test func shapeIsEightSecondsOfWhisperFrames() {
        #expect(frontEnd.sampleCount == 128_000)
        #expect(frontEnd.frameCount == 800)
        #expect(frontEnd.melFilters.count == 201 * 80)
        #expect(frontEnd.features(TestSignal.make(seconds: 1, seed: 3)).count == 80 * 800)
    }

    @Test func melFiltersMatchTransformers() {
        let reference = Reference.shared
        var worst: Float = 0
        for (row, bin) in reference.filterBins.enumerated() {
            for mel in 0..<80 {
                let expected = reference.filterValues[row * 80 + mel]
                worst = max(worst, abs(frontEnd.melFilters[bin * 80 + mel] - expected))
            }
        }
        #expect(worst < 1e-7, "largest filter difference \(worst)")
        for mel in 0..<80 {
            let sum = (0..<201).reduce(Float(0)) { $0 + frontEnd.melFilters[$1 * 80 + mel] }
            #expect(abs(sum - reference.filterColumnSums[mel]) < 1e-6, "filter \(mel): \(sum)")
        }
    }

    @Test(arguments: ["8s", "3s-padded", "10s-truncated"])
    func featuresMatchTransformers(_ name: String) throws {
        let reference = Reference.shared
        let item = try #require(reference.cases.first { $0.name == name })
        let features = frontEnd.features(TestSignal.make(seconds: item.seconds, seed: item.seed))
        var worst: Float = 0
        for (i, frame) in reference.frames.enumerated() {
            for mel in 0..<80 {
                let got = features[mel * 800 + frame]
                worst = max(worst, abs(got - item.values[i * 80 + mel]))
            }
        }
        // Float32 matrix DFT against numpy's float64 FFT. Measured: at most
        // 1.6e-5. The values are log10 energies over 4, so 1e-4 is a relative
        // energy error of about 0.1%.
        #expect(worst < 1e-4, "\(name): largest difference \(worst)")
        let mean = features.reduce(0, +) / Float(features.count)
        #expect(abs(mean - item.mean) < 1e-4, "\(name): mean \(mean) vs \(item.mean)")
        #expect(abs(features.min()! - item.min) < 1e-3, "\(name): min \(features.min()!) vs \(item.min)")
        #expect(abs(features.max()! - item.max) < 1e-3, "\(name): max \(features.max()!) vs \(item.max)")
    }

    @Test func windowKeepsTheLastEightSecondsAndPadsAtTheFront() {
        let short: [Float] = [1, 2, 3]
        let padded = frontEnd.window(short)
        #expect(padded.count == 128_000)
        #expect(padded.suffix(3) == [1, 2, 3])
        #expect(padded.prefix(127_997).allSatisfy { $0 == 0 })

        let long = (0..<130_000).map { Float($0) }
        let kept = frontEnd.window(long)
        #expect(kept.count == 128_000)
        #expect(kept.first == 2_000)
        #expect(kept.last == 129_999)
    }

    @Test func silenceGivesTheFloorEverywhere() {
        let features = frontEnd.features([Float](repeating: 0, count: 16_000))
        #expect(features.allSatisfy { $0 == -1.5 })
    }

    @Test func normalizationIsOverTheWholeWindow() {
        let x: [Float] = [0, 0, 2, 4]
        let normalized = WhisperLogMel.normalized(x)
        let mean = normalized.reduce(0, +) / 4
        let variance = normalized.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / 4
        #expect(abs(mean) < 1e-6)
        #expect(abs(variance - 1) < 1e-5)
        #expect(normalized[0] == normalized[1])
        #expect(normalized[0] < 0)
    }
}

/// The classifier against the reference pipeline's probabilities. Needs the
/// model file: SMART_TURN_MODEL=/path/to/smart-turn-v3.2-cpu.onnx.
///
/// The model quantizes its activations to int8 at run time, which amplifies
/// the front end's float rounding near p = 0.5: on "10s-truncated" (0.55 in
/// the reference) the features here, 1.6e-5 from the reference's at most,
/// give 0.52 on both ONNX Runtime 1.30 (this package) and 1.31 (Python). The
/// other two cases agree to 1e-4. So the tolerance is 0.05: it catches a
/// wrong layout or normalization, which moves these by far more.
struct ClassifierTests {
    static let modelPath = ProcessInfo.processInfo.environment["SMART_TURN_MODEL"]

    @Test(.enabled(if: modelPath != nil))
    func probabilitiesMatchTheReferencePipeline() async throws {
        let classifier = try SmartTurnClassifier(modelURL: URL(fileURLWithPath: Self.modelPath!), threads: 2)
        for item in Reference.shared.cases {
            let expected = try #require(item.probability)
            let audio = TestSignal.make(seconds: item.seconds, seed: item.seed)
            let got = try #require(await classifier.probability(last8s: audio))
            #expect(abs(got - expected) < 0.05, "\(item.name): \(got) vs \(expected)")
        }
        #expect(await classifier.probability(last8s: []) == nil)
    }

    @Test func aMissingModelThrows() {
        #expect(throws: SmartTurnError.self) {
            _ = try SmartTurnClassifier(modelURL: URL(fileURLWithPath: "/nonexistent/smart-turn.onnx"))
        }
    }
}
