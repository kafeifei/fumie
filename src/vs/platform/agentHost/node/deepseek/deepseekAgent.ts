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
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent, DEEPSEEK_AGENT_PROVIDER_ID, resolveAgentChatContext } from '../../common/agent.js';
import { AutoApproveLevel, createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { AHP_SESSION_NOT_FOUND, ProtocolError } from '../../common/state/sessionProtocol.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ProtectedResourceMetadata, type AgentSelection, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ChatInputResponseKind, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, buildDefaultChatUri, parseRequiredSessionUriFromChatUri, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type ToolResultTodoItem, type Turn } from '../../common/state/sessionState.js';
import { ensureWorkspacelessScratchDir } from '../workspacelessScratchDir.js';
import { getByokLmAgentModelId } from '../../common/agentHostByokLm.js';
import { createAgentModelByokMeta, readAgentModelByokHidden } from '../../common/agentModelByokMeta.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { IChatGptSubscriptionService } from '../chatGptSubscription.js';
import { deepSeekSubscriptionAgentOptions, deepSeekSubscriptionModels } from './deepseekSubscription.js';
import { DeepSeekProviderRoute, IDeepSeekEvent, IDeepSeekHarness, IDeepSeekSdkService, IDeepSeekSession, IDeepSeekSessionHeader, IDeepSeekAgent as IDeepSeekRuntimeAgent } from './deepseekSdkService.js';
import { readDeepSeekStoredSession } from './deepseekSessionLog.js';
import { replayDeepSeekSessionToTurns } from './deepseekReplayMapper.js';
import { buildDeepSeekToolMeta, getDeepSeekApprovalTarget, getDeepSeekConfirmationTitle, getDeepSeekInvocationMessage, getDeepSeekPastTenseMessage, getDeepSeekToolDisplayName, getDeepSeekToolInputString, mapDeepSeekTodos } from './deepseekToolDisplay.js';

const LegacyDeepSeekPermissionModeConfigKey = 'permissionMode';

const deepSeekSessionConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
});

interface IDeepSeekTurnState {
	readonly id: string;
	readonly startedAt: number;
	reasoningPartIndex: number;
	textPartIndex: number;
	/** toolCallId → tool name + parsed input, retained for rich past-tense messages. */
	toolCalls: Map<string, { name: string; input: Record<string, unknown> | undefined }>;
	/** Latest `todo/write` snapshot, attached to the next `todo_write` tool result. */
	latestTodos?: ToolResultTodoItem[];
	/** Live stream block index → part id + kind, for routing `reasoning-delta`/`text-delta` chunks. */
	streamingBlocks: Map<number, { partId: string; reasoning: boolean }>;
	/** Number of reasoning/text blocks opened this step via `block-start`; reset on each `assistant/message`. */
	streamedBlocksThisStep: number;
	pendingError?: ReturnType<typeof errorInfo>;
}

interface IDeepSeekSessionEntry {
	readonly session: URI;
	readonly chat: URI;
	workingDirectories: readonly URI[];
	model?: ModelSelection;
	agent?: AgentSelection;
	agentHandle?: { readonly agent: IDeepSeekRuntimeAgent; dispose(): Promise<void> };
	turn?: IDeepSeekTurnState;
}

class DeepSeekActiveClient implements IActiveClient {
	tools: readonly ToolDefinition[] = [];
	customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }
}

/**
 * Agent Host provider backed by the in-process DeepSeek Harness. Fumie owns
 * worktrees and protocol state; the harness owns the model loop and its native
 * transcript. DeepSeek's native subagent / workflow / goal / ralph / fork
 * lineage is intentionally not surfaced: this provider drives a single main
 * agent per chat, filters non-main session events, and rejects chat forking.
 */
