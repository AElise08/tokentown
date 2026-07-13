// swift-tools-version:6.0
import PackageDescription

// Casca nativa do TOKENTOWN — zero dependências de terceiros: só AppKit + WebKit +
// UserNotifications (frameworks do sistema). Modo de linguagem v5 pra evitar o atrito
// de concorrência estrita do Swift 6 num app AppKit clássico (delegate + filas).
let package = Package(
    name: "TokenTown",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TokenTown",
            path: "Sources/TokenTown"
        )
    ],
    swiftLanguageModes: [.v5]
)
