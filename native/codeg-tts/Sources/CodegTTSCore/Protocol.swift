import Foundation

/// The codeg-tts wire protocol, version 1.
///
/// The backend writes one JSON request per line to stdin. codeg-tts answers on
/// stdout with frames: a one-line JSON header, then exactly `bytes` raw bytes
/// when the header has a `bytes` field (audio chunks), nothing otherwise.
///
/// Requests:
///
///     {"op":"synthesize","id":7,"text":"…","voice":"noa","speed":1.0}
///     {"op":"cancel","id":7}
///     {"op":"load"}
///     {"op":"shutdown"}
///
/// Events:
///
///     {"event":"ready","protocol":1,"sampleRate":44100,"voices":["adam","noa"]}
///     {"event":"loaded","ms":1210}
///     {"event":"chunk","id":7,"index":0,"sampleRate":44100,"format":"s16le",
///      "samples":52000,"bytes":104000,"final":false,"elapsedMs":640}  + PCM
///     {"event":"done","id":7,"chunks":3,"cancelled":false,"audioMs":9100,
///      "elapsedMs":1480,"firstChunkMs":640}
///     {"event":"error","id":7,"message":"voice x not found"}   (id optional)
///
/// Every synthesize request ends with exactly one `done` or `error` for its id.
/// Closing stdin is the same as `shutdown`.
public enum CodegTTSProtocol {
    public static let version = 1
    /// Slowest and fastest speaking rate accepted (1 = the voice's own pace).
    public static let speedRange: ClosedRange<Double> = 0.5...2.0
    /// Longest text accepted in one request, in characters.
    public static let maxTextLength = 20_000
}

// MARK: - Requests

public struct SynthesizeRequest: Equatable, Sendable {
    public var id: UInt64
    public var text: String
    /// Voice file name without `.json`; nil = the default voice.
    public var voice: String?
    public var speed: Double

    public init(id: UInt64, text: String, voice: String? = nil, speed: Double = 1.0) {
        self.id = id
        self.text = text
        self.voice = voice
        self.speed = speed
    }
}

public enum Request: Equatable, Sendable {
    case synthesize(SynthesizeRequest)
    case cancel(id: UInt64)
    /// Load the models now rather than on the first synthesize.
    case load
    case shutdown
}

public enum RequestError: Error, Equatable, CustomStringConvertible {
    case malformed(String)
    case unknownOp(String)
    case missingField(String)
    case invalid(String)

    public var description: String {
        switch self {
        case .malformed(let why): return "malformed request: \(why)"
        case .unknownOp(let op): return "unknown op \(op)"
        case .missingField(let name): return "request is missing \(name)"
        case .invalid(let why): return "invalid request: \(why)"
        }
    }
}

private struct WireRequest: Decodable {
    let op: String
    let id: UInt64?
    let text: String?
    let voice: String?
    let speed: Double?
}

extension Request {
    /// Parse one request line.
    public static func parse(_ line: String) throws -> Request {
        let wire: WireRequest
        do {
            wire = try JSONDecoder().decode(WireRequest.self, from: Data(line.utf8))
        } catch {
            throw RequestError.malformed(String(describing: error))
        }
        switch wire.op {
        case "synthesize":
            guard let id = wire.id else { throw RequestError.missingField("id") }
            guard let text = wire.text else { throw RequestError.missingField("text") }
            guard text.count <= CodegTTSProtocol.maxTextLength else {
                throw RequestError.invalid("text is longer than \(CodegTTSProtocol.maxTextLength) characters")
            }
            let voice = wire.voice.flatMap { $0.isEmpty ? nil : $0 }
            if let voice, !isSafeVoiceName(voice) {
                throw RequestError.invalid("voice name \(voice)")
            }
            return .synthesize(SynthesizeRequest(id: id, text: text, voice: voice,
                                                 speed: clampSpeed(wire.speed ?? 1.0)))
        case "cancel":
            guard let id = wire.id else { throw RequestError.missingField("id") }
            return .cancel(id: id)
        case "load":
            return .load
        case "shutdown":
            return .shutdown
        default:
            throw RequestError.unknownOp(wire.op)
        }
    }

