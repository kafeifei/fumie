/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import type { IByokLmChatRequest } from '../../../../../../platform/agentHost/common/agentHostByokLm.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKey, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ChatEntitlementContextKeys, IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { AgentHostByokLmHandler } from '../../../browser/agentSessions/agentHost/agentHostByokLmHandler.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { ChatMessageRole, IChatMessage, IChatResponsePart, ILanguageModelChatMetadata, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelsGroup, ILanguageModelsService, IResolvedLanguageModelsProviderGroup } from '../../../common/languageModels.js';

interface ICapturedRequest {
	modelId: string;
	messages: IChatMessage[];
	options: ILanguageModelChatRequestOptions;
}

/**
 * Fake LM API service: resolves a small fixed model set and replays a
 * scripted response stream, capturing what the handler forwarded. Stands in
 * for the renderer's real `ILanguageModelsService` so the bridge handler can be
 * exercised without any extension or model provider.
 */
class TestLanguageModelsService extends mock<ILanguageModelsService>() {

	captured: ICapturedRequest | undefined;
	groups: ILanguageModelsGroup[] = [];

	override readonly onDidChangeLanguageModels = Event.None;
	override readonly onDidChangeModelVisibility: Event<void>;
	override readonly whenReady: Promise<void>;

	constructor(
		private readonly _models: ReadonlyMap<string, ILanguageModelChatMetadata>,
		private readonly _respond: (request: ICapturedRequest) => ILanguageModelChatResponse,
		onDidChangeModelVisibility = Event.None,
		private readonly _isModelHidden: (identifier: string) => boolean = () => false,
		private readonly _resolvedGroup: IResolvedLanguageModelsProviderGroup | undefined = undefined,
		whenReady: Promise<void> = Promise.resolve(),
	) {
		super();
		this.onDidChangeModelVisibility = onDidChangeModelVisibility;
		this.whenReady = whenReady;
	}

	override getLanguageModelIds(): string[] {
		return [...this._models.keys()];
	}

	override lookupLanguageModel(modelId: string): ILanguageModelChatMetadata | undefined {
		return this._models.get(modelId);
	}

	override getLanguageModelGroups(): ILanguageModelsGroup[] {
		return this.groups;
	}

	override isModelHidden(identifier: string): boolean {
		return this._isModelHidden(identifier);
	}

	override async resolveLanguageModelProviderGroup(): Promise<IResolvedLanguageModelsProviderGroup | undefined> {
		return this._resolvedGroup;
	}

	override async sendChatRequest(modelId: string, _from: ExtensionIdentifier | undefined, messages: IChatMessage[], options: ILanguageModelChatRequestOptions, _token: CancellationToken): Promise<ILanguageModelChatResponse> {
		this.captured = { modelId, messages, options };
		return this._respond(this.captured);
	}
}

class TestChatEntitlementService extends mock<IChatEntitlementService>() {
	constructor(private readonly _contextKeyService: IContextKeyService) {
		super();
	}

	override get clientByokEnabled(): boolean {
		return this._contextKeyService.getContextKeyValue<boolean>(ChatEntitlementContextKeys.clientByokEnabled.key) === true;
	}
}

function byokModel(vendor: string, id: string, capabilities?: ILanguageModelChatMetadata['capabilities']): ILanguageModelChatMetadata {
	return {
		extension: new ExtensionIdentifier('test.byok'),
		name: `${vendor} ${id}`,
		id,
		vendor,
		version: '1.0.0',
		family: 'test',
		maxInputTokens: 1000,
		maxOutputTokens: 1000,
		isDefaultForLocation: {},
		isBYOK: true,
		capabilities,
	};
}

function responseOf(parts: IChatResponsePart[]): ILanguageModelChatResponse {
	return {
		stream: (async function* () {
			for (const part of parts) {
				yield part;
			}
		})(),
		result: Promise.resolve(undefined),
	};
}

