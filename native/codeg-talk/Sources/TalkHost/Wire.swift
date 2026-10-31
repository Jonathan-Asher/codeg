@testable import TalkCore
import Foundation

// The helper ↔ window protocol, version 1: one JSON object per line, UTF-8,
// on the helper's stdin (window → helper) and stdout (helper → window). Every
// message has a `type`. codeg's Rust side relays the lines between the helper
// and the window that owns the Talk, adding `models` to `start`.
//
// Envelope fields are camelCase. Values that are server records (a
// `MessageTurn`, a `PendingItem`, a pending permission, question or plan
// approval) travel exactly as the server sends them to the window, in its
// snake_case JSON; the helper reads them the way the iPhone does
// (`.convertFromSnakeCase`, lenient RFC 3339 dates). Both sides ignore
// unknown message types and unknown fields. The fixtures in
// fixtures/protocol/ hold one example of every message; README.md documents
// each field.

public enum TalkWire {
    /// The protocol version. A window that speaks another one doesn't start
    /// Talk (the helper says which in `hello`).
    public static let version = 1
    /// The helper's own version, for logs and the Talk reports.
    public static let helperVersion = "1.0.0"
    /// How long a `req` waits for its `res` before it counts as failed.
    public static let requestTimeout: TimeInterval = 20
    /// `state` at most 20 times a second.
    public static let stateInterval: TimeInterval = 0.05
    /// `level` 15 times a second while Talk runs.
    public static let levelInterval: TimeInterval = 1.0 / 15
}

// MARK: - Window → helper

/// The window's Talk preferences (codeg's settings, not the server's).
/// Missing fields take the iPhone's defaults.
struct WirePrefs: Codable, Equatable, Sendable {
    var handsFree: Bool?
    /// `short`, `normal` or `long`.
    var patience: String?
    var interruptBySpeaking: Bool?
    var speakProgress: Bool?
    var smartTurnActive: Bool?
    /// `automatic`, `voiceProcessing`, `off` (`echoCancelledInput` reads as
    /// `voiceProcessing` on the Mac).
    var echoMode: String?
    var shareTelemetry: Bool?
}

/// Read aloud's voice: BlueTTS voice name and speaking rate.
struct WireVoice: Codable, Equatable, Sendable {
    var name: String?
    var speed: Double?
}

/// The model files, added by codeg's Rust side (absolute paths). Missing
/// required ones make Talk fail to start with a message.
struct WireModels: Codable, Equatable, Sendable {
    struct Zipformer: Codable, Equatable, Sendable {
        var encoder: String
        var decoder: String
        var joiner: String
        var tokens: String
    }

    /// The streaming Zipformer (required).
    var zipformer: Zipformer?
    /// Silero VAD, ggml (required).
    var vad: String?
    /// Smart Turn v3.2 ONNX (required; Talk goes on without it if it fails).
    var smartTurn: String?
    /// whisper he-turbo ggml (optional: the more accurate final transcript).
    var whisper: String?
    /// whisper tiny for telling Hebrew from English (optional).
    var languageID: String?
    /// BlueTTS models in BlueTTSKit's layout (`bluetts/`, `renikud/`,
    /// `voices/`); nil: the system voices speak.
    var bluetts: String?
    /// espeak-ng's English data; nil: looked up next to the helper.
    var espeakData: String?
}

/// The live turn: its main-thread text so far (see `SessionTalkObserver`).
struct WireLive: Codable, Equatable, Sendable {
    var turnId: String
    var text: String
    var streaming: Bool
}

/// `start`: everything one Talk needs. The helper fills its session mirror
/// first, then starts the controller (which replays the mirror).
struct WireStart {
    var protocolVersion: Int
    var conversationID: Int
    var title: String?
    /// The session's workspace folder name (whisper's prompt).
    var folder: String?
    /// The server's Talk settings as last seen.
    var settings: TalkSettings?
    var prefs: WirePrefs
    var voice: WireVoice?
    var port: PortSnapshot
    var live: WireLive?
    var items: [PendingItem]
    var models: WireModels?
    /// codeg's version, build and bundle id, for the Talk reports.
    var app: [String: String]?
}

