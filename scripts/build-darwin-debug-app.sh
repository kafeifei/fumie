#!/usr/bin/env bash
# Build and install an unminified, source-mapped Fumie Debug.app for daily use.
# The outer app is a small signed launcher; the nested runtime is VS Code's
# normal Darwin package. Model Providers stay in the profile configuration and
# secret storage; the launcher never injects their values. Package builds are
# receipt-driven: unchanged inputs reuse the package, src-only changes rebuild
# the core, and all other changes automatically take the complete build path.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "Fumie Debug.app can only be built on macOS." >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ARCH="$(uname -m)"
case "$ARCH" in
	arm64|x64) ;;
	*) echo "Unsupported Darwin architecture: $ARCH" >&2; exit 1 ;;
esac

# NODE_BINARY (also placed first on PATH) and NATIVE_RUNTIME_BINARIES; shared
# with scripts/fumie-worktree-provision.sh so neither can drift.
FUMIE_BUILD_ROOT="$ROOT" FUMIE_BUILD_ARCH="$ARCH" . "$ROOT/scripts/fumie-build-env.sh"

export FUMIE_DEBUG_STATE_ARCH="$ARCH"
export FUMIE_DEBUG_STATE_NODE_VERSION="$("$NODE_BINARY" --version)"
echo "[fumie-debug] using Node $FUMIE_DEBUG_STATE_NODE_VERSION at $NODE_BINARY" >&2

DEFAULT_INSTALL_APP="/Applications/Fumie Debug.app"
INSTALL_APP="$DEFAULT_INSTALL_APP"
PROFILE="${HOME}/Library/Application Support/Fumie Debug"
SOURCE_PROFILE="${HOME}/Library/Application Support/Fumie"
BUILD_MODE="auto"
WITH_SOURCEMAPS=0
PROVISION_ARGS=()

while (( $# )); do
	case "$1" in
		--skip-build) BUILD_MODE="skip"; shift ;;
		--full-build) BUILD_MODE="full"; shift ;;
		--incremental-build) BUILD_MODE="incremental"; shift ;;
		--with-sourcemaps) WITH_SOURCEMAPS=1; shift ;;
		--allow-dependency-drift) PROVISION_ARGS+=("$1"); shift ;;
		--output) INSTALL_APP="$2"; shift 2 ;;
		--profile) PROFILE="$2"; shift 2 ;;
		--source-profile) SOURCE_PROFILE="$2"; shift 2 ;;
		*) echo "Unknown argument: $1" >&2; exit 2 ;;
	esac
done

# A git worktree is created as pure source. Give it the main checkout's already
# installed node_modules and .build downloads before anything asks for them;
# the script is idempotent and a no-op in the main checkout.
if [[ -f "$ROOT/.git" ]]; then
	"$ROOT/scripts/fumie-worktree-provision.sh" ${PROVISION_ARGS+"${PROVISION_ARGS[@]}"}
fi

# Extensions that ship in the build but not in Fumie Debug. The list is empty:
# Fumie currently ships every built-in extension the build produces
# (mermaid-markdown-features included -- the chat's renderMermaidDiagram tool
# needs it). Names are validated against the expected set, so a rename here
# fails the build instead of quietly putting the extension back.
EXTENSION_DROP_LIST=()

# The single source of truth is build/lib/extensions.ts, next to the filters the
# packaging streams apply. `--entries` adds the shared node_modules folder that
# ships beside the extensions.
expected_extension_entries() {
	local dropped
	dropped="$(IFS=,; echo "${EXTENSION_DROP_LIST[*]+${EXTENSION_DROP_LIST[*]}}")"
	if [[ "${1:-}" == "--with-dropped" ]]; then
		dropped=""
	fi
	"$NODE_BINARY" "$ROOT/build/fumie/expectedBuiltinExtensions.ts" --drop "$dropped" --entries --format lines
}

# A build that ships a subset of the extensions installs and signs cleanly and
# only fails at runtime: on 2026-09-04 a failed extension compile left seven
# entries behind and the package was installed anyway.
verify_extension_set() {
	local directory="$1" label="$2" expected difference
	shift 2
	expected="$(expected_extension_entries "$@" | LC_ALL=C sort)"
	difference="$(diff <(printf '%s\n' "$expected") <(ls -1 "$directory" | LC_ALL=C sort) || true)"
	if [[ -n "$difference" ]]; then
		echo "$label has the wrong extension set ($directory):" >&2
		printf '%s\n' "$difference" | sed 's/^</  missing: /;s/^>/  unexpected: /' >&2
		return 1
	fi
	return 0
}

# Serialize the complete build/install transaction per output target. The lock
# lives outside the bundle so replacing the app cannot reset the sequence or
# allow an older concurrent build to overwrite a newer one.
INSTALL_NAME="$(basename "$INSTALL_APP")"
INSTALL_PARENT="$(dirname "$INSTALL_APP")"
mkdir -p "$INSTALL_PARENT"
INSTALL_PARENT="$(cd "$INSTALL_PARENT" && pwd -P)"
INSTALL_APP="$INSTALL_PARENT/$INSTALL_NAME"
BUILD_STATE_DIR="$INSTALL_PARENT/.$INSTALL_NAME.build-state"
mkdir -p "$BUILD_STATE_DIR"
exec 9>"$BUILD_STATE_DIR/lock"
python3 - 9 "$INSTALL_APP" <<'PY'
import fcntl
import sys

