import Foundation
import Testing
@testable import CodegTTSCore

/// Split encoded frames back into (header, payload) pairs, the way the
/// backend's reader does.
func decodeFrames(_ data: Data) throws -> [([String: Any], Data)] {
    var frames: [([String: Any], Data)] = []
    var rest = data[...]
    while !rest.isEmpty {
        guard let newline = rest.firstIndex(of: 0x0A) else {
            Issue.record("frame without a header newline")
            break
        }
        let headerData = rest[rest.startIndex..<newline]
        let header = try #require(try JSONSerialization.jsonObject(with: Data(headerData)) as? [String: Any])
        let bytes = (header["bytes"] as? Int) ?? 0
        let payloadStart = rest.index(after: newline)
        let payloadEnd = rest.index(payloadStart, offsetBy: bytes)
        frames.append((header, Data(rest[payloadStart..<payloadEnd])))
        rest = rest[payloadEnd...]
    }
    return frames
}

@Suite struct RequestParsing {
    @Test func synthesizeWithDefaults() throws {
        let r = try Request.parse(#"{"op":"synthesize","id":7,"text":"שלום world"}"#)
        #expect(r == .synthesize(SynthesizeRequest(id: 7, text: "שלום world", voice: nil, speed: 1.0)))
    }

    @Test func synthesizeWithVoiceAndSpeed() throws {
        let r = try Request.parse(#"{"op":"synthesize","id":1,"text":"hi","voice":"adam","speed":1.3}"#)
        #expect(r == .synthesize(SynthesizeRequest(id: 1, text: "hi", voice: "adam", speed: 1.3)))
    }

    @Test func emptyVoiceMeansDefault() throws {
        let r = try Request.parse(#"{"op":"synthesize","id":1,"text":"hi","voice":""}"#)
        #expect(r == .synthesize(SynthesizeRequest(id: 1, text: "hi", voice: nil, speed: 1.0)))
    }

    @Test(arguments: [(0.1, 0.5), (5.0, 2.0), (0.9, 0.9)])
    func speedIsClamped(input: Double, expected: Double) throws {
        let r = try Request.parse(#"{"op":"synthesize","id":1,"text":"hi","speed":\#(input)}"#)
        #expect(r == .synthesize(SynthesizeRequest(id: 1, text: "hi", speed: expected)))
    }

    @Test func voiceNamesCannotLeaveTheModelsDirectory() {
        #expect(throws: RequestError.self) {
            try Request.parse(#"{"op":"synthesize","id":1,"text":"hi","voice":"../../etc/passwd"}"#)
        }
        #expect(Request.isSafeVoiceName("noa"))
        #expect(Request.isSafeVoiceName("my_voice-2"))
        #expect(!Request.isSafeVoiceName("a/b"))
        #expect(!Request.isSafeVoiceName("נועה"))
        #expect(!Request.isSafeVoiceName(""))
    }

    @Test func otherOps() throws {
        #expect(try Request.parse(#"{"op":"cancel","id":9}"#) == .cancel(id: 9))
        #expect(try Request.parse(#"{"op":"load"}"#) == .load)
        #expect(try Request.parse(#"{"op":"shutdown"}"#) == .shutdown)
    }

    @Test func errors() {
        #expect(throws: RequestError.unknownOp("sing")) { try Request.parse(#"{"op":"sing"}"#) }
        #expect(throws: RequestError.missingField("text")) { try Request.parse(#"{"op":"synthesize","id":1}"#) }
        #expect(throws: RequestError.missingField("id")) { try Request.parse(#"{"op":"cancel"}"#) }
        #expect(throws: RequestError.self) { try Request.parse("not json") }
        let long = String(repeating: "a", count: CodegTTSProtocol.maxTextLength + 1)
        #expect(throws: RequestError.self) {
            try Request.parse(#"{"op":"synthesize","id":1,"text":"\#(long)"}"#)
        }
    }
}

@Suite struct EventEncoding {
    @Test func chunkCarriesItsPayload() throws {
        let pcm = Data([1, 0, 2, 0, 3, 0])
        let data = Event.chunk(id: 4, index: 0, sampleRate: 44100, isFinal: true, elapsedMs: 812, pcm: pcm).encoded()
        let frames = try decodeFrames(data)
        #expect(frames.count == 1)
        let (header, payload) = frames[0]
        #expect(header["event"] as? String == "chunk")
        #expect(header["id"] as? Int == 4)
        #expect(header["bytes"] as? Int == 6)
        #expect(header["samples"] as? Int == 3)
        #expect(header["format"] as? String == "s16le")
        #expect(header["final"] as? Bool == true)
        #expect(header["elapsedMs"] as? Int == 812)
        #expect(payload == pcm)
    }

    @Test func eventsWithoutPayloadAreOneLine() throws {
        let events: [Event] = [
            .ready(voices: ["adam", "noa"], sampleRate: 44100),
            .loaded(ms: 1500),
            .done(id: 3, chunks: 2, cancelled: false, audioMs: 4000, elapsedMs: 900, firstChunkMs: 400),
            .done(id: 5, chunks: 0, cancelled: true, audioMs: 0, elapsedMs: 10, firstChunkMs: nil),
            .error(id: nil, message: "boom"),
            .error(id: 8, message: "voice x not found"),
        ]
        var all = Data()
        for e in events {
            let d = e.encoded()
            #expect(d.last == 0x0A)
            #expect(d.filter { $0 == 0x0A }.count == 1)
            all.append(d)
        }
        let frames = try decodeFrames(all)
        #expect(frames.count == events.count)
        #expect(frames[0].0["protocol"] as? Int == CodegTTSProtocol.version)
        #expect(frames[0].0["voices"] as? [String] == ["adam", "noa"])
        #expect(frames[2].0["firstChunkMs"] as? Int == 400)
        #expect(frames[3].0["firstChunkMs"] == nil)
        #expect(frames[3].0["cancelled"] as? Bool == true)
        #expect(frames[4].0["id"] == nil)
        #expect(frames[5].0["id"] as? Int == 8)
    }

    @Test func framesInterleaveCleanly() throws {
        var data = Event.chunk(id: 1, index: 0, sampleRate: 44100, isFinal: false, elapsedMs: 1,
                               pcm: Data("\n{\"event\":\"x\"}\n".utf8) + Data([0, 0])).encoded()
        data.append(Event.done(id: 1, chunks: 1, cancelled: false, audioMs: 1, elapsedMs: 2, firstChunkMs: 1).encoded())
        let frames = try decodeFrames(data)
        #expect(frames.map { $0.0["event"] as? String } == ["chunk", "done"])
    }
}

@Suite struct PCMConversion {
    @Test func scalesClipsAndRounds() {
        let data = PCM.s16le([0, 1, -1, 0.5, 2, -3, .nan, 0.00002])
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)).map { Int16(littleEndian: $0) } }
        #expect(values == [0, 32767, -32767, 16384, 32767, -32767, 0, 1])
    }

    @Test func wavHeader() {
        let pcm = PCM.s16le([0, 0.5])
        let wav = PCM.wav(pcm, sampleRate: 44100)
        #expect(wav.count == 44 + 4)
        #expect(String(decoding: wav[0..<4], as: UTF8.self) == "RIFF")
        #expect(String(decoding: wav[8..<12], as: UTF8.self) == "WAVE")
        #expect(wav[44...] == pcm[...])
    }
}

@Suite struct Launching {
    @Test func parsesArguments() {
        let o = LaunchOptions.parse(["codeg-tts", "--models", "/m", "--espeak-data", "/e", "--voice", "adam",
                                     "--threads", "4"], environment: [:])
        #expect(o.modelsDirectory?.path == "/m")
        #expect(o.espeakDataDirectory?.path == "/e")
        #expect(o.defaultVoice == "adam")
        #expect(o.threads == 4)
        #expect(!o.printVersion)
    }

