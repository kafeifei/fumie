/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal, PI_AGENT_PROVIDER_ID, type IAgentCreateChatOptions } from '../../common/agent.js';
import type { IByokLmModelInfo, IByokLmProviderConfiguration } from '../../common/agentHostByokLm.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallStatus, TurnState, buildDefaultChatUri } from '../../common/state/sessionState.js';
import { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { chatGptSubscriptionAgentModelId, type IChatGptSubscriptionService } from '../../node/chatGptSubscription.js';
import { PiAgent } from '../../node/pi/piAgent.js';
import type { IProductService } from '../../../product/common/productService.js';
import { replayPiMessagesToTurns } from '../../node/pi/piReplayMapper.js';
import type { IPiAgentMessage, IPiAgentSession, IPiAgentSessionEvent, IPiCreateSessionOptions, IPiSdkService, IPiSessionHandle, PiBeforeToolCall } from '../../node/pi/piSdkService.js';

// allow-any-unicode-next-line
const PI_MODEL_ID = 'customendpoint/Example/qwen/qwen3-coder';

class FakePiSession implements IPiAgentSession {
	readonly sessionId = 'session-1';
	readonly sessionFile = '/session-data/pi/session-1.jsonl';
	readonly messages: IPiAgentMessage[] = [];
	readonly agent: { beforeToolCall?: PiBeforeToolCall } = {};
	isIdle = true;
	prompts: string[] = [];
	customMessages: string[] = [];
	disposeCount = 0;
	promptImpl: () => Promise<void> = async () => { };

	private listener: ((event: IPiAgentSessionEvent) => void) | undefined;

	subscribe(listener: (event: IPiAgentSessionEvent) => void): () => void {
		this.listener = listener;
		return () => { this.listener = undefined; };
	}

	prompt(text: string): Promise<void> {
		this.prompts.push(text);
		return this.promptImpl();
	}

	sendCustomMessage(message: { readonly content: string }): Promise<void> {
		this.customMessages.push(message.content);
		return Promise.resolve();
	}

	emit(event: IPiAgentSessionEvent): void { this.listener?.(event); }
	abort(): Promise<void> { return Promise.resolve(); }
	waitForIdle(): Promise<void> { return Promise.resolve(); }
	setModel(): Promise<void> { return Promise.resolve(); }
	setThinkingLevel(): void { }
	dispose(): void { this.disposeCount++; }
}

class FakePiSdkService implements IPiSdkService {
	declare readonly _serviceBrand: undefined;
	readonly session = new FakePiSession();
	readonly creations: IPiCreateSessionOptions[] = [];

	createSession(options: IPiCreateSessionOptions): Promise<IPiSessionHandle> {
		this.creations.push(options);
		this.session.agent.beforeToolCall = options.beforeToolCall;
		return Promise.resolve({ session: this.session, cwd: options.cwd, sessionFileName: 'session-1.jsonl', dispose: () => this.session.dispose() });
	}
	canLoadWithoutDownload(): Promise<boolean> { return Promise.resolve(true); }
	close(): Promise<void> { return Promise.resolve(); }
}

function piModel(): IByokLmModelInfo {
	return {
		vendor: 'customendpoint',
		id: 'qwen/qwen3-coder',
		name: 'Qwen 3 Coder',
		modelIdentifier: PI_MODEL_ID,
		maxContextWindowTokens: 262_144,
		maxOutputTokens: 32_768,
		supportsVision: true,
		supportedReasoningEfforts: ['low', 'medium', 'high'],
		defaultReasoningEffort: 'medium',
		supportedHarnesses: ['pi'],
	};
}

function byokRegistryWith(models: readonly IByokLmModelInfo[]): IByokLmBridgeRegistry {
	const configuration: IByokLmProviderConfiguration = {
		modelIdentifier: PI_MODEL_ID,
		vendor: 'customendpoint',
		groupName: 'Example',
		modelId: 'qwen/qwen3-coder',
		configuration: { apiKey: 'secret', apiType: 'responses', url: 'https://models.example/v1', models: [{ id: 'qwen/qwen3-coder' }] },
	};
	return {
		_serviceBrand: undefined,
		register: () => Disposable.None,
		getModels: () => models,
		getServingConnection: () => undefined,
		resolveProviderConfiguration: modelIdentifier => Promise.resolve(modelIdentifier === PI_MODEL_ID ? configuration : undefined),
		onDidChangeModels: Event.None,
	};
}

function chatGptSubscription(signedIn: boolean): IChatGptSubscriptionService {
	return {
		_serviceBrand: undefined,
		onDidChangeSignedIn: Event.None,
		registerSource: () => Disposable.None,
		isSignedIn: () => signedIn,
		readCredentials: () => Promise.resolve({ accessToken: 'token', accountId: 'acct-42', clientVersion: '0.147.0' }),
	};
}

function createAgent(models: readonly IByokLmModelInfo[] = [piModel()], signedInToChatGpt = false): { agent: PiAgent; sdk: FakePiSdkService } {
	const sdk = new FakePiSdkService();
	const sessionData = {
		_serviceBrand: undefined,
		getSessionDataDir: () => URI.file('/session-data'),
	} as unknown as ISessionDataService;
	return { agent: new PiAgent(sdk, byokRegistryWith(models), sessionData, new NullLogService(), { _serviceBrand: undefined } as IProductService, chatGptSubscription(signedInToChatGpt)), sdk };
}

async function createPiChat(agent: PiAgent, options: IAgentCreateChatOptions = {}) {
	const session = AgentSession.uri(PI_AGENT_PROVIDER_ID, 'session-1');
	const chat = URI.parse(buildDefaultChatUri(session));
	await agent.chats.createChat(chat, session, options);
	return { session, chat };
}

suite('PiAgent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds host instructions as hidden context without changing the user prompt', async () => {
		const { agent, sdk } = createAgent();
		try {
			const { session, chat } = await createPiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: PI_MODEL_ID } });
			await agent.chats.sendMessage(chat, 'keep this user prompt exact', [URI.file('/workspace')], undefined, 'turn-1', undefined, undefined, {
				resource: session,
				configurationResource: session,
				hostInstructions: ['Hosted inside Fumie.', 'Keep the Pi identity.'],
			});

			assert.deepStrictEqual({
				customMessages: sdk.session.customMessages,
				prompts: sdk.session.prompts,
			}, {
				customMessages: ['Hosted inside Fumie.\n\nKeep the Pi identity.'],
				prompts: ['keep this user prompt exact'],
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('uses the unified host approval schema', async () => {
		const { agent } = createAgent();
		try {
			const resolved = await agent.resolveChatConfig({ config: {} });
			assert.deepStrictEqual({
				properties: Object.keys(resolved.schema.properties),
				values: resolved.values,
			}, {
				properties: [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions],
				values: { [SessionConfigKey.AutoApprove]: 'default' },
			});
		} finally {
			agent.dispose();
		}
	});

	test('only advertises models explicitly assigned to Pi', () => {
		const { agent } = createAgent([piModel(), { ...piModel(), id: 'gpt-5', modelIdentifier: 'customendpoint/Example/gpt-5', supportedHarnesses: ['codex'] }]);
		try {
			assert.strictEqual(agent.getDescriptor().capabilities?.modelCatalog, 'projected');
			assert.deepStrictEqual(agent.models.get(), [{
				provider: PI_AGENT_PROVIDER_ID,
				id: PI_MODEL_ID,
				// The advertised id is vendor-qualified; the bare provider-local
				// id rides along so a model the runtime names can be matched
				// back to this row.
				underlyingModelId: 'qwen/qwen3-coder',
				name: 'Qwen 3 Coder',
				maxContextWindow: 262_144,
				maxOutputTokens: 32_768,
				supportsVision: true,
				configSchema: {
					type: 'object',
					properties: {
						thinkingLevel: {
							type: 'string',
							title: 'Thinking Level',
							description: 'Controls how much reasoning effort Pi asks the model to use.',
							enum: ['low', 'medium', 'high'],
							enumLabels: ['Low', 'Medium', 'High'],
							enumDescriptions: ['Faster responses with less reasoning', 'Balanced reasoning and speed', 'Greater reasoning depth but slower'],
							default: 'medium',
						},
					},
				},
				_meta: { byokModelIdentifier: PI_MODEL_ID },
			}]);
		} finally {
			agent.dispose();
		}
	});

	test('offers the ChatGPT subscription catalog only while a subscription is signed in', () => {
		const signedOut = createAgent([piModel()], false);
		const signedIn = createAgent([piModel()], true);
		try {
			assert.deepStrictEqual({
				signedOut: signedOut.agent.models.get().map(model => model.id),
				signedIn: signedIn.agent.models.get().map(model => ({ id: model.id, name: model.name, maxContextWindow: model.maxContextWindow })),
			}, {
				signedOut: [PI_MODEL_ID],
				signedIn: [
					{ id: PI_MODEL_ID, name: 'Qwen 3 Coder', maxContextWindow: 262_144 },
					{ id: '@provider=chatgpt-subscription:gpt-6-astra', name: 'GPT-6-Astra', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.6-sol', name: 'GPT-5.6-Sol', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.6-terra', name: 'GPT-5.6-Terra', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.6-luna', name: 'GPT-5.6-Luna', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.5', name: 'GPT-5.5', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.4', name: 'GPT-5.4', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.4-mini', name: 'GPT-5.4-Mini', maxContextWindow: 272_000 },
					{ id: '@provider=chatgpt-subscription:gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark', maxContextWindow: 128_000 },
				],
			});
		} finally {
			signedOut.agent.dispose();
			signedIn.agent.dispose();
		}
	});

	test('runs a ChatGPT subscription model over the Responses wire without a configured provider group', async () => {
		const { agent, sdk } = createAgent([], true);
		const subscriptionModelId = chatGptSubscriptionAgentModelId('gpt-5.5');
		try {
			const { chat } = await createPiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: subscriptionModelId } });
			sdk.session.promptImpl = async () => { sdk.session.emit({ type: 'agent_settled' }); };
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual(sdk.creations[0].model, {
				id: subscriptionModelId,
				name: 'GPT-5.5',
				wire: 'responses',
				reasoning: true,
				input: ['text', 'image'],
				contextWindow: 272_000,
				maxTokens: 128_000,
				thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
				defaultThinkingLevel: 'medium',
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('runs a text-only subscription model without claiming image input or an output ceiling above its window', async () => {
		const { agent, sdk } = createAgent([], true);
		const subscriptionModelId = chatGptSubscriptionAgentModelId('gpt-5.3-codex-spark');
		try {
			const { chat } = await createPiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: subscriptionModelId } });
			sdk.session.promptImpl = async () => { sdk.session.emit({ type: 'agent_settled' }); };
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual(sdk.creations[0].model, {
				id: subscriptionModelId,
				name: 'GPT-5.3-Codex-Spark',
				wire: 'responses',
				reasoning: true,
				input: ['text'],
				contextWindow: 128_000,
				maxTokens: 128_000,
				thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
				defaultThinkingLevel: 'high',
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('offers a subscription model only the reasoning levels Pi has a name for', async () => {
		const { agent, sdk } = createAgent([], true);
		const subscriptionModelId = chatGptSubscriptionAgentModelId('gpt-5.6-sol');
		try {
			const { chat } = await createPiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: subscriptionModelId } });
			sdk.session.promptImpl = async () => { sdk.session.emit({ type: 'agent_settled' }); };
			await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');

			// Upstream also advertises `ultra`, which Pi has no thinking level for.
			assert.deepStrictEqual({
				thinkingLevels: sdk.creations[0].model.thinkingLevels,
				defaultThinkingLevel: sdk.creations[0].model.defaultThinkingLevel,
			}, {
				thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
				defaultThinkingLevel: 'low',
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('offers the Speed choice only on the subscription models that publish a tier', () => {
		const { agent } = createAgent([piModel()], true);
		try {
			const serviceTierOf = (id: string) => agent.models.get().find(model => model.id === id)?.configSchema?.properties.serviceTier;
			assert.deepStrictEqual({
				tiered: serviceTierOf(chatGptSubscriptionAgentModelId('gpt-5.5')),
				untiered: serviceTierOf(chatGptSubscriptionAgentModelId('gpt-5.4-mini')),
				// A BYOK row is the user's own endpoint; it has no ChatGPT tier to pick.
				byok: serviceTierOf(PI_MODEL_ID),
			}, {
				tiered: {
					type: 'string',
					title: 'Speed',
					description: 'Controls Pi response speed and usage.',
					default: 'standard',
					enum: ['standard', 'priority'],
					enumLabels: ['Standard', 'Fast'],
					enumDescriptions: ['Standard speed and usage.', '1.5x speed, increased usage'],
				},
				untiered: undefined,
				byok: undefined,
			});
		} finally {
			agent.dispose();
		}
	});

	test('folds a chosen service tier into the model id Pi sends, and sends none for the standard one', async () => {
		const runWithTier = async (config: Record<string, string> | undefined) => {
			const { agent, sdk } = createAgent([], true);
			try {
				const { chat } = await createPiChat(agent, {
					workingDirectories: [URI.file('/workspace')],
					model: { id: chatGptSubscriptionAgentModelId('gpt-5.5'), ...(config ? { config } : {}) },
				});
				sdk.session.promptImpl = async () => { sdk.session.emit({ type: 'agent_settled' }); };
				await agent.chats.sendMessage(chat, 'hello', [URI.file('/workspace')], undefined, 'turn-1');
				return sdk.creations[0].model.id;
			} finally {
				await agent.shutdown();
				agent.dispose();
			}
		};

		assert.deepStrictEqual({
			fast: await runWithTier({ serviceTier: 'priority' }),
			standard: await runWithTier({ serviceTier: 'standard' }),
			unset: await runWithTier(undefined),
			// A tier this model does not publish is dropped rather than forwarded.
			unknown: await runWithTier({ serviceTier: 'flex' }),
		}, {
			fast: '@provider=chatgpt-subscription:gpt-5.5?serviceTier=priority',
			standard: '@provider=chatgpt-subscription:gpt-5.5',
			unset: '@provider=chatgpt-subscription:gpt-5.5',
			unknown: '@provider=chatgpt-subscription:gpt-5.5',
		});
	});

	test('maps Pi streaming, permission, tool result and usage into Fumie signals', async () => {
		const { agent, sdk } = createAgent();
		const signals: AgentSignal[] = [];
		const permissionRequests: Extract<AgentSignal, { kind: 'pending_confirmation' }>[] = [];
		const subscription = agent.onDidChatProgress(signal => {
			signals.push(signal);
			if (signal.kind === 'pending_confirmation') {
				permissionRequests.push(signal);
				agent.respondToPermissionRequest(signal.state.toolCallId, true);
			}
		});
		try {
			const { chat } = await createPiChat(agent, { workingDirectories: [URI.file('/workspace')], model: { id: PI_MODEL_ID, config: { thinkingLevel: 'high' } } });
			sdk.session.promptImpl = async () => {
				const decision = await sdk.session.agent.beforeToolCall?.({
					toolCall: { type: 'toolCall', id: 'tool-1', name: 'write', arguments: { path: 'src/new.ts', content: 'ok' } },
					args: { path: 'src/new.ts', content: 'ok' },
				});
				assert.strictEqual(decision, undefined);
				sdk.session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
				sdk.session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Done' } });
				sdk.session.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'write', result: { content: [{ type: 'text', text: 'wrote file' }] }, isError: false });
				sdk.session.emit({
					type: 'message_end', message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Done' }],
						stopReason: 'stop',
						usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0 },
						timestamp: Date.now(),
					}
				});
				sdk.session.emit({ type: 'agent_settled' });
			};

			await agent.chats.sendMessage(chat, 'create the file', [URI.file('/workspace')], undefined, 'turn-1');

			assert.deepStrictEqual({
				prompt: sdk.session.prompts,
				model: sdk.creations[0].model,
				thinkingLevel: sdk.creations[0].thinkingLevel,
				permission: permissionRequests.map(request => ({ kind: request.permissionKind, path: request.permissionPath, tool: request.state.toolName })),
				actions: signals.filter((signal): signal is Extract<AgentSignal, { kind: 'action' }> => signal.kind === 'action').map(signal => signal.action.type),
			}, {
				prompt: ['create the file'],
				model: {
					id: PI_MODEL_ID,
					name: 'Qwen 3 Coder',
					wire: 'responses',
					reasoning: true,
					input: ['text', 'image'],
					contextWindow: 262_144,
					maxTokens: 32_768,
					thinkingLevels: ['low', 'medium', 'high'],
					defaultThinkingLevel: 'medium',
				},
				thinkingLevel: 'high',
				permission: [{ kind: 'write', path: '/workspace/src/new.ts', tool: 'write' }],
				actions: [
					ActionType.ChatTurnStarted,
					ActionType.ChatToolCallStart,
					ActionType.ChatToolCallDelta,
					ActionType.ChatResponsePart,
					ActionType.ChatDelta,
					ActionType.ChatToolCallComplete,
					ActionType.ChatUsage,
					ActionType.ChatTurnComplete,
				],
			});
		} finally {
			subscription.dispose();
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('restores metadata and the Pi transcript from persisted provider data after eviction or restart', async () => {
		const { agent, sdk } = createAgent();
		const session = AgentSession.uri(PI_AGENT_PROVIDER_ID, 'session-1');
		const chat = URI.parse(buildDefaultChatUri(session));
		const providerData = JSON.stringify({
			sessionId: 'session-1',
			sessionFileName: 'session-1.jsonl',
			cwd: '/workspace',
			model: { id: PI_MODEL_ID, config: { thinkingLevel: 'high' } },
		});
		try {
			const coldMetadata = await agent.getChatMetadata(chat, session, providerData);
			await agent.materializeChat(chat, session, providerData);
			await agent.chats.releaseChat(chat, session);
			const evictedMetadata = await agent.getChatMetadata(chat, session, providerData);
			await agent.materializeChat(chat, session, providerData);
			const metadataSnapshot = (metadata: typeof coldMetadata) => metadata ? {
				chat: metadata.chat.toString(),
				startTime: metadata.startTime,
				modifiedTimeType: typeof metadata.modifiedTime,
				model: metadata.model,
				workingDirectories: metadata.workingDirectories?.map(directory => directory.toString()),
			} : undefined;

			assert.deepStrictEqual({
				coldMetadata: metadataSnapshot(coldMetadata),
				evictedMetadata: metadataSnapshot(evictedMetadata),
				createdFrom: sdk.creations.map(options => ({
					sessionId: options.sessionId,
					sessionFileName: options.sessionFileName,
					cwd: options.cwd,
					thinkingLevel: options.thinkingLevel,
				})),
			}, {
				coldMetadata: {
					chat: chat.toString(),
					startTime: 0,
					modifiedTimeType: 'number',
					model: { id: PI_MODEL_ID, config: { thinkingLevel: 'high' } },
					workingDirectories: ['file:///workspace'],
				},
				evictedMetadata: {
					chat: chat.toString(),
					startTime: 0,
					modifiedTimeType: 'number',
					model: { id: PI_MODEL_ID, config: { thinkingLevel: 'high' } },
					workingDirectories: ['file:///workspace'],
				},
				createdFrom: [{
					sessionId: 'session-1',
					sessionFileName: 'session-1.jsonl',
					cwd: '/workspace',
					thinkingLevel: 'high',
				}, {
					sessionId: 'session-1',
					sessionFileName: 'session-1.jsonl',
					cwd: '/workspace',
					thinkingLevel: 'high',
				}],
			});
		} finally {
			await agent.shutdown();
			agent.dispose();
		}
	});

	test('replays the persisted Pi transcript into completed Fumie turns', () => {
		const turns = replayPiMessagesToTurns([{
			role: 'user',
			content: 'inspect the file',
			timestamp: 1_000,
		}, {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'I should read it.' },
				{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/file.ts' } },
			],
			stopReason: 'toolUse',
			usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
			timestamp: 1_100,
		}, {
			role: 'toolResult',
			toolCallId: 'read-1',
			toolName: 'read',
			content: [{ type: 'text', text: 'const value = 1;' }],
			isError: false,
			timestamp: 1_200,
		}, {
			role: 'assistant',
			content: [{ type: 'text', text: 'The file defines value.' }],
			stopReason: 'stop',
			// A non-zero `cacheWrite` is the case the replay mapper used to drop
			// on the floor; occupancy for this turn is 8 + 2 + 5 = 15.
			usage: { input: 8, output: 3, cacheRead: 2, cacheWrite: 5 },
			timestamp: 1_300,
		}], 'session-1', '/workspace');

		assert.strictEqual(turns.length, 1);
		assert.deepStrictEqual({
			message: turns[0].message.text,
			state: turns[0].state,
			usage: turns[0].usage,
			parts: turns[0].responseParts.map(part => part.kind === ResponsePartKind.ToolCall
				? { kind: part.kind, status: part.toolCall.status, success: part.toolCall.status === ToolCallStatus.Completed ? part.toolCall.success : undefined }
				: part.kind === ResponsePartKind.Markdown || part.kind === ResponsePartKind.Reasoning
					? { kind: part.kind, content: part.content }
					: { kind: part.kind, content: undefined }),
		}, {
			message: 'inspect the file',
			state: TurnState.Complete,
			usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, _meta: { cacheCreationTokens: 5 } },
			parts: [
				{ kind: ResponsePartKind.Reasoning, content: 'I should read it.' },
				{ kind: ResponsePartKind.ToolCall, status: ToolCallStatus.Completed, success: true },
				{ kind: ResponsePartKind.Markdown, content: 'The file defines value.' },
			],
		});
	});
});