lock_fd = int(sys.argv[1])
install_app = sys.argv[2]
try:
	fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
	print(f"Another Fumie Debug build is already targeting {install_app}.", file=sys.stderr)
	raise SystemExit(1)
PY

PRODUCT_NAME="$($NODE_BINARY -p "require('$ROOT/product.json').nameLong")"
SOURCE_APP="$(cd "$ROOT/.." && pwd -P)/VSCode-darwin-$ARCH/$PRODUCT_NAME.app"
PACKAGE_STATE_DIR="$ROOT/.build/fumie-debug"
PACKAGE_STATE_FILE="$PACKAGE_STATE_DIR/package-state-$ARCH.json"
PACKAGE_STATE_HELPER="$ROOT/scripts/fumie-debug-package-state.py"
mkdir -p "$PACKAGE_STATE_DIR"
exec 8>"$PACKAGE_STATE_DIR/package.lock"
python3 - 8 <<'PY'
import fcntl
import sys

lock_fd = int(sys.argv[1])
try:
	fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
	print("Another Fumie Debug package build is already running.", file=sys.stderr)
	raise SystemExit(1)
PY

native_deps_fingerprint() {
	local entry path
	for entry in "${NATIVE_RUNTIME_BINARIES[@]}"; do
		path="$ROOT/node_modules/$entry"
		if [[ -f "$path" ]]; then
			stat -f "%z %m $entry" "$path" || echo "MISSING $entry"
		else
			echo "MISSING $entry"
		fi
	done
}

verify_packaged_native_binaries() {
	local app_unpacked="$1/Contents/Resources/app/node_modules.asar.unpacked" entry path bad=0
	for entry in "${NATIVE_RUNTIME_BINARIES[@]}"; do
		path="$app_unpacked/$entry"
		if [[ ! -f "$path" ]]; then
			echo "Packaged runtime is missing native binary: $entry" >&2
			bad=1
		elif [[ "$entry" != *.node && ! -x "$path" ]]; then
			echo "Packaged native helper is not executable: $entry" >&2
			bad=1
		fi
	done
	return "$bad"
}

EFFECTIVE_BUILD_MODE="$BUILD_MODE"
if [[ "$BUILD_MODE" == "auto" || "$BUILD_MODE" == "incremental" ]]; then
	if [[ -d "$SOURCE_APP" ]]; then
		classified_mode="$($PACKAGE_STATE_HELPER classify "$ROOT" "$PACKAGE_STATE_FILE")"
	else
		classified_mode="full"
	fi
	case "$classified_mode" in
		unchanged)
			if [[ "$BUILD_MODE" == "incremental" ]]; then
				EFFECTIVE_BUILD_MODE="core"
			else
				EFFECTIVE_BUILD_MODE="unchanged"
			fi
			;;
		core) EFFECTIVE_BUILD_MODE="core" ;;
		full)
			EFFECTIVE_BUILD_MODE="full"
			if [[ "$BUILD_MODE" == "incremental" ]]; then
				echo "[fumie-debug] incremental inputs are not reusable; falling back to a full build." >&2
			fi
			;;
		*) echo "Invalid package-state classification: $classified_mode" >&2; exit 1 ;;
	esac
fi

PACKAGE_SOURCE_STATE=""
ADVANCE_PACKAGE_STATE=0
if [[ "$EFFECTIVE_BUILD_MODE" != "skip" ]]; then
	package_source_state_before="$($PACKAGE_STATE_HELPER snapshot "$ROOT")"
	native_deps_before="$(native_deps_fingerprint)"
	if [[ "$EFFECTIVE_BUILD_MODE" != "unchanged" && "$native_deps_before" == *MISSING* ]]; then
		echo "node_modules is missing native binaries (npm install/rebuild still running?); refusing to package:" >&2
		printf '%s\n' "$native_deps_before" | grep '^MISSING' >&2
		exit 1
	fi
	case "$EFFECTIVE_BUILD_MODE" in
		full)
			echo "[fumie-debug] building complete unminified Darwin $ARCH package with sourcemaps..." >&2
			(cd "$ROOT" && npm run gulp "vscode-darwin-$ARCH")
			echo "[fumie-debug] rebuilding Copilot as an unminified linked-sourcemap bundle..." >&2
			(cd "$ROOT" && npm --prefix extensions/copilot run compile)
			echo "[fumie-debug] compiling tunnel CLI (cargo build --release)..." >&2
			(cd "$ROOT/cli" && cargo build --release)
			echo "[fumie-debug] bundling sessions web for mobile..." >&2
			(cd "$ROOT" && node --experimental-strip-types build/next/index.ts bundle --target web --minify --out out-fumie-web)
			;;
		core)
			# The core path never rebuilds extensions, it only re-packages
			# whatever .build/extensions holds. Check the whole set: the previous
			# guard only asked whether copilot's dist existed, so the leftovers of
			# an aborted extension build sailed straight into the package.
			if ! verify_extension_set "$ROOT/.build/extensions" "The incremental extension build" --with-dropped \
				|| [[ ! -f "$ROOT/extensions/copilot/dist/extension.js.map" ]]; then
				echo "[fumie-debug] incremental extension artifacts are incomplete; running a full build." >&2
				(cd "$ROOT" && npm run gulp "vscode-darwin-$ARCH")
				(cd "$ROOT" && npm --prefix extensions/copilot run compile)
			else
				echo "[fumie-debug] rebuilding only the core bundle and Darwin package..." >&2
				(cd "$ROOT" && npm run gulp copy-codicons)
				mkdir -p "$ROOT/out-build"
				git -C "$ROOT" log -1 --format=%cI HEAD > "$ROOT/out-build/date"
				(cd "$ROOT" && "$NODE_BINARY" build/next/index.ts bundle --out out-vscode --target desktop --nls)
				# `src/` feeds the phone as well as the desktop. Leaving this out
				# shipped a package whose desktop half carried the change and
				# whose mobile half was whatever the last complete build left
				# behind — a fix that looked installed and was not.
				echo "[fumie-debug] re-bundling sessions web for mobile..." >&2
				(cd "$ROOT" && "$NODE_BINARY" build/next/index.ts bundle --target web --minify --out out-fumie-web)
				(cd "$ROOT" && npm run gulp "vscode-darwin-$ARCH-ci")
			fi
			;;
		unchanged)
			echo "[fumie-debug] package inputs unchanged; reusing the current Darwin package." >&2
			;;
	esac
	PACKAGE_SOURCE_STATE="$($PACKAGE_STATE_HELPER snapshot "$ROOT")"
	if [[ "$PACKAGE_SOURCE_STATE" != "$package_source_state_before" ]]; then
		echo "Fumie sources changed while the package was being prepared; refusing a stale install." >&2
		exit 1
	fi
	if [[ "$EFFECTIVE_BUILD_MODE" != "unchanged" && "$(native_deps_fingerprint)" != "$native_deps_before" ]]; then
		echo "node_modules changed while the package was being built (concurrent npm install?); refusing a stale install." >&2
		exit 1
	fi
	ADVANCE_PACKAGE_STATE=1
