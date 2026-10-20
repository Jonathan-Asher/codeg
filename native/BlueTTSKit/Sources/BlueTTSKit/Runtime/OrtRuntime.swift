import Foundation
import OnnxRuntimeBindings

/// Where a graph runs. CPU is the default and the reference; CoreML is opt-in
/// per graph (see README for which graphs it accepts).
public enum ExecutionProvider: String, Sendable, Codable {
    case cpu
    case coreML
}

/// A dense row-major tensor, the only currency between Swift and ORT here.
struct Tensor<T: Sendable>: Sendable {
    var shape: [Int]
    var data: [T]

    init(shape: [Int], data: [T]) {
        precondition(shape.reduce(1, *) == data.count, "shape \(shape) vs \(data.count) elements")
        self.shape = shape
        self.data = data
    }
}

enum OrtError: Error, CustomStringConvertible {
    case missingOutput(String)
    case badOutputType(String)
    case modelFileMissing(String)

    var description: String {
        switch self {
        case .missingOutput(let s): return "ONNX output missing: \(s)"
        case .badOutputType(let s): return "ONNX output has an unexpected type: \(s)"
        case .modelFileMissing(let s): return "model file not found: \(s)"
        }
    }
}

/// One process-wide ORT environment.
final class OrtRuntime: @unchecked Sendable {
    static let shared = OrtRuntime()
    let env: ORTEnv

    private init() {
        // Warning level keeps ORT's own logging quiet in an app; BLUETTS_ORT_LOG=info|verbose
        // surfaces e.g. how many nodes the CoreML EP claims.
        let level: ORTLoggingLevel
        switch ProcessInfo.processInfo.environment["BLUETTS_ORT_LOG"] {
        case "verbose": level = .verbose
        case "info": level = .info
        default: level = .warning
        }
        env = try! ORTEnv(loggingLevel: level)
    }
}

/// A loaded graph. ORT sessions are thread-safe for `Run`, but every caller in
/// this package serializes inference on one queue anyway (CPU-bound work).
final class OrtSession: @unchecked Sendable {
    let session: ORTSession
    let path: String
    let inputNames: Set<String>
    let outputNames: [String]

    init(path: URL, threads: Int, provider: ExecutionProvider = .cpu) throws {
        guard FileManager.default.fileExists(atPath: path.path) else {
            throw OrtError.modelFileMissing(path.path)
        }
        let opts = try ORTSessionOptions()
        try opts.setGraphOptimizationLevel(.all)
        try opts.setIntraOpNumThreads(Int32(max(1, threads)))
        if provider == .coreML {
            let co = ORTCoreMLExecutionProviderOptions()
            // MLProgram is the modern format; BLUETTS_COREML_FORMAT=nn selects NeuralNetwork.
            co.createMLProgram = ProcessInfo.processInfo.environment["BLUETTS_COREML_FORMAT"] != "nn"
            try opts.appendCoreMLExecutionProvider(with: co)
        }
        session = try ORTSession(env: OrtRuntime.shared.env, modelPath: path.path, sessionOptions: opts)
        self.path = path.path
        inputNames = Set(try session.inputNames())
        outputNames = try session.outputNames()
    }

    enum Input {
        case float(Tensor<Float>)
        case int64(Tensor<Int64>)
    }

    private static func makeValue(_ input: Input) throws -> ORTValue {
        switch input {
        case .float(let t):
            let data = t.data.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
            return try ORTValue(tensorData: data, elementType: .float, shape: t.shape.map { NSNumber(value: $0) })
        case .int64(let t):
            let data = t.data.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
            return try ORTValue(tensorData: data, elementType: .int64, shape: t.shape.map { NSNumber(value: $0) })
        }
    }

    /// Run and return the requested float outputs (all outputs when `outputs` is nil).
    func run(_ inputs: [String: Input], outputs: [String]? = nil) throws -> [String: Tensor<Float>] {
        var feeds: [String: ORTValue] = [:]
        for (k, v) in inputs { feeds[k] = try Self.makeValue(v) }
        let names = outputs ?? outputNames
        let res = try session.run(withInputs: feeds, outputNames: Set(names), runOptions: nil)
        var out: [String: Tensor<Float>] = [:]
        for n in names {
            guard let v = res[n] else { throw OrtError.missingOutput(n) }
            let info = try v.tensorTypeAndShapeInfo()
            guard info.elementType == .float else { throw OrtError.badOutputType(n) }
            let shape = info.shape.map { $0.intValue }
            let raw = try v.tensorData() as Data
            let count = shape.reduce(1, *)
            var arr = [Float](repeating: 0, count: count)
            arr.withUnsafeMutableBytes { dst in
                raw.withUnsafeBytes { src in
                    dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[0..<min(src.count, dst.count)]))
                }
            }
            out[n] = Tensor(shape: shape, data: arr)
        }
        return out
    }
}

