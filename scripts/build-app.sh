#!/bin/bash
# Builds AniTrack.app from the Widevine Electron installed in node_modules, then installs it
# to ~/Applications. Run from the project folder with:  npm run app   (or: bash scripts/build-app.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
command -v npm >/dev/null 2>&1 || { echo "Node.js was not found. Install it from https://nodejs.org and try again."; exit 1; }

SRC="node_modules/electron/dist/Electron.app"
[ -d "$SRC" ] || npm install
[ -d "$SRC" ] || { echo "Could not find $SRC after npm install."; exit 1; }

OUT="dist/AniTrack.app"
rm -rf dist && mkdir -p dist
cp -R "$SRC" "$OUT"

APP="$OUT/Contents/Resources/app"
mkdir -p "$APP"
cp -R package.json src renderer "$APP/"

PLIST="$OUT/Contents/Info.plist"
setkey() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
setkey CFBundleName AniTrack
setkey CFBundleDisplayName AniTrack
setkey CFBundleIdentifier com.anitrack.app

if [ -f build/icon.png ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/AniTrack.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AniTrack.icns"
  setkey CFBundleIconFile AniTrack
fi

# Changing the bundle breaks its original signature; an ad-hoc signature lets macOS run it.
xattr -cr "$OUT" 2>/dev/null || true
codesign --force --deep --sign - "$OUT"

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/AniTrack.app"
cp -R "$OUT" "$HOME/Applications/"
echo
echo "Installed: $HOME/Applications/AniTrack.app"
echo "Open it from Finder (Go > Applications is /Applications; yours is in your home folder's Applications), Spotlight, or drag it to the Dock."
open "$HOME/Applications/AniTrack.app"
