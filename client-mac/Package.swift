// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SoftwareCenter",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SoftwareCenter",
            path: "Sources/SoftwareCenter"
        )
    ]
)
