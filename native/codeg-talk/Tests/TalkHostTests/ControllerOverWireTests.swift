@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

// The iPhone's TalkController, driven through the mirror and the backend over
// the wire, with fake engines: what the window sees of a Talk.

@MainActor
final class FakeAudio: TalkAudioIO {
    let frames: AsyncStream<MicFrame>
    let events: AsyncStream<TalkAudioEvent>
    private let frameSink: AsyncStream<MicFrame>.Continuation
    private let eventSink: AsyncStream<TalkAudioEvent>.Continuation
    var route: TalkRoute = .builtIn
    var echoMode: TalkEchoMode = .voiceProcessing
    private(set) var isSpeaking = false
    private(set) var starts = 0
    private(set) var stops = 0
    private(set) var scheduled = 0

    init() {
        (frames, frameSink) = AsyncStream.makeStream(of: MicFrame.self)
        (events, eventSink) = AsyncStream.makeStream(of: TalkAudioEvent.self)
    }

    func start(preferring: TalkEchoMode?) throws { starts += 1 }
    func stop() { stops += 1 }

    func schedule(_ samples: [Float], sampleRate: Double, onPlayed: @escaping @Sendable () -> Void) {
        scheduled += 1
        isSpeaking = true
        Task { @MainActor in
            self.isSpeaking = false
            onPlayed()
        }
    }

    func duck(_ on: Bool) {}
    func stopSpeech() { isSpeaking = false }
    func play(_ earcon: Earcon) {}
    func setInputMuted(_ muted: Bool) {}
}

final class SilentVAD: SpeechActivity {
    func probability(_ frame: [Float]) -> Float { 0 }
    func reset() {}
}

final class QuietTranscriber: LiveTranscriber, @unchecked Sendable {
    func begin(preRoll: [Float]) {}
    func accept(_ samples: [Float]) -> String? { nil }
    func flushTail() -> String { "" }
    func finish() -> String { "" }
    func reset() {}
    func transcribeOnce(_ clip: [Float]) -> String { "" }
}

@MainActor
final class ToneSynthesizer: Synthesizer {
    func synthesize(_ unit: SpeechUnit) -> AsyncThrowingStream<SpeechChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(SpeechChunk(samples: [Float](repeating: 0.1, count: 160), sampleRate: 16_000))
            continuation.finish()
        }
    }
}

@MainActor
final class FakeSystem: TalkSystem {
    var onEvent: ((TalkSystemEvent) -> Void)?

    func loadEngines() async throws -> TalkEngineSet {
        TalkEngineSet(vad: SilentVAD(), live: QuietTranscriber(), turn: nil, synthesizer: ToneSynthesizer(),
                      naturalVoice: true)
    }

    func releaseEngines() {}
    var finalTranscriber: FinalTranscriber? { nil }
    var isWhisperLoaded: Bool { false }
    func loadWhisper() async -> Bool { false }
    func unloadWhisper() {}
    var availableMemory: UInt64 { 8 << 30 }
    var thermalState: String { "nominal" }
    var isInBackground: Bool { false }
    var callActive: Bool { false }
    func setIdleTimerDisabled(_ disabled: Bool) {}
    func setNowPlaying(title: String?) {}
    func setRemoteTarget(_ target: TalkRemoteTarget?) {}
    var reportEnvironment: TalkReportEnvironment {
        TalkReportEnvironment(app: ["version": "test"], device: ["model": "Mac", "os": "macOS 26"])
    }
}

/// Timers fired by hand.
@MainActor
final class ManualScheduler: TalkScheduler {
    final class Item: TalkScheduled {
        let at: TimeInterval
        let action: @MainActor () -> Void
        var cancelled = false

        init(at: TimeInterval, action: @escaping @MainActor () -> Void) {
            self.at = at
            self.action = action
        }

        func cancel() { cancelled = true }
    }

    let clock: ManualClock
    private(set) var items: [Item] = []