/// Reads `metadata_props` out of an `.onnx` file without parsing the graph.
///
/// The ORT Objective-C API does not expose model metadata, and RenikudPlus keeps
/// its label vocabularies and cascade matrices there. ModelProto field 14 is
/// `repeated StringStringEntryProto metadata_props` (key = 1, value = 2); every
/// other top-level field is skipped by length, so this touches a few KB of a
/// memory-mapped file.
enum OnnxMetadataReader {
    struct Malformed: Error {}

    /// Static dims of each graph input (`nil` for symbolic dims), read from
    /// ModelProto.graph(7).input(11).type(2).tensor_type(1).shape(2).dim(1).
    /// The ORT Objective-C API has no shape introspection, and BlueTTS decides
    /// the vocoder input layout from the declared channel count.
    static func inputShapes(_ url: URL) throws -> [String: [Int?]] {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        return try data.withUnsafeBytes { raw -> [String: [Int?]] in
            let p = raw.bindMemory(to: UInt8.self)
            func varint(_ i: inout Int) throws -> UInt64 {
                var shift: UInt64 = 0
                var v: UInt64 = 0
                while true {
                    guard i < p.count else { throw Malformed() }
                    let b = p[i]
                    i += 1
                    v |= UInt64(b & 0x7F) << shift
                    if b & 0x80 == 0 { return v }
                    shift += 7
                    if shift > 63 { throw Malformed() }
                }
            }
            /// Iterate fields of the message in [start, end).
            func fields(_ start: Int, _ end: Int, _ body: (UInt64, Int, Int, Int) throws -> Void) throws {
                var i = start
                while i < end {
                    let key = try varint(&i)
                    let field = key >> 3, wire = key & 7
                    switch wire {
                    case 0:
                        let s = i
                        _ = try varint(&i)
                        try body(field, 0, s, i)
                    case 1: i += 8
                    case 5: i += 4
                    case 2:
                        let len = Int(try varint(&i))
                        guard i + len <= end else { throw Malformed() }
                        try body(field, 2, i, i + len)
                        i += len
                    default: throw Malformed()
                    }
                }
            }
            var out: [String: [Int?]] = [:]
            try fields(0, p.count) { f, w, s, e in
                guard f == 7, w == 2 else { return }
                try fields(s, e) { gf, gw, gs, ge in
                    guard gf == 11, gw == 2 else { return }
                    var name = ""
                    var dims: [Int?] = []
                    try fields(gs, ge) { vf, vw, vs, ve in
                        if vf == 1, vw == 2 {
                            name = String(decoding: UnsafeBufferPointer(rebasing: p[vs..<ve]), as: UTF8.self)
                        } else if vf == 2, vw == 2 {
                            try fields(vs, ve) { tf, tw, ts, te in
                                guard tf == 1, tw == 2 else { return }
                                try fields(ts, te) { sf, sw, ss, se in
                                    guard sf == 2, sw == 2 else { return }
                                    try fields(ss, se) { df, dw, ds, de in
                                        guard df == 1, dw == 2 else { return }
                                        var dim: Int?
                                        try fields(ds, de) { xf, xw, xs, _ in
                                            if xf == 1, xw == 0 {
                                                var j = xs
                                                dim = Int(try varint(&j))
                                            }
                                        }
                                        dims.append(dim)
                                    }
                                }
                            }
                        }
                    }
                    out[name] = dims
                }
            }
            return out
        }
    }

    static func read(_ url: URL) throws -> [String: String] {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        return try data.withUnsafeBytes { raw -> [String: String] in
            let p = raw.bindMemory(to: UInt8.self)
            var i = 0
            var out: [String: String] = [:]
            func varint() throws -> UInt64 {
                var shift: UInt64 = 0
                var v: UInt64 = 0
                while true {
                    guard i < p.count else { throw Malformed() }
                    let b = p[i]
                    i += 1
                    v |= UInt64(b & 0x7F) << shift
                    if b & 0x80 == 0 { return v }
                    shift += 7
                    if shift > 63 { throw Malformed() }
                }
            }
            while i < p.count {
                let key = try varint()
                let field = key >> 3, wire = key & 7
                switch wire {
                case 0: _ = try varint()
                case 1: i += 8
                case 5: i += 4
                case 2:
                    let len = Int(try varint())
                    guard i + len <= p.count else { throw Malformed() }
                    if field == 14 {
                        // StringStringEntryProto
                        let end = i + len
                        var k = "", v = ""
                        while i < end {
                            let kk = try varint()
                            let l = Int(try varint())
                            let s = String(decoding: UnsafeBufferPointer(rebasing: p[i..<(i + l)]), as: UTF8.self)
                            if kk >> 3 == 1 { k = s } else if kk >> 3 == 2 { v = s }
                            i += l
                        }
                        out[k] = v
                    } else {
                        i += len
                    }
                default:
                    throw Malformed()
                }
            }
            return out
        }
    }
}
