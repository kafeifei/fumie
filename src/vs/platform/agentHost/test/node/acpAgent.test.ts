/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as acp from '@agentclientprotocol/sdk';
import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { hasKey } from '../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IProductService } from '../../../product/common/productService.js';
import { ACP_CLAUDE_AGENT_PROVIDER_ID, AgentSession, type AgentSignal } from '../../common/agent.js';
import { readAgentModelSourceId } from '../../common/agentModelSource.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType, isChatAction, type ChatAction } from '../../common/state/sessionActions.js';
import { chatReducer } from '../../common/state/sessionReducers.js';
import { ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, TurnState, buildDefaultChatUri, type ChatState, type Turn } from '../../common/state/sessionState.js';
import { ACP_AGENT_CATALOG, AcpAgent, acpCatalogModels, acpPromptBlocks, decodeAcpProviderData, type IAcpAgentCatalogEntry } from '../../node/acp/acpAgent.js';
import type { IAcpLaunchSpec, IAcpTransport } from '../../node/acp/acpConnection.js';
import { AcpPermissionDecision, AcpTurnMapper, acpUsageDelta, buildAcpPermissionResponse, mapToolCallContent, selectAcpPermissionOption, stripAcpHostInstructions } from '../../node/acp/acpSessionMapper.js';
import { ARTIFACT_TOOLS_INSTRUCTION } from '../../node/shared/artifactServerTools.js';
import { getAcpApprovalTarget, getAcpToolDisplayName, getAcpToolName } from '../../node/acp/acpToolDisplay.js';

/**
 * The fake is a *real* ACP agent — `acp.agent(...)` from the official SDK,
 * driven by a per-test script and wired to the provider through an in-memory
 * newline-delimited JSON pair. Nothing is stubbed between the provider and the
 * protocol: the handshake, framing, request/response correlation and
 * notification ordering are all the SDK's own, so these tests fail if the
 * connector misuses the protocol, not merely if it misuses a mock.
 *
 * Mirrors `claudeSdkPipeline.test.ts`'s `FakeWarmQuery` in spirit: substitute
 * the far end, keep the pipeline real.
 */

type PromptScript = (session: IFakeAcpSession) => Promise<acp.PromptResponse>;

/** Streams a canned transcript back in answer to `session/load`. */
type ReplayScript = (session: IFakeAcpReplay) => Promise<void>;

interface IFakeAcpSession {
	readonly sessionId: string;
	readonly prompt: acp.PromptRequest;
	/** Sends one `session/update` notification. */
	update(update: acp.SessionUpdate): Promise<void>;
	/** Sends one `session/request_permission` request and awaits the outcome. */
	requestPermission(toolCall: acp.ToolCallUpdate, options?: readonly acp.PermissionOption[]): Promise<acp.RequestPermissionResponse>;
	/** Resolves once the client sends `session/cancel`. */
	readonly cancelled: Promise<void>;
}

interface IFakeAcpReplay {
	readonly sessionId: string;
	/** Sends one historical `session/update` notification. */
	update(update: acp.SessionUpdate): Promise<void>;
}

const DEFAULT_PERMISSION_OPTIONS: readonly acp.PermissionOption[] = [
	{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
	{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
	{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

interface IFakeAcpAgentOptions {
	readonly protocolVersion?: number;
	/** Makes `session/new` fail, as an unauthenticated agent's does. */
	readonly newSessionError?: string;
	readonly authMethods?: readonly acp.AuthMethod[];
	/** Session configuration options `session/new` advertises. */
	readonly configOptions?: readonly acp.SessionConfigOption[];
	/** Whether `initialize` advertises `loadSession`. Not every agent does. */
	readonly loadSession?: boolean;
	/** Makes `session/load` fail, as an agent that forgot the session would. */
	readonly loadSessionError?: string;
	/** The transcript `session/load` replays before it answers. */
	readonly replay?: ReplayScript;
}

/**
 * The `model` config option `@agentclientprotocol/claude-agent-acp@0.70.0`
 * advertises, value ids copied from a live `session/new` response.
 */
const CLAUDE_MODEL_CONFIG_OPTION: acp.SessionConfigOption = {
	id: 'model',
	name: 'Model',
	category: 'model',
	type: 'select',
	currentValue: 'default',
	options: [
		{ value: 'default', name: 'Default (recommended)', description: 'Opus (1M context)' },
		{ value: 'opus[1m]', name: 'Opus (1M context)' },
		{ value: 'claude-fable-5[1m]', name: 'Fable' },
		{ value: 'sonnet', name: 'Sonnet' },
		{ value: 'haiku', name: 'Haiku' },
	],
};

class FakeAcpAgent {
	/** Resolves when the agent starts handling a prompt turn. */
	readonly promptStarted = new DeferredPromise<void>();
	readonly newSessionRequests: acp.NewSessionRequest[] = [];
	readonly loadSessionRequests: acp.LoadSessionRequest[] = [];
	readonly initializeRequests: acp.InitializeRequest[] = [];
	readonly permissionOutcomes: acp.RequestPermissionOutcome[] = [];
	readonly cancelledSessions: string[] = [];
	readonly configOptionRequests: acp.SetSessionConfigOptionRequest[] = [];
	/** The session each `session/prompt` was addressed to. */
	readonly promptSessions: string[] = [];

	private readonly _app: acp.AgentApp;
	private readonly _cancelSignals = new Map<string, DeferredPromise<void>>();
	private _configOptions: acp.SessionConfigOption[];
	private _connection: acp.AgentConnection | undefined;

	constructor(script: PromptScript, private readonly _options: IFakeAcpAgentOptions = {}) {
		this._configOptions = [...(_options.configOptions ?? [])];
		this._app = acp.agent({ name: 'fake-acp-agent' })
			.onRequest(acp.methods.agent.initialize, ctx => {
				this.initializeRequests.push(ctx.params);
				return {
					protocolVersion: this._options.protocolVersion ?? acp.PROTOCOL_VERSION,
					agentCapabilities: { loadSession: this._options.loadSession ?? true },
					agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
					...(this._options.authMethods ? { authMethods: [...this._options.authMethods] } : {}),
				};
			})
			.onRequest(acp.methods.agent.session.new, ctx => {
				this.newSessionRequests.push(ctx.params);
				if (this._options.newSessionError) {
					// ACP's own auth-required code, the way a real agent reports it.
					throw new acp.RequestError(-32000, this._options.newSessionError);
				}
				return { sessionId: 'acp-session-1', ...(this._configOptions.length ? { configOptions: this._configOptions } : {}) };
			})
			.onRequest(acp.methods.agent.session.load, async ctx => {
				this.loadSessionRequests.push(ctx.params);
				if (this._options.loadSessionError) {
					throw new acp.RequestError(-32000, this._options.loadSessionError);
				}
				const client = ctx.client;
				const sessionId = ctx.params.sessionId;
				// The whole transcript goes out as ordinary notifications *before*
				// this request answers, which is the ordering the connector has to
				// survive: history and live streaming share one channel.
				await this._options.replay?.({
					sessionId,
					update: update => client.notify(acp.methods.client.session.update, { sessionId, update }),
				});
				return this._configOptions.length ? { configOptions: this._configOptions } : {};
			})
			.onRequest(acp.methods.agent.session.setConfigOption, ctx => {
				this.configOptionRequests.push(ctx.params);
				const { configId, value } = ctx.params;
				this._configOptions = this._configOptions.map(option => option.id === configId && option.type === 'select' && typeof value === 'string'
					? { ...option, currentValue: value }
					: option);
				return { configOptions: this._configOptions };
			})
			.onNotification(acp.methods.agent.session.cancel, ctx => {
				this.cancelledSessions.push(ctx.params.sessionId);
				this._cancelSignal(ctx.params.sessionId).complete();
			})
			.onRequest(acp.methods.agent.session.prompt, async ctx => {
				this.promptStarted.complete();
				const client = ctx.client;
				const sessionId = ctx.params.sessionId;
				this.promptSessions.push(sessionId);
				return script({
					sessionId,
					prompt: ctx.params,
					update: update => client.notify(acp.methods.client.session.update, { sessionId, update }),
					requestPermission: async (toolCall, options = DEFAULT_PERMISSION_OPTIONS) => {
						const response = await client.request(acp.methods.client.session.requestPermission, {
							sessionId,
							toolCall,
							options: [...options],
						});
						this.permissionOutcomes.push(response.outcome);
						return response;
					},
					cancelled: this._cancelSignal(sessionId).p,
				});
			});
	}

	connect(stream: acp.Stream): void {
		this._connection = this._app.connect(stream);
	}

	dispose(): void {
		this._connection?.close();
		this._connection = undefined;
		for (const signal of this._cancelSignals.values()) {
			signal.complete();
		}
		this._cancelSignals.clear();
		if (!this.promptStarted.isSettled) {
			this.promptStarted.complete();
		}
	}

	private _cancelSignal(sessionId: string): DeferredPromise<void> {
		let signal = this._cancelSignals.get(sessionId);
		if (!signal) {
			signal = new DeferredPromise<void>();
			this._cancelSignals.set(sessionId, signal);
		}
		return signal;
	}
}

/**
 * One conversation, as the updates an agent emits for it.
 *
 * Used twice over: streamed live from `session/prompt`, and replayed as
 * history from `session/load`. Sharing the fixture is what makes the two
 * comparable, which is the property session restore has to have.
 */
const REPLAYED_PROMPT = 'read the file';
const REPLAYED_TURN: readonly acp.SessionUpdate[] = [
	{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking.' }, messageId: 'thought-1' },
	{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading ' }, messageId: 'm1' },
	{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the file.' }, messageId: 'm1' },
	{ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read src/a.ts', kind: 'read', status: 'pending', rawInput: { path: '/workspace/src/a.ts' } },
	{ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] },
	{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'm2' },
];

/**
 * Replays {@link REPLAYED_TURN} as history, led by the user's own message.
 *
 * That leading `user_message_chunk` is the only record a replay carries of who
 * asked; live streaming never needs it, because the host opened the turn.
 */
const replayOneTurn: ReplayScript = async session => {
	await session.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: REPLAYED_PROMPT } });
	for (const update of REPLAYED_TURN) {
		await session.update(update);
	}
};

/**
 * The instructions Fumie attaches to every ACP prompt, verbatim.
 *
 * The first is `agentHostInstructions` from product.json; the second is the
 * artifact instruction the host appends when that tool is enabled. Together
 * they are the exact pair found leading every restored user bubble in the real
 * `acp:/7ae4f3d3-…` transcript, which is what these fixtures reproduce.
 */
const HOST_INSTRUCTIONS: readonly string[] = [
	'You are a coding agent inside Fumie, an agent-first desktop coding environment built on Code OSS. Fumie may host you in its Agents window, terminal chat, or editor inline chat. In the Agents window, Fumie manages the visible session, workspace or isolated worktree, Files/Changes, permissions, and Settings > Models; agent and model are separate choices. Your harness owns its model loop and tools. Trust observed Fumie UI and session state, follow surface-specific instructions, use only exposed controls, and never claim a UI or configuration change without observing it.',
	ARTIFACT_TOOLS_INSTRUCTION,
];

/**
 * How the agent replays a prompt this host sent.
 *
 * `acpPromptBlocks` leads with one text block holding the instructions joined
 * by a blank line, then the user's own block. The agent, never told the first
 * block was context rather than conversation, writes both into its transcript
 * and hands both back as `user_message_chunk`s of one message — the shape
 * probed off the pinned adapter against the real session.
 */
function replayHostPrompt(session: IFakeAcpReplay, typed: string, messageId: string): Promise<void> {
	return session.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: HOST_INSTRUCTIONS.join('\n\n') }, messageId })
		.then(() => typed
			? session.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: typed }, messageId })
			: undefined);
}

