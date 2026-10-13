#!/bin/bash
# Builds AniTrack.app from the Widevine Electron installed in node_modules, then installs it
# to ~/Applications. Run from the project folder with:  npm run app   (or: bash scripts/build-app.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
for p in /opt/homebrew/bin /usr/local/bin; do [ -d "$p" ] && PATH="$p:$PATH"; done
command -v npm >/dev/null 2>&1 || { echo "Node.js was not found. Install it from https://nodejs.org and try again."; exit 1; }

SRC="node_modules/electron/dist/Electron.app"
[ -d node_modules/electron ] || npm install
# The castlabs (Widevine) Electron package does not download itself on npm install; its installer
# fetches the framework for this Mac (or for npm_config_arch, when building for the other kind of Mac).
[ -d "$SRC" ] || node node_modules/electron/install.js
[ -d "$SRC" ] || { echo "Could not download Electron into $SRC."; exit 1; }

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

xattr -cr "$OUT" 2>/dev/null || true

# Widevine (VMP) signature, which Crunchyroll's copy protection needs before it plays video in the app.
# Uses castlabs' free EVS service: VMP_SIGN=1 after logging in with `python3 -m castlabs_evs.account reauth`.
# It has to come before the Apple signature below.
# The marker tells the app it may play Crunchyroll in its own window; without it, Watch opens the browser.
if [ -n "${VMP_SIGN:-}" ]; then
  touch "$OUT/Contents/Resources/vmp-signed"
  python3 -m castlabs_evs.vmp -n sign-pkg "$OUT"
fi

# Changing the bundle breaks its original signature; an ad-hoc signature lets macOS run it.
codesign --force --deep --sign - "$OUT"

# NO_INSTALL=1 (used by the GitHub build) stops here and leaves the app in dist/.
if [ -n "${NO_INSTALL:-}" ]; then
  echo "Built $OUT"
  exit 0
fi

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/AniTrack.app"
cp -R "$OUT" "$HOME/Applications/"
echo
echo "Installed: $HOME/Applications/AniTrack.app"
echo "Open it from Finder (Go > Applications is /Applications; yours is in your home folder's Applications), Spotlight, or drag it to the Dock."
open "$HOME/Applications/AniTrack.app"
