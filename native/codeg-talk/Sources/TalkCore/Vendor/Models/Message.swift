import Foundation

/// Role of a rendered turn (Rust `TurnRole`).
enum TurnRole: String, Codable, Hashable, Sendable {
    case user
    case assistant
    case system

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TurnRole(rawValue: raw) ?? .system
    }
}

/// Token usage for a single turn (Rust `TurnUsage`). All fields present on wire.
struct TurnUsage: Codable, Hashable, Sendable {
    let inputTokens: Int
    let outputTokens: Int
    let cacheCreationInputTokens: Int
    let cacheReadInputTokens: Int

    var total: Int { inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens }
}

/// Inline image payload (Rust `ImageData`).
struct ImageData: Codable, Hashable, Sendable {
    let data: String
    let mimeType: String
    let uri: String?
    /// Where the server serves the real image when a live frame could not carry
    /// it inline (`/api/live_image/<key>`, relative to the server). `data` is
    /// then a small placeholder picture.
    var dataRef: String? = nil
}

extension ImageData {
    /// Decode a list of images under `key`, skipping any that are malformed
    /// (and treating a missing or null list as empty) instead of failing the
    /// value that holds them — one bad image must not cost a whole transcript.
    static func lenientList<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) -> [ImageData] {
        guard c.contains(key), (try? c.decodeNil(forKey: key)) == false,
              var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [ImageData] = []
        while !list.isAtEnd {
            if let image = try? list.decode(ImageData.self) {
                out.append(image)
            } else if (try? list.decode(SkippedElement.self)) == nil {
                break
            }
        }
        return out
    }
}

/// Always decodes, so a list element that failed to decode is stepped over
/// rather than retried.
private struct SkippedElement: Decodable {
    init(from decoder: Decoder) {}
}

/// A polymorphic block of message content (Rust `ContentBlock`, internally
/// tagged by `type` with snake_case variant names). Decode-only: the server is
/// the source of truth for transcripts; locally-constructed optimistic turns
/// build cases directly. Unknown future variants decode to `.unknown` instead
/// of throwing.
enum ContentBlock: Hashable, Sendable, Codable {
    case text(String)
    case thinking(String)
    case image(ImageData)
    case imageGeneration(revisedPrompt: String?, image: ImageData?)
    case toolUse(id: String?, name: String, inputPreview: String?, meta: AnyJSON?)
    /// `images`: what the tool returned as pictures — a Read of a PNG, a
    /// screenshot — shown after the tool's card.
    case toolResult(id: String?, outputPreview: String?, isError: Bool, images: [ImageData] = [])
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        // NOTE: the decoder uses `.convertFromSnakeCase`, so wire keys arrive
        // here already camelCased — match them in camelCase.
        case type, text, data, mimeType, uri, dataRef, revisedPrompt, image
        case toolUseId, toolName, inputPreview, meta
        case outputPreview, isError, images
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "text":
            self = .text(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "thinking":
            self = .thinking(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "image":
            self = .image(ImageData(
                data: try c.decodeIfPresent(String.self, forKey: .data) ?? "",
                mimeType: try c.decodeIfPresent(String.self, forKey: .mimeType) ?? "image/png",
                uri: try c.decodeIfPresent(String.self, forKey: .uri),
                dataRef: try c.decodeIfPresent(String.self, forKey: .dataRef)
            ))
        case "image_generation":
            self = .imageGeneration(
                revisedPrompt: try c.decodeIfPresent(String.self, forKey: .revisedPrompt),
                image: try c.decodeIfPresent(ImageData.self, forKey: .image)
            )
        case "tool_use":
            self = .toolUse(
                id: try c.decodeIfPresent(String.self, forKey: .toolUseId),
                name: try c.decodeIfPresent(String.self, forKey: .toolName) ?? "tool",
                inputPreview: try c.decodeIfPresent(String.self, forKey: .inputPreview),
                // `meta["codeg.delegation"]` carries the delegate card's authoritative
                // terminal status; nil for tool uses without any meta.
                meta: try c.decodeIfPresent(AnyJSON.self, forKey: .meta)
            )
        case "tool_result":
            self = .toolResult(
                id: try c.decodeIfPresent(String.self, forKey: .toolUseId),
                outputPreview: try c.decodeIfPresent(String.self, forKey: .outputPreview),
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
                // Lenient: a malformed image must not fail the whole transcript.
                images: ImageData.lenientList(c, forKey: .images)
            )
        default:
            self = .unknown(type: type)
        }
    }

