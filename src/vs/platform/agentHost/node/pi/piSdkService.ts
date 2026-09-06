/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { basename, join } from '../../../../base/common/path.js';
import { pathToFileURL } from 'url';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostPiSdkRootEnvVar } from '../../common/agentService.js';
import { IAgentSdkDownloader, type IAgentSdkPackage } from '../agentSdkDownloader.js';
import { INativeModelProviderProxyService, type INativeModelProviderProxyHandle, type NativeModelWireProtocol } from '../nativeModelProviderProxyService.js';

export const PiSdkPackage: IAgentSdkPackage = {
	id: 'pi',
	displayName: 'Pi',
	devOverrideEnvVar: AgentHostPiSdkRootEnvVar,
	hasSeparateMuslLinuxPackage: false,
};

export const PiModelProviderId = 'fumie-pi';

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IPiModelSpec {
	readonly id: string;
	readonly name: string;
	readonly wire: NativeModelWireProtocol;
	readonly reasoning: boolean;
	readonly input: readonly ('text' | 'image')[];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly thinkingLevels?: readonly PiThinkingLevel[];
	readonly defaultThinkingLevel?: PiThinkingLevel;
}

export interface IPiTextContent {
	readonly type: 'text';
	readonly text: string;
}

export interface IPiThinkingContent {
	readonly type: 'thinking';
	readonly thinking: string;
}

