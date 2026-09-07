/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { NullLogService } from '../../../log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { chatGptSubscriptionAgentModelId, type IChatGptSubscriptionService } from '../../node/chatGptSubscription.js';
import { AgentSession, AgentSignal, type IAgentCreateChatOptions } from '../../common/agent.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { MessageAttachmentKind, ResponsePartKind, ToolCallStatus, TurnState, buildDefaultChatUri } from '../../common/state/sessionState.js';
import { KimiAgent } from '../../node/kimi/kimiAgent.js';
import { IKimiApprovalRequest, IKimiCodeSdkService, IKimiEvent, IKimiHarness, IKimiQuestionRequest, IKimiSession, IKimiSessionSummary, KimiQuestionResult, KimiSdkProviderId, KimiSdkResponsesProviderId, syncKimiHostInstructions, wrapKimiHarnessForByok } from '../../node/kimi/kimiCodeSdkService.js';

/** A Kimi row as it arrives from the renderer BYOK catalog: `<vendor>/<group>/<id>`. */
// allow-any-unicode-next-line
const BYOK_KIMI_MODEL_ID = 'customendpoint/Example/moonshotai/kimi-k2.6';
// allow-any-unicode-next-line
import { replayKimiSessionToTurns } from '../../node/kimi/kimiReplayMapper.js';

class FakeKimiSession implements IKimiSession {
	readonly workDir = '/workspace';

	private listener: ((event: IKimiEvent) => void) | undefined;
	private approvalHandler: ((request: IKimiApprovalRequest) => Promise<{ decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }>) | undefined;
	private questionHandler: ((request: IKimiQuestionRequest) => Promise<KimiQuestionResult>) | undefined;

	promptImpl: (prompt: Parameters<IKimiSession['prompt']>[0]) => Promise<void> = async () => { };
	setModelImpl: (model: string) => Promise<void> = async () => { };
	closeCount = 0;

	constructor(readonly id = 'session-1') { }

	onEvent(listener: (event: IKimiEvent) => void): () => void {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}

	setApprovalHandler(handler: typeof this.approvalHandler): void { this.approvalHandler = handler; }
	setQuestionHandler(handler: typeof this.questionHandler): void { this.questionHandler = handler; }
	prompt(prompt: Parameters<IKimiSession['prompt']>[0]): Promise<void> { return this.promptImpl(prompt); }
	steer(_input: Parameters<IKimiSession['steer']>[0]): Promise<void> { return Promise.resolve(); }
	cancel(): Promise<void> { return Promise.resolve(); }
	setModel(model: string): Promise<void> { return this.setModelImpl(model); }
	setThinking(_effort: string): Promise<void> { return Promise.resolve(); }
	setPermission(_mode: 'yolo' | 'manual' | 'auto'): Promise<void> { return Promise.resolve(); }
	setPlanMode(_enabled: boolean): Promise<void> { return Promise.resolve(); }
	getResumeState(): ReturnType<IKimiSession['getResumeState']> { return undefined; }
	close(): Promise<void> { this.closeCount++; return Promise.resolve(); }

	emit(event: Omit<IKimiEvent, 'sessionId' | 'agentId'>): void {
		this.listener?.({ sessionId: this.id, agentId: 'main', ...event } as IKimiEvent);
	}

	requestApproval(request: IKimiApprovalRequest): Promise<{ decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }> {
		assert.ok(this.approvalHandler);
		return this.approvalHandler(request);
	}
}

class FakeKimiHarness implements IKimiHarness {
	readonly sessions = new Map<string, IKimiSession>();
	readonly session = new FakeKimiSession();
	readonly summaries: IKimiSessionSummary[] = [];
	readonly createOptions: Parameters<IKimiHarness['createSession']>[0][] = [];
	readonly deletedSessions: string[] = [];
	/** Sessions the harness minted itself, i.e. created without a Fumie session id. */
	readonly hiddenSessions: FakeKimiSession[] = [];
	/** The detached turns started by {@link hiddenPromptImpl}, so a test can await them. */
	readonly hiddenTurns: Promise<void>[] = [];
	readonly replaceConfigCalls: Parameters<IKimiHarness['replaceConfigSections']>[0][] = [];
	readonly listSessionsCalls: Parameters<IKimiHarness['listSessions']>[0][] = [];
	onCreateSession: (() => void) | undefined;
	onResumeSession: (() => void) | undefined;
	onGetConfig: (() => void) | undefined;
	hiddenPromptImpl: ((session: FakeKimiSession, prompt: Parameters<IKimiSession['prompt']>[0]) => Promise<void>) | undefined;

