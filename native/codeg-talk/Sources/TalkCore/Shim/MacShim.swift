// What the helper adds to the vendored Talk files on the Mac. Nothing here
// changes their logic.
import Foundation

/// The helper's diagnostics, on stderr (stdout carries the protocol); codeg
/// logs them.
enum TalkLog {
    private static let lock = NSLock()

    static func write(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(Data("[codeg-talk] \(message)\n".utf8))
    }
}
