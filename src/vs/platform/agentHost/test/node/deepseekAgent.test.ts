/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { zstdCompressSync } from 'zlib';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { NullLogService } from '../../../log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { AgentSession, AgentSignal, DEEPSEEK_AGENT_PROVIDER_ID, type IAgentChatMetadata, type IAgentCreateChatOptions } from '../../common/agent.js';
import { AHP_SESSION_NOT_FOUND, ProtocolError } from '../../common/state/sessionProtocol.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { buildDefaultChatUri } from '../../common/state/sessionState.js';
import { DeepSeekAgent } from '../../node/deepseek/deepseekAgent.js';
import { DeepSeekProviderRoute, buildDeepSeekPersona, type IDeepSeekAgent, type IDeepSeekAgentHandle, type IDeepSeekContext, type IDeepSeekEvent, type IDeepSeekHarness, type IDeepSeekMessage, type IDeepSeekSdkService, type IDeepSeekSession, type IDeepSeekSessionHeader } from '../../node/deepseek/deepseekSdkService.js';

/** The creation stamp every session the fake harness stores carries. */
const SESSION_CREATED_AT = 1_787_724_176_661;

// #region durable session-log fixtures
//
// The provider describes a cold session by reading the harness's own stored
// log, so these build that file the way the harness's JSONL backend does:
// `<root>/<project-key>/<id>/session.jsonl.zstd`, holding a header record and
// then the session's events as newline-delimited JSON, zstd-framed.
//
// Two framings occur in the wild, and the provider must read both. The current
// writer gives the header a frame of its own and then appends one frame per
// batch. An older writer — the one that re-encoded a session when it was
// relocated to a new working directory — packed the header and every record
// into a single frame. Both are the same JSONL; only the frame boundaries
// differ, and the harness's own reader accepts only the first.

/** The store's per-session artifact name. */
const SESSION_LOG_NAME = 'session.jsonl.zstd';

/** Temp session stores this suite created, removed after each test. */
const tempSessionStores: string[] = [];

function createTempSessionsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'deepseek-sessions-'));
	tempSessionStores.push(root);
	return root;
}

/**
 * The header record as the backend serializes it — `cwd` at the top level, not
 * nested under `meta`.
 */
function headerLine(id: string, cwd: string | undefined, createdAt = SESSION_CREATED_AT): string {
	return JSON.stringify({ type: 'session', version: 0, id, createdAt, ...(cwd === undefined ? {} : { cwd }), delegationDepth: 0 });
}

/** A handful of records of the shape a real log opens with. */
function eventLines(id: string): readonly string[] {
	return [
		JSON.stringify({ type: 'permission/preset', seq: 0, time: SESSION_CREATED_AT, data: { preset: 'workspace-write' } }),
		JSON.stringify({ type: 'sandbox/mode', seq: 1, time: SESSION_CREATED_AT, data: { mode: 'workspace-write' } }),
		JSON.stringify({ type: 'agent/created', seq: 2, time: SESSION_CREATED_AT, data: { session: id } }),
	];
}

/** The current layout: the header alone in frame 0, then one frame per batch. */
function currentLayoutLog(id: string, cwd: string | undefined, createdAt = SESSION_CREATED_AT): Buffer {
	return Buffer.concat([
		zstdCompressSync(Buffer.from(headerLine(id, cwd, createdAt) + '\n')),
		zstdCompressSync(Buffer.from(eventLines(id).join('\n') + '\n')),
	]);
}

/** The legacy layout: header and every record share one frame. */
function legacyLayoutLog(id: string, cwd: string | undefined, createdAt = SESSION_CREATED_AT): Buffer {
	return zstdCompressSync(Buffer.from([headerLine(id, cwd, createdAt), ...eventLines(id)].join('\n') + '\n'));
}

/**
 * A log a hard kill tore mid-append: the header frame landed whole, the frame
 * after it did not. What the session did is lost; what it *is* survives.
 */
function tornTailLog(id: string, cwd: string | undefined): Buffer {
	const events = zstdCompressSync(Buffer.from(eventLines(id).join('\n') + '\n'));
	return Buffer.concat([
		zstdCompressSync(Buffer.from(headerLine(id, cwd) + '\n')),
		events.subarray(0, Math.max(1, events.length >> 1)),
	]);
}

