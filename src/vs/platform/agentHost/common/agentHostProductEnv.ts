/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Codex's own env var for the SQLite state directory. */
export const AgentHostCodexSqliteHomeEnvVar = 'CODEX_SQLITE_HOME';

/** Copilot CLI's own env var for its state directory. Must match `copilotHome.ts`. */
export const AgentHostCopilotHomeEnvVar = 'COPILOT_HOME';

/** Fumie-owned root for session state, synced plugins, and worktrees. */
export const AgentHostFumieHomeEnvVar = 'FUMIE_HOME';

/** Original editor user-data directory used as the source for one-time migration. */
export const AgentHostLegacyUserDataDirEnvVar = 'VSCODE_AGENT_HOST_LEGACY_USER_DATA_DIR';

/** Must match `AgentHostCodexAgentCodexHomeEnvVar` in `agentService.ts`. */
const CodexHomeEnvVar = 'CODEX_HOME';

/** Must match `AgentHostCodexAgentBinaryPathEnvVar` in `agentService.ts`. */
const CodexBinaryPathEnvVar = 'VSCODE_AGENT_HOST_CODEX_BINARY_PATH';

/**
 * Product.json keys the Agent Host process may consume via environment.
 * Keep this overlay in the starter / server entry, not inside a provider.
 */
export interface IAgentHostProductEnvOverlay {
	readonly agentHostDefaultFumieHome?: string;
	readonly agentHostDefaultCodexHome?: string;
	readonly agentHostDefaultCodexSqliteHome?: string;
	readonly agentHostDefaultCopilotHome?: string;
}

function hostHomeDir(): string {
	return process.env['HOME'] || process.env['USERPROFILE'] || '';
}

export function expandAgentHostUserPath(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value === '~') {
		return hostHomeDir() || undefined;
	}
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		const home = hostHomeDir();
		return home ? `${home}${value.slice(1)}` : value;
	}
	return value;
}

function setIfMissing(
	env: Record<string, string | undefined> | Record<string, string>,
	key: string,
	defaultValue: string | undefined,
): void {
	if (env[key] !== undefined) {
		return;
	}
	const expanded = expandAgentHostUserPath(defaultValue);
	if (expanded) {
		env[key] = expanded;
	}
}

/**
 * Applies distribution defaults and `~` expansion onto an Agent Host env map.
 * Existing env values win over product.json; callers should invoke this after
 * spreading settings-derived env.
 */
export function applyAgentHostProductEnv(
	env: Record<string, string | undefined> | Record<string, string>,
	product: IAgentHostProductEnvOverlay,
): void {
	setIfMissing(env, AgentHostFumieHomeEnvVar, product.agentHostDefaultFumieHome);
	setIfMissing(env, CodexHomeEnvVar, product.agentHostDefaultCodexHome);
	setIfMissing(env, AgentHostCodexSqliteHomeEnvVar, product.agentHostDefaultCodexSqliteHome);
	setIfMissing(env, AgentHostCopilotHomeEnvVar, product.agentHostDefaultCopilotHome);
	for (const key of [AgentHostFumieHomeEnvVar, CodexHomeEnvVar, CodexBinaryPathEnvVar, AgentHostCodexSqliteHomeEnvVar, AgentHostCopilotHomeEnvVar]) {
		const expanded = expandAgentHostUserPath(env[key]);
		if (expanded !== undefined) {
			env[key] = expanded;
		}
	}
}

/** Returns the Fumie-owned Agent Host data root, falling back to the editor profile. */
export function getAgentHostUserDataPath(defaultPath: string, env: Readonly<Record<string, string | undefined>>): string {
	return expandAgentHostUserPath(env[AgentHostFumieHomeEnvVar]) ?? defaultPath;
}
