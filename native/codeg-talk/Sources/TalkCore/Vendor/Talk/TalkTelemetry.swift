import Foundation

/// What one Talk records for tuning: per utterance, the stage timings (end
/// of speech → commit → final text → sent → first token → first audio), the
/// end-of-turn trace and which transcript won; for the whole Talk, echo and
/// barge-in counts per route, memory and thermal state, and what went wrong.
/// Text only (what was heard and said), never audio. Sent at the end as
/// `talk_lab` reports (``reports(app:device:maxBytes:storedLimit:)``), each
/// under the server's 1 MiB as the server stores it.
///
/// Times are seconds since Talk started.
struct TalkTelemetry: Sendable {
    struct Pause: Codable, Equatable, Sendable {
        var at: Double
        var speechEnd: Double
        var dangling: Bool
        var smartTurn: Float?
        var resumed: Bool
    }

    struct Utterance: Codable, Equatable, Sendable {
        var id: Int
        /// `speech`, `bargeIn` or `pushToTalk`.
        var start: String
        var route: String
        var echo: String
        var inBackground: Bool
        var whisperLoaded: Bool
        var began: Double
        var speechEnd: Double?
        var committed: Double?
        var commitReason: String?
        var discarded: Bool = false
        var pauses: [Pause] = []
        var smartTurnWouldCommit: Bool?
        var liveText: String?
        var liveAt: Double?
        var finalText: String?
        var finalAt: Double?
        var finalStarted: Double?
        var finalFailed: Bool = false
        /// The text used, and from which transcriber (`final` or `live`).
        var text: String?
        var source: String?
        var decided: Double?
        /// What the router made of it (`sendSpoken`, `respondPermission`, …).
        var action: String?
        /// Where a spoken message went (`prompt`, `insert`, `queued`).
        var sentRoute: String?
        var sent: Double?
        var firstToken: Double?
        var firstAudio: Double?
        /// The person said Talk cut them off.
        var cutOff: Bool = false
    }

    /// Echo and barge-in per route (`builtIn`, `bluetoothHFP`, …).
    struct RouteCounts: Codable, Equatable, Sendable {
        var echo = ""
        var speechSeconds: Double = 0
        /// Voice onsets (VAD ≥ 0.5 for two frames) heard while Talk spoke.
        var voiceOnsetsWhileSpeaking = 0
        var bargeInCandidates = 0
        var bargeInConfirmed = 0
        var bargeInRejected = 0
        /// Speech starts held back by the gate after the speech.
        var gatedStarts = 0
    }

    struct Sample: Codable, Equatable, Sendable {
        var at: Double
        var availableMB: Int
        var thermal: String
        var note: String?
    }

    struct Event: Codable, Equatable, Sendable {
        var at: Double
        var name: String
        var detail: String?
    }

    struct Settings: Codable, Equatable, Sendable {
        var handsFree: Bool
        var patience: String
        var interruptBySpeaking: Bool
        var smartTurn: String
        var echoSetting: String
        var naturalVoice: Bool
        var language: String?
        var address: String?
    }

    struct Body: Codable, Equatable, Sendable {
        var talkID: String
        var conversationID: Int
        var startedAt: String
        var seconds: Double
        var settings: Settings
        var utterances: [Utterance]
        var routes: [String: RouteCounts]
        var memory: [Sample]
        var events: [Event]
        var synthesisFirstAudio: [Double]
        var memoryWarnings: Int
        var part: Int
        var parts: Int
    }

    let talkID: String
    let conversationID: Int
    let startedAt: Date
    private let origin: TimeInterval
    var settings: Settings
    private(set) var utterances: [Utterance] = []
    private(set) var routes: [String: RouteCounts] = [:]
    private(set) var memory: [Sample] = []
    private(set) var events: [Event] = []
    private(set) var synthesisFirstAudio: [Double] = []
    private(set) var memoryWarnings = 0
    private(set) var ended: Double?

    /// At most this many events and samples are kept (the newest go).
    static let maxEvents = 400
    static let maxSamples = 200
    static let maxUtterances = 400

    init(talkID: String = UUID().uuidString.lowercased(), conversationID: Int, startedAt: Date = Date(),
         origin: TimeInterval, settings: Settings) {
        self.talkID = talkID
        self.conversationID = conversationID
        self.startedAt = startedAt
        self.origin = origin
        self.settings = settings
    }

    func time(_ clock: TimeInterval) -> Double {
        Self.relative(clock, origin: origin)
    }

    static func relative(_ clock: TimeInterval, origin: TimeInterval) -> Double {
        ((clock - origin) * 1000).rounded() / 1000
    }

    // MARK: - Recording

    mutating func event(_ name: String, _ detail: String? = nil, at clock: TimeInterval) {
        guard events.count < Self.maxEvents else { return }
        events.append(Event(at: time(clock), name: name, detail: detail))
    }

