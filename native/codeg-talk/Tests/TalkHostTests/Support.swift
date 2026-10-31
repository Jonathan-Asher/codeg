@testable import TalkCore
@testable import TalkHost
import Foundation
import Testing

/// The protocol fixtures (fixtures/protocol/*.json), read from the source tree.
enum Fixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("fixtures/protocol")

    static var names: [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
            .filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent("\(name).json"))
    }

    /// The fixture as one wire line (the files are pretty-printed).
    static func line(_ name: String) throws -> String {
        let object = try JSONSerialization.jsonObject(with: data(name))
        let compact = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: compact, as: UTF8.self)
    }

    static func object(_ name: String) throws -> NSDictionary {
        try #require(JSONSerialization.jsonObject(with: data(name)) as? NSDictionary)
    }
}

/// Everything the helper sent.
@MainActor
final class RecordingSink: WireSink {
    private(set) var messages: [Outbound] = []

    func send(_ message: Outbound) {
        messages.append(message)
    }

    /// The JSON objects, as they went on the wire.
    var objects: [NSDictionary] {
        messages.compactMap { message in
            let line = message.line()
            return (try? JSONSerialization.jsonObject(with: line)) as? NSDictionary
        }
    }

    var types: [String] { objects.compactMap { $0["type"] as? String } }

    func requests(_ op: String? = nil) -> [NSDictionary] {
        objects.filter { $0["type"] as? String == "req" && (op == nil || $0["op"] as? String == op) }
    }

    func clear() {
        messages = []
    }
}

/// What the controller is told, in order.
@MainActor
final class RecordingObserver: SessionTalkObserver {
    enum Call: Equatable {
        case live(String, String, Bool)
        case turnEnded(String, String?)
        case awaiting(Bool)
        case background([String])
        case pending
    }

    private(set) var calls: [Call] = []

    func talkLiveText(turnID: String, text: String, isStreaming: Bool) {
        calls.append(.live(turnID, text, isStreaming))
    }

    func talkTurnEnded(turnID: String, stopReason: String?) {
        calls.append(.turnEnded(turnID, stopReason))
    }

    func talkAwaitingBackground(_ awaiting: Bool) {
        calls.append(.awaiting(awaiting))
    }

    func talkBackgroundTurns(_ turns: [MessageTurn]) {
        calls.append(.background(turns.map(\.id)))
    }

    func talkPendingChanged() {
        calls.append(.pending)
    }

    func clear() {
        calls = []
    }
}

/// Answers the newest request `op` with `res`.
@MainActor
func answer(_ sink: RecordingSink, _ requests: WireRequests, op: String, ok: Bool = true, value: AnyJSON? = nil,
            error: String? = nil) throws {
    let request = try #require(sink.requests(op).last)
    let id = try #require(request["id"] as? Int)
    requests.resolve(WireResponse(id: id, ok: ok, value: value, error: error))
}

/// Let the main actor run what was scheduled.
@MainActor
func settle(_ rounds: Int = 20) async {
    for _ in 0..<rounds { await Task.yield() }
}

/// Wait until `condition` holds (up to `timeout`).
@MainActor
func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { return false }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return true
}