/// The session as the controller reads it through `TalkSessionPort`.
struct PortSnapshot {
    var title: String?
    var canInsertIntoTurn = false
    var isInFlight = false
    var awaitingBackground = false
    var backgroundOutstanding = 0
    var pendingPermission: PendingPermission?
    var pendingQuestion: PendingQuestion?
    var pendingPlanApproval: PendingPlanApproval?

    mutating func apply(_ change: PortChange) {
        if case .set(let value) = change.title { title = value }
        if let value = change.canInsertIntoTurn { canInsertIntoTurn = value }
        if let value = change.isInFlight { isInFlight = value }
        if let value = change.awaitingBackground { awaitingBackground = value }
        if let value = change.backgroundOutstanding { backgroundOutstanding = value }
        if case .set(let value) = change.pendingPermission { pendingPermission = value }
        if case .set(let value) = change.pendingQuestion { pendingQuestion = value }
        if case .set(let value) = change.pendingPlanApproval { pendingPlanApproval = value }
    }
}

/// A field of a `port` update: absent is unchanged; `null` clears a field
/// that can be empty.
enum WireChange<Value> {
    case unchanged
    case set(Value)
}

/// `port`: the fields that changed.
struct PortChange {
    var title: WireChange<String?> = .unchanged
    var canInsertIntoTurn: Bool?
    var isInFlight: Bool?
    var awaitingBackground: Bool?
    var backgroundOutstanding: Int?
    var pendingPermission: WireChange<PendingPermission?> = .unchanged
    var pendingQuestion: WireChange<PendingQuestion?> = .unchanged
    var pendingPlanApproval: WireChange<PendingPlanApproval?> = .unchanged
}

/// A `res`: the answer to a `req`.
struct WireResponse {
    var id: Int
    var ok: Bool
    var value: AnyJSON?
    var error: String?
}

/// `control`: the dock's buttons and the global shortcut.
struct WireControl: Equatable {
    enum Op: String, CaseIterable {
        /// The Mute button: the microphone stops until it is pressed again.
        case toggleMute
        /// Mute as an AirPods press does (`value`): Talk still listens here
        /// for "unmute" and "end", and sends nothing.
        case softMute
        /// Stop the speech and drop the rest of this reply.
        case skip
        /// Stop the speech and listen (a click on the orb).
        case tapOrb
        /// Push to talk: `down` true on press, false on release.
        case press
        /// A press was abandoned: drop what it heard.
        case cancelPress
        /// A choice button while Talk asks (`choiceId`).
        case choose
        /// "You cut me off".
        case reportCutOff
        /// Hands-free (`value` true) or hold to talk.
        case setHandsFree
        /// Say the last reply again.
        case repeatLast
    }

    var op: Op
    var value: Bool?
    var down: Bool?
    var choiceId: String?
}

enum Inbound {
    case start(WireStart)
    case port(PortChange)
    case live(WireLive)
    /// The turn ended: `stopReason` from the agent (`end_turn`, …),
    /// `cancelled`, `error`, or nil.
    case turnEnded(turnID: String, stopReason: String?)
    /// The turn is held open only for background work (true), or picked up
    /// again (false).
    case awaiting(Bool)
    /// Turns written outside a turn, upserted by id.
    case bgTurns([MessageTurn])
    /// The server's pending items (the helper keeps this conversation's
    /// sub-agents' ones).
    case items([PendingItem])
    case res(WireResponse)
    case control(WireControl)
    /// The server's Talk settings changed (they apply from the next Talk).
    case settings(TalkSettings)
    case prefs(WirePrefs)
    /// End the Talk.
    case end
}

enum WireError: Error, Equatable, CustomStringConvertible {
    case malformed(String)
    case unknownType(String)
    case missingField(String)
    case invalid(String)

    var description: String {
        switch self {
        case .malformed(let why): "malformed message: \(why)"
        case .unknownType(let type): "unknown message type \(type)"
        case .missingField(let name): "message is missing \(name)"
        case .invalid(let why): "invalid message: \(why)"
        }
    }
}

