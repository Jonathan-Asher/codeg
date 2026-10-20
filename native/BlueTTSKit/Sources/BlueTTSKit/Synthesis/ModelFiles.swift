import Compression
import Foundation

/// Minimal `.npz` reader: a zip of `.npy` files (float32, C order). BlueTTS
/// ships `stats.npz` and `uncond.npz` stored uncompressed; deflated entries are
/// handled too (`np.savez_compressed`).
enum NPZ {
    struct Malformed: Error, CustomStringConvertible {
        let description: String
    }

    static func load(_ url: URL) throws -> [String: Tensor<Float>] {
        let data = try Data(contentsOf: url)
        var out: [String: Tensor<Float>] = [:]
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            func u16(_ o: Int) -> Int { Int(raw.loadUnaligned(fromByteOffset: o, as: UInt16.self).littleEndian) }
            func u32(_ o: Int) -> Int { Int(raw.loadUnaligned(fromByteOffset: o, as: UInt32.self).littleEndian) }
            var o = 0
            while o + 30 <= raw.count, u32(o) == 0x0403_4B50 {
                let method = u16(o + 8)
                var csize = u32(o + 18)
                var usize = u32(o + 22)
                let nameLen = u16(o + 26), extraLen = u16(o + 28)
                let name = String(decoding: raw[(o + 30)..<(o + 30 + nameLen)], as: UTF8.self)
                let extraStart = o + 30 + nameLen
                // zip64 extra field carries the real sizes when the header has 0xFFFFFFFF.
                if csize == 0xFFFF_FFFF || usize == 0xFFFF_FFFF {
                    var e = extraStart
                    while e + 4 <= extraStart + extraLen {
                        let id = u16(e), len = u16(e + 2)
                        if id == 0x0001 {
                            usize = Int(raw.loadUnaligned(fromByteOffset: e + 4, as: UInt64.self).littleEndian)
                            csize = Int(raw.loadUnaligned(fromByteOffset: e + 12, as: UInt64.self).littleEndian)
                        }
                        e += 4 + len
                    }
                }
                let start = extraStart + extraLen
                guard start + csize <= raw.count else { throw Malformed(description: "truncated \(name)") }
                let payload: Data
                switch method {
                case 0:
                    payload = Data(raw[start..<(start + csize)])
                case 8:
                    var dst = [UInt8](repeating: 0, count: usize)
                    let n = raw.baseAddress!.advanced(by: start).withMemoryRebound(to: UInt8.self, capacity: csize) { src in
                        compression_decode_buffer(&dst, usize, src, csize, nil, COMPRESSION_ZLIB)
                    }
                    guard n == usize else { throw Malformed(description: "inflate \(name)") }
                    payload = Data(dst)
                default:
                    throw Malformed(description: "zip method \(method)")
                }
                let key = name.hasSuffix(".npy") ? String(name.dropLast(4)) : name
                out[key] = try parseNPY(payload)
                o = start + csize
            }
        }
        return out
    }

    static func parseNPY(_ d: Data) throws -> Tensor<Float> {
        guard d.count > 10, d[d.startIndex] == 0x93 else { throw Malformed(description: "npy magic") }
        let major = d[d.startIndex + 6]
        let headerLen: Int
        let headerStart: Int
        if major == 1 {
            headerLen = Int(d[d.startIndex + 8]) | (Int(d[d.startIndex + 9]) << 8)
            headerStart = 10
        } else {
            headerLen = d[(d.startIndex + 8)..<(d.startIndex + 12)].enumerated()
                .reduce(0) { $0 | (Int($1.element) << (8 * $1.offset)) }
            headerStart = 12
        }
        let header = String(decoding: d[(d.startIndex + headerStart)..<(d.startIndex + headerStart + headerLen)], as: UTF8.self)
        guard header.contains("'<f4'") else { throw Malformed(description: "only float32 npy supported: \(header)") }
        guard header.contains("'fortran_order': False") else { throw Malformed(description: "fortran order") }
        guard let s = header.range(of: "'shape': ("), let e = header[s.upperBound...].firstIndex(of: ")") else {
            throw Malformed(description: "shape")
        }
        let shape = header[s.upperBound..<e].split(separator: ",")
            .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        let count = shape.reduce(1, *)
        let body = d[(d.startIndex + headerStart + headerLen)...]
        guard body.count >= count * 4 else { throw Malformed(description: "npy body") }
        var arr = [Float](repeating: 0, count: count)
        arr.withUnsafeMutableBytes { dst in
            body.withUnsafeBytes { src in dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[0..<(count * 4)])) }
        }
        return Tensor(shape: shape.isEmpty ? [1] : shape, data: arr)
    }
}

/// A BlueTTS voice: the two style tensors from a `voices/*.json` file.
public struct VoiceStyle: Sendable {
    public let name: String
    let ttl: Tensor<Float>  // [1, 50, 256]
    let dp: Tensor<Float>   // [1, 8, 16]

    public init(contentsOf url: URL) throws {
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let d = obj as? [String: Any],
              let ttl = d["style_ttl"] as? [String: Any], let dp = d["style_dp"] as? [String: Any] else {
            throw NPZ.Malformed(description: "voice json \(url.lastPathComponent)")
        }
        self.name = url.deletingPathExtension().lastPathComponent
        self.ttl = try Self.tensor(ttl)
        self.dp = try Self.tensor(dp)
    }

    init(name: String, ttl: Tensor<Float>, dp: Tensor<Float>) {
        self.name = name
        self.ttl = ttl
        self.dp = dp
    }

    private static func tensor(_ d: [String: Any]) throws -> Tensor<Float> {
        guard let dims = d["dims"] as? [Int], let data = d["data"] else { throw NPZ.Malformed(description: "style") }
        var flat: [Float] = []
        flat.reserveCapacity(dims.reduce(1, *))
        func walk(_ x: Any) {
            if let a = x as? [Any] { a.forEach(walk) } else if let n = x as? NSNumber { flat.append(Float(n.doubleValue)) }
        }
        walk(data)
        // `np.array(data).flatten().reshape(dims[1], dims[2])` inside a batch of 1.
        return Tensor(shape: [1, dims[1], dims[2]], data: Array(flat.prefix(dims[1] * dims[2])))
    }

    /// Several voices averaged into one speaker, like `BlueTTS(style_json=[...])`.
    public static func average(_ voices: [VoiceStyle], name: String = "mix") -> VoiceStyle {
        precondition(!voices.isEmpty)
        func mean(_ ts: [Tensor<Float>]) -> Tensor<Float> {
            var acc = [Float](repeating: 0, count: ts[0].data.count)
            for t in ts { for i in acc.indices { acc[i] += t.data[i] } }
            let n = Float(ts.count)
            return Tensor(shape: ts[0].shape, data: acc.map { $0 / n })
        }
        return VoiceStyle(name: name, ttl: mean(voices.map(\.ttl)), dp: mean(voices.map(\.dp)))
    }
}
