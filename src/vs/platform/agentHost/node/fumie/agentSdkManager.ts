/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSdkRetryRequestConfigKey, AgentSdkStatusConfigKey, platformRootSchema, type AgentSdkState, type AgentSdkStatusMap } from '../../common/agentHostSchema.js';
import type { IAgentConfigurationService } from '../agentConfigurationService.js';
import type { IAgentSdkPackage } from '../agentSdkDownloader.js';

/**
 * Fumie-owned SDK readiness manager for source-style builds.
 *
 * Built products acquire agent SDKs through `product.agentSdks` and the
 * downloader; source builds have no CDN entry, so each SDK lives at
 * `build/agent-sdk/agents/<id>/` (a pinned descriptor: `package.json` plus
 * either a `package-lock.json` or `agentSdkSource` metadata). This manager
 * owns that path end to end: it adopts an existing install, runs the
 * repository's own installer (`build/agent-sdk/package.ts --sdk=<id>
 * --install-dir=<dir>`) when `node_modules` is missing, and publishes a
 * per-agent readiness map on the root config so clients can render
 * installing/failed agents instead of silently hiding them.
 *
 * On success the SDK root is written to the package's `devOverrideEnvVar`,
 * which every SDK service already honors — downstream provider code is
 * unaware this manager exists. Providers register only when their SDK is
 * ready, via the `register` callback handed to {@link manage}; late
 * registration flows to clients through the existing `RootAgentsChanged`
 * path.
 *
 * Retry rides the root config too: a client writes
 * {@link AgentSdkRetryRequestConfigKey} (`"<nonce>:<providerId>"`) and the
 * manager re-runs the failed install. Both keys are Fumie-owned; removing
 * this file and the two schema keys is a clean retreat once upstream ships
 * SDK distribution for these agents.
 */

export interface IAgentSdkManagerOptions {
	/**
	 * Absolute path of the `build/agent-sdk/agents` directory, or undefined
	 * when the layout is absent (fully packaged builds).
	 */
	readonly agentsDir: string | undefined;
	/** Whether `product.agentSdks` carries this SDK (CDN-backed; not managed here). */
	readonly hasProductSdk: (id: string) => boolean;
	/**
	 * Test seam: replaces the installer child process. Resolves when the
	 * install succeeded; rejects with the failure reason otherwise.
	 */
	readonly runInstaller?: (id: string, installDir: string) => Promise<void>;
}

interface IManagedEntry {
	readonly pkg: IAgentSdkPackage;
	readonly register: () => void;
	state: AgentSdkState;
	error?: string;
	registered: boolean;
}

/** Number of installer output lines retained as the failure reason. */
const ERROR_TAIL_LINES = 12;

/**
 * Default `build/agent-sdk/agents` location: an explicit
 * `FUMIE_AGENT_SDK_AGENTS_DIR` (exported by launchers whose app bundle does
 * not contain the repository layout), else the repository the running code
 * was built from, else undefined (fully packaged build).
 */
export function resolveDefaultAgentsDir(): string | undefined {
	const fromEnv = process.env['FUMIE_AGENT_SDK_AGENTS_DIR'];
	if (fromEnv) {
		return fromEnv;
	}
	const appRoot = dirname(FileAccess.asFileUri('').fsPath);
	const candidate = join(appRoot, 'build', 'agent-sdk', 'agents');
	return existsSync(candidate) ? candidate : undefined;
}

export class AgentSdkManager extends Disposable {

	private readonly _entries = new Map<string, IManagedEntry>();
	private readonly _children = new Set<ChildProcess>();
	private _lastRetryRequest: string | undefined;
	private _disposed = false;

	constructor(
		private readonly _options: IAgentSdkManagerOptions,
		private readonly _configurationService: IAgentConfigurationService,
		private readonly _logService: ILogService,
	) {
		super();
		this._register(this._configurationService.onDidRootConfigChange(() => this._consumeRetryRequest()));
		this._register({ dispose: () => this._onDispose() });
	}

