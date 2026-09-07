/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent, OPENCODE_AGENT_PROVIDER_ID, resolveAgentChatContext, resolveAgentHostInstructions } from '../../common/agent.js';
import { createAgentModelByokMeta } from '../../common/agentModelByokMeta.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelSourceMeta } from '../../common/agentModelSource.js';
import { getByokLmAgentModelId, type IByokLmModelInfo, visibleByokLmModels } from '../../common/agentHostByokLm.js';
import { AutoApproveLevel, createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { getReasoningEffortDescription, getReasoningEffortLabel, reasoningEffortLevels } from '../../common/reasoningEffort.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { composeSessionHostContext } from '../../common/sessionHostContext.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachmentKind, type AgentSelection, type ConfigSchema, type ModelSelection, type ProtectedResourceMetadata, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ChatInputResponseKind, MessageKind, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type PendingMessage, type Turn } from '../../common/state/sessionState.js';
import { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_PROVIDER_NAME, IChatGptSubscriptionService, chatGptSubscriptionMaxOutputTokens, type IChatGptSubscriptionModel } from '../chatGptSubscription.js';
import { OpencodeTurnMapper, replayOpencodeMessagesToTurns, type IOpencodePart, type IOpencodePermissionAsk, type IOpencodeStoredMessage } from './opencodeReplayMapper.js';
import { IOpencodeServerService, OPENCODE_BYOK_PROVIDER_ID, type IOpencodeEvent, type IOpencodeServer } from './opencodeServerService.js';

/**
 * The opencode provider.
 *
 * opencode is a complete coding agent — its own model loop, tools, permissions
 * and transcripts — that ships a local HTTP + SSE API and drives its own TUI
 * through it. Fumie is one more client of that API: this file owns AHP state,
 * permissions routing and the chat catalog, and owns nothing about how opencode
 * thinks. Represent, don't orchestrate.
 *
 * The reason for a native harness rather than the ACP adapter is subagents.
 * opencode delegates to a child *session*, and every child session's content
 * travels on the same global event stream as its parent's, which is what lets
 * {@link OpencodeTurnMapper} nest a subagent's whole transcript under the tool
 * call that spawned it — the exact thing opencode's ACP bridge drops.
 */

const opencodeSessionConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
});

interface IOpencodeTurnState {
	readonly mapper: OpencodeTurnMapper;
	readonly startedAt: number;
	cancelRequested: boolean;
	promptPending?: boolean;
	idleSeen?: boolean;
	waitingForIdle?: boolean;
	error?: unknown;
}

/**
 * Sub-key in `ModelSelection.config` carrying the user's thinking-level pick,
 * named the same as every other harness's so one picker contract spans them
 * all. opencode calls the same idea a model *variant*, so the value sent on the
 * wire is the variant key.
 */
const OpencodeThinkingLevelConfigKey = 'thinkingLevel';

/** A permission ask waiting on the host, and where its answer has to be sent. */
interface IOpencodePendingPermission {
	readonly entry: IOpencodeChatEntry;
	readonly permissionID: string;
	readonly sessionID: string;
	/** Someone else already answered this ask, so this connector must not answer it again. */
	replied: boolean;
}

interface IOpencodeChatEntry {
	readonly session: URI;
	readonly chat: URI;
	readonly storageResource: URI;
	workingDirectories: readonly URI[];
	model?: ModelSelection;
	providerData?: string;
	server?: IOpencodeServer;
	/** This chat keeps a retired server alive while its native work is active. */
	serverRetained?: boolean;
	/** Subscriptions to the shared server, dropped when this chat lets go of it. */
	serverListeners?: DisposableStore;
	/** The opencode session backing this chat; the anchor a restore resumes from. */
	opencodeSessionID?: string;
	/** The session-constant host briefing has not reached this opencode session yet. */
	hostContextPending?: boolean;
	turn?: IOpencodeTurnState;
	mapper?: OpencodeTurnMapper;
	readonly messages: Map<string, { turn?: IOpencodeTurnState; order?: number; parentID?: string; notification?: string }>;
	readonly steering: Map<string, { messageID: string; consumed: boolean }>;
	cancelled?: boolean;
	generation: number;
	messageOrder: number;
	lastUserMessageID?: string;
	pendingSends?: number;
	deferredEvents?: IOpencodeEvent[];
}

class OpencodeActiveClient implements IActiveClient {
	tools: readonly ToolDefinition[] = [];
	customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }
}