extension Inbound {
    /// The decoder for window messages: server records inside them are
    /// snake_case, as on the iPhone.
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let raw = try c.decode(String.self)
            if let date = WireDate.parse(raw) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unparseable date \(raw)")
        }
        return d
    }()

    /// Parse one line.
    static func parse(_ line: Data) throws -> Inbound {
        let type: String
        do {
            type = try decoder.decode(Envelope.self, from: line).type
        } catch {
            throw WireError.malformed(String(describing: error))
        }
        func decode<T: Decodable>(_: T.Type) throws -> T {
            do {
                return try decoder.decode(T.self, from: line)
            } catch let DecodingError.keyNotFound(key, _) {
                throw WireError.missingField(key.stringValue)
            } catch {
                throw WireError.invalid("\(type): \(error)")
            }
        }
        switch type {
        case "start": return .start(try decode(StartBody.self).start)
        case "port": return .port(try decode(PortChangeBody.self).change)
        case "live": return .live(try decode(WireLive.self))
        case "turnEnded":
            let body = try decode(TurnEndedBody.self)
            return .turnEnded(turnID: body.turnId, stopReason: body.stopReason)
        case "awaiting": return .awaiting(try decode(AwaitingBody.self).value)
        case "bgTurns": return .bgTurns(try decode(TurnsBody.self).turns)
        case "items": return .items(try decode(ItemsBody.self).items)
        case "res":
            let body = try decode(ResponseBody.self)
            return .res(WireResponse(id: body.id, ok: body.ok, value: body.value, error: body.error))
        case "control":
            let body = try decode(ControlBody.self)
            guard let op = WireControl.Op(rawValue: body.op) else { throw WireError.invalid("control op \(body.op)") }
            return .control(WireControl(op: op, value: body.value, down: body.down, choiceId: body.choiceId))
        case "settings": return .settings(try decode(SettingsBody.self).settings)
        case "prefs": return .prefs(try decode(PrefsBody.self).prefs)
        case "end": return .end
        default: throw WireError.unknownType(type)
        }
    }

    static func parse(_ line: String) throws -> Inbound {
        try parse(Data(line.utf8))
    }
}

// MARK: - Decoding the window's messages

private struct Envelope: Decodable {
    let type: String
}

/// A pending permission (the server's `PendingPermissionState`).
private struct WirePermission: Decodable {
    let requestId: String
    let toolCall: AnyJSON?
    let options: [PermissionOption]?

    var pending: PendingPermission {
        PendingPermission(requestId: requestId, toolCall: toolCall ?? .null, options: options ?? [])
    }
}

/// A pending question set (the server's `PendingQuestionState`).
private struct WireQuestion: Decodable {
    let questionId: String
    let questions: [QuestionSpec]

    var pending: PendingQuestion { PendingQuestion(questionId: questionId, questions: questions) }
}

/// A pending plan approval (the server's `PendingPlanApprovalState`).
private struct WirePlanApproval: Decodable {
    let approvalId: String
    let toolCallId: String?
    let planMarkdown: String?

    var pending: PendingPlanApproval {
        PendingPlanApproval(approvalId: approvalId, toolCallId: toolCallId ?? "", planMarkdown: planMarkdown ?? "")
    }
}

private enum PortKeys: String, CodingKey {
    case title, canInsertIntoTurn, isInFlight, awaitingBackground, backgroundOutstanding
    case pendingPermission, pendingQuestion, pendingPlanApproval
}

extension KeyedDecodingContainer where K == PortKeys {
    /// Absent: unchanged. `null`: cleared.
    fileprivate func change<T: Decodable, V>(_ type: T.Type, _ key: K, _ map: (T) -> V) throws -> WireChange<V?> {
        guard contains(key) else { return .unchanged }
        if try decodeNil(forKey: key) { return .set(nil) }
        return .set(map(try decode(T.self, forKey: key)))
    }

    fileprivate func flag<T: Decodable>(_ type: T.Type, _ key: K) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

private struct PortChangeBody: Decodable {
    let change: PortChange

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: PortKeys.self)
        var change = PortChange()
        change.title = try c.change(String.self, .title) { $0 }
        change.canInsertIntoTurn = c.flag(Bool.self, .canInsertIntoTurn)
        change.isInFlight = c.flag(Bool.self, .isInFlight)
        change.awaitingBackground = c.flag(Bool.self, .awaitingBackground)
        change.backgroundOutstanding = c.flag(Int.self, .backgroundOutstanding)
        change.pendingPermission = try c.change(WirePermission.self, .pendingPermission) { $0.pending }
        change.pendingQuestion = try c.change(WireQuestion.self, .pendingQuestion) { $0.pending }
        change.pendingPlanApproval = try c.change(WirePlanApproval.self, .pendingPlanApproval) { $0.pending }
        self.change = change
    }
}