	private _onDispose(): void {
		this._disposed = true;
		for (const child of this._children) {
			child.kill();
		}
		this._children.clear();
	}

	/**
	 * Takes ownership of one SDK. `register` runs exactly once, as soon as
	 * the SDK is ready — synchronously for an adopted install, later for a
	 * fresh one. Never calls `register` after a failed install until a
	 * retry succeeds.
	 */
	manage(pkg: IAgentSdkPackage, register: () => void): void {
		if (this._entries.has(pkg.id)) {
			throw new Error(`Agent SDK already managed: ${pkg.id}`);
		}
		const entry: IManagedEntry = { pkg, register, state: 'installing', registered: false };
		this._entries.set(pkg.id, entry);
		void this._ensure(entry);
	}

	/** Snapshot of all managed states, keyed by provider id. */
	getStatuses(): AgentSdkStatusMap {
		const out: AgentSdkStatusMap = {};
		for (const [id, entry] of this._entries) {
			out[id] = { displayName: entry.pkg.displayName, state: entry.state, ...(entry.error !== undefined ? { error: entry.error } : {}) };
		}
		return out;
	}

	/** Re-runs the install of a failed SDK. No-op in any other state. */
	retry(id: string): void {
		const entry = this._entries.get(id);
		if (!entry || entry.state !== 'failed') {
			return;
		}
		entry.error = undefined;
		void this._ensure(entry);
	}

