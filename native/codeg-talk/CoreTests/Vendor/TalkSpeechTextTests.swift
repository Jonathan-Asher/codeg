import XCTest
@testable import Codeg

/// Talk's streaming reader: a reply streamed in any chunks reads exactly like
/// the whole reply, and like the batch Markdown reader with the same options.
final class TalkIncrementalSpeechTextTests: XCTestCase {
    /// Replies covering what Talk reads differently: Hebrew, gershayim,
    /// nikud, code, tables, paths, URLs, numbers, abbreviations, hashes.
    static let fixtures: [String] = [
        "I fixed the login bug. The tests pass now! Want me to push it?",
        "עדכנתי את ה-README. ד\"ר כהן אישר, וצה\"ל גם. מה עכשיו?",
        "שָׁלוֹם עוֹלָם. זה עובד\u{200F} יפה.",
        "Here is the fix:\n\n```swift\nlet x = 1. y = 2\n```\n\nIt works.",
        "| File | Status |\n|---|---|\n| a.ts | done |\n| b.ts | todo |\n\nAll good.",
        "I edited src/auth/login.ts and ~/Work/codeg/README.md. Then ./scripts/build.sh ran, and/or not.",
        "See https://example.com/docs. ראה https://github.com/x/y לפרטים.",
        "Version 3.5 is out. It costs 4.99 e.g. for 10 users. Dr. Smith agreed. That's it.",
        "Commit a1b2c3d4e5f6a7b8c9 is pushed (deadbeef0123456789). Short abc1234 stays.",
        "# Summary\n\n- First item\n- Second item. With more\n\n1. One\n2) Two\n\n> Quote line\n> - quoted item",
        "Run `npm run build. Then test` now. Done.",
        "**Done. Next** step is *here. now* ok. ~~old. text~~ gone.",
        "בדקתי את `main.swift`, הכל עובד. רוצה שאדחוף?",
        "First.\r\nSecond line.\r\n\r\nNew paragraph.",
        "שמתי את הפקודה על המסך.\n\n```sh\nnpm test\n```\n\nותגיד לי.",
        "הוא אמר 'שלום' וגם \"תודה\". ג'ירה עובדת, וכו'. זה הכל.",
        "Use my_var and __init__ here. Ok _really_ done.",
        "Text before.\n\n```\ncode that never closes. at all",
        "Line one<br>Line two. <b>Bold</b> text.",
        "[the docs](https://x.com/a) and ![a picture](a.png) here. <https://auto.link/x> too.",
        "Wait... what?! OK. Fine…  Next one.",
        "א. ראשון ב. שני. זהו.",
        "- [ ] task one\n- [x] task two\n\n---\n\nAfter the rule.",
        "A table:\n| a | b |\n|---|---|\n| 1 | 2 |\nRight after.\n\n```\ncode\n```\n| c |\n| d |",
        "Mixed עברית and English. 2 tests נכשלו at 10:30 today.",
        "Ends without punctuation",
        "  Indented line.\n\tTabbed line.  \n",
        "Some *emphasis\nacross lines* here. And a [link\nacross](x) lines.",
        "",
        "\n\n",
        "עדכנתי את ה-src/app/main.swift ואת ~/x/y.md. (a1b2c3d4e5f6a7b8) [0123456789abcdef] נשאר.",
        "Use `a. b` and **c. d** in https://x.y/z. Done! <i>ok.</i> 1. not a list here",
        "ראה \"צה\"ל\" ו'שלום' ב-https://ex.am/ple, ואז ד''ר כהן.\nשורה שנייה עם e.g. קיצור. סוף",
        "> נאמר: עשה. ואז\n> - פריט. שני\n\n## כותרת. עם נקודה\n\n|a|b|\n|-|-|\n|1|2|\nאחרי.",
    ]

    static let longFixture: String = {
        let clause = "this clause goes on for a while, adding words that make the sentence longer and longer"
        return "Start. " + Array(repeating: clause, count: 6).joined(separator: " ") + ". End here."
    }()

    static var allFixtures: [String] { fixtures + [longFixture] }

    static let optionSets: [(String, SpeechText.MarkdownOptions)] = [
        ("talk", .talk),
        ("default", SpeechText.MarkdownOptions()),
        ("code", SpeechText.MarkdownOptions(includeCode: true)),
        ("talk with code", {
            var o = SpeechText.MarkdownOptions.talk
            o.includeCode = true
            o.skipTables = false
            return o
        }()),
    ]

