// bluetts-cli: macOS tool for benchmarking BlueTTSKit and producing listening packs.
//
//   bluetts-cli synth  --models DIR --text "..." --out a.wav [--seed N] [--voice noa]
//   bluetts-cli bench  --models DIR --cases cases.json --outdir out/ [--seed N] [--steps 5]
//   bluetts-cli stream --models DIR --text "..." [--out a.wav]
//   bluetts-cli phonemize --models DIR --text "..."
//
// `--models DIR` uses the README layout; `--spike` uses /tmp/tts-spike directly.

import BlueTTSEspeak
import BlueTTSKit
import Darwin
import Foundation

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func modelPaths() -> BlueTTSModelPaths {
    if let m = arg("--models") { return BlueTTSModelPaths(root: URL(fileURLWithPath: m)) }
    let spike = URL(fileURLWithPath: "/tmp/tts-spike")
    return BlueTTSModelPaths(
        blueDirectory: spike.appendingPathComponent("models/blue25"),
        voicesDirectories: [spike.appendingPathComponent("Light-BlueTTS/voices"),
                            spike.appendingPathComponent("models/blue25/voices")],
        renikudModel: spike.appendingPathComponent("models/renikud/model_int8.onnx"))
}

func configuration() -> BlueTTSConfiguration {
    var c = BlueTTSConfiguration()
    if let t = arg("--threads").flatMap(Int.init) { c.threads = t }
    if let p = arg("--coreml") {
        // comma list of graphs to put on CoreML: enc,vf,voc,g2p
        for g in p.split(separator: ",") {
            switch g {
            case "enc": c.textEncoderProvider = .coreML
            case "vf": c.vectorEstimatorProvider = .coreML
            case "voc": c.vocoderProvider = .coreML
            case "g2p": c.g2pProvider = .coreML
            default: die("unknown graph \(g)")
            }
        }
    }
    return c
}

func options() -> SynthesisOptions {
    var o = SynthesisOptions()
    if let s = arg("--seed").flatMap(UInt32.init) { o.seed = s }
    if let v = arg("--voice") { o.voice = v }
    if let s = arg("--steps").flatMap(Int.init) { o.totalSteps = s }
    if let s = arg("--speed").flatMap(Double.init) { o.speed = s }
    return o
}

/// 16-bit PCM WAV, like `soundfile.write` defaults in the Python reference.
func writeWAV(_ samples: [Float], sampleRate: Int, to url: URL) throws {
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    let n = samples.count
    d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 2))
    d.append("WAVE".data(using: .ascii)!)
    d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(sampleRate))
    u32(UInt32(sampleRate * 2)); u16(2); u16(16)
    d.append("data".data(using: .ascii)!); u32(UInt32(n * 2))
    var pcm = [Int16](repeating: 0, count: n)
    for i in 0..<n {
        // soundfile/libsndfile: clip, scale by 32767 and round.
        let x = max(-1.0, min(1.0, Double(samples[i])))
        pcm[i] = Int16((x * 32767.0).rounded())
    }
    pcm.withUnsafeBytes { d.append(contentsOf: $0) }
    try d.write(to: url)
}

func peakRSSBytes() -> Int {
    var ru = rusage()
    getrusage(RUSAGE_SELF, &ru)
    return Int(ru.ru_maxrss)  // bytes on macOS
}

func physFootprint() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return kr == KERN_SUCCESS ? Int(info.ledger_phys_footprint_peak) : -1
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

struct BenchCase: Decodable {
    let id: String
    let text: String
}

func makeTTS() throws -> BlueTTS {
    let espeak = try EspeakPhonemizer()
    return BlueTTS(paths: modelPaths(), englishPhonemizer: espeak, configuration: configuration())
}

let cmd = CommandLine.arguments.dropFirst().first ?? "help"