	async createSession(options: Parameters<IKimiHarness['createSession']>[0]): Promise<IKimiSession> {
		this.onCreateSession?.();
		this.createOptions.push(options);
		if (options.id === undefined) {
			const hidden = new FakeKimiSession(`hidden-${this.hiddenSessions.length + 1}`);
			// The SDK's `prompt()` resolves once the turn has *launched*; the turn's
			// events arrive afterwards. Run the scripted turn detached to keep that
			// ordering, so a caller that reads the reply without waiting for
			// `turn.ended` sees nothing.
			hidden.promptImpl = prompt => {
				this.hiddenTurns.push(this.hiddenPromptImpl?.(hidden, prompt) ?? Promise.resolve());
				return Promise.resolve();
			};
			this.hiddenSessions.push(hidden);
			this.sessions.set(hidden.id, hidden);
			return hidden;
		}
		this.sessions.set(this.session.id, this.session);
		return this.session;
	}
	async resumeSession(): Promise<IKimiSession> { this.onResumeSession?.(); return this.session; }
	async listSessions(options?: Parameters<IKimiHarness['listSessions']>[0]): Promise<readonly IKimiSessionSummary[]> {
		this.listSessionsCalls.push(options);
		return options?.sessionId === undefined
			? this.summaries
			: this.summaries.filter(summary => summary.id === options.sessionId);
	}
	async getConfig() {
		this.onGetConfig?.();
		return {
			defaultModel: BYOK_KIMI_MODEL_ID,
			models: {
				[BYOK_KIMI_MODEL_ID]: {
					provider: KimiSdkProviderId,
					model: BYOK_KIMI_MODEL_ID,
					maxContextSize: 1_000_000,
					capabilities: ['image_in'],
					displayName: 'Kimi Example',
				},
			},
		};
	}
	async replaceConfigSections(sections: Parameters<IKimiHarness['replaceConfigSections']>[0]): Promise<void> { this.replaceConfigCalls.push(sections); }
	async deleteSession(id: string): Promise<void> { this.deletedSessions.push(id); }
	async close(): Promise<void> { }
}

class FakeKimiSdkService implements IKimiCodeSdkService {
	declare readonly _serviceBrand: undefined;
	readonly harness = new FakeKimiHarness();
	getHarness(): Promise<IKimiHarness> { return Promise.resolve(this.harness); }
	canLoadWithoutDownload(): Promise<boolean> { return Promise.resolve(true); }
	close(): Promise<void> { return this.harness.close(); }
}

function chatGptSubscription(signedIn: boolean): IChatGptSubscriptionService {
	return {
		_serviceBrand: undefined,
		onDidChangeSignedIn: Event.None,
		registerSource: () => Disposable.None,
		getModels: () => [],
		isSignedIn: () => signedIn,
		readCredentials: () => Promise.resolve({ accessToken: 'token', accountId: 'acct-42', clientVersion: '0.153.4' }),
	};
}

function createAgent(models: readonly IByokLmModelInfo[] = [], signedInToChatGpt = false): { agent: KimiAgent; sdk: FakeKimiSdkService } {
	const sdk = new FakeKimiSdkService();
	const environment = { userHome: URI.file('/home/test') } as INativeEnvironmentService;
	return { agent: new KimiAgent(sdk, environment, new NullLogService(), byokRegistryWith(models), chatGptSubscription(signedInToChatGpt)), sdk };
}

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

async function createKimiChat(agent: KimiAgent, options: IAgentCreateChatOptions = {}) {
	const session = AgentSession.uri('kimi', 'session-1');
	const chat = URI.parse(buildDefaultChatUri(session));
	const result = await agent.chats.createChat(chat, session, options);
	return { session, chat, result };
}

