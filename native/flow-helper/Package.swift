// swift-tools-version: 6.0
import PackageDescription

// The helper is OS glue only: key event tap, paste, accessibility reads.
// All product logic lives in the TypeScript app.
let swiftSettings: [SwiftSetting] = [.swiftLanguageMode(.v5)]

let package = Package(
    name: "flow-helper",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything testable without OS permissions lives in the library.
        .target(name: "FlowHelperCore", swiftSettings: swiftSettings),
        .executableTarget(
            name: "flow-helper",
            dependencies: ["FlowHelperCore"],
            path: "Sources/FlowHelper",
            swiftSettings: swiftSettings
        ),
        .testTarget(
            name: "FlowHelperCoreTests",
            dependencies: ["FlowHelperCore"],
            swiftSettings: swiftSettings
        ),
    ]
)
