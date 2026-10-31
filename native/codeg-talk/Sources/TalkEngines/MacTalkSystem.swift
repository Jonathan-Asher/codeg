@testable import TalkHost
import AVFoundation
import BlueTTSEspeak
import BlueTTSKit
import Darwin
import Foundation
import SherpaOnnx
import SmartTurn

/// The engines, loaded once per process and kept across Talks (the process
/// itself exits a while after the last Talk, which is what gives the memory
/// back). Each is remade only when its model file changes.
@MainActor
final class EngineCache {
    static let shared = EngineCache()

    private var recognizer: (files: TransducerModelFiles, value: StreamingTransducerRecognizer)?
    private var smartTurn: (path: String, value: SmartTurnClassifier)?
    private var vad: (path: String, value: StreamingSileroVAD)?
    private var voice: (key: String, value: BlueTTS)?
    private var whisper: (path: String, value: WhisperCppEngine)?
    private var languageID: (path: String, value: WhisperLanguageIdentifier)?
    /// whisper's weights are loaded (``WhisperCppEngine/prepare()`` ran).
    var whisperLoaded = false

    /// Zipformer threads, as on the iPhone; the rest of the cores are left
    /// to whisper and the voice.
    nonisolated static let zipformerThreads = 2
    nonisolated static let smartTurnThreads = 2
    /// BlueTTS's ONNX Runtime threads while Talk runs (the iPhone's cap).
    nonisolated static let voiceThreads = 4

    func recognizer(_ files: TransducerModelFiles) async throws -> StreamingTransducerRecognizer {
        if let recognizer, recognizer.files == files { return recognizer.value }
        let made = try await Task.detached(priority: .userInitiated) {
            try StreamingTransducerRecognizer(files: files, threads: EngineCache.zipformerThreads)
        }.value
        recognizer = (files, made)
        return made
    }

    func smartTurn(_ path: String) async -> SmartTurnClassifier? {
        if let smartTurn, smartTurn.path == path { return smartTurn.value }
        let url = URL(fileURLWithPath: path)
        guard let made = try? await Task.detached(priority: .userInitiated, operation: {
            try SmartTurnClassifier(modelURL: url, threads: EngineCache.smartTurnThreads)
        }).value else { return nil }
        smartTurn = (path, made)
        return made
    }

    func vad(_ path: String) -> StreamingSileroVAD? {
        if let vad, vad.path == path { return vad.value }
        guard let made = StreamingSileroVAD(modelURL: URL(fileURLWithPath: path)) else { return nil }
        vad = (path, made)
        return made
    }

    func voice(models: URL, espeakData: URL) throws -> BlueTTS {
        let key = "\(models.path)|\(espeakData.path)"
        if let voice, voice.key == key { return voice.value }
        let phonemizer = try EspeakPhonemizer(dataDirectory: espeakData)
        var configuration = BlueTTSConfiguration()
        configuration.threads = min(configuration.threads, Self.voiceThreads)
        let made = BlueTTS(modelDirectory: models, englishPhonemizer: phonemizer, configuration: configuration)
        voice = (key, made)
        return made
    }

    func whisper(_ path: String) -> WhisperCppEngine {
        if let whisper, whisper.path == path { return whisper.value }
        if let old = whisper?.value { Task { await old.unload() } }
        whisperLoaded = false
        let made = WhisperCppEngine(modelID: URL(fileURLWithPath: path).lastPathComponent,
                                    modelURL: URL(fileURLWithPath: path))
        whisper = (path, made)
        return made
    }

    func languageID(_ path: String) -> WhisperLanguageIdentifier {
        if let languageID, languageID.path == path { return languageID.value }
        let made = WhisperLanguageIdentifier(modelURL: URL(fileURLWithPath: path))
        languageID = (path, made)
        return made
    }
}

/// Talk's device side on the Mac (the iPhone's `LiveTalkSystem`): the
/// engines, whisper, memory, and keeping the Mac awake while Talk runs.
/// There are no calls, Lock Screen or background states here: Talk goes on
/// in the background, and the global shortcut is codeg's.
@MainActor
final class MacTalkSystem: TalkSystem {
    var onEvent: ((TalkSystemEvent) -> Void)?