fi

if [[ ! -d "$SOURCE_APP" ]]; then
	echo "Missing packaged runtime: $SOURCE_APP" >&2
	echo "Run with --full-build first." >&2
	exit 1
fi
SOURCE_FRAMEWORKS="$SOURCE_APP/Contents/Frameworks"
if [[ ! -d "$SOURCE_FRAMEWORKS" ]]; then
	echo "Missing packaged Electron frameworks: $SOURCE_FRAMEWORKS" >&2
	exit 1
fi
SOURCE_BUILTIN_EXTENSIONS="$SOURCE_APP/Contents/Resources/app/extensions"
if [[ ! -d "$SOURCE_BUILTIN_EXTENSIONS" ]]; then
	echo "Missing packaged builtin extensions: $SOURCE_BUILTIN_EXTENSIONS" >&2
	exit 1
fi

if ! verify_packaged_native_binaries "$SOURCE_APP"; then
	echo "Refusing to install an incomplete package. Re-run with --full-build once npm install has finished." >&2
	exit 1
fi

if ! verify_extension_set "$SOURCE_BUILTIN_EXTENSIONS" "The packaged runtime" --with-dropped; then
	echo "Refusing to install a package that does not carry every built-in extension. Re-run with --full-build." >&2
	exit 1
fi

# The Copilot production bundle externalizes several debug helpers, while the
# regular release package intentionally omits devDependencies. Fumie Debug keeps
# them so extension-host stack traces resolve through its sourcemaps.
COPILOT_MODULES="$SOURCE_APP/Contents/Resources/app/extensions/copilot/node_modules"
COPILOT_DIST="$SOURCE_APP/Contents/Resources/app/extensions/copilot/dist"
COPILOT_PRODUCTION_DIST="$ROOT/.build/extensions/copilot/dist"
COPILOT_DEBUG_DIST="$ROOT/extensions/copilot/dist"
if [[ ! -f "$ROOT/extensions/copilot/dist/extension.js.map" ]]; then
	echo "Missing Copilot debug sourcemap. Run with --full-build first." >&2
	exit 1
fi
if [[ ! -d "$COPILOT_PRODUCTION_DIST" ]]; then
	echo "Missing packaged Copilot runtime: $COPILOT_PRODUCTION_DIST" >&2
	echo "Run with --full-build first." >&2
	exit 1
fi

# The development bundle also contains test, sanity, simulation, web, and stale
# CLI entry points that the production extension intentionally excludes. Keep
# the production package's file set as the runtime allowlist, then replace only
# its JavaScript with the unminified build and add the matching sourcemaps.
rm -rf "$COPILOT_DIST"
/usr/bin/ditto --clone "$COPILOT_PRODUCTION_DIST" "$COPILOT_DIST"
while IFS= read -r -d '' copilot_runtime_js; do
	copilot_relative_path="${copilot_runtime_js#"$COPILOT_PRODUCTION_DIST/"}"
	copilot_debug_js="$COPILOT_DEBUG_DIST/$copilot_relative_path"
	if [[ ! -f "$copilot_debug_js" ]]; then
		echo "Missing Copilot debug runtime entry: $copilot_debug_js" >&2
		exit 1
	fi
	mkdir -p "$(dirname "$COPILOT_DIST/$copilot_relative_path")"
	/usr/bin/ditto "$copilot_debug_js" "$COPILOT_DIST/$copilot_relative_path"
	if [[ -f "$copilot_debug_js.map" ]]; then
		/usr/bin/ditto "$copilot_debug_js.map" "$COPILOT_DIST/$copilot_relative_path.map"
	fi
