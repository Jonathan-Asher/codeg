import XCTest
@testable import Codeg

/// What of the session Talk speaks: the live turn past a cursor (through
/// reconnects and a mid-turn start), the background cue, background turns.
final class TalkFeedTests: XCTestCase {
    private func texts(_ units: [SpeechUnit]) -> [String] { units.map(\.text) }

    /// Feed `text` as it grows, `step` characters at a time.
    private func stream(_ feed: inout TalkFeed, turn: String, _ text: String, step: Int = 3) -> [SpeechUnit] {
        var units: [SpeechUnit] = []
        var end = text.startIndex
        while end < text.endIndex {
            end = text.index(end, offsetBy: step, limitedBy: text.endIndex) ?? text.endIndex
            units += feed.liveText(turnID: turn, text: String(text[..<end]), isStreaming: true)
        }
        return units
    }

    private func turn(_ id: String, _ blocks: [ContentBlock], role: TurnRole = .assistant) -> MessageTurn {
        MessageTurn(id: id, role: role, blocks: blocks, timestamp: Date(timeIntervalSince1970: 0))
    }

    func testTheLiveTurnIsSpokenOnceAsItStreams() {
        var feed = TalkFeed()
        let units = stream(&feed, turn: "t1", "בדקתי את הלוגים. יש שגיאה אחת.\n\nאני מתקן אותה עכשיו")
        XCTAssertEqual(texts(units), ["בדקתי את הלוגים.", "יש שגיאה אחת."])
        XCTAssertEqual(units.first?.isFirstOfReply, true)
        XCTAssertEqual(units.first?.id.reply, "t1")
        XCTAssertEqual(feed.liveText(turnID: "t1", text: "בדקתי את הלוגים. יש שגיאה אחת.\n\nאני מתקן אותה עכשיו",
                                     isStreaming: true), [], "the same text again says nothing")
        XCTAssertEqual(texts(feed.turnEnded(turnID: "t1", stopReason: "end_turn")), ["אני מתקן אותה עכשיו."])
    }

