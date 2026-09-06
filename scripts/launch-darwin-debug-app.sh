#!/usr/bin/env bash
# Runtime launcher embedded in Fumie Debug.app. The installed app contains an
# unminified packaged runtime with inline-source sourcemaps. Model Providers are
# loaded from the Fumie Debug profile and its secret storage.
set -euo pipefail

fail() {
	local message="$1"
	/usr/bin/osascript \
		-e 'on run argv' \
		-e 'display alert "Fumie Debug" message (item 1 of argv) as critical' \
		-e 'end run' \
		"$message" >/dev/null 2>&1 || true
	echo "[fumie-debug] $message" >&2
	exit 1
}

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CONFIG="$CONTENTS_DIR/Resources/fumie-debug.plist"
[[ -f "$CONFIG" ]] || fail "Missing Fumie Debug launch configuration. Re-run scripts/build-darwin-debug-app.sh."

plist_value() {
	/usr/libexec/PlistBuddy -c "Print :$1" "$CONFIG"
}

REPO="$(plist_value Repo)"
PROFILE="$(plist_value UserDataDir)"
EXTENSIONS="$(plist_value ExtensionsDir)"
SHARED_DATA="$(plist_value SharedDataDir)"
CDP_PORT="$(plist_value RendererCdpPort)"
EXT_HOST_PORT="$(plist_value ExtensionHostPort)"
MAIN_PORT="$(plist_value MainProcessPort)"
AGENT_HOST_PORT="$(plist_value AgentHostPort)"
NODE_BINARY="$(plist_value NodeBinary)"
BUILTIN_EXTENSIONS="$(plist_value BuiltinExtensionsDir)"

# Cursor-style split layout: Electron state remains in PROFILE while Fumie's
# durable agent state lives under one stable home. New data wins on conflicts;
# migrate missing legacy entries, then remove the old Fumie-owned root.
umask 077
export FUMIE_HOME="${FUMIE_HOME:-$HOME/.fumie}"
mkdir -p "$FUMIE_HOME/plugins"

INJECT="$REPO/scripts/fumie-configure-agents.sh"
RUNTIME_APP="$CONTENTS_DIR/Helpers/Fumie Debug Runtime.app"
RUNTIME="$RUNTIME_APP/Contents/MacOS/Fumie"

[[ -x "$INJECT" ]] || fail "The Fumie checkout is unavailable at $REPO. The debug app intentionally keeps provider credentials and source files outside the bundle."
[[ -x "$RUNTIME" ]] || fail "The packaged Fumie runtime is missing. Re-run scripts/build-darwin-debug-app.sh."
[[ -x "$NODE_BINARY" ]] || fail "The Node.js runtime recorded when Fumie Debug was built is unavailable at $NODE_BINARY. Re-run scripts/build-darwin-debug-app.sh."
[[ -d "$BUILTIN_EXTENSIONS" ]] || fail "The packaged builtin extensions are unavailable at $BUILTIN_EXTENSIONS. Re-run scripts/build-darwin-debug-app.sh."

# Port ownership matters when the runtime starts, not while a new bundle is
# being prepared. Keeping this check here lets the installer stage and verify a
# candidate while the current Fumie Debug process continues running.
for fumie_port in "$CDP_PORT" "$EXT_HOST_PORT" "$MAIN_PORT" "$AGENT_HOST_PORT"; do
	if /usr/sbin/lsof -nP -iTCP:"$fumie_port" -sTCP:LISTEN >/dev/null 2>&1; then
		fail "Debug port $fumie_port is already in use. Quit the existing Fumie Debug instance before launching this build."
	fi
done

# Finder launches GUI apps with a minimal PATH. The runtime setup uses Node
# to merge the profile settings, so prepend the build-recorded absolute runtime
# instead of depending on whichever shell happened to launch the app.
export PATH="$(dirname "$NODE_BINARY"):/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$PROFILE" "$EXTENSIONS" "$SHARED_DATA" "$PROFILE/logs"
cat > "$PROFILE/debug-endpoints.json" <<EOF
{
	"rendererCdp": $CDP_PORT,
	"extensionHost": $EXT_HOST_PORT,
	"mainProcess": $MAIN_PORT,
	"agentHost": $AGENT_HOST_PORT,
	"pid": $$
}
EOF

export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1
# The formal package is a built product and therefore does not use the source
# checkout's devDependency fallback. This debug distribution deliberately
# points both official SDK loaders back at the checkout it was built from.
export VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT="$REPO"
export VSCODE_AGENT_HOST_CODEX_SDK_ROOT="$REPO"
# GUI launches must not inherit a temporary CODEX_HOME from the terminal that
# built or opened the app. The profile setting remains authoritative and the
# debug-build default is ~/.codex, so users can still choose another home there.
unset CODEX_HOME
unset ELECTRON_RUN_AS_NODE

exec >>"$PROFILE/logs/launcher.log" 2>&1
echo "[fumie-debug] launch $(date -u +%Y-%m-%dT%H:%M:%SZ) pid=$$ cdp=$CDP_PORT extHost=$EXT_HOST_PORT main=$MAIN_PORT agentHost=$AGENT_HOST_PORT"

exec /bin/bash "$INJECT" --exec -- "$RUNTIME" \
	--agents \
	"--user-data-dir=$PROFILE" \
	"--extensions-dir=$EXTENSIONS" \
	"--builtin-extensions-dir=$BUILTIN_EXTENSIONS" \
	"--shared-data-dir=$SHARED_DATA" \
	"--remote-debugging-port=$CDP_PORT" \
	"--inspect-extensions=$EXT_HOST_PORT" \
	"--inspect=$MAIN_PORT" \
	"--inspect-agenthost=$AGENT_HOST_PORT"
