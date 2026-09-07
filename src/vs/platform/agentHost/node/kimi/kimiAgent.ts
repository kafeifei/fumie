/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { DeferredPromise, SequencerByKey, raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { getReasoningEffortDescription, getReasoningEffortLabel, resolveDefaultReasoningEffort } from '../../common/reasoningEffort.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent, KIMI_AGENT_PROVIDER_ID, resolveAgentChatContext } from '../../common/agent.js';
import { AutoApproveLevel, createSchema, platformSessionSchema, schemaProperty } from '../../common/agentHostSchema.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ProtectedResourceMetadata, type AgentSelection, type ConfigSchema, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, MessageAttachmentKind, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, buildDefaultChatUri, parseRequiredSessionUriFromChatUri, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import { ensureWorkspacelessScratchDir } from '../workspacelessScratchDir.js';
import { getByokLmAgentModelId } from '../../common/agentHostByokLm.js';
import { createAgentModelByokMeta } from '../../common/agentModelByokMeta.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelSourceMeta } from '../../common/agentModelSource.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_MODELS, IChatGptSubscriptionService, chatGptSubscriptionAgentModelId, chatGptSubscriptionMaxOutputTokens, parseChatGptSubscriptionModelId, type IChatGptSubscriptionModel, type IChatGptSubscriptionServiceTier } from '../chatGptSubscription.js';
import { IKimiApprovalRequest, IKimiCodeSdkService, IKimiEvent, IKimiPromptPart, IKimiQuestionRequest, IKimiSession, IKimiSessionSummary, KimiQuestionResult } from './kimiCodeSdkService.js';
import { replayKimiSessionToTurns } from './kimiReplayMapper.js';
import { buildKimiToolMeta, getKimiApprovalTarget, getKimiApprovalToolInput, getKimiConfirmationTitle, getKimiInvocationMessage, getKimiPastTenseMessage, getKimiToolDisplayName } from './kimiToolDisplay.js';

const LegacyKimiPermissionModeConfigKey = 'permissionMode';
const KimiPlanModeConfigKey = 'planMode';
const KimiThinkingEffortConfigKey = 'thinkingLevel';
const KimiServiceTierConfigKey = 'serviceTier';
const KimiStandardServiceTier = 'standard';

const kimiSessionConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
	[KimiPlanModeConfigKey]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('kimiAgent.planMode', "Plan mode"),
		description: localize('kimiAgent.planMode.description', "Have Kimi plan before making changes."),
		default: false,
		sessionMutable: true,
	}),
});

interface IKimiTurnState {
	readonly id: string;
	readonly startedAt: number;
	/** Open tool calls, so a `tool.result` can still render the call's own card text. */
	readonly toolCalls: Map<string, { readonly name: string; readonly input: unknown }>;
	textPartCreated: boolean;
	reasoningPartCreated: boolean;
	sdkStarted: boolean;
	pendingError?: ReturnType<typeof errorInfo>;
}

interface IKimiSessionEntry {
	readonly session: URI;
	readonly chat: URI;
	workingDirectories: readonly URI[];
	model?: ModelSelection;
	agent?: AgentSelection;
	planMode: boolean;
	sdkSession?: IKimiSession;
	unsubscribe?: () => void;
	turn?: IKimiTurnState;
}

interface IKimiPendingQuestion {
	readonly entry: IKimiSessionEntry;
	readonly request: IKimiQuestionRequest;
}

class KimiActiveClient implements IActiveClient {
	tools: readonly ToolDefinition[] = [];
	customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }
}

/**
 * Agent Host provider backed by the same in-process Kimi harness used by the
 * official Kimi VS Code extension. Fumie owns worktrees and protocol state;
 * the Kimi SDK owns the model loop and its native transcript.
 */
