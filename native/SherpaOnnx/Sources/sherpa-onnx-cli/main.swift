// sherpa-onnx-cli: stream audio files through StreamingTransducerRecognizer
// on macOS (the XCFramework's macOS slice, ONNX Runtime 1.30) and print the
// partial-text timeline, the final text and timings.
//
//   swift run -c release sherpa-onnx-cli --dir <model dir> [--threads 2] \
//       [--chunk-ms 100] [--partials] clip.wav ...
//
// --dir takes the first *encoder*.onnx, *decoder*.onnx, *joiner*.onnx and
// *tokens*.txt in the directory; --encoder/--decoder/--joiner/--tokens name
// them one by one. Audio is fed --chunk-ms at a time, as a microphone would,
// and converted to 16 kHz mono first (any format AVFoundation reads).

import AVFoundation
import Foundation
import SherpaOnnx

var options: [String: String] = [:]
var flags: Set<String> = []
var files: [String] = []
var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < arguments.count {
    let argument = arguments[index]
    if argument == "--partials" {
        flags.insert("partials")
    } else if argument.hasPrefix("--"), index + 1 < arguments.count {
        options[String(argument.dropFirst(2))] = arguments[index + 1]
        index += 1
    } else {
        files.append(argument)
    }
    index += 1
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func modelFiles() -> TransducerModelFiles {
    if let encoder = options["encoder"], let decoder = options["decoder"], let joiner = options["joiner"], let tokens = options["tokens"] {
        return TransducerModelFiles(encoder: URL(fileURLWithPath: encoder), decoder: URL(fileURLWithPath: decoder),
                                    joiner: URL(fileURLWithPath: joiner), tokens: URL(fileURLWithPath: tokens))
    }
    guard let dir = options["dir"] else { fail("usage: sherpa-onnx-cli --dir <model dir> [--threads N] [--chunk-ms 100] [--partials] clip.wav ...") }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir))?.sorted() ?? []
    func find(_ part: String, _ ext: String) -> URL {
        guard let name = names.first(where: { $0.contains(part) && $0.hasSuffix(ext) }) else { fail("no *\(part)*\(ext) in \(dir)") }
        return URL(fileURLWithPath: dir).appendingPathComponent(name)
    }
    return TransducerModelFiles(encoder: find("encoder", ".onnx"), decoder: find("decoder", ".onnx"),
                                joiner: find("joiner", ".onnx"), tokens: find("tokens", ".txt"))
}

func readMono16k(_ path: String) throws -> [Float] {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let source = file.processingFormat
    let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: input)
    if source.sampleRate == 16_000, source.channelCount == 1, source.commonFormat == .pcmFormatFloat32 {
        return Array(UnsafeBufferPointer(start: input.floatChannelData![0], count: Int(input.frameLength)))
    }
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    let converter = AVAudioConverter(from: source, to: target)!
    let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / source.sampleRate) + 1_024
    let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)!
    var fed = false
    var error: NSError?
    _ = converter.convert(to: output, error: &error) { _, status in
        if fed { status.pointee = .endOfStream; return nil }
        fed = true
        status.pointee = .haveData
        return input
    }
    if let error { throw error }
    return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
}

let threads = options["threads"].flatMap(Int.init) ?? 2
let chunk = (options["chunk-ms"].flatMap(Int.init) ?? 100) * 16
let versions = StreamingTransducerRecognizer.versions
let loadStart = Date()
let recognizer = try StreamingTransducerRecognizer(files: modelFiles(), threads: threads)
print(String(format: "sherpa-onnx %@ on ONNX Runtime %@; model loaded in %.0f ms; %d threads; %d ms chunks",
             versions.sherpaOnnx, versions.onnxRuntime, Date().timeIntervalSince(loadStart) * 1000, threads, chunk / 16))

var totalAudio = 0.0, totalCompute = 0.0
for path in files {
    let audio = try readMono16k(path)
    let name = (path as NSString).lastPathComponent
    recognizer.reset()
    var compute = 0.0, worstChunk = 0.0
    var firstText: Double?
    var last = ""
    var offset = 0
    while offset < audio.count {
        let end = min(offset + chunk, audio.count)
        let start = Date()
        let text = recognizer.accept(samples: Array(audio[offset..<end]))
        let took = Date().timeIntervalSince(start)
        compute += took
        worstChunk = max(worstChunk, took)
        offset = end
        if text != last {
            if firstText == nil { firstText = Double(offset) / 16_000 }
            if flags.contains("partials") { print(String(format: "  %6.2f s  %@", Double(offset) / 16_000, text)) }
            last = text
        }
    }
    let flushStart = Date()
    let final = recognizer.inputFinished()
    let flush = Date().timeIntervalSince(flushStart)
    let seconds = Double(audio.count) / 16_000
    totalAudio += seconds
    totalCompute += compute + flush
    print(String(format: "%@\t%.2f s audio\tfirst text at %@\tstreaming %.0f ms (RTF %.3f, worst chunk %.0f ms)\tflush %.0f ms",
                 name, seconds, firstText.map { String(format: "%.2f s", $0) } ?? "-", compute * 1000, compute / seconds,
                 worstChunk * 1000, flush * 1000))
    print("  final: \(final)")
}
if totalAudio > 0 {
    print(String(format: "total: %.1f s audio, %.2f s compute, RTF %.3f", totalAudio, totalCompute, totalCompute / totalAudio))
}
