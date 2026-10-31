import XCTest
@testable import Codeg

/// A clock the tests move by hand.
final class FakeTalkClock: TalkClock, @unchecked Sendable {
    private(set) var time: TimeInterval = 0
    func now() -> TimeInterval { time }
    func advance(_ seconds: TimeInterval) { time += seconds }
}

/// Runs the machine the way the controller does: keeps its timers on a fake
/// clock and fires them when the clock passes them, and routes final texts
/// through the router.
struct TalkMachineDriver {
    var machine = TalkMachine()
    let clock = FakeTalkClock()
    private(set) var timers: [TalkTimer: TimeInterval] = [:]

    var state: TalkState { machine.state }
    var phase: TalkState.Phase { machine.state.phase }

    @discardableResult
    mutating func send(_ event: TalkEvent) -> [TalkEffect] {
        let effects = machine.handle(event)
        for effect in effects {
            switch effect {
            case .startTimer(let timer, let seconds): timers[timer] = clock.now() + seconds
            case .cancelTimer(let timer): timers[timer] = nil
            default: break
            }
        }
        return effects
    }

    /// Move the clock; fire the timers that fall due.
    @discardableResult
    mutating func advance(_ seconds: TimeInterval) -> [TalkEffect] {
        clock.advance(seconds)
        var effects: [TalkEffect] = []
        for (timer, due) in timers.sorted(by: { $0.value < $1.value }) where due <= clock.now() + 1e-9 {
            timers[timer] = nil
            effects += send(.timerFired(timer))
        }
        return effects
    }

    /// Hands-free (or push-to-talk) Talk that is listening.
    static func listening(handsFree: Bool = true, voice: TalkVoice = .hebrew(.masculine)) -> TalkMachineDriver {
        var driver = TalkMachineDriver()
        driver.send(.start(handsFree: handsFree, voice: voice))
        driver.send(.ready)
        return driver
    }

    /// The person says `text` hands-free, and it is routed as the controller
    /// routes it. The effects of the routing.
    @discardableResult
    mutating func say(_ text: String) -> [TalkEffect] {
        if phase != .hearing { send(.speechStarted) }
        send(.pause)
        send(.commit)
        return finish(text)
    }

    /// The final text arrives and is routed.
    @discardableResult
    mutating func finish(_ text: String) -> [TalkEffect] {
        let effects = send(.transcript(text))
        guard case .route(let words)? = effects.last else { return effects }
        return send(.routed(TalkRouter.route(words, context: state.routeContext)))
    }
}

final class TalkMachineTests: XCTestCase {
    private let voice = TalkVoice.hebrew(.masculine)

    private func units(_ texts: [String], reply: String = "t1", from index: Int = 0) -> [SpeechUnit] {
        texts.enumerated().map { offset, text in
            SpeechUnit(id: SpeechUnit.ID(reply: reply, index: index + offset), text: text,
                       isFirstOfReply: index + offset == 0)
        }
    }

    private var permission: TalkAsk {
        SpokenPrompts.ask(toolCall: .object([
            "kind": .string("execute"),
            "rawInput": .object(["command": .string("npm test"), "description": .string("להריץ את הבדיקות")]),
        ]), requestId: "r1", options: [
            PermissionOption(optionId: "yes", name: "Yes", kind: "allow_once"),
            PermissionOption(optionId: "no", name: "No", kind: "reject_once"),
        ], voice: voice)
    }

    private func spoken(_ effects: [TalkEffect]) -> [String] {
        effects.flatMap { effect -> [String] in
            if case .speak(let units) = effect { return units.map(\.text) }
            return []
        }
    }

    // MARK: - Lifecycle

    func testStartingAndEnding() {
        var driver = TalkMachineDriver()
        XCTAssertEqual(driver.send(.start(handsFree: true, voice: voice)), [.prepare])
        XCTAssertEqual(driver.phase, .preparing)
        XCTAssertEqual(driver.send(.ready), [.startListening(handsFree: true), .playCue(.listening)])
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertEqual(driver.send(.end), [.stopListening, .release])
        XCTAssertEqual(driver.phase, .ending)
        XCTAssertEqual(driver.send(.ended), [])
        XCTAssertEqual(driver.phase, .off)

        var failing = TalkMachineDriver()
        failing.send(.start(handsFree: true, voice: voice))
        XCTAssertEqual(failing.send(.failed), [.playCue(.error), .release])
        XCTAssertEqual(failing.phase, .ending)
    }

