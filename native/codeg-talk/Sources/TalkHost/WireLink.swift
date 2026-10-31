@testable import TalkCore
import Foundation

/// Where the helper's messages go (stdout in the helper, a recorder in the
/// tests). Called on the main actor.
@MainActor
protocol WireSink: AnyObject {
    func send(_ message: Outbound)
}

/// The helper's `req`s waiting for their `res`. A request that gets no
/// answer within ``TalkWire/requestTimeout`` (or is dropped by
/// ``failAll()``) completes with nil; an answer that comes later is ignored.
@MainActor
final class WireRequests {
    private let sink: WireSink
    private let timeout: TimeInterval
    private var nextID = 1
    private var waiting: [Int: CheckedContinuation<WireResponse?, Never>] = [:]
    private var timers: [Int: Task<Void, Never>] = [:]

    init(sink: WireSink, timeout: TimeInterval = TalkWire.requestTimeout) {
        self.sink = sink
        self.timeout = timeout
    }

    /// The window is gone (stdin closed): requests fail at once.
    private(set) var isClosed = false

    /// Requests sent and not yet answered.
    var pendingCount: Int { waiting.count }

    /// Send `op` and wait for its answer (nil: none in time).
    func request(_ op: WireRequest.Op) async -> WireResponse? {
        guard !isClosed else { return nil }
        let id = nextID
        nextID += 1
        return await withCheckedContinuation { continuation in
            waiting[id] = continuation
            let timeout = timeout
            timers[id] = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(timeout * 1000)))
                guard !Task.isCancelled else { return }
                if self?.waiting[id] != nil {
                    TalkLog.write("request \(id) (\(op.name)) got no answer in \(Int(timeout)) s")
                }
                self?.finish(id, with: nil)
            }
            sink.send(.req(WireRequest(id: id, op: op)))
        }
    }

    /// A `res` arrived.
    func resolve(_ response: WireResponse) {
        finish(response.id, with: response)
    }

    /// Complete every waiting request as unanswered.
    func failAll() {
        for id in waiting.keys.sorted() { finish(id, with: nil) }
    }

    /// No window to answer any more: fail what waits and what comes.
    func close() {
        isClosed = true
        failAll()
    }

    private func finish(_ id: Int, with response: WireResponse?) {
        timers.removeValue(forKey: id)?.cancel()
        guard let continuation = waiting.removeValue(forKey: id) else { return }
        continuation.resume(returning: response)
    }
}

/// What the window keeps up for Talk, sent as one `flags` message whenever
/// any of it changes.
@MainActor
final class WireFlags {
    private let sink: WireSink
    private var sent = (keepsStreamAttached: false, isTalking: false, holdSession: false)

    init(sink: WireSink) {
        self.sink = sink
    }

    var keepsStreamAttached = false { didSet { publish() } }
    var isTalking = false { didSet { publish() } }
    var holdSession = false { didSet { publish() } }
    /// A Talk another one replaced: what it lets go of is no longer the
    /// window's state.
    private var silenced = false

    func silence() {
        silenced = true
    }

    private func publish() {
        guard !silenced else { return }
        let now = (keepsStreamAttached: keepsStreamAttached, isTalking: isTalking, holdSession: holdSession)
        guard now != sent else { return }
        sent = now
        sink.send(.flags(keepsStreamAttached: now.keepsStreamAttached, isTalking: now.isTalking,
                         holdSession: now.holdSession))
    }
}

extension WireResponse {
    /// A yes/no answer: `ok`, and `value` unless it says false.
    var succeeded: Bool { ok && value?.bool != false }
}
