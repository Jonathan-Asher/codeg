// swift-tools-version:5.9
//
// whisper.cpp for on-device voice typing: the official XCFramework from the
// whisper.cpp GitHub release (MIT), a dynamic framework with Metal (and Core
// ML encoder support) built in. The app imports it as `whisper`.
//
// To update: point `url` at a newer release's `whisper-<tag>-xcframework.zip`
// and set `checksum` to `swift package compute-checksum <zip>` (its sha256).
import PackageDescription

let package = Package(
    name: "WhisperCpp",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "whisper", targets: ["whisper"]),
    ],
    targets: [
        .binaryTarget(
            name: "whisper",
            url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-v1.9.1-xcframework.zip",
            checksum: "8c3ecbe73f48b0cb9318fc3058264f951ab336fd530e82c4ccdd2298d1311a4c"
        ),
    ]
)
