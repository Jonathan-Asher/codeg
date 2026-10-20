import Foundation
import Testing
@testable import BlueTTSKit
import BlueTTSEspeak

struct EspeakCase: Decodable, Sendable, CustomTestStringConvertible {
    let text: String
    let phonemes: String
    var testDescription: String { text }
}

struct RenikudCase: Decodable, Sendable, CustomTestStringConvertible {
    let text: String
    let phonemes: String
    let vocalized: String
    var testDescription: String { text }
}

@Suite("espeak-ng English phonemizer parity")
struct EspeakParityTests {
    static let cases = (try? Golden.load("espeak.json", as: [EspeakCase].self)) ?? []

    @Test(arguments: cases)
    func matchesPhonemizer(_ c: EspeakCase) throws {
        let e = try #require(TestModels.espeak)
        #expect(try e.phonemize(c.text) == c.phonemes)
    }

    @Test func version() { #expect(EspeakPhonemizer.version.hasPrefix("1.52.0")) }
}

@Suite("RenikudPlus G2P parity", .enabled(if: TestModels.available, "model files not found"), .serialized)
struct RenikudParityTests {
    static let cases = (try? Golden.load("renikud.json", as: [RenikudCase].self)) ?? []
    static let g2p: RenikudG2P? = TestModels.paths.flatMap { try? RenikudG2P(modelURL: $0.renikudModel, threads: 4) }

    @Test(arguments: cases)
    func phonemize(_ c: RenikudCase) throws {
        let g = try #require(Self.g2p)
        #expect(try g.phonemize(c.text) == c.phonemes)
    }

    @Test(arguments: cases)
    func vocalize(_ c: RenikudCase) throws {
        let g = try #require(Self.g2p)
        #expect(try g.vocalize(c.text) == c.vocalized)
    }
}

@Suite("Full front end vs Python (golden pipeline.json)", .enabled(if: TestModels.available, "model files not found"), .serialized)
struct PipelineParityTests {
    /// Swift on the *plain* text (auto-tagged) vs Python on the hand-tagged text.
    @Test(arguments: Golden.pipeline)
    func frontEnd(_ c: Golden.PipelineCase) async throws {
        let tts = try #require(TestModels.tts)
        let r = try await tts.phonemize(c.plain)
        #expect(r.language == c.language)
        #expect(r.tagged == c.tagged)
        #expect(r.normalized == c.normalized)
        #expect(r.segments.count == c.segments.count)
        for (s, g) in zip(r.segments, c.segments) {
            #expect(s.text == g.text)
            #expect(s.isSlow == g.isSlow)
            #expect(s.phonemes == g.phonemes)
            #expect(s.chunks == g.chunks)
        }
    }

    /// Token ids the acoustic model sees (UnicodeProcessor port).
    @Test(arguments: Golden.pipeline)
    func tokenIds(_ c: Golden.PipelineCase) throws {
        let vocab = try #require(TestModels.vocab)
        for seg in c.segments {
            for (chunk, ids) in zip(seg.chunks, seg.tokenIds) {
                #expect(vocab.encode(chunk, lang: c.language) == ids)
            }
        }
    }

    /// The spike's logged phoneme line (unmarked normalization, one G2P pass).
    @Test(arguments: Golden.pipeline.filter { $0.group == "spike" })
    func spikePhonemeLine(_ c: Golden.PipelineCase) async throws {
        let tts = try #require(TestModels.tts)
        var o = SynthesisOptions()
        o.normalizeText = false
        let input = TextNormalizer.prepareTextForSynthesis(EnglishAutoTagger.tag(c.plain), lang: c.language, markSlow: false)
        o.autoTagEnglish = false
        o.language = c.language == "en" ? .english : .hebrew
        let r = try await tts.phonemize(input, options: o)
        #expect(r.phonemes == c.spikePhon)
    }
}
