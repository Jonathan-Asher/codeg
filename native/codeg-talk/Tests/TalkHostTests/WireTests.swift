@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

/// Every protocol fixture decodes (window → helper) or is exactly what the
/// helper encodes (helper → window), and every message type and op has one.
@MainActor
struct WireTests {
    static let inboundTypes = ["start", "port", "live", "turnEnded", "awaiting", "bgTurns", "items", "res",
                               "control", "settings", "prefs", "end"]
    static let outboundTypes = ["hello", "state", "level", "req", "cmd", "flags", "ended", "error"]
    static let requestOps = ["sendSpoken", "respondPermission", "answerQuestion", "declineQuestion",
                             "answerPlanApproval", "setTalkMode", "fetchSettings", "respondItem", "answerItem",
                             "answerItemPlan", "uploadReport"]

    @Test func everyMessageHasAFixture() throws {
        var toHelper: Set<String> = [], toWindow: Set<String> = [], ops: Set<String> = [], controls: Set<String> = []
        for name in Fixtures.names {
            let object = try Fixtures.object(name)
            let type = try #require(object["type"] as? String, "\(name) has no type")
            if name.hasPrefix("to-helper.") {
                toHelper.insert(type)
                if type == "control", let op = object["op"] as? String { controls.insert(op) }
            } else {
                #expect(name.hasPrefix("to-window."), "\(name): fixtures are to-helper.* or to-window.*")
                toWindow.insert(type)
                if type == "req", let op = object["op"] as? String { ops.insert(op) }
            }
        }
        #expect(toHelper == Set(Self.inboundTypes))
        #expect(toWindow == Set(Self.outboundTypes))
        #expect(ops == Set(Self.requestOps))
        #expect(controls == Set(WireControl.Op.allCases.map(\.rawValue)))
    }

    @Test func everyWindowMessageDecodes() throws {
        for name in Fixtures.names where name.hasPrefix("to-helper.") {
            _ = try Inbound.parse(Fixtures.line(name))
        }
    }

