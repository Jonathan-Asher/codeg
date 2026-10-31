import Foundation

/// The person's Talk settings on the server (`get_talk_settings`,
/// `update_talk_settings`): which language the agent answers in, and how it
/// addresses the person in Hebrew. The server writes them into Talk's hidden
/// note on each spoken message.
struct TalkSettings: Codable, Hashable, Sendable {
    enum Language: String, Codable, CaseIterable, Sendable {
        /// The language of the person's last message (Hebrew when unsure).
        case auto
        case hebrew = "he"
        case english = "en"
    }

    enum Address: String, Codable, CaseIterable, Sendable {
        /// Wording without gendered second-person forms.
        case auto
        case masculine
        case feminine
    }

    var language: Language = .auto
    var address: Address = .auto

    init(language: Language = .auto, address: Address = .auto) {
        self.language = language
        self.address = address
    }

    private enum CodingKeys: String, CodingKey { case language, address }

    /// Lenient: a value this build doesn't know reads as `auto`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        language = ((try? c.decodeIfPresent(String.self, forKey: .language)) ?? nil).flatMap { Language(rawValue: $0) } ?? .auto
        address = ((try? c.decodeIfPresent(String.self, forKey: .address)) ?? nil).flatMap { Address(rawValue: $0) } ?? .auto
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(language.rawValue, forKey: .language)
        try c.encode(address.rawValue, forKey: .address)
    }
}
