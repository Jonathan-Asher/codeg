import Foundation
import Testing
@testable import SherpaOnnx

struct LinkTests {
    /// sherpa-onnx reports the runtime it calls into: BlueTTSKit's 1.30.0,
    /// not a copy of its own.
    @Test func runsOnBlueTTSKitsOnnxRuntime() {
        let versions = StreamingTransducerRecognizer.versions
        #expect(versions.sherpaOnnx == "2.0.1")
        #expect(versions.onnxRuntime == "1.30.0")
    }

    @Test func missingFilesThrowBeforeLoading() {
        let dir = URL(fileURLWithPath: "/nonexistent")
        let files = TransducerModelFiles(encoder: dir.appendingPathComponent("e.onnx"), decoder: dir.appendingPathComponent("d.onnx"),
                                         joiner: dir.appendingPathComponent("j.onnx"), tokens: dir.appendingPathComponent("t.txt"))
        #expect(throws: SherpaOnnxError.modelFileMissing("/nonexistent/e.onnx")) {
            _ = try StreamingTransducerRecognizer(files: files)
        }
    }

    @Test func partsMapToFilesInTheDirectory() throws {
        let dir = URL(fileURLWithPath: "/models/he-zipformer-stream")
        let files = try TransducerModelFiles(directory: dir, parts: [
            "encoder": "e.int8.onnx", "decoder": "d.int8.onnx", "joiner": "j.int8.onnx", "tokens": "tokens.txt",
        ])
        #expect(files.encoder.path == "/models/he-zipformer-stream/e.int8.onnx")
        #expect(files.tokens.lastPathComponent == "tokens.txt")
        #expect(throws: SherpaOnnxError.missingPart("joiner")) {
            _ = try TransducerModelFiles(directory: dir, parts: ["encoder": "e", "decoder": "d", "tokens": "t"])
        }
    }
}

/// With the model files: SHERPA_ONNX_MODEL_DIR holding the four parts of
/// zipformer2-66m-streaming-he (the `models-v2` release names).
struct RecognizerTests {
    static let modelDir = ProcessInfo.processInfo.environment["SHERPA_ONNX_MODEL_DIR"]

    static func files() throws -> TransducerModelFiles {
        try TransducerModelFiles(directory: URL(fileURLWithPath: modelDir!), parts: [
            "encoder": "zipformer2-66m-streaming-he-encoder.int8.onnx",
            "decoder": "zipformer2-66m-streaming-he-decoder.int8.onnx",
            "joiner": "zipformer2-66m-streaming-he-joiner.int8.onnx",
            "tokens": "zipformer2-66m-streaming-he-tokens.txt",
        ])
    }

    @Test(.enabled(if: modelDir != nil))
    func silenceStaysEmptyAndTheLifecycleHolds() throws {
        let recognizer = try StreamingTransducerRecognizer(files: Self.files(), threads: 2)
        #expect(recognizer.partialText == "")
        #expect(recognizer.finalText == nil)

        let silence = [Float](repeating: 0, count: 1_600)
        for _ in 0..<30 { recognizer.accept(samples: silence) }
        #expect(abs(recognizer.acceptedSeconds - 3.0) < 1e-9)
        #expect(recognizer.partialText == "")

        let final = recognizer.inputFinished()
        #expect(final == "")
        #expect(recognizer.isFinished)
        #expect(recognizer.finalText == "")
        #expect(recognizer.inputFinished() == final)
        // Ignored until reset.
        recognizer.accept(samples: silence)
        #expect(abs(recognizer.acceptedSeconds - 3.0) < 1e-9)

        recognizer.reset()
        #expect(!recognizer.isFinished)
        #expect(recognizer.acceptedSeconds == 0)
        recognizer.accept(samples: silence)
        #expect(recognizer.acceptedSeconds > 0)
    }

    /// A one-off pass decodes on a stream of its own: the utterance being fed
    /// goes on where it was.
    @Test(.enabled(if: modelDir != nil))
    func aOneOffPassLeavesTheUtteranceAlone() throws {
        let recognizer = try StreamingTransducerRecognizer(files: Self.files(), threads: 2)
        let silence = [Float](repeating: 0, count: 1_600)
        for _ in 0..<10 { recognizer.accept(samples: silence) }
        #expect(recognizer.transcribeOnce(samples: [Float](repeating: 0, count: 16_000)) == "")
        #expect(recognizer.transcribeOnce(samples: []) == "")
        #expect(abs(recognizer.acceptedSeconds - 1.0) < 1e-9)
        #expect(!recognizer.isFinished)
        recognizer.accept(samples: silence)
        #expect(abs(recognizer.acceptedSeconds - 1.1) < 1e-9)
        #expect(recognizer.inputFinished() == "")
    }

    /// Two threads hammering one recognizer: calls serialize, nothing crashes.
    @Test(.enabled(if: modelDir != nil))
    func callsFromSeveralThreadsSerialize() async throws {
        let recognizer = try StreamingTransducerRecognizer(files: Self.files(), threads: 1)
        let noise = (0..<1_600).map { i in Float(sin(Double(i) * 0.37)) * 0.01 }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<2 {
                group.addTask {
                    for _ in 0..<20 {
                        recognizer.accept(samples: noise)
                        _ = recognizer.partialText
                    }
                }
            }
        }
        #expect(abs(recognizer.acceptedSeconds - 4.0) < 1e-9)
        _ = recognizer.inputFinished()
    }
}
