import Foundation

/// How Talk keeps the agent's own speech out of what the microphone hears,
/// per audio route. Pure.
///
/// - Built-in microphone and speaker, on an iPhone that has it (iOS 18.2,
///   2024 and later models): echo-cancelled input
///   (`setPrefersEchoCancelledInput`, the session in mode `.default`), tuned
///   for a wide range of sound rather than voice calls only. Checked again
///   after every route change.
/// - Otherwise (an older iPhone, a wired headset, other outputs): voice
///   processing on the engine's input (the session in mode `.voiceChat`).
/// - AirPods and other Bluetooth headsets (HFP): none; the headset keeps its
///   own speech out of its microphone.
/// - The Lab can force any of them to compare them (`override`, which Talk
///   passes to ``TalkAudioIO/start(preferring:)`` from its settings).
///
/// The audio session's modes and routes are the iPhone's own, in
/// TalkEchoPolicy+Session.swift.
enum TalkEchoPolicy {
    /// The echo mode for a route.
    static func choose(route: TalkRoute, echoCancelledInputAvailable: Bool,
                       override: TalkEchoMode? = nil) -> TalkEchoMode {
        if let override { return override }
        switch route {
        case .bluetoothHFP:
            return .none
        case .builtIn:
            return echoCancelledInputAvailable ? .echoCancelledInput : .voiceProcessing
        case .wired, .other:
            return .voiceProcessing
        }
    }

    // MARK: - Names

    /// A stable name for logs and breadcrumbs.
    static func name(of echo: TalkEchoMode) -> String {
        switch echo {
        case .echoCancelledInput: return "echoCancelledInput"
        case .voiceProcessing: return "voiceProcessing"
        case .none: return "none"
        }
    }

    static func echoMode(named name: String) -> TalkEchoMode? {
        switch name {
        case "echoCancelledInput": return .echoCancelledInput
        case "voiceProcessing": return .voiceProcessing
        case "none": return TalkEchoMode.none
        default: return nil
        }
    }

    /// A stable name for a route.
    static func name(of route: TalkRoute) -> String {
        switch route {
        case .builtIn: return "builtIn"
        case .bluetoothHFP: return "bluetoothHFP"
        case .wired: return "wired"
        case .other: return "other"
        }
    }
}
