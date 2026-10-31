@testable import TalkHost
import Darwin
import Foundation
import whisper

/// The command line (`codeg-talk --help`).
public struct HelperOptions: Sendable {
    /// espeak-ng's English data when `start.models.espeakData` doesn't say.
    public var espeakData: URL?
    /// Exit this long after the last Talk ended (or after launch, without one).
    public var idleExit: TimeInterval = 120

    public init() {}

    public static func parse(_ arguments: [String], environment: [String: String]) -> HelperOptions {
        func value(_ name: String) -> String? {
            guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
            let v = arguments[i + 1]
            return v.isEmpty ? nil : v
        }
        var o = HelperOptions()
        if let e = value("--espeak-data") ?? environment["CODEG_TALK_ESPEAK_DATA"].flatMap({ $0.isEmpty ? nil : $0 }) {
            o.espeakData = URL(fileURLWithPath: e)
        }
        if let s = value("--idle-exit").flatMap(Double.init), s > 0 { o.idleExit = s }
        return o
    }
}

/// `codeg-talk --probe`: one JSON line about this Mac and the helper.
public enum HelperProbe {
    public static var line: String {
        // A call into whisper.framework that touches no backend: Metal's
        // start-up (seconds on a busy Mac) waits for the first Talk.
        let whisperLoads = whisper_lang_max_id() > 0 && whisper_lang_id("he") >= 0
        #if arch(arm64)
        let arm64 = true
        #else
        let arm64 = false
        #endif
        let object: [String: Any] = [
            "protocol": TalkWire.version, "version": TalkWire.helperVersion, "macos": MacTalkSystem.osVersion(),
            "arm64": arm64, "whisperLoads": whisperLoads, "mic": MacTalkSystem.microphoneStatus(),
        ]
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    public static var versionLine: String {
        "codeg-talk \(TalkWire.helperVersion), protocol \(TalkWire.version)"
    }
}

/// Writes the helper's lines to stdout, whole and in order, on one serial
/// queue.
final class LineWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "codeg-talk.stdout", qos: .userInitiated)
    private let handle = FileHandle.standardOutput

    func write(_ data: Data) {
        queue.async { [handle] in
            do {
                try handle.write(contentsOf: data)
            } catch {
                // codeg went away: nothing is left to talk to.
                TalkLog.write("stdout closed; exiting")
                exit(0)
            }
        }
    }

    /// Wait until everything written so far is out.
    func flush() {
        queue.sync {}
    }
}

/// One Talk: the mirror, the backend, the engines and the controller.
@MainActor
final class TalkSession {
    let conversationID: Int
    let port: MirrorPort
    let backend: BridgeBackend
    let flags: WireFlags
    let audio: MacTalkAudioEngine
    let system: MacTalkSystem
    let controller: TalkController
    let publisher: UIStatePublisher

    init(conversationID: Int, port: MirrorPort, backend: BridgeBackend, flags: WireFlags, audio: MacTalkAudioEngine,
         system: MacTalkSystem, controller: TalkController, publisher: UIStatePublisher) {
        self.conversationID = conversationID
        self.port = port
        self.backend = backend
        self.flags = flags
        self.audio = audio
        self.system = system
        self.controller = controller
        self.publisher = publisher
    }
}

/// Starts the helper (the executable's entry point).
public enum TalkHelperMain {
    @MainActor
    public static func start(options: HelperOptions) {
        TalkHelper.start(options: options)
    }
}

/// The helper: reads the window's messages in order on the main actor, runs
/// one Talk at a time, writes the helper's messages to stdout, and exits a
/// while after the last Talk.
@MainActor
final class TalkHelper: WireSink {
    private static var running: TalkHelper?

    private let options: HelperOptions
    private let writer = LineWriter()
    private lazy var requests = WireRequests(sink: self)
    private var talk: TalkSession?
    private var idleTimer: Task<Void, Never>?
    private var endTimer: Task<Void, Never>?

    init(options: HelperOptions) {
        self.options = options
    }

    /// Start the helper: `hello`, the stdin reader, the idle clock.
    static func start(options: HelperOptions) {
        let helper = TalkHelper(options: options)
        running = helper
        helper.run()
    }

    private func run() {
        send(.hello(mic: MacTalkSystem.microphoneStatus()))
        TalkLog.write("ready (protocol \(TalkWire.version), helper \(TalkWire.helperVersion), macOS \(MacTalkSystem.osVersion()))")
        let (lines, sink) = AsyncStream.makeStream(of: String.self, bufferingPolicy: .unbounded)
        // One reader thread, one consumer on the main actor: the window's
        // messages are handled in the order they were written.
        let reader = Thread {
            while let line = readLine(strippingNewline: true) {
                if !line.allSatisfy(\.isWhitespace) { sink.yield(line) }
            }
            sink.finish()
        }
        reader.name = "codeg-talk.stdin"
        reader.start()
        Task { @MainActor [weak self] in
            for await line in lines { self?.receive(line) }
            self?.stdinClosed()
        }
        scheduleIdleExit()
    }