	private async _ensure(entry: IManagedEntry): Promise<void> {
		const { pkg } = entry;
		try {
			// 1. Explicit root override (user- or launcher-provided). Honor the
			// downloader's own env var plus the historical FUMIE_<ID>_SDK_ROOT
			// spelling. An explicit override is never installed into — an
			// incomplete tree is the user's to fix, matching the old scripts.
			const override = process.env[pkg.devOverrideEnvVar] || process.env[`FUMIE_${pkg.id.toUpperCase()}_SDK_ROOT`];
			if (override) {
				const missing = this._missingDependencies(override, pkg.id);
				if (missing === undefined || missing.length === 0) {
					this._becomeReady(entry, override);
				} else {
					this._becomeFailed(entry, `SDK root override at ${override} is incomplete (missing ${missing.join(', ')}). Unset the override to use the repository-pinned install.`);
				}
				return;
			}

			// 2. CDN-backed SDK: the downloader owns acquisition and progress.
			if (this._options.hasProductSdk(pkg.id)) {
				this._becomeReady(entry, undefined);
				return;
			}

			// 3. Repository-pinned install at build/agent-sdk/agents/<id>.
			const agentsDir = this._options.agentsDir;
			if (!agentsDir) {
				this._becomeFailed(entry, `No SDK source for '${pkg.id}': product.json has no agentSdks entry and the build/agent-sdk/agents layout is absent.`);
				return;
			}
			const root = join(agentsDir, pkg.id);
			if (!existsSync(join(root, 'package.json'))) {
				this._becomeFailed(entry, `No SDK descriptor at ${root}. Add a package.json with a pinned dependency set or agentSdkSource metadata.`);
				return;
			}
			if (this._missingDependencies(root, pkg.id)?.length === 0) {
				this._becomeReady(entry, root);
				return;
			}

			this._setState(entry, 'installing');
			this._logService.info(`[AgentSdkManager] ${pkg.id}: installing into ${root}`);
			await (this._options.runInstaller ?? this._runInstallerProcess.bind(this))(pkg.id, root);
			const missing = this._missingDependencies(root, pkg.id);
			if (missing === undefined || missing.length > 0) {
				this._becomeFailed(entry, `Install completed but the SDK is still incomplete at ${root}${missing?.length ? ` (missing ${missing.join(', ')})` : ''}.`);
				return;
			}
			this._becomeReady(entry, root);
		} catch (err) {
			this._becomeFailed(entry, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Names of pinned dependencies not present under `<root>/node_modules`.
	 * `undefined` when the descriptor is unreadable or pins nothing — both
	 * count as "not ready" for adoption and "failed" after an install.
	 */
	private _missingDependencies(root: string, id: string): string[] | undefined {
		try {
			const descriptor = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
				dependencies?: Record<string, string>;
				agentSdkSource?: { name?: string };
			};
			const names = Object.keys(descriptor.dependencies ?? {});
			if (descriptor.agentSdkSource?.name) {
				names.push(descriptor.agentSdkSource.name);
			}
			if (names.length === 0) {
				return undefined;
			}
			return names.filter(name => !existsSync(join(root, 'node_modules', name)));
		} catch (err) {
			this._logService.debug(`[AgentSdkManager] ${id}: unreadable SDK descriptor at ${root}`, err);
			return undefined;
		}
	}

	private _runInstallerProcess(id: string, installDir: string): Promise<void> {
		const agentsDir = this._options.agentsDir!;
		const installer = join(dirname(agentsDir), 'package.ts');
		return new Promise<void>((resolve, reject) => {
			// The agent host runs under Electron in the utility process and
			// under plain Node in the server; ELECTRON_RUN_AS_NODE makes the
			// same spawn correct in both (plain Node ignores it).
			const child = spawn(process.execPath, [installer, `--sdk=${id}`, `--install-dir=${installDir}`], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			this._children.add(child);
			const tail: string[] = [];
			const collect = (chunk: Buffer): void => {
				for (const line of chunk.toString().split('\n')) {
					if (line.trim().length === 0) {
						continue;
					}
					tail.push(line.trimEnd());
					if (tail.length > ERROR_TAIL_LINES) {
						tail.shift();
					}
					this._logService.trace(`[AgentSdkManager] ${id}: ${line.trimEnd()}`);
				}
			};
			child.stdout?.on('data', collect);
			child.stderr?.on('data', collect);
			child.on('error', err => {
				this._children.delete(child);
				reject(new Error(`Installer failed to spawn: ${err.message}`));
			});
			child.on('exit', (code, signal) => {
				this._children.delete(child);
				if (this._disposed) {
					reject(new Error('Agent host shut down during the install.'));
				} else if (code === 0) {
					resolve();
				} else {
					const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
					reject(new Error(`Installer ${reason}.${tail.length ? `\n${tail.join('\n')}` : ''}`));
				}
			});
		});
	}

	private _becomeReady(entry: IManagedEntry, root: string | undefined): void {
		if (root && !process.env[entry.pkg.devOverrideEnvVar]) {
			process.env[entry.pkg.devOverrideEnvVar] = root;
		}
		entry.error = undefined;
		this._setState(entry, 'ready');
		this._logService.info(`[AgentSdkManager] ${entry.pkg.id}: ready${root ? ` at ${root}` : ' (product-provided)'}`);
		if (!entry.registered && !this._disposed) {
			entry.registered = true;
			entry.register();
		}
	}

	private _becomeFailed(entry: IManagedEntry, error: string): void {
		entry.error = error;
		this._setState(entry, 'failed');
		this._logService.warn(`[AgentSdkManager] ${entry.pkg.id}: ${error}`);
	}

	private _setState(entry: IManagedEntry, state: AgentSdkState): void {
		entry.state = state;
		this._publish();
	}

	private _publish(): void {
		if (this._disposed) {
			return;
		}
		this._configurationService.updateRootConfig({ [AgentSdkStatusConfigKey]: this.getStatuses() });
	}

	private _consumeRetryRequest(): void {
		const request = this._configurationService.getRootValue(platformRootSchema, AgentSdkRetryRequestConfigKey);
		if (typeof request !== 'string' || request === this._lastRetryRequest) {
			return;
		}
		this._lastRetryRequest = request;
		// "<nonce>:<providerId>" — the nonce only forces a config delta when
		// the same SDK is retried twice.
		const providerId = request.slice(request.indexOf(':') + 1);
		this.retry(providerId);
	}
}
