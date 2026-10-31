import XCTest
@testable import Codeg

/// What an utterance means in Talk: commands, answers to what the agent is
/// waiting on (NO before YES, ordinals, labels, several choices, asking
/// again), cancel confirmation, and words for the session.
final class TalkRouterTests: XCTestCase {
    private let voice = TalkVoice.hebrew(.masculine)

    private func route(_ text: String, _ context: TalkRouteContext = TalkRouteContext()) -> TalkAction {
        TalkRouter.route(text, context: context)
    }

    // MARK: - Commands

    func testCommandsAreWholeShortUtterances() {
        let table: [(String, TalkAction)] = [
            ("די", .stopSpeech), ("עצור בבקשה", .stopSpeech), ("Stop.", .stopSpeech), ("אוקיי, תעצור", .stopSpeech),
            ("שקט", .stopSpeech), ("תחזור", .repeatLast), ("מה אמרת?", .repeatLast), ("שוב", .repeatLast),
            ("דלג", .skip), ("skip", .skip), ("השתק", .mute(true)), ("סיים שיחה", .endTalk), ("end talk", .endTalk),
            ("בטל את הסוכן", .askConfirmCancel), ("cancel the agent", .askConfirmCancel), ("תקשיב", .ignore),
        ]
        for (text, expected) in table {
            XCTAssertEqual(route(text), expected, text)
        }
    }

    func testLongerUtterancesAreWordsForTheSession() {
        XCTAssertEqual(route("די כבר עם זה בבקשה עכשיו תקשיב"), .sendSpoken("די כבר עם זה בבקשה עכשיו תקשיב"))
        XCTAssertEqual(route("תעצור את השרת"), .sendSpoken("תעצור את השרת"))
        XCTAssertEqual(route("  תבדוק את הלוגים  "), .sendSpoken("תבדוק את הלוגים"))
        XCTAssertEqual(route("   "), .ignore)
        XCTAssertEqual(route("..."), .ignore)
    }

    func testContinueIsACommandOnlyWhenSpeechWasStopped() {
        XCTAssertEqual(route("תמשיך", TalkRouteContext(speechHeld: true)), .continueSpeech)
        XCTAssertEqual(route("תמשיך"), .sendSpoken("תמשיך"))
    }

    func testWhileMutedOnlyUnmuteAndEndAreHeard() {
        let muted = TalkRouteContext(muted: true)
        XCTAssertEqual(route("תקשיב", muted), .mute(false))
        XCTAssertEqual(route("unmute", muted), .mute(false))
        XCTAssertEqual(route("סיים שיחה", muted), .endTalk)
        XCTAssertEqual(route("מה קורה עם הבילד", muted), .ignore)
        XCTAssertEqual(route("די", muted), .ignore)
    }

    // MARK: - Cancelling the agent

    func testOnlyYesConfirmsCancelling() {
        let confirming = TalkRouteContext(confirmingCancel: true)
        for yes in ["כן", "כן, תבטל", "בטל", "yes", "סבבה", "כן בטוח", "תבטל את זה"] {
            XCTAssertEqual(route(yes, confirming), .cancelAgent, yes)
        }
        for other in ["לא", "רגע", "מה?", "כן לא", "תבדוק קודם את הלוגים", "no"] {
            XCTAssertEqual(route(other, confirming), .keepAgent, other)
        }
    }

    // MARK: - Permissions

    private func permissionAsk(_ options: [PermissionOption]? = nil) -> TalkAsk {
        let toolCall = AnyJSON.object([
            "kind": .string("execute"),
            "title": .string("`rm -rf build && npm ci`"),
            "rawInput": .object(["command": .string("rm -rf build && npm ci"),
                                 "description": .string("למחוק את תיקיית הבנייה ולהתקין מחדש")]),
        ])
        return SpokenPrompts.ask(toolCall: toolCall, requestId: "r1", options: options ?? [
            PermissionOption(optionId: "once", name: "Yes", kind: "allow_once"),
            PermissionOption(optionId: "always", name: "Yes, and don't ask again", kind: "allow_always"),
            PermissionOption(optionId: "no", name: "No", kind: "reject_once"),
            PermissionOption(optionId: "never", name: "No, never", kind: "reject_always"),
        ], voice: voice)
    }

    private func respond(_ option: String, _ feedback: String? = nil) -> TalkAction {
        .respondPermission(askID: "permission:r1", optionId: option, feedback: feedback)
    }

