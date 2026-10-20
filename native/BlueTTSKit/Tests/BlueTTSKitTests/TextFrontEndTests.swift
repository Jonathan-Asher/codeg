import Foundation
import Testing
@testable import BlueTTSKit

struct NormalizerCase: Decodable, Sendable, CustomTestStringConvertible {
    let lang: String
    let text: String
    let normalized: String
    var testDescription: String { text }
}

struct NumCase: Decodable, Sendable {
    let value: Double
    let isFloat: Bool
    let he: String?
    let en: String?
    let ordinalEn: String?
}

@Suite("Text normalizer (text_norm.py, num2words)")
struct NormalizerTests {
    static let cases = (try? Golden.load("normalizer.json", as: [NormalizerCase].self)) ?? []

    @Test(arguments: cases)
    func prepareTextForSynthesis(_ c: NormalizerCase) {
        #expect(TextNormalizer.prepareTextForSynthesis(c.text, lang: c.lang) == c.normalized)
    }

    @Test func num2words() throws {
        let nums = try Golden.load("num2words.json", as: [NumCase].self)
        #expect(!nums.isEmpty)
        for n in nums {
            let v: Num2Words.Value = n.isFloat ? .float(n.value) : .int(Int(n.value))
            if let he = n.he { #expect(Num2Words.cardinal(v, lang: "he") == he, "he \(n.value)") }
            if let en = n.en { #expect(Num2Words.cardinal(v, lang: "en") == en, "en \(n.value)") }
            if let o = n.ordinalEn { #expect(Num2Words.ordinal(Int(n.value), lang: "en") == o, "ord \(n.value)") }
        }
    }
}

@Suite("Automatic <en> tagging")
struct AutoTaggerTests {
    static let hebrewCases = Golden.pipeline.filter { $0.language == "he" }

    /// The hand-placed spike tags are the spec: plain text in, the same tags out.
    @Test(arguments: hebrewCases)
    func tagsLikeTheSpike(_ c: Golden.PipelineCase) {
        #expect(EnglishAutoTagger.tag(c.plain) == c.tagged)
    }

    @Test func edgeCases() {
        #expect(EnglishAutoTagger.tag("פתחתי Pull Request מספר 412") == "פתחתי <en>Pull Request</en> מספר 412")
        #expect(EnglishAutoTagger.tag("עדכנתי ל-iOS 26 אתמול") == "עדכנתי ל-<en>iOS</en> 26 אתמול")
        #expect(EnglishAutoTagger.tag("בראנץ’ main") == "בראנץ' <en>main</en>")
        #expect(EnglishAutoTagger.tag("כתבתי ב-C++ וב-C#.") == "כתבתי ב-<en>C++</en> וב-<en>C#</en>.")
        #expect(EnglishAutoTagger.tag("שלח ל-dev@example.com") == "שלח ל-dev@example.com")
        #expect(EnglishAutoTagger.tag("כבר <en>tagged</en> וגם new") == "כבר <en>tagged</en> וגם <en>new</en>")
        #expect(EnglishAutoTagger.tag("No Hebrew here, you're fine.") == "No Hebrew here, you're fine.")
        #expect(EnglishAutoTagger.tag("ראה https://github.com/x/y עכשיו") == "ראה <en>https://github.com/x/y</en> עכשיו")
    }
}