    func send(_ message: Outbound) {
        writer.write(message.line())
    }

    // MARK: - The window's messages

    func receive(_ line: String) {
        let message: Inbound
        do {
            message = try Inbound.parse(line)
        } catch {
            TalkLog.write("dropped a message: \(error)")
            send(.error(message: String(describing: error)))
            return
        }
        switch message {
        case .start(let start): begin(start)
        case .res(let response): requests.resolve(response)
        case .end: endTalk()
        case .port(let change): talk?.port.apply(change)
        case .live(let live): talk?.port.setLive(live)
        case .turnEnded(let turnID, let stopReason): talk?.port.turnEnded(turnID: turnID, stopReason: stopReason)
        case .awaiting(let value): talk?.port.setAwaitingBackground(value)
        case .bgTurns(let turns): talk?.port.backgroundTurns(turns)
        case .items(let items): talk?.backend.setItems(items)
        case .control(let control): perform(control)
        case .settings(let settings): talk?.backend.updateSettings(settings)
        case .prefs(let prefs): apply(prefs)
        }
    }

    private func begin(_ start: WireStart) {
        guard start.protocolVersion == TalkWire.version else {
            send(.error(message: "protocol \(start.protocolVersion) isn't this helper's \(TalkWire.version)"))
            send(.ended(reason: "failed", error: "This version of codeg's Talk helper doesn't match the app."))
            return
        }
        if let old = talk {
            TalkLog.write("a new Talk replaces the one with \(old.conversationID)")
            talk = nil
            old.controller.onEnded = nil
            old.flags.silence()
            old.publisher.stop()
            old.controller.end()
            send(.ended(reason: "replaced", error: nil))
        }
        idleTimer?.cancel()
        idleTimer = nil
        endTimer?.cancel()
        endTimer = nil

        let prefs = Self.prefs(start.prefs)
        let flags = WireFlags(sink: self)
        let port = MirrorPort(conversationID: start.conversationID, snapshot: start.port, live: start.live,
                              requests: requests, flags: flags, sink: self)
        let backend = BridgeBackend(conversationID: start.conversationID, settings: start.settings,
                                    items: start.items, requests: requests, flags: flags)
        let audio = MacTalkAudioEngine()
        let system = MacTalkSystem(models: start.models, voice: start.voice, folder: start.folder,
                                   title: start.title, app: start.app, espeakFallback: espeakData(start))
        let controller = TalkController(conversationID: start.conversationID, title: start.title, port: port,
                                        dependencies: TalkDependencies(audio: audio, system: system,
                                                                       backend: backend, prefs: prefs))
        let publisher = UIStatePublisher(
            controller: controller, sink: self, scheduler: TaskTalkScheduler(), clock: SystemTalkClock(),
            outputLevel: { [weak audio] in audio?.outputLevel },
            extras: { [weak system, weak audio] in
                UIStatePublisher.Extras(mic: system?.microphone ?? MacTalkSystem.microphoneStatus(),
                                        suggestHeadphones: audio?.halfDuplex ?? false)
            })
        let session = TalkSession(conversationID: start.conversationID, port: port, backend: backend, flags: flags,
                                  audio: audio, system: system, controller: controller, publisher: publisher)
        audio.onRouteChange = { [weak publisher] in publisher?.extrasChanged() }
        system.onMicrophoneChange = { [weak publisher] in publisher?.extrasChanged() }
        controller.onEnded = { [weak self, weak session] in
            guard let self, let session else { return }
            self.ended(session)
        }
        talk = session
        TalkLog.write("Talk with \(start.conversationID) starts")
        publisher.start()
        controller.start()
    }

    /// The controller let go of everything.
    private func ended(_ session: TalkSession) {
        guard talk === session else { return }
        talk = nil
        endTimer?.cancel()
        endTimer = nil
        session.publisher.stop()
        var error: String?
        if case .failed(let message) = session.controller.status { error = message }
        send(.ended(reason: error == nil ? "ended" : "failed", error: error))
        TalkLog.write("Talk with \(session.conversationID) ended\(error.map { ": \($0)" } ?? "")")
        scheduleIdleExit()
    }

    /// `end`: the controller says goodbye and lets go; if it hasn't within
    /// a few seconds, it is asked again (which ends it at once).
    private func endTalk() {
        guard let session = talk else { return }
        session.controller.end()
        endTimer?.cancel()
        endTimer = Task { @MainActor [weak self, weak session] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self, let session, self.talk === session else { return }
            session.controller.end()
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, self.talk === session else { return }
            TalkLog.write("the Talk didn't end in 10 s; letting it go")
            session.flags.silence()
            session.audio.stop()
            self.ended(session)
        }
    }

