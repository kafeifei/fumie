/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { SequencerByKey, raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent, PI_AGENT_PROVIDER_ID, resolveAgentChatContext, resolveAgentHostInstructions } from '../../common/agent.js';
import { AutoApproveLevel, createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { getByokLmAgentModelId, visibleByokLmModels, type IByokLmProviderConfiguration } from '../../common/agentHostByokLm.js';
import { createAgentModelByokMeta } from '../../common/agentModelByokMeta.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelSourceMeta } from '../../common/agentModelSource.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { getReasoningEffortDescription, getReasoningEffortLabel, resolveDefaultReasoningEffort } from '../../common/reasoningEffort.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachmentKind, type AgentSelection, type ConfigSchema, type ModelSelection, type ProtectedResourceMetadata, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ChatInputResponseKind, MessageKind, ResponsePartKind, ToolCallStatus, ToolResultContentType, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_MODELS, IChatGptSubscriptionService, chatGptSubscriptionAgentModelId, chatGptSubscriptionMaxOutputTokens, parseChatGptSubscriptionModelId, type IChatGptSubscriptionModel, type IChatGptSubscriptionServiceTier } from '../chatGptSubscription.js';
import { composeSessionHostContext } from '../../common/sessionHostContext.js';
import { IProductService } from '../../../product/common/productService.js';
import { replayPiMessagesToTurns } from './piReplayMapper.js';
import { IPiSdkService, type IPiAgentSessionEvent, type IPiAssistantMessage, type IPiBeforeToolCallContext, type IPiImageContent, type IPiModelSpec, type IPiSessionHandle, type PiThinkingLevel } from './piSdkService.js';
import { buildPiToolMeta, getPiApprovalTarget, getPiConfirmationTitle, getPiInvocationMessage, getPiPastTenseMessage, getPiToolDisplayName, stringifyPiToolInput } from './piToolDisplay.js';

const PiThinkingLevelConfigKey = 'thinkingLevel';
/** Shared with Codex so the model config UI groups it under "Speed". */
const PiServiceTierConfigKey = 'serviceTier';
/** The tier the backend serves when the request names none, so it is never sent. */
const PiStandardServiceTier = 'standard';
const PI_SYSTEM_PROMPT = 'You are Pi, a compact coding agent hosted inside Fumie. Inspect the workspace before editing, follow the user\'s request precisely, and use read, write, edit, and bash as needed. Fumie owns permissions, worktrees, and the visible session catalog.';

const piSessionConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
});

interface IPiTurnState {
	readonly id: string;
	readonly startedAt: number;
	readonly toolCalls: Map<string, { readonly name: string; readonly input: unknown }>;
	readonly streamedTextParts: Map<number, string>;
	readonly streamedReasoningParts: Map<number, string>;
	textPartIndex: number;
	reasoningPartIndex: number;
	lastAssistant?: IPiAssistantMessage;
	cancelRequested: boolean;
}

interface IPiChatEntry {
	readonly session: URI;
	readonly chat: URI;
	readonly storageResource: URI;
	workingDirectories: readonly URI[];
	model?: ModelSelection;
	providerData?: string;
	handle?: IPiSessionHandle;
	unsubscribe?: () => void;
	turn?: IPiTurnState;
}

class PiActiveClient implements IActiveClient {
	tools: readonly ToolDefinition[] = [];
	customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }
}

