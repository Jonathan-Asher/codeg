// SPDX-License-Identifier: GPL-3.0-or-later
//
// espeak-ng (GPL-3.0-or-later) wrapped as a BlueTTSKit `EnglishPhonemizer`.
// Linking this target into an app makes the app's binary GPL-3.

import BlueTTSKit
import CEspeakNG
import Foundation

/// espeak-ng 1.52.0 English (en-us) phonemizer, matching the reference
/// pipeline's `phonemizer.EspeakBackend("en-us", preserve_punctuation=True,
/// with_stress=True, language_switch="remove-flags")` byte for byte.
///
/// espeak-ng keeps global state, so all instances share one engine guarded by a
/// lock; that is fine for TTS, where English spans are short.
public final class EspeakPhonemizer: EnglishPhonemizer, @unchecked Sendable {
    public enum Error: Swift.Error, CustomStringConvertible {
        case dataNotFound(String)
        case initializeFailed(Int32)
        case voiceFailed(String)

        public var description: String {
            switch self {
            case .dataNotFound(let p): return "espeak-ng-data not found at \(p)"
            case .initializeFailed(let c): return "espeak_Initialize failed (\(c))"
            case .voiceFailed(let v): return "espeak-ng voice \(v) could not be loaded"
            }
        }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var initializedPath: String?
    nonisolated(unsafe) private static var currentVoice: String?

    /// The English data bundled with this target (phontab, phondata, en_dict, …).
    public static var bundledDataDirectory: URL? {
        Bundle.module.url(forResource: "espeak-ng-data", withExtension: nil)
    }

    private let dataPath: String
    private let voice: String

    /// - Parameters:
    ///   - dataDirectory: an `espeak-ng-data` directory; defaults to the bundled English data.
    ///   - voice: espeak voice identifier; phonemizer's `en-us` resolves to `gmw/en-US`.
    public init(dataDirectory: URL? = nil, voice: String = "gmw/en-US") throws {
        guard let dir = dataDirectory ?? Self.bundledDataDirectory else {
            throw Error.dataNotFound("<bundle>")
        }
        guard FileManager.default.fileExists(atPath: dir.appendingPathComponent("phontab").path) else {
            throw Error.dataNotFound(dir.path)
        }
        dataPath = dir.path
        self.voice = voice
        try Self.lock.withLock { try ensureEngine() }
    }

    /// Must be called with the lock held.
    private func ensureEngine() throws {
        if Self.initializedPath != dataPath {
            // AUDIO_OUTPUT_SYNCHRONOUS (0x02), no buffer, our data path, no options — as phonemizer does.
            let rc = dataPath.withCString { espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, $0, 0) }
            if rc <= 0 { throw Error.initializeFailed(rc) }
            Self.initializedPath = dataPath
            Self.currentVoice = nil
        }
        if Self.currentVoice != voice {
            let rc = voice.withCString { espeak_SetVoiceByName($0) }
            if rc != EE_OK { throw Error.voiceFailed(voice) }
            Self.currentVoice = voice
        }
    }

    /// `EspeakWrapper.text_to_phonemes`: IPA, `_` between phonemes, clauses joined by spaces.
    private func textToPhonemes(_ text: String) -> String {
        let utf8 = Array(text.utf8CString)
        var results: [String] = []
        utf8.withUnsafeBufferPointer { buf in
            var ptr: UnsafeRawPointer? = UnsafeRawPointer(buf.baseAddress!)
            // espeakPHONEMES_IPA (0x02) | '_' separator in bits 8-23.
            let mode = Int32((Int32(UInt8(ascii: "_")) << 8) | 0x02)
            while ptr != nil {
                guard let res = espeak_TextToPhonemes(&ptr, espeakCHARS_UTF8, mode) else { continue }
                let s = String(cString: res)
                if !s.isEmpty { results.append(s) }
            }
        }
        return results.joined(separator: " ")
    }

    static let underscoresRe = try! NSRegularExpression(pattern: "_+")
    static let underscoreSpaceRe = try! NSRegularExpression(pattern: "_ ")
    static let flagsRe = try! NSRegularExpression(pattern: "\\(.+?\\)")
    static let whitespaceRe = try! NSRegularExpression(pattern: "\\s+")

    static func sub(_ re: NSRegularExpression, _ s: String, _ t: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s),
                                    withTemplate: NSRegularExpression.escapedTemplate(for: t))
    }

    /// `EspeakBackend._postprocess_line` with separator(phone="", word=" "),
    /// strip=False, with_stress=True, tie=None, remove-flags.
    private func postprocess(_ raw: String) -> String {
        var line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
        line = Self.sub(Self.underscoresRe, line, "_")
        line = Self.sub(Self.underscoreSpaceRe, line, " ")
        line = Self.sub(Self.flagsRe, line, "")
        if line.isEmpty { return "" }
        var out = ""
        for word in line.components(separatedBy: " ") {
            var w = word.trimmingCharacters(in: .whitespacesAndNewlines)
            w += "_"
            w = w.replacingOccurrences(of: "_", with: "")
            out += w + " "
        }
        return out
    }

    /// Phonemize one English segment exactly like the reference `TextProcessor._espeak`.
    public func phonemize(_ text: String) throws -> String {
        try Self.lock.withLock {
            try ensureEngine()
            let raw = PunctuationPreserver.run(text, wordSep: " ") { chunk in
                postprocess(textToPhonemes(chunk))
            }
            return Self.sub(Self.whitespaceRe, raw, " ").trimmingCharacters(in: .whitespaces)
        }
    }

    /// The espeak-ng version string this target was compiled from.
    public static var version: String {
        var path: UnsafePointer<CChar>?
        guard let v = espeak_Info(&path) else { return "?" }
        return String(cString: v)
    }
}