export class DeepSeekAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = DEEPSEEK_AGENT_PROVIDER_ID;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	readonly onDidChangeChatData: Event<IAgentChatDataChange> = Event.None;
	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;
	readonly onDidDiscoverChats: IAgent['onDidDiscoverChats'] = Event.None;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = new Map<string, IDeepSeekSessionEntry>();
	private readonly _activeClients = new Map<string, DeepSeekActiveClient>();
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, IDeepSeekSessionEntry>();
	private readonly _sessionSequencer = new SequencerByKey<string>();
	/**
	 * Ids of the hidden naming agents from {@link generateTitle}. They belong to
	 * no Fumie session, so the harness approval hook rejects their tool calls
	 * instead of surfacing a confirmation nobody is looking at.
	 */
	private readonly _titleAgentIds = new Set<string>();
	private _harnessSubscriptionsInstalled = false;
	private _shutdownPromise: Promise<void> | undefined;

	constructor(
		@IDeepSeekSdkService private readonly _sdkService: IDeepSeekSdkService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
		@IChatGptSubscriptionService private readonly _chatGptSubscription: IChatGptSubscriptionService,
	) {
		super();
		// Project the compatible BYOK rows and shared ChatGPT subscription catalog.
		this._register(this._byokBridgeRegistry.onDidChangeModels(() => this._refreshModels()));
		this._register(this._chatGptSubscription.onDidChangeSignedIn(() => this._refreshModels()));
		this._refreshModels();
	}

	/**
	 * Publish the provider-compatible slice of the renderer BYOK catalog.
	 * BYOK rows keep their provider identity; subscription rows use a separate route.
	 */
	private _refreshModels(): void {
		const byokModels = this._byokBridgeRegistry.getModels()
			.filter(model => !model.supportedHarnesses || model.supportedHarnesses.includes(this.id))
			.map((m): IAgentModelInfo => {
				const byokMeta = createAgentModelByokMeta(m.modelIdentifier, m.hidden);
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
					...(byokMeta && { _meta: byokMeta }),
				};
			});
		this._models.set([...byokModels, ...(this._chatGptSubscription.isSignedIn() ? deepSeekSubscriptionModels() : [])], undefined);
	}

	/**
	 * Agent options for a resume that only replays a stored transcript. No turn
	 * runs, so the model just has to satisfy the runtime's option shape — any
	 * offerable one does. An empty catalog means the same thing here as it does
	 * at harness boot: there is nothing to run DeepSeek on.
	 */
	private _replayAgentOptions(): { provider: string; model: string } {
		const first = this._models.get().find(model => !readAgentModelByokHidden(model));
		if (!first) {
			throw new Error('DeepSeek has no model available from the configured model providers.');
		}
		return deepSeekAgentOptions({ id: first.id });
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
			throw new Error('DeepSeek session forking is not yet exposed through Fumie');
		}
		if (options.agent) {
			throw new Error('DeepSeek custom agent profiles are not yet exposed through Fumie');
		}
		const session = resolveAgentChatContext(context, chat).configurationResource;
		const sessionId = AgentSession.id(session);
		const existing = this._sessions.get(sessionId);
		if (existing) {
			if (existing.chat.toString() !== chat.toString()) {
				throw new Error('DeepSeek does not yet support additional Fumie chats');
			}
			return {
				resolvedWorkingDirectory: existing.workingDirectories[0],
				provisional: existing.agentHandle === undefined,
				providerData: encodeDeepSeekChatData(sessionId),
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
		});

		return { resolvedWorkingDirectory: primary, provisional: true, providerData: encodeDeepSeekChatData(sessionId) };
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		const config = migrateDeepSeekPermissionConfig(params.config);
		return Promise.resolve({
			schema: deepSeekSessionConfigSchema.toProtocol(),
			values: deepSeekSessionConfigSchema.validateOrDefault(config, {
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

	private async _deleteChat(chat: URI, context?: URI | IAgentChatContext): Promise<void> {
		const session = resolveDeepSeekSession(chat, context);
		const id = AgentSession.id(session);
		await this._sessionSequencer.queue(id, async () => {
			await this._releaseEntry(id);
			this._sessions.delete(id);
		});
	}

	private async _releaseChat(chat: URI, context?: URI | IAgentChatContext): Promise<void> {
		const session = resolveDeepSeekSession(chat, context);
		const id = AgentSession.id(session);
		await this._sessionSequencer.queue(id, () => this._releaseEntry(id));
	}

	private async _getChatMessages(chat: URI, context?: URI | IAgentChatContext): Promise<readonly Turn[]> {
		const id = AgentSession.id(resolveDeepSeekSession(chat, context));
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return [];
		}
		const live = this._sessions.get(id)?.agentHandle;
		if (live) {
			return replayDeepSeekSessionToTurns(live.agent.session.events, id);
		}
		const harness = await this._sdkService.getHarness();
		this._installHarnessSubscriptions(harness);
		try {
			const handle = await harness.ctx.agents.resume({ resumeSessionId: id, agentOptions: this._replayAgentOptions() });
			try {
				return replayDeepSeekSessionToTurns(handle.agent.session.events, id);
			} finally {
				await handle.dispose();
			}
		} catch {
			return [];
		}
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// DeepSeek does not surface its native user-question flow through Fumie yet.
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('deepseekAgent.displayName', "DeepSeek"),
			description: localize('deepseekAgent.description', "DeepSeek coding agent powered by the in-process DeepSeek Harness"),
			capabilities: { modelCatalog: 'projected' },
		};
	}

	async listChatsToMigrate(): Promise<IAgentChatMetadata[] | undefined> {
		// DeepSeek ships with the orchestrator-owned registry; there are no legacy
		// provider-native chats to migrate.
		return [];
	}

	/**
	 * Host contract: describe an exact registered chat from DURABLE state alone.
	 * The host calls this before {@link materializeChat} on every cold re-entry,
	 * handing back the `providerData` it persisted at creation, and it must work
	 * with nothing live in this process — idle eviction releases the agent handle
	 * (and, across a restart, the whole harness) while the session stays
	 * resumable. Answering `undefined` for a session the harness still stores
	 * makes the host conclude the provider cannot describe it and refuse to
	 * reopen it (`Provider deepseek cannot read the conversation recorded for
	 * <session>`), so this reads the durable store and never consults
	 * {@link _sessions}.
	 *
	 * It reads that store's log file directly rather than asking the harness to
	 * list it. The catalog listing walks every stored session and throws out of
	 * the whole scan on the first log it dislikes — including logs an older
	 * writer left in a layout it no longer accepts — so ONE damaged session made
	 * EVERY session undescribable. See {@link readDeepSeekStoredSession}.
	 */
	async getChatMetadata(chat: URI, context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return undefined;
		}
		const configurationResource = resolveAgentChatContext(context, chat).configurationResource;
		const id = decodeDeepSeekChatData(providerData) ?? AgentSession.id(configurationResource);
		const stored = await readDeepSeekStoredSession(this._sdkService.sessionsRoot, id);
		if (stored.kind === 'damaged') {
			// The host treats `undefined` for a registered session as "not yet"
			// and asks again on every open, forever. A log already read and
			// rejected will not parse on the next attempt, so answer once,
			// definitively, with the reason — an error the user can act on beats
			// a session that silently refuses to open.
			this._logService.warn(`[DeepSeek] Unreadable session log for ${id} at ${stored.path}`);
			throw new ProtocolError(AHP_SESSION_NOT_FOUND, `DeepSeek session ${id} is stored but its log cannot be read`);
		}
		return stored.kind === 'described' ? this._toChatMetadata(stored.header, chat) : undefined;
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const configurationResource = resolveAgentChatContext(context, chat).configurationResource;
		const id = decodeDeepSeekChatData(providerData) ?? AgentSession.id(configurationResource);
		if (this._sessions.has(id)) {
			return { providerData: encodeDeepSeekChatData(id) };
		}
		if (!(await this._sdkService.canLoadWithoutDownload())) {
			return;
		}
		const harness = await this._sdkService.getHarness();
		this._installHarnessSubscriptions(harness);
		try {
			const handle = await harness.ctx.agents.resume({ resumeSessionId: id, agentOptions: this._replayAgentOptions() });
			const cwd = sessionCwd(handle.agent.session) ?? (await ensureWorkspacelessScratchDir(this._environmentService.userHome, id)).fsPath;
			const workingDirectories = [URI.file(cwd)];
			this._sessions.set(id, {
				session: configurationResource,
				chat,
				workingDirectories,
				agentHandle: handle,
			});
			return { providerData: encodeDeepSeekChatData(id), resolvedWorkingDirectory: workingDirectories[0] };
		} catch (error) {
			// Returning nothing leaves the host with a session it can describe
			// but cannot open, so the reason has to reach the log at least: a
			// resume fails for good when the stored log is in a layout this SDK
			// no longer replays, and silence there is indistinguishable from a
			// session that simply is not there.
			this._logService.warn(`[DeepSeek] Failed to resume session ${id}`, error);
			return;
		}
	}

	onSessionConfigChanged(_session: URI, _values: Record<string, unknown>): void { }

	/**
	 * Generate a short title for a session from the user's first prompt, using
	 * the session's own backend/model. Never touches the user's session
	 * transcript or turns, and never writes Fumie's session metadata: the
	 * naming turn runs on a hidden throwaway agent that is disposed again.
	 */
	async generateTitle(session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken): Promise<string | undefined> {
		try {
			return await this._generateTitleOnHiddenAgent(session, request, token);
		} catch (error) {
			this._logService.warn('[DeepSeek] Failed to generate a session title', error);
			return undefined;
		}
	}

	/**
	 * The DeepSeek Harness has no title-only completion, so naming a session
	 * runs one hidden agent on the same harness and the same model as the real
	 * session. Its own session id is a fresh uuid that appears in neither
	 * {@link _sessions} nor Fumie's registry, so the harness event hooks ignore
	 * its stream: no chat action, no turn, and no write to the user's session.
	 */
	private async _generateTitleOnHiddenAgent(session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested || !(await this._sdkService.canLoadWithoutDownload())) {
			return undefined;
		}
		const entry = this._sessions.get(AgentSession.id(session));
		const harness = await this._sdkService.getHarness();
		this._installHarnessSubscriptions(harness);
		const agentOptions = deepSeekAgentOptions(request.modelId !== undefined ? { id: request.modelId } : entry?.model);
		const handle = await harness.ctx.agents.create({
			sessionId: generateUuid(),
			meta: { cwd: entry?.workingDirectories[0]?.fsPath ?? os.tmpdir() },
			agentOptions,
			setup: harness.createModelSelectionSetup(agentOptions),
		});
		this._titleAgentIds.add(handle.agent.id);
		// `ask` routes every tool call through the harness approval hook, which
		// rejects the hidden agent's calls, so the naming turn can only answer
		// with text.
		harness.ctx.approval?.setPolicy(handle.agent, 'ask');
		const cancellation = token.onCancellationRequested(() => handle.agent.cancel('title-cancelled'));
		try {
			handle.agent.followup(harness.createUserMessage(deepSeekTitlePrompt(request.prompt)));
			await raceCancellation(handle.agent.whenIdle(), token);
			// The raw model reply; sanitizing and shortening titles belongs to the caller.
			const reply = token.isCancellationRequested ? undefined : deepSeekTitleFromEvents(handle.agent.session.events);
			this._logService.info(`[DeepSeek:${handle.agent.id}] session title reply: ${token.isCancellationRequested ? 'cancelled' : `${reply?.length ?? 0} character(s)`}`);
			return reply;
		} finally {
			cancellation.dispose();
			this._titleAgentIds.delete(handle.agent.id);
			await handle.dispose();
		}
	}

	getChatCustomizations(): Promise<readonly []> {
		return Promise.resolve([]);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// DeepSeek runs entirely on renderer BYOK models through the loopback
		// proxy; Fumie never starts or brokers a DeepSeek OAuth flow.
		return [];
	}

	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${chat.toString()}\u0000${client.clientId}`;
		let handle = this._activeClients.get(key);
		if (!handle) {
			handle = new DeepSeekActiveClient(client.clientId, client.displayName);
			this._activeClients.set(key, handle);
		}
		return handle;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}\u0000${clientId}`);
	}

	onClientToolCallComplete(_chat: URI, _toolCallId: string): void {
		// Client-contributed tools are not yet injected into the DeepSeek harness.
	}

	shutdown(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._pendingPermissions.denyAll(false);
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
			};
			this._sessions.set(sessionId, entry);
		}
		if (workingDirectories && workingDirectories.length > 0) {
			entry.workingDirectories = workingDirectories;
		}
		if (entry.turn) {
			throw new Error('A response is already being generated for this DeepSeek session.');
		}
		const agent = await this._materialize(entry);
		const effectiveTurnId = turnId ?? generateUuid();
		entry.turn = { id: effectiveTurnId, startedAt: Date.now(), reasoningPartIndex: 0, textPartIndex: 0, toolCalls: new Map(), streamingBlocks: new Map(), streamedBlocksThisStep: 0 };
		this._fire(entry.chat, {
			type: ActionType.ChatTurnStarted,
			turnId: effectiveTurnId,
			startedAt: new Date(entry.turn.startedAt).toISOString(),
			message: { text: prompt, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments: [...attachments] } : {}), ...(entry.model ? { model: entry.model } : {}), ...(entry.agent ? { agent: entry.agent } : {}) },
		});
		try {
			const harness = await this._sdkService.getHarness();
			agent.followup(harness.createUserMessage(prompt));
			await agent.whenIdle();
		} catch (error) {
			if (entry.turn?.id === effectiveTurnId) {
				this._finishWithError(entry, error);
			}
			throw error;
		}
	}

	private async _materialize(entry: IDeepSeekSessionEntry): Promise<IDeepSeekRuntimeAgent> {
		if (entry.agentHandle) {
			return entry.agentHandle.agent;
		}
		const harness = await this._sdkService.getHarness();
		this._installHarnessSubscriptions(harness);
		const id = AgentSession.id(entry.session);
		const agentOptions = deepSeekAgentOptions(entry.model);
		let handle: { readonly agent: IDeepSeekRuntimeAgent; dispose(): Promise<void> };
		try {
			handle = await harness.ctx.agents.resume({ resumeSessionId: id, agentOptions, setup: harness.createModelSelectionSetup(agentOptions) });
		} catch {
			const primary = entry.workingDirectories[0]
				?? await ensureWorkspacelessScratchDir(this._environmentService.userHome, id);
			entry.workingDirectories = [primary, ...entry.workingDirectories.slice(1)];
			handle = await harness.ctx.agents.create({
				sessionId: id,
				meta: { cwd: primary.fsPath },
				agentOptions,
				setup: harness.createModelSelectionSetup(agentOptions),
			});
		}
		entry.agentHandle = handle;
		// Fumie owns the approval decision. Keep DeepSeek on the ask path so
		// every tool request reaches the host's autoApprove/permissions engine.
		harness.ctx.approval?.setPolicy(handle.agent, 'ask');
		this._onDidMaterializeChat.fire({ chat: entry.chat, result: { providerData: encodeDeepSeekChatData(id) }, workingDirectories: entry.workingDirectories, project: undefined });
		return handle.agent;
	}

	private _installHarnessSubscriptions(harness: IDeepSeekHarness): void {
		if (this._harnessSubscriptionsInstalled) {
			return;
		}
		this._harnessSubscriptionsInstalled = true;
		const ctx = harness.ctx;
		ctx.on('session/event', (session: unknown, event: unknown) => {
			const sessionId = stringValue((session as { id?: unknown } | undefined)?.id);
			const entry = this._sessions.get(sessionId);
			if (!entry) {
				return;
			}
			this._handleEvent(entry, event as { type?: unknown; data?: unknown });
		});
		ctx.on('approval/request', (...args: unknown[]) => {
			const req = args[0] as { agent?: { id?: unknown } } | undefined;
			const next = args[1] as () => Promise<unknown>;
			const agentId = stringValue(req?.agent?.id);
			if (this._titleAgentIds.has(agentId)) {
				return Promise.resolve('rejected');
			}
			const entry = this._sessions.get(agentId);
			if (!entry || !entry.turn) {
				return next();
			}
			return this._requestApproval(entry, req as { toolName?: unknown; callId?: unknown; reason?: unknown })
				.then(approved => approved ? 'allowed-once' : 'rejected');
		});
	}

	private _handleEvent(entry: IDeepSeekSessionEntry, event: { type?: unknown; data?: unknown }): void {
		const turn = entry.turn;
		if (!turn) {
			return;
		}
		const data = asRecord(event.data);
		switch (event.type) {
			case 'assistant/message':
				this._handleAssistantMessage(entry, turn, asRecord(data.message));
				break;
			case 'assistant/chunk':
				this._handleChunk(entry, turn, asRecord(data.chunk));
				break;
			case 'tool/call':
				this._handleToolCall(entry, turn, data);
				break;
			case 'tool/result':
				this._handleToolResult(entry, turn, data);
				break;
			case 'todo/write':
				turn.latestTodos = mapDeepSeekTodos(data.todos);
				break;
			case 'turn/end':
				this._handleTurnEnd(entry, turn, asRecord(data.reason));
				break;
		}
	}

	/**
	 * Reasoning/text are streamed live via `assistant/chunk` (`reasoning-delta`/
	 * `text-delta`, see {@link _handleChunk}). This method is a fallback that
	 * emits the assembled `assistant/message` blocks only for steps where the
	 * harness streamed no deltas (e.g. a non-streaming completion), so content
	 * is never dropped while avoiding double-rendering on the normal path.
	 */
	private _handleAssistantMessage(entry: IDeepSeekSessionEntry, turn: IDeepSeekTurnState, message: Readonly<Record<string, unknown>>): void {
		const blocks = asBlocks(message.content);
		if (blocks.length === 0) {
			return;
		}
		const streamedThisStep = turn.streamedBlocksThisStep > 0;
		turn.streamedBlocksThisStep = 0;
		if (streamedThisStep) {
			return;
		}
		for (const block of blocks) {
			if (block.type === 'reasoning' && block.text) {
				const id = `${turn.id}:reasoning:${String(turn.reasoningPartIndex++)}`;
				this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Reasoning, id, content: block.text } });
			} else if (block.type === 'text' && block.text) {
				const id = `${turn.id}:text:${String(turn.textPartIndex++)}`;
				this._fire(entry.chat, { type: ActionType.ChatResponsePart, turnId: turn.id, part: { kind: ResponsePartKind.Markdown, id, content: block.text } });
			}
		}
	}

	private _handleChunk(entry: IDeepSeekSessionEntry, turn: IDeepSeekTurnState, chunk: Readonly<Record<string, unknown>>): void {
		switch (chunk.type) {
			case 'usage': {
				const usage = deepSeekUsage(chunk.usage);
				if (usage) {
					this._fire(entry.chat, { type: ActionType.ChatUsage, turnId: turn.id, usage });
				}
				break;
			}
			case 'block-start': {
				const index = numberValue(chunk.index);
				const blockType = stringValue(chunk.blockType);
				if (index === undefined || (blockType !== 'reasoning' && blockType !== 'text')) {
					break;
				}
				const reasoning = blockType === 'reasoning';
				const partId = reasoning
					? `${turn.id}:reasoning:${String(turn.reasoningPartIndex++)}`
					: `${turn.id}:text:${String(turn.textPartIndex++)}`;
				turn.streamingBlocks.set(index, { partId, reasoning });
				turn.streamedBlocksThisStep++;
				this._fire(entry.chat, {
					type: ActionType.ChatResponsePart,
					turnId: turn.id,
					part: { kind: reasoning ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown, id: partId, content: '' },
				});
				break;
			}
			case 'reasoning-delta':
			case 'text-delta': {
				const index = numberValue(chunk.index);
				const text = stringValue(chunk.text);
				const block = index === undefined ? undefined : turn.streamingBlocks.get(index);
				if (!block || !text) {
					break;
				}
				this._fire(entry.chat, {
					type: block.reasoning ? ActionType.ChatReasoning : ActionType.ChatDelta,
					turnId: turn.id,
					partId: block.partId,
					content: text,
				});
				break;
			}
			case 'block-end': {
				const index = numberValue(chunk.index);
				if (index !== undefined) {
					turn.streamingBlocks.delete(index);
				}
				break;
			}
		}
	}

	private _handleToolCall(entry: IDeepSeekSessionEntry, turn: IDeepSeekTurnState, data: Readonly<Record<string, unknown>>): void {
		const toolCallId = stringValue(data.callId);
		const toolName = stringValue(data.name) || 'tool';
		const toolInput = optionalString(data.arguments);
		const toolInputRecord = parseToolArguments(toolInput);
		turn.toolCalls.set(toolCallId, { name: toolName, input: toolInputRecord });
		const displayName = getDeepSeekToolDisplayName(toolName);
		const meta = buildDeepSeekToolMeta(toolName, toolInputRecord);
		this._fire(entry.chat, {
			type: ActionType.ChatToolCallStart,
			turnId: turn.id,
			toolCallId,
			toolName,
			displayName,
			...(meta ? { _meta: meta } : {}),
		});
		if (toolInput) {
			this._fire(entry.chat, { type: ActionType.ChatToolCallDelta, turnId: turn.id, toolCallId, content: toolInput });
		}
		this._fire(entry.chat, {
			type: ActionType.ChatToolCallReady,
			turnId: turn.id,
			toolCallId,
			invocationMessage: getDeepSeekInvocationMessage(toolName, displayName, toolInputRecord),
			toolInput,
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	private _handleToolResult(entry: IDeepSeekSessionEntry, turn: IDeepSeekTurnState, data: Readonly<Record<string, unknown>>): void {
		const callId = toolResultCallId(data);
		if (!callId) {
			return;
		}
		const isError = toolResultIsError(data);
		const output = toolResultText(data);
		const tracked = turn.toolCalls.get(callId);
		const toolName = tracked?.name ?? 'tool';
		const displayName = getDeepSeekToolDisplayName(toolName);
		const todos = toolName === 'todo_write' ? turn.latestTodos : undefined;
		this._fire(entry.chat, {
			type: ActionType.ChatToolCallComplete,
			turnId: turn.id,
			toolCallId: callId,
			result: {
				success: !isError,
				pastTenseMessage: getDeepSeekPastTenseMessage(toolName, displayName, tracked?.input, !isError, output),
				...(todos ? { content: [{ type: ToolResultContentType.TodoList, todos }] } : output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
				...(isError ? { error: { message: output || 'DeepSeek tool failed' } } : {}),
			},
		});
	}

	private _handleTurnEnd(entry: IDeepSeekSessionEntry, turn: IDeepSeekTurnState, reason: Readonly<Record<string, unknown>>): void {
		const duration = Date.now() - turn.startedAt;
		const kind = stringValue(reason.kind);
		if (kind === 'cancelled') {
			this._fire(entry.chat, { type: ActionType.ChatTurnCancelled, turnId: turn.id, duration });
		} else if (kind !== 'completed' && kind !== '') {
			const error = errorInfo((reason as { error?: unknown }).error);
			this._fire(entry.chat, { type: ActionType.ChatError, turnId: turn.id, duration, error: turn.pendingError ?? error });
			this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
		} else {
			this._fire(entry.chat, { type: ActionType.ChatTurnComplete, turnId: turn.id, duration });
		}
		entry.turn = undefined;
	}

	private _requestApproval(entry: IDeepSeekSessionEntry, request: { toolName?: unknown; callId?: unknown; reason?: unknown }): Promise<boolean> {
		const toolName = stringValue(request.toolName) || 'tool';
		const requestId = optionalString(request.callId) ?? generateUuid();
		const displayName = getDeepSeekToolDisplayName(toolName);
		// The harness's approval request carries no arguments, but the `tool/call`
		// event the scheduler appends before dispatching does (see
		// `_handleToolCall`), so the tracked input is what the host's path and
		// shell auto-approve rules read. A request without a `callId` has no
		// tracked call and falls back to a plain confirmation.
		const toolInput = entry.turn?.toolCalls.get(requestId)?.input;
		return this._pendingPermissions.registerAndFire(requestId, () => {
			this._onDidChatProgress.fire({
				kind: 'pending_confirmation',
				chat: entry.chat,
				...getDeepSeekApprovalTarget(toolName, toolInput),
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId: requestId,
					toolName,
					displayName,
					invocationMessage: optionalString(request.reason) ?? displayName,
					// The host's terminal rules parse the command off `toolInput`.
					toolInput: getDeepSeekToolInputString(toolName, toolInput),
					confirmationTitle: optionalString(request.reason) ?? getDeepSeekConfirmationTitle(toolName),
				},
			});
		}, entry);
	}

	private async _abort(chat: URI): Promise<void> {
		const entry = this._entryForChat(chat);
		entry.agentHandle?.agent.cancel('user-requested');
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const entry = this._entryForChat(chat);
		entry.model = model;
		if (entry.agentHandle && !entry.turn) {
			const handle = entry.agentHandle;
			entry.agentHandle = undefined;
			await handle.dispose();
		}
	}

	private async _changeAgent(chat: URI, agent: AgentSelection | undefined): Promise<void> {
		const entry = this._entryForChat(chat);
		if (entry.agentHandle) {
			throw new Error('DeepSeek cannot change agent profile after session creation');
		}
		if (agent) {
			throw new Error('DeepSeek custom agent profiles are not yet exposed through Fumie');
		}
		entry.agent = undefined;
	}

	private _entryForChat(chat: URI): IDeepSeekSessionEntry {
		const id = AgentSession.id(URI.parse(parseRequiredSessionUriFromChatUri(chat)));
		const entry = this._sessions.get(id);
		if (!entry) {
			throw new Error(`Unknown DeepSeek session: ${id}`);
		}
		return entry;
	}

	private async _releaseEntry(id: string): Promise<void> {
		const entry = this._sessions.get(id);
		if (!entry) {
			return;
		}
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		const handle = entry.agentHandle;
		entry.agentHandle = undefined;
		entry.turn = undefined;
		await handle?.dispose();
	}

	/**
	 * The durable header is everything the harness's lightweight listing parses:
	 * it stamps a creation time and a cwd but no last-activity time, so
	 * `modifiedTime` seeds from `startTime`. That seed only has to order a cold
	 * row — the host recomputes the session's real modified time from the turns
	 * it replays through {@link IAgentChats.getMessages} immediately after this.
	 */
	private _toChatMetadata(header: IDeepSeekSessionHeader, chat: URI): IAgentChatMetadata {
		return {
			chat,
			startTime: header.createdAt,
			modifiedTime: header.createdAt,
			...(header.cwd ? { workingDirectories: [URI.file(header.cwd)] } : {}),
		};
	}

	private _finishWithError(entry: IDeepSeekSessionEntry, error: unknown): void {
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

function resolveDeepSeekSession(chat: URI, context?: URI | IAgentChatContext): URI {
	return context
		? resolveAgentChatContext(context, chat).configurationResource
		: URI.parse(parseRequiredSessionUriFromChatUri(chat));
}

function encodeDeepSeekChatData(sessionId: string): string {
	return JSON.stringify({ sessionId });
}

function decodeDeepSeekChatData(value: string | undefined): string | undefined {
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

function migrateDeepSeekPermissionConfig(config: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	const migrated = { ...config };
	if (migrated[SessionConfigKey.AutoApprove] === undefined) {
		const legacy = migrated[LegacyDeepSeekPermissionModeConfigKey];
		if (legacy === 'yolo') {
			migrated[SessionConfigKey.AutoApprove] = 'autoApprove';
		} else if (legacy === 'auto') {
			migrated[SessionConfigKey.AutoApprove] = 'assisted';
		} else if (legacy === 'manual') {
			migrated[SessionConfigKey.AutoApprove] = 'default';
		}
	}
	delete migrated[LegacyDeepSeekPermissionModeConfigKey];
	return migrated;
}

/**
 * The model string the runtime sends upstream: the provider-local half of the
 * BYOK id the picker advertised (`<vendor>/<provider-local id>`), which the BYOK
 * loopback proxy resolves against the renderer catalog. Every model this harness
 * lists comes from that catalog, so anything else is a stale or foreign
 * selection and must not be silently substituted for a working one.
 */
function deepSeekAgentOptions(model: ModelSelection | undefined): { provider: string; model: string; reasoningEffort?: string } {
	const subscription = model && deepSeekSubscriptionAgentOptions(model);
	if (subscription) {
		return subscription;
	}
	if (!model?.id.includes('/')) {
		throw new Error(`DeepSeek cannot run model '${model?.id ?? ''}': it is not one of the models the configured providers advertise.`);
	}
	return { provider: DeepSeekProviderRoute, model: model.id };
}

/**
 * The naming turn's only instruction. The naming context arrives already
 * budgeted by `SessionTitleService`, the single owner of that budget, so it is
 * passed through as-is.
 */
function deepSeekTitlePrompt(prompt: string): string {
	return `Reply with only a concise 3-8 word title for this coding session, no quotes, no punctuation at the end: ${prompt}`;
}

/** The text of the last assistant message the hidden naming agent produced. */
function deepSeekTitleFromEvents(events: readonly IDeepSeekEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event.type !== 'assistant/message') {
			continue;
		}
		const text = asBlocks(asRecord(event.data.message).content)
			.map(block => (block.type === 'text' ? block.text ?? '' : ''))
			.join('')
			.trim();
		if (text) {
			return text;
		}
	}
	return undefined;
}

/**
 * The working directory a resumed session was created in. `cwd` sits directly
 * on the durable header (`{"id":…,"createdAt":…,"cwd":…}`); reading it from a
 * nested `meta` bag always missed, which silently re-attached every resumed
 * session to a workspace-less scratch directory instead of its own worktree.
 */
function sessionCwd(session: IDeepSeekSession): string | undefined {
	const cwd = session.header?.cwd;
	return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

function deepSeekUsage(value: unknown): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined {
	const usage = asRecord(value);
	const inputTokens = numberValue(usage.inputTokens);
	const outputTokens = numberValue(usage.outputTokens);
	const cacheReadTokens = numberValue(usage.cacheReadTokens);
	if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) {
		return undefined;
	}
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
	};
}

function toolResultCallId(data: Readonly<Record<string, unknown>>): string | undefined {
	const message = asRecord(data.message);
	const source = asRecord(message.source);
	if (typeof source.callId === 'string') {
		return source.callId;
	}
	const blocks = asBlocks(message.content);
	return typeof blocks[0]?.callId === 'string' ? blocks[0].callId : undefined;
}

function toolResultIsError(data: Readonly<Record<string, unknown>>): boolean {
	if (data.error !== undefined && data.error !== null) {
		return true;
	}
	const message = asRecord(data.message);
	const blocks = asBlocks(message.content);
	return blocks[0]?.isError === true;
}

function toolResultText(data: Readonly<Record<string, unknown>>): string {
	const message = asRecord(data.message);
	const blocks = asBlocks(message.content);
	const inner = asBlocks(blocks[0]?.content);
	const text = inner.map(block => (block.type === 'text' ? block.text ?? '' : '')).filter(Boolean).join('\n');
	return text || (typeof blocks[0]?.text === 'string' ? blocks[0].text : '');
}

interface IDeepSeekBlockLocal {
	readonly type: string;
	readonly text?: string;
	readonly callId?: string;
	readonly isError?: boolean;
	readonly content?: readonly IDeepSeekBlockLocal[];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {};
}

function asBlocks(value: unknown): readonly IDeepSeekBlockLocal[] {
	if (Array.isArray(value)) {
		return value as readonly IDeepSeekBlockLocal[];
	}
	const records = asRecord(value);
	const content = records.content;
	return Array.isArray(content) ? content as readonly IDeepSeekBlockLocal[] : [];
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : String(value ?? '');
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseToolArguments(input: unknown): Record<string, unknown> | undefined {
	if (typeof input !== 'string' || input.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(input);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorInfo(error: unknown): { errorType: string; message: string; stack?: string } {
	if (error instanceof Error) {
		return { errorType: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
	}
	if (typeof error === 'object' && error !== null) {
		const candidate = error as { code?: unknown; message?: unknown; stack?: unknown };
		return {
			errorType: optionalString(candidate.code) ?? 'DeepSeekError',
			message: optionalString(candidate.message) ?? String(error),
			...(optionalString(candidate.stack) ? { stack: optionalString(candidate.stack) } : {}),
		};
	}
	return { errorType: 'DeepSeekError', message: stringValue(error) };
}
