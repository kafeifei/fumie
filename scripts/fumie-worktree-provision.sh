#!/usr/bin/env bash
# Give a Fumie git worktree everything the Darwin packaging path needs, by
# cloning it out of the main checkout instead of downloading it again.
#
# Fumie's own worktrees are created as pure source (worktreeIsolation.ts strips
# node_modules), but `npm run gulp vscode-darwin-<arch>` needs every node_modules
# listed in build/npm/dirs.ts plus the version-keyed downloads under .build/.
# All of those are content-identical to the main checkout's, so an APFS clone
# (`cp -Rc`) supplies them in seconds and costs no disk.
#
# Idempotent: only missing directories are cloned. `--refresh` re-clones them
# all, which is what to use when a previous partial copy is suspect.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "fumie-worktree-provision.sh only supports macOS (it relies on APFS cloning)." >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ARCH="$(uname -m)"
REFRESH=0
ALLOW_DEPENDENCY_DRIFT=0

while (( $# )); do
	case "$1" in
		--refresh) REFRESH=1; shift ;;
		--allow-dependency-drift) ALLOW_DEPENDENCY_DRIFT=1; shift ;;
		*) echo "Unknown argument: $1" >&2; exit 2 ;;
	esac
done

FUMIE_BUILD_ROOT="$ROOT" FUMIE_BUILD_ARCH="$ARCH" . "$ROOT/scripts/fumie-build-env.sh"

START_SECONDS="$SECONDS"

# The main checkout is wherever the shared git directory lives; never a hard
# coded path, because worktrees are created under whichever clone is in use.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(cd "$(dirname "$GIT_COMMON_DIR")" && pwd -P)"

if [[ "$MAIN_ROOT" == "$ROOT" ]]; then
	echo "[provision] $ROOT is the main checkout; nothing to provision." >&2
	exit 0
fi

echo "[provision] worktree $ROOT" >&2
echo "[provision] main checkout $MAIN_ROOT" >&2

if [[ ! -f "$MAIN_ROOT/node_modules/.postinstall-state" ]]; then
	echo "The main checkout has no node_modules/.postinstall-state; run 'npm install' in $MAIN_ROOT first." >&2
	exit 1
fi

# Cloning the main checkout's node_modules is only sound while this branch wants
# the same dependencies. build/npm/installStateHash.ts already defines what
# "same" means (the normalized package.json / package-lock.json / .npmrc of every
# directory in dirs.ts), so ask it about both checkouts rather than inventing a
# second answer here. A branch that changed a manifest is a hard stop; a main
# checkout whose own manifests have drifted from its install receipt is only
# worth reporting, because its node_modules is what main builds with today.
"$NODE_BINARY" - "$ROOT" "$MAIN_ROOT" "$ALLOW_DEPENDENCY_DRIFT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [worktreeRoot, mainRoot, allowDrift] = process.argv.slice(2);

const load = async root => (await import(path.join(root, 'build/npm/installStateHash.ts')))
	.computeState({ ignoreNodeVersion: true }).fileHashes;

(async () => {
	const worktree = await load(worktreeRoot);
	const main = await load(mainRoot);
	const receipt = JSON.parse(fs.readFileSync(path.join(mainRoot, 'node_modules/.postinstall-state'), 'utf8')).fileHashes;

	const keysOf = (...maps) => [...new Set(maps.flatMap(Object.keys))].sort();

	const divergent = keysOf(worktree, main).filter(key => worktree[key] !== main[key]);
	if (divergent.length) {
		const prefix = allowDrift === '1' ? '[provision] ignoring dependency drift: ' : '';
		console.error(`${prefix}this worktree wants different dependencies than the main checkout:`);
		for (const key of divergent) {
			console.error(`  ${key} (${!(key in main) ? 'absent from the main checkout' : !(key in worktree) ? 'absent from this worktree' : 'changed on this branch'})`);
		}
		if (allowDrift !== '1') {
			console.error('');
			console.error('Cloning would give this worktree the wrong node_modules. Either land the');
			console.error('dependency change and run npm install in the main checkout, or — when the');
			console.error('difference is only lockfile metadata npm rewrote in place — re-run with');
			console.error('--allow-dependency-drift. Running npm install in this worktree also works.');
			process.exit(1);
		}
	}

	const stale = keysOf(main, receipt).filter(key => main[key] !== receipt[key]);
	for (const key of stale) {
		console.error(`[provision] note: the main checkout's ${key} has changed since its last npm install; cloning what it actually has installed`);
	}
})();
NODE