    init(clock: ManualClock) {
        self.clock = clock
    }

    func schedule(after seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> TalkScheduled {
        let item = Item(at: clock.time + seconds, action: action)
        items.append(item)
        return item
    }

    /// Move the clock on, firing what falls due.
    func advance(_ seconds: TimeInterval) {
        clock.time += seconds
        while let next = items.filter({ !$0.cancelled && $0.at <= clock.time }).min(by: { $0.at < $1.at }) {
            next.cancelled = true
            next.action()
        }
    }
}

final class ManualClock: TalkClock, @unchecked Sendable {
    var time: TimeInterval = 1000
    func now() -> TimeInterval { time }
}

@MainActor
struct ControllerOverWireTests {
    let sink = RecordingSink()

    func lastState() -> NSDictionary? {
        sink.objects.last { $0["type"] as? String == "state" }
    }

    func lastFlags() -> [Bool]? {
        sink.objects.last { $0["type"] as? String == "flags" }.map {
            [$0["holdSession"] as? Bool ?? false, $0["keepsStreamAttached"] as? Bool ?? false,
             $0["isTalking"] as? Bool ?? false]
        }
    }

    static func prefs() -> TalkPrefs {
        TalkPrefs(defaults: UserDefaults(suiteName: "codeg-talk-tests-\(UUID().uuidString)")!)
    }

    @Test func aTalkOverTheWire() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let flags = WireFlags(sink: sink)
        var snapshot = PortSnapshot()
        snapshot.title = "Fix the build"
        snapshot.pendingPermission = PendingPermission(
            requestId: "perm-7", toolCall: .object(["title": .string("rm -rf build"), "kind": .string("execute")]),
            options: [PermissionOption(optionId: "allow", name: "Allow", kind: "allow_once"),
                      PermissionOption(optionId: "always", name: "Always allow", kind: "allow_always"),
                      PermissionOption(optionId: "deny", name: "Reject", kind: "reject_once")])
        let port = MirrorPort(conversationID: 42, snapshot: snapshot,
                              live: WireLive(turnId: "42:7", text: "בדקתי את הלוגים.", streaming: false),
                              requests: requests, flags: flags, sink: sink)
        let backend = BridgeBackend(conversationID: 42, settings: nil, items: [], requests: requests, flags: flags)
        let audio = FakeAudio()
        let controller = TalkController(
            conversationID: 42, title: "Fix the build", port: port,
            dependencies: TalkDependencies(audio: audio, system: FakeSystem(), backend: backend, prefs: Self.prefs()))
        let publisher = UIStatePublisher(controller: controller, sink: sink, scheduler: TaskTalkScheduler(),
                                         clock: SystemTalkClock())
        publisher.start()
        controller.start()

        // The session is held and its stream kept attached; Talk mode is asked for.
        #expect(await waitUntil { !sink.requests("setTalkMode").isEmpty })
        #expect(sink.requests("setTalkMode").first?["enabled"] as? Bool == true)
        #expect(lastFlags() == [true, true, false])
        try answer(sink, requests, op: "setTalkMode")
        // Presence says `talking` once the server took Talk mode; then the settings.
        #expect(await waitUntil { !sink.requests("fetchSettings").isEmpty })
        #expect(lastFlags() == [true, true, true])
        try answer(sink, requests, op: "fetchSettings",
                   value: .object(["language": .string("he"), "address": .string("masculine")]))

        // The waiting permission (replayed by the mirror) is asked.
        #expect(await waitUntil { controller.ask?.id == "permission:perm-7" })
        #expect(await waitUntil { lastState()?["status"] as? String == "asking" })
        let ask = try #require(lastState()?["ask"] as? NSDictionary)
        #expect((ask["choices"] as? [NSDictionary])?.compactMap { $0["id"] as? String } == ["allow", "always", "deny"])
        #expect(ask["kind"] as? String == "permission")
        #expect(audio.starts == 1)
        #expect(audio.scheduled >= 1)
        // The live turn was taken as heard, not spoken.
        let spoken = (lastState()?["spoken"] as? [NSDictionary])?.compactMap { $0["text"] as? String } ?? []
        #expect(!spoken.contains("בדקתי את הלוגים."))

