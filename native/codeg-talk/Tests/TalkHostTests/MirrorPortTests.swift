@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

/// The mirror tells the controller what changed exactly as the iPhone's
/// session model does.
@MainActor
struct MirrorPortTests {
    let sink = RecordingSink()
    let observer = RecordingObserver()

    func port(_ snapshot: PortSnapshot = PortSnapshot(), live: WireLive? = nil) -> MirrorPort {
        MirrorPort(conversationID: 42, snapshot: snapshot, live: live,
                   requests: WireRequests(sink: sink, timeout: 1), flags: WireFlags(sink: sink), sink: sink)
    }

    static func permission(_ id: String, options: [String] = ["allow", "deny"]) -> PendingPermission {
        PendingPermission(requestId: id, toolCall: .object(["title": .string("Run")]),
                          options: options.map { PermissionOption(optionId: $0, name: $0, kind: "allow_once") })
    }

    static func question(_ id: String) -> PendingQuestion {
        PendingQuestion(questionId: id, questions: [])
    }

    @Test func settingTheObserverReplaysLiveTextThenHoldThenCards() {
        var snapshot = PortSnapshot()
        snapshot.awaitingBackground = true
        snapshot.pendingPermission = Self.permission("p1")
        let port = port(snapshot, live: WireLive(turnId: "t1", text: "שלום", streaming: true))
        port.talkObserver = observer
        #expect(observer.calls == [.live("t1", "שלום", true), .awaiting(true), .pending])
    }

    @Test func withoutALiveTurnTheReplayIsHoldAndCards() {
        let port = port()
        port.talkObserver = observer
        #expect(observer.calls == [.awaiting(false), .pending])
    }

    @Test func settingTheSameObserverAgainReplaysNothing() {
        let port = port(live: WireLive(turnId: "t1", text: "a", streaming: true))
        port.talkObserver = observer
        observer.clear()
        port.talkObserver = observer
        #expect(observer.calls.isEmpty)
    }

    @Test func aNewObserverStartsTheDedupAfresh() {
        let port = port(live: WireLive(turnId: "t1", text: "a", streaming: true))
        port.talkObserver = observer
        let second = RecordingObserver()
        port.talkObserver = second
        #expect(second.calls == [.live("t1", "a", true), .awaiting(false), .pending])
        port.talkObserver = nil
        port.setLive(WireLive(turnId: "t1", text: "ab", streaming: true))
        #expect(second.calls.count == 3)
    }

    @Test func liveTextIsSentOnlyWhenItChanged() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.setLive(WireLive(turnId: "t1", text: "a", streaming: true))
        port.setLive(WireLive(turnId: "t1", text: "a", streaming: true))
        port.setLive(WireLive(turnId: "t1", text: "ab", streaming: true))
        port.setLive(WireLive(turnId: "t1", text: "ab", streaming: false))
        #expect(observer.calls == [.live("t1", "a", true), .live("t1", "ab", true), .live("t1", "ab", false)])
    }

    @Test func aTurnEndsOnceAfterItsFinalText() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.setLive(WireLive(turnId: "t1", text: "done", streaming: true))
        port.turnEnded(turnID: "t1", stopReason: "end_turn")
        port.turnEnded(turnID: "t1", stopReason: "end_turn")
        #expect(observer.calls == [.live("t1", "done", true), .live("t1", "done", false),
                                   .turnEnded("t1", "end_turn")])
    }

    @Test func aTurnEndAfterItsFinalTextSendsNoTextAgain() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.setLive(WireLive(turnId: "t1", text: "done", streaming: false))
        port.turnEnded(turnID: "t1", stopReason: nil)
        #expect(observer.calls == [.live("t1", "done", false), .turnEnded("t1", nil)])
    }

    @Test func anotherTurnsEndSendsNoLiveText() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.setLive(WireLive(turnId: "t2", text: "next", streaming: true))
        port.turnEnded(turnID: "t1", stopReason: "cancelled")
        #expect(observer.calls == [.live("t2", "next", true), .turnEnded("t1", "cancelled")])
    }

    @Test func cardsAreToldOnlyWhenAnIDChanges() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        var change = PortChange()
        change.pendingPermission = .set(Self.permission("p1"))
        port.apply(change)
        #expect(observer.calls == [.pending])

        // The same card again (its options changed): nothing new to ask.
        change.pendingPermission = .set(Self.permission("p1", options: ["allow"]))
        port.apply(change)
        #expect(observer.calls == [.pending])
        #expect(port.pendingPermission?.options.map(\.optionId) == ["allow"])

        // Other fields: nothing.
        var other = PortChange()
        other.isInFlight = true
        other.canInsertIntoTurn = true
        other.backgroundOutstanding = 3
        other.title = .set("New name")
        port.apply(other)
        #expect(observer.calls == [.pending])
        #expect(port.isInFlight && port.canInsertIntoTurn)
        #expect(port.backgroundOutstanding == 3)
        #expect(port.talkTitle == "New name")

        // A question arrives, the permission goes: one signal for the message.
        var swap = PortChange()
        swap.pendingPermission = .set(nil)
        swap.pendingQuestion = .set(Self.question("q1"))
        port.apply(swap)
        #expect(observer.calls == [.pending, .pending])
        #expect(port.pendingPermission == nil)
        #expect(port.pendingQuestion?.questionId == "q1")

        // Absent fields stay.
        port.apply(PortChange())
        #expect(port.pendingQuestion?.questionId == "q1")
        #expect(observer.calls.count == 2)
    }

    @Test func theHoldIsToldWhenItFlips() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.setAwaitingBackground(false)
        port.setAwaitingBackground(true)
        port.setAwaitingBackground(true)
        var change = PortChange()
        change.awaitingBackground = false
        port.apply(change)
        #expect(observer.calls == [.awaiting(true), .awaiting(false)])
    }

    @Test func backgroundTurnsPassThrough() {
        let port = port()
        port.talkObserver = observer
        observer.clear()
        port.backgroundTurns([])
        port.backgroundTurns([MessageTurn(id: "b1", role: .assistant, blocks: [.text("x")], timestamp: Date())])
        #expect(observer.calls == [.background(["b1"])])
    }

    @Test func flagsGoOutWhenTheyChange() {
        let port = port()
        port.keepsStreamAttached = true
        port.keepsStreamAttached = true
        port.isTalking = true
        port.isTalking = false
        #expect(sink.objects.map { [$0["keepsStreamAttached"] as? Bool, $0["isTalking"] as? Bool] }
            == [[true, false], [true, true], [true, false]])
        #expect(port.keepsStreamAttached)
        #expect(!port.isTalking)
    }

    @Test func cancelIsACommand() {
        port().cancel()
        #expect(sink.objects == [["type": "cmd", "op": "cancel"]])
    }
}