    func testEndingStopsWhateverIsGoingOn() {
        var driver = TalkMachineDriver.listening()
        driver.send(.reply(units(["One."])))
        XCTAssertEqual(driver.send(.end), [.stopSpeech, .stopListening, .release])
        var hearing = TalkMachineDriver.listening()
        hearing.send(.speechStarted)
        hearing.send(.pause)
        XCTAssertEqual(hearing.send(.end), [.cancelFinalDecode, .cancelUtterance, .stopListening, .release])
    }

    // MARK: - Listening

    func testAnUtteranceIsSentAndTheReplySpoken() {
        var driver = TalkMachineDriver.listening()
        XCTAssertEqual(driver.send(.speechStarted), [.beginUtterance(.speech)])
        XCTAssertEqual(driver.phase, .hearing)
        XCTAssertEqual(driver.send(.pause), [.startFinalDecode])
        XCTAssertEqual(driver.phase, .deciding)
        XCTAssertEqual(driver.send(.speechResumed), [.cancelFinalDecode])
        XCTAssertEqual(driver.send(.pause), [.startFinalDecode])
        XCTAssertEqual(driver.send(.commit), [.commitUtterance, .playCue(.gotIt)])
        XCTAssertEqual(driver.phase, .finalizing)
        XCTAssertEqual(driver.send(.transcript(" תבדוק את הלוגים ")), [.route("תבדוק את הלוגים")])
        XCTAssertEqual(driver.phase, .routing)
        XCTAssertEqual(driver.send(.routed(.sendSpoken("תבדוק את הלוגים"))),
                       [.sendAction(.sendSpoken("תבדוק את הלוגים"))])
        XCTAssertEqual(driver.phase, .agentWorking)

        let reply = units(["בדקתי.", "הכל תקין."])
        XCTAssertEqual(driver.send(.reply(reply)), [.speak(reply)])
        XCTAssertEqual(driver.phase, .speaking(ducked: false))
        let more = units(["רוצה עוד?"], from: 2)
        XCTAssertEqual(driver.send(.reply(more)), [.speak(more)], "appended to what is being said")
        driver.send(.unitStarted(reply[1].id))
        XCTAssertEqual(driver.state.playing.map(\.text), ["הכל תקין.", "רוצה עוד?"])
        XCTAssertEqual(driver.send(.speechFinished), [])
        XCTAssertEqual(driver.phase, .agentWorking)
        driver.send(.agentRunning(false))
        XCTAssertEqual(driver.phase, .listening)
    }

