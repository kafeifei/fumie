/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { AgentHostKimiSdkRootEnvVar } from '../../common/agentService.js';
import { getByokLmAgentModelId, type IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import { AgentHostFumieHomeEnvVar } from '../../common/agentHostProductEnv.js';
import { composeSessionHostContext } from '../../common/sessionHostContext.js';
import { IAgentSdkDownloader, type IAgentSdkPackage } from '../agentSdkDownloader.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { INativeModelProviderProxyService, type INativeModelProviderProxyHandle } from '../nativeModelProviderProxyService.js';

export const KimiSdkPackage: IAgentSdkPackage = {
	id: 'kimi',
	displayName: 'Kimi',
	devOverrideEnvVar: AgentHostKimiSdkRootEnvVar,
	hasSeparateMuslLinuxPackage: false,
};

/** Fumie-owned Kimi provider entry backed by the loopback provider proxy. */
export const KimiSdkProviderId = 'fumie-provider';

const KimiHostContextStart = '<!-- fumie-host-context:start -->';
const KimiHostContextEnd = '<!-- fumie-host-context:end -->';

/** Synchronizes only Fumie's managed block in Kimi's native global instruction file. */
export function syncKimiHostInstructions(homeDir: string, hostContext: string | undefined): boolean {
	const contextPath = join(homeDir, 'AGENTS.md');
	let existingMode: number | undefined;
	try {
		const stat = lstatSync(contextPath);
		if (!stat.isFile()) {
			return false;
		}
		existingMode = stat.mode;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const current = existingMode === undefined ? '' : readFileSync(contextPath, 'utf8');
	const start = current.indexOf(KimiHostContextStart);
	const end = current.indexOf(KimiHostContextEnd);
	const hasMalformedBlock = (start < 0) !== (end < 0)
		|| (start >= 0 && end < start)
		|| (start >= 0 && current.indexOf(KimiHostContextStart, start + KimiHostContextStart.length) >= 0)
		|| (end >= 0 && current.indexOf(KimiHostContextEnd, end + KimiHostContextEnd.length) >= 0);
	if (hasMalformedBlock) {
		return false;
	}

	let managedStart = start;
	let managedEnd = end < 0 ? -1 : end + KimiHostContextEnd.length;
	if (managedStart >= 2 && current.slice(managedStart - 2, managedStart) === '\n\n') {
		managedStart -= 2;
	}
	if (managedEnd >= 0 && managedEnd === current.length - 1 && current[managedEnd] === '\n') {
		managedEnd += 1;
	}

	let updated = current;
	if (hostContext) {
		const block = `${KimiHostContextStart}\n# Fumie Runtime Context\n\n${hostContext}\n${KimiHostContextEnd}`;
		if (start >= 0) {
			const leading = managedStart < start ? '\n\n' : '';
			const trailing = managedEnd > end + KimiHostContextEnd.length ? '\n' : '';
			updated = current.slice(0, managedStart) + leading + block + trailing + current.slice(managedEnd);
		} else {
			updated = current ? `${current}\n\n${block}\n` : `${block}\n`;
		}
	} else if (start >= 0) {
		updated = current.slice(0, managedStart) + current.slice(managedEnd);
	}

	if (updated === current) {
		return true;
	}
	if (updated.length === 0) {
		rmSync(contextPath, { force: true });
		return true;
	}

	mkdirSync(homeDir, { recursive: true });
	const temporaryPath = join(homeDir, `.AGENTS.md.fumie-${process.pid}-${Date.now()}.tmp`);
	try {
		writeFileSync(temporaryPath, updated, { encoding: 'utf8', mode: existingMode });
		renameSync(temporaryPath, contextPath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return true;
}

/**
 * Everything the harness needs to point the SDK at a BYOK model: the shared
 * loopback bind (route per vendor, one token) plus a read of the renderer
 * catalog for the non-routing facts the provider published.
 */
export interface IKimiByokEndpoint {
	readonly token: string;
	readonly providerBaseUrl: () => string;
	readonly lookupModel: (agentModelId: string) => IByokLmModelInfo | undefined;
}

export interface IKimiSessionSummary {
	readonly id: string;
	readonly title?: string;
	readonly lastPrompt?: string;
	readonly workDir: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly archived?: boolean;
	readonly additionalDirs?: readonly string[];
}

export interface IKimiApprovalRequest {
	readonly agentId?: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly action: string;
	readonly display: unknown;
}

export interface IKimiQuestionOption {
	readonly label: string;
	readonly description?: string;
}

export interface IKimiQuestionItem {
	readonly question: string;
	readonly header?: string;
	readonly body?: string;
	readonly options: readonly IKimiQuestionOption[];
	readonly multiSelect?: boolean;
	readonly otherLabel?: string;
	readonly otherDescription?: string;
}

export interface IKimiQuestionRequest {
	readonly agentId?: string;
	readonly toolCallId?: string;
	readonly questions: readonly IKimiQuestionItem[];
}

export type KimiQuestionResult = null | Readonly<Record<string, string | true>> | {
	readonly answers: Readonly<Record<string, string | true>>;
	readonly method?: 'enter' | 'space' | 'number_key';
};

export interface IKimiEvent {
	readonly type: string;
	readonly sessionId: string;
	readonly agentId?: string;
	readonly [key: string]: unknown;
}

export type IKimiPromptPart =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image_url'; readonly imageUrl: { readonly url: string; readonly id?: string } };

export interface IKimiReplayContentPart {
	readonly type: string;
	readonly text?: string;
	readonly think?: string;
	readonly imageUrl?: { readonly url: string; readonly id?: string };
	readonly audioUrl?: { readonly url: string; readonly id?: string };
	readonly videoUrl?: { readonly url: string; readonly id?: string };
}

export interface IKimiReplayMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: readonly IKimiReplayContentPart[];
	readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string | null }[];
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly origin?: Readonly<Record<string, unknown>>;
}

export interface IKimiReplayRecord {
	readonly type: string;
	readonly time: number;
	readonly message?: IKimiReplayMessage;
}

export interface IKimiResumedSessionState {
	readonly agents: Readonly<Record<string, {
		readonly replay: readonly IKimiReplayRecord[];
	}>>;
}

export interface IKimiSession {
	readonly id: string;
	readonly workDir: string;
	onEvent(listener: (event: IKimiEvent) => void): () => void;
	setApprovalHandler(handler: ((request: IKimiApprovalRequest) => Promise<{ decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }>) | undefined): void;
	setQuestionHandler(handler: ((request: IKimiQuestionRequest) => Promise<KimiQuestionResult>) | undefined): void;
	prompt(input: string | readonly IKimiPromptPart[]): Promise<void>;
	steer(input: string | readonly IKimiPromptPart[]): Promise<void>;
	cancel(): Promise<void>;
	setModel(model: string): Promise<void>;
	setThinking(effort: string): Promise<void>;
	setPermission(mode: 'yolo' | 'manual' | 'auto'): Promise<void>;
	setPlanMode(enabled: boolean): Promise<void>;
	getResumeState(): IKimiResumedSessionState | undefined;
	close(): Promise<void>;
}

export interface IKimiModelConfig {
	readonly provider: string;
	readonly model: string;
	readonly maxContextSize: number;
	readonly maxInputSize?: number;
	readonly maxOutputSize?: number;
	readonly capabilities?: readonly string[];
	readonly displayName?: string;
	readonly supportEfforts?: readonly string[];
	readonly defaultEffort?: string;
	readonly overrides?: Readonly<Partial<Omit<IKimiModelConfig, 'overrides'>>>;
}

export interface IKimiHarness {
	readonly sessions: ReadonlyMap<string, IKimiSession>;
	createSession(options: { id?: string; workDir: string; model?: string; thinking?: string; permission?: 'yolo' | 'manual' | 'auto'; planMode?: boolean; additionalDirs?: readonly string[]; agentProfile?: string }): Promise<IKimiSession>;
	/**
	 * `model` is not an SDK option: it is the agent-host model id whose endpoint
	 * the resumed session must run against, consumed by the BYOK wrapper and
	 * stripped before the call reaches the SDK.
	 */
	resumeSession(options: { id: string; additionalDirs?: readonly string[]; includeSubagents?: boolean; agentProfile?: string; model?: string }): Promise<IKimiSession>;
	listSessions(options?: { workDir?: string; sessionId?: string }): Promise<readonly IKimiSessionSummary[]>;
	getConfig(options?: { reload?: boolean }): Promise<{
		readonly defaultModel?: string;
		readonly models?: Readonly<Record<string, IKimiModelConfig>>;
	}>;
	replaceConfigSections(sections: {
		readonly providers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
		readonly models?: Readonly<Record<string, IKimiModelConfig>>;
		readonly defaultModel?: string;
	}): Promise<unknown>;
	deleteSession(id: string): Promise<void>;
	close(): Promise<void>;
}

interface IKimiSdkBindings {
	createKimiHarnessV2(options: {
		identity: { productName: string; version: string; platform: string };
		uiMode: string;
		homeDir: string;
	}): IKimiHarness;
}

export const IKimiCodeSdkService = createDecorator<IKimiCodeSdkService>('kimiCodeSdkService');

export interface IKimiCodeSdkService {
	readonly _serviceBrand: undefined;
	getHarness(): Promise<IKimiHarness>;
	canLoadWithoutDownload(): Promise<boolean>;
	close(): Promise<void>;
}

/**
 * Kimi is configured through its public config API. The selected renderer
 * Provider model is installed before sessions are created, resumed, or change
 * models, and those config-sensitive operations are serialized.
 *
 * The overlay is derived from the *selected* model: a Kimi row reaches the
 * picker from the renderer BYOK catalog as `<vendor>/<provider-local id>`, so
 * the complete model id is handed to the wire-transparent provider proxy. The
 * harness therefore holds no gateway URL and no gateway credential of its own.
 *
 * No model endpoint or credential is written to `process.env`; shell tools
 * therefore cannot inherit provider configuration.
 */
class KimiByokHarness implements IKimiHarness {
	private readonly _sessions = new Map<string, IKimiSession>();
	private readonly _configurationSequencer = new Sequencer();
	private readonly _configuredModels = new Map<string, IKimiModelConfig>();

	/**
	 * The last model an operation named, reused by operations that carry none
	 * (`getConfig`). `undefined` until the first session is created or resumed,
	 * where the overlay is simply absent and the SDK keeps its own config.
	 */
	private _model: string | undefined;

	constructor(
		private readonly _harness: IKimiHarness,
		private readonly _endpoint: IKimiByokEndpoint,
	) { }

	get sessions(): ReadonlyMap<string, IKimiSession> {
		return this._sessions;
	}

	async createSession(options: Parameters<IKimiHarness['createSession']>[0]): Promise<IKimiSession> {
		return this._withModelConfiguration(options.model, async model =>
			this._wrapSession(await this._harness.createSession({ ...options, model })));
	}

	async resumeSession(options: Parameters<IKimiHarness['resumeSession']>[0]): Promise<IKimiSession> {
		const { model, ...sdkOptions } = options;
		return this._withModelConfiguration(model, async () => this._wrapSession(await this._harness.resumeSession(sdkOptions)));
	}

	listSessions(options?: Parameters<IKimiHarness['listSessions']>[0]): Promise<readonly IKimiSessionSummary[]> {
		return this._harness.listSessions(options);
	}

	getConfig(options?: Parameters<IKimiHarness['getConfig']>[0]): ReturnType<IKimiHarness['getConfig']> {
		return this._harness.getConfig(options);
	}

	replaceConfigSections(sections: Parameters<IKimiHarness['replaceConfigSections']>[0]): ReturnType<IKimiHarness['replaceConfigSections']> {
		return this._harness.replaceConfigSections(sections);
	}

	async deleteSession(id: string): Promise<void> {
		await this._harness.deleteSession(id);
		this._sessions.delete(id);
	}

	async close(): Promise<void> {
		this._sessions.clear();
		await this._harness.close();
	}

	private _wrapSession(session: IKimiSession): IKimiSession {
		const existing = this._sessions.get(session.id);
		if (existing) {
			return existing;
		}
		const wrapped = new KimiByokSession(session, (model, task) => this._withModelConfiguration(model, async () => task()));
		this._sessions.set(session.id, wrapped);
		return wrapped;
	}

	private _withModelConfiguration<T>(model: string | undefined, task: (model: string | undefined) => Promise<T>): Promise<T> {
		if (model) {
			this._model = model;
		}
		return this._configurationSequencer.queue(async () => {
			if (this._model) {
				await this._configureModel(this._model);
			}
			return task(this._model);
		});
	}

	private async _configureModel(agentModelId: string): Promise<void> {
		const info = this._endpoint.lookupModel(agentModelId);
		this._configuredModels.set(agentModelId, {
			provider: KimiSdkProviderId,
			model: agentModelId,
			maxContextSize: info?.maxContextWindowTokens ?? 128_000,
			...(info?.maxOutputTokens !== undefined ? { maxOutputSize: info.maxOutputTokens } : {}),
			capabilities: info?.supportsVision ? ['image_in', 'thinking'] : ['thinking'],
			displayName: info?.name,
		});
		await this._harness.replaceConfigSections({
			providers: {
				[KimiSdkProviderId]: {
					type: 'kimi',
					baseUrl: this._endpoint.providerBaseUrl(),
					apiKey: this._endpoint.token,
				},
			},
			models: Object.fromEntries(this._configuredModels),
			defaultModel: agentModelId,
		});
	}
}

class KimiByokSession implements IKimiSession {
	constructor(
		private readonly _session: IKimiSession,
		private readonly _withModelConfiguration: <T>(model: string | undefined, task: () => Promise<T>) => Promise<T>,
	) { }

	get id(): string { return this._session.id; }
	get workDir(): string { return this._session.workDir; }

	onEvent(listener: (event: IKimiEvent) => void): () => void { return this._session.onEvent(listener); }
	setApprovalHandler(handler: Parameters<IKimiSession['setApprovalHandler']>[0]): void { this._session.setApprovalHandler(handler); }
	setQuestionHandler(handler: Parameters<IKimiSession['setQuestionHandler']>[0]): void { this._session.setQuestionHandler(handler); }
	prompt(input: Parameters<IKimiSession['prompt']>[0]): Promise<void> { return this._session.prompt(input); }
	steer(input: Parameters<IKimiSession['steer']>[0]): Promise<void> { return this._session.steer(input); }
	cancel(): Promise<void> { return this._session.cancel(); }
	setModel(model: string): Promise<void> { return this._withModelConfiguration(model, () => this._session.setModel(model)); }
	setThinking(effort: string): Promise<void> { return this._session.setThinking(effort); }
	setPermission(mode: Parameters<IKimiSession['setPermission']>[0]): Promise<void> { return this._session.setPermission(mode); }
	setPlanMode(enabled: boolean): Promise<void> { return this._session.setPlanMode(enabled); }
	getResumeState(): IKimiResumedSessionState | undefined { return this._session.getResumeState(); }
	close(): Promise<void> { return this._session.close(); }
}

export function wrapKimiHarnessForByok(harness: IKimiHarness, endpoint: IKimiByokEndpoint): IKimiHarness {
	return new KimiByokHarness(harness, endpoint);
}

/** Lazy loader and lifecycle owner for Kimi's in-process Node harness. */
export class KimiCodeSdkService implements IKimiCodeSdkService {
	declare readonly _serviceBrand: undefined;

	private _sdkModule: IKimiSdkBindings | undefined;
	private _harness: IKimiHarness | undefined;
	private _harnessPromise: Promise<IKimiHarness> | undefined;
	private _firstLoadFailureLogged = false;
	private readonly _home: string;
	/**
	 * The native provider proxy bind every Kimi turn runs against. Acquired with the
	 * harness and released in {@link close}: the in-process SDK keeps the
	 * endpoint it was configured with, so the handle must outlive it (the
	 * ownership invariant on {@link INativeModelProviderProxyHandle}).
	 */
	private _providerProxyHandle: INativeModelProviderProxyHandle | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IAgentSdkDownloader private readonly _downloader: IAgentSdkDownloader,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@INativeModelProviderProxyService private readonly _providerProxyService: INativeModelProviderProxyService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
	) {
		this._home = process.env[AgentHostFumieHomeEnvVar]
			? join(process.env[AgentHostFumieHomeEnvVar], 'providers', 'kimi')
			: join(this._environmentService.userDataPath, 'agentHost', 'kimi');
	}

	async getHarness(): Promise<IKimiHarness> {
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
				this._logService.error('[Kimi] Failed to load @moonshot-ai/kimi-code-sdk', error);
			}
			throw error;
		}
	}

	async canLoadWithoutDownload(): Promise<boolean> {
		return this._downloader.isSdkResolvableWithoutDownload(KimiSdkPackage);
	}

	async close(): Promise<void> {
		const loading = this._harnessPromise;
		const harness = this._harness ?? await loading?.catch(() => undefined);
		this._harness = undefined;
		this._harnessPromise = undefined;
		await harness?.close();
		// Ordering: the SDK ran in this process and is now closed, so releasing
		// the bind can no longer strand a live client.
		this._providerProxyHandle?.dispose();
		this._providerProxyHandle = undefined;
	}

	private async _createHarness(): Promise<IKimiHarness> {
		if (!syncKimiHostInstructions(this._home, composeSessionHostContext(this._productService))) {
			this._logService.warn(`[agentHost][kimi] Preserved protected or malformed instruction file at ${join(this._home, 'AGENTS.md')}`);
		}
		const handle = this._providerProxyHandle ??= await this._providerProxyService.start();
		const sdk = await this._getSdk();
		return wrapKimiHarnessForByok(sdk.createKimiHarnessV2({
			identity: {
				productName: 'fumie-agent-host',
				version: this._productService.version,
				platform: 'fumie_agent_host',
			},
			uiMode: 'vscode',
			homeDir: this._home,
		}), {
			// The SDK runs in this process and serves every session, so the token
			// cannot be session-scoped; the proxy only requires a non-empty id.
			token: `${handle.nonce}.kimi`,
			providerBaseUrl: () => handle.providerBaseUrl('chat-completions'),
			lookupModel: agentModelId => this._byokBridgeRegistry.getModels().find(m => getByokLmAgentModelId(m) === agentModelId),
		});
	}

	private async _getSdk(): Promise<IKimiSdkBindings> {
		if (this._sdkModule) {
			return this._sdkModule;
		}
		const root = await this._downloader.loadSdkRoot(KimiSdkPackage, CancellationToken.None);
		const entry = join(root, 'node_modules', '@moonshot-ai', 'kimi-code-sdk', 'dist', 'index.mjs');
		const sdkEntryUrl = pathToFileURL(entry).href;
		const sdk = await import(sdkEntryUrl) as IKimiSdkBindings;
		this._sdkModule = sdk;
		return sdk;
	}
}