    // MARK: - Helpers

    static func read(_ chunks: [String], options: SpeechText.MarkdownOptions = .talk) -> [SpeechUnit] {
        var reader = IncrementalSpeechText(reply: "r", options: options)
        var units: [SpeechUnit] = []
        for chunk in chunks { units += reader.append(chunk) }
        units += reader.finish()
        return units
    }

    static func joined(_ units: [SpeechUnit]) -> String {
        units.map(\.text).joined(separator: " ")
    }

    static func batch(_ markdown: String, options: SpeechText.MarkdownOptions) -> String {
        SpeechText.fromMarkdown(markdown, options: options).replacingOccurrences(of: "\n", with: " ")
    }

    /// Ways to cut `text`: every character, every scalar, fixed widths, and
    /// seeded random cuts.
    static func chunkings(of text: String) -> [[String]] {
        var out: [[String]] = []
        out.append(text.map { String($0) })
        out.append(text.unicodeScalars.map { String($0) })
        for width in [2, 3, 5, 7, 13] {
            var chunks: [String] = []
            var current = ""
            for c in text {
                current.append(c)
                if current.count == width {
                    chunks.append(current)
                    current = ""
                }
            }
            if !current.isEmpty { chunks.append(current) }
            out.append(chunks)
        }
        var rng = SplitMix(seed: UInt64(text.utf8.count) &* 2654435761 &+ 7)
        let scalars = Array(text.unicodeScalars)
        for _ in 0..<12 {
            var chunks: [String] = []
            var i = 0
            while i < scalars.count {
                let n = 1 + Int(rng.next() % 9)
                let end = min(scalars.count, i + n)
                var view = String.UnicodeScalarView()
                view.append(contentsOf: scalars[i..<end])
                chunks.append(String(view))
                i = end
            }
            out.append(chunks)
        }
        return out
    }

    // MARK: - Properties

    func testEveryChunkingReadsLikeOneChunk() {
        for (name, options) in Self.optionSets {
            for fixture in Self.allFixtures {
                let whole = Self.read([fixture], options: options)
                for chunks in Self.chunkings(of: fixture) {
                    let streamed = Self.read(chunks, options: options)
                    XCTAssertEqual(streamed, whole, "\(name): \(fixture.debugDescription) cut as \(chunks.count) chunks")
                }
            }
        }
    }

    func testItReadsLikeTheBatchReaderWithTheSameOptions() {
        for (name, options) in Self.optionSets {
            for fixture in Self.allFixtures {
                XCTAssertEqual(Self.joined(Self.read([fixture], options: options)), Self.batch(fixture, options: options),
                               "\(name): \(fixture.debugDescription)")
            }
        }
    }

    /// Read Aloud's existing fixtures, unchanged by the streaming reader.
    func testPlainMarkdownMatchesReadAloud() {
        let markdown = """
        ## Summary

        I **fixed** the `login` bug in [auth.ts](src/auth.ts) and _cleaned up_ the tests.

        ```swift
        let x = 1
        ```

        - First item
        - Second item

        See https://example.com/docs for more
        """
        let plain = SpeechText.MarkdownOptions()
        XCTAssertEqual(Self.joined(Self.read([markdown], options: plain)), SpeechText.fromMarkdown(markdown)
            .replacingOccurrences(of: "\n", with: " "))
        XCTAssertEqual(Self.read([markdown], options: plain).map(\.text), [
            "Summary.", "I fixed the login bug in auth.ts and cleaned up the tests.", "First item.", "Second item.",
            "See a link for more.",
        ])
    }

    func testEveryUnitIsShortEnough() {
        for fixture in Self.allFixtures {
            for unit in Self.read([fixture]) {
                XCTAssertLessThanOrEqual(unit.text.count, IncrementalSpeechText.maxUnitLength, unit.text)
                XCTAssertFalse(unit.text.isEmpty)
            }
        }
    }

    // MARK: - Streaming

    func testASentenceIsEmittedOnceItIsComplete() {
        var reader = IncrementalSpeechText(reply: "t1")
        XCTAssertEqual(reader.append("Hello there. How").map(\.text), ["Hello there."])
        XCTAssertEqual(reader.append(" are you"), [])
        XCTAssertEqual(reader.append("? Fine").map(\.text), ["How are you?"])
        XCTAssertEqual(reader.append(". Bye").map(\.text), ["Fine."])
        XCTAssertEqual(reader.finish().map(\.text), ["Bye."])
    }