    mutating func sample(availableMemory: UInt64, thermal: String, note: String? = nil, at clock: TimeInterval) {
        guard memory.count < Self.maxSamples else { return }
        memory.append(Sample(at: time(clock), availableMB: Int(availableMemory / 1_048_576), thermal: thermal, note: note))
    }

    mutating func memoryWarning(at clock: TimeInterval) {
        memoryWarnings += 1
        event("memory_warning", "\(memoryWarnings)", at: clock)
    }

    mutating func firstAudio(latency: TimeInterval) {
        guard synthesisFirstAudio.count < Self.maxSamples else { return }
        synthesisFirstAudio.append((latency * 1000).rounded() / 1000)
    }

    mutating func route(_ route: String, echo: String, _ change: (inout RouteCounts) -> Void) {
        var counts = routes[route] ?? RouteCounts()
        counts.echo = echo
        change(&counts)
        routes[route] = counts
    }

    mutating func began(id: Int, start: TalkUtteranceStart, route: String, echo: String, inBackground: Bool,
                        whisperLoaded: Bool, at clock: TimeInterval) {
        guard utterances.count < Self.maxUtterances else { return }
        utterances.append(Utterance(id: id, start: Self.name(start), route: route, echo: echo,
                                    inBackground: inBackground, whisperLoaded: whisperLoaded, began: time(clock)))
    }

    /// Change the record of utterance `id`.
    mutating func update(_ id: Int, _ change: (inout Utterance) -> Void) {
        guard let index = utterances.lastIndex(where: { $0.id == id }) else { return }
        change(&utterances[index])
    }

    /// The end-of-turn trace of utterance `id`.
    mutating func trace(_ id: Int, _ trace: EndOfTurnTrace) {
        let origin = self.origin
        let pauses = trace.pauses.map {
            Pause(at: Self.relative($0.at, origin: origin), speechEnd: Self.relative($0.speechEnd, origin: origin),
                  dangling: $0.dangling, smartTurn: $0.smartTurn, resumed: $0.resumed)
        }
        let speechEnd = trace.pauses.last(where: { !$0.resumed }).map { Self.relative($0.speechEnd, origin: origin) }
        update(id) { record in
            record.pauses = pauses
            record.commitReason = trace.commitReason?.rawValue ?? record.commitReason
            record.discarded = trace.discarded
            record.smartTurnWouldCommit = trace.smartTurnWouldCommit
            if let speechEnd { record.speechEnd = speechEnd }
        }
    }

    /// The person said the last decided utterance was cut off.
    mutating func cutOff() -> Int? {
        guard let index = utterances.lastIndex(where: { $0.decided != nil }) else { return nil }
        utterances[index].cutOff = true
        return utterances[index].id
    }

    /// The latest utterance waiting for its first token or first audio.
    mutating func reply(firstToken clock: TimeInterval) {
        guard let index = utterances.lastIndex(where: { $0.sent != nil }), utterances[index].firstToken == nil else {
            return
        }
        utterances[index].firstToken = time(clock)
    }

    mutating func reply(firstAudio clock: TimeInterval) {
        guard let index = utterances.lastIndex(where: { $0.sent != nil }), utterances[index].firstAudio == nil else {
            return
        }
        utterances[index].firstAudio = time(clock)
    }

    mutating func end(at clock: TimeInterval) {
        ended = time(clock)
    }

    static func name(_ start: TalkUtteranceStart) -> String {
        switch start {
        case .speech: "speech"
        case .bargeIn: "bargeIn"
        case .pushToTalk: "pushToTalk"
        }
    }

    // MARK: - Reports

    /// The `talk_lab` reports: the Talk's record, its utterances split over
    /// as many parts as keep each report's JSON under `maxBytes`, and what
    /// the server stores of it under `storedLimit` (see ``storedSize(of:)``).
    func reports(app: [String: String], device: [String: String], maxBytes: Int = 600 * 1024,
                 storedLimit: Int = Self.storedLimit) -> [Data] {
        let encoder = JSONEncoder()
        let sizes = utterances.map { (try? encoder.encode($0).count) ?? 4096 }
        // The first part also carries the routes, memory and events.
        let firstOverhead = encode(parts: [[]], app: app, device: device, index: 0, count: 1)?.count ?? 0
        let overhead = encode(parts: [[], []], app: app, device: device, index: 1, count: 2)?.count ?? 0
        var parts: [[Utterance]] = [[]]
        var used = firstOverhead
        for (utterance, size) in zip(utterances, sizes) {
            if used + size + 1 > maxBytes, !parts[parts.count - 1].isEmpty {
                parts.append([])
                used = overhead
            }
            parts[parts.count - 1].append(utterance)
            used += size + 1
        }
        // A part the server would store over its limit is halved until it
        // fits (or is down to one utterance).
        var fitted: [[Utterance]] = []
        var waiting = parts
        while !waiting.isEmpty {
            let part = waiting.removeFirst()
            if part.count > 1,
               let data = encode(parts: fitted + [part] + waiting, app: app, device: device, index: fitted.count,
                                 count: fitted.count + 1 + waiting.count),
               Self.storedSize(of: data) > storedLimit {
                let half = part.count / 2
                waiting.insert(contentsOf: [Array(part[..<half]), Array(part[half...])], at: 0)
                continue
            }
            fitted.append(part)
        }
        return fitted.indices.compactMap { encode(parts: fitted, app: app, device: device, index: $0, count: fitted.count) }
    }

