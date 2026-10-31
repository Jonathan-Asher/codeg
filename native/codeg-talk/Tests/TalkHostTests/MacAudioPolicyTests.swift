@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

/// The echo policy per route, Core Audio's transports, and channel 0.
struct MacAudioPolicyTests {
    static let speakers = fourCC("ispk")
    static let jack = fourCC("hdpn")

    static func route(_ input: MacTransport?, _ output: MacTransport?, source: UInt32? = nil) -> MacRoute {
        MacRoute(input: input.map { MacDevice(id: 1, transport: $0) },
                 output: output.map { MacDevice(id: 2, transport: $0, dataSource: source) })
    }

    struct Case: CustomTestStringConvertible, Sendable {
        var name: String
        var route: MacRoute
        var preferring: TalkEchoMode?
        var echo: TalkEchoMode
        var talkRoute: TalkRoute
        var halfDuplex: Bool

        var testDescription: String { name }
    }

    static let cases: [Case] = [
        Case(name: "MacBook mic and speakers", route: route(.builtIn, .builtIn, source: speakers),
             echo: .voiceProcessing, talkRoute: .builtIn, halfDuplex: false),
        Case(name: "MacBook mic, headphones in the jack", route: route(.builtIn, .builtIn, source: jack),
             echo: .none, talkRoute: .wired, halfDuplex: false),
        Case(name: "AirPods", route: route(.bluetooth, .bluetooth),
             echo: .none, talkRoute: .bluetoothHFP, halfDuplex: false),
        Case(name: "MacBook mic, AirPods out", route: route(.builtIn, .bluetooth),
             echo: .none, talkRoute: .wired, halfDuplex: false),
        Case(name: "AirPods mic, MacBook speakers", route: route(.bluetoothLE, .builtIn, source: speakers),
             echo: .none, talkRoute: .bluetoothHFP, halfDuplex: true),
        Case(name: "USB mic, MacBook speakers", route: route(.usb, .builtIn, source: speakers),
             echo: .voiceProcessing, talkRoute: .other, halfDuplex: false),
        Case(name: "MacBook mic, display speakers", route: route(.builtIn, .displayPort),
             echo: .voiceProcessing, talkRoute: .other, halfDuplex: false),
        Case(name: "USB interface both ways", route: route(.usb, .usb),
             echo: .voiceProcessing, talkRoute: .other, halfDuplex: false),
        Case(name: "iPhone mic (Continuity), HDMI", route: route(.continuity, .hdmi),
             echo: .voiceProcessing, talkRoute: .other, halfDuplex: false),
        Case(name: "echo off on speakers", route: route(.builtIn, .builtIn, source: speakers), preferring: TalkEchoMode.none,
             echo: .none, talkRoute: .builtIn, halfDuplex: true),
        Case(name: "voice processing forced on headphones", route: route(.builtIn, .builtIn, source: jack),
             preferring: .voiceProcessing, echo: .voiceProcessing, talkRoute: .wired, halfDuplex: false),
        Case(name: "the iPhone's echo-cancelled input reads as voice processing", route: route(.builtIn, .bluetooth),
             preferring: .echoCancelledInput, echo: .voiceProcessing, talkRoute: .wired, halfDuplex: false),
        Case(name: "echo off with AirPods", route: route(.bluetooth, .bluetooth), preferring: TalkEchoMode.none,
             echo: .none, talkRoute: .bluetoothHFP, halfDuplex: false),
    ]

    @Test(arguments: cases)
    func echoPolicy(_ c: Case) {
        let echo = MacEchoPolicy.choose(route: c.route, preferring: c.preferring)
        #expect(echo == c.echo)
        #expect(c.route.talkRoute == c.talkRoute)
        #expect(MacEchoPolicy.halfDuplex(route: c.route, echo: echo) == c.halfDuplex)
    }

    @Test func echoPreferenceNames() {
        #expect(MacEchoPolicy.preference(named: "automatic") == nil)
        #expect(MacEchoPolicy.preference(named: nil) == nil)
        #expect(MacEchoPolicy.preference(named: "voiceProcessing") == .voiceProcessing)
        #expect(MacEchoPolicy.preference(named: "echoCancelledInput") == .voiceProcessing)
        #expect(MacEchoPolicy.preference(named: "off") == TalkEchoMode.none)
        #expect(TalkEchoSetting(rawValue: "off")?.preferredMode == TalkEchoMode.none)
    }

    @Test func coreAudioTransports() {
        let table: [(StaticString, MacTransport)] = [
            ("bltn", .builtIn), ("usb ", .usb), ("blue", .bluetooth), ("blea", .bluetoothLE), ("grup", .aggregate),
            ("virt", .virtual), ("hdmi", .hdmi), ("dprt", .displayPort), ("airp", .airPlay), ("thun", .thunderbolt),
            ("pci ", .pci), ("1394", .fireWire), ("eavb", .avb), ("ccwd", .continuity), ("ccwl", .continuity),
        ]
        for (code, transport) in table {
            #expect(MacTransport(code: fourCC(code)) == transport, "\(code)")
        }
        #expect(MacTransport(code: 0) == .unknown(0))
        #expect(fourCC("bltn") == 0x626C_746E)
        #expect(MacTransport.bluetoothLE.isBluetooth)
        #expect(!MacTransport.usb.isBluetooth)
    }

    @Test func routeEdges() {
        #expect(!Self.route(nil, nil).outputIsSpeaker)
        #expect(Self.route(.builtIn, nil).talkRoute == .other)
        // A built-in output without a data source reads as speakers.
        #expect(Self.route(.builtIn, .builtIn).outputIsSpeaker)
        #expect(Self.route(.builtIn, .builtIn, source: Self.jack).description == "builtIn/builtIn:hdpn")
    }

    // MARK: - Channel 0

    @Test func channelZeroOfDeinterleavedAudioIsTheFirstChannel() {
        let channel0: [Float] = [0.1, 0.2, 0.3, 0.4]
        let out = channel0.withUnsafeBufferPointer {
            ChannelZero.extract($0.baseAddress!, frames: 4, channels: 3, interleaved: false)
        }
        #expect(out == channel0)
    }

    @Test func channelZeroOfInterleavedAudioTakesEveryNthSample() {
        // Three channels: voice, then two others.
        let interleaved: [Float] = [1, 9, 8, 2, 9, 8, 3, 9, 8, 4, 9, 8]
        let out = interleaved.withUnsafeBufferPointer {
            ChannelZero.extract($0.baseAddress!, frames: 4, channels: 3, interleaved: true)
        }
        #expect(out == [1, 2, 3, 4])
    }

    @Test func channelZeroOfMonoAndEmptyAudio() {
        let mono: [Float] = [0.5, -0.5]
        let out = mono.withUnsafeBufferPointer {
            ChannelZero.extract($0.baseAddress!, frames: 2, channels: 1, interleaved: true)
        }
        #expect(out == mono)
        let empty = mono.withUnsafeBufferPointer {
            ChannelZero.extract($0.baseAddress!, frames: 0, channels: 2, interleaved: true)
        }
        #expect(empty.isEmpty)
    }
}