    func testPermissionAnswers() {
        let ask = permissionAsk()
        let context = TalkRouteContext(ask: ask)
        let table: [(String, TalkAction)] = [
            ("כן", respond("once")), ("בטח", respond("once")), ("יאללה", respond("once")), ("תריץ", respond("once")),
            ("yes", respond("once")), ("go ahead", respond("once")), ("no problem", respond("once")),
            ("וכן", respond("once")), ("לא", respond("no")), ("די", respond("no")), ("רגע", respond("no")),
            ("אל תעשה את זה", respond("no")), ("nope", respond("no")), ("בטל", respond("no")),
            ("תמיד", respond("always")), ("always", respond("always")), ("אל תשאל שוב", respond("always")),
            ("אף פעם", respond("never")), ("never", respond("never")), ("הראשון", respond("once")),
            ("האחרון", respond("never")), ("השלישית", respond("no")),
        ]
        for (text, expected) in table {
            XCTAssertEqual(route(text, context), expected, text)
        }
    }

    func testNoComesBeforeYesAndTheRestOfANoIsFeedback() {
        let context = TalkRouteContext(ask: permissionAsk())
        XCTAssertEqual(route("לא, תריץ קודם את הבדיקות", context), respond("no", "תריץ קודם את הבדיקות"))
        XCTAssertEqual(route("no, first run the tests", context), respond("no", "first run the tests"))
        XCTAssertEqual(route("לא תודה", context), respond("no"))
    }

    func testAnUnclearAnswerIsAskedAgainOnceThenLeftOnTheScreen() {
        let ask = permissionAsk()
        for unclear in ["כן לא", "לא, כן", "לא בטוח", "אולי", "כן אבל רק את התיקייה הזאת", "מה זה עושה בכלל"] {
            XCTAssertEqual(route(unclear, TalkRouteContext(ask: ask)), .reAsk, unclear)
            XCTAssertEqual(route(unclear, TalkRouteContext(ask: ask, askAttempt: 1)), .leaveOnScreen, unclear)
        }
    }

    func testCommandsStillWorkWhileAsked() {
        let context = TalkRouteContext(ask: permissionAsk())
        XCTAssertEqual(route("תחזור", context), .repeatLast)
        XCTAssertEqual(route("דלג", context), .leaveOnScreen)
        XCTAssertEqual(route("השתק", context), .mute(true))
        XCTAssertEqual(route("סיים שיחה", context), .endTalk)
        XCTAssertEqual(route("בטל את הסוכן", context), .askConfirmCancel)
        XCTAssertEqual(route("stop the agent", context), .askConfirmCancel)
        XCTAssertEqual(route("cancel it", context), respond("no"), "cancelling the action is a no")
    }

    func testMissingKindsFallBack() {
        let ask = permissionAsk([
            PermissionOption(optionId: "y", name: "Allow", kind: "allow_once"),
            PermissionOption(optionId: "n", name: "Deny", kind: "reject_once"),
        ])
        let context = TalkRouteContext(ask: ask)
        XCTAssertEqual(route("תמיד", context), .respondPermission(askID: "permission:r1", optionId: "y", feedback: nil))
        XCTAssertEqual(route("אף פעם", context), .respondPermission(askID: "permission:r1", optionId: "n", feedback: nil))
        XCTAssertEqual(route("deny", context), .respondPermission(askID: "permission:r1", optionId: "n", feedback: nil))
    }

    // MARK: - Plans

    private var planApproval: TalkAsk {
        SpokenPrompts.ask(plan: PendingPlanApproval(approvalId: "p1", toolCallId: "t",
                                                    planMarkdown: "# Plan: fix the login\n\n1. a\n2. b"),
                          voice: voice)
    }

    private func plan(_ decision: PlanApprovalDecision, _ feedback: String? = nil) -> TalkAction {
        .answerPlan(askID: "plan:p1", decision: decision, feedback: feedback)
    }

