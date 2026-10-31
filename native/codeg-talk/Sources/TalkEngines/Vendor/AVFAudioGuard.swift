import ExceptionCatcher
import Foundation
import os

/// AVFAudio reports misuse by raising an Objective-C exception (a tap whose
/// format doesn't match the hardware, a player started while its engine is
/// stopped), and Swift can't catch one: the app aborts. Every call that can
/// raise goes through ``run(_:_:)``, which turns the exception into an
/// ``AVFAudioException``: logged, reported to the server
/// (``Diagnostics/caught(operation:exception:)``) and shown as a plain error.
enum AVFAudioGuard {
    static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "codeg", category: "audio-guard")

    /// Run `body`; an Objective-C exception it raises is thrown as an
    /// ``AVFAudioException`` naming `operation`; a Swift error it throws is
    /// rethrown unchanged.
    @discardableResult
    static func run<T>(_ operation: String, _ body: () throws -> T) throws -> T {
        var result: Result<T, Error>?
        if let exception = CGCatchException({ result = Result { try body() } }) {
            let error = AVFAudioException(operation: operation, name: exception.name.rawValue,
                                          reason: exception.reason ?? "")
            log.error("\(operation, privacy: .public) raised \(error.name, privacy: .public): \(error.reason, privacy: .public)")
            Diagnostics.shared.caught(operation: operation, exception: exception)
            throw error
        }
        guard let result else { throw AVFAudioException(operation: operation, name: "unknown", reason: "no result") }
        return try result.get()
    }
}

/// An exception AVFAudio raised, caught. Its text names the call for the
/// log; the person sees that the audio system refused and to try again.
struct AVFAudioException: PlainAudioError, Equatable {
    let operation: String
    let name: String
    let reason: String

    var errorDescription: String? { "The audio system refused the request, try again" }
}