private struct StartBody: Decodable {
    let start: WireStart

    private enum Keys: String, CodingKey {
        case `protocol`, conversationId, title, folder, settings, prefs, voice, port, live, items, models, app
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        var port = PortSnapshot()
        if c.contains(.port), try !c.decodeNil(forKey: .port) {
            port.apply(try c.decode(PortChangeBody.self, forKey: .port).change)
        }
        let title = try c.decodeIfPresent(String.self, forKey: .title)
        if port.title == nil { port.title = title }
        start = WireStart(
            protocolVersion: try c.decode(Int.self, forKey: .protocol),
            conversationID: try c.decode(Int.self, forKey: .conversationId),
            title: title,
            folder: try c.decodeIfPresent(String.self, forKey: .folder),
            settings: try c.decodeIfPresent(TalkSettings.self, forKey: .settings),
            prefs: try c.decodeIfPresent(WirePrefs.self, forKey: .prefs) ?? WirePrefs(),
            voice: try c.decodeIfPresent(WireVoice.self, forKey: .voice),
            port: port,
            live: try c.decodeIfPresent(WireLive.self, forKey: .live),
            items: try c.decodeIfPresent(LenientList<PendingItem>.self, forKey: .items)?.values ?? [],
            models: try c.decodeIfPresent(WireModels.self, forKey: .models),
            app: try c.decodeIfPresent([String: String].self, forKey: .app))
    }
}

private struct TurnEndedBody: Decodable {
    let turnId: String
    let stopReason: String?
}

private struct AwaitingBody: Decodable {
    let value: Bool
}

private struct TurnsBody: Decodable {
    let turns: [MessageTurn]

    private enum Keys: String, CodingKey { case turns }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        turns = try c.decode(LenientList<MessageTurn>.self, forKey: .turns).values
    }
}

private struct ItemsBody: Decodable {
    let items: [PendingItem]

    private enum Keys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        items = try c.decode(LenientList<PendingItem>.self, forKey: .items).values
    }
}

private struct ResponseBody: Decodable {
    let id: Int
    let ok: Bool
    let value: AnyJSON?
    let error: String?
}

private struct ControlBody: Decodable {
    let op: String
    let value: Bool?
    let down: Bool?
    let choiceId: String?
}

private struct SettingsBody: Decodable {
    let settings: TalkSettings
}

private struct PrefsBody: Decodable {
    let prefs: WirePrefs
}

/// A list whose elements that don't decode are skipped (one odd record must
/// not cost the rest).
struct LenientList<Element: Decodable>: Decodable {
    var values: [Element] = []

    private struct Skip: Decodable {
        init(from decoder: Decoder) {}
    }

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        while !c.isAtEnd {
            if let value = try? c.decode(Element.self) {
                values.append(value)
            } else {
                _ = try c.decode(Skip.self)
            }
        }
    }
}

/// Lenient RFC 3339 (any number of fraction digits, or none), as the
/// server's dates come.
enum WireDate {
    private static let lock = NSLock()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        if let d = plain.date(from: raw) { return d }
        if let d = fractional.date(from: raw) { return d }
        let stripped = raw.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return plain.date(from: stripped)
    }
}

// MARK: - Helper → window

/// One line of the agent's captions.
struct WireSpokenLine: Equatable {
    var id: String
    var text: String
}

/// A choice button.
struct WireChoice: Equatable {
    var id: String
    var label: String
}

/// What Talk asks (the dock shows big buttons for its choices).
struct WireAsk: Equatable {
    var id: String
    /// `permission`, `question` or `plan`.
    var kind: String
    var prompt: String
    var choices: [WireChoice]
    var multiSelect: Bool
    var acceptsOwnWords: Bool
    var isSecret: Bool
    var answerableByVoice: Bool
}

