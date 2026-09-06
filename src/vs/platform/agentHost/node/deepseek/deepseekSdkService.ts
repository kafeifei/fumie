/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { mkdirSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { AgentHostDeepSeekSdkRootEnvVar } from '../../common/agentService.js';
import { AgentHostFumieHomeEnvVar } from '../../common/agentHostProductEnv.js';
import { composeSessionHostContext } from '../../common/sessionHostContext.js';
import { IAgentSdkDownloader, type IAgentSdkPackage } from '../agentSdkDownloader.js';
import { INativeModelProviderProxyService, type INativeModelProviderProxyHandle } from '../nativeModelProviderProxyService.js';

/**
 * DeepSeek Harness distribution descriptor. Lives in this file because it
 * encodes DeepSeek-specific knowledge — the env-var name and the fact that the
 * SDK ships a single per-platform SKU (no separate musl variant). The
 * downloader consumes this through `IAgentSdkPackage` and never names
 * DeepSeek directly.
 */
export const DeepSeekSdkPackage: IAgentSdkPackage = {
	id: 'deepseek',
	displayName: 'DeepSeek',
	devOverrideEnvVar: AgentHostDeepSeekSdkRootEnvVar,
	hasSeparateMuslLinuxPackage: false,
};

/**
 * The Cordis provider id the booted tree exposes DeepSeek models under. Every
 * model this harness serves is reached through it; the model string itself is
 * the provider-local id from the renderer BYOK catalog and travels to the BYOK
 * loopback proxy verbatim.
 */
export const DeepSeekProviderRoute = 'deepseek-official';
/**
 * Credential reference used by the DeepSeek credential service. The value is
 * written through that service and is never materialized into `process.env`.
 */
export const DeepSeekApiKeyEnvVar = 'DEEPSEEK_API_KEY';

// ---- Minimal runtime surface (mirrors the downloaded `dsh-*` packages) ----
// These packages are resolved at runtime from the downloaded SDK root, so Fumie
// cannot statically import them. The interfaces below name only the surface the
// agent bridge touches; the dynamic `import()` results are cast to them.

/** One append-only session event. `data` is lossless JSON keyed by event type. */
export interface IDeepSeekEvent {
	readonly type: string;
	readonly seq: number;
	readonly data: Record<string, unknown>;
}

export interface IDeepSeekContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly arguments?: string;
	readonly id?: string;
	readonly name?: string;
}

export interface IDeepSeekMessage {
	readonly role: string;
	readonly content: readonly IDeepSeekContentBlock[];
	readonly source?: Readonly<Record<string, unknown>>;
}

/**
 * Durable creation metadata for one harness session — the first line of its
 * stored log, and the only thing a lightweight catalog listing parses. Note
 * that `cwd` sits directly on the header: the harness's own `SessionInspection`
 * wrapper carries the header under a `meta` key, but `Session.header` (and the
 * records `sessionQuery` lists) are the header itself.
 */
export interface IDeepSeekSessionHeader {
	readonly id: string;
	/** Unix epoch milliseconds when the session was created. */
	readonly createdAt: number;
	/** Absolute working directory the session was created in, when it has one. */
	readonly cwd?: string;
}

export interface IDeepSeekSession {
	readonly id: string;
	readonly header: IDeepSeekSessionHeader;
	readonly events: readonly IDeepSeekEvent[];
	deriveMessages(): readonly IDeepSeekMessage[];
}

export interface IDeepSeekAgent {
	readonly id: string;
	readonly session: IDeepSeekSession;
	readonly status: string;
	followup(message: unknown): void;
	cancel(cause: string): void;
	whenIdle(): Promise<void>;
}

export interface IDeepSeekAgentHandle {
	readonly agent: IDeepSeekAgent;
	dispose(): Promise<void>;
}