/** A log torn before its header line ever completed — nothing to describe. */
function tornHeaderLog(id: string, cwd: string | undefined): Buffer {
	return zstdCompressSync(Buffer.from(headerLine(id, cwd) + '\n')).subarray(0, 12);
}

/**
 * The backend's project-directory key: path separators collapse to `-`, unsafe
 * code units escape to `~XXXX`, and the whole thing is wrapped in `--`.
 */
function projectKey(cwd: string): string {
	let readable = '';
	let separatorRun = false;
	for (const character of cwd) {
		if (character === '/' || character === '\\' || character === ':') {
			if (!separatorRun) {
				readable += '-';
			}
			separatorRun = true;
		} else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
			readable += character;
			separatorRun = false;
		} else {
			readable += '~' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${readable.replace(/^-+/, '') || 'root'}--`;
}

/** Write one session's stored log, returning its path. */
function storeSessionLog(sessionsRoot: string, cwd: string | undefined, id: string, bytes: Buffer): string {
	const dir = join(sessionsRoot, cwd === undefined ? '_no-cwd' : projectKey(cwd), id);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, SESSION_LOG_NAME);
	writeFileSync(path, bytes);
	return path;
}

// #endregion

/** DeepSeek rows as they arrive from the renderer BYOK catalog: `<vendor>/<group>/<id>`. */
// allow-any-unicode-next-line
const BYOK_DEEPSEEK_FLASH_ID = 'customendpoint/Example/deepseek/deepseek-v4-flash';
// allow-any-unicode-next-line
const BYOK_DEEPSEEK_PRO_ID = 'customendpoint/Example/deepseek/deepseek-v4-pro';
// allow-any-unicode-next-line

/** The message shape {@link FakeDeepSeekHarness.createUserMessage} hands to the agent. */
interface IFakeDeepSeekMessage {
	readonly text: string;
}

/** One recorded `agents.create` call, normalized out of the untyped options record. */
interface IFakeDeepSeekCreation {
	readonly sessionId: string;
	readonly cwd: string;
	readonly provider: string;
	readonly model: string;
}

class FakeDeepSeekSession implements IDeepSeekSession {
	private readonly _replies: string[] = [];

	constructor(readonly header: IDeepSeekSessionHeader) { }

	get id(): string {
		return this.header.id;
	}

	/** Appends one assistant reply, as the harness does when a step completes. */
	reply(text: string): void {
		this._replies.push(text);
	}

	get events(): readonly IDeepSeekEvent[] {
		return this._replies.map((text, index) => ({
			type: 'assistant/message',
			seq: index + 1,
			data: { message: { content: [{ type: 'text', text }] } },
		}));
	}

	deriveMessages(): readonly IDeepSeekMessage[] {
		return this._replies.map(text => ({ role: 'assistant', content: [{ type: 'text', text }] }));
	}
}

class FakeDeepSeekAgent implements IDeepSeekAgent {
	readonly status = 'idle';
	readonly prompts: string[] = [];
	readonly cancellations: string[] = [];

	private _turn: Promise<void> | undefined;

	constructor(
		readonly session: FakeDeepSeekSession,
		private readonly _turnImpl: (agent: FakeDeepSeekAgent, prompt: string) => Promise<void>,
	) { }

	get id(): string {
		return this.session.id;
	}

	followup(message: unknown): void {
		const prompt = (message as IFakeDeepSeekMessage).text;
		this.prompts.push(prompt);
		this._turn = this._turnImpl(this, prompt);
	}

	cancel(cause: string): void {
		this.cancellations.push(cause);
	}

	async whenIdle(): Promise<void> {
		await this._turn;
	}
}

class FakeDeepSeekHarness implements IDeepSeekHarness {
	readonly creations: IFakeDeepSeekCreation[] = [];
	/** Every agent ever attached, including ones already disposed. */
	readonly agents: FakeDeepSeekAgent[] = [];
	readonly policies: { readonly agentId: string; readonly policy: string }[] = [];
	readonly disposedAgentIds: string[] = [];
	resumeCount = 0;
	/** Drives the single turn every created agent runs; answers nothing by default. */
	onFollowup: (agent: FakeDeepSeekAgent, prompt: string) => Promise<void> = async () => { };

	/**
	 * The harness's durable session store: written once at creation and never
	 * dropped when an agent handle goes away. `_live` is the far smaller set of
	 * sessions currently attached in-process — the distinction the provider must
	 * respect, since idle eviction empties `_live` while leaving this intact.
	 */
	private readonly _persisted = new Map<string, FakeDeepSeekSession>();
	private readonly _live = new Set<FakeDeepSeekAgent>();
	private readonly _listeners = new Map<string, (...args: unknown[]) => unknown>();

	/**
	 * Creating a session materializes its durable log, and the provider's cold
	 * describe reads that file rather than asking this harness — so the fake has
	 * to actually write it.
	 */
	constructor(private readonly _sessionsRoot: string) { }

	readonly ctx: IDeepSeekContext = {
		get: () => undefined,
		agents: {
			create: options => this._create(options),
			resume: options => this._resume(options),
			get: id => this._liveAgent(id),
		},
		sessions: {
			get: id => this._liveAgent(id)?.session,
			list: () => [...this._live].map(agent => agent.session),
		},
		approval: {
			setPolicy: (agent, policy) => { this.policies.push({ agentId: agent.id, policy }); },
		},
		on: (name, listener) => {
			this._listeners.set(name, listener);
			return () => { this._listeners.delete(name); };
		},
	};

	/** The session ids the durable store would still list after a restart. */
	get persistedSessionIds(): readonly string[] {
		return [...this._persisted.keys()];
	}

	/** The session ids with an agent attached in this process right now. */
	get liveSessionIds(): readonly string[] {
		return [...this._live].map(agent => agent.id);
	}

	createUserMessage(text: string): unknown {
		return { text } satisfies IFakeDeepSeekMessage;
	}

	/** Raises an `approval/request` the way the booted harness would. */
	async requestApproval(agentId: string, toolName: string, callId = 'call-1'): Promise<unknown> {
		const listener = this._listeners.get('approval/request');
		assert.ok(listener, 'expected the agent to subscribe to approval/request');
		return listener({ agent: { id: agentId }, toolName, callId }, () => Promise.resolve('deferred'));
	}

	/**
	 * Appends one `tool/call` the way the harness's scheduler does before it
	 * dispatches (and therefore before it asks for approval).
	 */
	announceToolCall(agentId: string, callId: string, toolName: string, input: Record<string, unknown>): void {
		const listener = this._listeners.get('session/event');
		assert.ok(listener, 'expected the agent to subscribe to session/event');
		listener({ id: agentId }, { type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(input) } });
	}

	private async _create(options: Record<string, unknown>): Promise<IDeepSeekAgentHandle> {
		const agentOptions = options.agentOptions as { readonly provider: string; readonly model: string };
		const sessionId = String(options.sessionId);
		// `agents.create` takes the cwd as a creation option under `meta`; the
		// durable header the harness then stamps carries it at the top level.
		const cwd = (options.meta as { readonly cwd: string }).cwd;
		this.creations.push({ sessionId, cwd, provider: agentOptions.provider, model: agentOptions.model });
		const session = new FakeDeepSeekSession({ id: sessionId, createdAt: SESSION_CREATED_AT, cwd });
		this._persisted.set(sessionId, session);
		storeSessionLog(this._sessionsRoot, cwd, sessionId, currentLayoutLog(sessionId, cwd));
		return this._attach(session);
	}

	/** Re-attaches an agent to a stored session, as a cold resume does. */
	private async _resume(options: Record<string, unknown>): Promise<IDeepSeekAgentHandle> {
		this.resumeCount++;
		const session = this._persisted.get(String(options.resumeSessionId));
		if (!session) {
			throw new Error('No DeepSeek session to resume');
		}
		return this._attach(session);
	}

	private _attach(session: FakeDeepSeekSession): IDeepSeekAgentHandle {
		const agent = new FakeDeepSeekAgent(session, (created, prompt) => this.onFollowup(created, prompt));
		this.agents.push(agent);
		this._live.add(agent);
		return {
			agent,
			dispose: async () => {
				// Releasing a handle detaches the agent; the stored session stays.
				this._live.delete(agent);
				this.disposedAgentIds.push(agent.id);
			},
		};
	}

	private _liveAgent(id: string): FakeDeepSeekAgent | undefined {
		return [...this._live].find(agent => agent.id === id);
	}
}

class FakeDeepSeekSdkService implements IDeepSeekSdkService {
	declare readonly _serviceBrand: undefined;
	readonly sessionsRoot = createTempSessionsRoot();
	readonly harness = new FakeDeepSeekHarness(this.sessionsRoot);

	getHarness(): Promise<IDeepSeekHarness> { return Promise.resolve(this.harness); }
	canLoadWithoutDownload(): Promise<boolean> { return Promise.resolve(true); }
	close(): Promise<void> { return Promise.resolve(); }
}

/**
 * Passing an existing `sdk` reuses one harness across two agents, which is what
 * a restart looks like from the harness's side: the stored sessions survive, the
 * provider's in-memory bookkeeping does not.
 */
function createAgent(models: readonly IByokLmModelInfo[] = [], sdk = new FakeDeepSeekSdkService()): { agent: DeepSeekAgent; sdk: FakeDeepSeekSdkService } {
	const environment = { userHome: URI.file('/home/test') } as INativeEnvironmentService;
	return { agent: new DeepSeekAgent(sdk, environment, new NullLogService(), byokRegistryWith(models)), sdk };
}

/** A renderer BYOK catalog with one DeepSeek row, enough to resume a session. */
const DEEPSEEK_BYOK_MODELS: readonly IByokLmModelInfo[] = [
	{ vendor: 'customendpoint', id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', modelIdentifier: BYOK_DEEPSEEK_FLASH_ID },
];

/**
 * An {@link IByokLmBridgeRegistry} whose serving window already published
 * `models` — the only source the agent's picker rows come from.
 */
function byokRegistryWith(models: readonly IByokLmModelInfo[]): IByokLmBridgeRegistry {
	return {
		_serviceBrand: undefined,
		register: () => Disposable.None,
		getModels: () => models,
		getServingConnection: () => undefined,
		onDidChangeModels: () => Disposable.None,
	};
}

/**
 * Describe a stored session by id, the way a cold re-entry does: nothing live
 * in the provider, only the session URI the host registered.
 */
function describeStoredSession(agent: DeepSeekAgent, id: string): Promise<IAgentChatMetadata | undefined> {
	const session = AgentSession.uri(DEEPSEEK_AGENT_PROVIDER_ID, id);
	return agent.getChatMetadata(URI.parse(buildDefaultChatUri(session)), session, undefined);
}

/** The fields of a describe worth asserting on. */
function describedFields(metadata: IAgentChatMetadata | undefined) {
	return metadata && {
		startTime: metadata.startTime,
		modifiedTime: metadata.modifiedTime,
		workingDirectories: metadata.workingDirectories?.map(directory => directory.fsPath),
	};
}

async function createDeepSeekChat(agent: DeepSeekAgent, options: IAgentCreateChatOptions = {}) {
	const session = AgentSession.uri(DEEPSEEK_AGENT_PROVIDER_ID, 'session-1');
	const chat = URI.parse(buildDefaultChatUri(session));
	const created = await agent.chats.createChat(chat, session, options);
	return { session, chat, providerData: created?.providerData };
}

/**
 * Runs one turn in which the harness announces each of `calls` and then asks
 * for approval on it, denying every confirmation the way a client would, and
 * returns the host-only auto-approval fields of the emitted signals.
 */
async function collectPermissionRequests(calls: readonly { readonly toolName: string; readonly input: Record<string, unknown> }[]) {
	const { agent, sdk } = createAgent();
	const requests: { toolName: string; permissionKind: string | undefined; permissionPath: string | undefined; shellLanguage: string | undefined; toolInput: unknown }[] = [];
	const subscription = agent.onDidChatProgress(signal => {
		if (signal.kind !== 'pending_confirmation') {
			return;
		}
		requests.push({
			toolName: signal.state.toolName,
			permissionKind: signal.permissionKind,
			permissionPath: signal.permissionPath,
			shellLanguage: signal.shellLanguage,
			toolInput: signal.state.toolInput,
		});
		agent.respondToPermissionRequest(signal.state.toolCallId, false);
	});
	try {
		const { chat } = await createDeepSeekChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_DEEPSEEK_FLASH_ID } });
		sdk.harness.onFollowup = async created => {
			for (let index = 0; index < calls.length; index++) {
				const callId = `call-${index + 1}`;
				sdk.harness.announceToolCall(created.id, callId, calls[index].toolName, calls[index].input);
				await sdk.harness.requestApproval(created.id, calls[index].toolName, callId);
			}
		};
		await agent.chats.sendMessage(chat, 'do the thing', [URI.file('/workspace')]);
		return requests;
	} finally {
		subscription.dispose();
		await agent.shutdown();
		agent.dispose();
	}
}

suite('DeepSeekAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		for (const root of tempSessionStores) {
			rmSync(root, { recursive: true, force: true });
		}
		tempSessionStores.length = 0;
	});

	test('includes product host instructions in the native system persona', () => {
		const instruction = 'Fumie owns the Agents window and Settings > Models.';
		const persona = buildDeepSeekPersona(instruction);
		assert.ok(persona.includes(instruction));
		assert.ok(persona.includes('{{model}}'));
		assert.ok(persona.includes('{{cwd}}'));
		assert.ok(buildDeepSeekPersona(undefined).includes('hosted inside Fumie'));
	});

	test('uses the unified host approval schema and migrates legacy permission modes', async () => {
		const { agent } = createAgent();
		try {
			const defaults = await agent.resolveChatConfig({ config: {} });
			const automatic = await agent.resolveChatConfig({ config: { permissionMode: 'auto' } });
			const yolo = await agent.resolveChatConfig({ config: { permissionMode: 'yolo' } });
			assert.deepStrictEqual({
				properties: Object.keys(defaults.schema.properties),
				defaults: defaults.values,
				automatic: automatic.values,
				yolo: yolo.values,
			}, {
				properties: [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions],
				defaults: { [SessionConfigKey.AutoApprove]: 'default' },
				automatic: { [SessionConfigKey.AutoApprove]: 'assisted' },
				yolo: { [SessionConfigKey.AutoApprove]: 'autoApprove' },
			});
		} finally {
			agent.dispose();
		}
	});

	test('the picker rows preserve the renderer BYOK catalog', () => {
		const empty = createAgent();
		const populated = createAgent([
			{ vendor: 'customendpoint', id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', modelIdentifier: 'customendpoint/Example/deepseek/deepseek-v4-pro', maxContextWindowTokens: 128_000 },
			{ vendor: 'customendpoint', id: 'claude-opus-4-6', modelIdentifier: 'customendpoint/Example/claude-opus-4-6' },
			{ vendor: 'customendpoint', id: 'voyage/voyage-4', modelIdentifier: 'customendpoint/Example/voyage/voyage-4' },
		]);
		try {
			assert.strictEqual(populated.agent.getDescriptor().capabilities?.modelCatalog, 'projected');
			assert.deepStrictEqual({
				empty: empty.agent.models.get(),
				populated: populated.agent.models.get(),
			}, {
				empty: [],
				populated: [{
					provider: DEEPSEEK_AGENT_PROVIDER_ID,
					id: 'customendpoint/Example/deepseek/deepseek-v4-pro',
					// The advertised id is vendor-qualified; the bare
					// provider-local id rides along so a model the runtime names
					// can be matched back to this row.
					underlyingModelId: 'deepseek/deepseek-v4-pro',
					name: 'DeepSeek V4 Pro',
					maxContextWindow: 128_000,
					supportsVision: false,
					_meta: { byokModelIdentifier: 'customendpoint/Example/deepseek/deepseek-v4-pro' },
				}, {
					provider: DEEPSEEK_AGENT_PROVIDER_ID,
					id: 'customendpoint/Example/claude-opus-4-6',
					underlyingModelId: 'claude-opus-4-6',
					name: 'claude-opus-4-6',
					maxContextWindow: undefined,
					supportsVision: false,
					_meta: { byokModelIdentifier: 'customendpoint/Example/claude-opus-4-6' },
				}, {
					provider: DEEPSEEK_AGENT_PROVIDER_ID,
					id: 'customendpoint/Example/voyage/voyage-4',
					underlyingModelId: 'voyage/voyage-4',
					name: 'voyage/voyage-4',
					maxContextWindow: undefined,
					supportsVision: false,
					_meta: { byokModelIdentifier: 'customendpoint/Example/voyage/voyage-4' },
				}],
			});
		} finally {
			empty.agent.dispose();
			populated.agent.dispose();
		}
	});

	test('names a session from a hidden toolless agent on the requested model and disposes it', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		const source = new CancellationTokenSource();
		try {
			const { session } = await createDeepSeekChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_DEEPSEEK_FLASH_ID } });
			let toolDecision: unknown;
			sdk.harness.onFollowup = async hidden => {
				toolDecision = await sdk.harness.requestApproval(hidden.id, 'Write');
				hidden.session.reply('Retry Logic for the Uploader');
			};

			const title = await agent.generateTitle(session, { prompt: 'add a retry to the uploader', modelId: BYOK_DEEPSEEK_PRO_ID }, source.token);

			const sessionId = AgentSession.id(session);
			assert.deepStrictEqual({
				title,
				creations: sdk.harness.creations.map(creation => ({ cwd: creation.cwd, provider: creation.provider, model: creation.model, isUserSession: creation.sessionId === sessionId })),
				prompts: sdk.harness.agents.map(hidden => hidden.prompts),
				policies: sdk.harness.policies.map(policy => policy.policy),
				toolDecision,
				disposedAgents: sdk.harness.disposedAgentIds.length,
				userSessionResumes: sdk.harness.resumeCount,
				chatSignalsWhileNaming: signals.length,
			}, {
				title: 'Retry Logic for the Uploader',
				creations: [{ cwd: '/workspace', provider: DeepSeekProviderRoute, model: BYOK_DEEPSEEK_PRO_ID, isUserSession: false }],
				prompts: [['Reply with only a concise 3-8 word title for this coding session, no quotes, no punctuation at the end: add a retry to the uploader']],
				policies: ['ask'],
				toolDecision: 'rejected',
				disposedAgents: 1,
				userSessionResumes: 0,
				chatSignalsWhileNaming: 0,
			});
		} finally {
			source.dispose();
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('describes a released session from the durable catalog, not from live state', async () => {
		const { agent, sdk } = createAgent(DEEPSEEK_BYOK_MODELS);
		try {
			const { session, chat, providerData } = await createDeepSeekChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_DEEPSEEK_FLASH_ID } });
			await agent.chats.sendMessage(chat, 'do the thing', [URI.file('/workspace')]);
			const describedWhileLive = await agent.getChatMetadata(chat, session, providerData);

			// Idle eviction: the host releases the chat, which detaches the agent
			// handle but must leave the session resumable.
			await agent.chats.releaseChat(chat, session);
			const describedAfterEviction = await agent.getChatMetadata(chat, session, providerData);

			const describe = (metadata: typeof describedAfterEviction) => metadata && {
				chat: metadata.chat.toString(),
				startTime: metadata.startTime,
				modifiedTime: metadata.modifiedTime,
				workingDirectories: metadata.workingDirectories?.map(directory => directory.fsPath),
			};
			const expected = {
				chat: chat.toString(),
				startTime: SESSION_CREATED_AT,
				modifiedTime: SESSION_CREATED_AT,
				workingDirectories: ['/workspace'],
			};
			assert.deepStrictEqual({
				live: sdk.harness.liveSessionIds,
				persisted: sdk.harness.persistedSessionIds,
				describedWhileLive: describe(describedWhileLive),
				describedAfterEviction: describe(describedAfterEviction),
			}, {
				live: [],
				persisted: [AgentSession.id(session)],
				describedWhileLive: expected,
				describedAfterEviction: expected,
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a cold re-entry describes and resumes a stored session in its own working directory', async () => {
		const first = createAgent(DEEPSEEK_BYOK_MODELS);
		const second = createAgent(DEEPSEEK_BYOK_MODELS, first.sdk);
		try {
			const { session, chat, providerData } = await createDeepSeekChat(first.agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_DEEPSEEK_FLASH_ID } });
			await first.agent.chats.sendMessage(chat, 'do the thing', [URI.file('/workspace')]);
			// A restart: the harness keeps its stored sessions, the provider loses
			// every in-memory entry, so re-entry runs entirely off `providerData`.
			await first.agent.shutdown();
			const resumesBeforeReentry = first.sdk.harness.resumeCount;

			const metadata = await second.agent.getChatMetadata(chat, session, providerData);
			const materialized = await second.agent.materializeChat(chat, session, providerData);

			assert.deepStrictEqual({
				startTime: metadata?.startTime,
				workingDirectories: metadata?.workingDirectories?.map(directory => directory.fsPath),
				resumed: first.sdk.harness.resumeCount - resumesBeforeReentry,
				resolvedWorkingDirectory: materialized?.resolvedWorkingDirectory?.fsPath,
				providerData: materialized?.providerData,
			}, {
				startTime: SESSION_CREATED_AT,
				workingDirectories: ['/workspace'],
				resumed: 1,
				// Not the workspace-less scratch directory: the resumed session's
				// own cwd, read from the durable header.
				resolvedWorkingDirectory: '/workspace',
				providerData,
			});
		} finally {
			await first.agent.shutdown();
			first.agent.dispose();
			await second.agent.shutdown();
			second.agent.dispose();
		}
	});

	test('describes a stored session the same way whichever frame layout its log uses', async () => {
		const { agent, sdk } = createAgent(DEEPSEEK_BYOK_MODELS);
		try {
			// Same session, same bytes of JSONL, different frame boundaries. The
			// harness's own reader accepts only `current`; a session relocated by
			// an older writer is stored as `legacy` and must read the same.
			storeSessionLog(sdk.sessionsRoot, '/worktree/current', 'framed-current', currentLayoutLog('framed-current', '/worktree/current'));
			storeSessionLog(sdk.sessionsRoot, '/worktree/legacy', 'framed-legacy', legacyLayoutLog('framed-legacy', '/worktree/legacy'));

			assert.deepStrictEqual({
				current: describedFields(await describeStoredSession(agent, 'framed-current')),
				legacy: describedFields(await describeStoredSession(agent, 'framed-legacy')),
			}, {
				current: { startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/worktree/current'] },
				legacy: { startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/worktree/legacy'] },
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('describes a session whose log was torn mid-append, and never the whole store with it', async () => {
		const { agent, sdk } = createAgent(DEEPSEEK_BYOK_MODELS);
		try {
			// A hard kill leaves logs in both states. Whether a session survives
			// has to be decided per session: reading one of these must not decide
			// anything about the other, which is what listing them together did.
			storeSessionLog(sdk.sessionsRoot, '/worktree/torn-tail', 'torn-tail', tornTailLog('torn-tail', '/worktree/torn-tail'));
			storeSessionLog(sdk.sessionsRoot, '/worktree/intact', 'intact', currentLayoutLog('intact', '/worktree/intact'));

			assert.deepStrictEqual({
				tornTail: describedFields(await describeStoredSession(agent, 'torn-tail')),
				intact: describedFields(await describeStoredSession(agent, 'intact')),
			}, {
				// The tail is gone; the header reached disk, so the session is
				// still describable from it.
				tornTail: { startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/worktree/torn-tail'] },
				intact: { startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/worktree/intact'] },
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a log with no readable header is reported as an error, not retried forever', async () => {
		const { agent, sdk } = createAgent(DEEPSEEK_BYOK_MODELS);
		try {
			storeSessionLog(sdk.sessionsRoot, '/worktree/unreadable', 'unreadable', tornHeaderLog('unreadable', '/worktree/unreadable'));
			storeSessionLog(sdk.sessionsRoot, '/worktree/healthy', 'healthy', currentLayoutLog('healthy', '/worktree/healthy'));

			// Answering `undefined` would make the host call this "not yet" and ask
			// again on every open, forever, for a log that will never parse.
			const damaged = await describeStoredSession(agent, 'unreadable').then(() => undefined, error => error);
			// A session with nothing stored is genuinely absent, not damaged: the
			// host may still be registering it, so that one stays a quiet miss.
			const absent = await describeStoredSession(agent, 'never-stored');

			assert.deepStrictEqual({
				damagedIsProtocolError: damaged instanceof ProtocolError,
				damagedCode: (damaged as ProtocolError | undefined)?.code,
				absent,
				neighbour: describedFields(await describeStoredSession(agent, 'healthy')),
			}, {
				damagedIsProtocolError: true,
				damagedCode: AHP_SESSION_NOT_FOUND,
				absent: undefined,
				neighbour: { startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/worktree/healthy'] },
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('describes a relocated session from the copy that was written last', async () => {
		const { agent, sdk } = createAgent(DEEPSEEK_BYOK_MODELS);
		try {
			// Moving a session's working directory re-stores it under a new project
			// key and leaves the old copy behind, so one id is stored twice with a
			// different `cwd` in each. Resuming into the stale one would attach the
			// session to a working directory it no longer has.
			const stale = storeSessionLog(sdk.sessionsRoot, '/old/worktree', 'relocated', currentLayoutLog('relocated', '/old/worktree'));
			const current = storeSessionLog(sdk.sessionsRoot, '/new/worktree', 'relocated', currentLayoutLog('relocated', '/new/worktree'));
			utimesSync(stale, new Date(SESSION_CREATED_AT), new Date(SESSION_CREATED_AT));
			utimesSync(current, new Date(SESSION_CREATED_AT + 60_000), new Date(SESSION_CREATED_AT + 60_000));

			assert.deepStrictEqual(
				describedFields(await describeStoredSession(agent, 'relocated')),
				{ startTime: SESSION_CREATED_AT, modifiedTime: SESSION_CREATED_AT, workingDirectories: ['/new/worktree'] },
			);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('a shell confirmation carries the command and its shell dialect for the terminal auto-approve rules', async () => {
		const requests = await collectPermissionRequests([
			{ toolName: 'bash', input: { command: 'git status', description: 'Show working tree status' } },
			{ toolName: 'pwsh', input: { command: 'Get-Process', description: 'List running processes' } },
		]);

		assert.deepStrictEqual(requests, [
			{ toolName: 'bash', permissionKind: 'shell', permissionPath: undefined, shellLanguage: 'bash', toolInput: 'git status' },
			{ toolName: 'pwsh', permissionKind: 'shell', permissionPath: undefined, shellLanguage: 'powershell', toolInput: 'Get-Process' },
		]);
	});

	test('a file confirmation carries the path the read/write auto-approve rules check', async () => {
		const requests = await collectPermissionRequests([
			{ toolName: 'read', input: { file_path: '/workspace/src/app.ts' } },
			{ toolName: 'write', input: { file_path: '/workspace/src/next.ts', content: 'export const next = 1;' } },
			{ toolName: 'str_replace_editor', input: { command: 'str_replace', path: '/workspace/src/app.ts', old_str: 'a', new_str: 'b' } },
		]);

		assert.deepStrictEqual(requests, [
			{ toolName: 'read', permissionKind: 'read', permissionPath: '/workspace/src/app.ts', shellLanguage: undefined, toolInput: '{\n  "file_path": "/workspace/src/app.ts"\n}' },
			{ toolName: 'write', permissionKind: 'write', permissionPath: '/workspace/src/next.ts', shellLanguage: undefined, toolInput: '{\n  "file_path": "/workspace/src/next.ts",\n  "content": "export const next = 1;"\n}' },
			{ toolName: 'str_replace_editor', permissionKind: 'write', permissionPath: '/workspace/src/app.ts', shellLanguage: undefined, toolInput: '{\n  "command": "str_replace",\n  "path": "/workspace/src/app.ts",\n  "old_str": "a",\n  "new_str": "b"\n}' },
		]);
	});
});