export interface IPiToolCallContent {
	readonly type: 'toolCall';
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface IPiImageContent {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

export type PiMessageContent = IPiTextContent | IPiThinkingContent | IPiToolCallContent | IPiImageContent;

export interface IPiUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface IPiUserMessage {
	readonly role: 'user';
	readonly content: string | readonly (IPiTextContent | IPiImageContent)[];
	readonly timestamp: number;
}

export interface IPiAssistantMessage {
	readonly role: 'assistant';
	readonly content: readonly PiMessageContent[];
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly usage: IPiUsage;
	readonly timestamp: number;
}

export interface IPiToolResultMessage {
	readonly role: 'toolResult';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly (IPiTextContent | IPiImageContent)[];
	readonly isError: boolean;
	readonly timestamp: number;
}

export type IPiAgentMessage = IPiUserMessage | IPiAssistantMessage | IPiToolResultMessage | { readonly role: string; readonly timestamp?: number };

export interface IPiBeforeToolCallContext {
	readonly toolCall: IPiToolCallContent;
	readonly args: unknown;
}

export interface IPiBeforeToolCallResult {
	readonly block?: boolean;
	readonly reason?: string;
}

export type PiBeforeToolCall = (context: IPiBeforeToolCallContext, signal?: AbortSignal) => Promise<IPiBeforeToolCallResult | undefined>;

export type IPiAgentSessionEvent =
	| { readonly type: 'message_update'; readonly assistantMessageEvent: { readonly type: string; readonly contentIndex?: number; readonly delta?: string; readonly message?: IPiAssistantMessage; readonly error?: IPiAssistantMessage } }
	| { readonly type: 'message_end'; readonly message: IPiAgentMessage }
	| { readonly type: 'tool_execution_start'; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
	| { readonly type: 'tool_execution_update'; readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly partialResult: unknown }
	| { readonly type: 'tool_execution_end'; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean }
	| { readonly type: 'agent_settled' }
	| { readonly type: 'agent_start' | 'agent_end' | 'turn_start' | 'turn_end' | 'message_start' | 'queue_update' | 'compaction_start' | 'compaction_end' | 'auto_retry_start' | 'auto_retry_end' | 'entry_appended' | 'session_info_changed' | 'thinking_level_changed' | 'bash_execution_update' };

export interface IPiAgentSession {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly messages: IPiAgentMessage[];
	readonly isIdle: boolean;
	readonly agent: {
		beforeToolCall?: PiBeforeToolCall;
	};
	subscribe(listener: (event: IPiAgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { readonly expandPromptTemplates?: boolean; readonly images?: readonly IPiImageContent[] }): Promise<void>;
	sendCustomMessage(message: { readonly customType: string; readonly content: string; readonly display: boolean }, options?: { readonly triggerTurn?: boolean }): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	setModel(model: unknown): Promise<void>;
	setThinkingLevel(level: PiThinkingLevel): void;
	dispose(): void;
}

export interface IPiSessionHandle {
	readonly session: IPiAgentSession;
	readonly cwd: string;
	readonly sessionFileName: string | undefined;
	dispose(): void;
}

export interface IPiCreateSessionOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionDir: string;
	readonly sessionFileName?: string;
	readonly model: IPiModelSpec;
	readonly thinkingLevel: PiThinkingLevel;
	readonly systemPrompt: string;
	readonly tools?: readonly ('read' | 'write' | 'edit' | 'bash')[];
	readonly beforeToolCall?: PiBeforeToolCall;
	readonly inMemory?: boolean;
}

export const IPiSdkService = createDecorator<IPiSdkService>('piSdkService');

export interface IPiSdkService {
	readonly _serviceBrand: undefined;
	createSession(options: IPiCreateSessionOptions): Promise<IPiSessionHandle>;
	canLoadWithoutDownload(): Promise<boolean>;
	close(): Promise<void>;
}

interface IPiModelRuntime {
	registerProvider(providerId: string, config: Record<string, unknown>): void;
	getModel(providerId: string, modelId: string): unknown;
}

interface IPiBindings {
	readonly ModelRuntime: {
		create(options: Record<string, unknown>): Promise<IPiModelRuntime>;
	};
	readonly DefaultResourceLoader: new (options: Record<string, unknown>) => {
		reload(): Promise<void>;
	};
	readonly SettingsManager: {
		inMemory(): unknown;
	};
	readonly SessionManager: {
		create(cwd: string, sessionDir?: string, options?: { readonly id?: string }): unknown;
		open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
		inMemory(cwd?: string, options?: { readonly id?: string }): unknown;
	};
	readonly createAgentSession: (options: Record<string, unknown>) => Promise<{ readonly session: IPiAgentSession }>;
}

const EMPTY_CREDENTIAL_STORE = {
	read: async () => undefined,
	list: async () => [],
	modify: async (_providerId: string, fn: (current: undefined) => Promise<undefined>) => fn(undefined),
	delete: async () => undefined,
};

export class PiSdkService implements IPiSdkService {
	declare readonly _serviceBrand: undefined;

	private _bindings: IPiBindings | undefined;
	private _bindingsPromise: Promise<IPiBindings> | undefined;
	private _providerProxyHandle: INativeModelProviderProxyHandle | undefined;
	private _firstLoadFailureLogged = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAgentSdkDownloader private readonly _downloader: IAgentSdkDownloader,
		@INativeModelProviderProxyService private readonly _providerProxyService: INativeModelProviderProxyService,
	) { }

	async createSession(options: IPiCreateSessionOptions): Promise<IPiSessionHandle> {
		const bindings = await this._getBindings();
		const proxy = this._providerProxyHandle ??= await this._providerProxyService.start();
		const api = piApiForWire(options.model.wire);
		const baseUrl = proxy.providerBaseUrl(options.model.wire);
		const modelRuntime = await bindings.ModelRuntime.create({
			credentials: EMPTY_CREDENTIAL_STORE,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider(PiModelProviderId, {
			name: 'Fumie',
			baseUrl,
			apiKey: `${proxy.nonce}.pi`,
			api,
			models: [{
				id: options.model.id,
				name: options.model.name,
				api,
				baseUrl,
				reasoning: options.model.reasoning,
				...(options.model.thinkingLevels?.length ? { thinkingLevelMap: piThinkingLevelMap(options.model.thinkingLevels) } : {}),
				input: [...options.model.input],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: options.model.contextWindow,
				maxTokens: options.model.maxTokens,
			}],
		});
		const model = modelRuntime.getModel(PiModelProviderId, options.model.id);
		if (!model) {
			throw new Error(`Pi could not configure model '${options.model.id}'.`);
		}

		const settingsManager = bindings.SettingsManager.inMemory();
		const agentDir = join(options.sessionDir, '.pi');
		const resourceLoader = new bindings.DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: options.systemPrompt,
		});
		await resourceLoader.reload();

		const sessionManager = options.inMemory
			? bindings.SessionManager.inMemory(options.cwd, { id: options.sessionId })
			: this._sessionManager(bindings, options);
		const { session } = await bindings.createAgentSession({
			cwd: options.cwd,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: options.thinkingLevel,
			tools: [...(options.tools ?? ['read', 'write', 'edit', 'bash'])],
			resourceLoader,
			settingsManager,
			sessionManager,
		});
		if (options.beforeToolCall) {
			const inherited = session.agent.beforeToolCall;
			session.agent.beforeToolCall = async (context, signal) => {
				const prior = await inherited?.(context, signal);
				return prior?.block ? prior : options.beforeToolCall?.(context, signal);
			};
		}
		return {
			session,
			cwd: options.cwd,
			sessionFileName: session.sessionFile ? basename(session.sessionFile) : options.sessionFileName,
			dispose: () => session.dispose(),
		};
	}

	canLoadWithoutDownload(): Promise<boolean> {
		return this._downloader.isSdkResolvableWithoutDownload(PiSdkPackage);
	}

	async close(): Promise<void> {
		this._bindings = undefined;
		this._bindingsPromise = undefined;
		this._providerProxyHandle?.dispose();
		this._providerProxyHandle = undefined;
	}

	private _sessionManager(bindings: IPiBindings, options: IPiCreateSessionOptions): unknown {
		if (options.sessionFileName) {
			const path = join(options.sessionDir, basename(options.sessionFileName));
			if (!existsSync(path)) {
				throw new Error(`Pi transcript does not exist: ${path}`);
			}
			return bindings.SessionManager.open(path, options.sessionDir, options.cwd);
		}
		return bindings.SessionManager.create(options.cwd, options.sessionDir, { id: options.sessionId });
	}

	private async _getBindings(): Promise<IPiBindings> {
		if (this._bindings) {
			return this._bindings;
		}
		if (this._bindingsPromise) {
			return this._bindingsPromise;
		}
		const loading = this._loadBindings();
		this._bindingsPromise = loading;
		try {
			this._bindings = await loading;
			return this._bindings;
		} catch (error) {
			if (this._bindingsPromise === loading) {
				this._bindingsPromise = undefined;
			}
			if (!this._firstLoadFailureLogged) {
				this._firstLoadFailureLogged = true;
				this._logService.error('[Pi] Failed to load the Pi coding-agent SDK', error);
			}
			throw error;
		}
	}

	private async _loadBindings(): Promise<IPiBindings> {
		const root = await this._downloader.loadSdkRoot(PiSdkPackage, CancellationToken.None);
		const entry = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
		return import(pathToFileURL(entry).href) as Promise<IPiBindings>;
	}
}

function piApiForWire(wire: NativeModelWireProtocol): 'openai-responses' | 'anthropic-messages' | 'openai-completions' {
	switch (wire) {
		case 'responses': return 'openai-responses';
		case 'messages': return 'anthropic-messages';
		case 'chat-completions': return 'openai-completions';
	}
}

function piThinkingLevelMap(levels: readonly PiThinkingLevel[]): Partial<Record<PiThinkingLevel, PiThinkingLevel | null>> {
	const supported = new Set(levels);
	const result: Partial<Record<PiThinkingLevel, PiThinkingLevel | null>> = {};
	for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
		result[level] = supported.has(level) ? level : null;
	}
	return result;
}