    func testPlanAnswers() {
        let context = TalkRouteContext(ask: planApproval)
        let table: [(String, TalkAction)] = [
            ("לאשר", plan(.approve)), ("כן", plan(.approve)), ("approve", plan(.approve)), ("תמיד", plan(.approve)),
            ("לוותר", plan(.abandon)), ("drop it", plan(.abandon)), ("אף פעם", plan(.abandon)),
            ("לא", plan(.requestChanges)), ("לבקש שינויים", plan(.requestChanges)),
            ("שינויים: תוסיף בדיקות", plan(.requestChanges, "תוסיף בדיקות")),
            ("request changes, split it in two", plan(.requestChanges, "split it in two")),
            ("תוסיף גם בדיקות יחידה", plan(.requestChanges, "תוסיף גם בדיקות יחידה")),
            ("לא, תפצל את זה לשני שלבים", plan(.requestChanges, "תפצל את זה לשני שלבים")),
            ("כן אבל בלי למחוק קבצים", plan(.requestChanges, "בלי למחוק קבצים")),
            ("השלישית", plan(.abandon)), ("הראשונה", plan(.approve)),
            ("מה עם הביצועים של השרת", plan(.requestChanges, "מה עם הביצועים של השרת")),
            ("אולי", .reAsk), ("hmm", .reAsk),
        ]
        for (text, expected) in table {
            XCTAssertEqual(route(text, context), expected, text)
        }
    }

    func testAPlanApprovedThroughPermissionOptionsKeepsTheContext() {
        let toolCall = AnyJSON.object([
            "kind": .string("switch_mode"),
            "title": .string("Ready to code?"),
            "rawInput": .object(["plan": .string("Fix the login flow.\n\n- step one\n- step two")]),
        ])
        let ask = SpokenPrompts.ask(toolCall: toolCall, requestId: "x", options: [
            PermissionOption(optionId: "clear", name: "Yes, clear context and auto-accept edits", kind: "allow_always"),
            PermissionOption(optionId: "accept", name: "Yes, auto-accept edits", kind: "allow_always"),
            PermissionOption(optionId: "manual", name: "Yes, manually approve edits", kind: "allow_once"),
            PermissionOption(optionId: "plan", name: "No, keep planning", kind: "reject_once"),
        ], voice: voice)
        XCTAssertEqual(ask.kind, .plan)
        XCTAssertEqual(ask.prompt, "יש תוכנית: Fix the login flow. לאשר, לבקש שינויים או לוותר?")
        let context = TalkRouteContext(ask: ask)
        XCTAssertEqual(route("כן", context), .respondPermission(askID: "permission:x", optionId: "accept", feedback: nil))
        XCTAssertEqual(route("שינויים: גם בדיקות", context),
                       .respondPermission(askID: "permission:x", optionId: "plan", feedback: "גם בדיקות"))
        XCTAssertEqual(route("לוותר", context), .respondPermission(askID: "permission:x", optionId: "plan", feedback: nil))
    }

    // MARK: - Questions

    private func question(_ labels: [String], multiSelect: Bool = false, id: String = "q1",
                          extra: [QuestionSpec] = []) -> TalkAsk {
        let spec = QuestionSpec(id: "\(id)-a", question: "באיזה מסד נתונים?", header: "DB", multiSelect: multiSelect,
                                options: labels.map { QuestionOption(label: $0, description: "") })
        return SpokenPrompts.ask(question: PendingQuestion(questionId: id, questions: [spec] + extra), voice: voice)
    }

    private func answered(_ labels: [String], id: String = "q1") -> TalkAction {
        .answerQuestion(askID: "question:\(id)", answer: QuestionAnswer(
            answers: [QuestionAnswerItem(questionId: "\(id)-a", labels: labels)], declined: false))
    }

    func testQuestionAnswers() {
        let context = TalkRouteContext(ask: question(["Postgres", "SQLite", "MySQL"]))
        let table: [(String, TalkAction)] = [
            ("Postgres", answered(["Postgres"])), ("sqlite", answered(["SQLite"])), ("השני", answered(["SQLite"])),
            ("השנייה", answered(["SQLite"])), ("אפשרות שנייה", answered(["SQLite"])), ("האחרונה", answered(["MySQL"])),
            ("the first one", answered(["Postgres"])), ("the second one", answered(["SQLite"])),
            ("בוא נלך על postgres", answered(["Postgres"])), ("I want MySQL please", answered(["MySQL"])),
            ("תשתמש במונגו", answered(["תשתמש במונגו"])), ("שנייה", .wait), ("רגע", .wait), ("hold on", .wait),
            ("כן", .reAsk), ("לא יודע", .reAsk),
        ]
        for (text, expected) in table {
            XCTAssertEqual(route(text, context), expected, text)
        }
    }

    func testYesAndNoPickTheOptionThatStartsWithThem() {
        let context = TalkRouteContext(ask: question(["Yes, add tests", "No, skip them"]))
        XCTAssertEqual(route("לא", context), answered(["No, skip them"]))
        XCTAssertEqual(route("כן", context), answered(["Yes, add tests"]))
        XCTAssertEqual(route("בטח", context), answered(["Yes, add tests"]))
        let single = TalkRouteContext(ask: question(["Run it"]))
        XCTAssertEqual(route("כן", single), answered(["Run it"]))
        let stop = TalkRouteContext(ask: question(["Stop the server", "Keep it running"]))
        XCTAssertEqual(route("לא", stop), .reAsk, "a verb at the start of a label isn't a no")
    }

