// codeg-talk: Talk on the Mac, a helper process of the codeg desktop app.
// The window that owns the Talk talks to it over JSON lines on stdin/stdout,
// relayed by codeg's Rust side; the protocol is in README.md. Diagnostics go
// to stderr.
//
//     codeg-talk [--espeak-data DIR] [--idle-exit SECONDS]
//     codeg-talk --probe
//     codeg-talk --version

import Darwin
import Foundation
import TalkEngines

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IONBF, 0)

let arguments = CommandLine.arguments
if arguments.contains("--version") {
    print(HelperProbe.versionLine)
    exit(0)
}
if arguments.contains("--probe") {
    print(HelperProbe.line)
    exit(0)
}

let options = HelperOptions.parse(arguments, environment: ProcessInfo.processInfo.environment)
MainActor.assumeIsolated {
    TalkHelperMain.start(options: options)
}
dispatchMain()