export class PiAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = PI_AGENT_PROVIDER_ID;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;
	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;
	readonly onDidDiscoverChats: IAgent['onDidDiscoverChats'] = Event.None;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _entries = new Map<string, IPiChatEntry>();
	private readonly _activeClients = new Map<string, PiActiveClient>();
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, IPiChatEntry>();
	private readonly _sequencer = new SequencerByKey<string>();
	private _shutdownPromise: Promise<void> | undefined;

	constructor(
		@IPiSdkService private readonly _sdkService: IPiSdkService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IChatGptSubscriptionService private readonly _chatGptSubscription: IChatGptSubscriptionService,
	) {
		super();
		this._register(this._byokBridgeRegistry.onDidChangeModels(() => this._refreshModels()));
		this._register(this._chatGptSubscription.onDidChangeSignedIn(() => this._refreshModels()));
		this._refreshModels();
	}

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this._createChat(chat, context, options),
		deleteChat: chat => this._deleteChat(chat),
		disposeChat: chat => this._deleteChat(chat),
		releaseChat: chat => this._releaseChat(chat),
		sendMessage: (chat, prompt, workingDirectories, attachments, turnId, _senderClientId, _clientType, context) => this._sendMessage(chat, prompt, normalizeWorkingDirectories(workingDirectories), attachments, turnId, context),
		abort: chat => this._abort(chat),
		changeModel: (chat, model) => this._changeModel(chat, model),
		changeAgent: (chat, agent) => this._changeAgent(chat, agent),
		getMessages: chat => this._getMessages(chat),
	};

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('piAgent.displayName', "Pi"),
			description: localize('piAgent.description', "Minimal, model-agnostic coding agent powered by Pi"),
			capabilities: { modelCatalog: 'projected' },
		};
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({
			schema: piSessionConfigSchema.toProtocol(),
			values: piSessionConfigSchema.validateOrDefault(params.config, {
				[SessionConfigKey.AutoApprove]: 'default' satisfies AutoApproveLevel,
			}),
		});
	}

	getInheritedChatConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		const inherited: Record<string, unknown> = {};
		for (const key of [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions]) {
			if (config[key] !== undefined) {
				inherited[key] = config[key];
			}
		}
		return Object.keys(inherited).length > 0 ? inherited : undefined;
	}

	chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	listChatsToMigrate(): Promise<readonly IAgentChatMetadata[]> {
		return Promise.resolve([]);
	}

	getChatMetadata(chat: URI, context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		const entry = this._entries.get(chat.toString());
		if (entry?.handle) {
			return Promise.resolve({
				chat,
				startTime: 0,
				modifiedTime: Date.now(),
				model: entry.model,
				workingDirectories: entry.workingDirectories,
			});
		}
		const session = resolveAgentChatContext(context, chat).configurationResource;
		const decoded = decodePiProviderData(providerData ?? entry?.providerData);
		if (!decoded?.sessionFileName || !decoded.cwd || decoded.sessionId !== AgentSession.id(session)) {
			return Promise.resolve(undefined);
		}
		return Promise.resolve({
			chat,
			startTime: 0,
			modifiedTime: Date.now(),
			model: entry?.model ?? decoded.model,
			workingDirectories: entry?.workingDirectories ?? [URI.file(decoded.cwd)],
		});
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const resolved = resolveAgentChatContext(context, chat);
		const decoded = decodePiProviderData(providerData);
		if (!decoded?.sessionFileName || !decoded.cwd) {
			return;
		}
		let entry = this._entries.get(chat.toString());
		if (!entry) {
			entry = {
				session: resolved.configurationResource,
				chat,
				storageResource: resolved.resource,
				workingDirectories: [URI.file(decoded.cwd)],
				model: decoded.model,
				providerData,
			};
			this._entries.set(chat.toString(), entry);
		}
		try {
			await this._materialize(entry, decoded.sessionFileName);
			return {
				providerData: entry.providerData,
				resolvedWorkingDirectory: entry.workingDirectories[0],
			};
		} catch (error) {
			this._logService.warn(`[Pi] Failed to restore ${chat.toString()}`, error);
			return;
		}
	}

	async generateTitle(session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken): Promise<string | undefined> {
		try {
			const entry = [...this._entries.values()].find(candidate => candidate.session.toString() === session.toString());
			const selection = request.modelId ? { id: request.modelId } : entry?.model;
			const model = await this._resolveModelSpec(selection);
			const cwd = entry?.workingDirectories[0]?.fsPath ?? os.tmpdir();
			const handle = await this._sdkService.createSession({
				sessionId: generateUuid(),
				cwd,
				sessionDir: this._sessionDataService.getSessionDataDir(session).fsPath,
				model,
				thinkingLevel: 'off',
				systemPrompt: 'Return only a concise 3-8 word title for the coding session. Do not use tools, quotes, or ending punctuation.',
				tools: [],
				inMemory: true,
			});
			const cancellation = token.onCancellationRequested(() => { void handle.session.abort(); });
			try {
				await raceCancellation(handle.session.prompt(request.prompt, { expandPromptTemplates: false }), token);
				return token.isCancellationRequested ? undefined : lastPiAssistantText(handle.session.messages);
			} finally {
				cancellation.dispose();
				handle.dispose();
			}
		} catch (error) {
			this._logService.warn('[Pi] Failed to generate a session title', error);
			return undefined;
		}
	}

	getChatCustomizations(): Promise<readonly []> {
		return Promise.resolve([]);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${chat.toString()}\u0000${client.clientId}`;
		let result = this._activeClients.get(key);
		if (!result) {
			result = new PiActiveClient(client.clientId, client.displayName);
			this._activeClients.set(key, result);
		}
		return result;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}\u0000${clientId}`);
	}

	onClientToolCallComplete(): void {
		// Pi's minimal built-in tool set executes inside its own runtime.
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// Pi has no built-in ask-user tool.
	}

	shutdown(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._pendingPermissions.denyAll(false);
			for (const entry of this._entries.values()) {
				await this._releaseEntry(entry);
			}
			this._entries.clear();
			await this._sdkService.close();
		})();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}

	private _refreshModels(): void {
		const byokModels = this._byokBridgeRegistry.getModels()
			.filter(model => model.supportedHarnesses?.includes(this.id))
			.map((model): IAgentModelInfo => {
				const configSchema = createPiModelConfigSchema(model.supportedReasoningEfforts, model.defaultReasoningEffort);
				const byokMeta = createAgentModelByokMeta(model.modelIdentifier, model.hidden);
				return {
					provider: this.id,
					id: getByokLmAgentModelId(model),
					// The vendor route in the id is ours; the native provider
					// proxy resolves it to the provider-local model before the
					// request goes upstream, so that is the id the runtime
					// reports back.
					underlyingModelId: model.id,
					name: model.name ?? model.id,
					maxContextWindow: model.maxContextWindowTokens,
					maxOutputTokens: model.maxOutputTokens,
					supportsVision: model.supportsVision ?? false,
					...(configSchema ? { configSchema } : {}),
					...(byokMeta ? { _meta: byokMeta } : {}),
				};
			});
		this._models.set([...byokModels, ...this._chatGptSubscriptionModels()], undefined);
	}

	/**
	 * The ChatGPT subscription rows, which the host synthesizes rather than
	 * projecting from the renderer catalog: the user configured no provider group
	 * for them, they are reachable purely because Codex is signed in. Signed out
	 * they are absent entirely — a row that cannot run is worse than no row.
	 */
	private _chatGptSubscriptionModels(): IAgentModelInfo[] {
		if (!this._chatGptSubscription.isSignedIn()) {
			return [];
		}
		return CHATGPT_SUBSCRIPTION_MODELS.map((model): IAgentModelInfo => {
			const configSchema = createPiModelConfigSchema(model.supportedReasoningEfforts, model.defaultReasoningEffort, model.serviceTiers);
			return {
				provider: this.id,
				id: chatGptSubscriptionAgentModelId(model.id),
				// The `@provider=` qualification is ours; the ChatGPT backend
				// names the bare model.
				underlyingModelId: model.id,
				name: model.name,
				maxContextWindow: model.maxContextWindowTokens,
				maxOutputTokens: chatGptSubscriptionMaxOutputTokens(model),
				supportsVision: model.supportsVision,
				_meta: createAgentModelSourceMeta(CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID),
				...(configSchema ? { configSchema } : {}),
			};
		});
	}

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options: IAgentCreateChatOptions = {}): Promise<IAgentCreateChatResult> {
		if (options.fork || options.sideChat || options.importConversation) {
			throw new Error('Pi chat branching and import are not exposed through Fumie.');
		}
		if (options.agent) {
			throw new Error('Pi custom agent profiles are not exposed through Fumie.');
		}
		const resolved = resolveAgentChatContext(context, chat);
		const existing = this._entries.get(chat.toString());
		if (existing) {
			return {
				resolvedWorkingDirectory: existing.workingDirectories[0],
				provisional: existing.handle === undefined,
				providerData: existing.providerData,
			};
		}
		const primary = options.workingDirectories?.[0];
		if (!primary) {
			throw new Error('Pi requires the Agent Host to provide an execution directory.');
		}
		const entry: IPiChatEntry = {
			session: resolved.configurationResource,
			chat,
			storageResource: resolved.resource,
			workingDirectories: [primary],
			model: options.model,
		};
		entry.providerData = encodePiProviderData(entry);
		this._entries.set(chat.toString(), entry);
		return { resolvedWorkingDirectory: primary, provisional: true, providerData: entry.providerData };
	}

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined, context: URI | IAgentChatContext | undefined): Promise<void> {
		return this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entryForChat(chat);
			if (entry.turn) {
				throw new Error('A response is already being generated for this Pi chat.');
			}
			if (workingDirectories?.[0] && !isEqual(entry.workingDirectories[0], workingDirectories[0])) {
				await this._releaseEntry(entry);
				entry.workingDirectories = [workingDirectories[0]];
			}
			const handle = await this._materialize(entry);
			const effectiveTurnId = turnId ?? generateUuid();
			entry.turn = {
				id: effectiveTurnId,
				startedAt: Date.now(),
				toolCalls: new Map(),
				streamedTextParts: new Map(),
				streamedReasoningParts: new Map(),
				textPartIndex: 0,
				reasoningPartIndex: 0,
				cancelRequested: false,
			};
			this._fire(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: effectiveTurnId,
				startedAt: new Date(entry.turn.startedAt).toISOString(),
				message: { text: prompt, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments: [...attachments] } : {}), ...(entry.model ? { model: entry.model } : {}) },
			});
			try {
				const instructions = resolveAgentHostInstructions(context);
				if (instructions?.length) {
					await handle.session.sendCustomMessage({ customType: 'fumie-host-instructions', content: instructions.join('\n\n'), display: false }, { triggerTurn: false });
				}
				const input = piPromptInput(prompt, attachments);
				await handle.session.prompt(input.text, { expandPromptTemplates: false, ...(input.images.length ? { images: input.images } : {}) });
			} catch (error) {
				if (entry.turn?.id === effectiveTurnId) {
					this._finishWithError(entry, error);
				}
				throw error;
			}
		});
	}

	/**
	 * Pi's session system prompt: the fixed Pi identity plus the session-constant
	 * host briefing (`composeSessionHostContext`) — Pi's session-level channel,
	 * so the briefing reaches the model once per session instead of riding every
	 * turn as a hidden custom message.
	 */
	private _systemPrompt(): string {
		const hostContext = composeSessionHostContext(this._productService);
		return hostContext ? `${PI_SYSTEM_PROMPT}\n\n${hostContext}` : PI_SYSTEM_PROMPT;
	}

	private async _materialize(entry: IPiChatEntry, sessionFileName?: string): Promise<IPiSessionHandle> {
		if (entry.handle) {
			return entry.handle;
		}
		const model = await this._resolveModelSpec(entry.model);
		const cwd = entry.workingDirectories[0]?.fsPath;
		if (!cwd) {
			throw new Error('Pi has no execution directory.');
		}
		const handle = await this._sdkService.createSession({
			sessionId: AgentSession.id(entry.session),
			cwd,
			sessionDir: URI.joinPath(this._sessionDataService.getSessionDataDir(entry.storageResource), 'pi').fsPath,
			sessionFileName,
			model,
			thinkingLevel: piThinkingLevel(entry.model, model),
			systemPrompt: this._systemPrompt(),
			beforeToolCall: (call, signal) => this._beforeToolCall(entry, call, signal),
		});
		entry.handle = handle;
		entry.unsubscribe = handle.session.subscribe(event => this._handleEvent(entry, event));
		entry.providerData = encodePiProviderData(entry);
		this._onDidMaterializeChat.fire({ chat: entry.chat, result: { providerData: entry.providerData }, workingDirectories: entry.workingDirectories, project: undefined });
		return handle;
	}

	private async _beforeToolCall(entry: IPiChatEntry, call: IPiBeforeToolCallContext, signal?: AbortSignal): Promise<{ block?: boolean; reason?: string } | undefined> {
		const turn = entry.turn;
		if (!turn) {
			return { block: true, reason: 'Pi has no active Fumie turn.' };
		}
		const toolCallId = call.toolCall.id;
		const toolName = call.toolCall.name;
		const input = call.args;
		turn.toolCalls.set(toolCallId, { name: toolName, input });
		const displayName = getPiToolDisplayName(toolName);
		const meta = buildPiToolMeta(toolName);
		this._fire(entry.chat, { type: ActionType.ChatToolCallStart, turnId: turn.id, toolCallId, toolName, displayName, ...(meta ? { _meta: meta } : {}) });
		const toolInput = stringifyPiToolInput(input);
		if (toolInput) {
			this._fire(entry.chat, { type: ActionType.ChatToolCallDelta, turnId: turn.id, toolCallId, content: toolInput });
		}
		const target = getPiApprovalTarget(toolName, input, entry.handle?.cwd ?? entry.workingDirectories[0].fsPath);
		const approved = await this._pendingPermissions.registerAndFire(toolCallId, () => {
			this._onDidChatProgress.fire({
				kind: 'pending_confirmation',
				chat: entry.chat,
				...target,
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId,
					toolName,
					displayName,
					invocationMessage: getPiInvocationMessage(toolName, input, entry.workingDirectories[0].fsPath),
					toolInput,
					confirmationTitle: getPiConfirmationTitle(toolName),
					...(meta ? { _meta: meta } : {}),
				},
			});
		}, entry);
		return approved && !signal?.aborted ? undefined : { block: true, reason: 'Tool call was not approved.' };
	}

	private _handleEvent(entry: IPiChatEntry, event: IPiAgentSessionEvent): void {
		const turn = entry.turn;
		if (!turn) {
			return;
		}
		switch (event.type) {
			case 'message_update':
				this._handleMessageUpdate(entry, turn, event);
				break;
			case 'message_end':
				this._handleMessageEnd(entry, turn, event.message);
				break;
			case 'tool_execution_end':
				this._handleToolResult(entry, turn, event.toolCallId, event.result, event.isError);
				break;
			case 'agent_settled':
				this._finishTurn(entry, turn);
				break;
		}
	}

	private _handleMessageUpdate(entry: IPiChatEntry, turn: IPiTurnState, event: Extract<IPiAgentSessionEvent, { type: 'message_update' }>): void {
		const update = event.assistantMessageEvent;
		const index = update.contentIndex;
		if (index === undefined) {
			return;
		}
		if (update.type === 'text_start') {
			this._ensureStreamingPart(entry, turn, index, false);
		} else if (update.type === 'thinking_start') {
			this._ensureStreamingPart(entry, turn, index, true);
		} else if (update.type === 'text_delta' && update.delta) {
			const partId = this._ensureStreamingPart(entry, turn, index, false);
			this._fire(entry.chat, { type: ActionType.ChatDelta, turnId: turn.id, partId, content: update.delta });
		} else if (update.type === 'thinking_delta' && update.delta) {
			const partId = this._ensureStreamingPart(entry, turn, index, true);
			this._fire(entry.chat, { type: ActionType.ChatReasoning, turnId: turn.id, partId, content: update.delta });
		}
	}

	private _ensureStreamingPart(entry: IPiChatEntry, turn: IPiTurnState, index: number, reasoning: boolean): string {
		const map = reasoning ? turn.streamedReasoningParts : turn.streamedTextParts;
		let partId = map.get(index);
		if (!partId) {
			partId = reasoning ? `${turn.id}:reasoning:${String(turn.reasoningPartIndex++)}` : `${turn.id}:text:${String(turn.textPartIndex++)}`;
			map.set(index, partId);
			this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: reasoning ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown, id: partId, content: '' } });
		}
		return partId;
	}

	private _handleMessageEnd(entry: IPiChatEntry, turn: IPiTurnState, message: { readonly role: string }): void {
		if (message.role !== 'assistant') {
			return;
		}
		const assistant = message as IPiAssistantMessage;
		turn.lastAssistant = assistant;
		assistant.content.forEach((content, index) => {
			if (content.type === 'text' && content.text && !turn.streamedTextParts.has(index)) {
				this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Markdown, id: `${turn.id}:text:${String(turn.textPartIndex++)}`, content: content.text } });
			} else if (content.type === 'thinking' && content.thinking && !turn.streamedReasoningParts.has(index)) {
				this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Reasoning, id: `${turn.id}:reasoning:${String(turn.reasoningPartIndex++)}`, content: content.thinking } });
			}
		});
		const usage = piUsage(assistant);
		if (usage) {
			this._fire(entry.chat, { type: ActionType.ChatUsage, turnId: turn.id, usage: { ...usage, ...(entry.model ? { model: entry.model.id } : {}) } });
		}
	}

	private _handleToolResult(entry: IPiChatEntry, turn: IPiTurnState, toolCallId: string, result: unknown, isError: boolean): void {
		const tracked = turn.toolCalls.get(toolCallId);
		const toolName = tracked?.name ?? 'tool';
		const output = piToolResultText(result);
		this._fire(entry.chat, {
			type: ActionType.ChatToolCallComplete,
			turnId: turn.id,
			toolCallId,
			result: {
				success: !isError,
				pastTenseMessage: getPiPastTenseMessage(toolName, tracked?.input, entry.workingDirectories[0].fsPath, !isError),
				...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
				...(isError ? { error: { message: output || 'Pi tool failed' } } : {}),
			},
		});
		turn.toolCalls.delete(toolCallId);
	}

	private _finishTurn(entry: IPiChatEntry, turn: IPiTurnState): void {
		if (entry.turn !== turn) {
			return;
		}
		const duration = Date.now() - turn.startedAt;
		const stopReason = turn.lastAssistant?.stopReason;
		if (turn.cancelRequested || stopReason === 'aborted') {
			this._fire(entry.chat, { type: ActionType.ChatTurnCancelled, turnId: turn.id, duration });
		} else if (stopReason === 'error') {
			this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration, error: { errorType: 'PiError', message: turn.lastAssistant?.errorMessage ?? 'Pi request failed' } });
			this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
		} else {
			this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
		}
		entry.turn = undefined;
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const entry = this._entryForChat(chat);
		const spec = await this._resolveModelSpec(model);
		if (entry.handle) {
			const replacement = await this._sdkService.createSession({
				sessionId: AgentSession.id(entry.session),
				cwd: entry.workingDirectories[0].fsPath,
				sessionDir: URI.joinPath(this._sessionDataService.getSessionDataDir(entry.storageResource), 'pi').fsPath,
				sessionFileName: entry.handle.sessionFileName,
				model: spec,
				thinkingLevel: piThinkingLevel(model, spec),
				systemPrompt: this._systemPrompt(),
				beforeToolCall: (call, signal) => this._beforeToolCall(entry, call, signal),
			});
			await this._releaseEntry(entry);
			entry.handle = replacement;
			entry.unsubscribe = replacement.session.subscribe(event => this._handleEvent(entry, event));
		}
		entry.model = model;
		entry.providerData = encodePiProviderData(entry);
		this._onDidChangeChatData.fire({ chat, providerData: entry.providerData });
	}

	private _changeAgent(_chat: URI, agent: AgentSelection | undefined): Promise<void> {
		return agent ? Promise.reject(new Error('Pi custom agent profiles are not exposed through Fumie.')) : Promise.resolve();
	}

	private async _abort(chat: URI): Promise<void> {
		const entry = this._entryForChat(chat);
		if (entry.turn) {
			entry.turn.cancelRequested = true;
		}
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		await entry.handle?.session.abort();
	}

	private _getMessages(chat: URI): Promise<readonly Turn[]> {
		const entry = this._entries.get(chat.toString());
		return Promise.resolve(entry?.handle ? replayPiMessagesToTurns(entry.handle.session.messages, AgentSession.id(entry.session), entry.handle.cwd) : []);
	}

	private async _deleteChat(chat: URI): Promise<void> {
		await this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entries.get(chat.toString());
			if (entry) {
				await this._releaseEntry(entry);
				this._entries.delete(chat.toString());
			}
		});
	}

	private async _releaseChat(chat: URI): Promise<void> {
		await this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entries.get(chat.toString());
			if (entry) {
				await this._releaseEntry(entry);
			}
		});
	}

	private async _releaseEntry(entry: IPiChatEntry): Promise<void> {
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
		entry.handle?.dispose();
		entry.handle = undefined;
		entry.turn = undefined;
	}

	private _entryForChat(chat: URI): IPiChatEntry {
		const entry = this._entries.get(chat.toString());
		if (!entry) {
			throw new Error(`Unknown Pi chat: ${chat.toString()}`);
		}
		return entry;
	}

	private async _resolveModelSpec(selection: ModelSelection | undefined): Promise<IPiModelSpec> {
		const subscription = selection ? parseChatGptSubscriptionModelId(selection.id) : undefined;
		if (subscription) {
			const subscriptionModel = CHATGPT_SUBSCRIPTION_MODELS.find(model => model.id === subscription.modelId);
			if (!subscriptionModel) {
				throw new Error(`Pi cannot run ChatGPT subscription model '${subscription.modelId}'.`);
			}
			return chatGptSubscriptionModelSpec(subscriptionModel, piServiceTier(selection, subscriptionModel));
		}
		const rows = visibleByokLmModels(this._byokBridgeRegistry.getModels()).filter(model => model.supportedHarnesses?.includes(this.id));
		const row = selection
			? rows.find(model => getByokLmAgentModelId(model) === selection.id)
			: rows[0];
		if (!row) {
			throw new Error(`Pi cannot run model '${selection?.id ?? ''}': it is not advertised as Pi-compatible.`);
		}
		const modelIdentifier = row.modelIdentifier ?? getByokLmAgentModelId(row);
		const provider = await this._byokBridgeRegistry.resolveProviderConfiguration?.(modelIdentifier);
		if (!provider) {
			throw new Error(`Pi cannot resolve the configured provider for '${modelIdentifier}'.`);
		}
		const levels = piThinkingLevels(row.supportedReasoningEfforts);
		const contextWindow = row.maxContextWindowTokens ?? 128_000;
		const defaultThinkingLevel = resolveDefaultReasoningEffort(levels, row.defaultReasoningEffort);
		return {
			id: modelIdentifier,
			name: row.name ?? row.id,
			wire: piWire(provider),
			reasoning: levels.length > 0,
			input: row.supportsVision ? ['text', 'image'] : ['text'],
			contextWindow,
			maxTokens: Math.min(row.maxOutputTokens ?? 16_384, contextWindow),
			...(levels.length ? { thinkingLevels: levels } : {}),
			...(defaultThinkingLevel ? { defaultThinkingLevel: defaultThinkingLevel as PiThinkingLevel } : {}),
		};
	}

	private _finishWithError(entry: IPiChatEntry, error: unknown): void {
		const turn = entry.turn;
		if (!turn) {
			return;
		}
		const duration = Date.now() - turn.startedAt;
		const message = error instanceof Error ? error.message : String(error);
		this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration, error: { errorType: error instanceof Error ? error.name : 'PiError', message, ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) } });
		this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
		entry.turn = undefined;
	}

	private _fire(resource: URI, action: Extract<AgentSignal, { kind: 'action' }>['action']): void {
		this._onDidChatProgress.fire({ kind: 'action', resource, action });
	}
}