    func testSeveralChoices() {
        let context = TalkRouteContext(ask: question(["Lint", "Tests", "Docs"], multiSelect: true))
        XCTAssertEqual(route("הראשון והשלישי", context), answered(["Lint", "Docs"]))
        XCTAssertEqual(route("Lint and Tests", context), answered(["Lint", "Tests"]))
        XCTAssertEqual(route("tests, docs", context), answered(["Tests", "Docs"]))
        XCTAssertEqual(route("כולם", context), answered(["Lint", "Tests", "Docs"]))
        XCTAssertEqual(route("all of them", context), answered(["Lint", "Tests", "Docs"]))
        XCTAssertEqual(route("Docs", context), answered(["Docs"]))
        XCTAssertEqual(route("Lint ו-Docs", context), answered(["Lint", "Docs"]))
        XCTAssertEqual(route("את השנייה וגם את השלישית", context), answered(["Tests", "Docs"]))
    }

    func testAQuestionSetIsAskedOneQuestionAtATime() {
        let second = QuestionSpec(id: "q1-b", question: "Which port?", header: "Port", multiSelect: false,
                                  options: [QuestionOption(label: "3000", description: ""),
                                            QuestionOption(label: "8080", description: "")])
        let ask = question(["Postgres", "SQLite"], extra: [second])
        XCTAssertTrue(ask.prompt.hasPrefix("יש לי 2 שאלות."))
        guard case .askNext(let next) = route("השני", TalkRouteContext(ask: ask)) else {
            return XCTFail("the second question should be asked next")
        }
        XCTAssertEqual(next.id, ask.id)
        XCTAssertEqual(next.questions?.index, 1)
        XCTAssertEqual(next.prompt, "Which port? 3000 או 8080?")
        XCTAssertEqual(route("8080", TalkRouteContext(ask: next)), .answerQuestion(askID: "question:q1", answer:
            QuestionAnswer(answers: [QuestionAnswerItem(questionId: "q1-a", labels: ["SQLite"]),
                                     QuestionAnswerItem(questionId: "q1-b", labels: ["8080"])], declined: false)))
    }

    func testASecretQuestionIsNeverListenedFor() {
        let spec = QuestionSpec(id: "s", question: "API key?", header: "Key", multiSelect: false, options: [],
                                isSecret: true)
        let ask = SpokenPrompts.ask(question: PendingQuestion(questionId: "sq", questions: [spec]), voice: voice)
        XCTAssertTrue(ask.isSecret)
        XCTAssertFalse(ask.answerableByVoice)
        XCTAssertFalse(ask.prompt.contains("API"))
        XCTAssertEqual(route("sk-12345", TalkRouteContext(ask: ask)), .sendSpoken("sk-12345"),
                       "a secret ask is not a context for answers")
    }

    // MARK: - Sub-agent items

    func testPendingItemsAreAnsweredLikeTheSessionsOwn() {
        let item = PendingItem(id: "i1", kind: "permission", source: "permission", conversationId: 2,
                               rootConversationId: 1, connectionId: "c", requestId: "r", askedAt: Date(),
                               text: "npm test", options: [PendingOption(id: "ok", label: "Yes", kind: "allow_once"),
                                                           PendingOption(id: "no", label: "No", kind: "reject_once")])
        let ask = SpokenPrompts.ask(item: item, voice: voice)
        XCTAssertEqual(ask.source, .pendingItem(id: "i1"))
        XCTAssertEqual(ask.prompt, "סוכן ברקע מבקש אישור: npm test. לאשר?")
        XCTAssertEqual(route("כן", TalkRouteContext(ask: ask)),
                       .respondPermission(askID: "item:i1", optionId: "ok", feedback: nil))
        let multi = PendingItem(id: "i2", kind: "question", source: "question", conversationId: 2, connectionId: "c",
                                requestId: "r", askedAt: Date(), text: "Q?",
                                options: [PendingOption(id: "A", label: "A")],
                                question: PendingQuestionDetail(itemId: "x", count: 2))
        XCTAssertFalse(SpokenPrompts.ask(item: multi, voice: voice).answerableByVoice,
                       "only the first question of the set is known")
    }
}