switch cmd {
case "phonemize":
    guard let text = arg("--text") else { die("--text") }
    let tts = try makeTTS()
    let r = try await tts.phonemize(text, options: options())
    print("tagged    :", r.tagged)
    print("normalized:", r.normalized)
    for s in r.segments { print(s.isSlow ? "slow" : "    ", s.phonemes) }

case "synth":
    guard let text = arg("--text"), let out = arg("--out") else { die("--text --out") }
    let tts = try makeTTS()
    let t0 = now()
    try await tts.load()
    let t1 = now()
    let audio = try await tts.synthesize(text, options: options())
    let t2 = now()
    try writeWAV(audio.samples, sampleRate: audio.sampleRate, to: URL(fileURLWithPath: out))
    print(String(format: "load %.2fs synth %.2fs audio %.2fs RTF %.3f", t1 - t0, t2 - t1, audio.duration,
                 (t2 - t1) / audio.duration))

case "stream":
    guard let text = arg("--text") else { die("--text") }
    let tts = try makeTTS()
    try await tts.load()
    let t0 = now()
    var all: [Float] = []
    var sr = 44100
    for try await c in tts.synthesizeStream(text, options: options()) {
        print(String(format: "chunk %d at %.3fs (%.2fs audio)%@", c.index, now() - t0, c.duration, c.isFinal ? " final" : ""))
        all += c.samples
        sr = c.sampleRate
    }
    if let out = arg("--out") { try writeWAV(all, sampleRate: sr, to: URL(fileURLWithPath: out)) }

case "bench":
    // Mirrors /tmp/tts-spike/run_model.py: load, warm-up, then every case once.
    guard let casesPath = arg("--cases"), let outdir = arg("--outdir") else { die("--cases --outdir") }
    let cases = try JSONDecoder().decode([BenchCase].self, from: Data(contentsOf: URL(fileURLWithPath: casesPath)))
    let prefix = arg("--prefix") ?? "swift"
    try FileManager.default.createDirectory(atPath: outdir, withIntermediateDirectories: true)
    let tts = try makeTTS()
    var o = options()
    let t0 = now()
    try await tts.load()
    let loadS = now() - t0
    let rssAfterLoad = physFootprint()
    let t1 = now()
    _ = try await tts.synthesize("שלום, זו בדיקה.", options: o)
    let warmS = now() - t1
    var rows: [[String: Any]] = []
    for c in cases {
        if let s = arg("--seed").flatMap(UInt32.init) { o.seed = s }
        let s0 = now()
        let audio = try await tts.synthesize(c.text, options: o)
        let dt = now() - s0
        try writeWAV(audio.samples, sampleRate: audio.sampleRate,
                     to: URL(fileURLWithPath: outdir).appendingPathComponent("\(prefix)__\(c.id).wav"))
        rows.append(["nn": c.id, "synth_s": dt, "audio_s": audio.duration, "rtf": dt / audio.duration])
        print(String(format: "%@ %@: %.2fs for %.2fs audio  RTF=%.3f", prefix, c.id, dt, audio.duration, dt / audio.duration))
    }
    // First-chunk latency of the streaming API, warm, for every case.
    var firsts: [[String: Any]] = []
    for c in cases {
        let s0 = now()
        var first = -1.0, total = 0.0, n = 0
        for try await ch in tts.synthesizeStream(c.text, options: o) {
            if first < 0 { first = now() - s0 }
            total = now() - s0
            n += 1
            _ = ch
        }
        firsts.append(["nn": c.id, "first_chunk_s": first, "total_s": total, "chunks": n])
        print(String(format: "stream %@: first chunk %.3fs, %d chunks, done %.2fs", c.id, first, n, total))
    }
    let summary: [String: Any] = [
        "model": prefix, "load_s": loadS, "warmup_s": warmS, "rows": rows, "stream": firsts,
        "peak_rss_bytes": peakRSSBytes(), "peak_phys_footprint_bytes": physFootprint(),
        "phys_footprint_after_load_bytes": rssAfterLoad,
        "threads": configuration().threads,
    ]
    let js = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
    try js.write(to: URL(fileURLWithPath: outdir).appendingPathComponent("\(prefix)-metrics.json"))
    print(String(format: "load %.2fs warmup %.2fs peak RSS %.0f MB footprint %.0f MB", loadS, warmS,
                 Double(peakRSSBytes()) / 1e6, Double(physFootprint()) / 1e6))

case "chunk-noise":
    // Synthesize one phoneme chunk with noise from a raw float32 file (Python parity check).
    guard let ph = arg("--phonemes"), let noisePath = arg("--noise"), let out = arg("--out") else {
        die("--phonemes --noise --out")
    }
    let raw = try Data(contentsOf: URL(fileURLWithPath: noisePath))
    let noise = raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    let tts = try makeTTS()
    var o = SynthesisOptions()
    o.paceBlend = arg("--pace").flatMap(Double.init) ?? 0
    let wav = try await tts._synthesizeChunkForTesting(phonemes: ph, language: arg("--lang") ?? "he",
                                                       voice: arg("--voice"), noise: noise, options: o)
    try wav.withUnsafeBytes { try Data($0).write(to: URL(fileURLWithPath: out)) }
    print("wrote \(wav.count) samples")

default:
    print("usage: bluetts-cli synth|stream|bench|phonemize|chunk-noise ...")
}
