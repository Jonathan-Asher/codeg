// swift-tools-version: 6.0
//
// codeg-tts: the desktop app's natural-voice sidecar. A long-running process
// that loads BlueTTS 2.5 + RenikudPlus once and streams 16-bit PCM back to the
// codeg backend, sentence by sentence, over stdin/stdout (see README.md).
//
//   CodegTTSCore  the wire protocol, PCM conversion and the espeak-ng data
//                 lookup. No model code, so its tests run without models.
//   codeg-tts     the executable. Links BlueTTSEspeak (espeak-ng), so the
//                 binary is GPL-3.0-or-later; see README.md "Licensing".

import PackageDescription

let package = Package(
    name: "codeg-tts",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "codeg-tts", targets: ["codeg-tts"]),
    ],
    dependencies: [
        .package(path: "../BlueTTSKit"),
    ],
    targets: [
        .target(name: "CodegTTSCore"),
        .executableTarget(
            name: "codeg-tts",
            dependencies: [
                "CodegTTSCore",
                .product(name: "BlueTTSKit", package: "BlueTTSKit"),
                .product(name: "BlueTTSEspeak", package: "BlueTTSKit"),
            ]
        ),
        .testTarget(
            name: "CodegTTSCoreTests",
            dependencies: ["CodegTTSCore"]
        ),
    ]
)