    /// Clamp a speaking rate into `CodegTTSProtocol.speedRange`; NaN reads as 1.
    public static func clampSpeed(_ speed: Double) -> Double {
        guard speed.isFinite else { return 1.0 }
        let range = CodegTTSProtocol.speedRange
        return min(range.upperBound, max(range.lowerBound, speed))
    }

    /// Voices are file names inside the models directory: letters, digits,
    /// `-` and `_` only, so a request can never point outside it.
    public static func isSafeVoiceName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 64 && name.unicodeScalars.allSatisfy {
            ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" || $0 == "_"
        }
    }
}

// MARK: - Events

public enum Event: Equatable, Sendable {
    case ready(voices: [String], sampleRate: Int)
    case loaded(ms: Int)
    /// One streamed piece of audio, 16-bit little-endian mono PCM.
    case chunk(id: UInt64, index: Int, sampleRate: Int, isFinal: Bool, elapsedMs: Int, pcm: Data)
    case done(id: UInt64, chunks: Int, cancelled: Bool, audioMs: Int, elapsedMs: Int, firstChunkMs: Int?)
    case error(id: UInt64?, message: String)

    /// The header line (JSON + newline) followed by the payload, if any.
    public func encoded() -> Data {
        var header: [String: Any]
        var payload = Data()
        switch self {
        case .ready(let voices, let sampleRate):
            header = ["event": "ready", "protocol": CodegTTSProtocol.version,
                      "voices": voices, "sampleRate": sampleRate]
        case .loaded(let ms):
            header = ["event": "loaded", "ms": ms]
        case .chunk(let id, let index, let sampleRate, let isFinal, let elapsedMs, let pcm):
            header = ["event": "chunk", "id": NSNumber(value: id), "index": index,
                      "sampleRate": sampleRate, "format": "s16le", "samples": pcm.count / 2,
                      "bytes": pcm.count, "final": isFinal, "elapsedMs": elapsedMs]
            payload = pcm
        case .done(let id, let chunks, let cancelled, let audioMs, let elapsedMs, let firstChunkMs):
            header = ["event": "done", "id": NSNumber(value: id), "chunks": chunks,
                      "cancelled": cancelled, "audioMs": audioMs, "elapsedMs": elapsedMs]
            if let firstChunkMs { header["firstChunkMs"] = firstChunkMs }
        case .error(let id, let message):
            header = ["event": "error", "message": message]
            if let id { header["id"] = NSNumber(value: id) }
        }
        // Only plain strings, numbers, bools and arrays go in, so this can't fail.
        var data = (try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]))
            ?? Data(#"{"event":"error","message":"could not encode an event"}"#.utf8)
        data.append(0x0A)
        data.append(payload)
        return data
    }
}

// MARK: - PCM

public enum PCM {
    /// Float samples in [-1, 1] to 16-bit little-endian PCM: clipped, scaled
    /// by 32767 and rounded, like libsndfile (and BlueTTSKit's WAV writer).
    public static func s16le(_ samples: [Float]) -> Data {
        var out = Data(count: samples.count * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            for (i, x) in samples.enumerated() {
                let clipped = x.isNaN ? 0 : max(-1.0, min(1.0, Double(x)))
                dst[i] = Int16((clipped * 32767.0).rounded()).littleEndian
            }
        }
        return out
    }

    /// A 16-bit mono WAV file around `pcm` (diagnostics and the E2E sample).
    public static func wav(_ pcm: Data, sampleRate: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + pcm.count))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(pcm.count))
        d.append(pcm)
        return d
    }
}

// MARK: - Output

/// Writes events to stdout, one whole frame at a time, from any thread.
public final class FrameWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let handle: FileHandle
    private let onBrokenPipe: @Sendable () -> Void

    /// - Parameter onBrokenPipe: called when the reader is gone (the backend
    ///   exited); the executable exits there.
    public init(handle: FileHandle, onBrokenPipe: @escaping @Sendable () -> Void) {
        self.handle = handle
        self.onBrokenPipe = onBrokenPipe
    }

    public func send(_ event: Event) {
        let data = event.encoded()
        let ok: Bool = lock.withLock {
            do {
                try handle.write(contentsOf: data)
                return true
            } catch {
                return false
            }
        }
        if !ok { onBrokenPipe() }
    }
}