export class OpencodeAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = OPENCODE_AGENT_PROVIDER_ID;

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

	private readonly _entries = new Map<string, IOpencodeChatEntry>();
	private readonly _activeClients = new Map<string, OpencodeActiveClient>();
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, IOpencodePendingPermission>();
	private readonly _sequencer = new SequencerByKey<string>();
	private _shutdownPromise: Promise<void> | undefined;

	constructor(
		@IOpencodeServerService private readonly _serverService: IOpencodeServerService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
		@IByokLmBridgeRegistry private readonly _byokBridgeRegistry: IByokLmBridgeRegistry,
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
		canReleaseChat: chat => {
			const entry = this._entries.get(chat.toString());
			return Promise.resolve(!entry?.turn && !entry?.pendingSends && !entry?.mapper?.hasActiveSubagents && ![...entry?.messages.values() ?? []].some(message => message.notification && !message.turn));
		},
		sendMessage: (chat, prompt, workingDirectories, attachments, turnId, _senderClientId, _clientType, context) => this._sendMessage(chat, prompt, normalizeWorkingDirectories(workingDirectories), attachments, turnId, context),
		abort: chat => this._abort(chat),
		changeModel: (chat, model) => this._changeModel(chat, model),
		changeAgent: (chat, agent) => this._changeAgent(chat, agent),
		getMessages: chat => this._getMessages(chat),
	};

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('opencodeAgent.displayName', "opencode"),
			description: localize('opencodeAgent.description', "The opencode coding agent, using this machine's opencode installation and Fumie Providers"),
			capabilities: { modelCatalog: 'projected' },
		};
	}

	/** Republishes the compatible rows from Fumie's Provider catalog. */
	refreshModels(): Promise<void> {
		this._refreshModels();
		return Promise.resolve();
	}

	private _refreshModels(): void {
		this._models.set(opencodeProviderModels(this.id, this._byokBridgeRegistry.getModels(), this._chatGptSubscription.getModels()), undefined);
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({
			schema: opencodeSessionConfigSchema.toProtocol(),
			values: opencodeSessionConfigSchema.validateOrDefault(params.config, {
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
		if (entry) {
			return Promise.resolve({
				chat,
				startTime: 0,
				modifiedTime: Date.now(),
				model: entry.model,
				workingDirectories: entry.workingDirectories,
			});
		}
		const session = resolveAgentChatContext(context, chat).configurationResource;
		const decoded = decodeOpencodeProviderData(providerData);
		if (!decoded?.cwd || decoded.sessionId !== AgentSession.id(session)) {
			return Promise.resolve(undefined);
		}
		return Promise.resolve({
			chat,
			startTime: 0,
			modifiedTime: Date.now(),
			...(decoded.model ? { model: decoded.model } : {}),
			workingDirectories: [URI.file(decoded.cwd)],
		});
	}

	/**
	 * Re-attaches a chat from its persisted receipt.
	 *
	 * Nothing is started here: this recovers the working directory, the model and
	 * the opencode session the chat left behind, and lets the first thing that
	 * actually needs a server pay for it. That anchor is what
	 * {@link _getMessages} replays and what the next send continues, so a
	 * restored chat resumes its conversation instead of opening a second one.
	 */
	materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const decoded = decodeOpencodeProviderData(providerData);
		if (!decoded?.cwd) {
			return Promise.resolve();
		}
		const resolved = resolveAgentChatContext(context, chat);
		let entry = this._entries.get(chat.toString());
		if (!entry) {
			entry = {
				session: resolved.configurationResource,
				chat,
				storageResource: resolved.resource,
				workingDirectories: [URI.file(decoded.cwd)],
				...(decoded.model ? { model: decoded.model } : {}),
				...(decoded.opencodeSessionId ? { opencodeSessionID: decoded.opencodeSessionId } : {}),
				providerData,
				messages: new Map(),
				steering: new Map(),
				generation: 0,
				messageOrder: 0,
			};
			this._entries.set(chat.toString(), entry);
		}
		return Promise.resolve({ providerData: entry.providerData, resolvedWorkingDirectory: entry.workingDirectories[0] });
	}

	/**
	 * opencode has no side-channel for a one-off completion that would not land
	 * in the user's own session, so the host falls back to its own title
	 * heuristics rather than spending a turn of the user's tokens.
	 */
	generateTitle(_session: URI, _request: { readonly prompt: string; readonly modelId?: string }, _token: CancellationToken): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	getChatCustomizations(): Promise<readonly []> {
		return Promise.resolve([]);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	/** OpenCode authentication is disabled; credentials stay in Fumie Providers. */
	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${chat.toString()}\u0000${client.clientId}`;
		let result = this._activeClients.get(key);
		if (!result) {
			result = new OpencodeActiveClient(client.clientId, client.displayName);
			this._activeClients.set(key, result);
		}
		return result;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}\u0000${clientId}`);
	}

	onClientToolCallComplete(): void {
		// opencode runs its own tools; this client contributes none.
	}

	/**
	 * `selectedOptionId` is deliberately not widened into opencode's own
	 * `always`: that would write a saved permission into opencode's policy store,
	 * a second grant Fumie's permission UI could neither show nor revoke. The
	 * host owns persistent approval, so every allow it hands down is the
	 * narrowest one opencode offers.
	 */
	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// opencode's `question` tool is not projected onto AHP's input requests yet.
	}

	shutdown(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._pendingPermissions.denyAll(false);
			for (const entry of this._entries.values()) {
				await this._releaseEntry(entry);
			}
			this._entries.clear();
			await this._serverService.close();
		})();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}

	private _createChat(chat: URI, context: URI | IAgentChatContext, options: IAgentCreateChatOptions = {}): Promise<IAgentCreateChatResult> {
		if (options.fork || options.sideChat || options.importConversation) {
			throw new Error('opencode chat forking, branching, and import are not exposed through Fumie.');
		}
		const existing = this._entries.get(chat.toString());
		if (existing) {
			return Promise.resolve({
				resolvedWorkingDirectory: existing.workingDirectories[0],
				provisional: existing.opencodeSessionID === undefined,
				providerData: existing.providerData,
			});
		}
		const primary = options.workingDirectories?.[0];
		if (!primary) {
			throw new Error('opencode requires the Agent Host to provide an execution directory.');
		}
		const resolved = resolveAgentChatContext(context, chat);
		const entry: IOpencodeChatEntry = {
			session: resolved.configurationResource,
			chat,
			storageResource: resolved.resource,
			workingDirectories: [primary],
			...(options.model ? { model: options.model } : {}),
			messages: new Map(),
			steering: new Map(),
			generation: 0,
			messageOrder: 0,
		};
		entry.providerData = encodeOpencodeProviderData(entry);
		this._entries.set(chat.toString(), entry);
		return Promise.resolve({ resolvedWorkingDirectory: primary, provisional: true, providerData: entry.providerData });
	}

	private _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined, context: URI | IAgentChatContext | undefined): Promise<void> {
		const reservedEntry = this._entryForChat(chat);
		reservedEntry.pendingSends = (reservedEntry.pendingSends ?? 0) + 1;
		let reserved = true;
		return this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entryForChat(chat);
			if (entry.turn) {
				throw new Error('A response is already being generated for this opencode chat.');
			}
			const effectiveModel = this._resolveModel(entry.model);
			// A server is rooted at its `cwd` and opencode's per-request `directory`
			// does not move its tools, so a moved working directory means a new
			// server — and a session that belonged to the old one.
			if (workingDirectories?.[0] && !isEqual(entry.workingDirectories[0], workingDirectories[0])) {
				await this._releaseEntry(entry);
				entry.opencodeSessionID = undefined;
				entry.workingDirectories = [workingDirectories[0]];
				this._publishChatData(entry);
			}
			const generation = entry.generation;
			const { server, opencodeSessionID } = await this._materialize(entry, effectiveModel);
			if (generation !== entry.generation) {
				return;
			}
			const cwd = entry.workingDirectories[0].fsPath;
			const effectiveTurnId = turnId ?? generateUuid();
			const startedAt = Date.now();
			const mapper = entry.mapper ??= new OpencodeTurnMapper(effectiveTurnId, chat, opencodeSessionID, cwd, startedAt);
			mapper.beginTurn(effectiveTurnId, startedAt);
			const turn: IOpencodeTurnState = {
				mapper,
				startedAt,
				cancelRequested: false,
				promptPending: true,
			};
			entry.turn = turn;
			reservedEntry.pendingSends!--;
			reserved = false;
			entry.cancelled = false;
			const messageID = opencodeMessageID();
			entry.messages.set(messageID, { turn });
			mapper.recordSubmittedMessage(messageID);
			this._fire(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: effectiveTurnId,
				startedAt: new Date(startedAt).toISOString(),
				message: { text: prompt, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments: [...attachments] } : {}), model: effectiveModel },
			});
			const deferred = entry.deferredEvents;
			entry.deferredEvents = undefined;
			for (const event of deferred ?? []) {
				this._handleEvent(entry, event);
			}
			try {
				const hidden = this._hiddenContext(entry, context);
				// Read off the chat's current selection at send time, so a model
				// switch or a restored session takes effect on the very next turn.
				const variant = opencodeVariant(effectiveModel, this._models.get());
				const response = await server.request<IOpencodePromptResponse>('POST', `/session/${opencodeSessionID}/message`, {
					messageID,
					parts: opencodePromptParts(prompt, attachments, hidden),
					model: opencodeModelRef(effectiveModel),
					...(variant ? { variant } : {}),
				});
				if (generation === entry.generation) {
					entry.hostContextPending = false;
				}
				if (entry.turn !== turn) {
					return;
				}
				turn.promptPending = false;
				if (turn.cancelRequested) {
					this._finishTurn(entry, turn);
					return;
				}
				// The prompt call answers with the turn's final assistant message, and
				// regularly wins the race against that message's own `message.updated`
				// frame on the event stream — so the last model call's usage is read
				// off the answer instead of being hoped for. The mapper reports a
				// message's usage once, so whichever of the two arrives first wins and
				// the other is dropped. Without this the turn kept the *previous*
				// call's usage, which is also what made a replayed turn disagree with
				// the live one.
				if (response?.info?.sessionID === opencodeSessionID && response.info.role === 'assistant') {
					this._dispatch(turn.mapper.mapEvent({ type: 'message.updated', properties: { sessionID: opencodeSessionID, info: response.info } }));
					for (const part of response.parts ?? []) {
						if (part.sessionID === opencodeSessionID && part.messageID === response.info.id) {
							this._dispatch(turn.mapper.mapEvent({ type: 'message.part.updated', properties: { part } }));
						}
					}
				}
				const error = response?.info?.error ?? turn.error;
				if (error || !turn.waitingForIdle) {
					this._finishTurn(entry, turn, error ? new Error(opencodeErrorMessage(error)) : undefined, isOpencodeAbortError(error));
				}
			} catch (error) {
				this._finishTurn(entry, turn, error);
				throw error;
			}
		}).finally(() => {
			if (reserved) {
				reservedEntry.pendingSends!--;
			}
			this._releaseServerIfIdle(reservedEntry);
		});
	}

	/** Host FIFO stays in the host; only its explicitly selected steering slot is sent. */
	setPendingMessages(chat: URI, steeringMessage: PendingMessage | undefined, _queuedMessages: readonly PendingMessage[]): void {
		const entry = this._entries.get(chat.toString());
		if (!entry?.turn || entry.cancelled || !entry.server || !steeringMessage || entry.steering.has(steeringMessage.id)) {
			return;
		}
		const messageID = opencodeMessageID();
		entry.steering.set(steeringMessage.id, { messageID, consumed: false });
		entry.messages.set(messageID, { turn: entry.turn });
		entry.mapper?.recordSubmittedMessage(messageID);
		const model = steeringMessage.message.model ?? entry.model;
		const variant = opencodeVariant(model, this._models.get());
		// Do not wait behind sendMessage's long-lived prompt response, or abort
		// the native runner. OpenCode persists this input then joins that runner.
		void entry.server.request('POST', `/session/${entry.opencodeSessionID}/message`, {
			messageID,
			parts: opencodePromptParts(steeringMessage.message.text, steeringMessage.message.attachments, undefined),
			...(opencodeModelRef(model) ? { model: opencodeModelRef(model) } : {}),
			...(variant ? { variant } : {}),
		}).catch(error => {
			// A transport failure is ambiguous: never retry a possibly persisted
			// prompt or claim consumption just because the POST was accepted.
			this._logService.warn(`[opencode] Steering request failed: ${errorText(error)}`);
		});
	}

	private _finishTurn(entry: IOpencodeChatEntry, turn: IOpencodeTurnState, error?: unknown, aborted = false): void {
		if (entry.turn !== turn) {
			return;
		}
		entry.turn = undefined;
		const duration = Date.now() - turn.startedAt;
		this._dispatch(turn.mapper.closeOutstandingToolCalls(localize('opencode.toolCall.turnEnded', "opencode ended the turn before this tool call finished."), turn.cancelRequested || aborted));
		this._dispatch(turn.cancelRequested || aborted ? turn.mapper.mapCancelled(duration)
			: error ? turn.mapper.mapFailure(error, duration) : turn.mapper.mapStop(duration));
		this._releaseServerIfIdle(entry);
	}

	private _nativeTurnForMessage(entry: IOpencodeChatEntry, parentID: string): IOpencodeTurnState | undefined {
		const parent = entry.messages.get(parentID);
		if (!parent || !entry.mapper || entry.cancelled) {
			return undefined;
		}
		if (parent.turn && parent.turn === entry.turn) {
			return parent.turn;
		}
		const steering = [...entry.steering.values()].some(value => value.messageID === parentID && !value.consumed);
		if ((parent.turn || !parent.notification) && !steering) {
			return undefined;
		}
		if (!entry.turn) {
			const startedAt = Date.now();
			const turnId = `opencode:${parentID}`;
			entry.mapper.beginTurn(turnId, startedAt);
			entry.turn = { mapper: entry.mapper, startedAt, cancelRequested: false };
			this._fire(entry.chat, {
				type: ActionType.ChatTurnStarted, turnId, startedAt: new Date(startedAt).toISOString(),
				message: { text: parent.notification ?? '', origin: { kind: MessageKind.SystemNotification } },
			});
		}
		if (entry.turn.idleSeen) {
			entry.turn.waitingForIdle = true;
		}
		return parent.turn = entry.turn;
	}

	/**
	 * The text that reaches the model without being the user's own.
	 *
	 * opencode marks a prompt part `synthetic` when it was not typed by a person,
	 * which is the channel this connector uses for the host's per-operation
	 * instructions and — once per opencode session, on its first send — the
	 * session-constant host briefing (`composeSessionHostContext`). Because a
	 * synthetic part is stored as such, a restore can tell it apart from what the
	 * user wrote and leave it out of the transcript, which is how the host's
	 * promise that its instructions never become user content is kept on a
	 * protocol with no session-level system prompt.
	 */
	private _hiddenContext(entry: IOpencodeChatEntry, context: URI | IAgentChatContext | undefined): string | undefined {
		const blocks: string[] = [];
		if (entry.hostContextPending) {
			const hostContext = composeSessionHostContext(this._productService);
			if (hostContext) {
				blocks.push(hostContext);
			}
		}
		blocks.push(...resolveAgentHostInstructions(context) ?? []);
		return blocks.length ? blocks.join('\n\n') : undefined;
	}

	/**
	 * Replays a restored chat's transcript from the opencode session that still
	 * holds it.
	 *
	 * Empty and failed are deliberately different answers. `[]` means there is
	 * genuinely nothing to replay — the chat never reached opencode. Anything
	 * that merely went wrong throws, because the host caches a resolved empty
	 * history for the life of the process while leaving a rejected one
	 * retryable; answering `[]` on a transient failure would blank a
	 * conversation until the app restarts.
	 */
	private _getMessages(chat: URI): Promise<readonly Turn[]> {
		return this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entries.get(chat.toString());
			const opencodeSessionID = entry?.opencodeSessionID;
			if (!entry || !opencodeSessionID) {
				return [];
			}
			const server = await this._connect(entry);
			try {
				const messages = await server.request<readonly IOpencodeStoredMessage[]>('GET', `/session/${opencodeSessionID}/message`);
				return replayOpencodeMessagesToTurns(messages ?? [], chat, opencodeSessionID, entry.workingDirectories[0].fsPath);
			} finally {
				this._releaseServerIfIdle(entry);
			}
		});
	}

	private async _materialize(entry: IOpencodeChatEntry, model: ModelSelection): Promise<{ server: IOpencodeServer; opencodeSessionID: string }> {
		const generation = entry.generation;
		const server = await this._connect(entry);
		if (!this._serverService.isModelAvailable(server, model.id)) {
			throw new Error(`The selected OpenCode model '${model.id}' is not available in this chat's active OpenCode process. Wait for its background work to finish, then try again.`);
		}
		if (entry.opencodeSessionID) {
			return { server, opencodeSessionID: entry.opencodeSessionID };
		}
		const created = await server.request<{ readonly id: string }>('POST', '/session', {});
		if (generation !== entry.generation || this._entries.get(entry.chat.toString()) !== entry) {
			throw new Error('opencode chat was released while creating a session.');
		}
		if (!created?.id) {
			throw new Error('opencode did not return a session id.');
		}
		entry.opencodeSessionID = created.id;
		// A session opencode has just minted has never been told who is hosting it.
		entry.hostContextPending = true;
		entry.providerData = encodeOpencodeProviderData(entry);
		this._onDidMaterializeChat.fire({ chat: entry.chat, result: { providerData: entry.providerData }, workingDirectories: entry.workingDirectories, project: undefined });
		return { server, opencodeSessionID: created.id };
	}

	/** Attaches this chat to the server for its working directory, starting one if needed. */
	private async _connect(entry: IOpencodeChatEntry): Promise<IOpencodeServer> {
		// A retained server owns a turn or native background child. Keep that
		// generation until the native work ends even when Providers changes.
		if (entry.server && entry.serverRetained) {
			return entry.server;
		}
		const cwd = entry.workingDirectories[0]?.fsPath;
		if (!cwd) {
			throw new Error('opencode has no execution directory.');
		}
		const generation = entry.generation;
		const server = await this._serverService.acquire(cwd);
		if (generation !== entry.generation || this._entries.get(entry.chat.toString()) !== entry) {
			this._serverService.release(server);
			throw new Error('opencode chat was released while connecting.');
		}
		entry.serverRetained = true;
		if (entry.server !== server) {
			const listeners = new DisposableStore();
			listeners.add(server.onDidReceiveEvent(event => this._handleEvent(entry, event)));
			listeners.add(server.onDidClose(reason => this._handleServerClose(entry, reason)));
			entry.serverListeners?.dispose();
			entry.server = server;
			entry.serverListeners = listeners;
		}
		return server;
	}

	/**
	 * One frame off the shared stream.
	 *
	 * The stream is server-wide, so a frame reaches every chat rooted in the same
	 * directory; the mapper drops what does not belong to this chat's session or
	 * one of its subagents, which is the single place that decision is made.
	 */
	private _handleEvent(entry: IOpencodeChatEntry, event: IOpencodeEvent): void {
		const properties = event.properties;
		const info = properties['info'] as Record<string, unknown> | undefined;
		const part = properties['part'] as Record<string, unknown> | undefined;
		const sessionID = properties['sessionID'] ?? info?.['sessionID'] ?? part?.['sessionID'];
		// The host already owns a queued send's turn. Do not open a competing
		// system turn during its asynchronous materialization window.
		if (!entry.turn && entry.pendingSends && sessionID === entry.opencodeSessionID && !entry.cancelled) {
			(entry.deferredEvents ??= []).push(event);
			return;
		}
		// Both permission generations are read. 1.18.25 publishes the v1 frame in
		// practice while leading with the v2 names in its schema, and an ask nobody
		// answers hangs opencode's agent loop until the turn is aborted — which is
		// precisely the failure that ruled out the ACP route, so this connector
		// must not reproduce it by knowing only one of the two names.
		if (event.type === 'permission.asked' || event.type === 'permission.v2.asked') {
			void this._handlePermissionAsk(entry, event.properties as unknown as IOpencodePermissionAsk, event.type === 'permission.v2.asked');
			return;
		}
		if (event.type === 'permission.replied' || event.type === 'permission.v2.replied') {
			this._handlePermissionReplied(entry, event.properties);
			return;
		}
		const mapper = entry.mapper;
		if (!mapper) {
			return;
		}
		if (entry.cancelled) {
			if (sessionID === entry.opencodeSessionID && event.type === 'session.status' && (properties['status'] as { type?: string } | undefined)?.type === 'idle' && entry.turn) {
				this._finishTurn(entry, entry.turn);
			}
			return;
		}
		if (sessionID !== entry.opencodeSessionID) {
			if (typeof sessionID === 'string' && mapper.ownsChild(sessionID)) {
				this._dispatch(mapper.mapEvent(event));
				this._releaseServerIfIdle(entry);
			}
			return;
		}
		if (event.type === 'message.updated' && typeof info?.['id'] === 'string') {
			const id = info['id'];
			const message = entry.messages.get(id) ?? {};
			entry.messages.set(id, message);
			if (info['role'] === 'user') {
				message.order ??= ++entry.messageOrder;
				entry.lastUserMessageID = id;
			} else if (info['role'] === 'assistant' && typeof info['parentID'] === 'string') {
				message.parentID = info['parentID'];
				message.turn ??= this._nativeTurnForMessage(entry, message.parentID);
				if (message.turn === entry.turn && entry.turn && info['error']) {
					entry.turn.error = info['error'];
				}
			}
		}
		const messageID = part?.['messageID'] ?? properties['messageID'] ?? info?.['id'];
		const message = typeof messageID === 'string' ? entry.messages.get(messageID) : undefined;
		if (event.type === 'message.part.updated' && part && message && mapper.backgroundResultForPart(part as unknown as IOpencodePart)) {
			message.notification = part['text'] as string;
			this._dispatch(mapper.mapEvent(event));
			this._releaseServerIfIdle(entry);
			return;
		}
		const status = (properties['status'] as { type?: string } | undefined)?.type;
		if (event.type === 'session.status' && status === 'busy' && entry.turn?.idleSeen) {
			entry.turn.waitingForIdle = true;
		}
		if (entry.lastUserMessageID && ((event.type === 'session.status' && status === 'busy') || event.type === 'session.error')) {
			this._nativeTurnForMessage(entry, entry.lastUserMessageID);
		}
		if (event.type === 'session.error' && entry.turn) {
			// ChatError is terminal in the host. Keep it behind the same HTTP
			// fallback barrier as completion instead of ending the host turn early.
			entry.turn.error = properties['error'];
			return;
		}
		if (event.type === 'message.part.updated' && part?.['type'] === 'step-start' && message?.parentID && !entry.cancelled) {
			const order = entry.messages.get(message.parentID)?.order;
			for (const [id, steering] of entry.steering) {
				const sentOrder = entry.messages.get(steering.messageID)?.order;
				if (!steering.consumed && order !== undefined && sentOrder !== undefined && sentOrder <= order) {
					steering.consumed = true;
					this._onDidChatProgress.fire({ kind: 'steering_consumed', chat: entry.chat, id });
				}
			}
		}
		if (event.type === 'session.status' && status === 'idle' && entry.turn) {
			entry.turn.idleSeen = true;
			entry.turn.waitingForIdle = false;
			if (entry.turn.promptPending) {
				return;
			}
			const error = entry.turn.error;
			this._finishTurn(entry, entry.turn, error ? new Error(opencodeErrorMessage(error)) : undefined, isOpencodeAbortError(error));
			return;
		}
		// User frames must reach the mapper to suppress their parts. Late root
		// snapshots from a finished turn must never be projected onto the next one.
		if (info?.['role'] === 'user' || (entry.turn && (!message || message.turn === entry.turn))) {
			this._dispatch(mapper.mapEvent(event));
		}
	}

	/**
	 * Bridges an opencode permission ask onto the host's approval pipeline.
	 *
	 * The host answers with a boolean because it — not opencode — owns
	 * persistent auto-approval rules, so an allow is always opencode's `once`.
	 * An ask arriving outside a turn, or for a session this turn cannot route,
	 * is rejected rather than left to hang the agent loop.
	 */
	private async _handlePermissionAsk(entry: IOpencodeChatEntry, ask: IOpencodePermissionAsk, v2: boolean): Promise<void> {
		if (typeof ask?.id !== 'string' || typeof ask.sessionID !== 'string') {
			return;
		}
		const mapper = entry.mapper;
		if (!mapper || entry.cancelled || (!entry.turn && ask.sessionID === entry.opencodeSessionID)) {
			// The stream is server-wide, so this frame reached every chat rooted in
			// the same directory. Only the chat that owns the session may answer for
			// it — and it answers rather than staying silent, because an unanswered
			// ask hangs opencode's agent loop. A chat that does not own it must do
			// nothing at all: rejecting on another chat's behalf is how the subagent
			// smoke saw an allowed write come back rejected.
			if (ask.sessionID === entry.opencodeSessionID || mapper?.ownsChild(ask.sessionID)) {
				await this._replyToPermission(entry, ask, v2, 'reject');
			}
			return;
		}
		// `undefined` means this turn has no route to the ask's session — it belongs
		// to another chat on the shared server, which will answer it itself.
		const mapping = mapper.mapPermissionAsk(ask);
		if (!mapping) {
			if (mapper.ownsChild(ask.sessionID)) {
				await this._replyToPermission(entry, ask, v2, 'reject');
			}
			return;
		}
		if (this._pendingPermissions.has(mapping.confirmation.state.toolCallId)) {
			return;
		}
		this._dispatch(mapping.signals);
		const pending: IOpencodePendingPermission = { entry, permissionID: ask.id, sessionID: ask.sessionID, replied: false };
		const approved = await this._pendingPermissions.registerAndFire(
			mapping.confirmation.state.toolCallId,
			() => this._onDidChatProgress.fire(mapping.confirmation),
			pending,
		);
		if (pending.replied) {
			return;
		}
		await this._replyToPermission(entry, ask, v2, approved && !entry.cancelled ? 'once' : 'reject');
	}

	/**
	 * Answers one ask on the route that matches the frame it came from.
	 *
	 * The two generations have separate endpoints — and separate body keys — so
	 * the frame's own version decides, rather than a guess that would leave the
	 * agent loop waiting.
	 *
	 * The answer is always opencode's narrowest: see
	 * {@link respondToPermissionRequest} for why `always` is never sent.
	 */
	private async _replyToPermission(entry: IOpencodeChatEntry, ask: IOpencodePermissionAsk, v2: boolean, reply: 'once' | 'reject'): Promise<void> {
		try {
			await (v2
				? entry.server?.request('POST', `/api/session/${ask.sessionID}/permission/${ask.id}/reply`, { reply })
				: entry.server?.request('POST', `/session/${ask.sessionID}/permissions/${ask.id}`, { response: reply }));
		} catch (error) {
			this._logService.warn(`[opencode] Failed to answer permission ${ask.id}`, error);
		}
	}

	/** Another client answered an ask this connector is still waiting on. */
	private _handlePermissionReplied(entry: IOpencodeChatEntry, properties: Record<string, unknown>): void {
		const requestID = properties['requestID'];
		if (typeof requestID !== 'string') {
			return;
		}
		const approved = properties['reply'] !== 'reject';
		this._pendingPermissions.respondWhere(pending => {
			if (pending.entry !== entry || pending.permissionID !== requestID) {
				return false;
			}
			pending.replied = true;
			return true;
		}, approved);
	}

	/**
	 * The server died outside a normal disposal. Fail the active turn so the chat
	 * stops looking busy and drop the handle so the next send starts a fresh
	 * process. The opencode session id survives: a crashed server did not unwrite
	 * the conversation.
	 */
	private _handleServerClose(entry: IOpencodeChatEntry, reason: string): void {
		this._logService.warn(`[opencode] ${reason}`);
		this._pendingPermissions.respondWhere(pending => pending.entry === entry, false);
		if (entry.mapper) {
			this._dispatch(entry.mapper.closeOutstandingToolCalls(reason));
		}
		const turn = entry.turn;
		if (turn) {
			entry.turn = undefined;
			this._dispatch(turn.mapper.mapFailure(new Error(reason), Date.now() - turn.startedAt));
		}
		const server = entry.server;
		entry.serverListeners?.dispose();
		entry.serverListeners = undefined;
		entry.server = undefined;
		if (server && entry.serverRetained) {
			entry.serverRetained = false;
			this._serverService.release(server);
		}
		entry.mapper = undefined;
		entry.messages.clear();
		entry.steering.clear();
		entry.lastUserMessageID = undefined;
		entry.deferredEvents = undefined;
	}

	private _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const entry = this._entryForChat(chat);
		this._resolveModel(model);
		entry.model = model;
		this._publishChatData(entry);
		// The choice rides every prompt, so a live session honours it on the next
		// turn without opencode being told separately.
		return Promise.resolve();
	}

	private _resolveModel(model: ModelSelection | undefined): ModelSelection {
		const available = opencodeProviderModels(
			this.id,
			visibleByokLmModels(this._byokBridgeRegistry.getModels()),
			this._chatGptSubscription.getModels(),
		);
		if (available.length === 0) {
			throw new Error('OpenCode has no visible compatible model in Fumie Providers.');
		}
		if (model && !available.some(candidate => candidate.id === model.id)) {
			throw new Error(`The selected OpenCode model '${model.id}' is no longer available in Fumie Providers.`);
		}
		return model ?? { id: available[0].id };
	}

	private _changeAgent(_chat: URI, agent: AgentSelection | undefined): Promise<void> {
		return agent ? Promise.reject(new Error('opencode custom agent profiles are not exposed through Fumie.')) : Promise.resolve();
	}

	private async _abort(chat: URI): Promise<void> {
		const entry = this._entryForChat(chat);
		entry.cancelled = true;
		if (entry.turn) {
			entry.turn.cancelRequested = true;
		}
		if (entry.server && entry.opencodeSessionID) {
			try {
				await entry.server.request('POST', `/session/${entry.opencodeSessionID}/abort`);
			} catch (error) {
				this._logService.warn(`[opencode] Failed to abort ${entry.opencodeSessionID}`, error);
			}
		}
		// Resolved after the abort is queued so the permission answers carry the
		// cancelled outcome rather than a plain rejection the model would read as
		// the user saying no.
		this._pendingPermissions.respondWhere(pending => pending.entry === entry, false);
		if (entry.mapper) {
			this._dispatch(entry.mapper.closeOutstandingToolCalls(localize('opencode.cancelled', "opencode was cancelled.")));
		}
	}

	private async _deleteChat(chat: URI): Promise<void> {
		const entry = this._entries.get(chat.toString());
		if (entry) {
			await this._releaseEntry(entry);
			this._entries.delete(chat.toString());
		}
	}

	private async _releaseChat(chat: URI): Promise<void> {
		const entry = this._entries.get(chat.toString());
		if (entry) {
			await this._releaseEntry(entry);
		}
	}

	/**
	 * Detaches a chat from its server while leaving the chat intact.
	 *
	 * The opencode session id deliberately survives: it names a conversation
	 * opencode wrote down, and the receipt on disk goes on naming it long after
	 * every process started here is gone. The server itself is shared, so it is
	 * only unsubscribed here — {@link shutdown} is what stops it.
	 */
	private async _releaseEntry(entry: IOpencodeChatEntry): Promise<void> {
		entry.generation++;
		entry.cancelled = true;
		if (entry.turn) {
			entry.turn.cancelRequested = true;
		}
		this._pendingPermissions.respondWhere(pending => pending.entry === entry, false);
		if (entry.server && entry.opencodeSessionID && entry.mapper) {
			try {
				await entry.server.request('POST', `/session/${entry.opencodeSessionID}/abort`);
			} catch (error) {
				this._logService.trace(`[opencode] Abort on release failed: ${errorText(error)}`);
			}
		}
		if (entry.mapper) {
			this._dispatch(entry.mapper.closeOutstandingToolCalls(localize('opencode.released', "opencode chat was released.")));
		}
		if (entry.turn) {
			this._finishTurn(entry, entry.turn);
		}
		const server = entry.server;
		entry.serverListeners?.dispose();
		entry.serverListeners = undefined;
		entry.server = undefined;
		if (server && entry.serverRetained) {
			entry.serverRetained = false;
			this._serverService.release(server);
		}
		entry.turn = undefined;
		entry.mapper = undefined;
		entry.messages.clear();
		entry.steering.clear();
		entry.lastUserMessageID = undefined;
		entry.deferredEvents = undefined;
	}

	private _releaseServerIfIdle(entry: IOpencodeChatEntry): void {
		const unreadNotification = [...entry.messages.values()].some(message => message.notification && !message.turn);
		if (!entry.server || !entry.serverRetained || entry.pendingSends || entry.turn || entry.mapper?.hasActiveSubagents || unreadNotification) {
			return;
		}
		entry.serverRetained = false;
		this._serverService.release(entry.server);
	}

	private _publishChatData(entry: IOpencodeChatEntry): void {
		entry.providerData = encodeOpencodeProviderData(entry);
		this._onDidChangeChatData.fire({ chat: entry.chat, providerData: entry.providerData });
	}

	private _entryForChat(chat: URI): IOpencodeChatEntry {
		const entry = this._entries.get(chat.toString());
		if (!entry) {
			throw new Error(`Unknown opencode chat: ${chat.toString()}`);
		}
		return entry;
	}

	private _dispatch(signals: readonly AgentSignal[]): void {
		for (const signal of signals) {
			this._onDidChatProgress.fire(signal);
		}
	}

	private _fire(resource: URI, action: Extract<AgentSignal, { kind: 'action' }>['action']): void {
		this._onDidChatProgress.fire({ kind: 'action', resource, action });
	}
}

