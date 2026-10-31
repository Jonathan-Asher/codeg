import XCTest
@testable import Codeg

/// How Talk words what the agent waits on, in Hebrew (masculine, feminine,
/// gender-neutral) and English.
final class TalkSpokenPromptsTests: XCTestCase {
    private let he = TalkVoice.hebrew(.masculine)
    private let en = TalkVoice.english

    private let yesNo = [
        PermissionOption(optionId: "y", name: "Yes", kind: "allow_once"),
        PermissionOption(optionId: "a", name: "Yes, always", kind: "allow_always"),
        PermissionOption(optionId: "n", name: "No", kind: "reject_once"),
        PermissionOption(optionId: "never", name: "No, never", kind: "reject_always"),
    ]

    private func prompt(_ toolCall: [String: AnyJSON], voice: TalkVoice) -> String {
        SpokenPrompts.ask(toolCall: .object(toolCall), requestId: "r", options: yesNo, voice: voice).prompt
    }

    private func command(_ description: String?) -> [String: AnyJSON] {
        var input: [String: AnyJSON] = ["command": .string("rm -rf build && npm ci")]
        if let description { input["description"] = .string(description) }
        return ["kind": .string("execute"), "title": .string("`rm -rf build && npm ci`"), "rawInput": .object(input)]
    }

    func testACommandIsReadFromItsDescription() {
        XCTAssertEqual(prompt(command("למחוק את תיקיית הבנייה ולהתקין מחדש"), voice: he),
                       "אני רוצה למחוק את תיקיית הבנייה ולהתקין מחדש. לאשר?")
        XCTAssertEqual(prompt(command("הרצת הבדיקות."), voice: he), "הרצת הבדיקות. לאשר?")
        XCTAssertEqual(prompt(command("Run the test suite"), voice: he), "Run the test suite. לאשר?",
                       "an English description is read as it is")
        XCTAssertEqual(prompt(command("Run the test suite."), voice: en), "I want to run the test suite. OK?")
        XCTAssertEqual(prompt(command(nil), voice: he), "אני רוצה להריץ פקודה, היא על המסך. לאשר?",
                       "the raw command is never read")
        XCTAssertEqual(prompt(command(nil), voice: en), "I want to run a command; it's on the screen. OK?")
    }

