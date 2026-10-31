import AVFAudio
import XCTest
@testable import Codeg

// Talk's audio pieces in Core (they run on the Mac as they do on the
// iPhone): the echo choice and its names, the 16 kHz conversion, the
// frames and the earcons. The audio session's side is in TalkAudioTests.swift.

final class TalkEchoPolicyTests: XCTestCase {
    func testEachRouteGetsItsEchoMode() {
        XCTAssertEqual(TalkEchoPolicy.choose(route: .builtIn, echoCancelledInputAvailable: true), .echoCancelledInput)
        XCTAssertEqual(TalkEchoPolicy.choose(route: .builtIn, echoCancelledInputAvailable: false), .voiceProcessing)
        XCTAssertEqual(TalkEchoPolicy.choose(route: .bluetoothHFP, echoCancelledInputAvailable: true), TalkEchoMode.none)
        XCTAssertEqual(TalkEchoPolicy.choose(route: .wired, echoCancelledInputAvailable: true), .voiceProcessing)
        XCTAssertEqual(TalkEchoPolicy.choose(route: .other, echoCancelledInputAvailable: false), .voiceProcessing)
    }

    func testTheLabOverrideWins() {
        XCTAssertEqual(TalkEchoPolicy.choose(route: .builtIn, echoCancelledInputAvailable: true, override: .voiceProcessing),
                       .voiceProcessing)
        XCTAssertEqual(TalkEchoPolicy.choose(route: .bluetoothHFP, echoCancelledInputAvailable: false,
                                             override: .echoCancelledInput), .echoCancelledInput)
    }

    func testNamesRoundTrip() {
        for mode in [TalkEchoMode.echoCancelledInput, .voiceProcessing, TalkEchoMode.none] {
            XCTAssertEqual(TalkEchoPolicy.echoMode(named: TalkEchoPolicy.name(of: mode)), mode)
        }
        XCTAssertNil(TalkEchoPolicy.echoMode(named: "automatic"))
        XCTAssertEqual(TalkEchoPolicy.name(of: .bluetoothHFP), "bluetoothHFP")
    }
}

/// The 16 kHz conversion voice typing and Talk share, Talk's 512-sample
/// frames, and the earcons.
final class TalkAudioFramesTests: XCTestCase {
    private func sine(_ hz: Double, amplitude: Float, frames: Int, rate: Double) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        let channel = buffer.floatChannelData![0]
        for i in 0..<frames { channel[i] = amplitude * Float(sin(2 * Double.pi * hz * Double(i) / rate)) }
        return buffer
    }

    func testTheConverterGivesSixteenKilohertzMonoAndTheInputLevel() throws {
        let tapFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let converter = try XCTUnwrap(MicrophoneConverter(inputFormat: tapFormat))
        XCTAssertEqual(converter.outputFormat.sampleRate, 16_000)
        XCTAssertEqual(converter.outputFormat.channelCount, 1)
        var counts: [Int] = []
        var last: MicrophoneConverter.Converted?
        for _ in 0..<5 {
            let converted = try XCTUnwrap(converter.convert(sine(440, amplitude: 0.5, frames: 4_800, rate: 48_000)))
            counts.append(converted.samples.count)
            last = converted
        }
        // 0.5 s in gives up to 0.5 s at 16 kHz. AVAudioConverter hands its
        // output back in blocks of its own and keeps the rest (and its
        // filter delay) for the next buffer, so a chunk isn't always 100 ms;
        // what it holds back stays under 100 ms.
        XCTAssertTrue(counts.allSatisfy { $0 > 0 && $0 <= 1_664 }, "\(counts)")
        let total = counts.reduce(0, +)
        XCTAssertLessThanOrEqual(total, 8_000, "\(counts)")
        XCTAssertGreaterThanOrEqual(total, 6_400, "\(counts)")
        XCTAssertEqual(try XCTUnwrap(last).inputRMS, Float(0.5) / Float(2).squareRoot(), accuracy: 0.01)
        let tail = try XCTUnwrap(last).samples
        let peak = tail.map { abs($0) }.max() ?? 0
        XCTAssertEqual(peak, 0.5, accuracy: 0.05, "the tone survives the conversion")
    }

    func testABufferInAnotherFormatIsDropped() throws {
        let converter = try XCTUnwrap(MicrophoneConverter(inputFormat: AVAudioFormat(standardFormatWithSampleRate: 48_000,
                                                                                      channels: 1)!))
        XCTAssertNil(converter.convert(sine(440, amplitude: 0.5, frames: 4_410, rate: 44_100)))
    }

    func testTheMeterScale() {
        XCTAssertEqual(MicrophoneConverter.meterLevel(rms: 1), 1)
        XCTAssertEqual(MicrophoneConverter.meterLevel(rms: 0), 0)
        XCTAssertEqual(MicrophoneConverter.meterLevel(rms: pow(10, -27.5 / 20)), 0.5, accuracy: 0.001)
    }

    func testFramesAre512SamplesWithTheirTimeAndLevel() {
        var assembler = MicFrameAssembler()
        XCTAssertTrue(assembler.append(Array(repeating: 0.5, count: 300), startingAt: 10).isEmpty)
        let frames = assembler.append(Array(repeating: -0.5, count: 900), startingAt: 10.01875)
        XCTAssertEqual(frames.count, 2)
        XCTAssertTrue(frames.allSatisfy { $0.samples.count == 512 })
        XCTAssertEqual(frames[0].time, 10, accuracy: 1e-9, "from the first sample still waiting")
        XCTAssertEqual(frames[1].time, 10.032, accuracy: 1e-9)
        XCTAssertEqual(frames[0].rms, 0.5, accuracy: 1e-6)
        XCTAssertEqual(Array(frames[0].samples.prefix(300)), Array(repeating: 0.5, count: 300))
        // 1200 samples in, 1024 out: 176 wait for the next chunk.
        let next = assembler.append(Array(repeating: 0, count: 336), startingAt: 10.075)
        XCTAssertEqual(next.count, 1)
        XCTAssertEqual(next[0].time, 10.064, accuracy: 1e-9)
        XCTAssertEqual(next[0].rms, (Float(176) * 0.25 / 512).squareRoot(), accuracy: 1e-5)
    }

    func testEarconsAreSoftShortTones() {
        let rate = 44_100.0
        let gotIt = EarconTone.samples(.gotIt, sampleRate: rate)
        XCTAssertEqual(gotIt.count, Int(0.04 * rate))
        for earcon in [Earcon.listening, .gotIt, .error] {
            let samples = EarconTone.samples(earcon, sampleRate: rate)
            let peak = samples.map { abs($0) }.max() ?? 0
            XCTAssertLessThanOrEqual(peak, EarconTone.peak + 1e-6, "about -20 dBFS")
            XCTAssertGreaterThan(peak, EarconTone.peak * 0.9)
            XCTAssertEqual(samples.first ?? 1, 0, accuracy: 1e-6, "fades in")
            XCTAssertEqual(samples.last ?? 1, 0, accuracy: 1e-6, "fades out")
        }
        XCTAssertEqual(EarconTone.tones(.listening).map(\.hz), [660, 880])
        XCTAssertEqual(EarconTone.tones(.error).map(\.hz), [330, 220])
    }
}
