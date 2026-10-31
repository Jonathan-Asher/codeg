@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

/// Requests go out as `req`, come back as `res`, and fail after the timeout.
@MainActor
struct RequestTests {
    let sink = RecordingSink()

    @Test func sendSpokenTakesTheRouteFromTheAnswer() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let port = MirrorPort(conversationID: 42, snapshot: PortSnapshot(), live: nil, requests: requests,
                              flags: WireFlags(sink: sink), sink: sink)
        for (answer, route) in [("prompt", SpokenSendRoute.prompt), ("insert", .insert), ("queued", .queued)] {
            let task = Task { await port.sendSpoken("שלום") }
            await settle()
            let request = try #require(sink.requests("sendSpoken").last)
            #expect(request["text"] as? String == "שלום")
            requests.resolve(WireResponse(id: request["id"] as! Int, ok: true, value: .string(answer), error: nil))
            #expect(await task.value == route)
        }
        #expect(requests.pendingCount == 0)
    }

    @Test func requestIDsRiseAndLateAnswersAreIgnored() async throws {
        let requests = WireRequests(sink: sink, timeout: 0.05)
        let first = Task { await requests.request(.fetchSettings) }
        await settle()
        let second = Task { await requests.request(.setTalkMode(enabled: true)) }
        await settle()
        #expect(sink.requests().map { $0["id"] as? Int } == [1, 2])
        requests.resolve(WireResponse(id: 2, ok: true, value: nil, error: nil))
        #expect(await second.value?.ok == true)
        // The first gets no answer in time.
        #expect(await first.value == nil)
        requests.resolve(WireResponse(id: 1, ok: true, value: nil, error: nil))
        #expect(requests.pendingCount == 0)
    }

    @Test func aRequestWithoutAnAnswerFailsAfterTheTimeout() async {
        let requests = WireRequests(sink: sink, timeout: 0.1)
        let port = MirrorPort(conversationID: 42, snapshot: PortSnapshot(), live: nil, requests: requests,
                              flags: WireFlags(sink: sink), sink: sink)
        let start = Date()
        #expect(await port.sendSpoken("x") == .queued)
        #expect(await port.respondPermission(optionId: "allow") == false)
        #expect(Date().timeIntervalSince(start) >= 0.2)
        #expect(TalkWire.requestTimeout == 20)
    }

    @Test func closedRequestsFailAtOnce() async {
        let requests = WireRequests(sink: sink, timeout: 30)
        let waiting = Task { await requests.request(.fetchSettings) }
        await settle()
        requests.close()
        #expect(await waiting.value == nil)
        #expect(await requests.request(.fetchSettings) == nil)
        #expect(sink.requests().count == 1)
    }

    @Test func answersNameTheCardTheyAnswer() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        var snapshot = PortSnapshot()
        snapshot.pendingPermission = MirrorPortTests.permission("perm-7")
        snapshot.pendingQuestion = MirrorPortTests.question("q-3")
        snapshot.pendingPlanApproval = PendingPlanApproval(approvalId: "plan-2", toolCallId: "c", planMarkdown: "")
        let port = MirrorPort(conversationID: 42, snapshot: snapshot, live: nil, requests: requests,
                              flags: WireFlags(sink: sink), sink: sink)

        let permission = Task { await port.respondPermission(optionId: "allow") }
        await settle()
        #expect(sink.requests("respondPermission").last?["requestId"] as? String == "perm-7")
        try answer(sink, requests, op: "respondPermission", value: .bool(true))
        #expect(await permission.value)

        let question = Task { await port.answerQuestion(QuestionAnswer(
            answers: [QuestionAnswerItem(questionId: "1b7c", labels: ["staging"])], declined: false)) }
        await settle()
        let asked = try #require(sink.requests("answerQuestion").last)
        #expect(asked["questionId"] as? String == "q-3")
        #expect((asked["answer"] as? NSDictionary) == ["answers": [["questionId": "1b7c", "labels": ["staging"]]],
                                                       "declined": false])
        try answer(sink, requests, op: "answerQuestion", ok: false, error: "gone")
        #expect(await question.value == false)

        let decline = Task { await port.declineQuestion() }
        await settle()
        try answer(sink, requests, op: "declineQuestion")
        #expect(await decline.value)

        let plan = Task { await port.answerPlanApproval(decision: .abandon, feedback: nil) }
        await settle()
        let planRequest = try #require(sink.requests("answerPlanApproval").last)
        #expect(planRequest["approvalId"] as? String == "plan-2")
        #expect(planRequest["decision"] as? String == "abandon")
        #expect(planRequest["feedback"] is NSNull)
        try answer(sink, requests, op: "answerPlanApproval", value: .bool(false))
        #expect(await plan.value == false)
    }

    // MARK: - BridgeBackend

    func backend(_ requests: WireRequests, items: [PendingItem] = []) -> BridgeBackend {
        BridgeBackend(conversationID: 42, settings: TalkSettings(language: .auto, address: .feminine),
                      items: items, requests: requests, flags: WireFlags(sink: sink))
    }

    static func item(_ id: String, conversation: Int, root: Int) -> PendingItem {
        PendingItem(id: id, kind: "permission", source: "permission", conversationId: conversation,
                    rootConversationId: root, connectionId: "conn-\(conversation)", requestId: "r-\(id)",
                    askedAt: Date(), text: "Run", options: [PendingOption(id: "allow", label: "Allow")])
    }

    @Test func talkModeFailsWhenTheWindowRefusesOrIsSilent() async throws {
        let requests = WireRequests(sink: sink, timeout: 0.05)
        let backend = backend(requests)
        let refused = Task { try await backend.setTalkMode(conversationID: 42, enabled: true) }
        await settle()
        #expect(sink.requests("setTalkMode").last?["enabled"] as? Bool == true)
        try answer(sink, requests, op: "setTalkMode", ok: false, error: "offline")
        await #expect(throws: BridgeBackend.Failure.refused("setTalkMode", "offline")) { try await refused.value }
        await #expect(throws: BridgeBackend.Failure.noAnswer("setTalkMode")) {
            try await backend.setTalkMode(conversationID: 42, enabled: false)
        }
    }

    @Test func settingsAreFetchedAndKept() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let backend = backend(requests)
        #expect(backend.cachedSettings == TalkSettings(language: .auto, address: .feminine))
        let fetched = Task { await backend.fetchSettings() }
        await settle()
        try answer(sink, requests, op: "fetchSettings",
                   value: .object(["language": .string("he"), "address": .string("masculine")]))
        #expect(await fetched.value == TalkSettings(language: .hebrew, address: .masculine))
        #expect(backend.cachedSettings == TalkSettings(language: .hebrew, address: .masculine))
        let empty = Task { await backend.fetchSettings() }
        await settle()
        try answer(sink, requests, op: "fetchSettings", value: .null)
        #expect(await empty.value == nil)
        backend.updateSettings(TalkSettings(language: .english, address: .auto))
        #expect(backend.cachedSettings?.language == .english)
    }

    @Test func subAgentItemsAreThisConversationsTreeOnly() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let backend = backend(requests, items: [
            Self.item("own", conversation: 42, root: 42),
            Self.item("sub", conversation: 57, root: 42),
            Self.item("other", conversation: 9, root: 9),
        ])
        #expect(backend.subAgentItems.map(\.id) == ["sub"])
        var changed = 0
        backend.onItemsChanged = { changed += 1 }
        backend.setItems([Self.item("sub2", conversation: 58, root: 42)])
        #expect(changed == 1)
        #expect(backend.subAgentItems.map(\.id) == ["sub2"])

        let item = backend.subAgentItems[0]
        let respond = Task { try await backend.respond(item: item, optionId: "allow") }
        await settle()
        let request = try #require(sink.requests("respondItem").last)
        #expect((request["item"] as? NSDictionary) == ["itemId": "sub2", "connectionId": "conn-58",
                                                       "requestId": "r-sub2", "conversationId": 58])
        #expect(request["optionId"] as? String == "allow")
        try answer(sink, requests, op: "respondItem")
        try await respond.value

        let answerTask = Task { try await backend.answer(item: item, answer: .dismissed) }
        await settle()
        #expect((sink.requests("answerItem").last?["answer"] as? NSDictionary) == ["answers": [], "declined": true])
        try answer(sink, requests, op: "answerItem", ok: false)
        await #expect(throws: BridgeBackend.Failure.self) { try await answerTask.value }

        let plan = Task { try await backend.answerPlan(item: item, decision: .approve, feedback: "ok") }
        await settle()
        #expect(sink.requests("answerItemPlan").last?["decision"] as? String == "approve")
        try answer(sink, requests, op: "answerItemPlan")
        try await plan.value
    }

    @Test func reportsGoUpAsObjects() async throws {
        let requests = WireRequests(sink: sink, timeout: 5)
        let backend = backend(requests)
        let report = try JSONSerialization.data(withJSONObject: ["kind": "talk_lab", "talk": ["parts": 1]])
        let upload = Task { try await backend.upload(report: report) }
        await settle()
        #expect((sink.requests("uploadReport").last?["report"] as? NSDictionary)
            == ["kind": "talk_lab", "talk": ["parts": 1]])
        try answer(sink, requests, op: "uploadReport")
        try await upload.value
    }

    @Test func holdingTheSessionIsAFlag() {
        let backend = backend(WireRequests(sink: sink))
        backend.holdSession(true)
        backend.holdSession(true)
        backend.holdSession(false)
        #expect(sink.objects.map { $0["holdSession"] as? Bool } == [true, false])
    }
}
