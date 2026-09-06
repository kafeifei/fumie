/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { SequencerByKey } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { ACP_CLAUDE_AGENT_PROVIDER_ID, AgentChatOperationContext, AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent, resolveAgentChatContext, resolveAgentHostInstructions } from '../../common/agent.js';
import { AutoApproveLevel, createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { ACP_CLAUDE_AGENT_SLUG, createAgentModelSourceMeta } from '../../common/agentModelSource.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { MessageAttachmentKind, type AgentSelection, type ModelSelection, type ProtectedResourceMetadata, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { ChatInputResponseKind, MessageKind, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type Turn } from '../../common/state/sessionState.js';
import { AcpConnection, spawnAcpTransport, type IAcpLaunchSpec, type IAcpTransport } from './acpConnection.js';
import { AcpPermissionDecision, AcpReplayCollector, AcpTurnMapper, buildAcpPermissionResponse } from './acpSessionMapper.js';

/**
 * The Agent Client Protocol provider.
 *
 * One class, many agents: every ACP-speaking CLI is a declarative entry in
 * {@link ACP_AGENT_CATALOG} rather than a code module, and the code below never
 * asks which entry it is driving. Everything agent-specific — the executable,
 * its arguments, its environment — is data; everything behavioural is
 * negotiated over the protocol. That is what lets the next agent be added
 * without touching a line of this file's logic.
 *
 * Each entry is registered as its own provider, because a picker row is keyed
 * on a provider id: a shared id would collapse the catalog into one row that
 * could not name the agent it starts. The class is instantiated once per entry
 * and {@link AcpAgent.id} says which one this instance drives.
 *
 * Session resume (`session/load`) and a user-facing catalog editor are later
 * milestones; the shapes here are chosen so both arrive as additions, not
 * rewrites.
 */

/**
 * One selectable model of a catalog agent.
 *
 * `id` is the agent's own ACP config-option value id, copied verbatim: this
 * table is a snapshot of what the pinned agent advertises, not a Fumie-side
 * naming scheme, so nothing has to translate between the two.
 */
export interface IAcpAgentModel {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

/** A declarative ACP agent. The catalog is the only place an agent is named. */
export interface IAcpAgentCatalogEntry {
	/** Stable identity persisted with the session; never derived from the command. */
	readonly slug: string;
	/** The agent-host provider this entry is registered as, and its session URI scheme. */
	readonly provider: AgentProvider;
	readonly displayName: string;
	readonly description: string;
	/** Executable, resolved from `PATH` unless absolute. */
	readonly command: string;
	readonly args: readonly string[];
	/** Extra environment layered over the agent host's, for agents that need one. */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Models this agent offers, when it is known to offer a choice.
	 *
	 * ACP has no pre-session model catalog — an agent only advertises its
	 * models in the `session/new` response, long after the picker needed them —
	 * so a picker-time list can only be a snapshot taken against a pinned agent
	 * version. Declaring it here keeps that snapshot next to the version it was
	 * taken from and out of the pipeline: the code below never learns which
	 * models exist, it only forwards the id the user chose back to the agent
	 * that published it. An entry with no list is an agent that owns its own
	 * model choice.
	 */
	readonly models?: readonly IAcpAgentModel[];
}

/**
 * Version of the ACP Claude adapter this catalog entry is validated against.
 *
 * Pinned rather than floating, matching how this repo pins
 * `@anthropic-ai/claude-agent-sdk`: an adapter that silently rolls forward
 * would change the wire behaviour of a shipped provider without a code review.
 */
const CLAUDE_ACP_ADAPTER = '@agentclientprotocol/claude-agent-acp@0.70.0';

/**
 * Model id used for an agent that declares no models of its own.
 *
 * It exists so every picker row has an id shaped `<slug>/<model>`; it is never
 * sent to an agent, because an agent that advertised no models has nothing to
 * set it to.
 */
const ACP_AGENT_MANAGED_MODEL_ID = 'default';

/**
 * The built-in ACP agent catalog.
 *
 * One entry today, zero pipeline code. It is purely declarative — an
 * executable, its arguments and (if it needed one) an environment — and it is
 * not mentioned anywhere outside this table. That is the architectural claim
 * this connector is making; M1 shipped a second entry (the Gemini CLI,
 * withdrawn on 2026-08-27 — see `docs/architecture.md`) which is how the
 * claim was tested, and the next agent is a row here rather than a code change.
 *
 * - **Claude Code** is reached through the ACP project's adapter, which
 *   embeds the Claude Agent SDK. Run via `npx --yes` so no global install is
 *   required; the first launch pays a download, later ones hit the npx cache.
 *   No credentials are injected: the adapter picks up the machine's own Claude
 *   login, which is exactly what makes this a genuine A/B against Fumie's
 *   native Claude harness rather than a second front-end onto the same
 *   configuration. Its model list mirrors the `model` config option the pinned
 *   adapter advertises in its `session/new` response, value ids included.
 *
 * Catalog order is picker order. Each entry declares the provider it registers
 * as, and an entry is the only agent behind that provider, so the row a user
 * picks names the agent Fumie will actually start.
 *
 * The names carry the protocol version because the point of these rows is the
 * transport, not the vendor: Fumie already has a native Claude harness, and
 * "Claude (ACPv1)" is how a user tells the two apart. ACP v1 is what this
 * connector negotiates, and a v2 entry would be a separate row.
 */
export const ACP_AGENT_CATALOG: readonly IAcpAgentCatalogEntry[] = [{
	slug: ACP_CLAUDE_AGENT_SLUG,
	provider: ACP_CLAUDE_AGENT_PROVIDER_ID,
	displayName: localize('acpAgent.claudeAcp.displayName', "Claude (ACPv1)"),
	description: localize('acpAgent.claudeAcp.description', "Claude Code via the Agent Client Protocol adapter, using this machine's own Claude sign-in"),
	command: 'npx',
	args: ['--yes', CLAUDE_ACP_ADAPTER],
	models: [
		{ id: 'default', name: localize('acpAgent.claudeAcp.model.default', "Default (Opus)"), description: localize('acpAgent.claudeAcp.model.default.description', "Whichever model the adapter recommends") },
		{ id: 'opus[1m]', name: localize('acpAgent.claudeAcp.model.opus', "Opus (1M context)"), description: localize('acpAgent.claudeAcp.model.opus.description', "Best for everyday, complex tasks") },
		{ id: 'claude-fable-5[1m]', name: localize('acpAgent.claudeAcp.model.fable', "Fable"), description: localize('acpAgent.claudeAcp.model.fable.description', "Most capable for your hardest and longest-running tasks") },
		{ id: 'sonnet', name: localize('acpAgent.claudeAcp.model.sonnet', "Sonnet"), description: localize('acpAgent.claudeAcp.model.sonnet.description', "Efficient for routine tasks") },
		{ id: 'haiku', name: localize('acpAgent.claudeAcp.model.haiku', "Haiku"), description: localize('acpAgent.claudeAcp.model.haiku.description', "Fastest for quick answers") },
	],
}];

/**
 * Splits a picker model id into the catalog agent that owns it and the agent's
 * own model id.
 *
 * The two travel as one string because Fumie's picker offers models, not
 * agents: choosing "Sonnet" has to be enough to say *which* agent runs it.
 * Everything downstream of this function deals in the agent's own id, so no
 * other code has to know the composite exists.
 */
export function splitAcpModelId(id: string): { readonly slug: string; readonly model: string } | undefined {
	const slash = id.indexOf('/');
	return slash > 0 && slash < id.length - 1 ? { slug: id.slice(0, slash), model: id.slice(slash + 1) } : undefined;
}

/** The model id the picker shows for one catalog entry's model. */
function acpModelId(slug: string, model: string): string {
	return `${slug}/${model}`;
}

/**
 * Projects the catalog onto the picker's flat model list.
 *
 * An agent that declares models contributes one row per model; an agent that
 * does not contributes a single row saying so, because a picker that requires a
 * model would otherwise refuse to select the agent at all. Either way the row's
 * id names its agent, which is what keeps a stored selection resolvable back to
 * the entry that published it.
 */
export function acpCatalogModels(catalog: readonly IAcpAgentCatalogEntry[]): readonly IAgentModelInfo[] {
	return catalog.flatMap(entry => {
		const meta = createAgentModelSourceMeta(entry.slug);
		const rows = entry.models ?? [{ id: ACP_AGENT_MANAGED_MODEL_ID, name: localize('acp.agentManagedModel', "Agent default") }];
		return rows.map((model): IAgentModelInfo => ({
			provider: entry.provider,
			id: acpModelId(entry.slug, model.id),
			name: model.name,
			supportsVision: false,
			...(meta ? { _meta: meta } : {}),
		}));
	});
}

const acpSessionConfigSchema = createSchema({
	[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
	[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
});

interface IAcpTurnState {
	readonly mapper: AcpTurnMapper;
	readonly startedAt: number;
	cancelRequested: boolean;
}

/**
 * A `session/load` in flight, and where the transcript it replays goes.
 *
 * ACP replays history through the very same `session/update` channel that
 * carries live streaming, with no marker distinguishing the two. Without this,
 * an agent's recollection of last week's turn would be fired at the renderer as
 * if it were happening now, duplicating every row on screen. So for as long as
 * a load is in flight, updates for that session are diverted here instead:
 * into a collector when the host asked for the transcript, into nothing when it
 * did not.
 */
interface IAcpSessionLoad {
	readonly acpSessionId: string;
	/** Absent when the replay is discarded — a resume taken purely to keep the agent's memory. */
	readonly collector?: AcpReplayCollector;
}

interface IAcpChatEntry {
	readonly session: URI;
	readonly chat: URI;
	readonly storageResource: URI;
	/** Mutable: choosing a model of another catalog agent moves the chat to that agent. */
	agent: IAcpAgentCatalogEntry;
	/** The agent's own model id (no slug prefix), as picked by the user. */
	model?: string;
	workingDirectories: readonly URI[];
	providerData?: string;
	connection?: AcpConnection;
	/** ACP session id from `session/new`; the anchor `session/load` resumes from. */
	acpSessionId?: string;
	/** Config options the live session advertised, refreshed on every change. */
	configOptions?: readonly acp.SessionConfigOption[];
	/** Cumulative usage the agent last reported, differenced into per-turn usage. */
	usage?: acp.Usage;
	turn?: IAcpTurnState;
	/** Set only while `session/load` is replaying; see {@link IAcpSessionLoad}. */
	load?: IAcpSessionLoad;
}

class AcpActiveClient implements IActiveClient {
	tools: readonly ToolDefinition[] = [];
	customizations: readonly ClientPluginCustomization[] = [];

	constructor(
		readonly clientId: string,
		readonly displayName: string | undefined,
	) { }
}

export class AcpAgent extends Disposable implements IAgent {

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;
	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;
	readonly onDidDiscoverChats: IAgent['onDidDiscoverChats'] = Event.None;

	/**
	 * The catalog, flattened for the picker.
	 *
	 * Fixed at construction because it is a projection of a static table: ACP
	 * exposes an agent's real model list only inside a session, far too late for
	 * a picker, so the catalog's declared snapshot is what the user chooses from
	 * and the live session is where that choice is reconciled.
	 */
	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _entries = new Map<string, IAcpChatEntry>();
	private readonly _activeClients = new Map<string, AcpActiveClient>();
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean, IAcpChatEntry>();
	private readonly _sequencer = new SequencerByKey<string>();
	private _shutdownPromise: Promise<void> | undefined;

	constructor(
		readonly id: AgentProvider,
		@ILogService protected readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
		this._models.set(acpCatalogModels(this._catalog()), undefined);
	}

	/**
	 * Opens the byte channel to an agent.
	 *
	 * `protected` so tests can substitute an in-process ACP agent for a spawned
	 * subprocess without a transport seam leaking into the production
	 * constructor — the same shape `ClaudeAgentSdkService._loadSdk` uses.
	 */
	protected _createTransport(spec: IAcpLaunchSpec): Promise<IAcpTransport> {
		return spawnAcpTransport(spec, this._logService);
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
		getMessages: (chat, context) => this._getMessages(chat, context),
	};

	/**
	 * One provider row, one catalog agent.
	 *
	 * The row names its agent, because that is what the user will actually get.
	 * The fallback covers only the case where the product allowlist has excluded
	 * this provider, in which case the row names nothing because it starts
	 * nothing.
	 */
	getDescriptor(): IAgentDescriptor {
		const entry = this._catalog()[0];
		return {
			provider: this.id,
			displayName: entry?.displayName ?? localize('acpAgent.displayName', "ACP Agent"),
			description: entry?.description
				?? localize('acpAgent.description', "An external coding agent connected over the Agent Client Protocol"),
			// No capability is advertised: this connector cannot fork a chat, cannot
			// host peer chats, and does not implement `setPendingMessages`, so
			// steering falls through to the host's own stranded-steering requeue.
			capabilities: {},
		};
	}

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return Promise.resolve({
			schema: acpSessionConfigSchema.toProtocol(),
			values: acpSessionConfigSchema.validateOrDefault(params.config, {
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
				workingDirectories: entry.workingDirectories,
			});
		}
		const session = resolveAgentChatContext(context, chat).configurationResource;
		const decoded = decodeAcpProviderData(providerData);
		if (!decoded?.cwd || decoded.sessionId !== AgentSession.id(session)) {
			return Promise.resolve(undefined);
		}
		return Promise.resolve({
			chat,
			startTime: 0,
			modifiedTime: Date.now(),
			workingDirectories: [URI.file(decoded.cwd)],
		});
	}

	/**
	 * Re-attaches a chat from its persisted receipt.
	 *
	 * Nothing is spawned here: this recovers identity — the working directory,
	 * which catalog agent owns the chat, and the ACP session it left running —
	 * and lets the first thing that actually needs the agent pay for starting
	 * it. That anchor is what {@link _getMessages} replays the transcript from
	 * and what the next send resumes, so a restored chat continues its
	 * conversation instead of beginning a second one.
	 */
	materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const decoded = decodeAcpProviderData(providerData);
		if (!decoded?.cwd) {
			return Promise.resolve();
		}
		const agent = this._catalog().find(candidate => candidate.slug === decoded.agent);
		if (!agent) {
			this._logService.warn(`[ACP] Chat ${chat.toString()} references unknown ACP agent '${decoded.agent}'.`);
			return Promise.resolve();
		}
		const resolved = resolveAgentChatContext(context, chat);
		let entry = this._entries.get(chat.toString());
		if (!entry) {
			entry = {
				session: resolved.configurationResource,
				chat,
				storageResource: resolved.resource,
				agent,
				...(decoded.model ? { model: decoded.model } : {}),
				...(decoded.acpSessionId ? { acpSessionId: decoded.acpSessionId } : {}),
				workingDirectories: [URI.file(decoded.cwd)],
				providerData,
			};
			this._entries.set(chat.toString(), entry);
		}
		return Promise.resolve({ providerData: entry.providerData, resolvedWorkingDirectory: entry.workingDirectories[0] });
	}

	/**
	 * ACP v1 has no side-channel for a one-off completion, and spawning a second
	 * agent process just to name a session would cost a full model turn. The
	 * host falls back to its own title heuristics.
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

	/**
	 * ACP agents authenticate themselves (`authenticate` with an agent-declared
	 * method id), so there is no host-forwarded bearer token to accept.
	 */
	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${chat.toString()}\u0000${client.clientId}`;
		let result = this._activeClients.get(key);
		if (!result) {
			result = new AcpActiveClient(client.clientId, client.displayName);
			this._activeClients.set(key, result);
		}
		return result;
	}

	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void {
		this._activeClients.delete(`${chat.toString()}\u0000${clientId}`);
	}

	onClientToolCallComplete(): void {
		// ACP agents run their own tools; this client contributes none.
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.respond(requestId, approved);
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// ACP's elicitation extension is not implemented, so nothing can ask.
	}

	shutdown(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._pendingPermissions.denyAll(false);
			for (const entry of this._entries.values()) {
				await this._releaseEntry(entry);
			}
			this._entries.clear();
		})();
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}

	/**
	 * This instance's catalog agent, when the product allows it.
	 *
	 * At most one entry — the one that declared {@link id} — so every lookup
	 * below resolves within the agent this provider stands for and a selection
	 * naming a different agent is simply unknown here.
	 */
	private _catalog(): readonly IAcpAgentCatalogEntry[] {
		const allowed = this._productService.sessionsAllowedAgentHostProviders;
		return allowed && !allowed.includes(this.id) ? [] : ACP_AGENT_CATALOG.filter(entry => entry.provider === this.id);
	}

	private async _createChat(chat: URI, context: URI | IAgentChatContext, options: IAgentCreateChatOptions = {}): Promise<IAgentCreateChatResult> {
		if (options.fork || options.sideChat || options.importConversation) {
			throw new Error('ACP agents cannot fork, branch, or import a conversation.');
		}
		const existing = this._entries.get(chat.toString());
		if (existing) {
			return {
				resolvedWorkingDirectory: existing.workingDirectories[0],
				provisional: existing.connection === undefined,
				providerData: existing.providerData,
			};
		}
		// A model selection outranks an agent selection: its id names an agent
		// too, and names the one whose model list the user actually chose from.
		const selection = options.model ? this._resolveModelSelection(options.model) : { agent: this._resolveCatalogEntry(options.agent), model: undefined };
		const primary = options.workingDirectories?.[0];
		if (!primary) {
			throw new Error('ACP agents require the Agent Host to provide an execution directory.');
		}
		const resolved = resolveAgentChatContext(context, chat);
		const entry: IAcpChatEntry = {
			session: resolved.configurationResource,
			chat,
			storageResource: resolved.resource,
			agent: selection.agent,
			...(selection.model ? { model: selection.model } : {}),
			workingDirectories: [primary],
		};
		entry.providerData = encodeAcpProviderData(entry);
		this._entries.set(chat.toString(), entry);
		return { resolvedWorkingDirectory: primary, provisional: true, providerData: entry.providerData };
	}

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined, context: URI | IAgentChatContext | undefined): Promise<void> {
		return this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entryForChat(chat);
			if (entry.turn) {
				throw new Error('A response is already being generated for this ACP chat.');
			}
			// The agent process is rooted at its `cwd`, so a moved working
			// directory means a new process rather than a re-rooted one — and a
			// session anchored to the directory it was opened in, which
			// `session/load` is handed alongside the id, does not survive the move.
			if (workingDirectories?.[0] && !isEqual(entry.workingDirectories[0], workingDirectories[0])) {
				await this._releaseEntry(entry);
				entry.acpSessionId = undefined;
				entry.workingDirectories = [workingDirectories[0]];
				// Published before the agent is asked for anything, because the move
				// has already happened here whether or not the send that prompted it
				// succeeds. A receipt still naming the old directory would move the
				// chat back to it on the next restore, and hand `session/load` an
				// anchor minted somewhere this chat no longer is.
				this._publishChatData(entry);
			}
			const { connection, acpSessionId } = await this._materialize(entry);
			const effectiveTurnId = turnId ?? generateUuid();
			const turn: IAcpTurnState = {
				mapper: new AcpTurnMapper(effectiveTurnId),
				startedAt: Date.now(),
				cancelRequested: false,
			};
			entry.turn = turn;
			this._fire(chat, {
				type: ActionType.ChatTurnStarted,
				turnId: effectiveTurnId,
				startedAt: new Date(turn.startedAt).toISOString(),
				message: { text: prompt, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments: [...attachments] } : {}) },
			});
			try {
				const blocks = acpPromptBlocks(prompt, attachments, resolveAgentHostInstructions(context));
				const response = await connection.prompt(acpSessionId, blocks);
				if (entry.turn !== turn) {
					return;
				}
				const previousUsage = entry.usage;
				entry.usage = response.usage ?? entry.usage;
				this._dispatch(entry, turn.mapper.closeOutstandingToolCalls(localize('acp.toolCall.turnEnded', "The agent ended the turn before this tool call finished.")));
				this._dispatch(entry, turn.mapper.mapStop(response, Date.now() - turn.startedAt, previousUsage));
				entry.turn = undefined;
			} catch (error) {
				if (entry.turn === turn) {
					this._dispatch(entry, turn.mapper.closeOutstandingToolCalls(localize('acp.toolCall.turnFailed', "The agent stopped before this tool call finished.")));
					this._dispatch(entry, turn.mapper.mapFailure(error, Date.now() - turn.startedAt));
					entry.turn = undefined;
				}
				throw error;
			}
		});
	}

	/**
	 * Replays a restored chat's transcript from the agent that still holds it.
	 *
	 * The host asks for this when it has recovered a chat from disk but has no
	 * turns for it. ACP's answer is `session/load`: the agent re-sends the whole
	 * conversation as ordinary `session/update` notifications, which run through
	 * the live mapper and the host's own reducer to become turns — see
	 * {@link AcpReplayCollector}. None of it reaches the chat as a live signal.
	 *
	 * Empty and failed are deliberately different answers here. `[]` means there
	 * is genuinely nothing to replay: the chat never reached an agent, its
	 * catalog entry is gone, or the agent cannot resume at all. Anything that
	 * merely *went wrong* throws, because the host caches a resolved empty
	 * history for the process's lifetime while leaving a rejected one
	 * retryable — answering `[]` on a transient failure would blank the
	 * conversation until the app restarts.
	 */
	private _getMessages(chat: URI, context: AgentChatOperationContext): Promise<readonly Turn[]> {
		// Queued on the chat like a send, so a replay can never interleave with a
		// turn on the same session.
		return this._sequencer.queue(chat.toString(), async () => {
			const entry = this._entries.get(chat.toString());
			const acpSessionId = entry?.acpSessionId;
			if (!entry || !acpSessionId) {
				return [];
			}
			const cwd = entry.workingDirectories[0]?.fsPath;
			if (!cwd) {
				throw new Error('The ACP agent has no execution directory.');
			}
			const existing = entry.connection;
			const connection = existing ?? await this._connect(entry, cwd);
			if (!connection.supportsLoadSession) {
				// An agent that cannot resume has no transcript to give. Nothing was
				// lost, so this is an honest empty — but do not leave a process
				// running for an answer it could not provide.
				if (!existing) {
					connection.dispose();
				}
				return [];
			}
			// The same instructions a send would inject, so the replay can take
			// back out what this connector had to put in — ACP v1 has no channel
			// that would have kept them out of the agent's transcript.
			const collector = new AcpReplayCollector(chat.toString(), acpSessionId, resolveAgentHostInstructions(context));
			try {
				const loaded = await this._replaySession(entry, acpSessionId, collector, () => connection.loadSession(acpSessionId, cwd));
				const turns = collector.finish();
				if (!turns.length) {
					// An anchor is only minted by a send, so a session that exists has
					// been spoken to and cannot honestly have nothing to replay. Silence
					// here is a replay that failed without saying so, and the difference
					// matters: the host caches a resolved empty history for the life of
					// the process, so answering `[]` would blank this conversation until
					// the app restarts, while a rejection is retried on the next open.
					throw new Error(`${entry.agent.displayName} replayed no history for session ${acpSessionId}.`);
				}
				// The session is loaded and the agent's memory is warm, so the chat
				// keeps it: the next send resumes this very session instead of
				// paying for a second process and a second replay.
				await this._adoptSession(entry, connection, acpSessionId, loaded.configOptions ?? undefined);
				return turns;
			} catch (error) {
				if (!existing) {
					connection.dispose();
				}
				throw error;
			}
		});
	}

	private async _materialize(entry: IAcpChatEntry): Promise<{ connection: AcpConnection; acpSessionId: string }> {
		if (entry.connection && entry.acpSessionId) {
			return { connection: entry.connection, acpSessionId: entry.acpSessionId };
		}
		const cwd = entry.workingDirectories[0]?.fsPath;
		if (!cwd) {
			throw new Error('The ACP agent has no execution directory.');
		}
		const connection = await this._connect(entry, cwd);
		// A chat that already ran once resumes the conversation it started rather
		// than opening a second one the agent would answer with no memory of the
		// first. Capability-gated, because an agent that never advertised
		// `loadSession` is entitled to reject the call — for those, a restored
		// chat keeps M1's behaviour and starts fresh.
		const resume = entry.acpSessionId && connection.supportsLoadSession ? entry.acpSessionId : undefined;
		let acpSessionId: string;
		let configOptions: readonly acp.SessionConfigOption[] | undefined;
		try {
			if (resume) {
				// The replay is discarded: this is a resume taken to restore the
				// *agent's* memory, and the host already holds the transcript.
				const loaded = await this._replaySession(entry, resume, undefined, () => connection.loadSession(resume, cwd));
				acpSessionId = resume;
				configOptions = loaded.configOptions ?? undefined;
			} else {
				const session = await connection.newSession(cwd);
				acpSessionId = session.sessionId;
				configOptions = session.configOptions ?? undefined;
			}
		} catch (error) {
			const methods = connection.authMethods;
			connection.dispose();
			// ACP puts sign-in before `session/new`, and an unauthenticated agent
			// fails it with a message that names no remedy (observed on the Gemini
			// CLI 0.56.0 that M1 validated against: "Gemini API key is missing or
			// not configured"). Nothing here parses that message — the agent's own
			// advertised `authMethods` supply the remedy, so this stays
			// agent-agnostic.
			throw methods.length ? new Error(`${errorText(error)} Sign in to ${entry.agent.displayName} first — it offers: ${methods.map(method => method.name).join(', ')}.`) : error;
		}
		// Both routes land here, so the chosen model is applied to a resumed
		// session exactly as it is to a new one.
		await this._adoptSession(entry, connection, acpSessionId, configOptions);
		entry.providerData = encodeAcpProviderData(entry);
		this._onDidMaterializeChat.fire({ chat: entry.chat, result: { providerData: entry.providerData }, workingDirectories: entry.workingDirectories, project: undefined });
		return { connection, acpSessionId };
	}

	/**
	 * Re-issues the chat's receipt after its durable identity changed.
	 *
	 * Everything {@link encodeAcpProviderData} carries — the agent, the model,
	 * the directory, the session anchor — is what a cold start has to rebuild
	 * this chat from. Whenever one of them changes in memory the receipt has to
	 * follow in the same breath, or a restart restores a chat that disagrees
	 * with the one the user was just using. `_materialize` publishes its own on
	 * the materialize channel, which carries the resolved directory too; this is
	 * for the changes that happen without one.
	 */
	private _publishChatData(entry: IAcpChatEntry): void {
		entry.providerData = encodeAcpProviderData(entry);
		this._onDidChangeChatData.fire({ chat: entry.chat, providerData: entry.providerData });
	}

	/** Opens a connection to the chat's catalog agent, rooted at `cwd`. */
	private _connect(entry: IAcpChatEntry, cwd: string): Promise<AcpConnection> {
		return AcpConnection.connect({
			launch: { command: entry.agent.command, args: entry.agent.args, cwd, ...(entry.agent.env ? { env: entry.agent.env } : {}) },
			clientName: this._productService.applicationName,
			clientVersion: this._productService.version,
			transportFactory: spec => this._createTransport(spec),
			handlers: {
				onSessionUpdate: notification => this._handleSessionUpdate(entry, notification),
				onRequestPermission: params => this._handlePermissionRequest(entry, params),
				onUnexpectedClose: reason => this._handleUnexpectedClose(entry, reason),
			},
		}, this._logService);
	}

	/**
	 * Takes ownership of a session the chat will keep using, whether it was just
	 * created or just resumed, and reconciles the chat's model with it.
	 */
	private async _adoptSession(entry: IAcpChatEntry, connection: AcpConnection, acpSessionId: string, configOptions: readonly acp.SessionConfigOption[] | undefined): Promise<void> {
		entry.connection = connection;
		entry.acpSessionId = acpSessionId;
		entry.configOptions = configOptions;
		await this._applyModel(entry, connection, acpSessionId);
	}

	/**
	 * Runs one `session/load`, with the replay it triggers routed away from the
	 * live chat for its whole duration.
	 *
	 * The window has to span the entire request because ACP delivers the
	 * transcript as notifications *before* answering: the last replayed update
	 * can arrive at any point up to the response.
	 */
	private async _replaySession<T>(entry: IAcpChatEntry, acpSessionId: string, collector: AcpReplayCollector | undefined, run: () => Promise<T>): Promise<T> {
		entry.load = { acpSessionId, ...(collector ? { collector } : {}) };
		try {
			return await run();
		} finally {
			entry.load = undefined;
		}
	}

	private _handleSessionUpdate(entry: IAcpChatEntry, notification: acp.SessionNotification): void {
		// A load in flight owns the channel: everything arriving is the agent
		// re-telling the past, so it must never reach `_dispatch` — that would
		// replay the whole conversation into the live chat.
		const load = entry.load;
		if (load) {
			if (notification.sessionId === load.acpSessionId) {
				load.collector?.accept(notification.update);
			}
			return;
		}
		const turn = entry.turn;
		if (!turn || (entry.acpSessionId && notification.sessionId !== entry.acpSessionId)) {
			return;
		}
		this._dispatch(entry, turn.mapper.mapSessionUpdate(notification.update));
	}

	/**
	 * Bridges an ACP permission ask onto the host's approval pipeline.
	 *
	 * The host answers with a boolean because it — not the agent — owns
	 * persistent auto-approval rules; the mapper widens that back into the
	 * agent's option set. A turn cancelled while the ask is outstanding answers
	 * `cancelled`, which ACP requires so the agent does not treat the stop as a
	 * user rejection.
	 */
	private async _handlePermissionRequest(entry: IAcpChatEntry, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const turn = entry.turn;
		if (!turn) {
			return buildAcpPermissionResponse(params.options, AcpPermissionDecision.Cancel);
		}
		const mapping = turn.mapper.mapPermissionRequest(params);
		this._dispatch(entry, mapping.actions);
		const approved = await this._pendingPermissions.registerAndFire(mapping.state.toolCallId, () => {
			this._onDidChatProgress.fire({
				kind: 'pending_confirmation',
				chat: entry.chat,
				...mapping.target,
				state: mapping.state,
			});
		}, entry);
		const decision = turn.cancelRequested
			? AcpPermissionDecision.Cancel
			: approved ? AcpPermissionDecision.Allow : AcpPermissionDecision.Reject;
		return buildAcpPermissionResponse(params.options, decision);
	}

	/**
	 * The agent process died outside a normal disposal. Fail the active turn so
	 * the chat stops looking busy, and drop the connection so the next send
	 * starts a fresh process.
	 *
	 * The session id stays for the same reason it survives a release: a crashed
	 * process did not unwrite the conversation, so the next send resumes it
	 * rather than silently forking a second one.
	 */
	private _handleUnexpectedClose(entry: IAcpChatEntry, reason: string | undefined): void {
		const message = reason ?? localize('acp.connection.closed', "The ACP agent stopped unexpectedly.");
		this._logService.warn(`[ACP] ${entry.agent.slug}: ${message}`);
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		const turn = entry.turn;
		if (turn) {
			this._dispatch(entry, turn.mapper.closeOutstandingToolCalls(message));
			this._dispatch(entry, turn.mapper.mapFailure(new Error(message), Date.now() - turn.startedAt));
			entry.turn = undefined;
		}
		entry.connection = undefined;
		entry.configOptions = undefined;
	}

	/**
	 * Points a chat at another of its agent's models.
	 *
	 * Always within this provider's one agent: a selection naming a different
	 * agent is not in this provider's catalog and {@link _resolveModelSelection}
	 * rejects it before anything is touched. Moving a chat to another agent is
	 * picking that agent's row, not re-modelling this chat — an ACP agent is a
	 * process rather than a parameter.
	 *
	 * The change is applied to the live session immediately, so the next turn
	 * honours it without a restart.
	 */
	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const entry = this._entryForChat(chat);
		const selection = this._resolveModelSelection(model);
		entry.model = selection.model;
		this._publishChatData(entry);
		if (entry.connection && entry.acpSessionId) {
			await this._applyModel(entry, entry.connection, entry.acpSessionId);
		}
	}

	/**
	 * Reconciles the chat's model with a live ACP session.
	 *
	 * Entirely generic: it looks for whatever the agent advertised as its model
	 * selector and sets the value the user chose, without knowing what any of
	 * those values mean. The catalog's declared list is a snapshot of a pinned
	 * agent version, so drift is possible — and is a warning, not a failure,
	 * because a turn on the agent's own default beats no turn at all.
	 */
	private async _applyModel(entry: IAcpChatEntry, connection: AcpConnection, acpSessionId: string): Promise<void> {
		const model = entry.model;
		// An agent that declares no models was never given one to apply.
		if (!model || !entry.agent.models) {
			return;
		}
		const option = entry.configOptions?.find(candidate => candidate.category === 'model' && candidate.type === 'select');
		if (option?.type !== 'select') {
			this._logService.warn(`[ACP] ${entry.agent.slug} advertised no model selector, so '${model}' was not applied.`);
			return;
		}
		if (option.currentValue === model) {
			return;
		}
		if (!acpSelectValues(option).includes(model)) {
			// Not a warning: an agent is entitled to advertise different value ids
			// for a session it resumed than for one it just created, and it usually
			// still means the same model. The pinned Claude adapter offers
			// `claude-fable-5[1m]` on `session/new` and reports that very session
			// back as `claude-fable-5` on `session/load` — the same model with the
			// context-window suffix resolved away. Re-setting it would be a change,
			// so the session keeps what the agent says it is running.
			this._logService.debug(`[ACP] ${entry.agent.slug} does not offer model '${model}' on this session, so it keeps '${String(option.currentValue)}'.`);
			return;
		}
		const response = await connection.setConfigOption(acpSessionId, option.id, model);
		entry.configOptions = response.configOptions;
	}

	private _changeAgent(chat: URI, agent: AgentSelection | undefined): Promise<void> {
		if (!agent) {
			return Promise.resolve();
		}
		const entry = this._entries.get(chat.toString());
		return entry && agentSelectionSlug(agent) === entry.agent.slug
			? Promise.resolve()
			: Promise.reject(new Error('The ACP agent for a chat is fixed when the chat is created.'));
	}

	private async _abort(chat: URI): Promise<void> {
		const entry = this._entryForChat(chat);
		const turn = entry.turn;
		if (turn) {
			turn.cancelRequested = true;
		}
		if (entry.connection && entry.acpSessionId) {
			await entry.connection.cancel(entry.acpSessionId);
		}
		// Resolve outstanding asks after `session/cancel` is queued so the
		// permission responses carry the cancelled outcome the spec requires.
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
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

	/**
	 * Tears a chat's live connection down while leaving the chat itself intact.
	 *
	 * The ACP session id deliberately survives. It is not connection state: it
	 * names a conversation the agent wrote down, and the receipt on disk goes on
	 * naming it long after every process started here is gone. Everything else
	 * here belongs to the process and dies with it.
	 *
	 * Clearing it was this provider's blank-history bug. The host evicts an idle
	 * session through `releaseChat` and then re-materializes it onto *this same
	 * entry* — `materializeChat` reads the receipt only when it has no entry to
	 * reuse — so a cleared anchor was never restored, and the next `getMessages`
	 * found nothing to replay and answered `[]` for a chat whose history was on
	 * screen a moment earlier. Callers that genuinely invalidate the anchor,
	 * because the conversation now belongs to another agent or another directory,
	 * clear it themselves.
	 */
	private async _releaseEntry(entry: IAcpChatEntry): Promise<void> {
		this._pendingPermissions.respondWhere(candidate => candidate === entry, false);
		if (entry.connection && entry.acpSessionId && entry.turn) {
			await entry.connection.cancel(entry.acpSessionId);
		}
		entry.connection?.dispose();
		entry.connection = undefined;
		entry.configOptions = undefined;
		entry.turn = undefined;
	}

	private _entryForChat(chat: URI): IAcpChatEntry {
		const entry = this._entries.get(chat.toString());
		if (!entry) {
			throw new Error(`Unknown ACP chat: ${chat.toString()}`);
		}
		return entry;
	}

	private _resolveCatalogEntry(agent: AgentSelection | undefined): IAcpAgentCatalogEntry {
		const catalog = this._catalog();
		const slug = agentSelectionSlug(agent);
		const entry = slug ? catalog.find(candidate => candidate.slug === slug) : catalog[0];
		if (!entry) {
			throw new Error(slug ? `Unknown ACP agent '${slug}'.` : 'No ACP agent is configured.');
		}
		return entry;
	}

	/** The catalog agent and agent-side model id a picker selection names. */
	private _resolveModelSelection(model: ModelSelection): { readonly agent: IAcpAgentCatalogEntry; readonly model: string } {
		const split = splitAcpModelId(model.id);
		const agent = split && this._catalog().find(candidate => candidate.slug === split.slug);
		if (!split || !agent) {
			throw new Error(`Unknown ACP model '${model.id}'.`);
		}
		return { agent, model: split.model };
	}

	private _dispatch(entry: IAcpChatEntry, actions: readonly ChatAction[]): void {
		for (const action of actions) {
			this._fire(entry.chat, action);
		}
	}

	private _fire(resource: URI, action: Extract<AgentSignal, { kind: 'action' }>['action']): void {
		this._onDidChatProgress.fire({ kind: 'action', resource, action });
	}
}

function normalizeWorkingDirectories(value: readonly URI[] | URI | undefined): readonly URI[] | undefined {
	return URI.isUri(value) ? [value] : value;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Every value a select config option offers.
 *
 * ACP lets an agent present its values either flat or in named groups; the
 * grouping is a display hint, so both shapes flatten to the same value set.
 */
function acpSelectValues(option: acp.SessionConfigSelect): readonly string[] {
	const groups: readonly (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[] = option.options;
	return groups.flatMap(entry => hasKey(entry, { group: true }) ? entry.options.map(value => value.value) : [entry.value]);
}

/**
 * The catalog slug an {@link AgentSelection} names, if it names one.
 *
 * Agent selections travel as protocol URI strings (`acp-agent:/<slug>`), so the
 * slug is the path segment.
 */
function agentSelectionSlug(agent: AgentSelection | undefined): string | undefined {
	if (!agent?.uri) {
		return undefined;
	}
	try {
		return URI.parse(agent.uri).path.replace(/^\//, '') || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Builds the ACP prompt blocks for one user message.
 *
 * Host instructions lead as a separate text block rather than being spliced
 * into the user's own text: ACP has no hidden-context channel in v1, and
 * mutating the user's prompt would make the transcript disagree with what the
 * model was actually shown.
 */
export function acpPromptBlocks(prompt: string, attachments: readonly MessageAttachment[] | undefined, hostInstructions: readonly string[] | undefined): readonly acp.ContentBlock[] {
	const blocks: acp.ContentBlock[] = [];
	if (hostInstructions?.length) {
		blocks.push({ type: 'text', text: hostInstructions.join('\n\n') });
	}
	blocks.push({ type: 'text', text: prompt });
	for (const attachment of attachments ?? []) {
		if (attachment.type === MessageAttachmentKind.EmbeddedResource && attachment.contentType.startsWith('image/')) {
			blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.contentType });
		} else if (attachment.type === MessageAttachmentKind.Simple && attachment.modelRepresentation) {
			blocks.push({ type: 'text', text: attachment.modelRepresentation });
		} else {
			blocks.push({ type: 'text', text: `[Attached: ${attachment.label}]` });
		}
	}
	return blocks;
}

interface IAcpProviderData {
	readonly sessionId: string;
	readonly agent: string;
	readonly model?: string;
	readonly cwd?: string;
	readonly acpSessionId?: string;
}

/**
 * The persisted receipt for a chat.
 *
 * `agent` records which catalog entry owns the chat so a later catalog change
 * cannot silently re-point old history at a different agent, `model` records
 * the choice so a reconnect re-applies it, and `acpSessionId` is carried so
 * M2's `session/load` has an anchor without a data migration. Every field past
 * the first two is optional, so older receipts stay readable as-is.
 */
export function encodeAcpProviderData(entry: { readonly session: URI; readonly agent: IAcpAgentCatalogEntry; readonly model?: string; readonly workingDirectories: readonly URI[]; readonly acpSessionId?: string }): string {
	return JSON.stringify({
		sessionId: AgentSession.id(entry.session),
		agent: entry.agent.slug,
		...(entry.model ? { model: entry.model } : {}),
		...(entry.workingDirectories[0] ? { cwd: entry.workingDirectories[0].fsPath } : {}),
		...(entry.acpSessionId ? { acpSessionId: entry.acpSessionId } : {}),
	} satisfies IAcpProviderData);
}

export function decodeAcpProviderData(value: string | undefined): IAcpProviderData | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as Partial<IAcpProviderData>;
		if (typeof parsed.sessionId !== 'string' || typeof parsed.agent !== 'string') {
			return undefined;
		}
		return {
			sessionId: parsed.sessionId,
			agent: parsed.agent,
			...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
			...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
			...(typeof parsed.acpSessionId === 'string' ? { acpSessionId: parsed.acpSessionId } : {}),
		};
	} catch {
		return undefined;
	}
}