done < <(find "$COPILOT_PRODUCTION_DIST" -type f -name '*.js' -print0)
mkdir -p "$COPILOT_MODULES"
for fumie_module in source-map-support buffer-from source-map dotenv; do
	module_source="$ROOT/extensions/copilot/node_modules/$fumie_module"
	if [[ ! -d "$module_source" ]]; then
		echo "Missing Copilot debug dependency: $module_source" >&2
		exit 1
	fi
	rm -rf "$COPILOT_MODULES/$fumie_module"
	/usr/bin/ditto "$module_source" "$COPILOT_MODULES/$fumie_module"
done

BUILTIN_EXTENSIONS_CACHE_ROOT="$BUILD_STATE_DIR/builtin-extensions"

# A running installed Fumie Debug owns these ports during normal iteration.
# Replacing its bundle is safe and intentionally does not control that process:
# the current runtime keeps running until the user next quits and launches it.
# Still reject unrelated listeners because a later launch would advertise ports
# that belong to another application.
RUNNING_INSTALL=0
for fumie_port in 9333 9334 9335 9336; do
	owner_pids="$(/usr/sbin/lsof -nP -t -iTCP:"$fumie_port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
	[[ -z "$owner_pids" ]] && continue

	while IFS= read -r owner_pid; do
		[[ -z "$owner_pid" ]] && continue
		owner_command="$(ps -p "$owner_pid" -o command= 2>/dev/null || true)"
		case "$owner_command" in
			"$INSTALL_APP/Contents/"*) RUNNING_INSTALL=1 ;;
			*)
				if [[ "$INSTALL_APP" != "$DEFAULT_INSTALL_APP" ]]; then
					# A side install exists to be inspected, not to take over the
					# daily app's endpoints. Say so instead of refusing: the
					# review build is
					# meant to be produced while the installed app keeps running.
					echo "[fumie-debug] warning: debug port $fumie_port belongs to another process; this side install advertises the same port and cannot be launched alongside it without an override." >&2
					continue
				fi
				echo "Debug port $fumie_port is already in use by another process; refusing to install an app whose advertised endpoint would be wrong." >&2
				exit 1
				;;
		esac
	done <<< "$owner_pids"
done

if [[ "$RUNNING_INSTALL" == "1" ]]; then
	echo "[fumie-debug] Fumie Debug is running; installing without stopping or restarting it." >&2
fi

if [[ ! -d "$PROFILE" ]]; then
	echo "[fumie-debug] seeding stable profile from $SOURCE_PROFILE" >&2
	mkdir -p "$PROFILE"
	if [[ -d "$SOURCE_PROFILE" ]]; then
		rsync -a \
			--exclude='logs/' \
			--exclude='Cache/' \
			--exclude='Code Cache/' \
			--exclude='GPUCache/' \
			--exclude='Dawn*Cache/' \
			--exclude='Crashpad/' \
			--exclude='Singleton*' \
			--exclude='*.lock' \
			--exclude='*.sock' \
			"$SOURCE_PROFILE/" "$PROFILE/"
	fi
fi
mkdir -p "$PROFILE/extensions" "$PROFILE/shared-data"

# Keep the native Codex home address for exact pre-isolation receipts only.
# New Fumie Codex sessions and auth live under FUMIE_HOME/providers/codex.
# Supply the native compatibility home only when no explicit home is configured.
node - "$PROFILE/User/settings.json" <<'NODE'
const fs = require('fs');
const path = require('path');

const settingsFile = process.argv[2];
const key = 'chat.agentHost.codexAgent.codexHome';
const desired = '~/.codex';
const migratedValues = new Set([
	'',
]);

let text;
try {
	text = fs.readFileSync(settingsFile, 'utf8');
} catch (error) {
	if (error.code !== 'ENOENT') {
		throw error;
	}
	text = '{}\n';
}

const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const property = new RegExp(`("${escapedKey}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")`);
const match = property.exec(text);
if (match) {
	const current = JSON.parse(match[2]);
	if (!migratedValues.has(current)) {
		process.exit(0);
	}
	text = text.replace(property, `$1${JSON.stringify(desired)}`);
} else {
	const closingBrace = text.lastIndexOf('}');
	const openingBrace = text.indexOf('{');
	if (openingBrace === -1 || closingBrace <= openingBrace) {
		throw new Error(`Cannot update invalid settings file: ${settingsFile}`);
	}
	const body = text.slice(openingBrace + 1, closingBrace)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.trim();
	const separator = body.length === 0 || body.endsWith(',') ? '' : ',';
	text = `${text.slice(0, closingBrace)}${separator}\n\t${JSON.stringify(key)}: ${JSON.stringify(desired)}\n${text.slice(closingBrace)}`;
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, text);
NODE

# Import the local Codex CLI's preferred model + effort once; this does not
# share its runtime config or auth with Fumie. Seed that exact pair into Fumie's
# model settings when it has no explicit value so
# the native ChatGPT catalog does not replace (for example) xhigh with the
# app-server model's generic low default. Later Fumie picker choices win.
"$NODE_BINARY" - "$PROFILE/User/chatLanguageModels.json" "${HOME}/.codex/config.toml" <<'NODE'
const fs = require('fs');
const path = require('path');

const [modelsFile, codexConfigFile] = process.argv.slice(2);
let codexConfig;
try {
	codexConfig = fs.readFileSync(codexConfigFile, 'utf8');
} catch (error) {
	if (error.code === 'ENOENT') {
		process.exit(0);
	}
	throw error;
}