        // A choice button answers the card by its id.
        let allow = try #require(controller.ask?.choices.first { $0.id == "allow" })
        controller.choose(allow)
        #expect(await waitUntil { !sink.requests("respondPermission").isEmpty })
        let request = try #require(sink.requests("respondPermission").last)
        #expect(request["requestId"] as? String == "perm-7")
        #expect(request["optionId"] as? String == "allow")
        try answer(sink, requests, op: "respondPermission", value: .bool(true))
        var gone = PortChange()
        gone.pendingPermission = .set(nil)
        port.apply(gone)
        #expect(await waitUntil { controller.ask == nil })

        // Spoken text from the agent is spoken.
        let before = audio.scheduled
        port.setLive(WireLive(turnId: "42:8", text: "מחקתי את תיקיית הבילד. ", streaming: true))
        port.turnEnded(turnID: "42:8", stopReason: "end_turn")
        #expect(await waitUntil { audio.scheduled > before })

        // The end: Talk mode off, the session let go, the reports sent.
        controller.end()
        #expect(await waitUntil { sink.requests("setTalkMode").count == 2 })
        #expect(sink.requests("setTalkMode").last?["enabled"] as? Bool == false)
        try answer(sink, requests, op: "setTalkMode")
        #expect(await waitUntil { lastFlags() == [false, false, false] })
        #expect(await waitUntil { !sink.requests("uploadReport").isEmpty })
        let report = try #require(sink.requests("uploadReport").first?["report"] as? NSDictionary)
        #expect(report["kind"] as? String == "talk_lab")
        #expect((report["device"] as? NSDictionary)?["os"] as? String == "macOS 26")
        for upload in sink.requests("uploadReport") {
            requests.resolve(WireResponse(id: upload["id"] as! Int, ok: true, value: nil, error: nil))
        }
        #expect(audio.stops >= 1)
        publisher.stop()
        #expect(lastState()?["status"] as? String == "ended")
        #expect(!controller.isActive)
    }

    @Test func stateIsSentAtMostTwentyTimesASecond() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let flags = WireFlags(sink: sink)
        let port = MirrorPort(conversationID: 42, snapshot: PortSnapshot(), live: nil, requests: requests,
                              flags: flags, sink: sink)
        let backend = BridgeBackend(conversationID: 42, settings: nil, items: [], requests: requests, flags: flags)
        let controller = TalkController(
            conversationID: 42, title: "t", port: port,
            dependencies: TalkDependencies(audio: FakeAudio(), system: FakeSystem(), backend: backend,
                                           prefs: Self.prefs()))
        let clock = ManualClock()
        let scheduler = ManualScheduler(clock: clock)
        let publisher = UIStatePublisher(controller: controller, sink: sink, scheduler: scheduler, clock: clock)
        publisher.start()
        let states = { sink.objects.filter { $0["type"] as? String == "state" } }
        #expect(states().count == 1)

        // A burst within 50 ms: one more state, after the interval, with the latest values.
        controller.setHandsFree(false)
        await settle()
        controller.setHandsFree(true)
        await settle()
        controller.setHandsFree(false)
        await settle()
        #expect(states().count == 1)
        scheduler.advance(0.049)
        #expect(states().count == 1)
        scheduler.advance(0.002)
        #expect(states().count == 2)
        #expect(states().last?["handsFree"] as? Bool == false)

        // Levels: 15 a second, only when they move.
        let levels = { sink.objects.filter { $0["type"] as? String == "level" } }
        scheduler.advance(1.0 / 15 + 0.001)
        scheduler.advance(1.0 / 15 + 0.001)
        #expect(levels().count == 1)
        #expect(levels().first?["in"] as? Double == 0)
        publisher.stop()
    }
}