let messageCounter = 0;

/** Native IDs sort by a 48-bit millisecond/counter prefix, then random suffix. */
function opencodeMessageID(): string {
	const time = BigInt.asUintN(48, BigInt(Date.now()) * 0x1000n + BigInt(++messageCounter % 0x1000));
	return `msg_${time.toString(16).padStart(12, '0')}${generateUuid().replaceAll('-', '').slice(0, 14)}`;
}

function normalizeWorkingDirectories(value: readonly URI[] | URI | undefined): readonly URI[] | undefined {
	return URI.isUri(value) ? [value] : value;
}

/**
 * The `POST /session/{id}/message` answer: the turn's final assistant message
 * and its parts. The originating turn consumes this fallback before ending;
 * the mapper deduplicates both usage and content already seen on SSE.
 */
interface IOpencodePromptResponse {
	readonly info?: Record<string, unknown> & { readonly error?: unknown };
	readonly parts?: readonly IOpencodePart[];
}

/**
 * Projects the Fumie Provider catalog into the OpenCode picker's flat rows.
 * OpenCode's own provider catalog and auth store never participate.
 */
export function opencodeProviderModels(provider: AgentProvider, byokModels: readonly IByokLmModelInfo[], chatGptModels: readonly IChatGptSubscriptionModel[]): readonly IAgentModelInfo[] {
	const byok = byokModels
		.filter(model => model.supportedHarnesses?.includes(OPENCODE_AGENT_PROVIDER_ID))
		.map((model): IAgentModelInfo => {
			const modelIdentifier = model.modelIdentifier ?? getByokLmAgentModelId(model);
			const configSchema = opencodeVariantConfigSchema(model.supportedReasoningEfforts);
			const byokMeta = createAgentModelByokMeta(model.modelIdentifier, model.hidden);
			return {
				provider,
				id: `${OPENCODE_BYOK_PROVIDER_ID}/${modelIdentifier}`,
				underlyingModelId: model.id,
				name: model.name ?? model.id,
				supportsVision: model.supportsVision ?? false,
				...(model.maxContextWindowTokens ? { maxContextWindow: model.maxContextWindowTokens } : {}),
				...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
				...(configSchema ? { configSchema } : {}),
				...(byokMeta ? { _meta: byokMeta } : {}),
			};
		});
	const chatGpt = chatGptModels.map((model): IAgentModelInfo => {
		const configSchema = opencodeVariantConfigSchema(model.supportedReasoningEfforts);
		return {
			provider,
			id: `${CHATGPT_SUBSCRIPTION_PROVIDER_NAME}/${model.id}`,
			underlyingModelId: model.id,
			name: model.name,
			supportsVision: model.supportsVision,
			maxContextWindow: model.maxContextWindowTokens,
			maxOutputTokens: chatGptSubscriptionMaxOutputTokens(model),
			...(configSchema ? { configSchema } : {}),
			_meta: createAgentModelSourceMeta(CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID),
		};
	});
	return [...byok, ...chatGpt];
}

