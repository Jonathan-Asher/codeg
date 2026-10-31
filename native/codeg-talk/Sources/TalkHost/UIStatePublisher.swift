@testable import TalkCore
import Foundation
import Observation

/// What the dock reads, from the controller: `state` when it changes, at
/// most 20 times a second (a burst ends with its latest state), and `level`
/// 15 times a second while the levels move.
@MainActor
final class UIStatePublisher {
    /// What the helper adds to the controller's state.
    struct Extras: Equatable {
        var mic = "undetermined"
        var suggestHeadphones = false
    }

    private let controller: TalkController
    private let sink: WireSink
    private let scheduler: TalkScheduler
    private let clock: TalkClock
    private let stateInterval: TimeInterval
    private let levelInterval: TimeInterval
    /// The speech's level as the audio engine measures it, when it does.
    private let outputLevel: () -> Float?
    private let extras: () -> Extras

    private var running = false
    private var lastState: WireState?
    private var lastStateAt: TimeInterval = -.infinity
    private var pendingState: TalkScheduled?
    private var levelTimer: TalkScheduled?
    private var lastLevel: (input: Float, output: Float) = (-1, -1)

    init(controller: TalkController, sink: WireSink, scheduler: TalkScheduler, clock: TalkClock,
         stateInterval: TimeInterval = TalkWire.stateInterval, levelInterval: TimeInterval = TalkWire.levelInterval,
         outputLevel: @escaping () -> Float? = { nil }, extras: @escaping () -> Extras = { Extras() }) {
        self.controller = controller
        self.sink = sink
        self.scheduler = scheduler
        self.clock = clock
        self.stateInterval = stateInterval
        self.levelInterval = levelInterval
        self.outputLevel = outputLevel
        self.extras = extras
    }

    func start() {
        guard !running else { return }
        running = true
        observe()
        publishState()
        scheduleLevel()
    }

    /// Send the last state now (the Talk ended) and stop.
    func stop() {
        guard running else { return }
        pendingState?.cancel()
        pendingState = nil
        levelTimer?.cancel()
        levelTimer = nil
        publishState()
        if lastLevel != (0, 0) { sink.send(.level(input: 0, output: 0)) }
        running = false
    }

    /// Something the helper adds changed (the microphone permission, the
    /// headphones hint).
    func extrasChanged() {
        stateChanged()
    }

    // MARK: - State

    private func observe() {
        guard running else { return }
        withObservationTracking {
            _ = Self.state(of: controller, extras: Extras())
        } onChange: { [weak self] in
            // Called before the change lands: look once it has.
            Task { @MainActor [weak self] in
                guard let self, self.running else { return }
                self.stateChanged()
                self.observe()
            }
        }
    }

    private func stateChanged() {
        guard running, pendingState == nil else { return }
        let wait = lastStateAt + stateInterval - clock.now()
        if wait <= 0 {
            publishState()
        } else {
            pendingState = scheduler.schedule(after: wait) { [weak self] in
                self?.pendingState = nil
                self?.publishState()
            }
        }
    }

    private func publishState() {
        let state = Self.state(of: controller, extras: extras())
        guard state != lastState else { return }
        lastState = state
        lastStateAt = clock.now()
        sink.send(.state(state))
    }

    // MARK: - Levels

    private func scheduleLevel() {
        levelTimer = scheduler.schedule(after: levelInterval) { [weak self] in
            guard let self, self.running else { return }
            self.publishLevel()
            self.scheduleLevel()
        }
    }

    private func publishLevel() {
        let input = (controller.inputLevel * 1000).rounded() / 1000
        let output = ((outputLevel() ?? controller.outputLevel) * 1000).rounded() / 1000
        guard input != lastLevel.input || output != lastLevel.output else { return }
        lastLevel = (input, output)
        sink.send(.level(input: input, output: output))
    }

    // MARK: - The controller's state as the wire carries it

    static func state(of c: TalkController, extras: Extras) -> WireState {
        var pauseReason: String?
        var error: String?
        let status: String
        switch c.status {
        case .starting: status = "starting"
        case .listening: status = "listening"
        case .hearing: status = "hearing"
        case .thinking: status = "thinking"
        case .working: status = "working"
        case .speaking: status = "speaking"
        case .asking: status = "asking"
        case .confirmingCancel: status = "confirmingCancel"
        case .paused(let reason):
            status = "paused"
            pauseReason = reason.rawValue
        case .ended: status = "ended"
        case .failed(let message):
            status = "failed"
            error = message
        }
        let ask = c.ask.map { ask in
            WireAsk(id: ask.id, kind: ask.kind.rawValue, prompt: ask.prompt,
                    choices: ask.choices.map { WireChoice(id: $0.id, label: $0.label) },
                    multiSelect: ask.multiSelect, acceptsOwnWords: ask.acceptsOwnWords, isSecret: ask.isSecret,
                    answerableByVoice: ask.answerableByVoice)
        }
        return WireState(
            status: status, pauseReason: pauseReason, error: error ?? (c.isActive ? nil : c.errorMessage),
            title: c.title, heard: c.heardText, heardFinal: c.heardIsFinal,
            spoken: c.spokenLog.map { WireSpokenLine(id: $0.id.description, text: $0.text) },
            current: c.currentSpokenID?.description, ask: ask, mute: c.mute.rawValue, handsFree: c.handsFree,
            backgroundOutstanding: c.backgroundOutstanding, awaitingBackground: c.awaitingBackground,
            fastMode: c.fastMode, naturalVoice: c.naturalVoice, canReportCutOff: c.canReportCutOff,
            route: TalkController.name(c.route), echo: TalkController.name(c.echoMode),
            speaksHebrew: c.speaksHebrew, mic: extras.mic, suggestHeadphones: extras.suggestHeadphones)
    }
}
