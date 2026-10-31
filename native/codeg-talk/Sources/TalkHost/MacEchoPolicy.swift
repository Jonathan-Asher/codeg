@testable import TalkCore
import Foundation

/// A Core Audio device's transport (`kAudioDevicePropertyTransportType`).
enum MacTransport: Equatable, Sendable {
    case builtIn, usb, bluetooth, bluetoothLE, aggregate, virtual, hdmi, displayPort, airPlay
    case thunderbolt, pci, fireWire, avb, continuity
    case unknown(UInt32)

    /// From the four-character code Core Audio reports.
    init(code: UInt32) {
        switch code {
        case fourCC("bltn"): self = .builtIn
        case fourCC("usb "): self = .usb
        case fourCC("blue"): self = .bluetooth
        case fourCC("blea"): self = .bluetoothLE
        case fourCC("grup"): self = .aggregate
        case fourCC("virt"): self = .virtual
        case fourCC("hdmi"): self = .hdmi
        case fourCC("dprt"): self = .displayPort
        case fourCC("airp"): self = .airPlay
        case fourCC("thun"): self = .thunderbolt
        case fourCC("pci "): self = .pci
        case fourCC("1394"): self = .fireWire
        case fourCC("eavb"): self = .avb
        case fourCC("ccwd"), fourCC("ccwl"): self = .continuity
        default: self = .unknown(code)
        }
    }

    var isBluetooth: Bool { self == .bluetooth || self == .bluetoothLE }
}

/// `'abcd'` as Core Audio's UInt32.
func fourCC(_ s: StaticString) -> UInt32 {
    s.withUTF8Buffer { bytes in bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } }
}

/// One default device as the route reads it.
struct MacDevice: Equatable, Sendable {
    /// Core Audio's device id: a change means another device.
    var id: UInt32
    var transport: MacTransport
    /// The built-in output's data source: `ispk` (speakers) or `hdpn`
    /// (headphones in the jack); nil when it has none.
    var dataSource: UInt32?
    var name: String?

    init(id: UInt32 = 0, transport: MacTransport, dataSource: UInt32? = nil, name: String? = nil) {
        self.id = id
        self.transport = transport
        self.dataSource = dataSource
        self.name = name
    }

    static let headphonesSource = fourCC("hdpn")
}

/// The default input and output devices: what Talk listens and speaks on.
struct MacRoute: Equatable, Sendable {
    var input: MacDevice?
    var output: MacDevice?

    /// AirPods or another Bluetooth headset's microphone.
    var inputIsBluetooth: Bool { input?.transport.isBluetooth ?? false }

    /// Speech goes to the ears only: Bluetooth (AirPods, headphones) or the
    /// headphone jack of the built-in output.
    var outputIsHeadphones: Bool {
        guard let output else { return false }
        if output.transport.isBluetooth { return true }
        return output.transport == .builtIn && output.dataSource == MacDevice.headphonesSource
    }

    /// Speech plays into the room (built-in speakers, a display, AirPlay, an
    /// interface Core Audio can't say more about).
    var outputIsSpeaker: Bool { output != nil && !outputIsHeadphones }

    /// The route's kind in Talk's terms (telemetry and the dock).
    var talkRoute: TalkRoute {
        if inputIsBluetooth { return .bluetoothHFP }
        if outputIsHeadphones { return .wired }
        if input?.transport == .builtIn, output?.transport == .builtIn { return .builtIn }
        return .other
    }

    /// A name for the logs: `builtIn/builtIn:ispk`.
    var description: String {
        func name(_ d: MacDevice?) -> String {
            guard let d else { return "none" }
            var s = "\(d.transport)"
            if let source = d.dataSource {
                let bytes = [24, 16, 8, 0].map { UInt8((source >> UInt32($0)) & 0xFF) }
                if bytes.allSatisfy({ (0x20...0x7E).contains($0) }) { s += ":" + String(decoding: bytes, as: UTF8.self) }
            }
            return s
        }
        return "\(name(input))/\(name(output))"
    }
}

/// How Talk keeps its own speech out of what the Mac's microphone hears.
/// Pure.
///
/// - A built-in or USB microphone with speakers: macOS voice processing on
///   the engine's input (echo cancellation, with the speech as reference).
/// - A Bluetooth microphone (AirPods), or headphone output: none; nothing
///   the speech plays reaches the microphone.
/// - The settings' override wins (`voiceProcessing` or `off`);
///   `echoCancelledInput`, an iPhone mode, reads as voice processing.
/// - With no echo cancellation on speakers (it was turned off, or failed to
///   start and Talk went on without it) Talk can't tell its own voice from
///   the person's: the microphone is not heard while Talk speaks
///   (``halfDuplex(route:echo:)``), so talking over the speech doesn't
///   interrupt it, and the dock suggests headphones.
enum MacEchoPolicy {
    static func choose(route: MacRoute, preferring preferred: TalkEchoMode?) -> TalkEchoMode {
        switch preferred {
        case .none?: return .none
        case .voiceProcessing?, .echoCancelledInput?: return .voiceProcessing
        case nil:
            if route.inputIsBluetooth || route.outputIsHeadphones { return .none }
            return .voiceProcessing
        }
    }

    /// The microphone is dropped while Talk speaks: speakers and no echo
    /// cancellation.
    static func halfDuplex(route: MacRoute, echo: TalkEchoMode) -> Bool {
        echo == .none && route.outputIsSpeaker
    }

    /// The echo preference the window's `echoMode` names (nil: automatic).
    static func preference(named name: String?) -> TalkEchoMode? {
        switch name {
        case "voiceProcessing", "echoCancelledInput": return .voiceProcessing
        case "off", "none": return TalkEchoMode.none
        default: return nil
        }
    }
}

/// The first channel of a microphone buffer. With voice processing on, the
/// Mac's input node can deliver several channels (the device's own, or the
/// voice processor's aggregate), and only the first carries the processed
/// voice. Pure.
enum ChannelZero {
    /// Channel 0 of `frames` frames. Deinterleaved data: `data` is channel
    /// 0 itself. Interleaved: every `channels`-th sample, from the first.
    static func extract(_ data: UnsafePointer<Float>, frames: Int, channels: Int, interleaved: Bool) -> [Float] {
        guard frames > 0 else { return [] }
        if !interleaved || channels <= 1 {
            return Array(UnsafeBufferPointer(start: data, count: frames))
        }
        var out = [Float](repeating: 0, count: frames)
        for i in 0..<frames { out[i] = data[i * channels] }
        return out
    }
}
