#!/bin/bash
# Compila a casca nativa e monta o TokenTown.app (executável + Info.plist + Resources).
# Zero deps de terceiros; usa só o toolchain do sistema (/usr/bin/swift).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
APP="$ROOT/TokenTown.app"

echo "==> swift build -c release"
swift build -c release

BIN="$(swift build -c release --show-bin-path)/TokenTown"
[ -f "$BIN" ] || { echo "ERRO: binário não encontrado em $BIN"; exit 1; }

echo "==> montando $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TokenTown"

# Resources: game.js VERBATIM + o cérebro (reader.js) + o wrapper.
cp "$ROOT/Resources/game.js"           "$APP/Contents/Resources/game.js"
cp "$ROOT/Resources/reader.js"         "$APP/Contents/Resources/reader.js"
cp "$ROOT/Resources/overlay-swift.html" "$APP/Contents/Resources/overlay-swift.html"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TokenTown</string>
  <key>CFBundleDisplayName</key><string>TokenTown</string>
  <key>CFBundleIdentifier</key><string>com.mel.tokentown</string>
  <key>CFBundleExecutable</key><string>TokenTown</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- utilitário/overlay: sem ícone no Dock (par com setActivationPolicy(.accessory)) -->
  <key>LSUIElement</key><true/>
  <!-- permite o URLSession postar em http://localhost (placar local) sob ATS -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# assinatura ad-hoc: ajuda WKWebView/notificações a se comportarem em macOS moderno.
echo "==> codesign ad-hoc"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "(codesign ad-hoc falhou; segue sem assinar)"

echo "==> pronto: $APP"
du -sh "$APP"
