# Fumie source-build Agent runtime setup for Windows. Provider models,
# endpoints and credentials come only from the saved Models configuration and
# secret storage; this file never reads or exports provider environment values.

function Get-FumieRepoRoot {
	return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

function Initialize-FumieAgentsRuntime {
	# Exporting CODEX_SQLITE_HOME lets Codex restore sessions that are already
	# registered in Fumie's own session catalog — it does not import
	# Desktop/ChatGPT threads; Fumie never sweeps those in (see
	# src/vs/platform/agentHost/AGENTS.md section 3a "Fumie-Owned Session Catalog").
	$desktopSqlite = Join-Path $env:USERPROFILE '.codex'
	if ([string]::IsNullOrWhiteSpace($env:CODEX_SQLITE_HOME) -and (Test-Path -LiteralPath $desktopSqlite -PathType Container)) {
		$env:CODEX_SQLITE_HOME = $desktopSqlite
		[Console]::Error.WriteLine('[fumie-agents] sharing Desktop Codex sqlite via CODEX_SQLITE_HOME')
	}
	$env:LAUNCH_EXTRA_SETTINGS_JSON = (@(
		@{ key = 'chat.agentHost.codexAgent.enabled'; value = $true },
		@{ key = 'chat.agentHost.codexAgent.binaryPath'; value = '~/.local/bin/codex' },
		@{ key = 'chat.agentHost.claudeAgent.enabled'; value = $true },
		@{ key = 'chat.agentHost.kimiAgent.enabled'; value = $true },
		@{ key = 'chat.agentHost.allowSignedOutWhenUsable'; value = $true }
	) | ConvertTo-Json -Compress)

	# SDK acquisition is owned by the agent host's Fumie SDK manager
	# (src/vs/platform/agentHost/node/fumie/agentSdkManager.ts): it adopts or
	# installs every build/agent-sdk/agents/<id>/ SDK and publishes readiness
	# to the UI. The launcher only points at the layout, for app bundles whose
	# own tree does not contain it. Per-SDK overrides (FUMIE_<ID>_SDK_ROOT /
	# VSCODE_AGENT_HOST_<ID>_SDK_ROOT) are read by the manager directly.
	if ([string]::IsNullOrWhiteSpace($env:FUMIE_AGENT_SDK_AGENTS_DIR)) {
		$env:FUMIE_AGENT_SDK_AGENTS_DIR = Join-Path (Get-FumieRepoRoot) 'build\agent-sdk\agents'
	}
}

function Assert-FumieAgentsRuntime {
	# SDK installs happen inside the agent host (visible in the launch UI);
	# nothing to pre-flight here anymore.
}