/**
 * The thinking-level picker entry for a model's `variants`, or `undefined` when
 * the model has none — the picker then renders no control for that model.
 *
 * opencode keys its variants map in no particular order, so the tiers are sorted
 * through {@link reasoningEffortLevels} — the same canonical order every other
 * provider's picker uses. A key that list does not name is one opencode invented
 * on its own (a provider is free to publish any variant name); those ride along
 * at the end in the order opencode listed them rather than being dropped.
 *
 * No `default` is declared: an unpicked level sends no `variant` at all, which
 * is what leaves opencode on whatever it would have chosen for the model.
 */
function opencodeVariantConfigSchema(supportedReasoningEfforts: readonly string[] | undefined): ConfigSchema | undefined {
	const keys = [...supportedReasoningEfforts ?? []];
	if (keys.length === 0) {
		return undefined;
	}
	const ordered: readonly string[] = reasoningEffortLevels;
	const levels = [...ordered.filter(level => keys.includes(level)), ...keys.filter(key => !ordered.includes(key))];
	return {
		type: 'object',
		properties: {
			[OpencodeThinkingLevelConfigKey]: {
				type: 'string',
				title: localize('opencode.modelThinkingLevel.title', "Thinking Level"),
				description: localize('opencode.modelThinkingLevel.description', "Controls how much reasoning effort opencode asks the model to use."),
				enum: levels,
				enumLabels: levels.map(getReasoningEffortLabel),
				enumDescriptions: levels.map(level => getReasoningEffortDescription(level) ?? ''),
			},
		},
	};
}