    @Test func start() throws {
        guard case .start(let s) = try Inbound.parse(Fixtures.line("to-helper.start")) else {
            Issue.record("not a start")
            return
        }
        #expect(s.protocolVersion == 1)
        #expect(s.conversationID == 42)
        #expect(s.title == "Fix the flaky build")
        #expect(s.folder == "codeg")
        #expect(s.settings == TalkSettings(language: .auto, address: .masculine))
        #expect(s.prefs == WirePrefs(handsFree: true, patience: "normal", interruptBySpeaking: true,
                                     speakProgress: false, smartTurnActive: false, echoMode: "automatic",
                                     shareTelemetry: true))
        #expect(s.voice == WireVoice(name: "noa", speed: 1.0))
        #expect(s.port.title == "Fix the flaky build")
        #expect(s.port.canInsertIntoTurn)
        #expect(s.port.isInFlight)
        #expect(!s.port.awaitingBackground)
        let permission = try #require(s.port.pendingPermission)
        #expect(permission.requestId == "perm-7")
        #expect(permission.options.map(\.optionId) == ["allow", "always", "deny"])
        #expect(permission.options.map(\.kind) == ["allow_once", "allow_always", "reject_once"])
        // The tool call's keys come camelCased, as on the iPhone; its parser reads both.
        #expect(permission.parsed.command == "rm -rf build")
        #expect(s.port.pendingQuestion == nil)
        #expect(s.port.pendingPlanApproval == nil)
        #expect(s.live == WireLive(turnId: "42:7", text: "בדקתי את הלוגים של ה-CI.", streaming: true))
        #expect(s.items.map(\.id) == ["permission:conn-9:perm-11", "question:conn-9:q-12", "permission:conn-1:perm-7"])
        #expect(s.items[0].rootConversationId == 42)
        #expect(s.items[0].conversationId == 57)
        #expect(s.items[1].question?.itemId == "c41d")
        let models = try #require(s.models)
        #expect(models.zipformer?.tokens.hasSuffix("zipformer2-66m-streaming-he-tokens.txt") == true)
        #expect(models.vad?.hasSuffix("ggml-silero-v5.1.2.bin") == true)
        #expect(models.smartTurn?.hasSuffix("smart-turn-v3.2-cpu.onnx") == true)
        #expect(models.whisper?.hasSuffix("ggml-ivrit-large-v3-turbo-q8_0.bin") == true)
        #expect(models.languageID?.hasSuffix("ggml-tiny-q8_0.bin") == true)
        #expect(models.bluetts?.hasSuffix("/tts/models") == true)
        #expect(models.espeakData?.hasSuffix("espeak-ng-data") == true)
        #expect(s.app?["bundleId"] == "app.codeg")
    }

    @Test func startWithOnlyTheRequiredFields() throws {
        let line = #"{"type":"start","protocol":1,"conversationId":7}"#
        guard case .start(let s) = try Inbound.parse(line) else {
            Issue.record("not a start")
            return
        }
        #expect(s.conversationID == 7)
        #expect(s.prefs == WirePrefs())
        #expect(s.items.isEmpty)
        #expect(s.live == nil)
        #expect(s.models == nil)
        #expect(!s.port.isInFlight)
    }

    @Test func portChangesOnlyWhatItNames() throws {
        guard case .port(let change) = try Inbound.parse(Fixtures.line("to-helper.port")) else {
            Issue.record("not a port")
            return
        }
        #expect(change.isInFlight == false)
        #expect(change.canInsertIntoTurn == false)
        #expect(change.awaitingBackground == nil)
        #expect(change.backgroundOutstanding == nil)
        guard case .set(let permission) = change.pendingPermission else {
            Issue.record("pendingPermission: null clears it")
            return
        }
        #expect(permission == nil)
        guard case .set(let question?) = change.pendingQuestion else {
            Issue.record("pendingQuestion is set")
            return
        }
        #expect(question.questionId == "q-3")
        #expect(question.questions.first?.multiSelect == false)
        #expect(question.questions.first?.options.map(\.label) == ["staging", "production"])
        guard case .unchanged = change.pendingPlanApproval else {
            Issue.record("pendingPlanApproval is absent: unchanged")
            return
        }
        guard case .set(let title) = change.title else {
            Issue.record("title is set")
            return
        }
        #expect(title == "Fix the flaky CI build")

        guard case .port(let plan) = try Inbound.parse(Fixtures.line("to-helper.port.plan")) else { return }
        guard case .set(let approval?) = plan.pendingPlanApproval else {
            Issue.record("pendingPlanApproval is set")
            return
        }
        #expect(approval.approvalId == "plan-2")
        #expect(approval.toolCallId == "call_9")
        #expect(approval.planMarkdown.hasPrefix("# Plan"))
        #expect(plan.backgroundOutstanding == 2)
        #expect(plan.awaitingBackground == true)
    }

    @Test func liveTurnsAndHold() throws {
        guard case .live(let live) = try Inbound.parse(Fixtures.line("to-helper.live")) else { return }
        #expect(live.turnId == "42:8")
        #expect(live.text.contains("\n\n"))
        #expect(live.streaming)
        guard case .turnEnded(let id, let reason) = try Inbound.parse(Fixtures.line("to-helper.turnEnded")) else { return }
        #expect(id == "42:8")
        #expect(reason == "end_turn")
        guard case .turnEnded(_, let none) = try Inbound.parse(Fixtures.line("to-helper.turnEnded.reconnect")) else { return }
        #expect(none == nil)
        guard case .awaiting(let value) = try Inbound.parse(Fixtures.line("to-helper.awaiting")) else { return }
        #expect(value)
    }

    @Test func backgroundTurnsAreServerRecords() throws {
        guard case .bgTurns(let turns) = try Inbound.parse(Fixtures.line("to-helper.bgTurns")) else { return }
        let turn = try #require(turns.first)
        #expect(turn.id == "turn-31")
        #expect(turn.role == .assistant)
        #expect(turn.blocks.count == 3)
        #expect(turn.durationMs == 5400)
        #expect(turn.completedAt != nil)
        // The exact milliseconds, as the server counts them.
        #expect(turn.serverMillis.map { $0 % 1000 } == 345)
        guard case .toolUse(let id, let name, let input, _) = turn.blocks[1] else {
            Issue.record("the second block is a tool use")
            return
        }
        #expect(id == "toolu_77")
        #expect(name == "Bash")
        #expect(input == "npm test")
    }

    @Test func pendingItems() throws {
        guard case .items(let items) = try Inbound.parse(Fixtures.line("to-helper.items")) else { return }
        #expect(items.count == 2)
        #expect(items[0].source == "permission")
        #expect(items[0].options.map(\.id) == ["allow", "deny"])
        #expect(items[1].question?.header == "Runner")
        #expect(items[1].remindersSent == 1)
        // One odd record doesn't cost the rest.
        let line = #"{"type":"items","items":[{"id":"x"},"#
            + (try Fixtures.line("to-helper.items")).components(separatedBy: #""items":["#)[1]
        guard case .items(let lenient) = try Inbound.parse(line) else { return }
        #expect(lenient.map(\.id) == items.map(\.id))
    }

    @Test func responses() throws {
        guard case .res(let spoken) = try Inbound.parse(Fixtures.line("to-helper.res.sendSpoken")) else { return }
        #expect(spoken.id == 3)
        #expect(spoken.ok)
        #expect(spoken.value?.string == "insert")
        guard case .res(let answer) = try Inbound.parse(Fixtures.line("to-helper.res.answer")) else { return }
        #expect(answer.succeeded)
        guard case .res(let settings) = try Inbound.parse(Fixtures.line("to-helper.res.fetchSettings")) else { return }
        #expect(settings.value?.object?["language"]?.string == "he")
        guard case .res(let failed) = try Inbound.parse(Fixtures.line("to-helper.res.error")) else { return }
        #expect(!failed.succeeded)
        #expect(failed.error == "no permission request is pending")
        #expect(!WireResponse(id: 1, ok: true, value: .bool(false), error: nil).succeeded)
    }

    @Test func controls() throws {
        let expected: [String: WireControl] = [
            "toggleMute": WireControl(op: .toggleMute),
            "softMute": WireControl(op: .softMute, value: true),
            "skip": WireControl(op: .skip),
            "tapOrb": WireControl(op: .tapOrb),
            "press": WireControl(op: .press, down: true),
            "cancelPress": WireControl(op: .cancelPress),
            "choose": WireControl(op: .choose, choiceId: "allow"),
            "reportCutOff": WireControl(op: .reportCutOff),
            "setHandsFree": WireControl(op: .setHandsFree, value: false),
            "repeatLast": WireControl(op: .repeatLast),
        ]
        for (op, control) in expected {
            guard case .control(let decoded) = try Inbound.parse(Fixtures.line("to-helper.control.\(op)")) else {
                Issue.record("control.\(op)")
                continue
            }
            #expect(decoded == control)
        }
        #expect(throws: WireError.self) { try Inbound.parse(#"{"type":"control","op":"dance"}"#) }
    }

    @Test func settingsPrefsAndEnd() throws {
        guard case .settings(let settings) = try Inbound.parse(Fixtures.line("to-helper.settings")) else { return }
        #expect(settings == TalkSettings(language: .english, address: .auto))
        guard case .prefs(let prefs) = try Inbound.parse(Fixtures.line("to-helper.prefs")) else { return }
        #expect(prefs == WirePrefs(handsFree: false, interruptBySpeaking: false))
        guard case .end = try Inbound.parse(Fixtures.line("to-helper.end")) else {
            Issue.record("end")
            return
        }
    }

    @Test func badLines() {
        #expect(throws: WireError.unknownType("startt")) { try Inbound.parse(#"{"type":"startt"}"#) }
        #expect(throws: WireError.self) { try Inbound.parse("not json") }
        #expect(throws: WireError.self) { try Inbound.parse(#"{"no":"type"}"#) }
        #expect(throws: WireError.missingField("turnId")) { try Inbound.parse(#"{"type":"live","text":"x","streaming":true}"#) }
    }

    // MARK: - Helper → window

    static func outbound(_ name: String) -> Outbound? {
        let permission = WireAsk(
            id: "permission:perm-7", kind: "permission", prompt: "אני רוצה להריץ rm -rf build. לאשר?",
            choices: [WireChoice(id: "allow", label: "Allow"), WireChoice(id: "always", label: "Always allow"),
                      WireChoice(id: "deny", label: "Reject")],
            multiSelect: false, acceptsOwnWords: false, isSecret: false, answerableByVoice: true)
        let base = WireState(status: "listening", pauseReason: nil, error: nil, title: "Fix the flaky build",
                             heard: "", heardFinal: false, spoken: [], current: nil, ask: nil, mute: "none",
                             handsFree: true, backgroundOutstanding: 0, awaitingBackground: false, fastMode: false,
                             naturalVoice: true, canReportCutOff: false, route: "builtIn", echo: "voiceProcessing",
                             speaksHebrew: true, mic: "granted", suggestHeadphones: false)
        func item(_ id: String, _ request: String) -> WireItemRef {
            WireItemRef(itemId: id, connectionId: "conn-9", requestId: request, conversationId: 57)
        }
        switch name {
        case "to-window.hello": return .hello(mic: "granted")
        case "to-window.state.listening":
            var s = base
            s.heard = "תבדוק למה הבילד נופל"
            s.heardFinal = true
            s.spoken = [WireSpokenLine(id: "42:7#0", text: "בדקתי את הלוגים של ה-CI."),
                        WireSpokenLine(id: "42:7#1", text: "הבדיקות של ה-API נופלות כי חסר משתנה סביבה.")]
            s.canReportCutOff = true
            return .state(s)
        case "to-window.state.asking":
            var s = base
            s.status = "asking"
            s.spoken = [WireSpokenLine(id: "ask:permission:perm-7:0:0", text: permission.prompt)]
            s.current = "ask:permission:perm-7:0:0"
            s.ask = permission
            s.route = "wired"
            s.echo = "none"
            return .state(s)
        case "to-window.state.failed":
            var s = base
            s.status = "failed"
            s.error = TalkStartError.microphoneOffText
            s.mic = "denied"
            return .state(s)
        case "to-window.level": return .level(input: 0.42, output: 0)
        case "to-window.req.sendSpoken":
            return .req(WireRequest(id: 3, op: .sendSpoken(text: "תוסיף את המשתנה ל-staging ותריץ שוב")))
        case "to-window.req.respondPermission":
            return .req(WireRequest(id: 4, op: .respondPermission(requestId: "perm-7", optionId: "allow")))
        case "to-window.req.answerQuestion":
            return .req(WireRequest(id: 7, op: .answerQuestion(questionId: "q-3", answer: QuestionAnswer(
                answers: [QuestionAnswerItem(questionId: "1b7c", labels: ["staging"])], declined: false))))
        case "to-window.req.declineQuestion":
            return .req(WireRequest(id: 8, op: .declineQuestion(questionId: "q-3")))
        case "to-window.req.answerPlanApproval":
            return .req(WireRequest(id: 9, op: .answerPlanApproval(approvalId: "plan-2", decision: .requestChanges,
                                                                   feedback: "Run the tests first")))
        case "to-window.req.setTalkMode": return .req(WireRequest(id: 1, op: .setTalkMode(enabled: true)))
        case "to-window.req.fetchSettings": return .req(WireRequest(id: 2, op: .fetchSettings))
        case "to-window.req.respondItem":
            return .req(WireRequest(id: 10, op: .respondItem(item: item("permission:conn-9:perm-11", "perm-11"),
                                                             optionId: "allow")))
        case "to-window.req.answerItem":
            return .req(WireRequest(id: 11, op: .answerItem(item: item("question:conn-9:q-12", "q-12"), answer: QuestionAnswer(
                answers: [QuestionAnswerItem(questionId: "c41d", labels: ["vitest"])], declined: false))))
        case "to-window.req.answerItemPlan":
            return .req(WireRequest(id: 12, op: .answerItemPlan(item: item("plan:conn-9:plan-4", "plan-4"),
                                                                decision: .approve, feedback: nil)))
        case "to-window.req.uploadReport":
            guard let data = try? Fixtures.data(name),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let report = object["report"] else { return nil }
            return .req(WireRequest(id: 13, op: .uploadReport(report: AnyJSON(any: report))))
        case "to-window.cmd.cancel": return .cmd(op: "cancel")
        case "to-window.flags": return .flags(keepsStreamAttached: true, isTalking: true, holdSession: true)
        case "to-window.ended": return .ended(reason: "ended", error: nil)
        case "to-window.ended.failed":
            return .ended(reason: "failed", error: "Talk's live transcription didn't load. Delete its model in Settings › Talk and download it again.")
        case "to-window.error": return .error(message: "unknown message type startt")
        default: return nil
        }
    }

    @Test func helperMessagesMatchTheFixtures() throws {
        for name in Fixtures.names where name.hasPrefix("to-window.") {
            let message = try #require(Self.outbound(name), "no encoder case for \(name)")
            let line = message.line()
            #expect(line.last == 0x0A)
            #expect(!line.dropLast().contains(0x0A), "\(name) is one line")
            let encoded = try #require(JSONSerialization.jsonObject(with: line) as? NSDictionary)
            #expect(encoded == (try Fixtures.object(name)), "\(name)")
        }
    }
}

extension TalkStartError {
    /// The failed state's fixture text.
    static let microphoneOffText =
        "Microphone access is off for codeg. Turn it on in System Settings › Privacy & Security › Microphone."
}