    private let models: WireModels?
    private let voice: WireVoice?
    private let folder: String?
    private let title: String?
    private let app: [String: String]
    /// espeak-ng's data when `models.espeakData` doesn't say.
    private let espeakFallback: URL?
    private let cache: EngineCache
    private var activity: NSObjectProtocol?
    private var memoryPressure: DispatchSourceMemoryPressure?
    /// Told when the microphone permission changed (the dock shows it).
    var onMicrophoneChange: (() -> Void)?
    private(set) var microphone = MacTalkSystem.microphoneStatus()

    init(models: WireModels?, voice: WireVoice?, folder: String?, title: String?, app: [String: String]?,
         espeakFallback: URL?, cache: EngineCache? = nil) {
        self.models = models
        self.voice = voice
        self.folder = folder
        self.title = title
        self.app = app ?? [:]
        self.espeakFallback = espeakFallback
        self.cache = cache ?? .shared
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.onEvent?(.memoryWarning) }
        }
        source.resume()
        memoryPressure = source
    }

    deinit {
        memoryPressure?.cancel()
    }

    // MARK: - Engines

    func loadEngines() async throws -> TalkEngineSet {
        guard let models, let zipformer = models.zipformer, let vadPath = models.vad,
              let smartTurnPath = models.smartTurn,
              [zipformer.encoder, zipformer.decoder, zipformer.joiner, zipformer.tokens, vadPath, smartTurnPath]
                .allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else {
            throw TalkStartError.macModelsMissing
        }
        // After the models: without them there is nothing to listen with.
        try await ensureMicrophone()
        let files = TransducerModelFiles(encoder: URL(fileURLWithPath: zipformer.encoder),
                                         decoder: URL(fileURLWithPath: zipformer.decoder),
                                         joiner: URL(fileURLWithPath: zipformer.joiner),
                                         tokens: URL(fileURLWithPath: zipformer.tokens))
        let recognizer: StreamingTransducerRecognizer
        do {
            recognizer = try await cache.recognizer(files)
        } catch {
            TalkLog.write("the Zipformer didn't load: \(error)")
            throw TalkStartError("Talk's live transcription didn't load. Delete its model in Settings › Talk and download it again.")
        }
        guard let vad = cache.vad(vadPath) else {
            throw TalkStartError("Talk's voice detection didn't load. Delete its model in Settings › Talk and download it again.")
        }
        let smartTurn = await cache.smartTurn(smartTurnPath)
        if smartTurn == nil { TalkLog.write("Smart Turn didn't load; Talk goes on without it") }
        let (synthesizer, natural) = await makeSynthesizer()
        return TalkEngineSet(vad: SileroSpeechActivity(vad), live: ZipformerTranscriber(recognizer: recognizer),
                             turn: smartTurn.map(SmartTurnTurnEnd.init), synthesizer: synthesizer,
                             naturalVoice: natural)
    }

    /// BlueTTS when its models are on this Mac, the system voices otherwise.
    private func makeSynthesizer() async -> (Synthesizer, Bool) {
        let speed = voice?.speed ?? 1
        if let dir = models?.bluetts, FileManager.default.fileExists(atPath: dir),
           let espeak = (models?.espeakData.map { URL(fileURLWithPath: $0) }) ?? espeakFallback {
            do {
                let tts = try cache.voice(models: URL(fileURLWithPath: dir), espeakData: espeak)
                let name = voice?.name.flatMap { tts.availableVoices().contains($0) ? $0 : nil }
                do {
                    try await tts.load()
                } catch {
                    TalkLog.write("BlueTTS didn't preload: \(error)")
                }
                return (MacBlueSynthesizer(tts: tts, voice: name, speed: speed), true)
            } catch {
                TalkLog.write("BlueTTS didn't load (\(error)); the system voices speak")
            }
        }
        return (MacSystemVoiceSynthesizer(speed: speed), false)
    }

    /// Kept for the next Talk.
    func releaseEngines() {}

    var finalTranscriber: FinalTranscriber? {
        guard let path = models?.whisper, FileManager.default.fileExists(atPath: path) else { return nil }
        let engine = cache.whisper(path)
        let languageID = models?.languageID.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
            .map { cache.languageID($0) }
        let folder = folder
        let title = title
        return WhisperFinalTranscriber(engine: engine, languageID: languageID, plan: .hebrewOrEnglish,
                                       prompt: { spoken in DictationText.prompt(folder: folder, session: title,
                                                                                 language: spoken) })
    }

    var isWhisperLoaded: Bool { cache.whisperLoaded }

    func loadWhisper() async -> Bool {
        guard let path = models?.whisper, FileManager.default.fileExists(atPath: path) else { return false }
        do {
            try await cache.whisper(path).prepare()
            if let id = models?.languageID, FileManager.default.fileExists(atPath: id) {
                try? await cache.languageID(id).prepare()
            }
            cache.whisperLoaded = true
            return true
        } catch {
            TalkLog.write("whisper didn't load: \(error)")
            return false
        }
    }

    func unloadWhisper() {
        guard let path = models?.whisper else { return }
        let engine = cache.whisper(path)
        cache.whisperLoaded = false
        Task { await engine.unload() }
    }

    // MARK: - The device

    /// What the Mac can give without paging: free, inactive, purgeable and
    /// speculative memory.
    var availableMemory: UInt64 { Self.availableMemory() }

    var thermalState: String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    /// Talk goes on while codeg is in the background, whisper included.
    var isInBackground: Bool { false }
    var callActive: Bool { false }

    /// Keep the Mac awake (not the display) while Talk runs.
    func setIdleTimerDisabled(_ disabled: Bool) {
        if disabled, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleSystemSleepDisabled], reason: "Talk is listening")
        } else if !disabled, let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
    }

    func setNowPlaying(title: String?) {}
    func setRemoteTarget(_ target: TalkRemoteTarget?) {}

    /// The Mac doesn't suspend the helper; the work is only counted, so the
    /// helper doesn't exit while a Talk's end is still sending.
    func beginBackgroundWork(_ name: String) -> TalkBackgroundWork {
        MacBackgroundWork(name)
    }

    var reportEnvironment: TalkReportEnvironment {
        var app = self.app
        app["helper"] = TalkWire.helperVersion
        return TalkReportEnvironment(app: app, device: ["model": Self.hardwareModel(), "os": Self.osName()])
    }

    // MARK: - The microphone

    /// `granted`, `denied` or `undetermined`, never asking.
    nonisolated static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "undetermined"
        @unknown default: return "undetermined"
        }
    }

    /// Ask for the microphone when macOS hasn't asked yet; fail when it's
    /// off.
    private func ensureMicrophone() async throws {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        let status = Self.microphoneStatus()
        if status != microphone {
            microphone = status
            onMicrophoneChange?()
        }
        guard status == "granted" else { throw TalkStartError.microphoneOff }
    }

    // MARK: - Facts about the Mac

    nonisolated static func availableMemory() -> UInt64 {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard status == KERN_SUCCESS else { return ProcessInfo.processInfo.physicalMemory / 4 }
        let pages = UInt64(stats.free_count) + UInt64(stats.inactive_count) + UInt64(stats.purgeable_count)
            + UInt64(stats.speculative_count)
        return pages * UInt64(vm_kernel_page_size)
    }

    nonisolated static func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return "Mac" }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 else { return "Mac" }
        return String(cString: buffer)
    }

    nonisolated static func osName() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    nonisolated static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}

extension TalkStartError {
    /// Talk's models aren't downloaded (codeg's Settings › Talk does it).
    static let macModelsMissing = TalkStartError(
        "Talk's models aren't on this Mac yet. Download them in Settings › Talk.")
    static let microphoneOff = TalkStartError(
        "Microphone access is off for codeg. Turn it on in System Settings › Privacy & Security › Microphone.")
}

/// Work a Talk's end still does (Talk mode off, the reports).
@MainActor
final class MacBackgroundWork: TalkBackgroundWork {
    /// Work begun and not ended.
    private(set) static var active = 0
    private let name: String
    private var ended = false

    init(_ name: String) {
        self.name = name
        Self.active += 1
    }

    func end() {
        guard !ended else { return }
        ended = true
        Self.active -= 1
    }
}