function topLevelString(key) {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`^${escapedKey}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, 'm').exec(codexConfig);
	return match ? JSON.parse(match[1]) : undefined;
}

const model = topLevelString('model');
const effort = topLevelString('model_reasoning_effort');
const knownEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
if (!model || !knownEfforts.has(effort)) {
	process.exit(0);
}

let groups;
try {
	groups = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
} catch (error) {
	if (error.code !== 'ENOENT') {
		throw error;
	}
	groups = [];
}
if (!Array.isArray(groups)) {
	throw new Error(`Expected an array in ${modelsFile}`);
}

let group = groups.find(candidate => candidate?.vendor === 'agent-host-codex' && candidate?.name === 'Codex');
if (!group) {
	group = { name: 'Codex', vendor: 'agent-host-codex' };
	groups.push(group);
}
const modelId = `@provider=openai:${encodeURIComponent(model)}`;
if (!group.settings || typeof group.settings !== 'object' || Array.isArray(group.settings)) {
	group.settings = {};
}
const existingModelSettings = group.settings[modelId];
if (existingModelSettings && typeof existingModelSettings === 'object' && !Array.isArray(existingModelSettings) && existingModelSettings.thinkingLevel !== undefined) {
	process.exit(0);
}
group.settings[modelId] = {
	...(existingModelSettings && typeof existingModelSettings === 'object' && !Array.isArray(existingModelSettings) ? existingModelSettings : {}),
	thinkingLevel: effort,
};

fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
fs.writeFileSync(modelsFile, `${JSON.stringify(groups, null, 2)}\n`);
NODE

STAGE_ROOT="$(mktemp -d "$INSTALL_PARENT/.fumie-debug-stage.XXXXXX")"
STAGE_APP="$STAGE_ROOT/Fumie Debug.app"
PREVIOUS_APP="$STAGE_ROOT/previous.app"
cleanup() {
	if [[ -d "$PREVIOUS_APP" && ! -e "$INSTALL_APP" ]]; then
		mv "$PREVIOUS_APP" "$INSTALL_APP"
	fi
	rm -rf "$STAGE_ROOT"
}
trap cleanup EXIT

mkdir -p "$STAGE_APP/Contents/MacOS" "$STAGE_APP/Contents/Resources" "$STAGE_APP/Contents/Helpers"
RUNTIME_APP="$STAGE_APP/Contents/Helpers/Fumie Debug Runtime.app"
# Keep the signed/transactional staging layout without rewriting the entire
# runtime on APFS. `ditto` falls back to a regular copy when cloning is unavailable.
/usr/bin/ditto --clone "$SOURCE_APP" "$RUNTIME_APP"

WEB_BUNDLE_SRC="$ROOT/out-fumie-web"
WEB_BUNDLE_DEST="$RUNTIME_APP/Contents/Resources/app/web-bundle"
if [[ -d "$WEB_BUNDLE_SRC" ]]; then
	# The web bundle is not self-contained. `importAMDNodeModule` builds its
	# script URLs at runtime, so esbuild cannot see them and inlines nothing;
	# the client asks for them under `node_modules/` beside the bundle and, until
	# they were staged here, every one of those requests 404ed on the phone.
	# Named one file at a time: these packages carry tens of megabytes of
	# sources, maps and docs that the browser never asks for.
	#
	# Tree-sitter is deliberately absent. Its grammars are 21MB and the workbench
	# only reaches for them behind an opt-in setting, so shipping them would cost
	# every phone a large download for something none of them load.
	#
	# The list lives in build/fumie/webBundleNodeModules.json because the
	# headless server's package needs exactly the same files: two copies of it
	# would mean fixing a 404 on the phone and leaving it in place in the browser.
	WEB_BUNDLE_NODE_MODULES=()
	while IFS= read -r asset; do
		WEB_BUNDLE_NODE_MODULES+=("$asset")
	done < <("$NODE_BINARY" -e 'for (const asset of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) { console.log(asset); }' "$ROOT/build/fumie/webBundleNodeModules.json")
	if [[ ${#WEB_BUNDLE_NODE_MODULES[@]} -eq 0 ]]; then
		echo "[fumie-debug] build/fumie/webBundleNodeModules.json produced no assets; the phone will 404 on xterm, katex and the rest" >&2
	fi
	for asset in "${WEB_BUNDLE_NODE_MODULES[@]}"; do
		asset_src="$ROOT/node_modules/$asset"
		if [[ ! -e "$asset_src" ]]; then
			echo "[fumie-debug] warning: $asset is missing from node_modules; the phone will 404 on it" >&2
			continue
		fi
		asset_dest="$WEB_BUNDLE_SRC/node_modules/$asset"
		mkdir -p "$(dirname "$asset_dest")"
		/usr/bin/ditto "$asset_src" "$asset_dest"
	done
	/usr/bin/ditto "$WEB_BUNDLE_SRC" "$WEB_BUNDLE_DEST"
else
	echo "[fumie-debug] warning: web bundle not found at $WEB_BUNDLE_SRC; mobile web will be unavailable" >&2
fi

TUNNEL_CLI_SRC="$ROOT/cli/target/release/code"
TUNNEL_CLI_NAME="$("$NODE_BINARY" -e '
const fs = require("fs");
const name = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).tunnelApplicationName;
if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
	throw new Error("Invalid tunnelApplicationName in packaged product.json");
}
process.stdout.write(name);
' "$RUNTIME_APP/Contents/Resources/app/product.json")"
TUNNEL_CLI_DEST="$RUNTIME_APP/Contents/Resources/app/bin/$TUNNEL_CLI_NAME"
if [[ -f "$TUNNEL_CLI_SRC" ]]; then
	mkdir -p "$(dirname "$TUNNEL_CLI_DEST")"
	cp "$TUNNEL_CLI_SRC" "$TUNNEL_CLI_DEST"
	chmod 0755 "$TUNNEL_CLI_DEST"
else
	echo "[fumie-debug] tunnel CLI not found at $TUNNEL_CLI_SRC; refusing to package broken remote connections" >&2
	exit 1
fi

# Trim the staged copy only. The packaged runtime under VSCode-darwin-$ARCH stays
# the complete build so a later run still sees a full extension set instead of
# mistaking its own trimming for a broken build.
RUNTIME_EXTENSIONS="$RUNTIME_APP/Contents/Resources/app/extensions"
for dropped_extension in ${EXTENSION_DROP_LIST[@]+"${EXTENSION_DROP_LIST[@]}"}; do
	rm -rf "$RUNTIME_EXTENSIONS/$dropped_extension"
done

# Keep Debug and standalone packaging on the same dependency pruning rules.
"$NODE_BINARY" "$ROOT/scripts/prune-packaged-copilot.cjs" "$RUNTIME_APP/Contents/Resources/app"

if (( ! WITH_SOURCEMAPS )); then
	# 415MB of .map across out/ and web-bundle/, another ~67MB spread over the
	# Copilot bundle and the sourcemaps upstream packages ship. The unminified
	# JavaScript stays; the maps stay in the checkout's out-vscode and
	# out-fumie-web, where a debugger can still be pointed at them.
	stripped_maps=0
	while IFS= read -r -d '' sourcemap; do
		rm -f "$sourcemap"
		stripped_maps=$(( stripped_maps + 1 ))
	done < <(find "$RUNTIME_APP" -name '*.map' -type f -print0)
	echo "[fumie-debug] stripped $stripped_maps sourcemaps (pass --with-sourcemaps to keep them)" >&2
fi

if ! verify_extension_set "$RUNTIME_EXTENSIONS" "The staged runtime"; then
	echo "Refusing to install: trimming the staged package did not produce the expected extension set." >&2
	exit 1
fi

cp "$ROOT/resources/darwin/code.icns" "$STAGE_APP/Contents/Resources/Fumie Debug.icns"
cp "$ROOT/scripts/launch-darwin-debug-app.sh" "$STAGE_APP/Contents/Resources/launch-fumie-debug.sh"
chmod 0755 "$STAGE_APP/Contents/Resources/launch-fumie-debug.sh"

xcrun clang -Os -Wall -Wextra -Werror "$ROOT/scripts/darwin-debug-app-launcher.c" \
	-o "$STAGE_APP/Contents/MacOS/Fumie Debug"

IDENTITY="${CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n 1)}"
if [[ -z "$IDENTITY" ]]; then
	echo "No Developer ID Application identity is available; a daily-use debug app must be stably signed." >&2
	exit 1
fi

# Code OSS supports an explicit builtin-extension root. Move this large payload
# out of the signed runtime into an immutable content-addressed cache. Existing
# builds keep their cache while a new source package is assembled, and identical
# extension content is reused without another copy.
STAGED_BUILTIN_EXTENSIONS="$STAGE_ROOT/runtime-extensions"
mv "$RUNTIME_EXTENSIONS" "$STAGED_BUILTIN_EXTENSIONS"
# Fingerprint the trimmed payload, not the packaged runtime's untrimmed copy, or
# the cache entry would never match its own name on the next build.
BUILTIN_EXTENSIONS_FINGERPRINT="$($PACKAGE_STATE_HELPER fingerprint "$STAGED_BUILTIN_EXTENSIONS")"
BUILTIN_EXTENSIONS="$BUILTIN_EXTENSIONS_CACHE_ROOT/$BUILTIN_EXTENSIONS_FINGERPRINT"
if [[ -d "$BUILTIN_EXTENSIONS" ]]; then
	cached_extensions_fingerprint="$($PACKAGE_STATE_HELPER fingerprint "$BUILTIN_EXTENSIONS")"
	if [[ "$cached_extensions_fingerprint" != "$BUILTIN_EXTENSIONS_FINGERPRINT" ]]; then
		# The installed app writes into its own cache entry: the Copilot
		# extension re-downloads the CLI harness this script prunes, so the
		# second build after any app run used to abort here. Replace the drifted
		# entry with the freshly staged payload; the app still only ever
		# launches from an entry whose content matches its fingerprint. Move it
		# aside instead of deleting it, because a running app may have it open.
		stale_builtin_extensions="$BUILTIN_EXTENSIONS.stale-$(date -u '+%Y%m%dT%H%M%SZ')"
		if [[ -e "$stale_builtin_extensions" ]]; then
			stale_builtin_extensions="$stale_builtin_extensions.$$"
		fi
		mv "$BUILTIN_EXTENSIONS" "$stale_builtin_extensions"
		echo "[fumie-debug] builtin extension cache drifted at runtime; replacing $BUILTIN_EXTENSIONS_FINGERPRINT" >&2
	fi
fi
if [[ ! -d "$BUILTIN_EXTENSIONS" ]]; then
	mkdir -p "$BUILTIN_EXTENSIONS_CACHE_ROOT"
	mv "$STAGED_BUILTIN_EXTENSIONS" "$BUILTIN_EXTENSIONS"
fi

# Allocate after the candidate copy and signing identity are ready, but before
# the candidate is stamped. A failed build burns its number; gaps are allowed,
# reuse is not. The sidecar and installed bundle jointly provide the floor so a
# missing sidecar can recover from the last installed app.
FUMIE_DEBUG_BUILD_NUMBER="$(python3 - "$BUILD_STATE_DIR/last" "$INSTALL_APP" <<'PY'
import errno
import os
import plistlib
import sys
import tempfile

state_file, install_app = sys.argv[1:]

def parse_build_number(value, source):
	if isinstance(value, bool):
		raise ValueError(f"Invalid Fumie Debug build number in {source}: {value!r}")
	text = str(value)
	if not text.isascii() or not text.isdecimal() or text.startswith('0'):
		raise ValueError(f"Invalid Fumie Debug build number in {source}: {value!r}")
	return int(text)

persisted = 0
try:
	with open(state_file, encoding='ascii') as handle:
		persisted = parse_build_number(handle.read().strip(), state_file)
except FileNotFoundError:
	pass

installed = 0
installed_plist = os.path.join(install_app, 'Contents', 'Info.plist')
if os.path.lexists(install_app):
	try:
		with open(installed_plist, 'rb') as handle:
			metadata = plistlib.load(handle)
	except FileNotFoundError as error:
		raise ValueError(f"Cannot recover Fumie Debug build number: {installed_plist} is missing") from error
	value = metadata.get('FumieDebugBuildNumber', metadata.get('CFBundleVersion'))
	if value is None:
		raise ValueError(f"Cannot recover Fumie Debug build number: {installed_plist} has no build number")
	installed = parse_build_number(value, installed_plist)

next_build_number = max(persisted, installed) + 1
state_dir = os.path.dirname(state_file)
temporary_fd, temporary_path = tempfile.mkstemp(prefix='.last.', dir=state_dir, text=True)
try:
	with os.fdopen(temporary_fd, 'w', encoding='ascii') as handle:
		handle.write(f'{next_build_number}\n')
		handle.flush()
		os.fsync(handle.fileno())
	os.chmod(temporary_path, 0o600)
	os.replace(temporary_path, state_file)
	directory_fd = os.open(state_dir, os.O_RDONLY)
	try:
		try:
			os.fsync(directory_fd)
		except OSError as error:
			if error.errno not in (errno.EINVAL, errno.ENOTSUP):
				raise
	finally:
		os.close(directory_fd)
finally:
	if os.path.exists(temporary_path):
		os.unlink(temporary_path)

print(next_build_number)
PY
)"
echo "[fumie-debug] build number #$FUMIE_DEBUG_BUILD_NUMBER" >&2

# The plist records where this package came from. With worktrees in play the
# checkout path is no longer enough to say which branch is installed.
SOURCE_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
python3 - "$STAGE_APP/Contents/Info.plist" "$RUNTIME_APP/Contents/Info.plist" "$PROFILE" "$ROOT" "$NODE_BINARY" "$FUMIE_DEBUG_BUILD_NUMBER" "$BUILTIN_EXTENSIONS" "$SOURCE_BRANCH" <<'PY'
import json
import os
import plistlib
import sys

outer_plist, runtime_plist, profile, repo, node_binary, build_number, builtin_extensions, branch = sys.argv[1:]
outer = {
	'CFBundleDevelopmentRegion': 'en',
	'CFBundleDisplayName': 'Fumie Debug',
	'CFBundleExecutable': 'Fumie Debug',
	'CFBundleIconFile': 'Fumie Debug.icns',
	'CFBundleIdentifier': 'com.fumie.debug',
	'CFBundleInfoDictionaryVersion': '6.0',
	'CFBundleName': 'Fumie Debug',
	'CFBundlePackageType': 'APPL',
	'CFBundleShortVersionString': '1.0-debug',
	'CFBundleVersion': build_number,
	'LSApplicationCategoryType': 'public.app-category.developer-tools',
	'NSHighResolutionCapable': True,
	'FumieDebugBuildNumber': build_number,
}
with open(outer_plist, 'wb') as handle:
	plistlib.dump(outer, handle)

with open(runtime_plist, 'rb') as handle:
	runtime = plistlib.load(handle)
runtime['CFBundleDisplayName'] = 'Fumie Debug'
runtime['CFBundleIdentifier'] = 'com.fumie.debug.runtime'
for url_type in runtime.get('CFBundleURLTypes', []):
	url_type['CFBundleURLName'] = 'Fumie Debug'
	url_type['CFBundleURLSchemes'] = ['fumie-debug']
with open(runtime_plist, 'wb') as handle:
	plistlib.dump(runtime, handle)

config = {
	'Repo': repo,
	'Branch': branch,
	'UserDataDir': profile,
	'ExtensionsDir': os.path.join(profile, 'extensions'),
	'SharedDataDir': os.path.join(profile, 'shared-data'),
	'RendererCdpPort': 9333,
	'ExtensionHostPort': 9334,
	'MainProcessPort': 9335,
	'AgentHostPort': 9336,
	'BuildNumber': build_number,
	'NodeBinary': node_binary,
	'BuiltinExtensionsDir': builtin_extensions,
}
config_path = os.path.join(os.path.dirname(outer_plist), 'Resources', 'fumie-debug.plist')
with open(config_path, 'wb') as handle:
	plistlib.dump(config, handle)

product_path = os.path.join(os.path.dirname(runtime_plist), 'Resources', 'app', 'product.json')
with open(product_path, encoding='utf-8') as handle:
	product = json.load(handle)
product.update({
	'nameShort': 'Fumie Debug',
	'nameLong': 'Fumie Debug',
	'applicationName': 'fumie-debug',
	'dataFolderName': '.fumie',
	'urlProtocol': 'fumie-debug',
	'darwinBundleIdentifier': 'com.fumie.debug.runtime',
	'agentHostDefaultCodexHome': '~/.codex',
	'fumieDebugBuildNumber': build_number,
})
with open(product_path, 'w', encoding='utf-8') as handle:
	json.dump(product, handle, ensure_ascii=False, indent=2)
	handle.write('\n')
PY

# The outer candidate receives the single authoritative deep/strict verify.
"$ROOT/scripts/sign-darwin-dev-electron.sh" --force --skip-verify --app "$RUNTIME_APP"
codesign --force --sign "$IDENTITY" --timestamp=none --options runtime \
	--entitlements "$ROOT/scripts/darwin-dev-app-entitlements.plist" "$STAGE_APP/Contents/MacOS/Fumie Debug"
# The runtime is signed explicitly above and lives in a canonical nested-code
# directory, so signing the outer shell does not need to re-seal runtime resources.
codesign --force --sign "$IDENTITY" --timestamp=none --options runtime \
	--entitlements "$ROOT/scripts/darwin-dev-app-entitlements.plist" "$STAGE_APP"
codesign --verify --deep --strict "$STAGE_APP"

if [[ "$ADVANCE_PACKAGE_STATE" == "1" ]]; then
	if [[ "$($PACKAGE_STATE_HELPER snapshot "$ROOT")" != "$PACKAGE_SOURCE_STATE" ]]; then
		echo "Fumie sources changed while the signed candidate was being prepared; refusing a stale install." >&2
		exit 1
	fi
	"$PACKAGE_STATE_HELPER" write "$ROOT" "$PACKAGE_STATE_FILE"
fi

if [[ -e "$INSTALL_APP" ]]; then
	mv "$INSTALL_APP" "$PREVIOUS_APP"
fi
mv "$STAGE_APP" "$INSTALL_APP"
if [[ -d "$PREVIOUS_APP" ]]; then
	if [[ -x /usr/bin/trash ]]; then
		/usr/bin/trash "$PREVIOUS_APP"
	else
		rm -rf "$PREVIOUS_APP"
	fi
fi

trap - EXIT
rm -rf "$STAGE_ROOT"

# Entries the drift guard moved aside (and the one-off `.drifted` copy from
# recovering this by hand) are ~13GB of dead weight once the app installed above
# points at the freshly staged entry instead. Only fingerprint-shaped names
# carrying those suffixes are removed, never a live cache entry.
swept_extension_copies=0
for stale_builtin_extensions in "$BUILTIN_EXTENSIONS_CACHE_ROOT"/*.stale-* "$BUILTIN_EXTENSIONS_CACHE_ROOT"/*.drifted; do
	[[ -d "$stale_builtin_extensions" ]] || continue
	[[ "$(basename "$stale_builtin_extensions")" =~ ^[0-9a-f]{64}\.(stale-[0-9A-Za-z.-]+|drifted)$ ]] || continue
	rm -rf "$stale_builtin_extensions"
	swept_extension_copies=$(( swept_extension_copies + 1 ))
done
if (( swept_extension_copies )); then
	echo "[fumie-debug] builtin extension cache: removed $swept_extension_copies drifted copies" >&2
fi

# The builtin-extension cache is content addressed and was never pruned: 23
# fingerprints of ~600MB each had accumulated. Keep the one the installed app
# points at, plus the two most recent others so a quick revert to a previous
# build still finds its payload.
python3 - "$BUILTIN_EXTENSIONS_CACHE_ROOT" "$INSTALL_APP/Contents/Resources/fumie-debug.plist" <<'PY'
import os
import plistlib
import shutil
import sys

cache_root, installed_config = sys.argv[1:]

with open(installed_config, 'rb') as handle:
	in_use = plistlib.load(handle)['BuiltinExtensionsDir']

entries = [
	os.path.join(cache_root, name)
	for name in os.listdir(cache_root)
	if os.path.isdir(os.path.join(cache_root, name))
]
entries.sort(key=os.path.getmtime, reverse=True)

keep = {in_use}
for entry in entries:
	if len(keep) >= 3:
		break
	keep.add(entry)

freed = 0
for entry in entries:
	if entry in keep:
		continue
	freed += sum(
		os.path.getsize(os.path.join(walk_root, name))
		for walk_root, _, names in os.walk(entry)
		for name in names
		if not os.path.islink(os.path.join(walk_root, name))
	)
	shutil.rmtree(entry)

print(f"[fumie-debug] builtin extension cache: kept {len(keep)} of {len(entries)}, freed {freed // (1024 * 1024)}MB", file=sys.stderr)
PY

echo "[fumie-debug] installed $INSTALL_APP" >&2
echo "[fumie-debug] build #$FUMIE_DEBUG_BUILD_NUMBER" >&2
echo "[fumie-debug] profile $PROFILE" >&2
echo "[fumie-debug] debug endpoints renderer=9333 extensionHost=9334 main=9335 agentHost=9336" >&2
