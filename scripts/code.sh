#!/usr/bin/env bash

set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f $0)")")
	# If the script is running in Docker using the WSL2 engine, powershell.exe won't exist
	if grep -qi Microsoft /proc/version && type powershell.exe > /dev/null 2>&1; then
		IN_WSL=true
	fi
fi

function code() {
	cd "$ROOT"

	if [[ "$OSTYPE" == "darwin"* ]]; then
		NAME=`node -p "require('./product.json').nameLong"`
		EXE_NAME=`node -p "require('./product.json').nameShort"`
		CODE="./.build/electron/$NAME.app/Contents/MacOS/$EXE_NAME"
	else
		NAME=`node -p "require('./product.json').applicationName"`
		CODE=".build/electron/$NAME"
	fi

	# Get electron, compile, built-in extensions
	if [[ -z "${VSCODE_SKIP_PRELAUNCH}" ]]; then
		node build/lib/preLaunch.ts
	fi

	# Darwin source Electron ships ad-hoc signed; re-sign with a local
	# Developer ID so keychain ACLs persist (see scripts/sign-darwin-dev-electron.sh).
	# Install the Dock trampoline before signing so Keep-in-Dock launches Agents.
	if [[ "$OSTYPE" == "darwin"* ]]; then
		"$ROOT/scripts/install-darwin-dev-electron-dock-app.sh"
		"$ROOT/scripts/sign-darwin-dev-electron.sh"
	fi

	# Manage built-in extensions
	if [[ "$1" == "--builtin" ]]; then
		exec "$CODE" build/builtin
		return
	fi

	# Fumie source-build Agent runtime setup. Provider models and credentials
	# stay in the profile's Models configuration and secret storage.
	INJECT_SH="$ROOT/scripts/fumie-configure-agents.sh"
	FUMIE_LAUNCHING_AGENTS=0
	for fumie_arg in "$@"; do
		if [[ "$fumie_arg" == "--agents" ]]; then
			FUMIE_LAUNCHING_AGENTS=1
			break
		fi
	done
	if [[ ! -f "$INJECT_SH" ]]; then
		if [[ "$FUMIE_LAUNCHING_AGENTS" == "1" ]]; then
			echo "[code.sh] REFUSING to launch Agents: missing $INJECT_SH" >&2
			exit 1
		fi
	else
		# shellcheck disable=SC1091
		. "$INJECT_SH"
		fumie_configure_agents
		if [[ "$FUMIE_LAUNCHING_AGENTS" == "1" ]]; then
			fumie_require_agents_runtime || exit 1
			fumie_udd="$(fumie_user_data_dir_from_args "$@" || true)"
			if [[ -z "${fumie_udd:-}" && "$OSTYPE" == "darwin"* ]]; then
				fumie_udd="$HOME/Library/Application Support/Fumie"
			fi
			if [[ -n "${fumie_udd:-}" ]]; then
				fumie_merge_agent_settings "$fumie_udd/User/settings.json"
			fi
		fi
	fi

	# Configuration
	export NODE_ENV=development
	export VSCODE_DEV=1
	export VSCODE_CLI=1
	export ELECTRON_ENABLE_STACK_DUMPING=1
	export ELECTRON_ENABLE_LOGGING=1

	DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"
	if [[ "$@" == *"--extensionTestsPath"* ]]; then
		DISABLE_TEST_EXTENSION=""
	fi

	# Launch Code
	exec "$CODE" . $DISABLE_TEST_EXTENSION "$@"
}

function code-wsl()
{
	HOST_IP=$(echo "" | powershell.exe -noprofile -Command "& {(Get-NetIPAddress | Where-Object {\$_.InterfaceAlias -like '*WSL*' -and \$_.AddressFamily -eq 'IPv4'}).IPAddress | Write-Host -NoNewline}")
	export DISPLAY="$HOST_IP:0"

	# in a wsl shell
	ELECTRON="$ROOT/.build/electron/Fumie.exe"
	if [ -f "$ELECTRON"  ]; then
		local CWD=$(pwd)
		cd $ROOT
		export WSLENV=ELECTRON_RUN_AS_NODE/w:VSCODE_DEV/w:$WSLENV
		local WSL_EXT_ID="ms-vscode-remote.remote-wsl"
		local WSL_EXT_WLOC=$(echo "" | VSCODE_DEV=1 ELECTRON_RUN_AS_NODE=1 "$ROOT/.build/electron/Fumie.exe" "out/cli.js" --locate-extension $WSL_EXT_ID)
		cd $CWD
		if [ -n "$WSL_EXT_WLOC" ]; then
			# replace \r\n with \n in WSL_EXT_WLOC
			local WSL_CODE=$(wslpath -u "${WSL_EXT_WLOC%%[[:cntrl:]]}")/scripts/wslCode-dev.sh
			$WSL_CODE "$ROOT" "$@"
			exit $?
		else
			echo "Remote WSL not installed, trying to run VSCode in WSL."
		fi
	fi
}

if [ "$IN_WSL" == "true" ] && [ -z "$DISPLAY" ]; then
	code-wsl "$@"
elif [ -f /mnt/wslg/versions.txt ]; then
	code --disable-gpu "$@"
elif [ -f /.dockerenv ]; then
	# Workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=1263267
	# Chromium does not release shared memory when streaming scripts
	# which might exhaust the available resources in the container environment
	# leading to failed script loading.
	code --disable-dev-shm-usage "$@"
else
	code "$@"
fi

exit $?
