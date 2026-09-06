#!/usr/bin/env bash
# Fumie source-build Agent runtime setup. Provider models, endpoints and
# credentials come only from the saved Models configuration and secret
# storage; this file never reads or exports provider environment variables.

# Do not `set -euo pipefail` here: this file is sourced into launchers
# that already have their own shell options.

fumie_repo_root() {
	cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

fumie_configure_agents() {
	LAUNCH_EXTRA_SETTINGS_JSON="$(node -e 'console.log(JSON.stringify([
		{ key: "chat.agentHost.codexAgent.enabled", value: true },
		{ key: "chat.agentHost.codexAgent.binaryPath", value: "~/.local/bin/codex" },
		{ key: "chat.agentHost.claudeAgent.enabled", value: true },
		{ key: "chat.agentHost.kimiAgent.enabled", value: true },
		{ key: "chat.agentHost.deepseekAgent.enabled", value: true },
		{ key: "chat.agentHost.piAgent.enabled", value: true },
		{ key: "chat.agentHost.allowSignedOutWhenUsable", value: true },
	]))')"
	export LAUNCH_EXTRA_SETTINGS_JSON
	# Exporting CODEX_SQLITE_HOME lets Codex restore sessions that are already
	# registered in Fumie's own session catalog — it does not import
	# Desktop/ChatGPT threads; Fumie never sweeps those in (see
	# src/vs/platform/agentHost/AGENTS.md section 3a "Fumie-Owned Session Catalog").
	if [[ -z "${CODEX_SQLITE_HOME:-}" && -d "${HOME}/.codex" ]]; then
		export CODEX_SQLITE_HOME="${HOME}/.codex"
		echo "[fumie-agents] sharing Desktop Codex sqlite via CODEX_SQLITE_HOME" >&2
	fi

	# SDK acquisition is owned by the agent host's Fumie SDK manager
	# (src/vs/platform/agentHost/node/fumie/agentSdkManager.ts): it adopts or
	# installs every build/agent-sdk/agents/<id>/ SDK and publishes readiness
	# to the UI. The launcher only points at the layout, for app bundles whose
	# own tree does not contain it. Per-SDK overrides (FUMIE_<ID>_SDK_ROOT /
	# VSCODE_AGENT_HOST_<ID>_SDK_ROOT) are read by the manager directly.
	if [[ -z "${FUMIE_AGENT_SDK_AGENTS_DIR:-}" ]]; then
		export FUMIE_AGENT_SDK_AGENTS_DIR="$(fumie_repo_root)/build/agent-sdk/agents"
	fi
}

# Merge Agent Host settings keys into a profile's settings.json.
# Does not write simpleDialog / workspace.trust (those are throwaway-only).
fumie_merge_agent_settings() {
	local settings_file="${1:-}"
	if [[ -z "$settings_file" || -z "${LAUNCH_EXTRA_SETTINGS_JSON:-}" ]]; then
		return 0
	fi
	mkdir -p "$(dirname "$settings_file")"
	if ! node - "$settings_file" <<'NODE'
const fs = require('fs');
const f = process.argv[2];
let UPDATES = [];
try {
	const extra = process.env.LAUNCH_EXTRA_SETTINGS_JSON;
	if (extra) {
		const parsed = JSON.parse(extra);
		if (Array.isArray(parsed)) {
			UPDATES = parsed;
		}
	}
} catch (e) {
	console.error('[fumie-agents] LAUNCH_EXTRA_SETTINGS_JSON is not valid JSON: ' + e.message);
	process.exit(1);
}
if (UPDATES.length === 0) {
	process.exit(0);
}

let text;
try { text = fs.readFileSync(f, 'utf8'); }
catch (e) {
	if (e.code === 'ENOENT') text = '';
	else { console.error('[fumie-agents] cannot read ' + f + ': ' + e.message); process.exit(1); }
}

function literal(v) {
	return v === true ? 'true' : v === false ? 'false' : JSON.stringify(v);
}

if (text.trim() === '') {
	const lines = UPDATES.map(u => '  "' + u.key + '": ' + literal(u.value));
	fs.writeFileSync(f, '{\n' + lines.join(',\n') + '\n}\n');
	process.exit(0);
}

for (const { key, value } of UPDATES) {
	const keyValueRe = new RegExp('("' + key.replace(/\./g, '\\.') + '"\\s*:\\s*)(true|false|null|"[^"\\n]*"|-?\\d+(?:\\.\\d+)?)');
	if (keyValueRe.test(text)) {
		text = text.replace(keyValueRe, '$1' + literal(value));
		continue;
	}
	const lastBrace = text.lastIndexOf('}');
	if (lastBrace === -1) {
		console.error('[fumie-agents] settings.json has no closing brace — refusing to clobber it: ' + f);
		process.exit(1);
	}
	const firstBrace = text.indexOf('{');
	if (firstBrace === -1 || firstBrace >= lastBrace) {
		console.error('[fumie-agents] settings.json has no opening brace — refusing to clobber it: ' + f);
		process.exit(1);
	}
	const between = text.slice(firstBrace + 1, lastBrace)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.trim();
	const separator = between.length === 0 || between.endsWith(',') ? '' : ',';
	const insertion = separator + '\n  "' + key + '": ' + literal(value) + '\n';
	text = text.slice(0, lastBrace) + insertion + text.slice(lastBrace);
}

fs.writeFileSync(f, text);
NODE
	then
		echo "[fumie-agents] failed to merge Agent Host settings into $settings_file" >&2
		return 1
	fi
	echo "[fumie-agents] merged Agent Host settings into $settings_file" >&2
}

fumie_require_agents_runtime() {
	# SDK installs happen inside the agent host (visible in the launch UI);
	# nothing to pre-flight here anymore.
	return 0
}

fumie_user_data_dir_from_args() {
	local arg
	for arg in "$@"; do
		case "$arg" in
			--user-data-dir=*)
				printf '%s' "${arg#--user-data-dir=}"
				return 0
				;;
		esac
	done
	return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -euo pipefail
	case "${1:-}" in
		--check)
			fumie_configure_agents
			fumie_require_agents_runtime
			;;
		--exec)
			shift
			if [[ "${1:-}" == "--" ]]; then
				shift
			fi
			fumie_configure_agents
			fumie_require_agents_runtime
			local_udd="$(fumie_user_data_dir_from_args "$@" || true)"
			if [[ -n "${local_udd:-}" ]]; then
				fumie_merge_agent_settings "$local_udd/User/settings.json"
			fi
			exec "$@"
			;;
		*)
			echo "Usage: $0 --check | --exec -- <command> [args...]" >&2
			echo "Or: source $0 && fumie_configure_agents && fumie_require_agents_runtime" >&2
			exit 2
			;;
	esac
fi
