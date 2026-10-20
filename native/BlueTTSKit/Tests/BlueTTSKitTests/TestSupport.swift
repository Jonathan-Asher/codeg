import Foundation
import Testing
@testable import BlueTTSKit
import BlueTTSEspeak

/// Golden JSON written by scripts/golden/make_golden.py from the Python reference.
enum Golden {
    static let dir = Bundle.module.url(forResource: "Golden", withExtension: nil)!

    static func load<T: Decodable>(_ name: String, as: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(contentsOf: dir.appendingPathComponent(name)))
    }

    struct PipelineCase: Decodable, Sendable, CustomTestStringConvertible {
        struct Segment: Decodable, Sendable {
            let text: String
            let isSlow: Bool
            let phonemes: String
            let chunks: [String]
            let tokenIds: [[Int64]]
        }
        let id: String
        let group: String
        let kind: String
        let language: String
        let plain: String
        let tagged: String
        let normalized: String
        let segments: [Segment]
        let spikePhon: String
        var testDescription: String { id }
    }

    static let pipeline: [PipelineCase] = (try? load("pipeline.json", as: [PipelineCase].self)) ?? []
}

/// Model files: `BLUETTS_MODEL_DIR` (README layout), else the spike checkout in /tmp/tts-spike.
enum TestModels {
    static let paths: BlueTTSModelPaths? = {
        let fm = FileManager.default
        if let root = ProcessInfo.processInfo.environment["BLUETTS_MODEL_DIR"] {
            let p = BlueTTSModelPaths(root: URL(fileURLWithPath: root))
            return fm.fileExists(atPath: p.renikudModel.path) ? p : nil
        }
        let spike = URL(fileURLWithPath: "/tmp/tts-spike")
        let p = BlueTTSModelPaths(
            blueDirectory: spike.appendingPathComponent("models/blue25"),
            voicesDirectories: [spike.appendingPathComponent("Light-BlueTTS/voices"),
                                spike.appendingPathComponent("models/blue25/voices")],
            renikudModel: spike.appendingPathComponent("models/renikud/model_int8.onnx"))
        return fm.fileExists(atPath: p.renikudModel.path) ? p : nil
    }()

    static var available: Bool { paths != nil }

    static let espeak: EspeakPhonemizer? = try? EspeakPhonemizer()

    /// One shared engine: RenikudPlus is 300 MB, load it once.
    static let tts: BlueTTS? = paths.map { BlueTTS(paths: $0, englishPhonemizer: espeak) }

    static let vocab: UnicodeProcessor? = paths.flatMap {
        try? UnicodeProcessor(vocabURL: $0.blueDirectory.appendingPathComponent("vocab.json"))
    }
}