function normalizeWorkingDirectories(value: readonly URI[] | URI | undefined): readonly URI[] | undefined {
	return URI.isUri(value) ? [value] : value;
}

function createPiModelConfigSchema(efforts: readonly string[] | undefined, defaultEffort: string | undefined, serviceTiers?: readonly IChatGptSubscriptionServiceTier[]): ConfigSchema | undefined {
	const properties: ConfigSchema['properties'] = {};
	const levels = piThinkingLevels(efforts);
	if (levels.length > 0) {
		const resolvedDefault = resolveDefaultReasoningEffort(levels, defaultEffort);
		properties[PiThinkingLevelConfigKey] = {
			type: 'string',
			title: localize('pi.modelThinkingLevel.title', "Thinking Level"),
			description: localize('pi.modelThinkingLevel.description', "Controls how much reasoning effort Pi asks the model to use."),
			enum: [...levels],
			enumLabels: levels.map(getReasoningEffortLabel),
			enumDescriptions: levels.map(level => getReasoningEffortDescription(level) ?? ''),
			...(resolvedDefault ? { default: resolvedDefault } : {}),
		};
	}
	// The standard tier is the absence of a tier, so it is a choice we add here
	// rather than one upstream publishes.
	const additionalTiers = (serviceTiers ?? []).filter(tier => tier.id !== PiStandardServiceTier);
	if (additionalTiers.length > 0) {
		properties[PiServiceTierConfigKey] = {
			type: 'string',
			title: localize('pi.modelServiceTier.title', "Speed"),
			description: localize('pi.modelServiceTier.description', "Controls Pi response speed and usage."),
			default: PiStandardServiceTier,
			enum: [PiStandardServiceTier, ...additionalTiers.map(tier => tier.id)],
			enumLabels: [localize('pi.modelServiceTier.standard', "Standard"), ...additionalTiers.map(tier => tier.name)],
			enumDescriptions: [localize('pi.modelServiceTier.standardDescription', "Standard speed and usage."), ...additionalTiers.map(tier => tier.description)],
		};
	}
	if (Object.keys(properties).length === 0) {
		return undefined;
	}
	return {
		type: 'object',
		properties,
	};
}

