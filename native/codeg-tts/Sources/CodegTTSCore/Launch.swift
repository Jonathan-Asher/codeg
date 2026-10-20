import Darwin
import Foundation

/// Command-line options of the codeg-tts executable.
///
///     codeg-tts --models DIR [--espeak-data DIR] [--voice noa] [--threads N]
///     codeg-tts --version
public struct LaunchOptions: Equatable, Sendable {
    /// The model directory in BlueTTSKit's layout (`bluetts/`, `renikud/`, `voices/`).
    public var modelsDirectory: URL?
    public var espeakDataDirectory: URL?
    public var defaultVoice: String?
    public var threads: Int?
    public var printVersion = false

    public static func parse(_ arguments: [String], environment: [String: String]) -> LaunchOptions {
        func value(_ name: String) -> String? {
            guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
            let v = arguments[i + 1]
            return v.isEmpty ? nil : v
        }
        var o = LaunchOptions()
        if let m = value("--models") ?? environment["CODEG_TTS_MODELS"].flatMap({ $0.isEmpty ? nil : $0 }) {
            o.modelsDirectory = URL(fileURLWithPath: m)
        }
        if let e = value("--espeak-data") { o.espeakDataDirectory = URL(fileURLWithPath: e) }
        o.defaultVoice = value("--voice")
        o.threads = value("--threads").flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil }
        o.printVersion = arguments.contains("--version")
        return o
    }
}

/// Where the espeak-ng English data (`phontab`, `phondata`, `en_dict`, …) is.
///
/// espeak-ng reads it from a directory at runtime. Inside codeg.app it is a
/// bundle resource next to the sidecar's own folder; in a `swift build` tree it
/// is BlueTTSEspeak's resource bundle beside the executable. The executable's
/// own path is used, never `Bundle.main`: for a helper in `Contents/MacOS`,
/// `Bundle.main` is the app, not the helper.
public enum EspeakDataLocator {
    public static let environmentKey = "CODEG_TTS_ESPEAK_DATA"
    static let resourceBundle = "BlueTTSKit_BlueTTSEspeak.bundle"

    /// Every place looked at, in order.
    public static func candidates(executable: URL, explicit: URL?, environment: [String: String]) -> [URL] {
        var out: [URL] = []
        if let explicit { out.append(explicit) }
        if let env = environment[environmentKey], !env.isEmpty { out.append(URL(fileURLWithPath: env)) }
        let dir = executable.deletingLastPathComponent()
        // codeg.app/Contents/MacOS/codeg-tts → codeg.app/Contents/Resources/tts/espeak-ng-data
        out.append(dir.deletingLastPathComponent().appendingPathComponent("Resources/tts/espeak-ng-data"))
        // `tauri dev`: resources are copied next to the dev binary.
        out.append(dir.appendingPathComponent("tts/espeak-ng-data"))
        out.append(dir.appendingPathComponent("espeak-ng-data"))
        // `swift build`: the resource bundle sits beside the executable.
        out.append(dir.appendingPathComponent("\(resourceBundle)/Contents/Resources/espeak-ng-data"))
        out.append(dir.appendingPathComponent("\(resourceBundle)/espeak-ng-data"))
        return out
    }

    /// The first candidate that holds espeak-ng data (has `phontab`).
    public static func locate(executable: URL, explicit: URL?, environment: [String: String],
                              fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> URL? {
        candidates(executable: executable, explicit: explicit, environment: environment).first {
            fileExists($0.appendingPathComponent("phontab").path)
        }
    }

    /// The running executable, symlinks resolved. `argv[0]` is relative when
    /// started from a shell, so it is resolved against the working directory.
    public static func currentExecutable() -> URL {
        var size = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size))
        if _NSGetExecutablePath(&buffer, &size) == 0 {
            let path = buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
            return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        }
        return URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    }
}
