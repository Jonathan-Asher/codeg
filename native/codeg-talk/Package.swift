// swift-tools-version: 6.0
//
// codeg-talk: Talk on the Mac. A helper process of the codeg desktop app that
// runs the whole hands-free voice loop of one Talk (microphone, voice
// detection, live and final Hebrew transcription, end of turn, barge-in, the
// spoken replies) and drives the session through the window that owns the
// Talk, over JSON lines on stdin/stdout (see README.md).
//
//   TalkCore     the iPhone's portable Talk logic, vendored unchanged from
//                codeg-ios (scripts/sync-from-ios.sh, vendor.lock), plus a
//                small shim. No engine dependencies.
//   TalkHost     the wire protocol, the session mirror the controller drives
//                (MirrorPort), the backend over the wire, the UI state
//                publisher and the Mac echo policy. No engine dependencies,
//                so its tests build in seconds.
//   TalkEngines  the Mac audio engine (one AVAudioEngine with voice
//                processing for the microphone and the speech), Core Audio
//                routes, the engines' adapters (vendored), the BlueTTS voice
//                and the device side (keeping the Mac awake).
//   codeg-talk   the executable.
//
// The vendored sources use Swift's default (internal) access, exactly as they
// are in the app, and compile as one module. The other targets reach them with
// testable imports, so every library target is compiled with -enable-testing,
// in release too. The package is only ever built as a root package (by
// src-tauri/scripts/prepare-sidecars.mjs), which is what allows the unsafe
// flags.
//
// Engines are arm64 only (whisper.framework and sherpa-onnx's macOS slice),
// so the executable is built with `--triple arm64-apple-macosx15.0`.
//
// The executable links BlueTTSEspeak (espeak-ng, GPL-3.0-or-later), so the
// binary as built is GPL-3.0-or-later, like codeg-tts; see README.md.

import PackageDescription

/// Swift 5 mode (the vendored code is Swift 5 code) and testable internals.
let shared: [SwiftSetting] = [
    .swiftLanguageMode(.v5),
    .unsafeFlags(["-enable-testing"]),
]

let package = Package(
    name: "codeg-talk",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "codeg-talk", targets: ["codeg-talk"]),
    ],
    dependencies: [
        .package(path: "../BlueTTSKit"),
        .package(path: "../SherpaOnnx"),
        .package(path: "../SmartTurn"),
        .package(path: "../WhisperCpp"),
        .package(path: "../ExceptionCatcher"),
    ],
    targets: [
        .target(
            name: "TalkCore",
            swiftSettings: shared,
            linkerSettings: [.linkedFramework("Accelerate")]
        ),
        .target(
            name: "TalkHost",
            dependencies: ["TalkCore"],
            swiftSettings: shared
        ),
        .target(
            name: "TalkEngines",
            dependencies: [
                "TalkCore",
                "TalkHost",
                .product(name: "BlueTTSKit", package: "BlueTTSKit"),
                .product(name: "BlueTTSEspeak", package: "BlueTTSKit"),
                .product(name: "SherpaOnnx", package: "SherpaOnnx"),
                .product(name: "SmartTurn", package: "SmartTurn"),
                .product(name: "whisper", package: "WhisperCpp"),
                .product(name: "ExceptionCatcher", package: "ExceptionCatcher"),
            ],
            // The vendored adapters name TalkCore's types without importing
            // it (in the app they share a module): import it into every file.
            swiftSettings: shared + [
                .unsafeFlags(["-Xfrontend", "-testable-import-module", "-Xfrontend", "TalkCore"]),
            ],
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
            ]
        ),
        .executableTarget(
            name: "codeg-talk",
            dependencies: ["TalkCore", "TalkHost", "TalkEngines"],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                // Inside codeg.app the helper is Contents/MacOS/codeg-talk and
                // whisper.framework is in Contents/Frameworks (`tauri dev`:
                // target/debug and target/Frameworks). SwiftPM's own
                // @loader_path covers a `swift build` tree.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
        .testTarget(
            name: "TalkHostTests",
            dependencies: ["TalkCore", "TalkHost"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