function piThinkingLevels(values: readonly string[] | undefined): PiThinkingLevel[] {
	return (values ?? []).filter((value): value is PiThinkingLevel => value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max');
}

function piThinkingLevel(selection: ModelSelection | undefined, spec: IPiModelSpec): PiThinkingLevel {
	const selected = selection?.config?.[PiThinkingLevelConfigKey];
	if (typeof selected === 'string' && piThinkingLevels([selected]).length > 0 && spec.thinkingLevels?.includes(selected as PiThinkingLevel)) {
		return selected as PiThinkingLevel;
	}
	return spec.defaultThinkingLevel ?? spec.thinkingLevels?.[0] ?? 'off';
}

/**
 * The tier `selection` asks for, or `undefined` for the standard one — which is
 * the absence of a `service_tier`, not a value to send.
 */
function piServiceTier(selection: ModelSelection | undefined, model: IChatGptSubscriptionModel): string | undefined {
	const selected = selection?.config?.[PiServiceTierConfigKey];
	return typeof selected === 'string' && model.serviceTiers?.some(tier => tier.id === selected) ? selected : undefined;
}

/**
 * The Pi runtime spec for a ChatGPT subscription model. The id stays
 * provider-qualified because it is what Pi puts in the request body, and the
 * proxy routes on it — which is also why a chosen `serviceTier` is folded into
 * the id: Pi composes the body from the spec, and has no tier of its own to
 * carry one. The wire is fixed: the ChatGPT backend speaks Responses.
 */
function chatGptSubscriptionModelSpec(model: IChatGptSubscriptionModel, serviceTier?: string): IPiModelSpec {
	const levels = piThinkingLevels(model.supportedReasoningEfforts);
	const defaultThinkingLevel = resolveDefaultReasoningEffort(levels, model.defaultReasoningEffort);
	return {
		id: chatGptSubscriptionAgentModelId(model.id, serviceTier),
		name: model.name,
		wire: 'responses',
		reasoning: levels.length > 0,
		input: model.supportsVision ? ['text', 'image'] : ['text'],
		contextWindow: model.maxContextWindowTokens,
		maxTokens: chatGptSubscriptionMaxOutputTokens(model),
		...(levels.length ? { thinkingLevels: levels } : {}),
		...(defaultThinkingLevel ? { defaultThinkingLevel: defaultThinkingLevel as PiThinkingLevel } : {}),
	};
}

function piWire(provider: IByokLmProviderConfiguration): 'responses' | 'messages' | 'chat-completions' {
	const models = Array.isArray(provider.configuration.models) ? provider.configuration.models : [];
	const model = models.find(candidate => !!candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === provider.modelId) as { apiType?: unknown; url?: unknown } | undefined;
	const configured = typeof model?.apiType === 'string' ? model.apiType : typeof provider.configuration.apiType === 'string' ? provider.configuration.apiType : undefined;
	const url = typeof model?.url === 'string' ? model.url : typeof provider.configuration.url === 'string' ? provider.configuration.url : '';
	const wire = configured ?? (/\/messages(?:\?|$)/i.test(url) ? 'messages' : /\/responses(?:\?|$)/i.test(url) ? 'responses' : 'chat-completions');
	if (wire !== 'responses' && wire !== 'messages' && wire !== 'chat-completions') {
		throw new Error(`Pi does not support configured model wire '${wire}'.`);
	}
	return wire;
}

function encodePiProviderData(entry: IPiChatEntry): string {
	return JSON.stringify({
		sessionId: AgentSession.id(entry.session),
		...(entry.handle?.sessionFileName ? { sessionFileName: entry.handle.sessionFileName } : {}),
		...(entry.workingDirectories[0] ? { cwd: entry.workingDirectories[0].fsPath } : {}),
		...(entry.model ? { model: entry.model } : {}),
	});
}

function decodePiProviderData(value: string | undefined): { readonly sessionId: string; readonly sessionFileName?: string; readonly cwd?: string; readonly model?: ModelSelection } | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as { sessionId?: unknown; sessionFileName?: unknown; cwd?: unknown; model?: unknown };
		if (typeof parsed.sessionId !== 'string') {
			return undefined;
		}
		return {
			sessionId: parsed.sessionId,
			...(typeof parsed.sessionFileName === 'string' ? { sessionFileName: parsed.sessionFileName } : {}),
			...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
			...(isModelSelection(parsed.model) ? { model: parsed.model } : {}),
		};
	} catch {
		return undefined;
	}
}