    @Test func modelsFromEnvironment() {
        let o = LaunchOptions.parse(["codeg-tts"], environment: ["CODEG_TTS_MODELS": "/env/models"])
        #expect(o.modelsDirectory?.path == "/env/models")
        #expect(LaunchOptions.parse(["codeg-tts", "--threads", "0"], environment: [:]).threads == nil)
        #expect(LaunchOptions.parse(["codeg-tts", "--version"], environment: [:]).printVersion)
    }

    @Test func espeakDataInsideTheAppBundleComesBeforeLooseCopies() {
        let exe = URL(fileURLWithPath: "/Applications/codeg.app/Contents/MacOS/codeg-tts")
        let paths = EspeakDataLocator.candidates(executable: exe, explicit: nil, environment: [:]).map(\.path)
        #expect(paths.first == "/Applications/codeg.app/Contents/Resources/tts/espeak-ng-data")
        #expect(paths.contains("/Applications/codeg.app/Contents/MacOS/BlueTTSKit_BlueTTSEspeak.bundle/Contents/Resources/espeak-ng-data"))
    }

    @Test func explicitAndEnvironmentWin() {
        let exe = URL(fileURLWithPath: "/x/codeg-tts")
        let paths = EspeakDataLocator.candidates(executable: exe, explicit: URL(fileURLWithPath: "/explicit"),
                                                 environment: [EspeakDataLocator.environmentKey: "/env"]).map(\.path)
        #expect(Array(paths.prefix(2)) == ["/explicit", "/env"])
    }

    @Test func locateTakesTheFirstDirectoryWithData() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("codeg-tts-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let exe = root.appendingPathComponent("bin/codeg-tts")
        let data = root.appendingPathComponent("bin/espeak-ng-data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        #expect(EspeakDataLocator.locate(executable: exe, explicit: nil, environment: [:]) == nil)
        try Data().write(to: data.appendingPathComponent("phontab"))
        #expect(EspeakDataLocator.locate(executable: exe, explicit: nil, environment: [:])?.path == data.path)
    }
}

@Suite struct Writing {
    @Test func writerSendsWholeFramesFromManyThreads() async throws {
        let pipe = Pipe()
        let writer = FrameWriter(handle: pipe.fileHandleForWriting) {}
        let pcm = PCM.s16le([Float](repeating: 0.25, count: 20_000))
        // Drain the pipe while writing: the frames are larger than its buffer.
        let readEnd = pipe.fileHandleForReading
        let reading = Task.detached { readEnd.readDataToEndOfFile() }
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<8 {
                group.addTask {
                    writer.send(.chunk(id: UInt64(i), index: 0, sampleRate: 44100, isFinal: true, elapsedMs: i, pcm: pcm))
                }
                group.addTask { writer.send(.error(id: UInt64(i), message: "m\(i)")) }
            }
        }
        try pipe.fileHandleForWriting.close()
        let data = await reading.value
        let frames = try decodeFrames(data)
        #expect(frames.count == 16)
        #expect(frames.filter { $0.0["event"] as? String == "chunk" }.allSatisfy { $0.1 == pcm })
    }

    @Test func brokenPipeIsReported() throws {
        let pipe = Pipe()
        try pipe.fileHandleForReading.close()
        let flag = Flag()
        let writer = FrameWriter(handle: pipe.fileHandleForWriting) { flag.set() }
        signal(SIGPIPE, SIG_IGN)
        writer.send(.loaded(ms: 1))
        #expect(flag.isSet)
    }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}
