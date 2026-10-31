// swift-tools-version: 6.0
//
// SmartTurn: Smart Turn v3.2 (pipecat-ai, BSD-2-Clause), an end-of-turn
// classifier over the last 8 s of speech, for Talk mode's end-of-turn
// decision (shadow mode first; see docs/FORK.md, "Talk engines").
//
// Products
//   SmartTurn       `SmartTurnClassifier` (the int8 ONNX model on ONNX Runtime,
//                   CPU only) and `WhisperLogMel`, its Whisper-style log-mel
//                   front end in Accelerate.
//   smart-turn-cli  macOS tool: probabilities and timings over WAV files.
//
// ONNX Runtime is BlueTTSKit's (1.30.0, its `OnnxRuntime` product), so the app
// links one runtime. The model file is downloaded at runtime (`models-v2`
// release, `smart-turn-v3.2` in CodegiOS/Resources/stt-models.json).

import PackageDescription

let package = Package(
    name: "SmartTurn",
    platforms: [
        // BlueTTSKit's minimums: a package can't sit below a dependency's.
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "SmartTurn", targets: ["SmartTurn"]),
        .executable(name: "smart-turn-cli", targets: ["smart-turn-cli"]),
    ],
    dependencies: [
        .package(path: "../BlueTTSKit"),
    ],
    targets: [
        .target(
            name: "SmartTurn",
            dependencies: [.product(name: "OnnxRuntime", package: "BlueTTSKit")],
            linkerSettings: [.linkedFramework("Accelerate")]
        ),
        .executableTarget(
            name: "smart-turn-cli",
            dependencies: ["SmartTurn"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "SmartTurnTests",
            dependencies: ["SmartTurn"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