    func testAToolBoundaryEndsTheParagraph() {
        var feed = TalkFeed()
        XCTAssertEqual(feed.liveText(turnID: "t", text: "Let me check the tests", isStreaming: true), [])
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "Let me check the tests\n\n", isStreaming: true)),
                       ["Let me check the tests."])
    }

    func testAReconnectResumesWithoutRepeating() {
        var feed = TalkFeed()
        _ = feed.liveText(turnID: "t", text: "First sentence. Second", isStreaming: true)
        // The text is rebuilt from the start after a reconnect.
        XCTAssertEqual(feed.liveText(turnID: "t", text: "First sen", isStreaming: true), [])
        XCTAssertEqual(feed.liveText(turnID: "t", text: "First sentence. Second", isStreaming: true), [])
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "First sentence. Second one. Third", isStreaming: true)),
                       ["Second one."])
        // Rebuilt slightly differently before the cursor: reading goes on at the cursor.
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "First sentence! Second one. Third part. Fourth",
                                           isStreaming: true)), ["Third part."])
    }

    func testAFinishedTurnSaysItsLastSentence() {
        var feed = TalkFeed()
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "All done", isStreaming: false)), ["All done."])
        XCTAssertEqual(feed.turnEnded(turnID: "t", stopReason: "end_turn"), [], "said once")
        XCTAssertEqual(feed.turnEnded(turnID: "other", stopReason: "end_turn"), [])
    }

    func testACancelledTurnDoesntFinishItsSentence() {
        var feed = TalkFeed()
        _ = feed.liveText(turnID: "t", text: "Okay. I'm deleting the", isStreaming: true)
        XCTAssertEqual(feed.turnEnded(turnID: "t", stopReason: "cancelled"), [])
    }

    func testANewTurnFinishesAMissedEnd() {
        var feed = TalkFeed()
        _ = feed.liveText(turnID: "t1", text: "Last words", isStreaming: true)
        let units = feed.liveText(turnID: "t2", text: "New turn. ", isStreaming: true)
        XCTAssertEqual(texts(units), ["Last words.", "New turn."])
        XCTAssertEqual(units.map(\.id.reply), ["t1", "t2"])
    }

    func testStartingMidTurnSpeaksOnlyWhatComesAfter() {
        var feed = TalkFeed()
        feed.start(liveTurnID: "t", liveText: "Earlier sentence. Half of a", backgroundTurns: [])
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "Earlier sentence. Half of a sentence. Next one. ",
                                           isStreaming: true)), ["Next one."])
        var inCode = TalkFeed()
        inCode.start(liveTurnID: "t", liveText: "Here:\n\n```sh\nnpm te", backgroundTurns: [])
        XCTAssertEqual(texts(inCode.liveText(turnID: "t", text: "Here:\n\n```sh\nnpm test\n```\n\nDone. ",
                                             isStreaming: true)), ["Done."], "the code block was already open")
    }

    func testWaitingForBackgroundWorkGivesOneCue() {
        var feed = TalkFeed()
        _ = feed.liveText(turnID: "t", text: "אני מתחיל לעבוד על זה ברקע", isStreaming: true)
        let units = feed.awaitingBackground(true)
        XCTAssertEqual(texts(units), ["אני מתחיל לעבוד על זה ברקע.", "העבודה ממשיכה ברקע."])
        XCTAssertEqual(units.last?.kind, .cue)
        XCTAssertEqual(feed.awaitingBackground(true), [])
        XCTAssertEqual(feed.awaitingBackground(false), [])
        XCTAssertEqual(feed.awaitingBackground(true), [], "once per turn")
        _ = feed.turnEnded(turnID: "t", stopReason: "end_turn")
        _ = feed.liveText(turnID: "t2", text: "Starting it in the background", isStreaming: true)
        XCTAssertEqual(texts(feed.awaitingBackground(true)),
                       ["Starting it in the background.", "It's running in the background."])
    }

    func testBackgroundTurnsHaveTheirOwnCursors() {
        var feed = TalkFeed()
        let first = turn("bg-0-0", [.text("The tests pass."), .toolUse(id: "1", name: "Bash", inputPreview: nil,
                                                                         meta: nil)])
        XCTAssertEqual(texts(feed.backgroundTurns([first])), ["The tests pass."])
        let grown = turn("bg-0-0", [.text("The tests pass."), .toolUse(id: "1", name: "Bash", inputPreview: nil,
                                                                         meta: nil),
                                    .text("I also fixed the lint.")])
        let second = turn("bg-0-1", [.text("Second result.")])
        let user = turn("bg-0-2", [.text("A user turn.")], role: .user)
        XCTAssertEqual(texts(feed.backgroundTurns([grown, second, user])), ["I also fixed the lint.", "Second result."])
        XCTAssertEqual(feed.backgroundTurns([grown, second]), [], "upserted, nothing new")
    }

    func testBackgroundTurnsThatWereThereBeforeTalkAreNotSpoken() {
        var feed = TalkFeed()
        let old = turn("bg-1-0", [.text("An old result.")])
        feed.start(liveTurnID: nil, liveText: "", backgroundTurns: [old])
        XCTAssertEqual(feed.backgroundTurns([old]), [])
        let grown = turn("bg-1-0", [.text("An old result."), .text("A new paragraph.")])
        XCTAssertEqual(texts(feed.backgroundTurns([grown])), ["A new paragraph."])
    }

    func testEnglishTalkSaysCuesInEnglishBeforeAnyProse() {
        var feed = TalkFeed(language: .english)
        XCTAssertEqual(texts(feed.liveText(turnID: "t", text: "```\nx\n```\n", isStreaming: true)),
                       ["It's on the screen."])
        var hebrew = TalkFeed()
        XCTAssertEqual(texts(hebrew.liveText(turnID: "t", text: "```\nx\n```\n", isStreaming: true)),
                       ["שמתי את זה על המסך."])
    }
}
