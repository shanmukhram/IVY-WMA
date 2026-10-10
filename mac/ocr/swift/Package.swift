// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "IvyOCR",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ivy-ocr", targets: ["ivy-ocr"]),
        .executable(name: "ivy-fixture", targets: ["ivy-fixture"]),
    ],
    targets: [
        // Long-running OCR + thumbnail helper (NDJSON over stdin/stdout).
        .executableTarget(name: "ivy-ocr", path: "Sources/ivy-ocr"),
        // Test-only fixture generator (renders known text into images/PDFs, probes pixels).
        .executableTarget(name: "ivy-fixture", path: "Sources/ivy-fixture"),
    ]
)
