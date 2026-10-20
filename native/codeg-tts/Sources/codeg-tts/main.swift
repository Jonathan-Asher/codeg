// codeg-tts: BlueTTS 2.5 + RenikudPlus as a long-running sidecar of the codeg
// backend. Requests come in on stdin, audio goes out on stdout; the wire
// format is documented on `CodegTTSProtocol`. Diagnostics go to stderr.
//
// The models load once (on `load` or the first `synthesize`) and stay loaded
// for as long as the process lives; the backend ends the process when read
// aloud has been idle for a while, which is what gives the memory back.

import BlueTTSEspeak
import BlueTTSKit
import CodegTTSCore
import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IONBF, 0)

let launch = LaunchOptions.parse(CommandLine.arguments, environment: ProcessInfo.processInfo.environment)

if launch.printVersion {
    print("codeg-tts protocol \(CodegTTSProtocol.version), espeak-ng \(EspeakPhonemizer.version)")
    exit(0)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[codeg-tts] \(message)\n".utf8))
}

let writer = FrameWriter(handle: .standardOutput) {
    // The backend is gone; nothing left to speak for.
    exit(0)
}

guard let modelsDirectory = launch.modelsDirectory else {
    writer.send(.error(id: nil, message: "no models directory (--models)"))
    exit(2)
}

let executable = EspeakDataLocator.currentExecutable()
guard let espeakData = EspeakDataLocator.locate(executable: executable,
                                                explicit: launch.espeakDataDirectory,
                                                environment: ProcessInfo.processInfo.environment) else {
    writer.send(.error(id: nil, message: "espeak-ng data not found next to \(executable.path)"))
    exit(3)
}

let phonemizer: EspeakPhonemizer
do {
    phonemizer = try EspeakPhonemizer(dataDirectory: espeakData)
} catch {
    writer.send(.error(id: nil, message: "espeak-ng: \(error)"))
    exit(3)
}

var configuration = BlueTTSConfiguration()
if let threads = launch.threads { configuration.threads = threads }
if let voice = launch.defaultVoice, Request.isSafeVoiceName(voice) { configuration.defaultVoice = voice }
let tts = BlueTTS(modelDirectory: modelsDirectory, englishPhonemizer: phonemizer, configuration: configuration)

func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let d = ContinuousClock.now - start
    return Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
}

func describe(_ error: Error) -> String {
    String(describing: error)
}

/// Runs requests in arrival order. Each synthesis is its own task, so a
/// `cancel` that arrives while it runs is handled at once; BlueTTS itself
/// runs one inference at a time, so a second request waits for the first.
actor Server {
    private let tts: BlueTTS
    private let writer: FrameWriter
    private var running: [UInt64: Task<Void, Never>] = [:]

    init(tts: BlueTTS, writer: FrameWriter) {
        self.tts = tts
        self.writer = writer
    }

    func handle(_ request: Request) {
        switch request {
        case .synthesize(let req):
            guard running[req.id] == nil else {
                writer.send(.error(id: req.id, message: "request \(req.id) is already running"))
                return
            }
            let tts = self.tts, writer = self.writer
            running[req.id] = Task.detached(priority: .userInitiated) {
                await Server.synthesize(req, tts: tts, writer: writer)
                await self.finished(req.id)
            }
        case .cancel(let id):
            running[id]?.cancel()
        case .load:
            let tts = self.tts, writer = self.writer
            Task.detached(priority: .userInitiated) {
                let start = ContinuousClock.now
                do {
                    try await tts.load()
                    writer.send(.loaded(ms: milliseconds(since: start)))
                } catch {
                    writer.send(.error(id: nil, message: "loading the models failed: \(describe(error))"))
                }
            }
        case .shutdown:
            break
        }
    }

    private func finished(_ id: UInt64) {
        running[id] = nil
    }

    private static func synthesize(_ req: SynthesizeRequest, tts: BlueTTS, writer: FrameWriter) async {
        var options = SynthesisOptions()
        options.voice = req.voice
        options.speed = req.speed
        let start = ContinuousClock.now
        var chunks = 0
        var audioSamples = 0
        var sampleRate = tts.sampleRate
        var firstChunkMs: Int?
        func done(cancelled: Bool) {
            let audioMs = sampleRate > 0 ? audioSamples * 1000 / sampleRate : 0
            writer.send(.done(id: req.id, chunks: chunks, cancelled: cancelled, audioMs: audioMs,
                              elapsedMs: milliseconds(since: start), firstChunkMs: firstChunkMs))
        }
        guard !req.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            done(cancelled: false)
            return
        }
        do {
            for try await chunk in tts.synthesizeStream(req.text, options: options) {
                if Task.isCancelled { break }
                let elapsed = milliseconds(since: start)
                if firstChunkMs == nil { firstChunkMs = elapsed }
                sampleRate = chunk.sampleRate
                audioSamples += chunk.samples.count
                writer.send(.chunk(id: req.id, index: chunks, sampleRate: chunk.sampleRate,
                                   isFinal: chunk.isFinal, elapsedMs: elapsed, pcm: PCM.s16le(chunk.samples)))
                chunks += 1
            }
            done(cancelled: Task.isCancelled)
        } catch {
            if Task.isCancelled {
                done(cancelled: true)
            } else {
                writer.send(.error(id: req.id, message: describe(error)))
            }
        }
    }
}

let server = Server(tts: tts, writer: writer)
let (requests, requestSink) = AsyncStream<Request>.makeStream()
_ = Task.detached { [server, requests] in
    for await request in requests {
        await server.handle(request)
    }
}

writer.send(.ready(voices: tts.availableVoices(), sampleRate: tts.sampleRate))
log("ready: models \(modelsDirectory.path), espeak-ng data \(espeakData.path)")

// stdin is read on the main thread; everything else runs off it.
while let line = readLine(strippingNewline: true) {
    if line.allSatisfy(\.isWhitespace) { continue }
    let request: Request
    do {
        request = try Request.parse(line)
    } catch {
        writer.send(.error(id: nil, message: describe(error)))
        continue
    }
    if request == .shutdown { break }
    requestSink.yield(request)
}
log("stdin closed or shutdown requested; exiting")
exit(0)
