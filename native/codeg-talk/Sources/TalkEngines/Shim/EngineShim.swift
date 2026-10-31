// What the vendored engine files (AVFAudioGuard) name from the rest of the
// iPhone app, on the Mac.
import Foundation

/// An audio error whose description is already plain words (the app's
/// AudioSessionOwner.swift, iOS-only).
protocol PlainAudioError: LocalizedError {}

/// The app's diagnostics: an Objective-C exception AVFAudio raised and the
/// guard caught. The helper logs it on stderr.
final class Diagnostics: @unchecked Sendable {
    static let shared = Diagnostics()

    func caught(operation: String, exception: NSException) {
        TalkLog.write("caught \(exception.name.rawValue) in \(operation): \(exception.reason ?? "")")
    }
}