/**
 * The opencode variant `model` asks for, or `undefined` for none — which is the
 * absence of a `variant` field on the prompt body, not a value to send.
 *
 * A pick is only honoured while the model it was made for still publishes it:
 * variant sets differ per model (opencode-zen's models carry `minimal`, the
 * OpenAI ones carry `max` instead), and a stored pick outlives the model it was
 * made for, so an unchecked level would follow a model switch onto a model that
 * has no such variant and opencode would reject the turn. Anything `catalog`
 * does not name for that model — including every level while the catalog has
 * not been read yet — is treated as unpicked, which leaves opencode on the
 * default it would have chosen anyway.
 */
export function opencodeVariant(model: ModelSelection | undefined, catalog: readonly IAgentModelInfo[]): string | undefined {
	const selected = model?.config?.[OpencodeThinkingLevelConfigKey];
	if (typeof selected !== 'string' || selected.length === 0) {
		return undefined;
	}
	const levels = catalog.find(row => row.id === model?.id)?.configSchema?.properties[OpencodeThinkingLevelConfigKey]?.enum;
	return levels?.includes(selected) ? selected : undefined;
}

/** Splits a picker model id back into what opencode's prompt body expects. */
export function opencodeModelRef(model: ModelSelection | undefined): { readonly providerID: string; readonly modelID: string } | undefined {
	const slash = model?.id.indexOf('/') ?? -1;
	if (!model || slash <= 0 || slash >= model.id.length - 1) {
		return undefined;
	}
	return { providerID: model.id.slice(0, slash), modelID: model.id.slice(slash + 1) };
}