    private func perform(_ control: WireControl) {
        guard let controller = talk?.controller else { return }
        switch control.op {
        case .toggleMute: controller.toggleMuteButton()
        case .softMute: controller.remoteSetMuted(control.value ?? true)
        case .skip: controller.skip()
        case .tapOrb: controller.tapOrb()
        case .press: controller.press(control.down ?? false)
        case .cancelPress: controller.cancelPress()
        case .choose:
            guard let id = control.choiceId, let choice = controller.ask?.choices.first(where: { $0.id == id }) else {
                send(.error(message: "no choice \(control.choiceId ?? "") is offered"))
                return
            }
            controller.choose(choice)
        case .reportCutOff: controller.reportCutOff()
        case .setHandsFree: controller.setHandsFree(control.value ?? true)
        case .repeatLast: controller.remoteRepeat()
        }
    }

    /// `prefs`: kept for the next Talk; hands-free applies now.
    private func apply(_ wire: WirePrefs) {
        let prefs = TalkPrefs(defaults: Self.defaults)
        if let v = wire.handsFree { prefs.handsFree = v }
        if let v = wire.patience.flatMap(TalkPatience.init) { prefs.patience = v }
        if let v = wire.interruptBySpeaking { prefs.interruptBySpeaking = v }
        if let v = wire.speakProgress { prefs.speakProgress = v }
        if let v = wire.smartTurnActive { prefs.smartTurnActive = v }
        if let v = wire.echoMode.flatMap(TalkEchoSetting.init) { prefs.echoMode = v }
        if let v = wire.shareTelemetry { prefs.shareTelemetry = v }
        if let v = wire.handsFree, let controller = talk?.controller, controller.handsFree != v {
            controller.setHandsFree(v)
        }
    }

    private func stdinClosed() {
        TalkLog.write("stdin closed")
        requests.close()
        guard let session = talk else {
            quit()
            return
        }
        session.controller.end()
        Task { @MainActor [weak self] in
            // Long enough for the goodbye's release, without a window to wait for.
            try? await Task.sleep(for: .seconds(2))
            if let talk = self?.talk { talk.audio.stop() }
            self?.quit()
        }
    }

    private func scheduleIdleExit() {
        idleTimer?.cancel()
        let seconds = options.idleExit
        idleTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
            guard !Task.isCancelled, let self, self.talk == nil else { return }
            TalkLog.write("no Talk for \(Int(seconds)) s; exiting")
            self.quit()
        }
    }

    private func quit() {
        writer.flush()
        exit(0)
    }

    // MARK: - Settings

    /// The helper's own defaults domain: the window is the source of truth
    /// and sets every value on `start`.
    static let defaults = UserDefaults(suiteName: "app.codeg.talk-helper") ?? .standard

    static func prefs(_ wire: WirePrefs) -> TalkPrefs {
        let prefs = TalkPrefs(defaults: defaults)
        prefs.handsFree = wire.handsFree ?? true
        prefs.patience = wire.patience.flatMap(TalkPatience.init) ?? .normal
        prefs.interruptBySpeaking = wire.interruptBySpeaking ?? true
        prefs.speakProgress = wire.speakProgress ?? false
        prefs.smartTurnActive = wire.smartTurnActive ?? false
        prefs.echoMode = wire.echoMode.flatMap(TalkEchoSetting.init) ?? .automatic
        prefs.shareTelemetry = wire.shareTelemetry ?? true
        return prefs
    }

    private func espeakData(_ start: WireStart) -> URL? {
        if let explicit = start.models?.espeakData { return URL(fileURLWithPath: explicit) }
        if let option = options.espeakData { return option }
        return EspeakDataLookup.locate()
    }
}

/// Where espeak-ng's English data is when codeg doesn't say: inside codeg.app
/// (`Contents/Resources/tts/espeak-ng-data`, bundled for codeg-tts), beside
/// a `tauri dev` binary, or BlueTTSEspeak's resource bundle in a `swift build`
/// tree. The executable's own path is used, never `Bundle.main`.
enum EspeakDataLookup {
    static let resourceBundle = "BlueTTSKit_BlueTTSEspeak.bundle"

    static func candidates(executable: URL) -> [URL] {
        let dir = executable.deletingLastPathComponent()
        return [
            dir.deletingLastPathComponent().appendingPathComponent("Resources/tts/espeak-ng-data"),
            dir.appendingPathComponent("tts/espeak-ng-data"),
            dir.appendingPathComponent("espeak-ng-data"),
            dir.appendingPathComponent("\(resourceBundle)/Contents/Resources/espeak-ng-data"),
            dir.appendingPathComponent("\(resourceBundle)/espeak-ng-data"),
        ]
    }

    static func locate() -> URL? {
        candidates(executable: currentExecutable()).first {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("phontab").path)
        }
    }

    static func currentExecutable() -> URL {
        var size = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size))
        if _NSGetExecutablePath(&buffer, &size) == 0 {
            let path = buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
            return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        }
        return URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    }
}