    func testAnEditNamesTheFile() {
        let edit: [String: AnyJSON] = [
            "kind": .string("edit"), "title": .string("Edit"),
            "rawInput": .object(["file_path": .string("/Users/j/Work/app/src/auth/login.ts"),
                                 "old_string": .string("a"), "new_string": .string("b")]),
        ]
        XCTAssertEqual(prompt(edit, voice: he), "אני רוצה לערוך את login.ts. לאשר?")
        XCTAssertEqual(prompt(edit, voice: en), "I want to edit login.ts. OK?")
        let write: [String: AnyJSON] = [
            "kind": .string("edit"),
            "rawInput": .string(#"{"file_path":"notes/todo.md","content":"x"}"#),
        ]
        XCTAssertEqual(prompt(write, voice: he), "אני רוצה לערוך את todo.md. לאשר?")
        let read: [String: AnyJSON] = ["kind": .string("read"),
                                       "rawInput": .object(["file_path": .string("/etc/hosts")])]
        XCTAssertEqual(prompt(read, voice: he), "אני רוצה לקרוא את hosts. לאשר?")
        let unknown: [String: AnyJSON] = ["kind": .string("other"),
                                          "title": .string(String(repeating: "very long title ", count: 6))]
        XCTAssertEqual(prompt(unknown, voice: he), "צריך אישור, הפרטים על המסך. לאשר?")
    }

    func testAFetchNamesTheSiteAndAnMCPToolItsName() {
        let fetch: [String: AnyJSON] = ["kind": .string("fetch"), "title": .string("Fetch"),
                                        "rawInput": .object(["url": .string("https://github.com/a/b/pull/3")])]
        XCTAssertEqual(prompt(fetch, voice: he), "אני רוצה לפתוח דף מ-github.com. לאשר?")
        XCTAssertEqual(prompt(fetch, voice: en), "I want to open a page from github.com. OK?")
        let mcp: [String: AnyJSON] = ["kind": .string("other"), "title": .string("create_issue"),
                                      "_meta": .object(["agent": .object([
                                          "toolName": .string("mcp__github__create_issue")])])]
        XCTAssertEqual(prompt(mcp, voice: he), "אני רוצה להשתמש ב-create issue. לאשר?")
        XCTAssertEqual(prompt(mcp, voice: en), "I want to use create issue. OK?")
    }

    func testTheSessionsPermissionCardIsReadTheSameWay() {
        let pending = PendingPermission(requestId: "r9", toolCall: .object(command("להריץ את הבדיקות")),
                                        options: yesNo)
        let ask = SpokenPrompts.ask(permission: pending, voice: he)
        XCTAssertEqual(ask.prompt, "אני רוצה להריץ את הבדיקות. לאשר?")
        XCTAssertEqual(ask.id, "permission:r9")
        XCTAssertEqual(ask.choices.map(\.meaning), [.allowOnce, .allowAlways, .rejectOnce, .rejectAlways])
    }

    func testASubAgentsPermissionIsReadOnlyWhenPlain() {
        XCTAssertEqual(SpokenPrompts.subAgentPermissionText("npm test", voice: he),
                       "סוכן ברקע מבקש אישור: npm test. לאשר?")
        XCTAssertEqual(SpokenPrompts.subAgentPermissionText("rm -rf x && ls", voice: he),
                       "סוכן ברקע מבקש אישור, הפרטים על המסך. לאשר?")
        XCTAssertEqual(SpokenPrompts.subAgentPermissionText("npm test", voice: en),
                       "A background agent asks to: npm test. OK?")
    }

    func testAQuestionReadsAtMostFourOptions() {
        let spec = QuestionSpec(id: "a", question: "באיזה **מסד נתונים**?", header: "", multiSelect: false,
                                options: ["Postgres", "SQLite", "MySQL"].map { QuestionOption(label: $0, description: "") })
        XCTAssertEqual(SpokenPrompts.questionText(spec, voice: he), "באיזה מסד נתונים? Postgres, SQLite או MySQL?")
        XCTAssertEqual(SpokenPrompts.questionText(spec, voice: en), "באיזה מסד נתונים? Postgres, SQLite, or MySQL?")
        let many = QuestionSpec(id: "b", question: "Which?", header: "", multiSelect: true,
                                options: ["A", "B", "C", "D", "E"].map { QuestionOption(label: $0, description: "") })
        XCTAssertEqual(SpokenPrompts.questionText(many, voice: .hebrew(.feminine)),
                       "Which? A, B, C, D או משהו אחר מהמסך? את יכולה לבחור כמה.")
        XCTAssertEqual(SpokenPrompts.questionText(many, voice: .hebrew(.masculine)),
                       "Which? A, B, C, D או משהו אחר מהמסך? אתה יכול לבחור כמה.")
        XCTAssertEqual(SpokenPrompts.questionText(many, voice: .hebrew(.neutral)),
                       "Which? A, B, C, D או משהו אחר מהמסך? אפשר לבחור כמה.")
        XCTAssertEqual(SpokenPrompts.questionText(many, voice: en),
                       "Which? A, B, C, D, or something else on the screen? You can pick more than one.")
        let two = QuestionSpec(id: "c", question: "Go?", header: "", multiSelect: false,
                               options: ["Yes", "No"].map { QuestionOption(label: $0, description: "") })
        XCTAssertEqual(SpokenPrompts.questionText(two, voice: en), "Go? Yes or No?")
    }

    func testAPlanIsReadFromItsFirstSentence() {
        XCTAssertEqual(SpokenPrompts.planText(markdown: "# Plan: Fix the login flow\n\n1. Read it\n2. Fix it",
                                              voice: he),
                       "יש תוכנית: Fix the login flow. לאשר, לבקש שינויים או לוותר?")
        XCTAssertEqual(SpokenPrompts.planText(markdown: "נתקן את ההתחברות. קודם נקרא את הקוד.", voice: he),
                       "יש תוכנית: נתקן את ההתחברות. לאשר, לבקש שינויים או לוותר?")
        XCTAssertEqual(SpokenPrompts.planText(markdown: "Refactor the store. Then test.", voice: en),
                       "There's a plan: Refactor the store. Approve it, ask for changes, or drop it?")
        XCTAssertEqual(SpokenPrompts.planText(markdown: "", voice: he),
                       "יש תוכנית על המסך. לאשר, לבקש שינויים או לוותר?")
    }

    func testTheCancelQuestionFollowsTheAddress() {
        XCTAssertEqual(SpokenPrompts.confirmCancel(.hebrew(.masculine)), "בטוח? לבטל את העבודה?")
        XCTAssertEqual(SpokenPrompts.confirmCancel(.hebrew(.feminine)), "בטוחה? לבטל את העבודה?")
        XCTAssertEqual(SpokenPrompts.confirmCancel(.hebrew(.neutral)), "לבטל באמת את העבודה?")
        XCTAssertEqual(SpokenPrompts.confirmCancel(.english), "Are you sure? Cancel the work?")
    }

    func testTheVoiceComesFromTheServersTalkSettings() {
        XCTAssertEqual(TalkVoice.resolve(language: "he", address: "masculine"), .hebrew(.masculine))
        XCTAssertEqual(TalkVoice.resolve(language: "auto", address: "auto"), .hebrew(.neutral))
        XCTAssertEqual(TalkVoice.resolve(language: nil, address: "feminine"), .hebrew(.feminine))
        XCTAssertEqual(TalkVoice.resolve(language: "en", address: "masculine"), .english)
        XCTAssertEqual(TalkVoice.resolve(language: "auto", address: "masculine", lastHeardHebrew: false), .english)
        XCTAssertEqual(TalkVoice.resolve(language: "auto", address: "masculine", lastHeardHebrew: true),
                       .hebrew(.masculine))
    }

    func testAnAsksSecondAttemptStartsWithIDidntCatchThat() {
        let ask = SpokenPrompts.ask(toolCall: .object(command("להריץ את הבדיקות")), requestId: "r", options: yesNo,
                                    voice: he)
        XCTAssertEqual(ask.promptUnit().text, "אני רוצה להריץ את הבדיקות. לאשר?")
        XCTAssertEqual(ask.promptUnit(attempt: 1).text, "לא הבנתי. אני רוצה להריץ את הבדיקות. לאשר?")
        XCTAssertEqual(ask.promptUnit().kind, .cue)
        XCTAssertNotEqual(ask.promptUnit().id, ask.promptUnit(attempt: 1).id)
    }
}
