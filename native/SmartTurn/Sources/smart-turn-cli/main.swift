// smart-turn-cli: Smart Turn probabilities and timings over audio files, with
// the package's own front end and ONNX Runtime 1.30 (macOS).
//
//   swift run -c release smart-turn-cli --model smart-turn-v3.2-cpu.onnx \
//       [--threads 2] [--cut 0.6] [--dump DIR] clip.wav ...
//
// For each clip: the probability for the whole clip (its last 8 s), and for
// the clip cut at --cut of its length, which usually ends mid-sentence. Any
// format AVFoundation reads; converted to 16 kHz mono. --dump writes each
// clip's features (80 × 800 Float32, mel-major) to DIR/<clip>.f32, to compare
// with the reference pipeline (scripts/mel_reference.py).

import AVFoundation
import Foundation
import SmartTurn

var options: [String: String] = [:]
var files: [String] = []
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    if argument.hasPrefix("--") { options[String(argument.dropFirst(2))] = arguments.next() } else { files.append(argument) }
}
guard let model = options["model"], !files.isEmpty else {
    FileHandle.standardError.write(Data("usage: smart-turn-cli --model smart-turn-v3.2-cpu.onnx [--threads N] [--cut 0.6] clip.wav ...\n".utf8))
    exit(2)
}

func readMono16k(_ path: String) throws -> [Float] {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let source = file.processingFormat
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: input)
    if source.sampleRate == 16_000, source.channelCount == 1, source.commonFormat == .pcmFormatFloat32 {
        return Array(UnsafeBufferPointer(start: input.floatChannelData![0], count: Int(input.frameLength)))
    }
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
let cut = options["cut"].flatMap(Double.init) ?? 0.6
let loadStart = Date()
let classifier = try SmartTurnClassifier(modelURL: URL(fileURLWithPath: model), threads: threads)
print(String(format: "model loaded in %.0f ms, %d threads", Date().timeIntervalSince(loadStart) * 1000, threads))
_ = try classifier.predict([Float](repeating: 0, count: 16_000))  // warm-up

let frontEnd = WhisperLogMel()
var timings: [Double] = []
for path in files {
    let audio = try readMono16k(path)
    let name = (path as NSString).lastPathComponent
    let featureStart = Date()
    let features = frontEnd.features(audio)
    let featureMs = Date().timeIntervalSince(featureStart) * 1000
    if let dump = options["dump"] {
        let url = URL(fileURLWithPath: dump).appendingPathComponent((name as NSString).deletingPathExtension + ".f32")
        try features.withUnsafeBytes { try Data($0).write(to: url) }
    }
    let start = Date()
    let whole = try classifier.predict(audio)
    let ms = Date().timeIntervalSince(start) * 1000
    timings.append(ms)
    let partial = try classifier.predict(Array(audio.prefix(Int(Double(audio.count) * cut))))
    print(String(format: "%@\t%.2f s\tcomplete %.3f\tcut at %.0f%% %.3f\t%.1f ms (front end %.1f ms)",
                 name, Double(audio.count) / 16_000, whole, cut * 100, partial, ms, featureMs))
}
if !timings.isEmpty {
    let sorted = timings.sorted()
    print(String(format: "inference: median %.1f ms, max %.1f ms over %d clips", sorted[sorted.count / 2], sorted.last!, sorted.count))
}
