@testable import TalkHost
import AVFoundation
import Accelerate

/// Talk's audio on the Mac: one `AVAudioEngine` for the microphone and the
/// agent's speech, so macOS voice processing has the speech as its echo
/// reference (the iPhone's `TalkAudioEngine`, ported).
///
/// - A fresh engine for every start and every rebuild.
/// - Two player nodes, one for speech and one for the earcons, attached and
///   connected before `inputNode.setVoiceProcessingEnabled(true)`; other
///   apps' audio is ducked as little as voice processing allows; voice
///   processing is turned off before the engine stops.
/// - The echo mode per route comes from ``MacEchoPolicy`` over Core Audio's
///   default devices (``CoreAudioRoute``). A default-device change, the
///   headphone jack or `AVAudioEngineConfigurationChange` rebuilds the
///   engine 150 ms later (the controller says the sentence again).
/// - The microphone goes through ``MacMicTap`` (channel 0, 16 kHz frames).
///   Mute drops frames at the tap and sets `isVoiceProcessingInputMuted`.
/// - Every AVFAudio call that can raise runs through ``AVFAudioGuard``.
/// - No sessions, interruptions or calls: those are the iPhone's.
@MainActor
final class MacTalkAudioEngine: TalkAudioIO {
    /// Speech plays at BlueTTS's own rate; other rates are resampled to it.
    nonisolated static let playerSampleRate: Double = 44_100
    /// The speech's volume while ducked.
    nonisolated static let duckedVolume: Float = 0.12
    /// A route or configuration change is looked at once things settle.
    nonisolated static let routeSettle: Duration = .milliseconds(150)
    /// More rebuilds than this within ``rebuildWindow`` is a loop: give up.
    nonisolated static let rebuildLimit = 6
    nonisolated static let rebuildWindow: TimeInterval = 20

    let frames: AsyncStream<MicFrame>
    let events: AsyncStream<TalkAudioEvent>
    private(set) var route: TalkRoute = .builtIn
    private(set) var echoMode: TalkEchoMode = .voiceProcessing
    private(set) var isSpeaking = false {
        didSet { if isSpeaking != oldValue { tap?.setGated(halfDuplex && isSpeaking) } }
    }
    /// The route Talk runs on now.
    private(set) var macRoute = MacRoute()
    /// Speakers and no echo cancellation: the microphone isn't heard while
    /// Talk speaks, and the dock suggests headphones.
    private(set) var halfDuplex = false
    /// Called when the route, the echo mode or ``halfDuplex`` changed.
    var onRouteChange: (() -> Void)?
    /// The speech's level as it plays, 0…1.
    var outputLevel: Float { meter.value }

    private let frameSink: AsyncStream<MicFrame>.Continuation
    private let eventSink: AsyncStream<TalkAudioEvent>.Continuation
    private let playerFormat: AVAudioFormat
    private let coreAudio = CoreAudioRoute()
    private let meter = LevelMeter()

    // The engine and its nodes, while built.
    private var engine: AVAudioEngine?
    private var input: AVAudioInputNode?
    private var speechPlayer: AVAudioPlayerNode?
    private var earconPlayer: AVAudioPlayerNode?
    private var tap: MacMicTap?
    private var tapInstalled = false
    private var meterInstalled = false
    private var voiceProcessingOn = false

    /// Started and not stopped: route changes rebuild the engine.
    private var wantsRunning = false
    /// The echo mode asked for at start (the settings' override).
    private var preference: TalkEchoMode?
    private var ducked = false
    /// The Mute button is on: the tap drops every frame.
    private var inputMuted = false
    /// Bumped when queued speech is dropped, so its completions are ignored.
    private var speechGeneration = 0
    private var pendingSpeech = 0
    private var routeCheck: Task<Void, Never>?
    private var rebuilds: [TimeInterval] = []
    private var configObserver: NSObjectProtocol?
    private var earconBuffers: [Earcon: AVAudioPCMBuffer] = [:]
    private var resamplers: [Double: AVAudioConverter] = [:]

