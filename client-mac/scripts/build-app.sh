#!/bin/bash
# Packages the Swift executable into a real .app bundle so macOS treats it
# like a normal application — Dock icon, Cmd+Tab, Mission Control all work.
# Without this, running the raw binary from `swift build` has none of that.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Software Center"
BUNDLE_ID="com.internal.softwarecenter"
BUILD_DIR=".build/debug"
APP_DIR="build/${APP_NAME}.app"

echo "Building..."
swift build

echo "Packaging ${APP_DIR}..."
rm -rf "build"
mkdir -p "${APP_DIR}/Contents/MacOS"
cp "${BUILD_DIR}/SoftwareCenter" "${APP_DIR}/Contents/MacOS/${APP_NAME}"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo "Done: ${APP_DIR}"
echo "Launch it with: open \"${APP_DIR}\""