MAIN_NODE_VERSION="$("$NODE_BINARY" -p "JSON.parse(require('fs').readFileSync('$MAIN_ROOT/node_modules/.postinstall-state','utf8')).nodeVersion")"
echo "[provision] cloning the main checkout's dependencies (installed with Node $MAIN_NODE_VERSION)" >&2

# `cp -Rc` asks APFS to clone: the copy shares the original's blocks, so it is
# effectively instant and adds no disk usage until one side is written.
clone_into_worktree() {
	local relative="$1" source="$MAIN_ROOT/$1" destination="$ROOT/$1"

	if [[ ! -d "$source" ]]; then
		return 1
	fi
	if [[ -e "$destination" ]]; then
		if (( ! REFRESH )); then
			return 2
		fi
		rm -rf "$destination"
	fi

	mkdir -p "$(dirname "$destination")"
	cp -Rc "$source" "$destination"
	return 0
}

NODE_MODULES_DIRS=()
while IFS= read -r line; do
	NODE_MODULES_DIRS+=("$line")
done < <("$NODE_BINARY" - "$ROOT" <<'NODE'
const path = require('path');
const worktreeRoot = process.argv[2];

(async () => {
	const { dirs } = await import(path.join(worktreeRoot, 'build/npm/dirs.ts'));
	for (const dir of dirs) {
		console.log(dir === '' ? 'node_modules' : `${dir}/node_modules`);
	}
})();
NODE
)

# An interrupted earlier copy leaves a root node_modules that looks populated
# but is missing files nothing checks until the build fails. The install receipt
# is the last thing npm writes, so its absence marks the tree as unfinished.
if [[ -d "$ROOT/node_modules" && ! -f "$ROOT/node_modules/.postinstall-state" ]]; then
	echo "[provision] node_modules has no install receipt; re-cloning it" >&2
	rm -rf "$ROOT/node_modules"
fi

cloned=0
reused=0
absent=0
for relative in "${NODE_MODULES_DIRS[@]}"; do
	set +e
	clone_into_worktree "$relative"
	status=$?
	set -e
	case "$status" in
		0) cloned=$(( cloned + 1 )) ;;
		2) reused=$(( reused + 1 )) ;;
		# A dirs.ts entry with no node_modules in the main checkout has no
		# dependencies of its own; that is normal, not a failure.
		1) absent=$(( absent + 1 )) ;;
	esac
done

# Downloads under .build/ are keyed by version and architecture only — nothing
# in them depends on the checkout they were fetched into.
build_cloned=0
build_reused=0
for relative in .build/electron .build/electron-feed .build/node .build/node-runtime .build/agent-sdk .build/builtInExtensions; do
	set +e
	clone_into_worktree "$relative"
	status=$?
	set -e
	case "$status" in
		0) build_cloned=$(( build_cloned + 1 )) ;;
		2) build_reused=$(( build_reused + 1 )) ;;
	esac
done

# tsgo runs with --incremental (build/lib/tsgo.ts). A *.tsbuildinfo left behind
# by an earlier copy of this tree describes files at their old timestamps and
# makes tsgo report type errors that do not exist — on 2026-09-04 five phantom
# errors in html-language-features/server killed the extension build and the
# package shipped with seven extensions. These are gitignored build artifacts;
# deleting them only costs a cold typecheck.
stale_tsbuildinfo=0
while IFS= read -r -d '' buildinfo; do
	rm -f "$buildinfo"
	stale_tsbuildinfo=$(( stale_tsbuildinfo + 1 ))
done < <(find "$ROOT" -name '*.tsbuildinfo' -not -path '*/node_modules/*' -print0)

missing_native=0
for entry in "${NATIVE_RUNTIME_BINARIES[@]}"; do
	if [[ ! -f "$ROOT/node_modules/$entry" ]]; then
		echo "[provision] missing native binary: node_modules/$entry" >&2
		missing_native=1
	fi
done
if (( missing_native )); then
	echo "The provisioned node_modules is missing native binaries; the main checkout's install is incomplete." >&2
	exit 1
fi

echo "[provision] node_modules: $cloned cloned, $reused already present, $absent not installed in the main checkout" >&2
echo "[provision] .build downloads: $build_cloned cloned, $build_reused already present" >&2
echo "[provision] removed $stale_tsbuildinfo stale *.tsbuildinfo" >&2
echo "[provision] native runtime binaries present" >&2
echo "[provision] done in $(( SECONDS - START_SECONDS ))s" >&2