    /// The most the server stores of one report: it refuses one over 1 MiB,
    /// less room for the part numbers, which grow as parts split.
    static let storedLimit = 1_048_576 - 8_192

    /// The size of the copy the server stores of `report` (codeg's
    /// `report_client_diagnostic`): `serde_json`'s pretty printing of
    /// `{"receivedAtMs": <13 digits>, "report": <report>}`, which it holds to
    /// 1 MiB. Up to about twice the compact JSON sent: every value in a
    /// non-empty array or object goes on a line of its own, indented two
    /// spaces a level, and every key gets a space after its colon. Counted
    /// from the compact JSON, so `\/` (one byte longer than the `/` the
    /// server writes) errs on the large side.
    static func storedSize(of report: Data) -> Int {
        let space = UInt8(ascii: " "), newline = UInt8(ascii: "\n"), tab = UInt8(ascii: "\t"),
            carriageReturn = UInt8(ascii: "\r")
        // `{\n  "receivedAtMs": 1761955200000,\n  "report": ` and `\n}`.
        var size = 49 + report.count
        // One entry per open array or object: whether it has a value yet.
        var open: [Bool] = []
        var inString = false
        var escaped = false
        var opening = false
        for byte in report {
            if inString {
                if escaped {
                    escaped = false
                } else if byte == UInt8(ascii: "\\") {
                    escaped = true
                } else if byte == UInt8(ascii: "\"") {
                    inString = false
                }
                continue
            }
            if byte == space || byte == newline || byte == tab || byte == carriageReturn {
                size -= 1
                continue
            }
            // The report sits one level inside the envelope, so a value in a
            // container opened at depth d (1 for the report) is indented d + 1
            // levels, and its closing bracket d.
            let depth = open.count
            if opening {
                opening = false
                if byte != UInt8(ascii: "]") && byte != UInt8(ascii: "}") {
                    open[depth - 1] = true
                    size += 1 + 2 * (depth + 1)
                }
            }
            switch byte {
            case UInt8(ascii: "\""):
                inString = true
            case UInt8(ascii: "{"), UInt8(ascii: "["):
                open.append(false)
                opening = true
            case UInt8(ascii: "}"), UInt8(ascii: "]"):
                if open.popLast() == true { size += 1 + 2 * depth }
            case UInt8(ascii: ","):
                size += 1 + 2 * (depth + 1)
            case UInt8(ascii: ":"):
                size += 1
            default:
                break
            }
        }
        return size
    }

    private func encode(parts: [[Utterance]], app: [String: String], device: [String: String], index: Int,
                        count: Int) -> Data? {
        let first = index == 0
        let body = Body(talkID: talkID, conversationID: conversationID,
                        startedAt: ISO8601DateFormatter().string(from: startedAt),
                        seconds: ended ?? 0, settings: settings, utterances: parts[index],
                        routes: first ? routes : [:], memory: first ? memory : [], events: first ? events : [],
                        synthesisFirstAudio: first ? synthesisFirstAudio : [], memoryWarnings: memoryWarnings,
                        part: index + 1, parts: count)
        let report = Report(id: "talk-\(talkID.prefix(36))-\(index + 1)", createdAt: ISO8601DateFormatter().string(from: Date()),
                            app: app, device: device,
                            summary: Report.Summary(context: "Talk \(Int(ended ?? 0)) s, \(utterances.count) utterances, part \(index + 1) of \(count)"),
                            talk: body)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(report)
    }

    /// The report around the record, shaped like the app's crash reports so
    /// the server's list shows it.
    private struct Report: Encodable {
        struct Summary: Encodable {
            var context: String
        }

        var schema = 1
        var id: String
        var kind = "talk_lab"
        var source = "talk"
        var createdAt: String
        var app: [String: String]
        var device: [String: String]
        var summary: Summary
        var talk: Body
    }
}

/// The app and device a `talk_lab` report names, as the platform tells them
/// (``TalkSystem/reportEnvironment``; the iPhone's are in
/// TalkReportEnvironment+iOS.swift).
struct TalkReportEnvironment: Equatable, Sendable {
    /// `version`, `build` and `bundleId`.
    var app: [String: String]
    /// `model` and `os` (the system and its version).
    var device: [String: String]
}