suite('KimiAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('manages Fumie context without overwriting Kimi user instructions', () => {
		const home = mkdtempSync(join(tmpdir(), 'fumie-kimi-context-'));
		const contextPath = join(home, 'AGENTS.md');
		const userInstructions = '# My Kimi instructions\n\nKeep this text exactly.';
		try {
			writeFileSync(contextPath, userInstructions);
			assert.strictEqual(syncKimiHostInstructions(home, 'Fumie owns the Agents window.'), true);
			assert.match(readFileSync(contextPath, 'utf8'), /^# My Kimi instructions[\s\S]*Fumie owns the Agents window\./);

			assert.strictEqual(syncKimiHostInstructions(home, 'Use Settings > Models for model configuration.'), true);
			const updated = readFileSync(contextPath, 'utf8');
			assert.strictEqual(updated.match(/<!-- fumie-host-context:start -->/g)?.length, 1);
			assert.ok(!updated.includes('Fumie owns the Agents window.'));
			assert.ok(updated.includes('Use Settings > Models for model configuration.'));

			assert.strictEqual(syncKimiHostInstructions(home, undefined), true);
			assert.strictEqual(readFileSync(contextPath, 'utf8'), userInstructions);
			writeFileSync(contextPath, ' \n');
			assert.strictEqual(syncKimiHostInstructions(home, 'Fumie context'), true);
			assert.strictEqual(syncKimiHostInstructions(home, undefined), true);
			assert.strictEqual(readFileSync(contextPath, 'utf8'), ' \n');
			rmSync(contextPath);
			assert.strictEqual(syncKimiHostInstructions(home, 'Fumie context'), true);
			assert.strictEqual(syncKimiHostInstructions(home, undefined), true);
			assert.strictEqual(existsSync(contextPath), false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('preserves a linked Kimi instruction file', () => {
		if (process.platform === 'win32') {
			return;
		}
		const home = mkdtempSync(join(tmpdir(), 'fumie-kimi-context-link-'));
		const contextPath = join(home, 'AGENTS.md');
		const targetPath = join(home, 'shared-instructions.md');
		try {
			writeFileSync(targetPath, 'Shared Kimi instructions.');
			symlinkSync(targetPath, contextPath);
			assert.strictEqual(syncKimiHostInstructions(home, 'Fumie context'), false);
			assert.strictEqual(lstatSync(contextPath).isSymbolicLink(), true);
			assert.strictEqual(readFileSync(targetPath, 'utf8'), 'Shared Kimi instructions.');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
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
				properties: [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions, 'planMode'],
				defaults: { [SessionConfigKey.AutoApprove]: 'default', planMode: false },
				automatic: { [SessionConfigKey.AutoApprove]: 'assisted', planMode: false },
				yolo: { [SessionConfigKey.AutoApprove]: 'autoApprove', planMode: false },
			});
		} finally {
			agent.dispose();
		}
	});

	test('the picker rows preserve the renderer BYOK catalog', () => {
		const empty = createAgent();
		const populated = createAgent([
			{ vendor: 'customendpoint', id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', modelIdentifier: 'customendpoint/Example/moonshotai/kimi-k2.6', supportsVision: true, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high' },
			{ vendor: 'customendpoint', id: 'deepseek/deepseek-v4-pro', modelIdentifier: 'customendpoint/Example/deepseek/deepseek-v4-pro' },
			{ vendor: 'customendpoint', id: 'elevenlabs/scribe_v2', modelIdentifier: 'customendpoint/Example/elevenlabs/scribe_v2' },
		]);
		try {
			assert.strictEqual(populated.agent.getDescriptor().capabilities?.modelCatalog, 'projected');
			assert.deepStrictEqual({
				empty: empty.agent.models.get(),
				populated: populated.agent.models.get(),
			}, {
				empty: [],
				populated: [{
					provider: 'kimi',
					id: 'customendpoint/Example/moonshotai/kimi-k2.6',
					// The advertised id is vendor-qualified; the bare
					// provider-local id rides along so a model the runtime names
					// can be matched back to this row.
					underlyingModelId: 'moonshotai/kimi-k2.6',
					name: 'Kimi K2.6',
					maxContextWindow: undefined,
					supportsVision: true,
					configSchema: {
						type: 'object',
						properties: {
							thinkingLevel: {
								type: 'string',
								title: 'Thinking Level',
								description: 'Controls how much reasoning effort Kimi uses.',
								default: 'high',
								enum: ['low', 'medium', 'high'],
								enumLabels: ['Low', 'Medium', 'High'],
								enumDescriptions: ['Faster responses with less reasoning', 'Balanced reasoning and speed', 'Greater reasoning depth but slower'],
							},
						},
					},
					_meta: { byokModelIdentifier: 'customendpoint/Example/moonshotai/kimi-k2.6' },
				}, {
					provider: 'kimi',
					id: 'customendpoint/Example/deepseek/deepseek-v4-pro',
					underlyingModelId: 'deepseek/deepseek-v4-pro',
					name: 'deepseek/deepseek-v4-pro',
					maxContextWindow: undefined,
					supportsVision: false,
					_meta: { byokModelIdentifier: 'customendpoint/Example/deepseek/deepseek-v4-pro' },
				}, {
					provider: 'kimi',
					id: 'customendpoint/Example/elevenlabs/scribe_v2',
					underlyingModelId: 'elevenlabs/scribe_v2',
					name: 'elevenlabs/scribe_v2',
					maxContextWindow: undefined,
					supportsVision: false,
					_meta: { byokModelIdentifier: 'customendpoint/Example/elevenlabs/scribe_v2' },
				}],
			});
		} finally {
			empty.agent.dispose();
			populated.agent.dispose();
		}
	});

	test('installs the selected BYOK model through Kimi config without touching process env', async () => {
		const rawHarness = new FakeKimiHarness();
		const originalProviderEnv = process.env['KIMI_MODEL_API_KEY'];
		delete process.env['KIMI_MODEL_API_KEY'];
		try {
			const harness = wrapKimiHarnessForByok(rawHarness, {
				token: 'n.kimi',
				providerBaseUrl: () => 'http://127.0.0.1:4321/v1',
				resolveModel: () => ({ wire: 'chat-completions', name: 'Kimi K2.6', maxContextWindowTokens: 1_000_000, supportsVision: true }),
			});
			const session = await harness.createSession({ id: 'session-1', workDir: '/workspace', model: BYOK_KIMI_MODEL_ID });
			await session.setModel(BYOK_KIMI_MODEL_ID);
			await harness.resumeSession({ id: session.id, model: BYOK_KIMI_MODEL_ID });

			assert.strictEqual(process.env['KIMI_MODEL_API_KEY'], undefined);
			assert.deepStrictEqual(rawHarness.createOptions.map(options => options.model), [BYOK_KIMI_MODEL_ID]);
			assert.strictEqual(rawHarness.replaceConfigCalls.length, 3);
			assert.deepStrictEqual(rawHarness.replaceConfigCalls[0], {
				providers: {
					[KimiSdkProviderId]: { type: 'kimi', baseUrl: 'http://127.0.0.1:4321/v1', apiKey: 'n.kimi' },
				},
				models: {
					[BYOK_KIMI_MODEL_ID]: {
						provider: KimiSdkProviderId,
						model: BYOK_KIMI_MODEL_ID,
						maxContextSize: 1_000_000,
						capabilities: ['image_in', 'thinking'],
						displayName: 'Kimi K2.6',
					},
				},
				defaultModel: BYOK_KIMI_MODEL_ID,
			});
		} finally {
			if (originalProviderEnv === undefined) {
				delete process.env['KIMI_MODEL_API_KEY'];
			} else {
				process.env['KIMI_MODEL_API_KEY'] = originalProviderEnv;
			}
		}
	});

	test('offers ChatGPT subscription models only while signed in', () => {
		const signedOut = createAgent([], false);
		const signedIn = createAgent([], true);
		try {
			assert.deepStrictEqual(signedOut.agent.models.get(), []);
			assert.deepStrictEqual(signedIn.agent.models.get().map(model => ({ id: model.id, name: model.name })), [
				{ id: '@provider=chatgpt-subscription:gpt-6-astra', name: 'GPT-6-Astra' },
				{ id: '@provider=chatgpt-subscription:gpt-5.6-sol', name: 'GPT-5.6-Sol' },
				{ id: '@provider=chatgpt-subscription:gpt-5.6-terra', name: 'GPT-5.6-Terra' },
				{ id: '@provider=chatgpt-subscription:gpt-5.6-luna', name: 'GPT-5.6-Luna' },
				{ id: '@provider=chatgpt-subscription:gpt-5.5', name: 'GPT-5.5' },
				{ id: '@provider=chatgpt-subscription:gpt-5.4', name: 'GPT-5.4' },
				{ id: '@provider=chatgpt-subscription:gpt-5.4-mini', name: 'GPT-5.4-Mini' },
				{ id: '@provider=chatgpt-subscription:gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' },
			]);
			const astra = signedIn.agent.models.get()[0];
			assert.deepStrictEqual(astra.configSchema?.properties.serviceTier, {
				type: 'string',
				title: 'Speed',
				description: 'Controls Kimi response speed and usage.',
				default: 'standard',
				enum: ['standard', 'priority'],
				enumLabels: ['Standard', 'Fast'],
				enumDescriptions: ['Standard speed and usage.', '2x speed, increased usage'],
			});
		} finally {
			signedOut.agent.dispose();
			signedIn.agent.dispose();
		}
	});

	test('configures ChatGPT subscription models through the SDK native Responses provider', async () => {
		const rawHarness = new FakeKimiHarness();
		const modelId = chatGptSubscriptionAgentModelId('gpt-5.5', 'priority');
		const harness = wrapKimiHarnessForByok(rawHarness, {
			token: 'n.kimi',
			providerBaseUrl: wire => wire === 'responses' ? 'http://127.0.0.1:4321' : 'http://127.0.0.1:4321/v1',
			resolveModel: () => ({
				wire: 'responses',
				name: 'GPT-5.5',
				maxContextWindowTokens: 272_000,
				maxOutputTokens: 128_000,
				supportsVision: true,
				supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
				defaultReasoningEffort: 'medium',
			}),
		});

		await harness.createSession({ id: 'session-1', workDir: '/workspace', model: modelId });

		assert.deepStrictEqual(rawHarness.replaceConfigCalls[0], {
			providers: {
				[KimiSdkResponsesProviderId]: { type: 'openai_responses', baseUrl: 'http://127.0.0.1:4321', apiKey: 'n.kimi' },
			},
			models: {
				[modelId]: {
					provider: KimiSdkResponsesProviderId,
					model: modelId,
					maxContextSize: 272_000,
					maxOutputSize: 128_000,
					capabilities: ['image_in', 'thinking'],
					displayName: 'GPT-5.5',
					supportEfforts: ['low', 'medium', 'high', 'xhigh'],
					defaultEffort: 'medium',
				},
			},
			defaultModel: modelId,
		});
	});

	test('carries the selected ChatGPT service tier in the runtime model id', async () => {
		const { agent, sdk } = createAgent([], true);
		const modelId = chatGptSubscriptionAgentModelId('gpt-5.5');
		try {
			const { chat } = await createKimiChat(agent, {
				workingDirectories: [URI.file('/workspace')],
				model: { id: modelId, config: { serviceTier: 'priority', thinkingLevel: 'high' } },
			});
			sdk.harness.session.promptImpl = async () => sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });

			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			assert.strictEqual(sdk.harness.createOptions[0].model, chatGptSubscriptionAgentModelId('gpt-5.5', 'priority'));
			assert.strictEqual(sdk.harness.createOptions[0].thinking, 'high');
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('maps the core live event stream onto AHP chat actions', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_KIMI_MODEL_ID } });
			sdk.harness.session.promptImpl = async () => {
				sdk.harness.session.emit({ type: 'assistant.delta', turnId: 1, delta: 'hello' });
				sdk.harness.session.emit({ type: 'thinking.delta', turnId: 1, delta: 'thinking' });
				sdk.harness.session.emit({ type: 'tool.call.started', turnId: 1, toolCallId: 'tool-1', name: 'Read', args: { path: 'README.md' } });
				sdk.harness.session.emit({ type: 'tool.result', turnId: 1, toolCallId: 'tool-1', output: 'contents' });
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 12 });
			};

			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			const actionTypes = signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action.type);
			assert.deepStrictEqual(actionTypes, [
				ActionType.ChatTurnStarted,
				ActionType.ChatResponsePart,
				ActionType.ChatDelta,
				ActionType.ChatResponsePart,
				ActionType.ChatReasoning,
				ActionType.ChatToolCallStart,
				ActionType.ChatToolCallDelta,
				ActionType.ChatToolCallReady,
				ActionType.ChatToolCallComplete,
				ActionType.ChatTurnComplete,
			]);
			// The agent hands the harness the picker's id; the wrapper (not exercised
			// by this fake) is what lowers it onto the SDK's env alias.
			assert.strictEqual(sdk.harness.createOptions[0].model, BYOK_KIMI_MODEL_ID);
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('parks an SDK approval until Fumie responds', async () => {
		const { agent, sdk } = createAgent();
		const pending = new DeferredPromise<string>();
		const subscription = agent.onDidChatProgress(signal => {
			if (signal.kind === 'pending_confirmation') {
				pending.complete(signal.state.toolCallId);
			}
		});
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			let decision: string | undefined;
			sdk.harness.session.promptImpl = async () => {
				decision = (await sdk.harness.session.requestApproval({ toolCallId: 'approval-1', toolName: 'Write', action: 'Write README.md', display: { path: 'README.md' } })).decision;
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};

			const send = agent.chats.sendMessage(chat, 'edit', [URI.file('/workspace')], undefined, 'turn-1');
			const requestId = await pending.p;
			assert.strictEqual(decision, undefined);
			agent.respondToPermissionRequest(requestId, true);
			await send;
			assert.strictEqual(decision, 'approved');
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('keeps recoverable SDK errors non-terminal and maps blocked turns to errors', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			sdk.harness.session.promptImpl = async prompt => {
				sdk.harness.session.emit({ type: 'turn.started', turnId: 1 });
				if (prompt === 'recover') {
					sdk.harness.session.emit({ type: 'error', code: 'retry', message: 'provider retried' });
					sdk.harness.session.emit({ type: 'assistant.delta', turnId: 1, delta: 'recovered' });
					sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
				} else {
					sdk.harness.session.emit({ type: 'turn.ended', turnId: 2, reason: 'blocked' });
				}
			};

			await agent.chats.sendMessage(chat, 'recover', [URI.file('/workspace')], undefined, 'turn-1');
			let errors = signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatError);
			assert.strictEqual(errors.length, 0);

			await agent.chats.sendMessage(chat, 'block', [URI.file('/workspace')], undefined, 'turn-2');
			errors = signals.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatError);
			assert.strictEqual(errors.length, 1);
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('passes embedded images to the SDK prompt and retains message attachments', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			let received: Parameters<IKimiSession['prompt']>[0] | undefined;
			sdk.harness.session.promptImpl = async input => {
				received = input;
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};
			const attachment = { type: MessageAttachmentKind.EmbeddedResource, label: 'pixel.png', contentType: 'image/png', data: 'aGVsbG8=' } as const;

			await agent.chats.sendMessage(chat, 'inspect', [URI.file('/workspace')], [attachment], 'turn-1');

			assert.ok(Array.isArray(received));
			assert.deepStrictEqual(received?.[1], { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=', id: 'pixel.png' } });
			const started = signals.find(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatTurnStarted);
			assert.ok(started?.kind === 'action' && started.action.type === ActionType.ChatTurnStarted);
			assert.deepStrictEqual(started.action.message.attachments, [attachment]);
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('getChatMetadata asks the harness for the one session, not for the whole store', async () => {
		const { agent, sdk } = createAgent();
		try {
			const session = AgentSession.uri('kimi', 'described');
			const chat = URI.parse(buildDefaultChatUri(session));
			sdk.harness.summaries.push(
				{ id: 'described', title: 'Described', workDir: '/workspace', createdAt: 10, updatedAt: 20 },
				{ id: 'neighbour', title: 'Neighbour', workDir: '/other', createdAt: 30, updatedAt: 40 },
			);

			const metadata = await agent.getChatMetadata(chat, session);

			assert.deepStrictEqual({
				// A whole-store listing fails as a whole on the first entry it
				// dislikes, taking every healthy neighbour down with it.
				queries: sdk.harness.listSessionsCalls,
				summary: metadata?.summary,
				workingDirectory: metadata?.workingDirectories?.[0]?.fsPath,
			}, {
				queries: [{ sessionId: 'described' }],
				summary: 'Described',
				workingDirectory: URI.file('/workspace').fsPath,
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('release closes the SDK handle but preserves session configuration for rematerialization', async () => {
		const { agent, sdk } = createAgent();
		try {
			const created = await createKimiChat(agent, {
				workingDirectories: [URI.file('/workspace')],
				config: { [SessionConfigKey.AutoApprove]: 'autoApprove', planMode: true },
			});
			const { chat } = created;
			await agent.chats.sendMessage(chat, 'first', [URI.file('/workspace')], undefined, 'turn-1');

			await agent.chats.releaseChat(chat, created.session);
			assert.strictEqual(sdk.harness.session.closeCount, 1);
			assert.deepStrictEqual(sdk.harness.deletedSessions, []);

			await agent.chats.sendMessage(chat, 'second', [URI.file('/workspace')], undefined, 'turn-2');
			assert.strictEqual(sdk.harness.createOptions.length, 2);
			assert.strictEqual(sdk.harness.createOptions[1].permission, 'manual');
			assert.strictEqual(sdk.harness.createOptions[1].planMode, true);
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('rejects a second prompt while the session turn is active', async () => {
		const { agent, sdk } = createAgent();
		const firstPromptStarted = new DeferredPromise<void>();
		const finishFirstPrompt = new DeferredPromise<void>();
		const prompts: string[] = [];
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			sdk.harness.session.promptImpl = async prompt => {
				if (typeof prompt !== 'string') {
					assert.fail('Expected a text-only prompt');
				}
				prompts.push(prompt);
				if (prompt === 'first') {
					firstPromptStarted.complete();
					await finishFirstPrompt.p;
				}
			};

			const first = agent.chats.sendMessage(chat, 'first', [URI.file('/workspace')], undefined, 'turn-1');
			await firstPromptStarted.p;
			const second = agent.chats.sendMessage(chat, 'second', [URI.file('/workspace')], undefined, 'turn-2');
			await Promise.resolve();
			assert.deepStrictEqual(prompts, ['first']);

			finishFirstPrompt.complete();
			await first;
			await assert.rejects(second, /already being generated/);
			assert.deepStrictEqual(prompts, ['first']);
		} finally {
			finishFirstPrompt.complete();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('names a session from a throwaway session on the session model and deletes it', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		const source = new CancellationTokenSource();
		try {
			const { session, chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: BYOK_KIMI_MODEL_ID } });
			const realPrompts: Parameters<IKimiSession['prompt']>[0][] = [];
			sdk.harness.session.promptImpl = async prompt => {
				realPrompts.push(prompt);
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};
			const titlePrompts: Parameters<IKimiSession['prompt']>[0][] = [];
			let toolDecision: unknown;
			// Mirrors a real naming turn: `turn.started`, a rejected tool attempt, the
			// reply deltas, then `turn.ended` — all after `prompt()` has resolved.
			sdk.harness.hiddenPromptImpl = async (hidden, prompt) => {
				titlePrompts.push(prompt);
				hidden.emit({ type: 'turn.started', turnId: 1 });
				toolDecision = await hidden.requestApproval({ toolCallId: 'tool-1', toolName: 'Write', action: 'Write TITLE.md', display: {} });
				hidden.emit({ type: 'assistant.delta', turnId: 1, delta: 'Retry Logic for the Uploader\n' });
				hidden.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};
			await agent.chats.sendMessage(chat, 'add a retry to the uploader', [URI.file('/workspace')], undefined, 'turn-1');
			const actionsBeforeTitle = signals.length;

			const title = await agent.generateTitle(session, { prompt: 'add a retry to the uploader', modelId: BYOK_KIMI_MODEL_ID }, source.token);
			await Promise.all(sdk.harness.hiddenTurns);

			assert.deepStrictEqual({
				title,
				titlePrompts,
				toolDecision,
				throwawayCreations: sdk.harness.createOptions.filter(options => options.id === undefined),
				throwawayClosed: sdk.harness.hiddenSessions.map(hidden => hidden.closeCount),
				deletedSessions: sdk.harness.deletedSessions,
				realPrompts,
				realSessionClosed: sdk.harness.session.closeCount,
				chatActionsWhileNaming: signals.length - actionsBeforeTitle,
			}, {
				title: 'Retry Logic for the Uploader',
				titlePrompts: ['Reply with only a concise 3-8 word title for this coding session, no quotes, no punctuation at the end, and do not use any tools: add a retry to the uploader'],
				toolDecision: { decision: 'rejected', feedback: 'Tool calls are not available while naming a session.' },
				throwawayCreations: [{ workDir: '/workspace', model: BYOK_KIMI_MODEL_ID, permission: 'manual', planMode: false }],
				throwawayClosed: [1],
				deletedSessions: ['hidden-1'],
				realPrompts: ['add a retry to the uploader'],
				realSessionClosed: 0,
				chatActionsWhileNaming: 0,
			});
		} finally {
			source.dispose();
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('stamps the same tool-call meta on live and replayed tool calls', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const subscription = agent.onDidChatProgress(signal => signals.push(signal));
		const calls = [
			{ id: 'tool-1', name: 'Bash', args: { command: 'npm test' } },
			{ id: 'tool-2', name: 'Grep', args: { pattern: 'TODO' } },
			{ id: 'tool-3', name: 'Agent', args: { description: 'Find related files', subagent_type: 'explore', prompt: 'go' } },
			{ id: 'tool-4', name: 'CronList', args: {} },
		];
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			sdk.harness.session.promptImpl = async () => {
				for (const call of calls) {
					sdk.harness.session.emit({ type: 'tool.call.started', turnId: 1, toolCallId: call.id, name: call.name, args: call.args });
				}
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};

			await agent.chats.sendMessage(chat, 'inspect', [URI.file('/workspace')], undefined, 'turn-1');

			const live = signals
				.filter(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart)
				.map(signal => {
					assert.ok(signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallStart);
					return { toolName: signal.action.toolName, displayName: signal.action.displayName, meta: signal.action._meta };
				});

			const replayed = replayKimiSessionToTurns({
				agents: {
					main: {
						replay: [
							{ type: 'message', time: 1, message: { role: 'user', content: [{ type: 'text', text: 'inspect' }], toolCalls: [], origin: { kind: 'user' } } },
							{
								type: 'message', time: 2, message: {
									role: 'assistant',
									content: [],
									toolCalls: calls.map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
								},
							},
						],
					},
				},
			}, 'session-1')[0].responseParts
				.filter(part => part.kind === ResponsePartKind.ToolCall)
				.map(part => {
					assert.ok(part.kind === ResponsePartKind.ToolCall);
					return { toolName: part.toolCall.toolName, displayName: part.toolCall.displayName, meta: part.toolCall._meta };
				});

			const expected = [
				{ toolName: 'Bash', displayName: 'Run shell command', meta: { toolKind: 'terminal' } },
				{ toolName: 'Grep', displayName: 'Search files', meta: { toolKind: 'search' } },
				{ toolName: 'Agent', displayName: 'Delegate to subagent', meta: { toolKind: 'subagent', subagentDescription: 'Find related files', subagentAgentName: 'explore' } },
				// Not a rendering-relevant kind: no meta, generic card.
				{ toolName: 'CronList', displayName: 'List scheduled tasks', meta: undefined },
			];
			assert.deepStrictEqual({ live, replayed }, { live: expected, replayed: expected });
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('projects Kimi approval displays onto the host auto-approval fields', async () => {
		const { agent, sdk } = createAgent();
		const confirmations: Record<string, unknown>[] = [];
		const subscription = agent.onDidChatProgress(signal => {
			if (signal.kind !== 'pending_confirmation') {
				return;
			}
			confirmations.push({
				toolName: signal.state.toolName,
				displayName: signal.state.displayName,
				permissionKind: signal.permissionKind,
				permissionPath: signal.permissionPath,
				shellLanguage: signal.shellLanguage,
				toolInput: signal.state.toolInput,
				confirmationTitle: signal.state.confirmationTitle,
			});
			agent.respondToPermissionRequest(signal.state.toolCallId, true);
		});
		try {
			const { chat } = await createKimiChat(agent, { workingDirectories: [URI.file('/workspace')] });
			sdk.harness.session.promptImpl = async () => {
				await sdk.harness.session.requestApproval({
					toolCallId: 'bash-1',
					toolName: 'Bash',
					action: '',
					display: { kind: 'command', command: 'npm test', cwd: '/workspace', language: 'bash' },
				});
				await sdk.harness.session.requestApproval({
					toolCallId: 'read-1',
					toolName: 'Read',
					action: '',
					display: { kind: 'file_io', operation: 'read', path: '/workspace/README.md' },
				});
				await sdk.harness.session.requestApproval({
					toolCallId: 'mcp-1',
					toolName: 'mcp__github__create_pr',
					action: '',
					display: { kind: 'generic', summary: 'Open a pull request' },
				});
				sdk.harness.session.emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
			};

			await agent.chats.sendMessage(chat, 'run the tests', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual(confirmations, [
				{
					toolName: 'Bash',
					displayName: 'Run shell command',
					permissionKind: 'shell',
					permissionPath: undefined,
					shellLanguage: 'bash',
					toolInput: 'npm test',
					confirmationTitle: 'Run in terminal?',
				},
				{
					toolName: 'Read',
					displayName: 'Read file',
					permissionKind: 'read',
					permissionPath: '/workspace/README.md',
					shellLanguage: undefined,
					toolInput: '{"kind":"file_io","operation":"read","path":"/workspace/README.md"}',
					confirmationTitle: 'Read file?',
				},
				{
					// Unknown to the display table: generic card, no path, no shell dialect.
					toolName: 'mcp__github__create_pr',
					displayName: 'mcp__github__create_pr',
					permissionKind: 'custom-tool',
					permissionPath: undefined,
					shellLanguage: undefined,
					toolInput: '{"kind":"generic","summary":"Open a pull request"}',
					confirmationTitle: 'Allow tool call?',
				},
			]);
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('replays main-agent text, reasoning, and completed tools', () => {
		const turns = replayKimiSessionToTurns({
			agents: {
				main: {
					replay: [
						{ type: 'message', time: 1_700_000_000_000, message: { role: 'user', content: [{ type: 'text', text: 'inspect' }], toolCalls: [], origin: { kind: 'user' } } },
						{ type: 'message', time: 1_700_000_000_100, message: { role: 'assistant', content: [{ type: 'think', think: 'checking' }, { type: 'text', text: 'done' }], toolCalls: [{ id: 'tool-1', name: 'Read', arguments: '{"path":"README.md"}' }] } },
						{ type: 'message', time: 1_700_000_000_200, message: { role: 'tool', content: [{ type: 'text', text: 'contents' }], toolCalls: [], toolCallId: 'tool-1' } },
					],
				},
			},
		}, 'session-1');

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].state, TurnState.Complete);
		assert.strictEqual(turns[0].duration, 200);
		assert.deepStrictEqual(turns[0].responseParts.map(part => part.kind), [ResponsePartKind.Reasoning, ResponsePartKind.Markdown, ResponsePartKind.ToolCall]);
		const toolPart = turns[0].responseParts[2];
		assert.ok(toolPart.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(toolPart.toolCall.status, ToolCallStatus.Completed);
		assert.strictEqual(toolPart.toolCall.success, true);
	});
});