/** The chat context a history read carries, with the host's instructions on it. */
function historyContext(session: URI, chat: URI, hostInstructions?: readonly string[]) {
	return { resource: chat, configurationResource: session, ...(hostInstructions ? { hostInstructions } : {}) };
}

/** A pair of ACP streams wired back to back over in-memory byte pipes. */
function streamPair(): { readonly client: acp.Stream; readonly agent: acp.Stream } {
	const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
	const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
	return {
		client: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
		agent: acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
	};
}

class TestAcpAgent extends AcpAgent {
	readonly launches: IAcpLaunchSpec[] = [];

	/** Drives the catalog's Claude entry, the only provider the catalog declares. */
	constructor(private readonly _fake: FakeAcpAgent) {
		super(ACP_CLAUDE_AGENT_PROVIDER_ID, new NullLogService(), {
			applicationName: 'fumie-test',
			version: '1.0.0',
		} as IProductService);
	}

	protected override _createTransport(spec: IAcpLaunchSpec): Promise<IAcpTransport> {
		this.launches.push(spec);
		const pair = streamPair();
		this._fake.connect(pair.agent);
		return Promise.resolve({
			stream: pair.client,
			description: `${spec.command} ${spec.args.join(' ')}`,
			onDidClose: Event.None,
			dispose: () => this._fake.dispose(),
		});
	}
}

function createAgent(script: PromptScript): { agent: TestAcpAgent; fake: FakeAcpAgent } {
	const fake = new FakeAcpAgent(script);
	return { agent: new TestAcpAgent(fake), fake };
}

async function createAcpChat(agent: TestAcpAgent, model?: string) {
	const session = AgentSession.uri(agent.id, 'session-1');
	const chat = URI.parse(buildDefaultChatUri(session));
	const result = await agent.chats.createChat(chat, session, {
		workingDirectories: [URI.file('/workspace')],
		...(model ? { model: { id: model } } : {}),
	});
	return { session, chat, result };
}

/**
 * A chat restored from its persisted receipt, exactly as a fresh app launch
 * does it: no in-memory entry, nothing spawned, just the recorded anchor.
 */
async function restoreAcpChat(agent: TestAcpAgent, acpSessionId: string | undefined = 'acp-session-1') {
	const session = AgentSession.uri(agent.id, 'session-1');
	const chat = URI.parse(buildDefaultChatUri(session));
	await agent.materializeChat(chat, session, JSON.stringify({
		sessionId: AgentSession.id(session),
		agent: 'claude-acp',
		cwd: '/workspace',
		...(acpSessionId ? { acpSessionId } : {}),
	}));
	return { session, chat };
}

/**
 * Folds a live action stream into turns the way the Agent Host does.
 *
 * Lets a replayed transcript be compared against the one the very same updates
 * produced while streaming, which is the property M2 actually promises: reopen
 * a chat and see what you saw live.
 */
function turnsFromLiveActions(chat: URI, actions: readonly ChatAction[]): readonly Turn[] {
	let state: ChatState = { resource: chat.toString(), title: '', status: SessionStatus.Idle, modifiedAt: new Date(0).toISOString(), turns: [] };
	for (const action of actions) {
		state = chatReducer(state, action);
	}
	return state.turns;
}

/** The part of a turn ACP can vouch for; ids and timings are not comparable. */
function summarizeTurn(turn: Turn) {
	return {
		message: turn.message.text,
		state: turn.state,
		text: turn.responseParts.flatMap(part => part.kind === ResponsePartKind.Markdown ? [part.content] : []),
		reasoning: turn.responseParts.flatMap(part => part.kind === ResponsePartKind.Reasoning ? [part.content] : []),
		toolCalls: turn.responseParts.flatMap(part => part.kind === ResponsePartKind.ToolCall ? [{
			toolCallId: part.toolCall.toolCallId,
			displayName: part.toolCall.displayName,
			status: part.toolCall.status,
		}] : []),
	};
}

