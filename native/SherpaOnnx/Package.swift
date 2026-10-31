// swift-tools-version: 6.0
//
// SherpaOnnx: sherpa-onnx's streaming transducer recognizer for Talk mode's
// live Hebrew transcription (ivrit.ai's zipformer2-66m-streaming-he).
//
// Products
//   SherpaOnnx        `StreamingTransducerRecognizer`, a thin Swift wrapper
//                     over sherpa-onnx's C API (module `SherpaOnnxC`).
//   sherpa-onnx-cli   macOS tool: streams WAV files through the recognizer
//                     and prints partials, final text and timings.
//
// `SherpaOnnxC` is sherpa-onnx 2.0.1's C API as a static XCFramework built by
// scripts/build-sherpa-onnx.sh (.github/workflows/sherpa-onnx.yml): TTS and
// speaker diarization off, compiled against ONNX Runtime 1.30.0 headers and
// linked here against BlueTTSKit's ONNX Runtime (its `OnnxRuntime` product),
// so the app carries one runtime. Slices: ios-arm64,
// ios-arm64_x86_64-simulator, macos-arm64.
//
// To update: build a new release with the script (bump its version or
// BUILD_REVISION), then point `url` at the new zip and set `checksum` to its
// sha256 (`swift package compute-checksum <zip>`).

import PackageDescription

let package = Package(
    name: "SherpaOnnx",
    platforms: [
        // BlueTTSKit's minimums: a package can't sit below a dependency's.
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "SherpaOnnx", targets: ["SherpaOnnx"]),
        .executable(name: "sherpa-onnx-cli", targets: ["sherpa-onnx-cli"]),
    ],
    dependencies: [
        .package(path: "../BlueTTSKit"),
    ],
    targets: [
        .binaryTarget(
            name: "SherpaOnnxC",
            url: "https://github.com/Jonathan-Asher/codeg-ios/releases/download/sherpa-onnx-2.0.1-ort1.30/sherpa-onnx-2.0.1-ort1.30.0-xcframework.zip",
            checksum: "6acc2d12910084e9328919a95cc335b4ffdd62d5124fab2bc4de54f0e1fc27c9"
        ),
        .target(
            name: "SherpaOnnx",
            dependencies: [
                "SherpaOnnxC",
                // sherpa-onnx calls ONNX Runtime's C API; this is the one copy.
                .product(name: "OnnxRuntime", package: "BlueTTSKit"),
            ],
            linkerSettings: [
                // The archive is C++ (libc++) and logs through Foundation.
                .linkedLibrary("c++"),
                .linkedFramework("Foundation"),
            ]
        ),
        .executableTarget(
            name: "sherpa-onnx-cli",
            dependencies: ["SherpaOnnx"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "SherpaOnnxTests",
            dependencies: ["SherpaOnnx"]
        ),
    ]
)
