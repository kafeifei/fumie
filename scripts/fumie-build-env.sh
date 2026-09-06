# Shared build environment for the Fumie Debug packaging scripts.
# Source this with FUMIE_BUILD_ROOT and FUMIE_BUILD_ARCH already set:
#
#   FUMIE_BUILD_ROOT=... FUMIE_BUILD_ARCH=... . "$ROOT/scripts/fumie-build-env.sh"
#
# It defines NODE_BINARY (and puts it first on PATH) plus the
# NATIVE_RUNTIME_BINARIES list. Both are needed by the packaging script and by
# the worktree provisioning script, and a second copy of either would drift.

if [[ -z "${FUMIE_BUILD_ROOT:-}" || -z "${FUMIE_BUILD_ARCH:-}" ]]; then
	echo "fumie-build-env.sh requires FUMIE_BUILD_ROOT and FUMIE_BUILD_ARCH." >&2
	exit 1
fi

REQUIRED_NODE_VERSION="$(tr -d '[:space:]' < "$FUMIE_BUILD_ROOT/.nvmrc")"
node_version_is_compatible() {
	local candidate="$1"
	local actual
	actual="$("$candidate" --version 2>/dev/null || true)"
	actual="${actual#v}"
	python3 - "$REQUIRED_NODE_VERSION" "$actual" <<'PY'
import sys

try:
	required = tuple(int(part) for part in sys.argv[1].split('.'))
	actual = tuple(int(part) for part in sys.argv[2].split('.'))
except ValueError:
	raise SystemExit(1)
raise SystemExit(0 if actual[0] == required[0] and actual >= required else 1)
PY
}

NODE_BINARY=""
path_node="$(command -v node || true)"
for node_candidate in \
	"$path_node" \
	"${HOME}/.nvm/versions/node/v$REQUIRED_NODE_VERSION/bin/node" \
	"/opt/homebrew/opt/node@24/bin/node" \
	"${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
do
	if [[ -n "$node_candidate" && -x "$node_candidate" ]] && node_version_is_compatible "$node_candidate"; then
		NODE_BINARY="$node_candidate"
		break
	fi
done
if [[ -z "$NODE_BINARY" ]]; then
	echo "Fumie Debug requires Node.js major ${REQUIRED_NODE_VERSION%%.*} at version $REQUIRED_NODE_VERSION or newer; current PATH has ${path_node:-none}." >&2
	exit 1
fi
export PATH="$(dirname "$NODE_BINARY"):$PATH"

# Native binaries that must ship unpacked next to node_modules.asar. Losing any
# of them produces a package that installs cleanly but breaks at runtime
# (2026-08-28: a package built while npm was still rebuilding node_modules
# shipped without policy-watcher's .node → startup crash; spawn-helper left
# inside the asar → every Agent Host terminal failed on posix_spawn ENOENT).
NATIVE_RUNTIME_BINARIES=(
	"node-pty/prebuilds/darwin-$FUMIE_BUILD_ARCH/pty.node"
	"node-pty/prebuilds/darwin-$FUMIE_BUILD_ARCH/spawn-helper"
	"@vscode/policy-watcher/build/Release/vscode-policy-watcher.node"
	"@vscode/sqlite3/build/Release/vscode-sqlite3.node"
	"@vscode/fs-copyfile/build/Release/vscode_fs.node"
	"@parcel/watcher-darwin-$FUMIE_BUILD_ARCH/watcher.node"
	"@vscode/ripgrep-universal/bin/darwin-$FUMIE_BUILD_ARCH/rg"
	"@vscode/os-proxy-resolver-darwin-$FUMIE_BUILD_ARCH/os_proxy_resolver.node"
	"@github/copilot-darwin-$FUMIE_BUILD_ARCH/prebuilds/darwin-$FUMIE_BUILD_ARCH/runtime.node"
)