    func testTheFirstUnitOfAReplyIsMarkedAndIdsCount() {
        let units = Self.read(["One. Two. Three."])
        XCTAssertEqual(units.map(\.isFirstOfReply), [true, false, false])
        XCTAssertEqual(units.map(\.id), [
            SpeechUnit.ID(reply: "r", index: 0), SpeechUnit.ID(reply: "r", index: 1), SpeechUnit.ID(reply: "r", index: 2),
        ])
    }

    func testALineThatMayOpenAFenceWaits() {
        var reader = IncrementalSpeechText(reply: "t")
        XCTAssertEqual(reader.append("Look.\n").map(\.text), ["Look."])
        XCTAssertEqual(reader.append("``"), [], "it may still become a code fence")
        let opened = reader.append("`swift\nlet x = 1. More code\n")
        XCTAssertEqual(opened.map(\.text), ["It's on the screen."])
        XCTAssertEqual(opened.first?.kind, .cue)
        XCTAssertEqual(reader.append("```\nAfter.\n").map(\.text), ["After."])
    }

    func testHeadingsTablesAndListsWaitForTheirLine() {
        var reader = IncrementalSpeechText(reply: "t")
        XCTAssertEqual(reader.append("# Head. ing"), [])
        XCTAssertEqual(reader.append("\n").map(\.text), ["Head.", "ing."])
        XCTAssertEqual(reader.append("| a. b | c"), [])
        XCTAssertEqual(reader.append(" |\n").map(\.text), ["It's on the screen."])
        XCTAssertEqual(reader.append("- item. one"), [])
        XCTAssertEqual(reader.append("\n").map(\.text), ["item.", "one."])
    }

    func testProseIsReadUpToMarkdownThatIsStillOpen() {
        var reader = IncrementalSpeechText(reply: "t")
        XCTAssertEqual(reader.append("Done. Now **bold. still").map(\.text), ["Done."])
        XCTAssertEqual(reader.append(" open** text. "), [])
        XCTAssertEqual(reader.append("\n").map(\.text), ["Now bold.", "still open text."])
    }

    // MARK: - What is read

    func testCodeAndTablesBecomeOneCueEach() {
        let units = Self.read(["Intro.\n\n```\na\nb\n```\n\n| x |\n|---|\n| y |\n\nOutro."])
        XCTAssertEqual(units.map(\.text), ["Intro.", "It's on the screen.", "Outro."])
        XCTAssertEqual(units.map(\.kind), [.sentence, .cue, .sentence])
        let hebrew = Self.read(["הנה.\n\n```\na\n```\n\nתמשיך.\n\n| x |\n| y |"])
        XCTAssertEqual(hebrew.map(\.text), ["הנה.", "שמתי את זה על המסך.", "תמשיך.", "שמתי את זה על המסך."])
        XCTAssertEqual(hebrew[1].language, .hebrew)
    }

    func testNoCueWhenTheReplyAlreadySaysItIsOnTheScreen() {
        XCTAssertEqual(Self.read(["שמתי את הפקודה על המסך.\n\n```sh\nnpm test\n```"]).map(\.text),
                       ["שמתי את הפקודה על המסך."])
        XCTAssertEqual(Self.read(["I put it on the screen.\n\n| a |\n| b |"]).map(\.text), ["I put it on the screen."])
    }

    func testACueBeforeAnyProseIsHebrew() {
        XCTAssertEqual(Self.read(["```\nx\n```\nAfter."]).map(\.text), ["שמתי את זה על המסך.", "After."])
    }

    func testPathsAreReadAsTheirLastPart() {
        XCTAssertEqual(Self.joined(Self.read(["I edited src/auth/login.ts and ~/Work/codeg/. Also ./run.sh and a/b.json."])),
                       "I edited login.ts and codeg. Also run.sh and b.json.")
        XCTAssertEqual(Self.joined(Self.read(["Read and/or write 10/31/2026, TCP/IP."])),
                       "Read and/or write 10/31/2026, TCP/IP.")
        XCTAssertEqual(Self.joined(Self.read(["עדכנתי את ה-src/app/main.swift."])), "עדכנתי את ה-main.swift.")
    }

