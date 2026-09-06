#!/usr/bin/env bash
# Point the source Electron's default_app (Dock / Finder launch with no
# repo path) at scripts/fumie-configure-agents.sh then
# scripts/code.sh --agents. Bare Electron / missing injector used to open
# Agents with only default Anthropic/OpenAI models. code.sh itself passes
# `.` as the app path, so it never loads default_app and is unaffected.
#
# Do NOT install Contents/Resources/app — that makes the .app look packaged
# and Electron ignores the repo path from code.sh.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
NAME="$(node -p "require('$ROOT/product.json').nameLong")"
APP="$ROOT/.build/electron/$NAME.app"
SRC="$ROOT/scripts/darwin-dev-electron-dock-app"
ASAR="$APP/Contents/Resources/default_app.asar"
PLIST="$APP/Contents/Info.plist"

if [[ ! -d "$APP" ]]; then
	echo "[install-darwin-dev-electron-dock-app] no app at $APP; skip" >&2
	exit 0
fi
if [[ ! -f "$SRC/main.js" || ! -f "$SRC/package.json" ]]; then
	echo "[install-darwin-dev-electron-dock-app] missing stub sources in $SRC" >&2
	exit 1
fi

# A leftover Resources/app shadows code.sh's `.` argument and quits the
# VSCODE_DEV launch. Always strip it.
if [[ -e "$APP/Contents/Resources/app" ]]; then
	echo "[install-darwin-dev-electron-dock-app] removing Resources/app so code.sh can load the repo" >&2
	rm -rf "$APP/Contents/Resources/app"
fi

STAGE="$(mktemp -d /tmp/cod/dock-asar-XXXXXX)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$STAGE/app"
cp "$SRC/main.js" "$SRC/package.json" "$STAGE/app/"

PACKED="$STAGE/default_app.asar"
INSTALL_ROOT="$ROOT" INSTALL_SRC="$STAGE/app" INSTALL_DEST="$PACKED" node <<'NODE'
const path = require('path');
const root = process.env.INSTALL_ROOT;
const src = process.env.INSTALL_SRC;
const dest = process.env.INSTALL_DEST;
let asar;
for (const c of [
	path.join(root, 'node_modules/asar'),
	path.join(root, 'node_modules/@electron/asar'),
]) {
	try { asar = require(c); break; } catch { /* continue */ }
}
if (!asar || typeof asar.createPackage !== 'function') {
	console.error('[install-darwin-dev-electron-dock-app] asar.createPackage is not available');
	process.exit(1);
}
asar.createPackage(src, dest).catch((err) => {
	console.error(err);
	process.exit(1);
});
NODE

if [[ -f "$ASAR" ]] && cmp -s "$PACKED" "$ASAR"; then
	echo "[install-darwin-dev-electron-dock-app] default_app trampoline already installed" >&2
	exit 0
fi

cp "$PACKED" "$ASAR"
HASH="$(shasum -a 256 "$ASAR" | awk '{print $1}')"
python3 - "$PLIST" "$HASH" <<'PY'
import plistlib, sys
path, digest = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f: data = plistlib.load(f)
data['ElectronAsarIntegrity'] = data.get('ElectronAsarIntegrity') or {}
data['ElectronAsarIntegrity']['Resources/default_app.asar'] = {'algorithm': 'SHA256', 'hash': digest}
with open(path, 'wb') as f: plistlib.dump(data, f)
PY

echo "[install-darwin-dev-electron-dock-app] installed default_app trampoline (sha256=$HASH)" >&2
if [[ -x "$ROOT/scripts/sign-darwin-dev-electron.sh" ]]; then
	"$ROOT/scripts/sign-darwin-dev-electron.sh" --force
fi
