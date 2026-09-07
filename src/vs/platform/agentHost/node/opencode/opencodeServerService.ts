/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { existsSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { request } from 'undici';
import { DeferredPromise, raceTimeout, SequencerByKey } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { delimiter, join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { getByokLmAgentModelId, type IByokLmModelInfo, type IByokLmProviderConfiguration, visibleByokLmModels } from '../../common/agentHostByokLm.js';
import { withoutModelProviderEnvironment } from '../modelProviderEnvironment.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_PROVIDER_NAME, IChatGptSubscriptionService, chatGptSubscriptionAgentModelId, chatGptSubscriptionMaxOutputTokens, type IChatGptSubscriptionModel } from '../chatGptSubscription.js';
import { INativeModelProviderProxyService, type INativeModelProviderProxyHandle, type NativeModelWireProtocol } from '../nativeModelProviderProxyService.js';
import { resolveDefaultAgentsDir } from '../fumie/agentSdkManager.js';
import { OpencodeDbEnvVar, prepareOpencodeBackingStore } from './opencodeBackingStore.js';

/**
 * The `opencode serve` process, and nothing else.
 *
 * opencode ships as a Bun binary that owns its own model loop, tools and
 * transcripts; Fumie drives it the way opencode's own TUI does — over the local
 * HTTP + SSE API its `serve` command exposes. So this module's whole job is to
 * find that binary, keep exactly one server alive per workspace root, and hand
 * out an authenticated client for it. Nothing here knows what an AHP signal is.
 *
 * One server per working directory, not per chat: opencode roots a server's
 * tools at the process `cwd` (the per-request `directory` parameter does not
 * move them), so the directory is the only thing that can distinguish two
 * servers, and every chat under the same root shares one process the way every
 * TUI tab does.
 */

/** The spawned server: no stdin, and both output streams drained into the log. */
type OpencodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Executable name looked up on `PATH`, and the directory name under the agents dir. */
const OPENCODE_BINARY = 'opencode';

/** The user half of the server's HTTP Basic credentials; opencode fixes it. */
const OPENCODE_BASIC_AUTH_USER = 'opencode';

/** Environment variable opencode reads its server password from. */
const OPENCODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

/** In-memory config overlay supported by opencode's own server launcher. */
const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

/** Replaces OpenCode's auth-file view with an authoritative empty snapshot. */
const OPENCODE_AUTH_CONTENT_ENV = 'OPENCODE_AUTH_CONTENT';

/** Prevents OpenCode's built-in account/auth plugins from registering providers. */
const OPENCODE_DISABLE_DEFAULT_PLUGINS_ENV = 'OPENCODE_DISABLE_DEFAULT_PLUGINS';

/** Keeps models.dev from becoming a live catalog source for the embedded harness. */
const OPENCODE_DISABLE_MODELS_FETCH_ENV = 'OPENCODE_DISABLE_MODELS_FETCH';

/** The only provider id under which renderer BYOK rows enter OpenCode. */
export const OPENCODE_BYOK_PROVIDER_ID = 'fumie-byok';

/** How long a server gets to bind its port and answer the health probe. */
const OPENCODE_START_TIMEOUT_MS = 60_000;

/** One frame of opencode's global `/event` stream. */
export interface IOpencodeEvent {
	/** Event name, e.g. `message.part.delta` or `permission.v2.asked`. */
	readonly type: string;
	readonly properties: Record<string, unknown>;
}

/**
 * A live `opencode serve` process: one HTTP client, one global event stream.
 *
 * The stream is global rather than per session, which is exactly what makes
 * subagents observable — a delegated child session's parts and tool calls
 * arrive here alongside its parent's.
 */
export interface IOpencodeServer {
	/** The directory the server process is rooted at; its tools run here. */
	readonly cwd: string;
	/** Where the server listens, for diagnostics. */
	readonly baseUrl: string;
	readonly onDidReceiveEvent: Event<IOpencodeEvent>;
	/** Fires once when the process goes away without being disposed. */
	readonly onDidClose: Event<string>;
	request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
	dispose(): void;
}

export const IOpencodeServerService = createDecorator<IOpencodeServerService>('opencodeServerService');

export interface IOpencodeServerService {
	readonly _serviceBrand: undefined;
	/** The running server for `cwd`, starting one if this is the first caller. */
	acquire(cwd: string): Promise<IOpencodeServer>;
	/** Releases one acquire. Retired generations stop after their last release. */
	release(server: IOpencodeServer): void;
	/** Whether this exact server generation was configured with the picker model. */
	isModelAvailable(server: IOpencodeServer, modelId: string | undefined): boolean;
	/** Stops every server this service started. */
	close(): Promise<void>;
}

export class OpencodeServerService implements IOpencodeServerService {
	declare readonly _serviceBrand: undefined;

	private readonly _workspaces = new Map<string, IOpencodeWorkspaceServers>();
	private readonly _generations = new Map<IOpencodeServer, IOpencodeServerGeneration>();
	private readonly _sequencer = new SequencerByKey<string>();
	private readonly _pendingAcquires = new Set<Promise<IOpencodeServer>>();
	private _closePromise: Promise<void> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeModelProviderProxyService private readonly _nativeModelProviderProxyService: INativeModelProviderProxyService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
		@IChatGptSubscriptionService private readonly _chatGptSubscription: IChatGptSubscriptionService,
		private readonly _testHooks?: IOpencodeServerServiceTestHooks,
	) { }

	async acquire(cwd: string): Promise<IOpencodeServer> {
		if (this._closePromise) {
			throw new Error('OpenCode server service is closed.');
		}
		const acquiring = this._sequencer.queue(cwd, async () => {
			if (this._closePromise) {
				throw new Error('OpenCode server service is closed.');
			}
			const snapshot = await this._snapshot();
			const workspace = this._workspaces.get(cwd) ?? { generations: new Set<IOpencodeServerGeneration>() };
			this._workspaces.set(cwd, workspace);
			let generation = workspace.current;
			if (!generation || generation.signature !== snapshot.signature || generation.server.closed) {
				if (generation) {
					generation.retired = true;
					this._collect(generation);
				}
				workspace.current = undefined;
				generation = await this._start(cwd, snapshot);
				workspace.current = generation;
				workspace.generations.add(generation);
				this._generations.set(generation.server, generation);
			}
			generation.references++;
			return generation.server;
		});
		this._pendingAcquires.add(acquiring);
		try {
			return await acquiring;
		} finally {
			this._pendingAcquires.delete(acquiring);
		}
	}

	release(server: IOpencodeServer): void {
		const generation = this._generations.get(server);
		if (!generation || generation.references === 0) {
			return;
		}
		generation.references--;
		this._collect(generation);
	}

	isModelAvailable(server: IOpencodeServer, modelId: string | undefined): boolean {
		const generation = this._generations.get(server);
		return !!generation && (modelId ? generation.modelIds.has(modelId) : generation.modelIds.size > 0);
	}

	private async _start(cwd: string, snapshot: IOpencodeProviderSnapshot): Promise<IOpencodeServerGeneration> {
		const modelIds = opencodeSnapshotModelIds(snapshot);
		if (this._testHooks) {
			return { cwd, signature: snapshot.signature, server: await this._testHooks.start(cwd, snapshot.signature), modelIds, references: 0, retired: false };
		}
		const proxy = await this._nativeModelProviderProxyService.start();
		try {
			const config = opencodeProviderConfig(proxy, snapshot);
			const server = await OpencodeServer.start(resolveOpencodeBinary(), cwd, proxy, config, this._logService);
			return { cwd, signature: snapshot.signature, server, modelIds, references: 0, retired: false };
		} catch (error) {
			proxy.dispose();
			throw error;
		}
	}

	private async _snapshot(): Promise<IOpencodeProviderSnapshot> {
		const byok: IOpencodeByokModel[] = [];
		for (const model of visibleByokLmModels(this._byokBridgeRegistry.getModels()).filter(model => model.supportedHarnesses?.includes('opencode'))) {
			const modelIdentifier = model.modelIdentifier ?? getByokLmAgentModelId(model);
			const provider = await this._byokBridgeRegistry.resolveProviderConfiguration?.(modelIdentifier);
			if (!provider) {
				throw new Error(`OpenCode cannot resolve the configured provider for '${modelIdentifier}'.`);
			}
			byok.push({ model, modelIdentifier, wire: opencodeWire(provider) });
		}
		const chatGpt = [...this._chatGptSubscription.getModels()];
		const content = { byok, chatGpt };
		return { ...content, signature: JSON.stringify(content) };
	}

	private _collect(generation: IOpencodeServerGeneration): void {
		if (!generation.retired || generation.references > 0) {
			return;
		}
		generation.server.dispose();
		this._generations.delete(generation.server);
		const workspace = this._workspaces.get(generation.cwd);
		workspace?.generations.delete(generation);
		if (workspace && !workspace.current && workspace.generations.size === 0) {
			this._workspaces.delete(generation.cwd);
		}
	}

	async close(): Promise<void> {
		return this._closePromise ??= (async () => {
			await Promise.allSettled([...this._pendingAcquires]);
			const servers = [...this._generations.keys()];
			this._workspaces.clear();
			this._generations.clear();
			for (const server of servers) {
				server.dispose();
			}
		})();
	}
}

interface IOpencodeWorkspaceServers {
	current?: IOpencodeServerGeneration;
	readonly generations: Set<IOpencodeServerGeneration>;
}

/** Narrow process seam for deterministic generation/shutdown tests. */
export interface IOpencodeServerServiceTestHooks {
	start(cwd: string, signature: string): Promise<IManagedOpencodeServer>;
}

type IManagedOpencodeServer = IOpencodeServer & { readonly closed: boolean };

interface IOpencodeServerGeneration {
	readonly cwd: string;
	readonly signature: string;
	readonly server: IManagedOpencodeServer;
	readonly modelIds: ReadonlySet<string>;
	references: number;
	retired: boolean;
}

interface IOpencodeByokModel {
	readonly model: IByokLmModelInfo;
	readonly modelIdentifier: string;
	readonly wire: NativeModelWireProtocol;
}

interface IOpencodeProviderSnapshot {
	readonly signature: string;
	readonly byok: readonly IOpencodeByokModel[];
	readonly chatGpt: readonly IChatGptSubscriptionModel[];
}

function opencodeSnapshotModelIds(snapshot: Pick<IOpencodeProviderSnapshot, 'byok' | 'chatGpt'>): ReadonlySet<string> {
	return new Set([
		...snapshot.byok.map(model => `${OPENCODE_BYOK_PROVIDER_ID}/${model.modelIdentifier}`),
		...snapshot.chatGpt.map(model => `${CHATGPT_SUBSCRIPTION_PROVIDER_NAME}/${model.id}`),
	]);
}

interface IExpectedOpencodeProviders {
	readonly providerIds: readonly string[];
	readonly modelIds: Readonly<Record<string, readonly string[]>>;
	readonly config: Record<string, unknown>;
}

/**
 * opencode provider overlay for the ChatGPT subscription borrowed from Codex.
 * Only the loopback nonce crosses into the subprocess; live ChatGPT credentials
 * remain in the Agent Host and are resolved by the proxy for each request.
 */
export function opencodeProviderConfig(handle: INativeModelProviderProxyHandle, snapshot: Pick<IOpencodeProviderSnapshot, 'byok' | 'chatGpt'>): Record<string, unknown> {
	const providers: Record<string, unknown> = {};
	if (snapshot.byok.length > 0) {
		providers[OPENCODE_BYOK_PROVIDER_ID] = {
			name: 'Fumie Providers',
			options: { apiKey: `${handle.nonce}.opencode` },
			models: Object.fromEntries(snapshot.byok.map(({ model, modelIdentifier, wire }) => [modelIdentifier, opencodeByokModelConfig(handle, model, modelIdentifier, wire)])),
		};
	}
	if (snapshot.chatGpt.length > 0) {
		providers[CHATGPT_SUBSCRIPTION_PROVIDER_NAME] = {
			npm: '@ai-sdk/openai',
			name: 'ChatGPT',
			options: {
				baseURL: handle.providerBaseUrl('responses'),
				apiKey: `${handle.nonce}.opencode`,
			},
			models: Object.fromEntries(snapshot.chatGpt.map(model => [model.id, {
				// opencode keeps the map key as its provider-local selection id and
				// sends `id` to the AI SDK as the wire model.
				id: chatGptSubscriptionAgentModelId(model.id),
				name: model.name,
				options: { reasoningEffort: model.defaultReasoningEffort },
				variants: Object.fromEntries(model.supportedReasoningEfforts.map(effort => [effort, { reasoningEffort: effort }])),
				attachment: model.supportsVision,
				reasoning: model.supportedReasoningEfforts.length > 0,
				temperature: false,
				tool_call: true,
				limit: {
					context: model.maxContextWindowTokens,
					output: chatGptSubscriptionMaxOutputTokens(model),
				},
				modalities: {
					input: model.supportsVision ? ['text', 'image'] : ['text'],
					output: ['text'],
				},
			}])),
		};
	}
	const providerIds = Object.keys(providers);
	const firstProvider = providerIds[0];
	const firstModels = firstProvider ? (providers[firstProvider] as { models: Record<string, unknown> }).models : {};
	const firstModel = Object.keys(firstModels)[0];
	const defaultModel = firstProvider && firstModel ? `${firstProvider}/${firstModel}` : undefined;
	return {
		disabled_providers: [],
		enabled_providers: providerIds,
		provider: providers,
		...(defaultModel ? { model: defaultModel, small_model: defaultModel } : {}),
	};
}

function opencodeByokModelConfig(handle: INativeModelProviderProxyHandle, model: IByokLmModelInfo, modelIdentifier: string, wire: NativeModelWireProtocol): Record<string, unknown> {
	const context = model.maxContextWindowTokens ?? 128_000;
	const output = Math.min(model.maxOutputTokens ?? 16_384, context);
	const optionName = wire === 'messages' ? 'effort' : 'reasoningEffort';
	const variants = Object.fromEntries((model.supportedReasoningEfforts ?? []).map(effort => [effort, { [optionName]: effort }]));
	return {
		id: modelIdentifier,
		name: model.name ?? model.id,
		provider: {
			npm: wire === 'messages' ? '@ai-sdk/anthropic' : wire === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
			api: handle.providerBaseUrl(wire),
		},
		...(model.defaultReasoningEffort ? { options: { [optionName]: model.defaultReasoningEffort } } : {}),
		...(Object.keys(variants).length ? { variants } : {}),
		attachment: model.supportsVision ?? false,
		reasoning: (model.supportedReasoningEfforts?.length ?? 0) > 0,
		temperature: false,
		tool_call: true,
		limit: { context, output },
		modalities: { input: model.supportsVision ? ['text', 'image'] : ['text'], output: ['text'] },
	};
}

function opencodeWire(provider: IByokLmProviderConfiguration): NativeModelWireProtocol {
	const models = Array.isArray(provider.configuration.models) ? provider.configuration.models : [];
	const model = models.find(candidate => !!candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === provider.modelId) as { apiType?: unknown; url?: unknown } | undefined;
	const configured = typeof model?.apiType === 'string' ? model.apiType : typeof provider.configuration.apiType === 'string' ? provider.configuration.apiType : undefined;
	const url = typeof model?.url === 'string' ? model.url : typeof provider.configuration.url === 'string' ? provider.configuration.url : '';
	const wire = configured ?? (/\/messages(?:\?|$)/i.test(url) ? 'messages' : /\/responses(?:\?|$)/i.test(url) ? 'responses' : 'chat-completions');
	if (wire !== 'responses' && wire !== 'messages' && wire !== 'chat-completions') {
		throw new Error(`OpenCode does not support configured model wire '${wire}'.`);
	}
	return wire;
}

interface IOpencodePublicProvider {
	readonly id: string;
	readonly options?: Record<string, unknown>;
	readonly models?: Readonly<Record<string, {
		readonly api?: { readonly id?: string; readonly npm?: string; readonly url?: string };
	}>>;
}

function expectedOpencodeProviders(config: Record<string, unknown>): IExpectedOpencodeProviders {
	const provider = config['provider'] as Record<string, { models?: Record<string, unknown> }>;
	const providerIds = config['enabled_providers'] as readonly string[];
	return {
		providerIds,
		modelIds: Object.fromEntries(providerIds.map(id => [id, Object.keys(provider[id]?.models ?? {})])),
		config,
	};
}

function providerConfigMatches(actual: unknown, expected: unknown): boolean {
	return structuralEquals(actual, expected);
}

function effectiveProviderMatches(provider: IOpencodePublicProvider, configured: unknown, modelIds: readonly string[]): boolean {
	if (!isRecord(configured) || !structuralEquals(provider.options ?? {}, configured['options'] ?? {})) {
		return false;
	}
	const configuredModels = isRecord(configured['models']) ? configured['models'] : {};
	for (const modelId of modelIds) {
		const model = provider.models?.[modelId];
		const configuredModel = configuredModels[modelId];
		if (!model || !isRecord(configuredModel)) {
			return false;
		}
		const configuredRoute = isRecord(configuredModel['provider']) ? configuredModel['provider'] : {};
		const expectedNpm = configuredRoute['npm'] ?? configured['npm'];
		const expectedUrl = configuredRoute['api'] ?? configured['api'] ?? '';
		if (model.api?.id !== configuredModel['id'] || model.api?.npm !== expectedNpm || model.api?.url !== expectedUrl) {
			return false;
		}
	}
	return true;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
	return Array.isArray(actual)
		&& actual.every(value => typeof value === 'string')
		&& [...actual].sort().join('\0') === [...expected].sort().join('\0');
}

function structuralEquals(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => structuralEquals(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) {
		return false;
	}
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return sameStrings(leftKeys, rightKeys) && leftKeys.every(key => structuralEquals(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

class OpencodeServer extends Disposable implements IOpencodeServer {

	/**
	 * Starts one server and waits until it can actually be talked to.
	 *
	 * Readiness is the `server.connected` frame on the event stream rather than
	 * a probe of some health route: it proves the very channel every turn depends
	 * on is open, which a `200` on another path would not.
	 */
	static async start(binary: string, cwd: string, providerProxy: INativeModelProviderProxyHandle, config: Record<string, unknown>, logService: ILogService): Promise<OpencodeServer> {
		const dbPath = await prepareOpencodeBackingStore();
		const port = await findFreePort();
		const password = generateUuid();
		const args = ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)];
		let child: OpencodeChildProcess;
		try {
			child = spawn(binary, args, {
				cwd,
				// Ambient provider configuration is never a configuration source for a
				// harness Fumie launches. Its providers and loopback credentials come
				// exclusively from the config assembled above.
				env: {
					...withoutModelProviderEnvironment(process.env),
					[OpencodeDbEnvVar]: dbPath,
					[OPENCODE_SERVER_PASSWORD_ENV]: password,
					[OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(config),
					[OPENCODE_AUTH_CONTENT_ENV]: '{}',
					[OPENCODE_DISABLE_DEFAULT_PLUGINS_ENV]: '1',
					[OPENCODE_DISABLE_MODELS_FETCH_ENV]: '1',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				// Node refuses to execute `.cmd` / `.bat` without a shell, and on
				// Windows a user-installed `opencode` normally arrives as one.
				shell: isWindows,
			});
		} catch (error) {
			throw new Error(startFailureMessage(binary, error));
		}
		const server = new OpencodeServer(child, `http://127.0.0.1:${String(port)}`, password, cwd, providerProxy, logService);
		try {
			await server._waitUntilConnected();
			await server._validateProviderIsolation(expectedOpencodeProviders(config));
			return server;
		} catch (error) {
			server.dispose();
			throw error;
		}
	}

	private readonly _onDidReceiveEvent = this._register(new Emitter<IOpencodeEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidClose = this._register(new Emitter<string>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _authorization: string;
	private readonly _connected = new DeferredPromise<void>();
	private readonly _streamAbort = new AbortController();
	private _exitReason: string | undefined;
	private _disposed = false;

	private constructor(
		private readonly _child: OpencodeChildProcess,
		private readonly _baseUrl: string,
		password: string,
		readonly cwd: string,
		providerProxy: INativeModelProviderProxyHandle,
		private readonly _logService: ILogService,
	) {
		super();
		this._authorization = `Basic ${Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${password}`).toString('base64')}`;
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => this._logService.trace(`[opencode] ${chunk.trimEnd()}`));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => this._logService.trace(`[opencode] ${chunk.trimEnd()}`));
		this._child.once('exit', (code, signal) => this._reportExit(exitDescription(code, signal)));
		this._child.once('error', error => this._reportExit(errorText(error)));
		this._register(toDisposable(() => {
			this._disposed = true;
			this._streamAbort.abort();
			if (this._child.exitCode === null && this._child.signalCode === null) {
				this._child.kill();
			}
		}));
		this._register(providerProxy);
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	/** Whether the process has gone away, so the next caller starts a new one. */
	get closed(): boolean {
		return this._disposed || this._exitReason !== undefined;
	}

	async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		return requestOpencode<T>(this._baseUrl, this._authorization, method, path, body, this._streamAbort.signal);
	}

	private async _waitUntilConnected(): Promise<void> {
		void this._consumeEventStream();
		const settled = await raceTimeout(
			Promise.race([this._connected.p, this._whenExited()]),
			OPENCODE_START_TIMEOUT_MS,
		);
		if (settled === undefined && !this._connected.isSettled) {
			throw new Error(`opencode did not start within ${String(OPENCODE_START_TIMEOUT_MS / 1000)}s.`);
		}
		if (this._exitReason) {
			throw new Error(`opencode stopped before it was ready: ${this._exitReason}`);
		}
	}

	/** Refuses a process whose later config layers changed Fumie's provider boundary. */
	private async _validateProviderIsolation(expected: IExpectedOpencodeProviders): Promise<void> {
		const config = await this.request<Record<string, unknown>>('GET', '/config');
		const catalog = await this.request<{ providers?: readonly IOpencodePublicProvider[] }>('GET', '/config/providers');
		const problems: string[] = [];
		if (!sameStrings(config['enabled_providers'], expected.providerIds)) {
			problems.push('enabled provider list');
		}
		if (!sameStrings(config['disabled_providers'], [])) {
			problems.push('disabled provider list');
		}
		if (config['model'] !== expected.config['model'] || config['small_model'] !== expected.config['small_model']) {
			problems.push('default model selection');
		}
		const configured = isRecord(config['provider']) ? config['provider'] : {};
		for (const providerId of expected.providerIds) {
			const wanted = (expected.config['provider'] as Record<string, unknown>)[providerId];
			const actual = configured[providerId];
			if (!providerConfigMatches(actual, wanted)) {
				problems.push(`provider '${providerId}' configuration`);
			}
		}
		const providers = catalog.providers ?? [];
		if (!sameStrings(providers.map(provider => provider.id), expected.providerIds)) {
			problems.push('effective provider catalog');
		}
		for (const providerId of expected.providerIds) {
			const provider = providers.find(candidate => candidate.id === providerId);
			const wantedModels = expected.modelIds[providerId] ?? [];
			if (!provider || !sameStrings(Object.keys(provider.models ?? {}), wantedModels)) {
				problems.push(`provider '${providerId}' model catalog`);
				continue;
			}
			const configuredProvider = configured[providerId];
			if (!effectiveProviderMatches(provider, configuredProvider, wantedModels)) {
				problems.push(`provider '${providerId}' effective route`);
			}
		}
		if (problems.length > 0) {
			throw new Error(`OpenCode provider isolation validation failed: ${problems.join(', ')}.`);
		}
	}

	/**
	 * Reads the global event stream for the life of the process.
	 *
	 * The connect is retried while the server is still binding its port — the
	 * process is up long before the listener is — and the loop ends when the
	 * stream ends, which for a live server only happens on exit or disposal.
	 */
	private async _consumeEventStream(): Promise<void> {
		while (!this.closed) {
			try {
				const response = await fetch(`${this._baseUrl}/event`, {
					headers: { authorization: this._authorization, accept: 'text/event-stream' },
					signal: this._streamAbort.signal,
				});
				if (!response.ok || !response.body) {
					throw new Error(`opencode event stream answered ${String(response.status)}.`);
				}
				await this._readEventStream(response.body);
				return;
			} catch (error) {
				if (this.closed || this._connected.isSettled) {
					return;
				}
				this._logService.trace(`[opencode] Event stream not ready yet: ${errorText(error)}`);
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
	}

	private async _readEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		let buffer = '';
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			// Server-sent events are separated by a blank line; a frame that has not
			// arrived whole stays in the buffer until it has.
			let boundary = buffer.indexOf('\n\n');
			while (boundary >= 0) {
				this._dispatchFrame(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf('\n\n');
			}
		}
	}

	private _dispatchFrame(frame: string): void {
		for (const line of frame.split('\n')) {
			if (!line.startsWith('data:')) {
				continue;
			}
			const event = parseOpencodeEvent(line.slice(5).trim());
			if (!event) {
				continue;
			}
			if (event.type === 'server.connected') {
				this._connected.complete();
			}
			this._onDidReceiveEvent.fire(event);
		}
	}

	private _whenExited(): Promise<void> {
		return new Promise(resolve => {
			if (this._exitReason !== undefined) {
				resolve();
				return;
			}
			this._register(this.onDidClose(() => resolve()));
		});
	}

	private _reportExit(reason: string): void {
		if (this._exitReason !== undefined) {
			return;
		}
		this._exitReason = reason;
		if (!this._disposed) {
			this._onDidClose.fire(reason);
		}
	}
}

/** A prompt response waits for the whole turn; its HTTP wait is not a turn deadline. */
export async function requestOpencode<T>(baseUrl: string, authorization: string, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const waitsForTurn = method === 'POST' && /^\/session\/[^/]+\/message$/.test(path);
	const response = await request(`${baseUrl}${path}`, {
		method,
		headers: {
			authorization,
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		// fetch's five-minute header/body timeout can fail Fumie while opencode
		// and its subagents continue working. Only the synchronous prompt RPC
		// waits without that timeout; cancellation/server disposal still aborts it.
		...(waitsForTurn ? { headersTimeout: 0, bodyTimeout: 0 } : {}),
		signal,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`opencode ${method} ${path} failed with ${String(response.statusCode)}: ${(await response.body.text()).slice(0, 500)}`);
	}
	if (response.statusCode === 204 || response.headers['content-length'] === '0') {
		await response.body.dump();
		return undefined as T;
	}
	return await response.body.json() as T;
}

/** Parses one `data:` payload; a frame that is not an opencode event is dropped. */
export function parseOpencodeEvent(payload: string): IOpencodeEvent | undefined {
	if (!payload) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(payload) as { type?: unknown; properties?: unknown };
		if (typeof parsed.type !== 'string') {
			return undefined;
		}
		const properties = parsed.properties;
		return {
			type: parsed.type,
			properties: properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : {},
		};
	} catch {
		return undefined;
	}
}

/**
 * The `opencode` executable to run.
 *
 * `PATH` first, because v1 asks the user to install opencode themselves and
 * that is where their install is; the agents directory is the second place to
 * look so a build that does ship the binary needs no code change. Failing both,
 * the error names the remedy rather than leaving a spawn to fail with `ENOENT`
 * halfway into a turn.
 */
export function resolveOpencodeBinary(): string {
	const fromPath = findOnPath(OPENCODE_BINARY);
	if (fromPath) {
		return fromPath;
	}
	const agentsDir = resolveDefaultAgentsDir();
	const bundled = agentsDir ? firstExisting([
		join(agentsDir, OPENCODE_BINARY, binaryFileName(OPENCODE_BINARY)),
		join(agentsDir, OPENCODE_BINARY, 'bin', binaryFileName(OPENCODE_BINARY)),
	]) : undefined;
	if (bundled) {
		return bundled;
	}
	throw new Error('opencode was not found on PATH. Install it (https://opencode.ai) and make sure `opencode` runs from a terminal.');
}

function binaryFileName(name: string): string {
	return isWindows ? `${name}.exe` : name;
}

function findOnPath(name: string): string | undefined {
	const candidates: string[] = [];
	for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		// On Windows an installed CLI is as likely to be a `.cmd` shim as an
		// executable, and `spawn` runs it through a shell either way.
		for (const suffix of isWindows ? ['.exe', '.cmd', '.bat', ''] : ['']) {
			candidates.push(join(dir, `${name}${suffix}`));
		}
	}
	return firstExisting(candidates);
}

function firstExisting(candidates: readonly string[]): string | undefined {
	return candidates.find(candidate => existsSync(candidate));
}

/**
 * A port nothing is listening on right now.
 *
 * Inherently a hint rather than a reservation — the port is free when it is
 * read and could be taken before opencode binds it — which is why the caller's
 * readiness check is what actually decides whether the server came up.
 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const port = (probe.address() as AddressInfo).port;
			probe.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function startFailureMessage(binary: string, error: unknown): string {
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return `The opencode executable '${binary}' could not be run. Install opencode and make sure it runs from a terminal.`;
	}
	return `Could not start '${binary} serve': ${errorText(error)}`;
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
	return signal ? `opencode serve was terminated by ${signal}.` : `opencode serve exited with code ${String(code ?? 0)}.`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