/** The provider's own record for a chat — the agent and model a picker cannot show. */
function chatEntry(agent: TestAcpAgent, chat: URI) {
	const entry = (agent as unknown as { _entries: Map<string, { agent: { slug: string }; model?: string; providerData?: string; connection?: unknown; acpSessionId?: string }> })._entries.get(chat.toString());
	assert.ok(entry, `no ACP entry for ${chat.toString()}`);
	return entry;
}

/** The `session/set_config_option` payloads an agent received, minus protocol noise. */
function configOptionCalls(fake: FakeAcpAgent) {
	return fake.configOptionRequests.map(request => ({ sessionId: request.sessionId, configId: request.configId, value: request.value }));
}

/** Collects every signal the provider emits, auto-answering permission asks. */
function collectSignals(agent: TestAcpAgent, respond: ((signal: Extract<AgentSignal, { kind: 'pending_confirmation' }>) => void) | undefined) {
	const signals: AgentSignal[] = [];
	const permissions: Extract<AgentSignal, { kind: 'pending_confirmation' }>[] = [];
	const subscription = agent.onDidChatProgress(signal => {
		signals.push(signal);
		if (signal.kind === 'pending_confirmation') {
			permissions.push(signal);
			respond?.(signal);
		}
	});
	return {
		signals,
		permissions,
		dispose: () => subscription.dispose(),
		actionTypes: () => signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action.type),
		actions: () => signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action),
	};
}