/// `state`: what the dock shows.
struct WireState: Equatable {
    /// `starting`, `listening`, `hearing`, `thinking`, `working`,
    /// `speaking`, `asking`, `confirmingCancel`, `paused`, `ended`, `failed`.
    var status: String
    /// With `paused`: `phoneCall`, `siri` or `interruption`.
    var pauseReason: String?
    /// With `failed`: why, in plain words.
    var error: String?
    var title: String
    /// What the person is saying (live) or last said (final).
    var heard: String
    var heardFinal: Bool
    /// The last lines spoken (at most 20), and the one playing.
    var spoken: [WireSpokenLine]
    var current: String?
    var ask: WireAsk?
    /// `none`, `soft` (said "mute": still listening for "unmute") or
    /// `hard` (the Mute button).
    var mute: String
    var handsFree: Bool
    var backgroundOutstanding: Int
    var awaitingBackground: Bool
    /// whisper was dropped for memory: finals come from the live transcriber.
    var fastMode: Bool
    /// BlueTTS speaks (false: the system voices).
    var naturalVoice: Bool
    var canReportCutOff: Bool
    /// `builtIn`, `bluetoothHFP`, `wired` (headphones) or `other`.
    var route: String
    /// `voiceProcessing` or `none`.
    var echo: String
    var speaksHebrew: Bool
    /// The microphone permission: `granted`, `denied` or `undetermined`.
    var mic: String
    /// Speakers without echo cancellation: talking over the speech doesn't
    /// interrupt it; headphones would let it.
    var suggestHeadphones: Bool
}

/// A request the window carries out, answered with `res` of the same id.
struct WireRequest {
    enum Op {
        case sendSpoken(text: String)
        case respondPermission(requestId: String?, optionId: String)
        case answerQuestion(questionId: String?, answer: QuestionAnswer)
        case declineQuestion(questionId: String?)
        case answerPlanApproval(approvalId: String?, decision: PlanApprovalDecision, feedback: String?)
        case setTalkMode(enabled: Bool)
        case fetchSettings
        case respondItem(item: WireItemRef, optionId: String)
        case answerItem(item: WireItemRef, answer: QuestionAnswer)
        case answerItemPlan(item: WireItemRef, decision: PlanApprovalDecision, feedback: String?)
        case uploadReport(report: AnyJSON)

        var name: String {
            switch self {
            case .sendSpoken: "sendSpoken"
            case .respondPermission: "respondPermission"
            case .answerQuestion: "answerQuestion"
            case .declineQuestion: "declineQuestion"
            case .answerPlanApproval: "answerPlanApproval"
            case .setTalkMode: "setTalkMode"
            case .fetchSettings: "fetchSettings"
            case .respondItem: "respondItem"
            case .answerItem: "answerItem"
            case .answerItemPlan: "answerItemPlan"
            case .uploadReport: "uploadReport"
            }
        }
    }

    var id: Int
    var op: Op
}

/// A sub-agent's pending item, as a request names it.
struct WireItemRef: Equatable {
    var itemId: String
    var connectionId: String
    var requestId: String
    var conversationId: Int

    init(_ item: PendingItem) {
        itemId = item.id
        connectionId = item.connectionId
        requestId = item.requestId
        conversationId = item.conversationId
    }

    init(itemId: String, connectionId: String, requestId: String, conversationId: Int) {
        self.itemId = itemId
        self.connectionId = connectionId
        self.requestId = requestId
        self.conversationId = conversationId
    }
}

enum Outbound {
    /// First line after launch.
    case hello(mic: String)
    case state(WireState)
    /// Microphone and speech levels, 0…1.
    case level(input: Float, output: Float)
    case req(WireRequest)
    /// Fire and forget: `cancel` stops the agent's turn.
    case cmd(op: String)
    /// What the window keeps for Talk: the event stream attached while idle,
    /// presence `talking`, the session held open.
    case flags(keepsStreamAttached: Bool, isTalking: Bool, holdSession: Bool)
    /// The Talk ended (`ended`, `failed`, `replaced`) and let go of the
    /// microphone. The process stays for a while for the next Talk.
    case ended(reason: String, error: String?)
    /// A message the helper couldn't use.
    case error(message: String)

