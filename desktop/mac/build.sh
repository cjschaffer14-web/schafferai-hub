#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_path=${1:-"$source_dir/build/SchafferDesktop.app"}
mkdir -p "$app_path/Contents/MacOS" "$source_dir/build/swift-cache"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macosx14.0 \
  -module-cache-path "$source_dir/build/swift-cache" \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
  -framework CoreImage -framework CoreMedia -framework ImageIO -framework UniformTypeIdentifiers \
  "$source_dir/main.swift" -o "$app_path/Contents/MacOS/SchafferDesktop"
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>SchafferDesktop</string>
  <key>CFBundleIdentifier</key><string>com.schafferai.desktop-portal</string>
  <key>CFBundleName</key><string>Schaffer Desktop</string>
  <key>CFBundleDisplayName</key><string>Schaffer Desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Share this Mac's desktop with the Schaffer AI desktop portal.</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Finder metadata can be added automatically to app bundles inside Documents/iCloud.
# Remove only the two build-artifact attributes codesign forbids; keep quarantine intact.
/usr/bin/xattr -dr com.apple.FinderInfo "$app_path" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.ResourceFork "$app_path" 2>/dev/null || true
/usr/bin/codesign --force --sign - "$app_path"
printf '%s\n' "$app_path"