export class KimiAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = KIMI_AGENT_PROVIDER_ID;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	readonly onDidChangeChatData: Event<IAgentChatDataChange> = Event.None;
	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;
	readonly onDidDiscoverChats: IAgent['onDidDiscoverChats'] = Event.None;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, IKimiSessionEntry>();
	private readonly _activeClients = new Map<string, KimiActiveClient>();
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, IKimiSessionEntry>();
	private readonly _pendingQuestions = new PendingRequestRegistry<{ response: ChatInputResponseKind; answers?: Record<string, ChatInputAnswer> }, IKimiPendingQuestion>();
	private readonly _sessionSequencer = new SequencerByKey<string>();
	private _shutdownPromise: Promise<void> | undefined;

	constructor(
		@IKimiCodeSdkService private readonly _sdkService: IKimiCodeSdkService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
		@IChatGptSubscriptionService private readonly _chatGptSubscription: IChatGptSubscriptionService,
	) {
		super();
		// Keep renderer-owned BYOK rows and the host-owned ChatGPT subscription
		// rows synchronized with their respective sources.
		this._register(this._byokBridgeRegistry.onDidChangeModels(() => this._refreshModels()));
		this._register(this._chatGptSubscription.onDidChangeSignedIn(() => this._refreshModels()));
		this._refreshModels();
	}

	/**
	 * Publish the provider-compatible slice of the renderer BYOK catalog plus
	 * the subscription catalog while its credential owner is signed in.
	 * Nothing here renames, re-stamps or dedupes BYOK provider rows.
	 */
	private _refreshModels(): void {
		const byokModels = this._byokBridgeRegistry.getModels()
			.filter(model => !model.supportedHarnesses || model.supportedHarnesses.includes(this.id))
			.map((m): IAgentModelInfo => {
				const byokMeta = createAgentModelByokMeta(m.modelIdentifier, m.hidden);
				const configSchema = createKimiModelConfigSchema(m.supportedReasoningEfforts, m.defaultReasoningEffort, m.id);
				return {
					provider: this.id,
					id: getByokLmAgentModelId(m),
					// The vendor route in the id is ours; the proxy rewrites the
					// request body to the provider's own model id before it goes
					// upstream, so that is the id the runtime reports back.
					underlyingModelId: m.id,
					name: m.name ?? m.id,
					maxContextWindow: m.maxContextWindowTokens,
					supportsVision: m.supportsVision ?? false,
					...(configSchema ? { configSchema } : {}),
					...(byokMeta && { _meta: byokMeta }),
				};
			});
		this._models.set([...byokModels, ...this._chatGptSubscriptionModels()], undefined);
	}

	private _chatGptSubscriptionModels(): IAgentModelInfo[] {
		if (!this._chatGptSubscription.isSignedIn()) {
			return [];
		}
		return CHATGPT_SUBSCRIPTION_MODELS.map((model): IAgentModelInfo => {
			const configSchema = createKimiModelConfigSchema(model.supportedReasoningEfforts, model.defaultReasoningEffort, model.id, model.serviceTiers);
			return {
				provider: this.id,
				id: chatGptSubscriptionAgentModelId(model.id),
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

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this._createChat(chat, context, options),
		deleteChat: (chat, context) => this._deleteChat(chat, context),
		disposeChat: (chat, context) => this._deleteChat(chat, context),
		releaseChat: (chat, context) => this._releaseChat(chat, context),
		sendMessage: (chat, prompt, workingDirectories, attachments, turnId) => this._sendMessage(chat, prompt, normalizeWorkingDirectories(workingDirectories), attachments, turnId),
		abort: chat => this._abort(chat),
		changeModel: (chat, model) => this._changeModel(chat, model),
		changeAgent: (chat, agent) => this._changeAgent(chat, agent),
		getMessages: (chat, context) => this._getChatMessages(chat, context),
	};

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options: IAgentCreateChatOptions = {}): Promise<IAgentCreateChatResult> {
		if (options.fork || options.sideChat) {
			throw new Error('Kimi session forking is not yet exposed through Fumie');
		}
		if (options.agent) {
			throw new Error('Kimi custom agent profiles are not yet exposed through Fumie');
		}
		const session = resolveAgentChatContext(context, chat).configurationResource;
		const sessionId = AgentSession.id(session);
		const existing = this._sessions.get(sessionId);
		if (existing) {
			if (existing.chat.toString() !== chat.toString()) {
				throw new Error('Kimi does not yet support additional Fumie chats');
			}
			return {
				resolvedWorkingDirectory: existing.workingDirectories[0],
				provisional: existing.sdkSession === undefined,
				providerData: encodeKimiChatData(sessionId),
			};
		}

		const primary = options.workingDirectories?.[0]
			?? await ensureWorkspacelessScratchDir(this._environmentService.userHome, sessionId);
		const workingDirectories = [primary, ...(options.workingDirectories?.slice(1) ?? [])];
		this._sessions.set(sessionId, {
			session,
			chat,
			workingDirectories,
			model: options.model,
			agent: options.agent,
			planMode: options.config?.[KimiPlanModeConfigKey] === true,
		});

		return { resolvedWorkingDirectory: primary, provisional: true, providerData: encodeKimiChatData(sessionId) };
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		const config = migrateKimiPermissionConfig(params.config);
		return Promise.resolve({
			schema: kimiSessionConfigSchema.toProtocol(),
			values: kimiSessionConfigSchema.validateOrDefault(config, {
				[SessionConfigKey.AutoApprove]: 'default' satisfies AutoApproveLevel,
				[KimiPlanModeConfigKey]: false,
			}),
		});
	}

	getInheritedChatConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		const inherited: Record<string, unknown> = {};
		for (const key of [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions, KimiPlanModeConfigKey]) {
			if (config[key] !== undefined) {
				inherited[key] = config[key];
			}
		}
		return Object.keys(inherited).length > 0 ? inherited : undefined;
	}

	chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	private getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const id = AgentSession.id(session);
		return this._sessionSequencer.queue(id, () => this._getSessionMessagesQueued(id));
	}

	private async _getSessionMessagesQueued(id: string): Promise<readonly Turn[]> {
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return [];
		}
		const existing = this._sessions.get(id)?.sdkSession;
		if (existing) {
			return replayKimiSessionToTurns(existing.getResumeState(), id);
		}
		const harness = await this._sdkService.getHarness();
		const summary = (await harness.listSessions({ sessionId: id }))[0];
		if (!summary) {
			return [];
		}
		const resumed = await harness.resumeSession({ id, includeSubagents: false });
		try {
			return replayKimiSessionToTurns(resumed.getResumeState(), id);
		} finally {
			await resumed.close();
		}
	}

	private async _deleteChat(chat: URI, context?: URI | IAgentChatContext): Promise<void> {
		const session = resolveKimiSession(chat, context);
		const id = AgentSession.id(session);
		await this._sessionSequencer.queue(id, async () => {
			await this._releaseEntry(id);
			this._sessions.delete(id);
			const harness = await this._sdkService.getHarness();
			await harness.deleteSession(id);
		});
	}

	private async _releaseChat(chat: URI, context?: URI | IAgentChatContext): Promise<void> {
		const session = resolveKimiSession(chat, context);
		const id = AgentSession.id(session);
		await this._sessionSequencer.queue(id, () => this._releaseEntry(id));
	}

	private _getChatMessages(chat: URI, context?: URI | IAgentChatContext): Promise<readonly Turn[]> {
		return this.getSessionMessages(resolveKimiSession(chat, context));
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(requestId: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		this._pendingQuestions.respond(requestId, { response, answers });
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('kimiAgent.displayName', "Kimi"),
			description: localize('kimiAgent.description', "Kimi Code agent using Moonshot AI's official Node SDK"),
			capabilities: { modelCatalog: 'projected' },
		};
	}

	async listChatsToMigrate(): Promise<IAgentChatMetadata[] | undefined> {
		try {
			if (!(await this._sdkService.canLoadWithoutDownload())) {
				return undefined;
			}
			const harness = await this._sdkService.getHarness();
			const summaries = await harness.listSessions();
			return summaries.filter(summary => !summary.archived).map(summary => this._toChatMetadata(summary));
		} catch (error) {
			this._logService.warn('[Kimi] listChatsToMigrate failed; deferring migration', error);
			return undefined;
		}
	}

	async getChatMetadata(chat: URI, context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return undefined;
		}
		const configurationResource = resolveAgentChatContext(context, chat).configurationResource;
		const id = decodeKimiChatData(providerData) ?? AgentSession.id(configurationResource);
		const harness = await this._sdkService.getHarness();
		// Ask for this one session, never the whole store: a listing that walks
		// every stored session fails as a whole on the first entry it dislikes,
		// which would make one damaged session undescribable for all of them.
		const summary = (await harness.listSessions({ sessionId: id }))[0];
		return summary ? this._toChatMetadata(summary, chat) : undefined;
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const configurationResource = resolveAgentChatContext(context, chat).configurationResource;
		const id = decodeKimiChatData(providerData) ?? AgentSession.id(configurationResource);
		if (this._sessions.has(id)) {
			return { providerData: encodeKimiChatData(id) };
		}
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return;
		}
		const harness = await this._sdkService.getHarness();
		const summary = (await harness.listSessions({ sessionId: id }))[0];
		if (!summary) {
			return;
		}
		const workingDirectories = [URI.file(summary.workDir), ...(summary.additionalDirs ?? []).map(directory => URI.file(directory))];
		this._sessions.set(id, {
			session: configurationResource,
			chat,
			workingDirectories,
			planMode: false,
		});
		return { providerData: encodeKimiChatData(id), resolvedWorkingDirectory: workingDirectories[0] };
	}

	onSessionConfigChanged(session: URI, values: Record<string, unknown>): void {
		const entry = this._sessions.get(AgentSession.id(session));
		if (!entry) {
			return;
		}
		entry.planMode = values[KimiPlanModeConfigKey] === true;
		if (entry.sdkSession) {
			void entry.sdkSession.setPlanMode(entry.planMode).catch(error => this._logService.warn('[Kimi] Failed to update plan mode', error));
		}
	}

	getChatCustomizations(): Promise<readonly []> {
		return Promise.resolve([]);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// Kimi runs entirely on renderer BYOK models through the loopback proxy;
		// Fumie never starts or brokers a Kimi OAuth flow.
		return [];
	}

	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${chat.toString()}\u0000${client.clientId}`;
		let handle = this._activeClients.get(key);
		if (!handle) {
			handle = new KimiActiveClient(client.clientId, client.displayName);
			this._activeClients.set(key, handle);
		}
		return handle;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}\u0000${clientId}`);
	}

	onClientToolCallComplete(_chat: URI, _toolCallId: string): void {
		// Client-contributed tools are not yet injected into the Kimi harness.
	}

	shutdown(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._pendingPermissions.denyAll(false);
			this._pendingQuestions.denyAll({ response: ChatInputResponseKind.Cancel });
			for (const id of [...this._sessions.keys()]) {
				await this._sessionSequencer.queue(id, async () => {
					await this._releaseEntry(id);
					this._sessions.delete(id);
				});
			}
			await this._sdkService.close();
		})();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(URI.parse(parseRequiredSessionUriFromChatUri(chat)));
		return this._sessionSequencer.queue(sessionId, () => this._sendMessageQueued(chat, prompt, workingDirectories, attachments, turnId));
	}

	private async _sendMessageQueued(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(URI.parse(parseRequiredSessionUriFromChatUri(chat)));
		let entry = this._sessions.get(sessionId);
		if (!entry) {
			const session = AgentSession.uri(this.id, sessionId);
			entry = {
				session,
				chat: URI.parse(buildDefaultChatUri(session)),
				workingDirectories: workingDirectories ?? [],
				planMode: false,
			};
			this._sessions.set(sessionId, entry);
		}
		if (workingDirectories && workingDirectories.length > 0) {
			entry.workingDirectories = workingDirectories;
		}
		if (entry.turn) {
			throw new Error('A response is already being generated for this Kimi session.');
		}
		const sdkSession = await this._materialize(entry);
		const effectiveTurnId = turnId ?? generateUuid();
		entry.turn = { id: effectiveTurnId, startedAt: Date.now(), toolCalls: new Map(), textPartCreated: false, reasoningPartCreated: false, sdkStarted: false };
		this._fire(entry.chat, {
			type: ActionType.ChatTurnStarted,
			turnId: effectiveTurnId,
			startedAt: new Date(entry.turn.startedAt).toISOString(),
			message: { text: prompt, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments: [...attachments] } : {}), ...(entry.model ? { model: entry.model } : {}), ...(entry.agent ? { agent: entry.agent } : {}) },
		});
		try {
			await sdkSession.prompt(kimiPromptInput(prompt, attachments));
		} catch (error) {
			if (entry.turn?.id === effectiveTurnId) {
				this._finishWithError(entry, error);
			}
			throw error;
		}
	}

	private async _materialize(entry: IKimiSessionEntry): Promise<IKimiSession> {
		if (entry.sdkSession) {
			return entry.sdkSession;
		}
		const harness = await this._sdkService.getHarness();
		const id = AgentSession.id(entry.session);
		let sdkSession: IKimiSession;
		const persisted = (await harness.listSessions()).some(summary => summary.id === id);
		if (persisted) {
			sdkSession = await harness.resumeSession({
				id,
				additionalDirs: entry.workingDirectories.slice(1).map(directory => directory.fsPath),
				includeSubagents: true,
				model: kimiRuntimeModelId(entry.model),
			});
			if (entry.workingDirectories.length === 0) {
				entry.workingDirectories = [URI.file(sdkSession.workDir)];
			}
			if (entry.model) {
				await sdkSession.setModel(kimiRuntimeModelId(entry.model)!);
				const thinking = modelThinkingEffort(entry.model);
				if (thinking) {
					await sdkSession.setThinking(thinking);
				}
			}
			// Fumie owns the approval decision. Keep Kimi in manual mode so every
			// tool request reaches the host's autoApprove/permissions engine.
			await sdkSession.setPermission('manual');
			await sdkSession.setPlanMode(entry.planMode);
		} else {
			const primary = entry.workingDirectories[0]
				?? await ensureWorkspacelessScratchDir(this._environmentService.userHome, id);
			entry.workingDirectories = [primary, ...entry.workingDirectories.slice(1)];
			sdkSession = await harness.createSession({
				id,
				workDir: primary.fsPath,
				model: kimiRuntimeModelId(entry.model),
				thinking: modelThinkingEffort(entry.model),
				permission: 'manual',
				planMode: entry.planMode,
				additionalDirs: entry.workingDirectories.slice(1).map(directory => directory.fsPath),
			});
		}
		entry.sdkSession = sdkSession;
		entry.unsubscribe = sdkSession.onEvent(event => this._handleEvent(entry, event));
		sdkSession.setApprovalHandler(request => this._requestApproval(entry, request));
		sdkSession.setQuestionHandler(request => this._requestQuestion(entry, request));
		this._onDidMaterializeChat.fire({ chat: entry.chat, result: { providerData: encodeKimiChatData(id) }, workingDirectories: entry.workingDirectories, project: undefined });
		return sdkSession;
	}

	/**
	 * Generate a short title for a session from the user's first prompt, using
	 * the session's own backend/model. Never touches the user's session
	 * transcript or turns, and never writes Kimi's own session metadata:
	 * the naming turn runs in a hidden throwaway session that is deleted again.
	 */
	async generateTitle(session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken): Promise<string | undefined> {
		try {
			return await this._generateTitleInThrowawaySession(session, request, token);
		} catch (error) {
			this._logService.warn('[Kimi] Failed to generate a session title', error);
			return undefined;
		}
	}

	/**
	 * Kimi has no title-only endpoint, so naming a session runs one hidden
	 * throwaway session on the same harness and the same model as the real
	 * session, and deletes it again on every exit path. The real session's SDK
	 * handle, transcript, and turn state are never involved.
	 */
	private async _generateTitleInThrowawaySession(session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}
		const entry = this._sessions.get(AgentSession.id(session));
		const selection = entry?.model?.id === request.modelId || request.modelId === undefined ? entry?.model : { id: request.modelId };
		const modelId = kimiRuntimeModelId(selection);
		const harness = await this._sdkService.getHarness();
		// Passing no id makes the harness mint its own, so this can never adopt
		// or disturb the session Fumie is naming.
		const throwaway = await harness.createSession({
			workDir: entry?.workingDirectories[0]?.fsPath ?? os.tmpdir(),
			model: modelId,
			permission: 'manual',
			planMode: false,
		});
		let reply = '';
		let turnStarted = false;
		const turnEnded = new DeferredPromise<void>();
		const unsubscribe = throwaway.onEvent(event => {
			if (event.agentId !== undefined && event.agentId !== 'main') {
				return;
			}
			switch (event.type) {
				case 'turn.started':
					turnStarted = true;
					break;
				case 'assistant.delta':
					reply += stringValue(event.delta);
					break;
				case 'turn.ended':
					turnEnded.complete();
					break;
				case 'error':
					// Kimi reports recoverable errors while a turn runs, but an error
					// before `turn.started` means no `turn.ended` will ever follow.
					if (!turnStarted) {
						this._logService.warn(`[Kimi:${throwaway.id}] the naming turn failed before it started`, errorInfo(event));
						turnEnded.complete();
					}
					break;
			}
		});
		// 'manual' routes tool calls through the approval handler, and naming a
		// session must neither run tools nor ask the user anything.
		throwaway.setApprovalHandler(() => Promise.resolve({ decision: 'rejected', feedback: 'Tool calls are not available while naming a session.' }));
		throwaway.setQuestionHandler(() => Promise.resolve(null));
		const cancellation = token.onCancellationRequested(() => void throwaway.cancel().catch(() => undefined));
		try {
			// Kimi's `prompt()` resolves once the SDK has *launched* the turn, not
			// when it ends, so the reply is only complete on `turn.ended` — exactly
			// how the real send path tracks a turn.
			await raceCancellation(throwaway.prompt(kimiTitlePrompt(request.prompt)), token);
			await raceCancellation(turnEnded.p, token);
			if (token.isCancellationRequested) {
				this._logService.info(`[Kimi:${throwaway.id}] session title reply: cancelled`);
				return undefined;
			}
			this._logService.info(`[Kimi:${throwaway.id}] session title reply: ${reply.trim().length} character(s)`);
			// The raw model reply; sanitizing and shortening titles belongs to the caller.
			return reply.trim() || undefined;
		} finally {
			cancellation.dispose();
			unsubscribe();
			throwaway.setApprovalHandler(undefined);
			throwaway.setQuestionHandler(undefined);
			try {
				await throwaway.close();
			} finally {
				await harness.deleteSession(throwaway.id);
			}
		}
	}

	private _handleEvent(entry: IKimiSessionEntry, event: IKimiEvent): void {
		// Subagent streams need their own AHP chat membership and routing. Until
		// that mapping is installed, do not corrupt the main chat transcript.
		if (event.agentId !== undefined && event.agentId !== 'main') {
			return;
		}
		const turn = entry.turn;
		if (!turn) {
			return;
		}
		switch (event.type) {
			case 'turn.started':
				turn.sdkStarted = true;
				break;
			case 'assistant.delta': {
				const delta = stringValue(event.delta);
				if (!turn.textPartCreated) {
					turn.textPartCreated = true;
					this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Markdown, id: `${turn.id}:text`, content: '' } });
				}
				this._fire(entry.chat, { type: ActionType.ChatDelta, turnId: turn.id, partId: `${turn.id}:text`, content: delta });
				break;
			}
			case 'thinking.delta': {
				const delta = stringValue(event.delta);
				if (!turn.reasoningPartCreated) {
					turn.reasoningPartCreated = true;
					this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Reasoning, id: `${turn.id}:reasoning`, content: '' } });
				}
				this._fire(entry.chat, { type: ActionType.ChatReasoning, turnId: turn.id, partId: `${turn.id}:reasoning`, content: delta });
				break;
			}
			case 'tool.call.started': {
				const toolCallId = stringValue(event.toolCallId);
				const toolName = stringValue(event.name) || 'tool';
				const toolInput = jsonValue(event.args);
				const displayName = getKimiToolDisplayName(toolName);
				const meta = buildKimiToolMeta(toolName, event.args);
				turn.toolCalls.set(toolCallId, { name: toolName, input: event.args });
				this._fire(entry.chat, {
					type: ActionType.ChatToolCallStart,
					turnId: turn.id,
					toolCallId,
					toolName,
					displayName,
					intention: optionalString(event.description),
					...(meta ? { _meta: meta } : {}),
				});
				if (toolInput) {
					this._fire(entry.chat, { type: ActionType.ChatToolCallDelta, turnId: turn.id, toolCallId, content: toolInput });
				}
				this._fire(entry.chat, {
					type: ActionType.ChatToolCallReady,
					turnId: turn.id,
					toolCallId,
					invocationMessage: getKimiInvocationMessage(toolName, displayName, event.args),
					toolInput,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
				break;
			}
			case 'tool.call.delta': {
				const content = optionalString(event.argumentsPart);
				if (content) {
					this._fire(entry.chat, { type: ActionType.ChatToolCallDelta, turnId: turn.id, toolCallId: stringValue(event.toolCallId), content });
				}
				break;
			}
			case 'tool.result': {
				const isError = event.isError === true;
				const output = outputText(event.output);
				const toolCallId = stringValue(event.toolCallId);
				const tracked = turn.toolCalls.get(toolCallId);
				const toolName = tracked?.name ?? 'tool';
				turn.toolCalls.delete(toolCallId);
				this._fire(entry.chat, {
					type: ActionType.ChatToolCallComplete,
					turnId: turn.id,
					toolCallId,
					result: {
						success: !isError,
						pastTenseMessage: getKimiPastTenseMessage(toolName, getKimiToolDisplayName(toolName), tracked?.input, !isError),
						...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
						...(isError ? { error: { message: output || 'Kimi tool failed' } } : {}),
					},
				});
				break;
			}
			case 'turn.ended': {
				const duration = numberValue(event.durationMs) ?? Date.now() - turn.startedAt;
				if (event.reason === 'cancelled') {
					this._fire(entry.chat, { type: ActionType.ChatTurnCancelled, turnId: turn.id, duration });
				} else if (event.reason !== 'completed') {
					const fallback = { code: `turn.${stringValue(event.reason)}`, message: `Turn ended with reason: ${stringValue(event.reason)}` };
					this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration, error: turn.pendingError ?? errorInfo(event.error ?? fallback) });
					this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
				} else {
					this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
				}
				entry.turn = undefined;
				break;
			}
			case 'agent.status.updated': {
				const usage = kimiUsage(event.usage);
				if (usage) {
					// The SDK reports the env alias, never the real model; report the
					// selection the picker shows instead.
					const reported = optionalString(event.model);
					const model = reported;
					this._fire(entry.chat, { type: ActionType.ChatUsage, turnId: turn.id, usage: { ...usage, ...(model ? { model } : {}) } });
				}
				break;
			}
			case 'error': {
				const error = errorInfo(event);
				if (turn.sdkStarted) {
					// The SDK can report recoverable errors while a turn continues. AHP's
					// ChatError is terminal, so retain the detail for a later failed/blocked
					// turn end and otherwise leave the live turn intact.
					turn.pendingError = error;
					this._logService.warn('[Kimi] Non-terminal SDK error during an active turn', error);
				} else {
					this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration: Date.now() - turn.startedAt, error });
					entry.turn = undefined;
				}
				break;
			}
		}
	}

	private _requestApproval(entry: IKimiSessionEntry, request: IKimiApprovalRequest): Promise<{ decision: 'approved' | 'rejected'; feedback?: string }> {
		if (request.agentId !== undefined && request.agentId !== 'main') {
			return Promise.resolve({ decision: 'rejected', feedback: 'Fumie cannot route Kimi subagent approvals yet.' });
		}
		const requestId = request.toolCallId;
		const displayName = getKimiToolDisplayName(request.toolName);
		// Kimi gates a tool call *before* it publishes `tool.call.started`, so the
		// approval request's own `ToolInputDisplay` is the only input the host's
		// auto-approve rules can read. It already carries the resolved absolute
		// path and the shell dialect.
		return this._pendingPermissions.registerAndFire(requestId, () => {
			this._onDidChatProgress.fire({
				kind: 'pending_confirmation',
				chat: entry.chat,
				...getKimiApprovalTarget(request.toolName, request.display),
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					displayName,
					invocationMessage: optionalString(request.action) ?? getKimiInvocationMessage(request.toolName, displayName, request.display),
					// The host's terminal rules parse the command line off `toolInput`.
					toolInput: getKimiApprovalToolInput(request.toolName, request.display),
					confirmationTitle: optionalString(request.action) ?? getKimiConfirmationTitle(request.toolName),
				},
			});
		}, entry).then(approved => approved ? { decision: 'approved' } : { decision: 'rejected', feedback: 'User declined this tool call.' });
	}

	private _requestQuestion(entry: IKimiSessionEntry, request: IKimiQuestionRequest): Promise<KimiQuestionResult> {
		if (request.agentId !== undefined && request.agentId !== 'main') {
			return Promise.resolve(null);
		}
		const requestId = request.toolCallId ?? generateUuid();
		return this._pendingQuestions.registerAndFire(requestId, () => {
			this._fire(entry.chat, {
				type: ActionType.ChatInputRequested,
				request: {
					id: requestId,
					message: request.questions[0]?.header,
					questions: request.questions.map((question, index) => ({
						id: `q${index}`,
						kind: question.multiSelect ? ChatInputQuestionKind.MultiSelect : ChatInputQuestionKind.SingleSelect,
						title: question.header,
						message: question.body ?? question.question,
						required: true,
						options: question.options.map(option => ({ id: option.label, label: option.label, description: option.description })),
						allowFreeformInput: question.otherLabel !== undefined,
					})),
				},
			});
		}, { entry, request }).then(result => this._toKimiQuestionResult(request, result));
	}

	private _toKimiQuestionResult(request: IKimiQuestionRequest, result: { response: ChatInputResponseKind; answers?: Record<string, ChatInputAnswer> }): KimiQuestionResult {
		if (result.response !== ChatInputResponseKind.Accept) {
			return null;
		}
		const answers: Record<string, string | true> = {};
		request.questions.forEach((question, index) => {
			const answer = result.answers?.[`q${index}`];
			if (!answer || answer.state === ChatInputAnswerState.Skipped) {
				answers[question.question] = true;
				return;
			}
			switch (answer.value.kind) {
				case ChatInputAnswerValueKind.Selected:
					answers[question.question] = answer.value.freeformValues?.[0] ?? answer.value.value;
					break;
				case ChatInputAnswerValueKind.SelectedMany:
					answers[question.question] = [...answer.value.value, ...(answer.value.freeformValues ?? [])].join(', ');
					break;
				case ChatInputAnswerValueKind.Text:
					answers[question.question] = answer.value.value;
					break;
				default:
					answers[question.question] = String(answer.value.value);
			}
		});
		return { answers, method: 'enter' };
	}

	private async _abort(chat: URI): Promise<void> {
		const entry = this._entryForChat(chat);
		await entry.sdkSession?.cancel();
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const entry = this._entryForChat(chat);
		entry.model = model;
		await entry.sdkSession?.setModel(kimiRuntimeModelId(model)!);
		const thinking = modelThinkingEffort(model);
		if (thinking) {
			await entry.sdkSession?.setThinking(thinking);
		}
	}

	private async _changeAgent(chat: URI, agent: AgentSelection | undefined): Promise<void> {
		const entry = this._entryForChat(chat);
		if (entry.sdkSession) {
			throw new Error('Kimi cannot change agent profile after session creation');
		}
		if (agent) {
			throw new Error('Kimi custom agent profiles are not yet exposed through Fumie');
		}
		entry.agent = undefined;
	}

	private _entryForChat(chat: URI): IKimiSessionEntry {
		const id = AgentSession.id(URI.parse(parseRequiredSessionUriFromChatUri(chat)));
		const entry = this._sessions.get(id);
		if (!entry) {
			throw new Error(`Unknown Kimi session: ${id}`);
		}
		return entry;
	}

	private async _releaseEntry(id: string): Promise<void> {
		const entry = this._sessions.get(id);
		if (!entry) {
			return;
		}
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		this._pendingQuestions.respondWhere(candidate => candidate.entry === entry, { response: ChatInputResponseKind.Cancel });
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
		const sdkSession = entry.sdkSession;
		entry.sdkSession = undefined;
		entry.turn = undefined;
		sdkSession?.setApprovalHandler(undefined);
		sdkSession?.setQuestionHandler(undefined);
		await sdkSession?.close();
	}

	private _toChatMetadata(summary: IKimiSessionSummary, chat = URI.parse(buildDefaultChatUri(AgentSession.uri(this.id, summary.id)))): IAgentChatMetadata {
		return {
			chat,
			startTime: summary.createdAt,
			modifiedTime: summary.updatedAt,
			summary: summary.title ?? summary.lastPrompt,
			workingDirectories: [URI.file(summary.workDir), ...(summary.additionalDirs ?? []).map(directory => URI.file(directory))],
		};
	}

	private _finishWithError(entry: IKimiSessionEntry, error: unknown): void {
		const turn = entry.turn;
		if (!turn) {
			return;
		}
		const duration = Date.now() - turn.startedAt;
		this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration, error: errorInfo(error) });
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