function isModelSelection(value: unknown): value is ModelSelection {
	return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

function piPromptInput(prompt: string, attachments: readonly MessageAttachment[] | undefined): { readonly text: string; readonly images: IPiImageContent[] } {
	const text: string[] = [prompt];
	const images: IPiImageContent[] = [];
	for (const attachment of attachments ?? []) {
		if (attachment.type === MessageAttachmentKind.EmbeddedResource && attachment.contentType.startsWith('image/')) {
			images.push({ type: 'image', data: attachment.data, mimeType: attachment.contentType });
		} else if (attachment.type === MessageAttachmentKind.Simple && attachment.modelRepresentation) {
			text.push(attachment.modelRepresentation);
		} else {
			text.push(`[Attached: ${attachment.label}]`);
		}
	}
	return { text: text.filter(Boolean).join('\n\n'), images };
}

function lastPiAssistantText(messages: readonly { readonly role: string; readonly content?: unknown }[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'assistant' || !Array.isArray(message.content)) {
			continue;
		}
		const text = message.content.map(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' ? (part as { text?: unknown }).text : undefined).filter((value): value is string => typeof value === 'string').join('');
		if (text) {
			return text;
		}
	}
	return undefined;
}

function piToolResultText(result: unknown): string {
	if (!result || typeof result !== 'object') {
		return '';
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return '';
	}
	return content.map(item => item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '').filter(Boolean).join('\n');
}

/**
 * Transcribes Pi's four per-call counters into the protocol's usage counters,
 * 1:1. `cacheWrite` used to be destructured away, which cost a first turn its
 * whole prompt in the context gauge: nothing is read from cache yet and
 * everything is written to it. It rides in `_meta` because the generated
 * `UsageInfo` has no cache-creation field; `usageOccupancyTokens` reads it back.
 */
export function piUsage(message: IPiAssistantMessage): UsageInfo | undefined {
	const { input, output, cacheRead, cacheWrite } = message.usage;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
		return undefined;
	}
	return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, _meta: { cacheCreationTokens: cacheWrite } };
}
