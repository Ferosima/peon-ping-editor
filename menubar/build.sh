#!/bin/bash
# Builds PeonBar.app from PeonBar.swift.
#   bash menubar/build.sh <out-dir> [--universal]
# --universal builds arm64 + x86_64 (used for the prebuilt app in GitHub Releases).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build.sh <out-dir> [--universal]}"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/../package.json" | head -1)"
APP="$OUT/PeonBar.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
if [ "${2:-}" = "--universal" ]; then
  TMP="$(mktemp -d)"
  swiftc -O -target arm64-apple-macos12 -o "$TMP/arm64" "$HERE/PeonBar.swift" -framework AppKit
  swiftc -O -target x86_64-apple-macos12 -o "$TMP/x86_64" "$HERE/PeonBar.swift" -framework AppKit
  lipo -create -output "$APP/Contents/MacOS/PeonBar" "$TMP/arm64" "$TMP/x86_64"
  rm -rf "$TMP"
else
  swiftc -O -o "$APP/Contents/MacOS/PeonBar" "$HERE/PeonBar.swift" -framework AppKit
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.peonping.peonbar</string>
  <key>CFBundleName</key><string>PeonBar</string>
  <key>CFBundleExecutable</key><string>PeonBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature: Apple silicon refuses to run unsigned binaries
codesign --force --sign - "$APP" >/dev/null 2>&1 || { echo "codesign failed" >&2; exit 1; }
echo "$APP"