    /// Written only to the on-device transcript cache: the keys `init(from:)`
    /// reads, so a cached block decodes to the same value.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .thinking(let text):
            try c.encode("thinking", forKey: .type)
            try c.encode(text, forKey: .text)
        case .image(let image):
            try c.encode("image", forKey: .type)
            try c.encode(image.data, forKey: .data)
            try c.encode(image.mimeType, forKey: .mimeType)
            try c.encodeIfPresent(image.uri, forKey: .uri)
            try c.encodeIfPresent(image.dataRef, forKey: .dataRef)
        case .imageGeneration(let revisedPrompt, let image):
            try c.encode("image_generation", forKey: .type)
            try c.encodeIfPresent(revisedPrompt, forKey: .revisedPrompt)
            try c.encodeIfPresent(image, forKey: .image)
        case .toolUse(let id, let name, let inputPreview, let meta):
            try c.encode("tool_use", forKey: .type)
            try c.encodeIfPresent(id, forKey: .toolUseId)
            try c.encode(name, forKey: .toolName)
            try c.encodeIfPresent(inputPreview, forKey: .inputPreview)
            try c.encodeIfPresent(meta, forKey: .meta)
        case .toolResult(let id, let outputPreview, let isError, let images):
            try c.encode("tool_result", forKey: .type)
            try c.encodeIfPresent(id, forKey: .toolUseId)
            try c.encodeIfPresent(outputPreview, forKey: .outputPreview)
            try c.encode(isError, forKey: .isError)
            if !images.isEmpty { try c.encode(images, forKey: .images) }
        case .unknown(let type):
            try c.encode(type, forKey: .type)
        }
    }
}

/// One turn in a conversation transcript (Rust `MessageTurn`).
struct MessageTurn: Identifiable, Hashable, Sendable, Codable {
    let id: String
    let role: TurnRole
    let blocks: [ContentBlock]
    let timestamp: Date
    let usage: TurnUsage?
    let durationMs: Int?
    let model: String?
    let completedAt: Date?
    /// The server's timestamp in epoch milliseconds, exactly as the server
    /// counts it (`timestamp_millis`). Only turns that came from the server
    /// have it; a turn built on the phone (an optimistic prompt, a reply that
    /// was never reconciled) has `nil`. The transcript window's prefix
    /// fingerprint is computed from it (`TranscriptFingerprint`).
    let serverMillis: Int64?
    /// The user said this message in Talk rather than typing it (the server's
    /// `spoken`, set where the message carried Talk's hidden note). The
    /// message card shows a microphone for it. False from an older server.
    let spoken: Bool

    init(
        id: String,
        role: TurnRole,
        blocks: [ContentBlock],
        timestamp: Date,
        usage: TurnUsage? = nil,
        durationMs: Int? = nil,
        model: String? = nil,
        completedAt: Date? = nil,
        serverMillis: Int64? = nil,
        spoken: Bool = false
    ) {
        self.id = id
        self.role = role
        self.blocks = blocks
        self.timestamp = timestamp
        self.usage = usage
        self.durationMs = durationMs
        self.model = model
        self.completedAt = completedAt
        self.serverMillis = serverMillis
        self.spoken = spoken
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, blocks, timestamp, usage, durationMs, model, completedAt, spoken
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decode(TurnRole.self, forKey: .role)
        blocks = try c.decode([ContentBlock].self, forKey: .blocks)
        // Read the timestamp text ourselves: the date decoder drops 6- and
        // 9-digit fractions entirely, and the fingerprint needs the exact
        // milliseconds.
        if let raw = try? c.decode(String.self, forKey: .timestamp), let millis = TranscriptTime.millis(raw) {
            timestamp = Date(timeIntervalSince1970: Double(millis) / 1000)
            serverMillis = millis
        } else {
            timestamp = try c.decode(Date.self, forKey: .timestamp)
            serverMillis = nil
        }
        usage = try c.decodeIfPresent(TurnUsage.self, forKey: .usage)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
        spoken = ((try? c.decodeIfPresent(Bool.self, forKey: .spoken)) ?? nil) ?? false
    }

    /// Written only to the on-device transcript cache, in the shape the
    /// decoder above reads back (camelCase keys, RFC 3339 timestamp).
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(role.rawValue, forKey: .role)
        try c.encode(blocks, forKey: .blocks)
        try c.encode(serverMillis.map(TranscriptTime.string(millis:)) ?? TranscriptTime.string(date: timestamp),
                     forKey: .timestamp)
        try c.encodeIfPresent(usage, forKey: .usage)
        try c.encodeIfPresent(durationMs, forKey: .durationMs)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(completedAt, forKey: .completedAt)
        if spoken { try c.encode(true, forKey: .spoken) }
    }
}