/**
 * Builds the prompt parts for one user message.
 *
 * Host-supplied context leads as its own `synthetic` text part rather than
 * being spliced into what the user wrote, so the transcript keeps saying what
 * the user actually typed.
 */
export function opencodePromptParts(prompt: string, attachments: readonly MessageAttachment[] | undefined, hiddenContext: string | undefined): readonly Record<string, unknown>[] {
	const parts: Record<string, unknown>[] = [];
	if (hiddenContext) {
		parts.push({ type: 'text', text: hiddenContext, synthetic: true });
	}
	parts.push({ type: 'text', text: prompt });
	for (const attachment of attachments ?? []) {
		if (attachment.type === MessageAttachmentKind.EmbeddedResource) {
			parts.push({
				type: 'file',
				mime: attachment.contentType,
				filename: attachment.label,
				url: `data:${attachment.contentType};base64,${attachment.data}`,
			});
		} else if (attachment.type === MessageAttachmentKind.Simple && attachment.modelRepresentation) {
			parts.push({ type: 'text', text: attachment.modelRepresentation, synthetic: true });
		} else {
			parts.push({ type: 'text', text: `[Attached: ${attachment.label}]`, synthetic: true });
		}
	}
	return parts;
}

/** opencode's own name for a turn the user stopped. */
function isOpencodeAbortError(error: unknown): boolean {
	return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'MessageAbortedError';
}

