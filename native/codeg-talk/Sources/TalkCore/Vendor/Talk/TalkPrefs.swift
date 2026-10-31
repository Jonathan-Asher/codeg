import Foundation

/// How echo is kept out of what Talk hears (the Lab's override; Automatic
/// picks per route: echo-cancelled input on the built-in mic and speaker
/// where iOS offers it, voice processing otherwise, nothing on AirPods).
enum TalkEchoSetting: String, CaseIterable, Equatable, Sendable {
    case automatic
    case echoCancelledInput
    case voiceProcessing
    case off

    /// What ``TalkAudioIO/start(preferring:)`` takes: nil lets
    /// ``TalkEchoPolicy`` choose per route.
    var preferredMode: TalkEchoMode? {
        switch self {
        case .automatic: return nil
        case .echoCancelledInput: return .echoCancelledInput
        case .voiceProcessing: return .voiceProcessing
        case .off: return TalkEchoMode.none
        }
    }
}

/// Settings › Voice › Talk, kept in UserDefaults under `codeg.talk.*`.
/// (Language and address are the server's Talk settings.)
struct TalkPrefs {
    static let handsFreeKey = "codeg.talk.handsFree"
    static let patienceKey = "codeg.talk.patience"
    static let interruptBySpeakingKey = "codeg.talk.interruptBySpeaking"
    static let speakProgressKey = "codeg.talk.speakProgress"
    static let smartTurnActiveKey = "codeg.talk.smartTurnActive"
    static let echoModeKey = "codeg.talk.lab.echoMode"
    static let shareTelemetryKey = "codeg.talk.shareTelemetry"

    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Hands-free (on by default); off is push to talk.
    var handsFree: Bool {
        get { defaults.object(forKey: Self.handsFreeKey) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Self.handsFreeKey) }
    }

    var patience: TalkPatience {
        get { defaults.string(forKey: Self.patienceKey).flatMap(TalkPatience.init) ?? .normal }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Self.patienceKey) }
    }

    /// Talking over the speech interrupts it (on by default); off, only a tap
    /// or the Camera Control does.
    var interruptBySpeaking: Bool {
        get { defaults.object(forKey: Self.interruptBySpeakingKey) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Self.interruptBySpeakingKey) }
    }

    /// Say a short status phrase while the agent works (at most one per 20 s).
    var speakProgress: Bool {
        get { defaults.bool(forKey: Self.speakProgressKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.speakProgressKey) }
    }

    /// Let Smart Turn commit an utterance (off: it is only logged).
    var smartTurnActive: Bool {
        get { defaults.bool(forKey: Self.smartTurnActiveKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.smartTurnActiveKey) }
    }

    /// Send each Talk's telemetry (timings, end-of-turn traces, what was
    /// heard and said as text, never audio) to the session's codeg server
    /// as a `talk_lab` report (on by default).
    var shareTelemetry: Bool {
        get { defaults.object(forKey: Self.shareTelemetryKey) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Self.shareTelemetryKey) }
    }

    /// The Lab's echo override.
    var echoMode: TalkEchoSetting {
        get { defaults.string(forKey: Self.echoModeKey).flatMap(TalkEchoSetting.init) ?? .automatic }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Self.echoModeKey) }
    }

    /// The end-of-turn settings these prefs give.
    var endOfTurnConfig: EndOfTurnConfig {
        var config = EndOfTurnConfig.standard
        config.patience = patience
        config.smartTurn = smartTurnActive ? .active : .shadow
        return config
    }

    /// The barge-in settings these prefs give.
    var bargeInConfig: BargeInConfig {
        var config = BargeInConfig.standard
        config.enabled = interruptBySpeaking
        return config
    }
}
