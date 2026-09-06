#!/usr/bin/env bash
# Sign the source Electron (.build/electron/*.app) with a local Developer ID
# so macOS keychain ACLs stick across launches. Unsigned / ad-hoc Electron
# prompts for "fumie-dev Safe Storage" on every start.
#
# Identity: $CODESIGN_IDENTITY, else the first "Developer ID Application" in
# the default keychain. No-ops when missing, not on Darwin, or already signed.
set -eu

FORCE=0
SKIP_VERIFY=0
APP_OVERRIDE=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--force)
			FORCE=1
			shift
			;;
		--app)
			APP_OVERRIDE="$2"
			shift 2
			;;
		--skip-verify)
			SKIP_VERIFY=1
			shift
			;;
		*)
			echo "Usage: $0 [--force] [--skip-verify] [--app /path/to/App.app]" >&2
			exit 2
			;;
	esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
	exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
NAME="$(node -p "require('$ROOT/product.json').nameLong")"
APP="$ROOT/.build/electron/$NAME.app"
if [[ -n "$APP_OVERRIDE" ]]; then
	APP="$APP_OVERRIDE"
fi

if [[ ! -d "$APP" ]]; then
	exit 0
fi

pick_identity() {
	if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
		printf '%s\n' "$CODESIGN_IDENTITY"
		return 0
	fi
	security find-identity -v -p codesigning 2>/dev/null \
		| sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' \
		| head -n 1
}

IDENTITY="$(pick_identity || true)"
if [[ -z "$IDENTITY" ]]; then
	echo "[sign-darwin-dev-electron] no Developer ID Application identity; skip" >&2
	exit 0
fi

current_authority="$(codesign -dv --verbose=2 "$APP" 2>&1 | awk -F= '/^Authority=/{print substr($0, index($0,$2)); exit}' || true)"
has_dev_entitlements=0
if codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'disable-library-validation'; then
	has_dev_entitlements=1
fi
if [[ "$FORCE" != "1" && "$current_authority" == "$IDENTITY" && "$has_dev_entitlements" == "1" ]]; then
	echo "[sign-darwin-dev-electron] already signed as $IDENTITY" >&2
	exit 0
fi

ENT="$ROOT/scripts/darwin-dev-app-entitlements.plist"
sign_item() {
	local target="$1"
	echo "[sign-darwin-dev-electron] signing $target" >&2
	codesign --force --sign "$IDENTITY" --timestamp=none --options runtime \
		--entitlements "$ENT" "$target"
}

FW="$APP/Contents/Frameworks"
for dylib in \
	"$FW/Electron Framework.framework/Versions/A/Libraries/"*.dylib
do
	[[ -f "$dylib" ]] && sign_item "$dylib"
done
for fw in \
	"Electron Framework.framework" \
	"Mantle.framework" \
	"ReactiveObjC.framework" \
	"Squirrel.framework"
do
	[[ -d "$FW/$fw" ]] && sign_item "$FW/$fw"
done

sign_item "$FW/$NAME Helper.app"
sign_item "$FW/$NAME Helper (GPU).app"
sign_item "$FW/$NAME Helper (Renderer).app"
sign_item "$FW/$NAME Helper (Plugin).app"
sign_item "$APP"

if [[ "$SKIP_VERIFY" != "1" ]]; then
	codesign --verify --deep --strict "$APP"
fi
echo "[sign-darwin-dev-electron] signed $APP as $IDENTITY" >&2