    func testACommitWithoutAPauseStartsTheFinalDecode() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        XCTAssertEqual(driver.send(.commit), [.startFinalDecode, .commitUtterance, .playCue(.gotIt)])
    }

    func testNothingHeardGoesBackToListening() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        XCTAssertEqual(driver.send(.discard), [.cancelUtterance])
        XCTAssertEqual(driver.phase, .listening)
        driver.send(.speechStarted)
        driver.send(.commit)
        XCTAssertEqual(driver.send(.transcript("  ")), [])
        XCTAssertEqual(driver.phase, .listening)
    }

    func testTheAgentWaitsWhileThePersonHasTheFloor() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        let reply = units(["Done."])
        XCTAssertEqual(driver.send(.reply(reply)), [], "the person is speaking")
        driver.send(.pause)
        XCTAssertEqual(driver.send(.reply(units(["More."], from: 1))), [])
        driver.send(.commit)
        let effects = driver.finish("ומה עם הבדיקות")
        XCTAssertEqual(effects, [.sendAction(.sendSpoken("ומה עם הבדיקות")), .speak(units(["Done.", "More."]))])
    }

    func testSpeechThatStartsDuringRoutingIsHeardRightAfter() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        driver.send(.pause)
        driver.send(.commit)
        XCTAssertEqual(driver.send(.speechStarted), [], "kept until the routing ends")
        XCTAssertEqual(driver.send(.transcript("תבדוק את הלוגים")), [.route("תבדוק את הלוגים")])
        XCTAssertEqual(driver.send(.pause), [])
        XCTAssertEqual(driver.send(.routed(.sendSpoken("תבדוק את הלוגים"))),
                       [.sendAction(.sendSpoken("תבדוק את הלוגים")), .beginUtterance(.speech), .startFinalDecode])
        XCTAssertEqual(driver.phase, .deciding)

        var committed = TalkMachineDriver.listening()
        committed.send(.speechStarted)
        committed.send(.commit)
        committed.send(.speechStarted)
        committed.send(.commit)
        XCTAssertEqual(committed.finish("ראשון"), [
            .sendAction(.sendSpoken("ראשון")), .beginUtterance(.speech), .startFinalDecode, .commitUtterance,
            .playCue(.gotIt),
        ])
        XCTAssertEqual(committed.phase, .finalizing)

        var dropped = TalkMachineDriver.listening()
        dropped.send(.speechStarted)
        dropped.send(.commit)
        dropped.send(.speechStarted)
        dropped.send(.discard)
        XCTAssertEqual(dropped.finish("ראשון"), [.sendAction(.sendSpoken("ראשון"))])
        XCTAssertEqual(dropped.phase, .agentWorking)
    }

    // MARK: - Interrupting

    func testTalkingOverTheSpeechDucksItThenStopsIt() {
        var driver = TalkMachineDriver.listening()
        let reply = units(["One.", "Two.", "Three."])
        driver.send(.reply(reply))
        XCTAssertEqual(driver.send(.bargeInCandidate), [.duck(true)])
        XCTAssertEqual(driver.phase, .speaking(ducked: true))
        XCTAssertEqual(driver.send(.bargeInRejected), [.duck(false)])
        XCTAssertEqual(driver.phase, .speaking(ducked: false))

        driver.send(.unitStarted(reply[1].id))
        driver.send(.bargeInCandidate)
        XCTAssertEqual(driver.send(.bargeInConfirmed), [.stopSpeech, .beginUtterance(.bargeIn)])
        XCTAssertEqual(driver.phase, .hearing)
        XCTAssertEqual(driver.state.held.map(\.text), ["Two.", "Three."], "from the sentence being spoken")

        XCTAssertEqual(driver.say("די"), [])
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertTrue(driver.state.routeContext.speechHeld)
        XCTAssertEqual(driver.say("תמשיך"), [.speak(Array(reply[1...]))])
    }

    func testAnInterruptionThatComesToNothingGoesOn() {
        var driver = TalkMachineDriver.listening()
        let reply = units(["One.", "Two."])
        driver.send(.reply(reply))
        driver.send(.bargeInCandidate)
        driver.send(.bargeInConfirmed)
        driver.send(.commit)
        XCTAssertEqual(driver.send(.transcript("")), [.speak(reply)])
        XCTAssertEqual(driver.phase, .speaking(ducked: false))
    }

    func testMoreOfAStoppedReplyIsHeldUntilThePersonSpeaksAgain() {
        var driver = TalkMachineDriver.listening()
        driver.send(.reply(units(["One.", "Two."])))
        driver.send(.bargeInCandidate)
        driver.send(.bargeInConfirmed)
        driver.say("עצור")
        XCTAssertEqual(driver.send(.reply(units(["Three."], from: 2))), [], "the person stopped this reply")
        XCTAssertEqual(driver.state.held.map(\.text), ["One.", "Two.", "Three."])
        let other = units(["Background result."], reply: "bg-1")
        XCTAssertEqual(driver.send(.reply(other)), [.speak(other)], "another reply is spoken")
        driver.send(.speechFinished)
        XCTAssertEqual(driver.say("תוסיף גם לוגים"), [.sendAction(.sendSpoken("תוסיף גם לוגים"))])
        let answer = units(["Added."], from: 3)
        XCTAssertEqual(driver.send(.reply(answer)), [.speak(answer)], "after new words, the reply is spoken again")
    }

    func testSkipDropsTheRestOfTheReply() {
        var driver = TalkMachineDriver.listening()
        driver.send(.reply(units(["One.", "Two."])))
        driver.send(.bargeInCandidate)
        driver.send(.bargeInConfirmed)
        XCTAssertEqual(driver.say("דלג"), [])
        XCTAssertEqual(driver.state.held, [])
        XCTAssertEqual(driver.send(.reply(units(["Three."], from: 2))), [])
        XCTAssertEqual(driver.state.held, [])
    }

    func testStopHoldsAReplyThatWasWaitingToo() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        driver.send(.reply(units(["Waiting."])))
        driver.send(.commit)
        XCTAssertEqual(driver.finish("די"), [], "the reply that waited for the person isn't spoken")
        XCTAssertEqual(driver.state.held.map(\.text), ["Waiting."])
        XCTAssertEqual(driver.say("תמשיך"), [.speak(units(["Waiting."]))])
    }

    func testSkipDropsAReplyThatWasWaiting() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        driver.send(.reply(units(["Waiting."])))
        let other = units(["Other."], reply: "bg")
        driver.send(.reply(other))
        driver.send(.commit)
        XCTAssertEqual(driver.finish("דלג"), [.speak(other)], "only the next reply in line is skipped")
        XCTAssertEqual(driver.send(.reply(units(["More."], from: 1))), [])
    }

    func testRepeatDoesntSayAWaitingUnitTwice() {
        var driver = TalkMachineDriver.listening()
        let first = units(["One."])
        driver.send(.reply(first))
        driver.send(.bargeInCandidate)
        driver.send(.bargeInConfirmed)
        driver.send(.reply(units(["Two."], from: 1)))
        XCTAssertEqual(driver.say("תחזור"), [.speak(units(["One.", "Two."]))])
    }

    func testATapStopsTheSpeech() {
        var driver = TalkMachineDriver.listening()
        driver.send(.reply(units(["One.", "Two."])))
        XCTAssertEqual(driver.send(.tapInterrupt), [.stopSpeech])
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertEqual(driver.state.held.map(\.text), ["One.", "Two."])
    }

    func testRepeatSaysTheLastReplyAgain() {
        var driver = TalkMachineDriver.listening()
        let reply = units(["One.", "Two."])
        driver.send(.reply(reply))
        driver.send(.speechFinished)
        XCTAssertEqual(driver.say("תחזור"), [.speak(reply)])
        var nothing = TalkMachineDriver.listening()
        XCTAssertEqual(nothing.say("תחזור"), [.playCue(.error)])
    }

    // MARK: - Asking

    func testAnAskTakesOverAfterTheSentenceBeingSpoken() {
        var driver = TalkMachineDriver.listening()
        let reply = units(["One.", "Two.", "Three."])
        driver.send(.reply(reply))
        let ask = permission
        XCTAssertEqual(driver.send(.ask(ask)), [.stopSpeechAfterCurrent])
        XCTAssertEqual(driver.state.held.map(\.text), ["Two.", "Three."])
        XCTAssertEqual(spoken(driver.send(.speechFinished)), ["אני רוצה להריץ את הבדיקות. לאשר?"])
        XCTAssertEqual(driver.send(.speechFinished), [])
        XCTAssertEqual(driver.phase, .asking(ask, attempt: 0))
        XCTAssertEqual(driver.send(.reply(units(["Four."], from: 3))), [], "more of the reply waits")
        XCTAssertEqual(driver.say("כן"),
                       [.sendAction(.respondPermission(askID: "permission:r1", optionId: "yes", feedback: nil))])
        XCTAssertNil(driver.state.ask)
        XCTAssertEqual(driver.state.held, [], "the reply before the question is not resumed")
        XCTAssertEqual(driver.phase, .agentWorking)
    }

    func testAnAskWhileListeningIsAskedAtOnce() {
        var driver = TalkMachineDriver.listening()
        XCTAssertEqual(spoken(driver.send(.ask(permission))), ["אני רוצה להריץ את הבדיקות. לאשר?"])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.say("לא, תריץ קודם את הלינטר"), [.sendAction(.respondPermission(
            askID: "permission:r1", optionId: "no", feedback: "תריץ קודם את הלינטר"))])
    }

    func testWordsStartedBeforeAPromptAreForTheSession() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        XCTAssertEqual(driver.send(.ask(permission)), [], "asked once the person is done")
        driver.send(.commit)
        let effects = driver.finish("תבדוק גם את הלוגים")
        XCTAssertEqual(effects.first, .sendAction(.sendSpoken("תבדוק גם את הלוגים")))
        XCTAssertEqual(spoken(effects), ["אני רוצה להריץ את הבדיקות. לאשר?"])
    }

    func testAnUnclearAnswerIsAskedAgainThenLeftOnTheScreen() {
        var driver = TalkMachineDriver.listening()
        let ask = permission
        driver.send(.ask(ask))
        driver.send(.speechFinished)
        XCTAssertEqual(spoken(driver.say("כן לא")), ["לא הבנתי. אני רוצה להריץ את הבדיקות. לאשר?"])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.phase, .asking(ask, attempt: 1))
        XCTAssertEqual(spoken(driver.say("אולי")), ["השארתי את זה על המסך."])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertEqual(driver.send(.ask(ask)), [], "left on the screen")
        XCTAssertEqual(driver.say("כן"), [.sendAction(.sendSpoken("כן"))], "now it's words for the session")
    }

    func testRepeatAndWaitWhileAsked() {
        var driver = TalkMachineDriver.listening()
        driver.send(.ask(permission))
        driver.send(.speechFinished)
        XCTAssertEqual(spoken(driver.say("תחזור")), ["אני רוצה להריץ את הבדיקות. לאשר?"])
        driver.send(.speechFinished)
        let question = SpokenPrompts.ask(question: PendingQuestion(questionId: "q", questions: [
            QuestionSpec(id: "a", question: "Which?", header: "", multiSelect: false,
                         options: [QuestionOption(label: "A", description: ""),
                                   QuestionOption(label: "B", description: "")]),
        ]), voice: voice)
        var asked = TalkMachineDriver.listening()
        asked.send(.ask(question))
        asked.send(.speechFinished)
        XCTAssertEqual(asked.say("רגע"), [])
        XCTAssertEqual(asked.phase, .asking(question, attempt: 0))
    }

    func testABargeInOverAPromptAnswersIt() {
        var driver = TalkMachineDriver.listening()
        driver.send(.ask(permission))
        driver.send(.bargeInCandidate)
        XCTAssertEqual(driver.send(.bargeInConfirmed), [.stopSpeech, .beginUtterance(.bargeIn)])
        XCTAssertEqual(driver.say("כן"),
                       [.sendAction(.respondPermission(askID: "permission:r1", optionId: "yes", feedback: nil))])

        var noise = TalkMachineDriver.listening()
        noise.send(.ask(permission))
        noise.send(.bargeInCandidate)
        noise.send(.bargeInConfirmed)
        noise.send(.commit)
        XCTAssertEqual(spoken(noise.send(.transcript(""))), ["אני רוצה להריץ את הבדיקות. לאשר?"],
                       "an interruption that came to nothing asks again")
    }

    func testASecretQuestionIsAnnouncedOnceAndNeverAsked() {
        let secret = SpokenPrompts.ask(question: PendingQuestion(questionId: "s", questions: [
            QuestionSpec(id: "k", question: "API key?", header: "", multiSelect: false, options: [], isSecret: true),
        ]), voice: voice)
        var driver = TalkMachineDriver.listening()
        XCTAssertEqual(spoken(driver.send(.ask(secret))), ["יש שאלה שמחכה על המסך."])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertNil(driver.state.ask)
        XCTAssertEqual(driver.send(.ask(secret)), [])
        XCTAssertEqual(driver.say("sk-123"), [.sendAction(.sendSpoken("sk-123"))])
    }

    func testAsksWaitTheirTurn() {
        var driver = TalkMachineDriver.listening()
        let first = permission
        let second = SpokenPrompts.ask(plan: PendingPlanApproval(approvalId: "p", toolCallId: "t",
                                                                 planMarkdown: "Ship it."), voice: voice)
        driver.send(.ask(first))
        XCTAssertEqual(driver.send(.ask(second)), [])
        driver.send(.speechFinished)
        let effects = driver.say("כן")
        XCTAssertEqual(effects.first,
                       .sendAction(.respondPermission(askID: "permission:r1", optionId: "yes", feedback: nil)))
        XCTAssertEqual(spoken(effects), ["יש תוכנית: Ship it. לאשר, לבקש שינויים או לוותר?"])
    }

    func testAnAskAnsweredElsewhereStopsItsPrompt() {
        var driver = TalkMachineDriver.listening()
        driver.send(.ask(permission))
        XCTAssertEqual(driver.send(.askResolved(id: "permission:r1")), [.stopSpeech])
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertNil(driver.state.ask)
    }

    func testAQuestionSetMovesOnByVoice() {
        let set = PendingQuestion(questionId: "q", questions: [
            QuestionSpec(id: "a", question: "DB?", header: "", multiSelect: false,
                         options: [QuestionOption(label: "Postgres", description: ""),
                                   QuestionOption(label: "SQLite", description: "")]),
            QuestionSpec(id: "b", question: "Port?", header: "", multiSelect: false,
                         options: [QuestionOption(label: "3000", description: ""),
                                   QuestionOption(label: "8080", description: "")]),
        ])
        var driver = TalkMachineDriver.listening()
        driver.send(.ask(SpokenPrompts.ask(question: set, voice: voice)))
        driver.send(.speechFinished)
        XCTAssertEqual(spoken(driver.say("SQLite")), ["Port? 3000 או 8080?"])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.say("השני"), [.sendAction(.answerQuestion(askID: "question:q", answer: QuestionAnswer(
            answers: [QuestionAnswerItem(questionId: "a", labels: ["SQLite"]),
                      QuestionAnswerItem(questionId: "b", labels: ["8080"])], declined: false)))])
    }

    // MARK: - Cancelling

    func testCancellingTheAgentIsConfirmed() {
        var driver = TalkMachineDriver.listening()
        let asked = driver.say("בטל את הסוכן")
        XCTAssertEqual(asked.first, .startTimer(.cancelConfirmation, seconds: 8))
        XCTAssertEqual(spoken(asked), ["בטוח? לבטל את העבודה?"])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.phase, .confirmingCancel)
        let cancelled = driver.say("כן")
        XCTAssertEqual(Array(cancelled.prefix(2)), [.cancelTimer(.cancelConfirmation), .sendAction(.cancelAgent)])
        XCTAssertEqual(spoken(cancelled), ["ביטלתי."])
        XCTAssertNil(driver.timers[.cancelConfirmation])
    }

    func testAnythingButYesKeepsTheAgent() {
        var driver = TalkMachineDriver.listening()
        driver.say("cancel the agent")
        driver.send(.speechFinished)
        let kept = driver.say("רגע, לא")
        XCTAssertEqual(kept.first, .cancelTimer(.cancelConfirmation))
        XCTAssertEqual(spoken(kept), ["בסדר, לא ביטלתי."])
        XCTAssertFalse(kept.contains(.sendAction(.cancelAgent)))
    }

    func testNoAnswerWithinEightSecondsKeepsTheAgent() {
        var driver = TalkMachineDriver.listening(voice: .hebrew(.feminine))
        XCTAssertEqual(spoken(driver.say("בטל את הסוכן")), ["בטוחה? לבטל את העבודה?"])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.advance(7.9), [])
        XCTAssertEqual(driver.phase, .confirmingCancel)
        XCTAssertEqual(spoken(driver.advance(0.1)), ["בסדר, לא ביטלתי."])
        driver.send(.speechFinished)
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertFalse(driver.state.confirmingCancel)
    }

    // MARK: - Mute, pauses, push to talk

    func testWhileMutedOnlyUnmuteIsActedOn() {
        var driver = TalkMachineDriver.listening()
        XCTAssertEqual(driver.send(.setMuted(true)), [.micMuted(true)])
        XCTAssertEqual(driver.say("מה קורה עם הבילד"), [])
        XCTAssertEqual(driver.phase, .listening)
        driver.send(.reply(units(["One."])))
        XCTAssertEqual(driver.send(.bargeInCandidate), [], "talking over the speech is off while muted")
        driver.send(.speechFinished)
        XCTAssertEqual(driver.say("תקשיב"), [.micMuted(false), .playCue(.listening)])
        XCTAssertFalse(driver.state.muted)

        var hearing = TalkMachineDriver.listening()
        hearing.send(.speechStarted)
        XCTAssertEqual(hearing.send(.setMuted(true)), [.micMuted(true), .cancelUtterance])
        XCTAssertEqual(hearing.phase, .listening)
    }

    func testAPhoneCallPausesTalk() {
        var driver = TalkMachineDriver.listening()
        driver.send(.reply(units(["One.", "Two."])))
        XCTAssertEqual(driver.send(.interrupted(.phoneCall)), [.stopSpeech, .stopListening])
        XCTAssertEqual(driver.phase, .paused(.phoneCall))
        XCTAssertEqual(driver.send(.reply(units(["Three."], from: 2))), [], "held: the reply was stopped")
        XCTAssertEqual(driver.send(.speechStarted), [])
        XCTAssertEqual(driver.send(.resumed), [.startListening(handsFree: true), .playCue(.listening)])
        XCTAssertEqual(driver.phase, .listening)
        XCTAssertEqual(driver.say("תמשיך"), [.speak(units(["One.", "Two.", "Three."]))])
    }

    func testWordsBeingRoutedWhenACallComesStillReachTheSession() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        driver.send(.commit)
        driver.send(.transcript("תריץ את הבדיקות"))
        driver.send(.interrupted(.siri))
        XCTAssertEqual(driver.send(.routed(.sendSpoken("תריץ את הבדיקות"))),
                       [.sendAction(.sendSpoken("תריץ את הבדיקות"))])
        XCTAssertEqual(driver.phase, .paused(.siri))
    }

    func testPushToTalk() {
        var driver = TalkMachineDriver.listening(handsFree: false)
        XCTAssertEqual(driver.state.handsFree, false)
        XCTAssertEqual(driver.send(.speechStarted), [], "voice detection doesn't open an utterance")
        driver.send(.reply(units(["One.", "Two."])))
        XCTAssertEqual(driver.send(.bargeInCandidate), [])
        XCTAssertEqual(driver.send(.pushToTalk(pressed: true)), [.stopSpeech, .beginUtterance(.pushToTalk)])
        XCTAssertEqual(driver.phase, .hearing)
        XCTAssertEqual(driver.send(.pushToTalk(pressed: false)),
                       [.startFinalDecode, .commitUtterance, .playCue(.gotIt)])
        XCTAssertEqual(driver.finish("תמשיך"), [.speak(units(["One.", "Two."]))])
    }

    func testSwitchingToPushToTalkDropsTheUtteranceBeingHeard() {
        var driver = TalkMachineDriver.listening()
        driver.send(.speechStarted)
        XCTAssertEqual(driver.send(.setHandsFree(false)), [.startListening(handsFree: false), .cancelUtterance])
        XCTAssertEqual(driver.phase, .listening)
    }

    func testTheReducerIsPure() {
        let state = TalkMachineDriver.listening().state
        let (a, effectsA) = TalkMachine.reduce(state, .speechStarted)
        let (b, effectsB) = TalkMachine.reduce(state, .speechStarted)
        XCTAssertEqual(a, b)
        XCTAssertEqual(effectsA, effectsB)
        XCTAssertEqual(state.phase, .listening, "the input state is untouched")
    }
}