    init() {
        let frameStream = AsyncStream.makeStream(of: MicFrame.self, bufferingPolicy: .bufferingNewest(256))
        frames = frameStream.stream
        frameSink = frameStream.continuation
        let eventStream = AsyncStream.makeStream(of: TalkAudioEvent.self)
        events = eventStream.stream
        eventSink = eventStream.continuation
        // The standard 44.1 kHz mono format always exists.
        playerFormat = AVAudioFormat(standardFormatWithSampleRate: Self.playerSampleRate, channels: 1)!
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            let changed = note.object as AnyObject?
            MainActor.assumeIsolated {
                // Only this engine's change matters.
                guard let self, let engine = self.engine, changed === engine else { return }
                self.scheduleRouteCheck()
            }
        }
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        frameSink.finish()
        eventSink.finish()
    }

    // MARK: - Start and stop

    func start(preferring preferred: TalkEchoMode?) throws {
        routeCheck?.cancel()
        routeCheck = nil
        stopSpeech()
        teardownEngine()
        preference = preferred
        do {
            try startForRoute()
        } catch {
            TalkLog.write("audio didn't start: \(Self.describe(error))")
            teardownEngine()
            throw error
        }
        wantsRunning = true
        coreAudio.start { [weak self] in self?.scheduleRouteCheck() }
    }

    func stop() {
        if inputMuted { setInputMuted(false) }
        let wasRunning = engine != nil
        wantsRunning = false
        routeCheck?.cancel()
        routeCheck = nil
        coreAudio.stop()
        stopSpeech()
        teardownEngine()
        if wasRunning { TalkLog.write("audio stopped") }
    }

    /// Read the route, pick the echo mode for it and build the engine.
    private func startForRoute() throws {
        let route = CoreAudioRoute.current()
        guard route.input != nil else { throw MacAudioError.noInput }
        guard route.output != nil else { throw MacAudioError.noOutput }
        let echo = MacEchoPolicy.choose(route: route, preferring: preference)
        do {
            try buildEngine(echo: echo)
        } catch {
            // Once more from scratch, as a cold start sometimes needs.
            TalkLog.write("engine didn't start (\(Self.describe(error))); trying again")
            teardownEngine()
            try buildEngine(echo: echo)
        }
        macRoute = route
        self.route = route.talkRoute
        echoMode = echo
        halfDuplex = MacEchoPolicy.halfDuplex(route: route, echo: echo)
        tap?.setGated(halfDuplex && isSpeaking)
        TalkLog.write("audio runs on \(route.description) (\(route.input?.name ?? "?") → \(route.output?.name ?? "?")) with \(TalkEchoPolicy.name(of: echo))\(halfDuplex ? ", half duplex" : "")")
        onRouteChange?()
    }

    /// A fresh engine: the players, voice processing when asked, the format
    /// check, the tap, then start. Registered at once, so a failure anywhere
    /// is undone by ``teardownEngine()``.
    private func buildEngine(echo: TalkEchoMode) throws {
        teardownEngine()
        let engine = AVAudioEngine()
        let speech = AVAudioPlayerNode()
        let earcons = AVAudioPlayerNode()
        self.engine = engine
        do {
            // The players go in first: with voice processing they must be
            // connected before it is turned on.
            try AVFAudioGuard.run("set up Talk's players") {
                engine.attach(speech)
                engine.attach(earcons)
                engine.connect(speech, to: engine.mainMixerNode, format: playerFormat)
                engine.connect(earcons, to: engine.mainMixerNode, format: playerFormat)
            }
            speechPlayer = speech
            earconPlayer = earcons
            let input = try AVFAudioGuard.run("get Talk's microphone input") { engine.inputNode }
            self.input = input
            if echo == .voiceProcessing {
                try AVFAudioGuard.run("turn on voice processing") { try input.setVoiceProcessingEnabled(true) }
                voiceProcessingOn = true
                // Other apps' audio is ducked as little as voice processing allows.
                input.voiceProcessingOtherAudioDuckingConfiguration =
                    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                if inputMuted { input.isVoiceProcessingInputMuted = true }
            }
            let hardware = AudioFormatShape(input.inputFormat(forBus: 0))
            let tapFormat = input.outputFormat(forBus: 0)
            switch MicrophoneFormatCheck.evaluate(hardware: hardware, output: AudioFormatShape(tapFormat),
                                                  inputAvailable: true) {
            case .ready:
                break
            case .unavailable(.formatChanging):
                // The voice processor can run at its own rate on the Mac; the
                // tap takes the node's output format as it is.
                TalkLog.write("microphone formats differ: hw=\(Int(hardware.sampleRate))/\(hardware.channelCount) tap=\(Int(tapFormat.sampleRate))/\(tapFormat.channelCount)")
            case .unavailable(let problem):
                TalkLog.write("microphone format isn't usable (\(problem)): hw=\(Int(hardware.sampleRate))/\(hardware.channelCount) tap=\(Int(tapFormat.sampleRate))/\(tapFormat.channelCount)")
                throw MacAudioError.noInput
            }
            guard let tap = MacMicTap(inputFormat: tapFormat, sink: frameSink) else { throw MacAudioError.noInput }
            tap.setMuted(inputMuted)
            let block = Self.tapBlock(tap)
            try AVFAudioGuard.run("install Talk's microphone tap") {
                input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat, block: block)
            }
            self.tap = tap
            tapInstalled = true
            let meter = Self.meterBlock(self.meter)
            try AVFAudioGuard.run("install Talk's speech meter") {
                speech.installTap(onBus: 0, bufferSize: 1024, format: nil, block: meter)
            }
            meterInstalled = true
            try AVFAudioGuard.run("start Talk's audio") {
                engine.prepare()
                try engine.start()
            }
            // A configuration change can stop it again before this returns.
            guard engine.isRunning else { throw MacAudioError.didNotStart }
            try AVFAudioGuard.run("start Talk's players") {
                speech.play()
                earcons.play()
            }
            speech.volume = ducked ? Self.duckedVolume : 1
        } catch {
            teardownEngine()
            throw error
        }
    }

    /// The tap's block, made outside the main actor: it runs on the audio
    /// thread.
    nonisolated private static func tapBlock(_ tap: MacMicTap) -> AVAudioNodeTapBlock {
        { buffer, when in tap.consume(buffer, at: when) }
    }

    nonisolated private static func meterBlock(_ meter: LevelMeter) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            var rms: Float = 0
            vDSP_rmsqv(data, 1, &rms, vDSP_Length(buffer.frameLength))
            meter.set(rms > 1e-5 ? MicrophoneConverter.meterLevel(rms: rms) : 0)
        }
    }

    /// Undo whatever of the engine is built. Voice processing goes off before
    /// the engine stops (and again after, if the running engine refused), so
    /// it never outlives Talk.
    private func teardownEngine() {
        guard let engine else { return }
        let input = self.input
        let speech = speechPlayer
        let earcons = earconPlayer
        let hadTap = tapInstalled
        let hadMeter = meterInstalled
        let processing = voiceProcessingOn
        self.engine = nil
        self.input = nil
        speechPlayer = nil
        earconPlayer = nil
        tap?.close()
        tap = nil
        tapInstalled = false
        meterInstalled = false
        voiceProcessingOn = false
        meter.set(0)
        if hadTap, let input {
            try? AVFAudioGuard.run("remove Talk's microphone tap") { input.removeTap(onBus: 0) }
        }
        if hadMeter, let speech {
            try? AVFAudioGuard.run("remove Talk's speech meter") { speech.removeTap(onBus: 0) }
        }
        if processing, let input {
            try? AVFAudioGuard.run("turn off voice processing") { try input.setVoiceProcessingEnabled(false) }
        }
        try? AVFAudioGuard.run("stop Talk's players") {
            speech?.stop()
            earcons?.stop()
        }
        try? AVFAudioGuard.run("stop Talk's audio") { engine.stop() }
        if processing, let input, input.isVoiceProcessingEnabled {
            try? AVFAudioGuard.run("turn off voice processing") { try input.setVoiceProcessingEnabled(false) }
        }
    }

    // MARK: - Speech and earcons

    func schedule(_ samples: [Float], sampleRate: Double, onPlayed: @escaping @Sendable () -> Void) {
        guard !samples.isEmpty else { return }
        guard let engine, engine.isRunning, let player = speechPlayer else {
            TalkLog.write("speech dropped: Talk's audio isn't running")
            return
        }
        guard let buffer = speechBuffer(samples, sampleRate: sampleRate) else {
            TalkLog.write("speech dropped: it didn't convert from \(Int(sampleRate)) Hz")
            return
        }
        let generation = speechGeneration
        pendingSpeech += 1
        isSpeaking = true
        do {
            try AVFAudioGuard.run("queue Talk's speech") {
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    Task { @MainActor in self?.speechPlayed(generation: generation, onPlayed: onPlayed) }
                }
            }
            if !player.isPlaying {
                try AVFAudioGuard.run("play Talk's speech") { player.play() }
            }
        } catch {
            pendingSpeech = max(0, pendingSpeech - 1)
            isSpeaking = pendingSpeech > 0
            eventSink.yield(.engineFailed("Couldn't play the reply: \(Self.describe(error))"))
        }
    }

    private func speechPlayed(generation: Int, onPlayed: @Sendable () -> Void) {
        // Cut off by stopSpeech, stop or a rebuild: not heard to the end.
        guard generation == speechGeneration else { return }
        pendingSpeech = max(0, pendingSpeech - 1)
        isSpeaking = pendingSpeech > 0
        onPlayed()
    }

    func duck(_ on: Bool) {
        ducked = on
        speechPlayer?.volume = on ? Self.duckedVolume : 1
    }

    func stopSpeech() {
        speechGeneration &+= 1
        pendingSpeech = 0
        isSpeaking = false
        guard let player = speechPlayer else { return }
        // A stopped player needs `play()` again: `schedule` does it.
        try? AVFAudioGuard.run("stop Talk's speech") { player.stop() }
    }

    func setInputMuted(_ muted: Bool) {
        inputMuted = muted
        tap?.setMuted(muted)
        if voiceProcessingOn, let input {
            input.isVoiceProcessingInputMuted = muted
        }
        TalkLog.write("input muted: \(muted ? "on" : "off")")
    }

    func play(_ earcon: Earcon) {
        guard let engine, engine.isRunning, let player = earconPlayer else { return }
        let buffer: AVAudioPCMBuffer
        if let cached = earconBuffers[earcon] {
            buffer = cached
        } else {
            guard let made = Self.pcmBuffer(EarconTone.samples(earcon, sampleRate: Self.playerSampleRate),
                                            format: playerFormat) else { return }
            earconBuffers[earcon] = made
            buffer = made
        }
        try? AVFAudioGuard.run("play a Talk earcon") {
            player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
            if !player.isPlaying { player.play() }
        }
    }

    /// `samples` at `sampleRate` as a buffer in the players' format.
    private func speechBuffer(_ samples: [Float], sampleRate: Double) -> AVAudioPCMBuffer? {
        guard sampleRate > 0 else { return nil }
        if abs(sampleRate - Self.playerSampleRate) < 1 { return Self.pcmBuffer(samples, format: playerFormat) }
        guard let sourceFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let source = Self.pcmBuffer(samples, format: sourceFormat) else { return nil }
        let converter: AVAudioConverter
        if let cached = resamplers[sampleRate] {
            converter = cached
        } else {
            guard let made = AVAudioConverter(from: sourceFormat, to: playerFormat) else { return nil }
            resamplers[sampleRate] = made
            converter = made
        }
        // Each piece of speech is a whole of its own.
        converter.reset()
        let capacity = AVAudioFrameCount(Double(samples.count) * Self.playerSampleRate / sampleRate) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .endOfStream
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return source
        }
        guard status != .error, error == nil, out.frameLength > 0 else { return nil }
        return out
    }

    nonisolated static func pcmBuffer(_ samples: [Float], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }

    // MARK: - Route changes

    /// A device or configuration change: look once things settle.
    private func scheduleRouteCheck() {
        guard wantsRunning else { return }
        routeCheck?.cancel()
        routeCheck = Task { [weak self] in
            try? await Task.sleep(for: Self.routeSettle)
            guard !Task.isCancelled else { return }
            self?.checkRoute()
        }
    }

    /// Rebuild when the default devices (or the jack) changed, or the engine
    /// stopped. Voice processing's own configuration change moves neither,
    /// so it rebuilds nothing.
    private func checkRoute() {
        guard wantsRunning else { return }
        let now = CoreAudioRoute.current()
        let running = engine?.isRunning == true
        let same = now.input?.id == macRoute.input?.id && now.output?.id == macRoute.output?.id
            && now.output?.dataSource == macRoute.output?.dataSource
        guard !same || !running else { return }
        rebuild(reason: same ? "engine_stopped" : "route \(macRoute.description) → \(now.description)")
    }

    private func rebuild(reason: String) {
        let time = ProcessInfo.processInfo.systemUptime
        rebuilds = rebuilds.filter { time - $0 < Self.rebuildWindow } + [time]
        TalkLog.write("rebuilding Talk's audio (\(reason))")
        stopSpeech()
        teardownEngine()
        guard rebuilds.count <= Self.rebuildLimit else {
            fail("Talk's audio kept restarting; the audio devices may be changing.")
            return
        }
        do {
            try startForRoute()
            eventSink.yield(.routeChanged(route))
        } catch {
            fail("Talk's audio stopped: \(Self.describe(error))")
        }
    }

    private func fail(_ message: String) {
        wantsRunning = false
        coreAudio.stop()
        TalkLog.write(message)
        eventSink.yield(.engineFailed(message))
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let plain = error as? LocalizedError, let text = plain.errorDescription { return text }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code) \(ns.localizedDescription)"
    }
}

/// Why Talk's audio couldn't start on the Mac, in plain words.
enum MacAudioError: PlainAudioError, Equatable {
    case noInput
    case noOutput
    case didNotStart

    var errorDescription: String? {
        switch self {
        case .noInput: "No microphone is available."
        case .noOutput: "No speakers or headphones are available."
        case .didNotStart: "The audio didn't start; the audio devices may be changing."
        }
    }
}
