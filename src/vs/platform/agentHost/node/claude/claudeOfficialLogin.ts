/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type SpawnOptions } from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { dirname, join } from '../../../../base/common/path.js';
import { IAgentSdkDownloader, resolveSdkTarget } from '../agentSdkDownloader.js';
import { withoutModelProviderEnvironment } from '../modelProviderEnvironment.js';
import { ClaudeSdkPackage } from './claudeAgentSdkService.js';

export interface IClaudeOfficialLoginProcess {
	once(event: 'error', listener: (error: Error) => void): this;
	once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	/** Terminate the process when the attempt is abandoned. */
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type ClaudeOfficialLoginSpawn = (file: string, args: readonly string[], options: SpawnOptions) => IClaudeOfficialLoginProcess;

const defaultSpawn: ClaudeOfficialLoginSpawn = (file, args, options) => spawn(file, args, options);

/** The native executable packaged beside the JS SDK for this host. */
export function claudeOfficialLoginExecutable(
	sdkRoot: string,
	sdkTarget = resolveSdkTarget(ClaudeSdkPackage),
	platform: NodeJS.Platform = process.platform,
): string {
	if (!sdkTarget) {
		throw new Error(`Claude Code login is not supported on ${platform}/${process.arch}`);
	}
	return join(
		sdkRoot,
		'node_modules',
		'@anthropic-ai',
		`claude-agent-sdk-${sdkTarget}`,
		platform === 'win32' ? 'claude.exe' : 'claude',
	);
}

/** Resolve the source checkout's node_modules root without importing the SDK. */
export async function resolveClaudeDevSdkRoot(
	resolveSdkEntryPath: () => string | Promise<string> = defaultResolveClaudeSdkEntryPath,
): Promise<string | undefined> {
	try {
		const sdkEntry = await resolveSdkEntryPath();
		// <root>/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs -> <root>
		return dirname(dirname(dirname(dirname(sdkEntry))));
	} catch {
		return undefined;
	}
}

async function defaultResolveClaudeSdkEntryPath(): Promise<string> {
	const { createRequire } = await import('node:module');
	return createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
}

/**
 * Preserve the user's normal Claude config location while preventing ambient
 * provider credentials or a host-owned OAuth token from selecting the login.
 */
export function createClaudeOfficialLoginEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = withoutModelProviderEnvironment(environment);
	const denied = new Set([
		'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
		'CLAUDE_CODE_ENTRYPOINT',
		'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
		'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
		'ELECTRON_RUN_AS_NODE',
		'NODE_OPTIONS',
	]);
	for (const key of Object.keys(result)) {
		const normalized = key.toUpperCase();
		if (normalized.startsWith('CLAUDE_CODE_OAUTH_') || denied.has(normalized)) {
			delete result[key];
		}
	}
	return result;
}

/**
 * Run one of the official `claude auth` commands and observe process completion
 * only.
 *
 * `token` abandons the run: `claude auth login` waits on a browser round-trip
 * that never arrives if the user cancels or closes the tab, so the process is
 * killed rather than waited on forever. The promise settles on the resulting
 * exit like any other.
 */
function runClaudeOfficialAuthCommand(
	command: 'login' | 'logout',
	executable: string,
	environment: NodeJS.ProcessEnv,
	spawnProcess: ClaudeOfficialLoginSpawn,
	token: CancellationToken,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawnProcess(executable, ['auth', command], {
			env: createClaudeOfficialLoginEnvironment(environment),
			shell: false,
			stdio: 'ignore',
			windowsHide: true,
		});
		const cancellation = token.onCancellationRequested(() => {
			cancellation.dispose();
			child.kill();
		});
		const settle = (finish: () => void) => {
			cancellation.dispose();
			finish();
		};
		child.once('error', error => settle(() => reject(error)));
		child.once('exit', (code, signal) => settle(() => {
			if (code === 0) {
				resolve();
			} else if (token.isCancellationRequested) {
				// Abandoned on purpose; the caller already knows and is starting over.
				resolve();
			} else {
				reject(new Error(signal
					? `Claude Code ${command} exited after signal ${signal}`
					: `Claude Code ${command} exited with status ${code ?? 'unknown'}`));
			}
		}));
	});
}

/** Run the official command and observe process completion only. */
export function runClaudeOfficialLogin(
	executable: string,
	environment: NodeJS.ProcessEnv = process.env,
	spawnProcess: ClaudeOfficialLoginSpawn = defaultSpawn,
	token: CancellationToken = CancellationToken.None,
): Promise<void> {
	return runClaudeOfficialAuthCommand('login', executable, environment, spawnProcess, token);
}

/**
 * Run the official sign-out. `claude auth logout` is the CLI's own command (its
 * `claude auth --help` lists `login`, `logout`, `status`), so the credential is
 * dropped by whoever owns it.
 */
export function runClaudeOfficialLogout(
	executable: string,
	environment: NodeJS.ProcessEnv = process.env,
	spawnProcess: ClaudeOfficialLoginSpawn = defaultSpawn,
): Promise<void> {
	return runClaudeOfficialAuthCommand('logout', executable, environment, spawnProcess, CancellationToken.None);
}

/**
 * Absolute path to the SDK-bundled native Claude Code executable for this host.
 *
 * The login flow is only one of its callers — the model-catalog reader
 * (`claudeCliModelRegistry.ts`) reads the same file — so this resolves the path
 * without launching anything. Callers must have established that the SDK is
 * already on disk (`IClaudeAgentSdkService.canLoadWithoutDownload`), otherwise
 * the downloader branch below fetches it.
 */
export async function resolveClaudeCliExecutable(downloader: IAgentSdkDownloader): Promise<string> {
	return claudeOfficialLoginExecutable(await resolveClaudeSdkRoot(downloader));
}

async function resolveClaudeSdkRoot(downloader: IAgentSdkDownloader): Promise<string> {
	if (downloader.isAvailable(ClaudeSdkPackage)) {
		return downloader.loadSdkRoot(ClaudeSdkPackage, CancellationToken.None);
	}
	const devRoot = await resolveClaudeDevSdkRoot();
	if (devRoot) {
		return devRoot;
	}
	return downloader.loadSdkRoot(ClaudeSdkPackage, CancellationToken.None);
}

/** Launch the SDK-bundled first-party Claude Code login flow. */
export async function launchClaudeOfficialLogin(downloader: IAgentSdkDownloader, token: CancellationToken = CancellationToken.None): Promise<void> {
	const executable = await resolveClaudeCliExecutable(downloader);
	await runClaudeOfficialLogin(executable, process.env, defaultSpawn, token);
}

/** Launch the SDK-bundled first-party Claude Code sign-out. */
export async function launchClaudeOfficialLogout(downloader: IAgentSdkDownloader): Promise<void> {
	const executable = await resolveClaudeCliExecutable(downloader);
	await runClaudeOfficialLogout(executable);
}