suite('AgentHostByokLmHandler', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createPolicyContext(enabled: boolean): { contextKeyService: IContextKeyService; clientByokEnabled: IContextKey<boolean> } {
		const contextKeyService = store.add(new ContextKeyService(new TestConfigurationService()));
		const clientByokEnabled = ChatEntitlementContextKeys.clientByokEnabled.bindTo(contextKeyService);
		clientByokEnabled.set(enabled);
		return { contextKeyService, clientByokEnabled };
	}

	function createHandler(service: ILanguageModelsService): AgentHostByokLmHandler {
		const { contextKeyService } = createPolicyContext(true);
		return store.add(new AgentHostByokLmHandler(service, new NullLogService(), new TestChatEntitlementService(contextKeyService), contextKeyService));
	}

	test('updates model discovery and blocks requests when BYOK policy changes', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id-acme', byokModel('acme', 'claude')]]),
			() => responseOf([]),
		);
		const { contextKeyService, clientByokEnabled } = createPolicyContext(true);
		const handler = store.add(new AgentHostByokLmHandler(service, new NullLogService(), new TestChatEntitlementService(contextKeyService), contextKeyService));
		let modelChangeCount = 0;
		store.add(handler.onDidChangeModels(() => modelChangeCount++));

		clientByokEnabled.set(false);
		const disabledModels = await handler.listModels(CancellationToken.None);
		const disabledResult = await handler.chat({
			vendor: 'acme',
			modelId: 'claude',
			input: [],
		}, CancellationToken.None);
		clientByokEnabled.set(true);
		const enabledModels = await handler.listModels(CancellationToken.None);

		assert.deepStrictEqual({
			modelChangeCount,
			disabledModels,
			disabledResult,
			enabledModels,
			requestSent: service.captured !== undefined,
		}, {
			modelChangeCount: 2,
			disabledModels: [],
			disabledResult: { output: [], error: 'BYOK models are disabled by policy.' },
			enabledModels: [
				{ vendor: 'acme', id: 'claude', name: 'acme claude', modelIdentifier: 'id-acme', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: [] },
			],
			requestSent: false,
		});
	});

	test('pushes the first renderer model change to the agent host without debounce delay', () => {
		const modelChanges = store.add(new Emitter<string>());
		const service = new class extends TestLanguageModelsService {
			override readonly onDidChangeLanguageModels = modelChanges.event;
		}(
			new Map([['id-acme', byokModel('acme', 'claude')]]),
			() => responseOf([]),
		);
		const handler = createHandler(service);
		let modelChangeCount = 0;
		store.add(handler.onDidChangeModels(() => modelChangeCount++));

		modelChanges.fire('customendpoint');

		assert.strictEqual(modelChangeCount, 1);
	});

	test('does not publish the initial model snapshot before the renderer catalog is ready', async () => {
		const ready = new DeferredPromise<void>();
		const models = new Map<string, ILanguageModelChatMetadata>();
		const service = new TestLanguageModelsService(
			models,
			() => responseOf([]),
			Event.None,
			() => false,
			undefined,
			ready.p,
		);
		const result = createHandler(service).listModels(CancellationToken.None);
		let settled = false;
		void result.then(() => { settled = true; });
		await Promise.resolve();
		assert.strictEqual(settled, false);

		models.set('customendpoint/Custom/kimi-k2.5', byokModel('customendpoint', 'kimi-k2.5'));
		ready.complete();

		assert.deepStrictEqual(await result, [{
			vendor: 'customendpoint',
			id: 'kimi-k2.5',
			name: 'customendpoint kimi-k2.5',
			modelIdentifier: 'customendpoint/Custom/kimi-k2.5',
			maxContextWindowTokens: 2000,
			maxOutputTokens: 1000,
			supportsVision: false,
			supportedHarnesses: ['pi', 'opencode'],
		}]);
	});

	test('listModels enumerates renderer BYOK models and excludes agent-host copies', async () => {
		const service = new TestLanguageModelsService(
			new Map<string, ILanguageModelChatMetadata>([
				['id-acme', byokModel('acme', 'claude', { vision: true })],
				['ollama/Ollama/gemma4:31b-mlx', byokModel('ollama', 'gemma4:31b-mlx')],
				['id-copy', { ...byokModel('acme', 'claude'), targetChatSessionType: 'copilotcli' }],
				['id-capi', { ...byokModel('copilot', 'gpt-4'), isBYOK: false }],
			]),
			() => responseOf([]),
		);
		const handler = createHandler(service);

		const models = await handler.listModels(CancellationToken.None);

		assert.deepStrictEqual(models, [
			{ vendor: 'acme', id: 'claude', name: 'acme claude', modelIdentifier: 'id-acme', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: true, supportedHarnesses: [] },
			{ vendor: 'ollama', id: 'gemma4:31b-mlx', name: 'ollama gemma4:31b-mlx', modelIdentifier: 'ollama/Ollama/gemma4:31b-mlx', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: ['pi', 'opencode'] },
		]);
	});

	test('listModels routes generic native models to Pi and OpenCode while preserving explicit Agent metadata', async () => {
		const genericId = 'customendpoint/Generic/qwen3-coder';
		const officialId = 'customendpoint/Generic/gpt-5';
		const service = new TestLanguageModelsService(
			new Map<string, ILanguageModelChatMetadata>([
				[genericId, byokModel('customendpoint', 'qwen3-coder')],
				[officialId, byokModel('customendpoint', 'gpt-5')],
			]),
			() => responseOf([]),
		);
		service.groups = [{
			modelIdentifiers: [genericId, officialId],
			group: {
				name: 'Generic',
				vendor: 'customendpoint',
				apiKey: 'secret',
				apiType: 'responses',
				url: 'https://models.example/v1',
				models: [
					{ id: 'qwen3-coder' },
					{ id: 'gpt-5', fumieHarnesses: ['codex'] },
				],
			},
		}];
		const models = await createHandler(service).listModels(CancellationToken.None);

		assert.deepStrictEqual(models.map(model => ({ id: model.id, harnesses: model.supportedHarnesses })), [
			{ id: 'qwen3-coder', harnesses: ['pi', 'opencode'] },
			{ id: 'gpt-5', harnesses: ['codex'] },
		]);
	});

	test('publishes only visible canonical subscription models and tracks Provider removal', async () => {
		const id = 'subscription-provider:model';
		const owner: ILanguageModelChatMetadata = {
			...byokModel('subscription-provider', 'model'),
			isBYOK: false,
			sourceModel: { sourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, modelId: 'gpt-example', visibilityNamespace: 'local', visibilityOwner: true },
		};
		const models = new Map<string, ILanguageModelChatMetadata>([
			[id, owner],
			['agent-copy:model', { ...owner, sourceModel: { ...owner.sourceModel!, visibilityOwner: false } }],
			['byok:model', byokModel('customendpoint', 'gpt-example')],
		]);
		const hidden = new Set<string>();
		const changes = store.add(new Emitter<void>());
		const service = new TestLanguageModelsService(models, () => responseOf([]), changes.event, identifier => hidden.has(identifier));
		const { contextKeyService } = createPolicyContext(false);
		const handler = store.add(new AgentHostByokLmHandler(service, new NullLogService(), new TestChatEntitlementService(contextKeyService), contextKeyService));
		let publishes = 0;
		store.add(handler.onDidChangeModels(() => publishes++));
		assert.deepStrictEqual((await handler.listChatGptModels(CancellationToken.None)).map(model => model.id), ['gpt-example']);
		assert.deepStrictEqual(await handler.listModels(CancellationToken.None), []); // BYOK policy is independent.
		hidden.add(id);
		changes.fire();
		assert.deepStrictEqual(await handler.listChatGptModels(CancellationToken.None), []);
		hidden.clear();
		changes.fire();
		assert.strictEqual((await handler.listChatGptModels(CancellationToken.None)).length, 1);
		models.delete(id);
		assert.deepStrictEqual(await handler.listChatGptModels(CancellationToken.None), []);
		assert.strictEqual(publishes, 2);
	});

	test('listModels carries the LM service identifier (the Manage Models visibility key)', async () => {
		// A grouped BYOK model is registered under `<vendor>/<group>/<id>` — exactly the id the
		// Manage Models view keys visibility by. The handler carries that identifier verbatim so
		// the picker can honour the toggle for the model's agent-host copy.
		const groupedId = 'openrouter/OpenRouter 2/ai21/jamba-large-1.7';
		const service = new TestLanguageModelsService(
			new Map<string, ILanguageModelChatMetadata>([
				[groupedId, byokModel('openrouter', 'ai21/jamba-large-1.7')],
				['openrouter/gpt-4', byokModel('openrouter', 'gpt-4')],
			]),
			() => responseOf([]),
		);
		const handler = createHandler(service);

		const models = await handler.listModels(CancellationToken.None);

		assert.deepStrictEqual(models, [
			{ vendor: 'openrouter', id: 'ai21/jamba-large-1.7', name: 'openrouter ai21/jamba-large-1.7', modelIdentifier: groupedId, maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: [] },
			{ vendor: 'openrouter', id: 'gpt-4', name: 'openrouter gpt-4', modelIdentifier: 'openrouter/gpt-4', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: [] },
		]);
	});

	test('listModels reports hidden BYOK sources and Agent Host copies rather than dropping them', async () => {
		const sourceIdentifier = 'openrouter/OpenRouter 2/ai21/jamba-large-1.7';
		const agentHostIdentifier = `${SessionType.AgentHostCopilot}:openrouter/OpenRouter 2/ai21/jamba-large-1.7`;
		const hidden = new Set<string>();
		const visibilityChanges = store.add(new Emitter<void>());
		const service = new TestLanguageModelsService(
			new Map([[sourceIdentifier, byokModel('openrouter', 'ai21/jamba-large-1.7')]]),
			() => responseOf([]),
			visibilityChanges.event,
			identifier => hidden.has(identifier),
		);
		const handler = createHandler(service);
		let modelChangeCount = 0;
		store.add(handler.onDidChangeModels(() => modelChangeCount++));

		const visibleModels = await handler.listModels(CancellationToken.None);
		hidden.add(sourceIdentifier);
		visibilityChanges.fire();
		const sourceHiddenModels = await handler.listModels(CancellationToken.None);
		hidden.delete(sourceIdentifier);
		hidden.add(agentHostIdentifier);
		visibilityChanges.fire();
		const copyHiddenModels = await handler.listModels(CancellationToken.None);
		hidden.clear();
		visibilityChanges.fire();
		const restoredModels = await handler.listModels(CancellationToken.None);

		// The row stays in the catalogue either way — a client that reaches the
		// catalogue only through this window has no other way to learn it exists,
		// and cannot un-hide a row it was never told about. Only the flag moves.
		const row = {
			vendor: 'openrouter',
			id: 'ai21/jamba-large-1.7',
			name: 'openrouter ai21/jamba-large-1.7',
			modelIdentifier: sourceIdentifier,
			maxContextWindowTokens: 2000,
			maxOutputTokens: 1000,
			supportsVision: false,
			supportedHarnesses: [],
		};
		assert.deepStrictEqual({
			modelChangeCount,
			visibleModels,
			sourceHiddenModels,
			copyHiddenModels,
			restoredModels,
		}, {
			modelChangeCount: 3,
			visibleModels: [row],
			sourceHiddenModels: [{ ...row, hidden: true }],
			copyHiddenModels: [{ ...row, hidden: true }],
			restoredModels: [row],
		});
	});

	test('listModels carries string reasoning effort metadata from renderer BYOK schemas', async () => {
		const service = new TestLanguageModelsService(
			new Map<string, ILanguageModelChatMetadata>([
				['id-reasoning', {
					...byokModel('acme', 'reasoning'),
					configurationSchema: {
						properties: {
							reasoningEffort: {
								type: 'string',
								enum: ['minimal', 'low', 1, 'high'],
								default: 'high',
							},
						},
					},
				}],
				['id-malformed', {
					...byokModel('acme', 'malformed'),
					configurationSchema: {
						properties: {
							reasoningEffort: {
								type: 'string',
								enum: [1, false],
								default: 1,
							},
						},
					},
				}],
				['id-plain', byokModel('acme', 'plain')],
			]),
			() => responseOf([]),
		);
		const handler = createHandler(service);

		const models = await handler.listModels(CancellationToken.None);

		assert.deepStrictEqual(models, [
			{
				vendor: 'acme',
				id: 'reasoning',
				name: 'acme reasoning',
				modelIdentifier: 'id-reasoning',
				maxContextWindowTokens: 2000,
				maxOutputTokens: 1000,
				supportsVision: false,
				supportedHarnesses: [],
				supportedReasoningEfforts: ['minimal', 'low', 'high'],
				defaultReasoningEffort: 'high',
			},
			{ vendor: 'acme', id: 'malformed', name: 'acme malformed', modelIdentifier: 'id-malformed', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: [] },
			{ vendor: 'acme', id: 'plain', name: 'acme plain', modelIdentifier: 'id-plain', maxContextWindowTokens: 2000, maxOutputTokens: 1000, supportsVision: false, supportedHarnesses: [] },
		]);
	});

	test('chat resolves the configured provider group when models share a vendor and id', async () => {
		const workIdentifier = 'google/Gemini Work/gemini-2.5-pro';
		const service = new TestLanguageModelsService(
			new Map([
				['google/Gemini Personal/gemini-2.5-pro', byokModel('google', 'gemini-2.5-pro')],
				[workIdentifier, byokModel('google', 'gemini-2.5-pro')],
			]),
			() => responseOf([]),
		);
		const handler = createHandler(service);

		await handler.chat({
			vendor: 'google',
			modelId: 'Gemini Work/gemini-2.5-pro',
			input: [],
		}, CancellationToken.None);

		assert.strictEqual(service.captured?.modelId, workIdentifier);
	});

	test('buffers ordered thinking, text, tool calls, continuation and usage', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id-acme-claude', byokModel('acme', 'claude')]]),
			() => responseOf([
				{ type: 'thinking', value: 'considered ', id: 'rs_1' },
				{ type: 'thinking', value: ['options'], id: 'rs_1', metadata: { encrypted_content: 'opaque' } },
				{ type: 'thinking', value: '', id: 'thinking_2', metadata: { signature: 'sig', _completeThinking: 'full thought' } },
				{ type: 'text', value: 'hello ' },
				{ type: 'text', value: 'world' },
				{ type: 'tool_use', name: 'getWeather', toolCallId: 't1', parameters: { city: 'NYC' } },
				{ type: 'tool_use', name: 'apply_patch', toolCallId: 't2', parameters: { input: 'patch' } },
				{ type: 'data', mimeType: 'stateful_marker', data: VSBuffer.fromString('claude\\resp_provider') },
				{ type: 'data', mimeType: 'usage', data: VSBuffer.fromString('{"prompt_tokens":10,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":2}}') },
			]),
		);
		const handler = createHandler(service);

		const result = await handler.chat(
			{
				vendor: 'acme',
				modelId: 'claude',
				input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
				tools: [
					{ type: 'function', name: 'getWeather' },
					{ type: 'custom', name: 'apply_patch' },
				],
			},
			CancellationToken.None,
		);

		assert.strictEqual(service.captured?.modelId, 'id-acme-claude');
		assert.deepStrictEqual(result, {
			output: [
				{ type: 'reasoning', id: 'rs_1', summary: ['considered ', 'options'], encryptedContent: 'opaque', metadata: { encrypted_content: 'opaque' } },
				{ type: 'reasoning', id: 'thinking_2', summary: [''], encryptedContent: 'vscode-reasoning-metadata:{"signature":"sig","_completeThinking":"full thought"}', metadata: { signature: 'sig', _completeThinking: 'full thought' } },
				{ type: 'message', content: [{ type: 'text', text: 'hello world' }] },
				{ type: 'function_call', callId: 't1', name: 'getWeather', argumentsJson: '{"city":"NYC"}' },
				{ type: 'custom_tool_call', callId: 't2', name: 'apply_patch', input: 'patch' },
			],
			responseId: 'resp_provider',
			usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
		});
	});

	test('combines streamed thinking chunks into one summary entry', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id-deepseek', byokModel('customendpoint', 'deepseek')]]),
			() => responseOf([
				{ type: 'thinking', value: 'Analy' },
				{ type: 'thinking', value: 'zing' },
			]),
		);
		const handler = createHandler(service);

		const result = await handler.chat({
			vendor: 'customendpoint',
			modelId: 'deepseek',
			input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
		}, CancellationToken.None);

		assert.deepStrictEqual(result.output, [{
			type: 'reasoning',
			id: undefined,
			summary: ['Analyzing'],
			encryptedContent: undefined,
			metadata: undefined,
		}]);
	});

	test('preserves streamed reasoning summary part boundaries', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id', byokModel('customendpoint', 'reasoning')]]),
			() => responseOf([
				{ type: 'thinking', value: 'fir', id: 'rs_1' },
				{ type: 'thinking', value: 'st', id: 'rs_1' },
				{ type: 'thinking', value: '', id: 'rs_1', metadata: { vscode_reasoning_summary_part_done: true } },
				{ type: 'thinking', value: 'sec', id: 'rs_1' },
				{ type: 'thinking', value: 'ond', id: 'rs_1' },
				{ type: 'thinking', value: '', id: 'rs_1', metadata: { vscode_reasoning_summary_part_done: true } },
				{ type: 'thinking', value: '', id: 'rs_1', metadata: { encrypted_content: 'opaque' } },
			]),
		);
		const handler = createHandler(service);

		const result = await handler.chat({
			vendor: 'customendpoint',
			modelId: 'reasoning',
			input: [],
		}, CancellationToken.None);

		assert.deepStrictEqual(result.output, [{
			type: 'reasoning',
			id: 'rs_1',
			summary: ['first', 'second'],
			encryptedContent: 'opaque',
			metadata: { encrypted_content: 'opaque' },
		}]);
	});

	test('maps ordered Responses input and options to LM API chat messages', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id', byokModel('acme', 'claude')]]),
			() => responseOf([{ type: 'text', value: 'ok' }]),
		);
		const handler = createHandler(service);

		await handler.chat(
			{
				vendor: 'acme',
				modelId: 'claude',
				instructions: 'be helpful',
				previousResponseId: 'resp_previous',
				reasoningEffort: 'high',
				modelOptions: { temperature: 0.5 },
				tools: [
					{ type: 'function', name: 'getWeather', parametersSchema: { type: 'object' } },
					{ type: 'custom', name: 'apply_patch' },
				],
				input: [
					{ type: 'reasoning', id: 'rs_1', summary: ['thought'], encryptedContent: 'opaque' },
					{ type: 'reasoning', id: 'rs_2', summary: ['other thought'], encryptedContent: 'vscode-reasoning-metadata:{"signature":"sig-2","_completeThinking":"other complete thought"}' },
					{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'check' }, { type: 'text', text: 'ing' }] },
					{ type: 'function_call', callId: 't1', name: 'getWeather', argumentsJson: '{"city":"NYC"}' },
					{ type: 'custom_tool_call', callId: 't2', name: 'apply_patch', input: 'patch' },
					{ type: 'function_call_output', callId: 't1', output: 'sunny' },
					{ type: 'custom_tool_call_output', callId: 't2', output: 'Done!' },
					{
						type: 'message',
						role: 'user',
						content: [
							{ type: 'text', text: 'hi' },
							{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
						],
					},
				],
			},
			CancellationToken.None,
		);

		const messages = service.captured?.messages.map(message => ({
			role: message.role,
			content: message.content.map(part => part.type === 'data' ? { ...part, data: part.data.toString() } : part),
		}));
		assert.deepStrictEqual({
			messages,
			options: service.captured?.options,
		}, {
			messages: [
				{ role: ChatMessageRole.Assistant, content: [{ type: 'data', mimeType: 'stateful_marker', data: 'claude\\resp_previous' }] },
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'be helpful' }] },
				{
					role: ChatMessageRole.Assistant,
					content: [
						{ type: 'thinking', value: ['thought'], id: 'rs_1', metadata: { encrypted_content: 'opaque' } },
						{ type: 'thinking', value: ['other thought'], id: 'rs_2', metadata: { signature: 'sig-2', _completeThinking: 'other complete thought' } },
						{ type: 'text', value: 'checking' },
						{ type: 'tool_use', name: 'getWeather', toolCallId: 't1', parameters: { city: 'NYC' } },
						{ type: 'tool_use', name: 'apply_patch', toolCallId: 't2', parameters: { input: 'patch' } },
					],
				},
				{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 't1', value: [{ type: 'text', value: 'sunny' }] }] },
				{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 't2', value: [{ type: 'text', value: 'Done!' }] }] },
				{
					role: ChatMessageRole.User,
					content: [
						{ type: 'text', value: 'hi' },
						{ type: 'image_url', value: { mimeType: 'image/png', data: VSBuffer.fromString('image') } },
					],
				},
			],
			options: {
				modelOptions: { temperature: 0.5 },
				includeEncryptedThinking: true,
				configuration: { reasoningEffort: 'high' },
				tools: [
					{ name: 'getWeather', description: '', inputSchema: { type: 'object' } },
					{ name: 'apply_patch', description: '', inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } },
				],
			},
		});
	});

	test('resolves the provider group and its secret configuration for native routing', async () => {
		const identifier = 'customendpoint/Example/claude-opus-4-6';
		const service = new TestLanguageModelsService(
			new Map([[identifier, byokModel('customendpoint', 'claude-opus-4-6')]]),
			() => responseOf([]),
			Event.None,
			() => false,
			{ name: 'Example', vendor: 'customendpoint', configuration: { apiKey: 'resolved-secret', apiType: 'responses' } },
		);
		const handler = createHandler(service);

		assert.deepStrictEqual(await handler.resolveProviderConfiguration(identifier, CancellationToken.None), {
			modelIdentifier: identifier,
			vendor: 'customendpoint',
			groupName: 'Example',
			modelId: 'claude-opus-4-6',
			configuration: { apiKey: 'resolved-secret', apiType: 'responses' },
		});
	});

	test('returns an error result when no BYOK model matches', async () => {
		const service = new TestLanguageModelsService(new Map(), () => responseOf([]));
		const handler = createHandler(service);

		const result = await handler.chat(
			{ vendor: 'acme', modelId: 'missing', input: [] } satisfies IByokLmChatRequest,
			CancellationToken.None,
		);

		assert.deepStrictEqual(result.output, []);
		assert.ok(result.error?.includes('acme/missing'), `expected error to name the model: ${result.error}`);
	});

	test('returns an error result when the LM request throws', async () => {
		const service = new TestLanguageModelsService(
			new Map([['id', byokModel('acme', 'claude')]]),
			() => { throw new Error('provider exploded'); },
		);
		const handler = createHandler(service);

		const result = await handler.chat(
			{ vendor: 'acme', modelId: 'claude', input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
			CancellationToken.None,
		);

		assert.deepStrictEqual(result, { output: [], error: 'provider exploded' });
	});
});
