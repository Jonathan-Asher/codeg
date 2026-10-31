// swift-tools-version:5.9
//
// Swift can't catch an Objective-C exception: one raised by a framework
// (AVFAudio's `installTap`, `play`, `connect`) unwinds straight through Swift
// frames and ends the app. This runs a block inside `@try/@catch` and hands
// the exception back, so the caller can turn it into an error.
import PackageDescription

let package = Package(
    name: "ExceptionCatcher",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "ExceptionCatcher", targets: ["ExceptionCatcher"]),
    ],
    targets: [
        .target(name: "ExceptionCatcher"),
    ]
)