    func testURLsBecomeALinkInTheLinesLanguage() {
        XCTAssertEqual(Self.joined(Self.read(["See https://example.com/a/b. Then go."])), "See a link. Then go.")
        XCTAssertEqual(Self.joined(Self.read(["ראה https://example.com/a, ואז תמשיך."])), "ראה קישור, ואז תמשיך.")
    }

    func testLongHexRunsAreDropped() {
        XCTAssertEqual(Self.joined(Self.read(["Pushed a1b2c3d4e5f6a7 (0123456789abcdef) and abc1234."])),
                       "Pushed and abc1234.")
        XCTAssertEqual(Self.joined(Self.read(["Commit is pushed (deadbeef0123456789)."])), "Commit is pushed .")
    }

    func testSentencesDontSplitInsideAbbreviationsNumbersOrCode() {
        XCTAssertEqual(Self.read(["Use e.g. Postgres 16.2 now. Dr. Who said `a. b! c?` too. Next."]).map(\.text),
                       ["Use e.g. Postgres 16.2 now.", "Dr. Who said a. b! c? too.", "Next."])
    }

    func testGershayimAndNikudAreCleaned() {
        XCTAssertEqual(Self.read(["ד\"ר כהן מצה''ל. שָׁלוֹם וכו'."]).map(\.text), ["ד״ר כהן מצה״ל.", "שלום וכו׳."])
        XCTAssertEqual(Self.read(["‏שלום\u{200E} עולם."]).map(\.text), ["שלום עולם."])
    }

    func testALongSentenceIsCutAtACommaOrSpace() {
        let units = Self.read([Self.longFixture])
        XCTAssertGreaterThan(units.count, 3)
        XCTAssertEqual(units.first?.text, "Start.")
        XCTAssertEqual(units.last?.text, "End here.")
        XCTAssertEqual(Self.joined(units), Self.batch(Self.longFixture, options: .talk))
        XCTAssertTrue(units.allSatisfy { $0.text.count <= IncrementalSpeechText.maxUnitLength })
    }

    func testLanguageHints() {
        let units = Self.read(["שלום. Hello. 42."])
        XCTAssertEqual(units.map(\.language), [.hebrew, .english, .auto])
    }

    // MARK: - Boundaries and joining mid-reply

    func testABoundaryEndsTheParagraph() {
        var reader = IncrementalSpeechText(reply: "t")
        XCTAssertEqual(reader.append("Let me check"), [])
        XCTAssertEqual(reader.boundary().map(\.text), ["Let me check."])
        XCTAssertEqual(reader.append("```\nunclosed").map(\.text), ["It's on the screen."])
        XCTAssertEqual(reader.boundary(), [], "the boundary closes the code block")
        let found = reader.append("Found it. ")
        XCTAssertEqual(found.map(\.text), ["Found it."])
        XCTAssertEqual(found.first?.id, SpeechUnit.ID(reply: "t", index: 2))
    }

    func testSkippingTheSentenceInProgress() {
        var reader = IncrementalSpeechText(reply: "t")
        _ = reader.append("Earlier. Half a sen")
        reader.skipCurrentSentence()
        XCTAssertEqual(reader.append("tence here. Next one. "), Self.unitsFor(["Next one."], reply: "t", from: 1))
        var fence = IncrementalSpeechText(reply: "t")
        _ = fence.append("Intro.\n``")
        fence.skipCurrentSentence()
        XCTAssertEqual(fence.append("`\ncode\n```\nAfter.").map(\.text), [], "the code block began before")
        XCTAssertEqual(fence.finish().map(\.text), ["After."])
        var atBoundary = IncrementalSpeechText(reply: "t")
        _ = atBoundary.append("Done. ")
        atBoundary.skipCurrentSentence()
        XCTAssertEqual(atBoundary.append("Next. ").map(\.text), ["Next."], "nothing was in progress")
    }

    static func unitsFor(_ texts: [String], reply: String, from index: Int) -> [SpeechUnit] {
        texts.enumerated().map { offset, text in
            SpeechUnit(id: SpeechUnit.ID(reply: reply, index: index + offset), text: text,
                       isFirstOfReply: index + offset == 0)
        }
    }
}

/// A small seeded generator, so the random cuts are the same on every run.
struct SplitMix {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
