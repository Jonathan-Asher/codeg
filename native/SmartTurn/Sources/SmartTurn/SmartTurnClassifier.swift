import Foundation
import OnnxRuntimeBindings

public enum SmartTurnError: Error, CustomStringConvertible {
    case modelFileMissing(String)
    case unexpectedModel(String)
    case badOutput(String)

    public var description: String {
        switch self {
        case .modelFileMissing(let path): return "Smart Turn model not found: \(path)"
        case .unexpectedModel(let detail): return "not a Smart Turn model: \(detail)"
        case .badOutput(let detail): return "Smart Turn output: \(detail)"
        }
    }
}

/// Smart Turn v3.2: the probability that the speaker has finished their turn,
/// from the last 8 s of audio.
///
/// The int8 ONNX model (`smart-turn-v3.2-cpu.onnx`, about 8.7 MB) runs on
/// ONNX Runtime's CPU provider, the runtime BlueTTSKit links. Features come
/// from ``WhisperLogMel``. Inference runs on the classifier's own serial
/// queue, so the async API never blocks the caller.
///
/// The model has no Hebrew in its training data; Talk logs its probability
/// next to its own end-of-turn decision before it decides anything.
public final class SmartTurnClassifier: @unchecked Sendable {
    public static let sampleRate = WhisperLogMel.sampleRate
    public static let maxSeconds = 8

    public let modelURL: URL
    private let session: ORTSession
    private let inputName: String
    private let outputName: String
    private let frontEnd = WhisperLogMel(seconds: SmartTurnClassifier.maxSeconds)
    private let queue = DispatchQueue(label: "io.ashurov.codeg.smart-turn", qos: .userInitiated)

    /// Loads the model. `threads` is ONNX Runtime's intra-op thread count.
    public init(modelURL: URL, threads: Int = 2) throws {
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            throw SmartTurnError.modelFileMissing(modelURL.path)
        }
        let options = try ORTSessionOptions()
        try options.setGraphOptimizationLevel(.all)
        try options.setIntraOpNumThreads(Int32(max(1, threads)))
        // It runs once per pause: don't keep worker threads spinning after it.
        try options.addConfigEntry(withKey: "session.intra_op.allow_spinning", value: "0")
        session = try ORTSession(env: Self.environment(), modelPath: modelURL.path, sessionOptions: options)
        self.modelURL = modelURL
        let inputs = try session.inputNames()
        let outputs = try session.outputNames()
        guard inputs == ["input_features"], let output = outputs.first, outputs.count == 1 else {
            throw SmartTurnError.unexpectedModel("inputs \(inputs), outputs \(outputs)")
        }
        inputName = inputs[0]
        outputName = output
    }

    /// The probability that the turn is complete, for up to 8 s of 16 kHz mono
    /// audio ending now (longer input keeps its last 8 s; shorter input is
    /// zero-padded at the front). Nil for empty input or when inference fails.
    public func probability(last8s: [Float]) async -> Float? {
        guard !last8s.isEmpty else { return nil }
        return await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: try? self.predict(last8s))
            }
        }
    }

    /// The same, synchronously on the caller's thread (tools and tests).
    public func predict(_ audio: [Float]) throws -> Float {
        let features = frontEnd.features(audio)
        let data = features.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
        let shape: [NSNumber] = [1, NSNumber(value: WhisperLogMel.melCount), NSNumber(value: frontEnd.frameCount)]
        let input = try ORTValue(tensorData: data, elementType: .float, shape: shape)
        let outputs = try session.run(withInputs: [inputName: input], outputNames: [outputName], runOptions: nil)
        guard let value = outputs[outputName] else { throw SmartTurnError.badOutput("no \(outputName)") }
        let info = try value.tensorTypeAndShapeInfo()
        guard info.elementType == .float else { throw SmartTurnError.badOutput("element type \(info.elementType.rawValue)") }
        let raw = try value.tensorData() as Data
        guard raw.count >= MemoryLayout<Float>.size else { throw SmartTurnError.badOutput("\(raw.count) bytes") }
        // The exported graph ends in a sigmoid: this is already a probability.
        let p = raw.withUnsafeBytes { $0.loadUnaligned(as: Float.self) }
        guard p.isFinite else { throw SmartTurnError.badOutput("\(p)") }
        return p
    }

    private static func environment() throws -> ORTEnv {
        try envLock.withLock {
            if let env = sharedEnv { return env }
            let env = try ORTEnv(loggingLevel: .warning)
            sharedEnv = env
            return env
        }
    }

    private static let envLock = NSLock()
    nonisolated(unsafe) private static var sharedEnv: ORTEnv?
}