suite('AcpAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('spawns the catalog agent and streams text, tool calls and a permission ask into Fumie signals', async () => {
		const { agent, fake } = createAgent(async session => {
			await session.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning.' }, messageId: 'thought-1' });
			await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing ' }, messageId: 'msg-1' });
			await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the file.' }, messageId: 'msg-1' });
			await session.update({
				sessionUpdate: 'tool_call',
				toolCallId: 'tool-1',
				title: 'Write src/new.ts',
				kind: 'edit',
				status: 'pending',
				rawInput: { path: '/workspace/src/new.ts' },
				locations: [{ path: '/workspace/src/new.ts' }],
			});
			await session.requestPermission({ toolCallId: 'tool-1', title: 'Write src/new.ts', kind: 'edit' });
			await session.update({
				sessionUpdate: 'tool_call_update',
				toolCallId: 'tool-1',
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'wrote 3 lines' } }],
			});
			await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'msg-2' });
			return { stopReason: 'end_turn', usage: { totalTokens: 15, inputTokens: 12, outputTokens: 3 } };
		});
		const collected = collectSignals(agent, signal => agent.respondToPermissionRequest(signal.state.toolCallId, true));
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'create the file', [URI.file('/workspace')], undefined, 'turn-1');

			const complete = collected.actions().find(action => action.type === ActionType.ChatToolCallComplete);
			const usage = collected.actions().find(action => action.type === ActionType.ChatUsage);
			assert.deepStrictEqual({
				launch: agent.launches.map(spec => ({ command: spec.command, args: spec.args, cwd: spec.cwd })),
				// Only the capabilities this client declares; the SDK fills the rest with defaults.
				clientCapabilities: fake.initializeRequests.map(request => ({ fs: request.clientCapabilities?.fs, terminal: request.clientCapabilities?.terminal })),
				sessionCwd: fake.newSessionRequests.map(request => request.cwd),
				permissions: collected.permissions.map(signal => ({
					kind: signal.permissionKind,
					path: signal.permissionPath,
					status: signal.state.status,
					displayName: signal.state.displayName,
				})),
				outcomes: fake.permissionOutcomes,
				actions: collected.actionTypes(),
				toolResult: complete?.type === ActionType.ChatToolCallComplete ? complete.result : undefined,
				usage: usage?.type === ActionType.ChatUsage ? usage.usage : undefined,
			}, {
				// Nothing was selected, so the chat gets the first catalog entry.
				launch: [{ command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.70.0'], cwd: '/workspace' }],
				clientCapabilities: [{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }],
				sessionCwd: ['/workspace'],
				permissions: [{
					kind: 'write',
					path: '/workspace/src/new.ts',
					status: ToolCallStatus.PendingConfirmation,
					displayName: 'Write src/new.ts',
				}],
				// The narrowest allow the agent offered, never `allow_always`.
				outcomes: [{ outcome: 'selected', optionId: 'allow-once' }],
				actions: [
					ActionType.ChatTurnStarted,
					ActionType.ChatResponsePart,
					ActionType.ChatReasoning,
					ActionType.ChatResponsePart,
					ActionType.ChatDelta,
					ActionType.ChatDelta,
					ActionType.ChatToolCallStart,
					ActionType.ChatToolCallDelta,
					ActionType.ChatToolCallComplete,
					ActionType.ChatResponsePart,
					ActionType.ChatDelta,
					ActionType.ChatUsage,
					ActionType.ChatTurnComplete,
				],
				toolResult: {
					success: true,
					pastTenseMessage: 'Write src/new.ts',
					content: [{ type: 'text', text: 'wrote 3 lines' }],
				},
				usage: { inputTokens: 12, outputTokens: 3 },
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('Stop cancels the ACP session and reports the turn as cancelled', async () => {
		const { agent, fake } = createAgent(async session => {
			await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' }, messageId: 'msg-1' });
			await session.cancelled;
			return { stopReason: 'cancelled' };
		});
		const collected = collectSignals(agent, undefined);
		try {
			const { chat } = await createAcpChat(agent);
			const send = agent.chats.sendMessage(chat, 'do something long', [URI.file('/workspace')], undefined, 'turn-1');
			await fake.promptStarted.p;
			await agent.chats.abort(chat, chat);
			await send;

			assert.deepStrictEqual({
				cancelledSessions: fake.cancelledSessions,
				actions: collected.actionTypes(),
			}, {
				cancelledSessions: ['acp-session-1'],
				actions: [
					ActionType.ChatTurnStarted,
					ActionType.ChatResponsePart,
					ActionType.ChatDelta,
					ActionType.ChatTurnCancelled,
				],
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('Stop while a permission ask is outstanding answers cancelled, not rejected', async () => {
		const { agent, fake } = createAgent(async session => {
			await session.update({
				sessionUpdate: 'tool_call',
				toolCallId: 'tool-1',
				title: 'Run the test suite',
				kind: 'execute',
				status: 'pending',
			});
			await session.requestPermission({ toolCallId: 'tool-1', title: 'Run the test suite', kind: 'execute' });
			return { stopReason: 'cancelled' };
		});
		const asked = new DeferredPromise<void>();
		const collected = collectSignals(agent, () => asked.complete());
		try {
			const { chat } = await createAcpChat(agent);
			const send = agent.chats.sendMessage(chat, 'run the tests', [URI.file('/workspace')], undefined, 'turn-1');
			await asked.p;
			await agent.chats.abort(chat, chat);
			await send;

			assert.deepStrictEqual({
				permissionTargets: collected.permissions.map(signal => ({ kind: signal.permissionKind, path: signal.permissionPath })),
				outcomes: fake.permissionOutcomes,
				cancelledSessions: fake.cancelledSessions,
				lastAction: collected.actionTypes().at(-1),
			}, {
				// No `shellLanguage`: ACP never says which shell ran the command, and
				// guessing one would let a terminal rule auto-approve unanalysed input.
				permissionTargets: [{ kind: 'shell', path: undefined }],
				outcomes: [{ outcome: 'cancelled' }],
				cancelledSessions: ['acp-session-1'],
				lastAction: ActionType.ChatTurnCancelled,
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a denied permission ask fails the tool call without ending the turn', async () => {
		const { agent, fake } = createAgent(async session => {
			await session.update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Delete build output', kind: 'delete', status: 'pending' });
			await session.requestPermission({ toolCallId: 'tool-1', title: 'Delete build output', kind: 'delete' });
			await session.update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }] });
			return { stopReason: 'end_turn' };
		});
		const collected = collectSignals(agent, signal => agent.respondToPermissionRequest(signal.state.toolCallId, false));
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'delete it', [URI.file('/workspace')], undefined, 'turn-1');

			const complete = collected.actions().find(action => action.type === ActionType.ChatToolCallComplete);
			assert.deepStrictEqual({
				outcomes: fake.permissionOutcomes,
				result: complete?.type === ActionType.ChatToolCallComplete ? complete.result : undefined,
				lastAction: collected.actionTypes().at(-1),
			}, {
				outcomes: [{ outcome: 'selected', optionId: 'reject-once' }],
				result: {
					success: false,
					pastTenseMessage: 'Delete build output failed',
					content: [{ type: 'text', text: 'Permission denied' }],
					error: { message: 'Permission denied' },
				},
				lastAction: ActionType.ChatTurnComplete,
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a tool call left open when the turn ends is completed rather than stranded', async () => {
		const { agent } = createAgent(async session => {
			await session.update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Search the workspace', kind: 'search', status: 'in_progress' });
			return { stopReason: 'cancelled' };
		});
		const collected = collectSignals(agent, undefined);
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'search', [URI.file('/workspace')], undefined, 'turn-1');

			const complete = collected.actions().find(action => action.type === ActionType.ChatToolCallComplete);
			assert.deepStrictEqual({
				actions: collected.actionTypes(),
				success: complete?.type === ActionType.ChatToolCallComplete ? complete.result.success : undefined,
			}, {
				actions: [
					ActionType.ChatTurnStarted,
					ActionType.ChatToolCallStart,
					// Auto-confirmed: the agent never asked, so the connector moves the
					// call to `running` itself or the completion would be a no-op.
					ActionType.ChatToolCallReady,
					ActionType.ChatToolCallComplete,
					ActionType.ChatTurnCancelled,
				],
				success: false,
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('declares no fork or peer chat, and keeps the host approval schema', async () => {
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		try {
			const resolved = await agent.resolveChatConfig({ config: {} });
			assert.deepStrictEqual({
				provider: agent.getDescriptor().provider,
				// One catalog agent behind this provider row, so the row names it.
				displayName: agent.getDescriptor().displayName,
				description: agent.getDescriptor().description,
				capabilities: agent.getDescriptor().capabilities,
				models: agent.models.get().map(model => model.id),
				steering: typeof (agent as { setPendingMessages?: unknown }).setPendingMessages,
				properties: Object.keys(resolved.schema.properties),
				values: resolved.values,
			}, {
				provider: 'acp-claude',
				displayName: 'Claude (ACPv1)',
				description: 'Claude Code via the Agent Client Protocol adapter, using this machine\'s own Claude sign-in',
				capabilities: {},
				models: [
					'claude-acp/default',
					'claude-acp/opus[1m]',
					'claude-acp/claude-fable-5[1m]',
					'claude-acp/sonnet',
					'claude-acp/haiku',
				],
				steering: 'undefined',
				properties: [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions],
				values: { [SessionConfigKey.AutoApprove]: 'default' },
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a catalog agent is its own provider row, named after the agent it starts', async () => {
		const claude = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' })));
		try {
			assert.deepStrictEqual({
				provider: claude.getDescriptor().provider,
				displayName: claude.getDescriptor().displayName,
			}, { provider: 'acp-claude', displayName: 'Claude (ACPv1)' });
		} finally {
			await claude.shutdown();
			claude.dispose();
		}
	});

	test('projects its own catalog entry into picker models', async () => {
		const claude = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' })));
		try {
			assert.deepStrictEqual(claude.models.get().map(model => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				// The source id is what heads the picker group with the agent's name.
				source: readAgentModelSourceId(model),
			})), [
				{ provider: 'acp-claude', id: 'claude-acp/default', name: 'Default (Opus)', source: 'claude-acp' },
				{ provider: 'acp-claude', id: 'claude-acp/opus[1m]', name: 'Opus (1M context)', source: 'claude-acp' },
				{ provider: 'acp-claude', id: 'claude-acp/claude-fable-5[1m]', name: 'Fable', source: 'claude-acp' },
				{ provider: 'acp-claude', id: 'claude-acp/sonnet', name: 'Sonnet', source: 'claude-acp' },
				{ provider: 'acp-claude', id: 'claude-acp/haiku', name: 'Haiku', source: 'claude-acp' },
			]);
		} finally {
			await claude.shutdown();
			claude.dispose();
		}
	});

	test('an agent that declares no models still gets one picker row', () => {
		// No shipped entry is modelless, so the entry is a literal here: an agent
		// that advertises nothing before a session exists keeps the single row that
		// says the agent decides, because a picker that requires a model would
		// otherwise refuse to select it at all.
		const modelless: IAcpAgentCatalogEntry = {
			slug: 'modelless',
			provider: 'acp-modelless',
			displayName: 'Modelless (ACPv1)',
			description: 'An agent that owns its own model choice',
			command: 'modelless-acp',
			args: [],
		};
		assert.deepStrictEqual(acpCatalogModels([modelless]).map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			source: readAgentModelSourceId(model),
		})), [
			{ provider: 'acp-modelless', id: 'modelless/default', name: 'Agent default', source: 'modelless' },
		]);
	});

	test('a model selection picks the agent that owns it and is applied to the new session', async () => {
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { configOptions: [CLAUDE_MODEL_CONFIG_OPTION] });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await createAcpChat(agent, 'claude-acp/claude-fable-5[1m]');
			assert.deepStrictEqual({ agent: chatEntry(agent, chat).agent.slug, model: chatEntry(agent, chat).model }, { agent: 'claude-acp', model: 'claude-fable-5[1m]' });

			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual(agent.launches.map(spec => spec.command), ['npx']);
			assert.deepStrictEqual(configOptionCalls(fake), [{ sessionId: 'acp-session-1', configId: 'model', value: 'claude-fable-5[1m]' }]);

			const other = AgentSession.uri(agent.id, 'session-9');
			await assert.rejects(
				agent.chats.createChat(URI.parse(buildDefaultChatUri(other)), other, { workingDirectories: [URI.file('/workspace')], model: { id: 'not-an-agent/sonnet' } }),
				/Unknown ACP model 'not-an-agent\/sonnet'/);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('leaves the session alone when the chosen model is already the one it is running', async () => {
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { configOptions: [CLAUDE_MODEL_CONFIG_OPTION] });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await createAcpChat(agent, 'claude-acp/default');
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			// The agent already reported `default` as its current value, so there is
			// nothing to set — the round trip is skipped, not sent and ignored.
			assert.deepStrictEqual(configOptionCalls(fake), []);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('changing model within one agent reconfigures the live session instead of restarting it', async () => {
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { configOptions: [CLAUDE_MODEL_CONFIG_OPTION] });
		const agent = new TestAcpAgent(fake);
		try {
			const { session, chat } = await createAcpChat(agent, 'claude-acp/default');
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			await agent.chats.changeModel(chat, { id: 'claude-acp/sonnet' }, session);

			assert.deepStrictEqual(configOptionCalls(fake), [{ sessionId: 'acp-session-1', configId: 'model', value: 'sonnet' }]);
			assert.deepStrictEqual({
				agent: chatEntry(agent, chat).agent.slug,
				model: chatEntry(agent, chat).model,
				// One agent process throughout: the session was reconfigured, not replaced.
				launches: agent.launches.length,
				connected: chatEntry(agent, chat).connection !== undefined,
			}, { agent: 'claude-acp', model: 'sonnet', launches: 1, connected: true });
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('rejects a model belonging to another agent, leaving the running one untouched', async () => {
		// Each provider offers only its own agent's models, so a selection naming a
		// different agent can only be stale or hand-written. Switching agent is
		// picking the other row, not re-modelling this chat.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { configOptions: [CLAUDE_MODEL_CONFIG_OPTION] });
		const agent = new TestAcpAgent(fake);
		try {
			const { session, chat } = await createAcpChat(agent, 'claude-acp/sonnet');
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			await assert.rejects(
				agent.chats.changeModel(chat, { id: 'other-acp-agent/default' }, session),
				/Unknown ACP model 'other-acp-agent\/default'/);

			assert.deepStrictEqual({
				agent: chatEntry(agent, chat).agent.slug,
				model: chatEntry(agent, chat).model,
				connected: chatEntry(agent, chat).connection !== undefined,
				launches: agent.launches.map(spec => spec.command),
				providerData: decodeAcpProviderData(chatEntry(agent, chat).providerData),
			}, {
				agent: 'claude-acp',
				model: 'sonnet',
				connected: true,
				launches: ['npx'],
				providerData: { sessionId: 'session-1', agent: 'claude-acp', model: 'sonnet', acpSessionId: 'acp-session-1', cwd: '/workspace' },
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('runs on the agent\'s own model when the declared snapshot has drifted from what it advertises', async () => {
		// The catalog is a snapshot of a pinned agent version. Both ways it can go
		// stale — the selector gone, or the value gone — leave the turn running.
		const silent = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		const narrowed = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			configOptions: [{ ...CLAUDE_MODEL_CONFIG_OPTION, options: [{ value: 'default', name: 'Default (recommended)' }] }],
		});
		const withoutSelector = new TestAcpAgent(silent);
		const withoutValue = new TestAcpAgent(narrowed);
		try {
			for (const [agent, fake] of [[withoutSelector, silent], [withoutValue, narrowed]] as const) {
				const { chat } = await createAcpChat(agent, 'claude-acp/haiku');
				await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');
				assert.deepStrictEqual(configOptionCalls(fake), []);
			}
		} finally {
			await withoutSelector.shutdown();
			withoutSelector.dispose();
			await withoutValue.shutdown();
			withoutValue.dispose();
		}
	});

	test('launches the catalog entry the agent selection names, and rejects an unknown slug', async () => {
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		try {
			const session = AgentSession.uri(agent.id, 'session-2');
			const chat = URI.parse(buildDefaultChatUri(session));
			await agent.chats.createChat(chat, session, {
				workingDirectories: [URI.file('/workspace')],
				agent: { uri: 'acp-agent:/claude-acp' },
			});
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			const unknown = URI.parse(buildDefaultChatUri(AgentSession.uri(agent.id, 'session-3')));
			await assert.rejects(
				agent.chats.createChat(unknown, AgentSession.uri(agent.id, 'session-3'), {
					workingDirectories: [URI.file('/workspace')],
					agent: { uri: 'acp-agent:/not-a-real-agent' },
				}),
				/Unknown ACP agent 'not-a-real-agent'/);

			assert.deepStrictEqual(agent.launches.map(spec => ({ command: spec.command, args: spec.args })), [
				{ command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.70.0'] },
			]);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('every catalog entry is a pure data row with a unique slug and its own provider', () => {
		assert.deepStrictEqual(ACP_AGENT_CATALOG.map(entry => ({
			slug: entry.slug,
			provider: entry.provider,
			displayName: entry.displayName,
			command: entry.command,
			args: [...entry.args],
			// No entry injects credentials: each agent uses its own sign-in.
			env: entry.env,
			// Model ids are the agent's own config-option values, copied verbatim.
			models: entry.models?.map(model => model.id),
		})), [
			{
				slug: 'claude-acp', provider: 'acp-claude', displayName: 'Claude (ACPv1)',
				command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.70.0'], env: undefined,
				models: ['default', 'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku'],
			},
		]);
		assert.strictEqual(new Set(ACP_AGENT_CATALOG.map(entry => entry.slug)).size, ACP_AGENT_CATALOG.length);
		// One provider per entry is what gives each agent its own picker row.
		assert.strictEqual(new Set(ACP_AGENT_CATALOG.map(entry => entry.provider)).size, ACP_AGENT_CATALOG.length);
	});

	test('records the catalog agent and ACP session id in provider data, and restores it cold', async () => {
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		try {
			const { session, chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');
			const providerData = decodeAcpProviderData((await agent.getChatMetadata(chat, session)) && (agent as unknown as { _entries: Map<string, { providerData?: string }> })._entries.get(chat.toString())?.providerData);

			// A cold restore (no in-memory entry) must recover identity from the receipt alone.
			const cold = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' })));
			const restored = await cold.materializeChat(chat, session, JSON.stringify(providerData));
			const metadata = await cold.getChatMetadata(chat, session, JSON.stringify(providerData));
			await cold.shutdown();
			cold.dispose();

			assert.deepStrictEqual({
				providerData,
				restoredDirectory: restored?.resolvedWorkingDirectory?.toString(),
				metadataDirectories: metadata?.workingDirectories?.map(directory => directory.toString()),
			}, {
				providerData: { sessionId: 'session-1', agent: 'claude-acp', cwd: '/workspace', acpSessionId: 'acp-session-1' },
				restoredDirectory: 'file:///workspace',
				metadataDirectories: ['file:///workspace'],
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('minting a session hands the host a receipt that names it', async () => {
		// The anchor is minted long after the chat was created, so nothing the
		// host already wrote down mentions it. If this publish were ever lost,
		// every restore would find an anchor-less receipt and answer an honest
		// but wrong `[]` — a conversation that blanks and stays blank.
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		const published: string[] = [];
		const subs = [
			agent.onDidMaterializeChat(e => e.result?.providerData !== undefined && published.push(e.result.providerData)),
			agent.onDidChangeChatData(e => e.providerData !== undefined && published.push(e.providerData)),
		];
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual(published.map(blob => decodeAcpProviderData(blob)?.acpSessionId), ['acp-session-1']);
		} finally {
			subs.forEach(subscription => subscription.dispose());
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a chat restored from the receipt its own send published replays instead of starting over', async () => {
		// The restart path, end to end and without a real disk: whatever the
		// running agent handed the host is the only thing the cold one is given.
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		let receipt: string | undefined;
		const subscription = agent.onDidMaterializeChat(e => { receipt = e.result?.providerData ?? receipt; });
		try {
			const { session, chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			const cold = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: replayOneTurn }));
			try {
				await cold.materializeChat(chat, session, receipt);
				const replayed = await cold.chats.getMessages(chat, historyContext(session, chat));

				assert.deepStrictEqual(replayed.map(turn => turn.message.text), [REPLAYED_PROMPT]);
			} finally {
				await cold.shutdown();
				cold.dispose();
			}
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a chat that moved directory says so before the move can fail', async () => {
		// The move is already true here whatever the agent does next, so the
		// receipt cannot wait on a send: a start that fails in the new directory
		// would otherwise leave a receipt naming the old one, and the next
		// restore would quietly put the chat back where it no longer belongs.
		const { agent } = createAgent(() => Promise.reject(new Error('the agent could not start here')));
		const published: string[] = [];
		const subscription = agent.onDidChangeChatData(e => e.providerData !== undefined && published.push(e.providerData));
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1').catch(() => undefined);
			await agent.chats.sendMessage(chat, 'again', [URI.file('/elsewhere')], undefined, 'turn-2').catch(() => undefined);

			assert.deepStrictEqual(published.map(blob => {
				const decoded = decodeAcpProviderData(blob);
				return { cwd: decoded?.cwd, acpSessionId: decoded?.acpSessionId };
			}), [{ cwd: '/elsewhere', acpSessionId: undefined }]);
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('replays a loaded session into the transcript live streaming produced', async () => {
		// The same conversation twice: once streamed as it happens, once replayed
		// by `session/load`. M2's whole promise is that the two agree.
		const live = new TestAcpAgent(new FakeAcpAgent(async session => {
			for (const update of REPLAYED_TURN) {
				await session.update(update);
			}
			return { stopReason: 'end_turn' };
		}));
		const collected = collectSignals(live, undefined);
		const restored = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: replayOneTurn }));
		try {
			const { chat } = await createAcpChat(live);
			await live.chats.sendMessage(chat, REPLAYED_PROMPT, [URI.file('/workspace')], undefined, 'turn-1');
			const streamed = turnsFromLiveActions(chat, collected.actions().filter(isChatAction));

			const { chat: restoredChat } = await restoreAcpChat(restored);
			const replayed = await restored.chats.getMessages(restoredChat, restoredChat);

			assert.deepStrictEqual(replayed.map(summarizeTurn), streamed.map(summarizeTurn));
			assert.deepStrictEqual(replayed.map(summarizeTurn), [{
				message: REPLAYED_PROMPT,
				state: TurnState.Complete,
				text: ['Reading the file.', 'Done.'],
				reasoning: ['Checking.'],
				toolCalls: [{ toolCallId: 'tool-1', displayName: 'Read src/a.ts', status: ToolCallStatus.Completed }],
			}]);
			// ACP replays no clock, so a replayed turn declines to invent one
			// rather than claiming the conversation happened just now.
			assert.deepStrictEqual(replayed.map(turn => ({ startedAt: turn.startedAt, duration: turn.duration })), [{ startedAt: undefined, duration: undefined }]);
		} finally {
			collected.dispose();
			await live.shutdown();
			live.dispose();
			await restored.shutdown();
			restored.dispose();
		}
	});

	test('a replay never reaches the chat as a live signal', async () => {
		const agent = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: replayOneTurn }));
		const collected = collectSignals(agent, undefined);
		try {
			const { chat } = await restoreAcpChat(agent);
			const replayed = await agent.chats.getMessages(chat, chat);

			assert.strictEqual(replayed.length, 1);
			// History arrives on the same channel as live streaming. Firing it at
			// the renderer would duplicate every row the restore just drew.
			assert.deepStrictEqual(collected.signals, []);
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a restored chat shows what the user typed, not the instructions the host attached to it', async () => {
		// Regression: restored bubbles must not include the host preamble
		// as though the user had typed it, once per turn.
		const agent = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			replay: async session => {
				await replayHostPrompt(session, '请检查示例项目的设置页面', 'msg-1');
				await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking at the settings page.' }, messageId: 'a1' });
				await replayHostPrompt(session, '页面加载后是否保留选项', 'msg-2');
				await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the saved options.' }, messageId: 'a2' });
			},
		}));
		try {
			const { session, chat } = await restoreAcpChat(agent);
			const replayed = await agent.chats.getMessages(chat, historyContext(session, chat, HOST_INSTRUCTIONS));

			assert.deepStrictEqual(replayed.map(turn => turn.message.text), [
				'请检查示例项目的设置页面',
				'页面加载后是否保留选项',
			]);
			// The answers are untouched: only the host's own words come back out.
			assert.deepStrictEqual(replayed.map(summarizeTurn).map(turn => turn.text), [
				['Looking at the settings page.'],
				['Checking the saved options.'],
			]);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a prompt that was nothing but host instructions is not a turn at all', async () => {
		const agent = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			replay: async session => {
				await replayHostPrompt(session, 'read the file', 'msg-1');
				await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'a1' });
				// Instructions with nothing typed after them and no answer: an
				// exchange the user never had. An empty bubble is not a truer
				// account of it than no bubble.
				await replayHostPrompt(session, '', 'msg-2');
			},
		}));
		try {
			const { session, chat } = await restoreAcpChat(agent);
			const replayed = await agent.chats.getMessages(chat, historyContext(session, chat, HOST_INSTRUCTIONS));

			assert.deepStrictEqual(replayed.map(turn => turn.message.text), ['read the file']);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('an answer is kept even when the prompt it answered scrubs away to nothing', async () => {
		const agent = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			replay: async session => {
				await replayHostPrompt(session, '', 'msg-1');
				await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Understood.' }, messageId: 'a1' });
			},
		}));
		try {
			const { session, chat } = await restoreAcpChat(agent);
			const replayed = await agent.chats.getMessages(chat, historyContext(session, chat, HOST_INSTRUCTIONS));

			// The agent spoke, so the turn stands. Dropping it would delete the
			// only thing in it that was ever real.
			assert.deepStrictEqual(replayed.map(turn => ({ message: turn.message.text, text: summarizeTurn(turn).text })), [
				{ message: '', text: ['Understood.'] },
			]);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a chat whose host attached no instructions replays every word exactly as it was said', async () => {
		// Nothing is matched against a pattern here: an agent whose prompts the
		// host never added to has nothing to take back out, so the same replay
		// comes through whole. This is what keeps the rule from guessing.
		const agent = new TestAcpAgent(new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			replay: async session => {
				await replayHostPrompt(session, 'read the file', 'msg-1');
				await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' }, messageId: 'a1' });
			},
		}));
		try {
			const { session, chat } = await restoreAcpChat(agent);
			const replayed = await agent.chats.getMessages(chat, historyContext(session, chat));

			assert.deepStrictEqual(replayed.map(turn => turn.message.text), [`${HOST_INSTRUCTIONS.join('\n\n')}read the file`]);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('sending in a restored chat resumes its session instead of starting a new one', async () => {
		const fake = new FakeAcpAgent(async session => {
			await session.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh reply' }, messageId: 'm9' });
			return { stopReason: 'end_turn' };
		}, { replay: replayOneTurn });
		const agent = new TestAcpAgent(fake);
		const collected = collectSignals(agent, undefined);
		try {
			const { chat } = await restoreAcpChat(agent);
			await agent.chats.sendMessage(chat, 'and now this', [URI.file('/workspace')], undefined, 'turn-2');

			assert.deepStrictEqual({
				loaded: fake.loadSessionRequests.map(request => ({ sessionId: request.sessionId, cwd: request.cwd })),
				newSessions: fake.newSessionRequests.length,
				promptSessions: fake.promptSessions,
				deltas: collected.actions().flatMap(action => action.type === ActionType.ChatDelta ? [action.content] : []),
			}, {
				loaded: [{ sessionId: 'acp-session-1', cwd: '/workspace' }],
				// The conversation is continued, not started over: the agent keeps
				// everything it knew, so the next answer is in context.
				newSessions: 0,
				promptSessions: ['acp-session-1'],
				// The replay that came with the resume was discarded — only the new
				// turn is streamed, because the renderer already holds the history.
				deltas: ['fresh reply'],
			});
		} finally {
			collected.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('an agent that cannot resume answers no history and starts a fresh session', async () => {
		// The Gemini CLI 0.56 M1 validated against was this agent: it advertised no
		// `loadSession`, so there is genuinely nothing to replay. An honest empty,
		// not a swallowed failure.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { loadSession: false, replay: replayOneTurn });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await restoreAcpChat(agent);
			assert.deepStrictEqual(await agent.chats.getMessages(chat, chat), []);

			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');
			assert.deepStrictEqual({
				loaded: fake.loadSessionRequests.length,
				newSessions: fake.newSessionRequests.length,
			}, { loaded: 0, newSessions: 1 });
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a failed replay is reported, never answered with an empty history', async () => {
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { loadSessionError: 'No such session.' });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await restoreAcpChat(agent);
			// The host caches a resolved empty history for the life of the process
			// but leaves a rejected one retryable, so answering `[]` on a failure
			// would blank the conversation until the app restarts.
			await assert.rejects(agent.chats.getMessages(chat, chat), /No such session/);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('an idle-evicted chat replays the same history when it is opened again', async () => {
		// The field bug, reduced to its sequence: open, idle-evict, open again.
		// Eviction releases the chat rather than deleting it, and the host then
		// re-materializes it onto the entry it already has — so a release that
		// forgot the ACP session id left the second open with nothing to load and
		// blanked a conversation that had just rendered.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: replayOneTurn });
		const agent = new TestAcpAgent(fake);
		try {
			const { session, chat } = await restoreAcpChat(agent);
			const first = await agent.chats.getMessages(chat, chat);

			await agent.chats.releaseChat(chat, session);
			assert.deepStrictEqual({
				connected: chatEntry(agent, chat).connection !== undefined,
				// The process is gone; the conversation it was holding is not.
				anchor: chatEntry(agent, chat).acpSessionId,
			}, { connected: false, anchor: 'acp-session-1' });

			const second = await agent.chats.getMessages(chat, chat);

			assert.deepStrictEqual(second.map(summarizeTurn), first.map(summarizeTurn));
			assert.deepStrictEqual(second.map(summarizeTurn), [{
				message: REPLAYED_PROMPT,
				state: TurnState.Complete,
				text: ['Reading the file.', 'Done.'],
				reasoning: ['Checking.'],
				toolCalls: [{ toolCallId: 'tool-1', displayName: 'Read src/a.ts', status: ToolCallStatus.Completed }],
			}]);
			// Turn ids are derived from the session, not minted, so the host sees the
			// same conversation restored rather than a second one appended.
			assert.deepStrictEqual(second.map(turn => turn.id), first.map(turn => turn.id));
			assert.deepStrictEqual({
				// A real second `session/load` against a genuinely restarted process.
				loaded: fake.loadSessionRequests.map(request => request.sessionId),
				launches: agent.launches.length,
			}, { loaded: ['acp-session-1', 'acp-session-1'], launches: 2 });
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a session that replays nothing has failed to replay, and says so instead of answering empty', async () => {
		// This agent answers `session/load` without replaying a single update. The
		// anchor being set means a send already happened, so an empty transcript
		// cannot be the truth — and `[]` would be cached for the life of the
		// process, making a momentary failure look like a permanently blank chat.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: undefined });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await restoreAcpChat(agent);
			await assert.rejects(agent.chats.getMessages(chat, chat), /replayed no history/);
			// Rejecting leaves it retryable, and each retry is a real attempt.
			await assert.rejects(agent.chats.getMessages(chat, chat), /replayed no history/);
			assert.deepStrictEqual({
				loaded: fake.loadSessionRequests.length,
				// The process spawned for a replay that failed is not left running.
				connected: chatEntry(agent, chat).connection !== undefined,
			}, { loaded: 2, connected: false });
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a chat that moved to another directory starts a new session instead of resuming the old one', async () => {
		// The anchor survives a release, but not a move: `session/load` is given a
		// working directory alongside the id, and this conversation was not opened
		// in the new one.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { replay: replayOneTurn });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await createAcpChat(agent);
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');
			await agent.chats.sendMessage(chat, 'hello again', [URI.file('/elsewhere')], undefined, 'turn-2');

			assert.deepStrictEqual({
				newSessions: fake.newSessionRequests.map(request => request.cwd),
				loaded: fake.loadSessionRequests.length,
			}, { newSessions: ['/workspace', '/elsewhere'], loaded: 0 });
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a chat that never reached an agent has an empty history, not a failure', async () => {
		const { agent } = createAgent(() => Promise.resolve({ stopReason: 'end_turn' }));
		try {
			const { chat } = await createAcpChat(agent);
			assert.deepStrictEqual(await agent.chats.getMessages(chat, chat), []);

			const unknown = URI.parse(buildDefaultChatUri(AgentSession.uri(agent.id, 'session-404')));
			assert.deepStrictEqual(await agent.chats.getMessages(unknown, unknown), []);
			// Nothing to replay means nothing to start: no agent was spawned.
			assert.strictEqual(agent.launches.length, 0);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('refuses an agent that answers the handshake with a protocol version it does not implement', async () => {
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), { protocolVersion: acp.PROTOCOL_VERSION + 1 });
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await createAcpChat(agent);
			await assert.rejects(
				agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1'),
				/ACP protocol version/);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('names the agent-advertised sign-in methods when session creation fails unauthenticated', async () => {
		// The shape an unauthenticated ACP agent really produces: `initialize`
		// succeeds and advertises auth methods, then `session/new` fails with a
		// message that names no remedy.
		const fake = new FakeAcpAgent(() => Promise.resolve({ stopReason: 'end_turn' }), {
			newSessionError: 'API key is missing or not configured.',
			authMethods: [
				{ id: 'oauth-personal', name: 'Log in with your account' },
				{ id: 'api-key', name: 'API key' },
			],
		});
		const agent = new TestAcpAgent(fake);
		try {
			const { chat } = await createAcpChat(agent, 'claude-acp/default');
			await assert.rejects(
				agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1'),
				/API key is missing or not configured\. Sign in to Claude \(ACPv1\) first — it offers: Log in with your account, API key\./);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});
});

suite('acpSessionMapper', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('auto-confirms a tool call the agent never asked about', () => {
		const mapper = new AcpTurnMapper('turn-1');
		const actions = [
			...mapper.mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read config', kind: 'read', status: 'pending', rawInput: { path: '/w/a.ts' } }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }),
		];
		const ready = actions.find(action => action.type === ActionType.ChatToolCallReady);
		assert.deepStrictEqual({
			types: actions.map(action => action.type),
			confirmed: ready?.type === ActionType.ChatToolCallReady ? ready.confirmed : undefined,
			toolInput: ready?.type === ActionType.ChatToolCallReady ? ready.toolInput : undefined,
		}, {
			types: [
				ActionType.ChatToolCallStart,
				ActionType.ChatToolCallDelta,
				ActionType.ChatToolCallReady,
				ActionType.ChatToolCallComplete,
			],
			confirmed: ToolCallConfirmationReason.NotNeeded,
			toolInput: '{"path":"/w/a.ts"}',
		});
	});

	test('does not auto-confirm a tool call the host is already confirming', () => {
		const mapper = new AcpTurnMapper('turn-1');
		mapper.mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Run tests', kind: 'execute', status: 'pending' });
		const mapping = mapper.mapPermissionRequest({ sessionId: 's', toolCall: { toolCallId: 'tool-1' }, options: [...DEFAULT_PERMISSION_OPTIONS] });
		const after = mapper.mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' });

		assert.deepStrictEqual({
			synthesizedStart: mapping.actions.map(action => action.type),
			confirmationTitle: mapping.state.confirmationTitle,
			target: mapping.target,
			afterAsk: after.map(action => action.type),
		}, {
			// The tool call already existed, so no synthetic start is produced.
			synthesizedStart: [],
			confirmationTitle: 'Run in terminal?',
			target: { permissionKind: 'shell' },
			afterAsk: [],
		});
	});

	test('synthesizes a tool call start when a permission ask is the first thing the agent sends', () => {
		const mapper = new AcpTurnMapper('turn-1');
		const mapping = mapper.mapPermissionRequest({
			sessionId: 's',
			toolCall: { toolCallId: 'tool-9', title: 'Fetch docs', kind: 'fetch' },
			options: [...DEFAULT_PERMISSION_OPTIONS],
		});
		assert.deepStrictEqual({
			actions: mapping.actions.map(action => action.type),
			toolName: mapping.state.toolName,
			displayName: mapping.state.displayName,
			target: mapping.target,
		}, {
			actions: [ActionType.ChatToolCallStart],
			toolName: 'fetch',
			displayName: 'Fetch docs',
			target: { permissionKind: 'url' },
		});
	});

	test('starts a new response part per ACP message id and reopens after a tool call', () => {
		const mapper = new AcpTurnMapper('turn-1');
		const actions = [
			...mapper.mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm1' }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' }, messageId: 'm1' }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' }, messageId: 'm2' }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Think', kind: 'think', status: 'pending' }),
			...mapper.mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'd' }, messageId: 'm2' }),
			// The host owns the user's message; echoing it back would duplicate it.
			...mapper.mapSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ignored' } }),
		];
		assert.deepStrictEqual(actions.map(action => action.type === ActionType.ChatDelta
			? `delta:${action.partId}:${action.content}`
			: action.type === ActionType.ChatResponsePart ? `part:${hasKey(action.part, { id: true }) ? action.part.id : ''}` : action.type), [
			'part:turn-1:text:0',
			'delta:turn-1:text:0:a',
			'delta:turn-1:text:0:b',
			'part:turn-1:text:1',
			'delta:turn-1:text:1:c',
			ActionType.ChatToolCallStart,
			'part:turn-1:text:2',
			'delta:turn-1:text:2:d',
		]);
	});

	test('ignores session updates this milestone does not consume instead of inventing transcript entries', () => {
		const mapper = new AcpTurnMapper('turn-1');
		const ignored: acp.SessionUpdate[] = [
			{ sessionUpdate: 'plan', entries: [{ content: 'Step', priority: 'high', status: 'pending' }] },
			{ sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
			{ sessionUpdate: 'available_commands_update', availableCommands: [] },
			{ sessionUpdate: 'usage_update', used: 10, size: 100 },
		];
		assert.deepStrictEqual(ignored.flatMap(update => mapper.mapSessionUpdate(update)), []);
	});

	test('maps a host allow onto the narrowest allow option the agent offered', () => {
		const onlyAlways: readonly acp.PermissionOption[] = [
			{ optionId: 'always', name: 'Always', kind: 'allow_always' },
			{ optionId: 'never', name: 'Never', kind: 'reject_always' },
		];
		assert.deepStrictEqual({
			allow: selectAcpPermissionOption(DEFAULT_PERMISSION_OPTIONS, AcpPermissionDecision.Allow),
			reject: selectAcpPermissionOption(DEFAULT_PERMISSION_OPTIONS, AcpPermissionDecision.Reject),
			cancel: buildAcpPermissionResponse(DEFAULT_PERMISSION_OPTIONS, AcpPermissionDecision.Cancel),
			allowFallback: selectAcpPermissionOption(onlyAlways, AcpPermissionDecision.Allow),
			rejectFallback: selectAcpPermissionOption(onlyAlways, AcpPermissionDecision.Reject),
			noOptions: buildAcpPermissionResponse([], AcpPermissionDecision.Allow),
		}, {
			allow: 'allow-once',
			reject: 'reject-once',
			cancel: { outcome: { outcome: 'cancelled' } },
			allowFallback: 'always',
			rejectFallback: 'never',
			noOptions: { outcome: { outcome: 'cancelled' } },
		});
	});

	test('differences ACP cumulative usage into per-turn usage and survives a counter reset', () => {
		const first: acp.Usage = { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 };
		const second: acp.Usage = { totalTokens: 40, inputTokens: 25, outputTokens: 15, cachedReadTokens: 6 };
		const reset: acp.Usage = { totalTokens: 3, inputTokens: 2, outputTokens: 1 };
		assert.deepStrictEqual({
			firstTurn: acpUsageDelta(undefined, first),
			secondTurn: acpUsageDelta(first, second),
			afterReset: acpUsageDelta(second, reset),
			absent: acpUsageDelta(first, undefined),
			unchanged: acpUsageDelta(second, second),
		}, {
			firstTurn: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
			secondTurn: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 4 },
			afterReset: { inputTokens: 2, outputTokens: 1 },
			absent: undefined,
			unchanged: undefined,
		});
	});

	test('degrades tool content Fumie cannot represent structurally instead of dropping it silently', () => {
		assert.deepStrictEqual(mapToolCallContent([
			{ type: 'content', content: { type: 'text', text: 'plain' } },
			{ type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' },
			// Terminals need the terminal capability this client does not advertise.
			{ type: 'terminal', terminalId: 'term-1' },
		]), [
			{ type: 'text', text: 'plain' },
			{ type: 'text', text: '/w/a.ts (+3 -2)' },
		]);
	});

	test('takes back only the instruction text the host says it added', () => {
		const [preamble, artifacts] = HOST_INSTRUCTIONS;
		// The whole injected block: what is left is the blank line that joined
		// the two instructions, which is why a scrubbed-to-blank block is dropped
		// rather than concatenated onto the user's text.
		assert.strictEqual(stripAcpHostInstructions(HOST_INSTRUCTIONS.join('\n\n'), HOST_INSTRUCTIONS).trim(), '');
		// Mixed: real words keep their place around the instruction.
		assert.strictEqual(stripAcpHostInstructions(`before ${preamble} after`, HOST_INSTRUCTIONS), 'before  after');
		// An instruction the host has stopped sending is not recognised, and
		// survives as text rather than being guessed at.
		assert.strictEqual(stripAcpHostInstructions(HOST_INSTRUCTIONS.join('\n\n'), [preamble]), `\n\n${artifacts}`);
		// Nothing declared, nothing touched.
		assert.strictEqual(stripAcpHostInstructions(preamble, undefined), preamble);
		assert.strictEqual(stripAcpHostInstructions(preamble, []), preamble);
	});
});

suite('acpToolDisplay', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes every ACP tool kind to a host permission kind', () => {
		const kinds: acp.ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
		assert.deepStrictEqual(kinds.map(kind => getAcpApprovalTarget(kind, [{ path: '/w/a.ts' }]).permissionKind), [
			'read', 'write', 'write', 'write', 'read', 'shell', 'custom-tool', 'url', 'custom-tool', 'custom-tool',
		]);
	});

	test('only forwards a path target for path-shaped kinds', () => {
		assert.deepStrictEqual({
			edit: getAcpApprovalTarget('edit', [{ path: '/w/a.ts' }]),
			execute: getAcpApprovalTarget('execute', [{ path: '/w/a.ts' }]),
			unknownKind: getAcpApprovalTarget(undefined, [{ path: '/w/a.ts' }]),
			noLocation: getAcpApprovalTarget('edit', []),
		}, {
			edit: { permissionKind: 'write', permissionPath: '/w/a.ts' },
			execute: { permissionKind: 'shell' },
			unknownKind: { permissionKind: 'custom-tool' },
			noLocation: { permissionKind: 'write' },
		});
	});

	test('prefers the agent title for display and the agent name for telemetry', () => {
		assert.deepStrictEqual({
			titled: getAcpToolDisplayName('execute', 'Run npm test'),
			untitled: getAcpToolDisplayName('execute', '   '),
			named: getAcpToolName('execute', 'run_shell_command'),
			unnamed: getAcpToolName('execute', null),
		}, {
			titled: 'Run npm test',
			untitled: 'Run command',
			named: 'run_shell_command',
			unnamed: 'execute',
		});
	});

	test('leads the prompt with host instructions instead of rewriting the user message', () => {
		assert.deepStrictEqual(acpPromptBlocks('fix the bug', undefined, ['Hosted inside Fumie.']), [
			{ type: 'text', text: 'Hosted inside Fumie.' },
			{ type: 'text', text: 'fix the bug' },
		]);
		assert.deepStrictEqual(acpPromptBlocks('fix the bug', undefined, undefined), [
			{ type: 'text', text: 'fix the bug' },
		]);
	});
});