function resolveKimiSession(chat: URI, context?: URI | IAgentChatContext): URI {
	return context
		? resolveAgentChatContext(context, chat).configurationResource
		: URI.parse(parseRequiredSessionUriFromChatUri(chat));
}

function encodeKimiChatData(sessionId: string): string {
	return JSON.stringify({ sessionId });
}

function decodeKimiChatData(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as { sessionId?: unknown };
		return typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
	} catch {
		return undefined;
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : String(value ?? '');
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jsonValue(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	try {
		return typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function outputText(output: unknown): string {
	if (typeof output === 'string') {
		return output;
	}
	return jsonValue(output) ?? '';
}

function errorInfo(error: unknown): { errorType: string; message: string; stack?: string } {
	if (error instanceof Error) {
		return { errorType: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
	}
	if (typeof error === 'object' && error !== null) {
		const candidate = error as { code?: unknown; message?: unknown; stack?: unknown };
		return {
			errorType: optionalString(candidate.code) ?? 'KimiError',
			message: optionalString(candidate.message) ?? outputText(error),
			...(optionalString(candidate.stack) ? { stack: optionalString(candidate.stack) } : {}),
		};
	}
	return { errorType: 'KimiError', message: stringValue(error) };
}

function migrateKimiPermissionConfig(config: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	const migrated = { ...config };
	if (migrated[SessionConfigKey.AutoApprove] === undefined) {
		const legacy = migrated[LegacyKimiPermissionModeConfigKey];
		if (legacy === 'yolo') {
			migrated[SessionConfigKey.AutoApprove] = 'autoApprove';
		} else if (legacy === 'auto') {
			migrated[SessionConfigKey.AutoApprove] = 'assisted';
		} else if (legacy === 'manual') {
			migrated[SessionConfigKey.AutoApprove] = 'default';
		}
	}
	delete migrated[LegacyKimiPermissionModeConfigKey];
	return migrated;
}

function modelThinkingEffort(model: ModelSelection | undefined): string | undefined {
	return optionalString(model?.config?.[KimiThinkingEffortConfigKey]);
}

function createKimiModelConfigSchema(supportedEfforts: readonly string[] | undefined, declaredDefault: string | undefined, modelId: string, serviceTiers?: readonly IChatGptSubscriptionServiceTier[]): ConfigSchema | undefined {
	const properties: ConfigSchema['properties'] = {};
	if (supportedEfforts?.length) {
		properties[KimiThinkingEffortConfigKey] = {
			type: 'string',
			title: localize('kimi.modelThinkingLevel.title', "Thinking Level"),
			description: localize('kimi.modelThinkingLevel.description', "Controls how much reasoning effort Kimi uses."),
			default: resolveDefaultReasoningEffort(supportedEfforts, declaredDefault, modelId),
			enum: [...supportedEfforts],
			enumLabels: supportedEfforts.map(getReasoningEffortLabel),
			enumDescriptions: supportedEfforts.map(effort => getReasoningEffortDescription(effort) ?? ''),
		};
	}
	const additionalTiers = (serviceTiers ?? []).filter(tier => tier.id !== KimiStandardServiceTier);
	if (additionalTiers.length > 0) {
		properties[KimiServiceTierConfigKey] = {
			type: 'string',
			title: localize('kimi.modelServiceTier.title', "Speed"),
			description: localize('kimi.modelServiceTier.description', "Controls Kimi response speed and usage."),
			default: KimiStandardServiceTier,
			enum: [KimiStandardServiceTier, ...additionalTiers.map(tier => tier.id)],
			enumLabels: [localize('kimi.modelServiceTier.standard', "Standard"), ...additionalTiers.map(tier => tier.name)],
			enumDescriptions: [localize('kimi.modelServiceTier.standardDescription', "Standard speed and usage."), ...additionalTiers.map(tier => tier.description)],
		};
	}
	return Object.keys(properties).length > 0 ? { type: 'object', properties } : undefined;
}

function kimiRuntimeModelId(selection: ModelSelection | undefined): string | undefined {
	if (!selection) {
		return undefined;
	}
	const subscription = parseChatGptSubscriptionModelId(selection.id);
	if (!subscription) {
		return selection.id;
	}
	const model = CHATGPT_SUBSCRIPTION_MODELS.find(candidate => candidate.id === subscription.modelId);
	return model ? chatGptSubscriptionAgentModelId(model.id, kimiServiceTier(selection, model)) : selection.id;
}

function kimiServiceTier(selection: ModelSelection, model: IChatGptSubscriptionModel): string | undefined {
	const selected = selection.config?.[KimiServiceTierConfigKey];
	return typeof selected === 'string' && model.serviceTiers?.some(tier => tier.id === selected) ? selected : undefined;
}

/**
 * The naming turn's only instruction. The naming context arrives already
 * budgeted by `SessionTitleService`, the single owner of that budget, so it is
 * passed through as-is. The Kimi SDK has no way to create a tool-less session
 * (`createSession` takes no tool denylist, and the `prompt` payload's
 * `disabledTools` is unread by this engine), so the naming turn is told not to
 * use tools; the approval handler rejects any it attempts anyway.
 */
function kimiTitlePrompt(prompt: string): string {
	return `Reply with only a concise 3-8 word title for this coding session, no quotes, no punctuation at the end, and do not use any tools: ${prompt}`;
}

/**
 * Transcribes the Kimi SDK's turn counters into the protocol's usage counters,
 * 1:1. Kimi splits its prompt side exactly the way the protocol does —
 * `inputOther` is the uncached remainder, disjoint from the two cache counters —
 * so each lands in the counter that means the same thing and nothing is summed
 * here; the client derives occupancy centrally. Cache creation rides in `_meta`
 * because the generated `UsageInfo` has no field for it.
 */
export function kimiUsage(value: unknown): UsageInfo | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const currentTurn = (value as { currentTurn?: unknown }).currentTurn;
	if (typeof currentTurn !== 'object' || currentTurn === null) {
		return undefined;
	}
	const usage = currentTurn as Record<string, unknown>;
	const inputOther = numberValue(usage.inputOther);
	const inputCacheCreation = numberValue(usage.inputCacheCreation);
	const output = numberValue(usage.output);
	const inputCacheRead = numberValue(usage.inputCacheRead);
	return {
		...(inputOther !== undefined ? { inputTokens: inputOther } : {}),
		...(output !== undefined ? { outputTokens: output } : {}),
		...(inputCacheRead !== undefined ? { cacheReadTokens: inputCacheRead } : {}),
		...(inputCacheCreation !== undefined ? { _meta: { cacheCreationTokens: inputCacheCreation } } : {}),
	};
}

function kimiPromptInput(prompt: string, attachments: readonly MessageAttachment[] | undefined): string | readonly IKimiPromptPart[] {
	if (!attachments?.length) {
		return prompt;
	}
	const parts: IKimiPromptPart[] = [{ type: 'text', text: prompt }];
	const references: string[] = [];
	for (const attachment of attachments) {
		switch (attachment.type) {
			case MessageAttachmentKind.Simple:
				if (attachment.modelRepresentation) {
					parts.push({ type: 'text', text: attachment.modelRepresentation });
				}
				break;
			case MessageAttachmentKind.EmbeddedResource:
				if (attachment.contentType.startsWith('image/')) {
					parts.push({ type: 'image_url', imageUrl: { url: `data:${attachment.contentType};base64,${attachment.data}`, id: attachment.label } });
				}
				break;
			case MessageAttachmentKind.Resource: {
				const resource = URI.parse(attachment.uri);
				const location = resource.scheme === 'file' ? resource.fsPath : resource.toString();
				const line = attachment.selection ? `:${attachment.selection.range.start.line + 1}` : '';
				references.push(`- ${location}${line}`);
				break;
			}
		}
	}
	if (references.length > 0) {
		parts.push({
			type: 'text',
			text: `<system-reminder>\nThe user provided these resource references:\n${references.join('\n')}\n</system-reminder>`,
		});
	}
	return parts;
}
