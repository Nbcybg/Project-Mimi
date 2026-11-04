#!/bin/sh
# Builds Mimi.app from the Swift package with only the Command Line Tools (no Xcode):
#   apps/macos/Support/build-app.sh                 a Release build into apps/macos/build/Mimi.app (finds the repo's
#                                                   core and PC agent from the sources: for this machine)
#   apps/macos/Support/build-app.sh --bundle-core   also copies node, the core, the PC agent and node_modules into
#                                                   the app (Resources/node, Resources/mimi): an app to hand to others
# Signed ad hoc (codesign -s -). A Developer ID signature and notarization need an Apple Developer account (Q9).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/.." && pwd)
REPO=$(cd "$PKG/../.." && pwd)
OUT="$PKG/build"
APP="$OUT/Mimi.app"
VERSION=$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo "0.0.0")
# The bundle version must be numbers only: 0.8.1-prototype -> 0.8.1
SHORT=$(echo "$VERSION" | sed 's/[^0-9.].*//')

cd "$PKG"
swift build -c release --product Mimi
BIN=$(swift build -c release --show-bin-path)/Mimi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Mimi"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.mimi.macos</string>
  <key>CFBundleName</key><string>Mimi</string>
  <key>CFBundleDisplayName</key><string>Mimi</string>
  <key>CFBundleExecutable</key><string>Mimi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$SHORT</string>
  <key>CFBundleVersion</key><string>$SHORT</string>
  <key>CFBundleIconFile</key><string>Mimi</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Mimi ใช้ไมโครโฟนเมื่อคุณอัดข้อความเสียง</string>
  <key>NSAppleEventsUsageDescription</key><string>PC agent ของ Mimi ใช้คุมแอปที่คุณอนุญาต</string>
  <key>NSHumanReadableCopyright</key><string>Mimi $VERSION</string>
</dict>
</plist>
PLIST

# The icon: the same picture the core draws for the web (packages/core/src/app/icon.ts).
ICONSET="$OUT/Mimi.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
if node --input-type=module -e "
import { renderIconPng } from '$REPO/packages/core/src/app/icon.ts';
import fs from 'node:fs';
for (const [name, size] of [['16x16',16],['16x16@2x',32],['32x32',32],['32x32@2x',64],['128x128',128],['128x128@2x',256],['256x256',256],['256x256@2x',512],['512x512',512],['512x512@2x',1024]])
  fs.writeFileSync('$ICONSET/icon_' + name + '.png', renderIconPng(size));
" 2>/dev/null; then
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Mimi.icns" || echo "no icon (iconutil failed)"
fi
rm -rf "$ICONSET"

if [ "$1" = "--bundle-core" ]; then
  NODE=$(command -v node)
  mkdir -p "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/mimi/packages"
  cp "$NODE" "$APP/Contents/Resources/node/bin/node"
  for part in core shared pc-agent; do
    rsync -a --exclude '*.test.ts' --exclude 'src/test/' "$REPO/packages/$part" "$APP/Contents/Resources/mimi/packages/"
  done
  cp "$REPO/package.json" "$REPO/mimi.json" "$APP/Contents/Resources/mimi/"
  # Production dependencies only; the workspace packages are links into the copies above.
  rsync -a --exclude '.cache' --exclude '@types' --exclude 'typescript' --exclude '@electron' "$REPO/node_modules" "$APP/Contents/Resources/mimi/"
  echo "bundled: node $("$NODE" --version), core, PC agent ($(du -sh "$APP/Contents/Resources" | cut -f1))"
fi

codesign --force --deep -s - "$APP" 2>/dev/null || echo "warning: ad hoc signing failed"
echo "built $APP ($VERSION)"