export interface IDeepSeekContext {
	get(name: 'credentials'): {
		set(ref: string, value: string): Promise<void>;
		unset(ref: string): Promise<void>;
	} | undefined;
	readonly agents: {
		create(options: Record<string, unknown>): Promise<IDeepSeekAgentHandle>;
		resume(options: Record<string, unknown>): Promise<IDeepSeekAgentHandle>;
		get(id: string): IDeepSeekAgent | undefined;
	};
	readonly sessions: {
		get(id: string): IDeepSeekSession | undefined;
		list(): readonly IDeepSeekSession[];
	};
	readonly approval?: {
		setPolicy(agent: IDeepSeekAgent, policy: string): void;
	};
	/** Cordis root fiber; disposing it tears down the whole booted tree. */
	readonly fiber?: {
		dispose(): Promise<void> | void;
	};
	on(name: string, listener: (...args: unknown[]) => unknown): () => void;
}

/** The composed runtime the agent drives: the booted context plus message helpers. */
export interface IDeepSeekHarness {
	readonly ctx: IDeepSeekContext;
	createUserMessage(text: string): unknown;
}

export const IDeepSeekSdkService = createDecorator<IDeepSeekSdkService>('deepSeekSdkService');

export interface IDeepSeekSdkService {
	readonly _serviceBrand: undefined;
	/**
	 * Where the harness's JSONL persistence backend stores session logs, as a
	 * plain path: reading a session's durable header needs neither a download
	 * nor a boot, and a cold describe must not pay for either.
	 */
	readonly sessionsRoot: string;
	/** Lazy boot of the in-process DeepSeek core (Cordis context + helpers). */
	getHarness(): Promise<IDeepSeekHarness>;
	/** True iff the SDK can be loaded WITHOUT a network download. */
	canLoadWithoutDownload(): Promise<boolean>;
	close(): Promise<void>;
}

interface IDeepSeekBootBindings {
	boot(binName: string, absoluteConfigPath: string, patches?: readonly unknown[], prepare?: (ctx: unknown) => Promise<void> | void, bareModuleBaseUrl?: string): Promise<IDeepSeekContext>;
	loadOptionalPatches(binName: string, file: string): unknown[] | undefined;
}

interface IDeepSeekMessageBindings {
	createUserMessage(input: { content: readonly { type: 'text'; text: string }[]; source: { kind: 'user' } }): unknown;
}

export function buildDeepSeekPersona(hostContext: string | undefined): string {
	return [
		hostContext
			? 'You are a coding agent powered by the {{model}} model.'
			: 'You are a coding agent powered by the {{model}} model, hosted inside Fumie.',
		...(hostContext ? [hostContext] : []),
		'Your working directory is {{cwd}}.',
		'Inspect the workspace, follow the user\'s instructions, and use your tools to read, edit, and run code.',
	].join('\n\n');
}

/** Lazy loader and lifecycle owner for the in-process DeepSeek Harness. */
export class DeepSeekSdkService implements IDeepSeekSdkService {
	declare readonly _serviceBrand: undefined;