    /// The JSON object.
    var object: [String: Any] {
        switch self {
        case .hello(let mic):
            return ["type": "hello", "protocol": TalkWire.version, "version": TalkWire.helperVersion, "mic": mic]
        case .state(let s):
            var o: [String: Any] = [
                "type": "state", "status": s.status, "title": s.title, "heard": s.heard,
                "heardFinal": s.heardFinal, "spoken": s.spoken.map { ["id": $0.id, "text": $0.text] },
                "mute": s.mute, "handsFree": s.handsFree, "backgroundOutstanding": s.backgroundOutstanding,
                "awaitingBackground": s.awaitingBackground, "fastMode": s.fastMode, "naturalVoice": s.naturalVoice,
                "canReportCutOff": s.canReportCutOff, "route": s.route, "echo": s.echo,
                "speaksHebrew": s.speaksHebrew, "mic": s.mic, "suggestHeadphones": s.suggestHeadphones,
            ]
            o["pauseReason"] = s.pauseReason ?? NSNull()
            o["error"] = s.error ?? NSNull()
            o["current"] = s.current ?? NSNull()
            if let ask = s.ask {
                o["ask"] = [
                    "id": ask.id, "kind": ask.kind, "prompt": ask.prompt,
                    "choices": ask.choices.map { ["id": $0.id, "label": $0.label] },
                    "multiSelect": ask.multiSelect, "acceptsOwnWords": ask.acceptsOwnWords,
                    "isSecret": ask.isSecret, "answerableByVoice": ask.answerableByVoice,
                ] as [String: Any]
            } else {
                o["ask"] = NSNull()
            }
            return o
        case .level(let input, let output):
            return ["type": "level", "in": Self.rounded(input), "out": Self.rounded(output)]
        case .req(let request):
            var o: [String: Any] = ["type": "req", "id": request.id, "op": request.op.name]
            switch request.op {
            case .sendSpoken(let text):
                o["text"] = text
            case .respondPermission(let requestId, let optionId):
                o["requestId"] = requestId ?? NSNull()
                o["optionId"] = optionId
            case .answerQuestion(let questionId, let answer):
                o["questionId"] = questionId ?? NSNull()
                o["answer"] = Self.object(answer)
            case .declineQuestion(let questionId):
                o["questionId"] = questionId ?? NSNull()
            case .answerPlanApproval(let approvalId, let decision, let feedback):
                o["approvalId"] = approvalId ?? NSNull()
                o["decision"] = decision.rawValue
                o["feedback"] = feedback ?? NSNull()
            case .setTalkMode(let enabled):
                o["enabled"] = enabled
            case .fetchSettings:
                break
            case .respondItem(let item, let optionId):
                o["item"] = Self.object(item)
                o["optionId"] = optionId
            case .answerItem(let item, let answer):
                o["item"] = Self.object(item)
                o["answer"] = Self.object(answer)
            case .answerItemPlan(let item, let decision, let feedback):
                o["item"] = Self.object(item)
                o["decision"] = decision.rawValue
                o["feedback"] = feedback ?? NSNull()
            case .uploadReport(let report):
                o["report"] = Self.object(report)
            }
            return o
        case .cmd(let op):
            return ["type": "cmd", "op": op]
        case .flags(let keepsStreamAttached, let isTalking, let holdSession):
            return ["type": "flags", "keepsStreamAttached": keepsStreamAttached, "isTalking": isTalking,
                    "holdSession": holdSession]
        case .ended(let reason, let error):
            return ["type": "ended", "reason": reason, "error": error ?? NSNull()]
        case .error(let message):
            return ["type": "error", "message": message]
        }
    }

    /// One line: the JSON object and a newline.
    func line() -> Data {
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
            ?? Data(#"{"message":"could not encode a message","type":"error"}"#.utf8)
        data.append(0x0A)
        return data
    }

    private static func rounded(_ value: Float) -> Double {
        guard value.isFinite else { return 0 }
        return (Double(min(1, max(0, value))) * 1000).rounded() / 1000
    }

    private static func object(_ answer: QuestionAnswer) -> [String: Any] {
        ["answers": answer.answers.map { ["questionId": $0.questionId, "labels": $0.labels] as [String: Any] },
         "declined": answer.declined]
    }

    private static func object(_ item: WireItemRef) -> [String: Any] {
        ["itemId": item.itemId, "connectionId": item.connectionId, "requestId": item.requestId,
         "conversationId": item.conversationId]
    }

    private static func object(_ json: AnyJSON) -> Any {
        switch json {
        case .object(let o): return o.mapValues { object($0) }
        case .array(let a): return a.map { object($0) }
        case .string(let s): return s
        case .number(let n): return n
        case .bool(let b): return b
        case .null: return NSNull()
        }
    }
}
