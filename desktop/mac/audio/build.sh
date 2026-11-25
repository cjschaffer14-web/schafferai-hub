#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_path=${1:-"$source_dir/build/SchafferDesktopAudio.app"}
mkdir -p "$app_path/Contents/MacOS" "$source_dir/build/swift-cache"
xcrun swiftc -swift-version 5 -O -target arm64-apple-macosx14.0 \
  -module-cache-path "$source_dir/build/swift-cache" \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
  -framework CoreMedia -framework CoreAudio -framework AudioToolbox -framework AVFoundation \
  "$source_dir/main.swift" -o "$app_path/Contents/MacOS/SchafferDesktopAudio"
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>SchafferDesktopAudio</string>
<key>CFBundleIdentifier</key><string>com.schafferai.desktop-audio</string>
<key>CFBundleName</key><string>Schaffer Desktop Audio</string>
<key>CFBundleDisplayName</key><string>Schaffer Desktop Audio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Send this Mac's system audio to a connected Schaffer AI desktop portal when Sound is enabled.</string>
<key>NSAudioCaptureUsageDescription</key><string>Send system sound to the connected desktop portal only while Sound is enabled.</string>
</dict></plist>
PLIST
/usr/bin/xattr -dr com.apple.FinderInfo "$app_path" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.ResourceFork "$app_path" 2>/dev/null || true
/usr/bin/codesign --force --sign - "$app_path"
printf '%s\n' "$app_path"