	private _harness: IDeepSeekHarness | undefined;
	private _harnessPromise: Promise<IDeepSeekHarness> | undefined;
	private _firstLoadFailureLogged = false;
	/**
	 * The native provider proxy bind the booted tree talks to. Acquired with the harness
	 * and released in {@link close}: the boot pins `baseURL` for the life of the
	 * composition, so the handle must outlive it (the ownership invariant on
	 * {@link INativeModelProviderProxyHandle}).
	 */
	private _providerProxyHandle: INativeModelProviderProxyHandle | undefined;
	private readonly _home: string;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentSdkDownloader private readonly _downloader: IAgentSdkDownloader,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@INativeModelProviderProxyService private readonly _providerProxyService: INativeModelProviderProxyService,
		@IProductService private readonly _productService: IProductService,
	) {
		this._home = process.env[AgentHostFumieHomeEnvVar]
			? join(process.env[AgentHostFumieHomeEnvVar], 'providers', 'deepseek')
			: join(this._environmentService.userDataPath, 'agentHost', 'deepseek');
	}

	/**
	 * Mirrors the composition's `session-persistence-jsonl` row, whose root is
	 * `dshHomePath('sessions')` — the same `DSH_HOME` this service pins below.
	 */
	get sessionsRoot(): string {
		return join(this._home, 'sessions');
	}

	async getHarness(): Promise<IDeepSeekHarness> {
		if (this._harness) {
			return this._harness;
		}
		if (this._harnessPromise) {
			return this._harnessPromise;
		}
		const loading = this._createHarness();
		this._harnessPromise = loading;
		try {
			this._harness = await loading;
			return this._harness;
		} catch (error) {
			if (this._harnessPromise === loading) {
				this._harnessPromise = undefined;
			}
			if (!this._firstLoadFailureLogged) {
				this._firstLoadFailureLogged = true;
				this._logService.error('[DeepSeek] Failed to boot the in-process DeepSeek Harness', error);
			}
			throw error;
		}
	}

	async canLoadWithoutDownload(): Promise<boolean> {
		return this._downloader.isSdkResolvableWithoutDownload(DeepSeekSdkPackage);
	}

	async close(): Promise<void> {
		const loading = this._harnessPromise;
		const harness = this._harness ?? await loading?.catch(() => undefined);
		this._harness = undefined;
		this._harnessPromise = undefined;
		await harness?.ctx.get('credentials')?.unset(DeepSeekApiKeyEnvVar).catch(() => { });
		await harness?.ctx.fiber?.dispose();
		// Ordering: the composition ran in this process and is now torn down, so
		// releasing the bind can no longer strand a live client.
		this._providerProxyHandle?.dispose();
		this._providerProxyHandle = undefined;
	}

	private async _createHarness(): Promise<IDeepSeekHarness> {
		const handle = this._providerProxyHandle ??= await this._providerProxyService.start();
		const root = await this._downloader.loadSdkRoot(DeepSeekSdkPackage, CancellationToken.None);
		// Isolate every DeepSeek user-data root (sessions, settings, credentials)
		// under Fumie so the user's real `~/.dsh` is never written to or read back
		// into a Fumie session.
		mkdirSync(this._home, { recursive: true });
		process.env['DSH_HOME'] = this._home;

		const moduleBaseUrl = pathToFileURL(join(root, 'node_modules') + '/').href;
		const bootUrl = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href;
		const messageUrl = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'types', 'message.js')).href;

		const bootModule = await import(bootUrl) as IDeepSeekBootBindings;
		const messageModule = await import(messageUrl) as IDeepSeekMessageBindings;

		const dshBasePatch = join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
		const basePatches = bootModule.loadOptionalPatches('fumie-deepseek', dshBasePatch) ?? [];
		const overlay = [
			// The HMR plugin requires `--expose-internals`, which Fumie's agent
			// host never passes; Fumie reloads the whole process instead of
			// hot-swapping the composition, so it is safely disabled.
			{ id: 'hmr', disabled: true },
			// Fumie's renderer Provider catalog is the only model configuration.
			// Disable DeepSeek's private settings layer so a saved `baseURL` or
			// arbitrary `apiKeyEnv` cannot override the selected Provider.
			{ id: 'settings', disabled: true },
			{ id: 'system-prompt', config: { persona: buildDeepSeekPersona(composeSessionHostContext(this._productService)) } },
			{ id: 'llm-deepseek', config: { apiKeyEnv: DeepSeekApiKeyEnvVar, baseURL: handle.providerBaseUrl('chat-completions') } },
		];
		const configPath = join(this._home, 'cordis.yml');
		writeFileSync(configPath, '[]\n');

		const ctx = await bootModule.boot(
			'fumie-deepseek',
			configPath,
			[...basePatches, ...overlay],
			undefined,
			moduleBaseUrl,
		);
		const credentials = ctx.get('credentials');
		if (!credentials) {
			await ctx.fiber?.dispose();
			throw new Error('DeepSeek credential service is unavailable');
		}
		// The composition serves every session, so the loopback credential cannot
		// be session-scoped. Store it through the harness credential seam; model
		// configuration and tool subprocesses never see a provider environment var.
		await credentials.set(DeepSeekApiKeyEnvVar, `${handle.nonce}.deepseek`);

		return {
			ctx,
			createUserMessage: (text: string) => messageModule.createUserMessage({
				content: [{ type: 'text', text }],
				source: { kind: 'user' },
			}),
		};
	}
}