function opencodeErrorMessage(error: unknown): string {
	const record = error as { name?: unknown; data?: { message?: unknown } } | null;
	if (record?.data && typeof record.data.message === 'string' && record.data.message) {
		return record.data.message;
	}
	return typeof record?.name === 'string' ? record.name : 'opencode reported an error.';
}

interface IOpencodeProviderData {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly model?: ModelSelection;
	readonly opencodeSessionId?: string;
}

/**
 * The persisted receipt for a chat: the directory its server is rooted at, the
 * chosen model, and the opencode session to resume. Every field past the first
 * is optional, so an older receipt stays readable as-is.
 */
export function encodeOpencodeProviderData(entry: { readonly session: URI; readonly workingDirectories: readonly URI[]; readonly model?: ModelSelection; readonly opencodeSessionID?: string }): string {
	return JSON.stringify({
		sessionId: AgentSession.id(entry.session),
		...(entry.workingDirectories[0] ? { cwd: entry.workingDirectories[0].fsPath } : {}),
		...(entry.model ? { model: entry.model } : {}),
		...(entry.opencodeSessionID ? { opencodeSessionId: entry.opencodeSessionID } : {}),
	} satisfies IOpencodeProviderData);
}

export function decodeOpencodeProviderData(value: string | undefined): IOpencodeProviderData | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as Partial<IOpencodeProviderData>;
		if (typeof parsed.sessionId !== 'string') {
			return undefined;
		}
		return {
			sessionId: parsed.sessionId,
			...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
			...(isModelSelection(parsed.model) ? { model: parsed.model } : {}),
			...(typeof parsed.opencodeSessionId === 'string' ? { opencodeSessionId: parsed.opencodeSessionId } : {}),
		};
	} catch {
		return undefined;
	}
}

function isModelSelection(value: unknown): value is ModelSelection {
	return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
