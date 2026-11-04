// swift-tools-version:6.0
// The native Mac app (Phase 3): SwiftUI, built with SwiftPM so it needs only the Command Line Tools;
// `Support/build-app.sh` wraps the binary into Mimi.app. MimiKit holds everything an iOS app shares
// (protocol, HTTP + WebSocket, chat reducer); MimiDesktop is what only a computer does (the PC agent,
// the core on this machine); Mimi is the app itself.
import PackageDescription

let package = Package(
    name: "Mimi",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MimiKit", targets: ["MimiKit"]),
        .executable(name: "Mimi", targets: ["Mimi"]),
    ],
    targets: [
        .target(name: "MimiKit"),
        .target(name: "MimiDesktop", dependencies: ["MimiKit"]),
        .executableTarget(name: "Mimi", dependencies: ["MimiKit", "MimiDesktop"]),
        .testTarget(name: "MimiKitTests", dependencies: ["MimiKit"]),
        .testTarget(name: "MimiDesktopTests", dependencies: ["MimiDesktop"]),
    ],
    swiftLanguageModes: [.v5]
)
