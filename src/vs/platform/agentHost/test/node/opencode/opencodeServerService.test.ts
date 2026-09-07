/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { RequestListener } from 'http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IByokLmModelInfo } from '../../../common/agentHostByokLm.js';
import type { IByokLmBridgeRegistry } from '../../../node/byokLmBridgeRegistry.js';
import { CHATGPT_SUBSCRIPTION_MODELS, CHATGPT_SUBSCRIPTION_PROVIDER_NAME, chatGptSubscriptionAgentModelId } from '../../../node/chatGptSubscription.js';
import type { IChatGptSubscriptionService } from '../../../node/chatGptSubscription.js';
import type { INativeModelProviderProxyHandle } from '../../../node/nativeModelProviderProxyService.js';
import { OPENCODE_BYOK_PROVIDER_ID, OpencodeServerService, opencodeProviderConfig, requestOpencode, type IOpencodeServer } from '../../../node/opencode/opencodeServerService.js';

suite('Opencode ChatGPT subscription provider config', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses a proxy-valid credential and keeps the provider-local and wire ids separate', () => {
		const handle: INativeModelProviderProxyHandle = {
			baseUrl: 'http://127.0.0.1:9876',
			nonce: 'NATIVE-NONCE',
			providerBaseUrl: wire => `http://127.0.0.1:9876/${wire}`,
			dispose: () => { },
		};
		const config = opencodeProviderConfig(handle, {
			byok: [
				{ model: { vendor: 'customendpoint', id: 'responses-model', supportedHarnesses: ['opencode'], supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }, modelIdentifier: 'customendpoint/Test/responses-model', wire: 'responses' },
				{ model: { vendor: 'customendpoint', id: 'messages-model', supportedHarnesses: ['opencode'] }, modelIdentifier: 'customendpoint/Test/messages-model', wire: 'messages' },
				{ model: { vendor: 'ollama', id: 'chat-model', supportedHarnesses: ['opencode'] }, modelIdentifier: 'ollama/Ollama/chat-model', wire: 'chat-completions' },
			],
			chatGpt: [CHATGPT_SUBSCRIPTION_MODELS[0]],
		}) as {
			enabled_providers: string[];
			model: string;
			small_model: string;
			provider: Record<string, { options: { baseURL?: string; apiKey: string }; models: Record<string, { id: string; provider?: { npm: string; api: string }; options: Record<string, unknown>; variants: Record<string, unknown>; limit: { context: number; output: number } }> }>;
		};
		assert.deepStrictEqual(config.enabled_providers, [OPENCODE_BYOK_PROVIDER_ID, CHATGPT_SUBSCRIPTION_PROVIDER_NAME]);
		assert.strictEqual(config.model, `${OPENCODE_BYOK_PROVIDER_ID}/customendpoint/Test/responses-model`);
		assert.strictEqual(config.small_model, config.model);
		const byok = config.provider[OPENCODE_BYOK_PROVIDER_ID];
		assert.deepStrictEqual(byok.options, { apiKey: 'NATIVE-NONCE.opencode' }, 'mixed-wire provider has no global baseURL override');
		assert.deepStrictEqual(byok.models['customendpoint/Test/responses-model'].provider, { npm: '@ai-sdk/openai', api: 'http://127.0.0.1:9876/responses' });
		assert.deepStrictEqual(byok.models['customendpoint/Test/messages-model'].provider, { npm: '@ai-sdk/anthropic', api: 'http://127.0.0.1:9876/messages' });
		assert.deepStrictEqual(byok.models['ollama/Ollama/chat-model'].provider, { npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:9876/chat-completions' });
		const provider = config.provider[CHATGPT_SUBSCRIPTION_PROVIDER_NAME];
		assert.deepStrictEqual(provider.options, {
			baseURL: 'http://127.0.0.1:9876/responses',
			apiKey: 'NATIVE-NONCE.opencode',
		});
		const subscription = CHATGPT_SUBSCRIPTION_MODELS[0];
		assert.strictEqual(provider.models[subscription.id].id, chatGptSubscriptionAgentModelId(subscription.id));
		assert.deepStrictEqual(provider.models[subscription.id].options, { reasoningEffort: subscription.defaultReasoningEffort });
		assert.deepStrictEqual(Object.keys(provider.models[subscription.id].variants), subscription.supportedReasoningEfforts);
	});
});

suite('Opencode server generations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let model: IByokLmModelInfo;
	let disposed: string[];
	let started: TestServer[];

	class TestServer implements IOpencodeServer {
		closed = false;
		readonly baseUrl: string;
		readonly onDidReceiveEvent = Event.None;
		readonly onDidClose = Event.None;
		constructor(readonly cwd: string, readonly signature: string) { this.baseUrl = `test://${started.length}`; }
		request<T>(): Promise<T> { return Promise.reject(new Error('unused')); }
		dispose(): void { if (!this.closed) { this.closed = true; disposed.push(this.signature); } }
	}

	function createService(start: (cwd: string, signature: string) => Promise<TestServer> = async (cwd, signature) => {
		const server = new TestServer(cwd, signature);
		started.push(server);
		return server;
	}): OpencodeServerService {
		const registry: IByokLmBridgeRegistry = {
			_serviceBrand: undefined,
			register: () => Disposable.None,
			getModels: () => [model],
			getServingConnection: () => undefined,
			resolveProviderConfiguration: async modelIdentifier => ({ modelIdentifier, vendor: model.vendor, groupName: 'Test', modelId: model.id, configuration: { apiType: 'chat-completions' } }),
			onDidChangeModels: () => Disposable.None,
		};
		const subscription: IChatGptSubscriptionService = {
			_serviceBrand: undefined, onDidChangeSignedIn: Event.None, registerSource: () => Disposable.None,
			isSignedIn: () => false, getModels: () => [], readCredentials: async () => { throw new Error('unused'); },
		};
		return new OpencodeServerService(new NullLogService(), { _serviceBrand: undefined, start: async () => { throw new Error('unused'); }, dispose() { } }, registry, subscription, { start });
	}

	setup(() => {
		model = { vendor: 'customendpoint', id: 'one', modelIdentifier: 'customendpoint/Test/one', supportedHarnesses: ['opencode'] };
		disposed = [];
		started = [];
	});

	test('keeps a busy old generation until its lease is released', async () => {
		const service = createService();
		const old = await service.acquire('/workspace');
		assert.strictEqual(service.isModelAvailable(old, `${OPENCODE_BYOK_PROVIDER_ID}/customendpoint/Test/one`), true);
		model = { ...model, id: 'two', modelIdentifier: 'customendpoint/Test/two' };
		const current = await service.acquire('/workspace');
		assert.notStrictEqual(current, old);
		assert.strictEqual(service.isModelAvailable(old, `${OPENCODE_BYOK_PROVIDER_ID}/customendpoint/Test/two`), false);
		assert.strictEqual(service.isModelAvailable(current, `${OPENCODE_BYOK_PROVIDER_ID}/customendpoint/Test/two`), true);
		assert.strictEqual((old as TestServer).closed, false);
		service.release(old);
		assert.strictEqual((old as TestServer).closed, true);
		assert.strictEqual((current as TestServer).closed, false);
		service.release(current);
		await service.close();
		assert.strictEqual((current as TestServer).closed, true);
	});

	test('close waits for an in-flight start and disposes the late server', async () => {
		const starting = new DeferredPromise<TestServer>();
		const service = createService((_cwd, _signature) => starting.p);
		const acquire = service.acquire('/workspace');
		await new Promise<void>(resolve => setImmediate(resolve));
		const closing = service.close();
		let closeFinished = false;
		void closing.then(() => closeFinished = true);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.strictEqual(closeFinished, false);
		const server = new TestServer('/workspace', 'late');
		await starting.complete(server);
		await acquire;
		await closing;
		assert.strictEqual(server.closed, true);
		await assert.rejects(service.acquire('/workspace'), /closed/);
	});
});

suite('Opencode HTTP turn lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// This suite runs serially: changing the dispatcher models the ordinary
	// HTTP timeout without waiting five minutes for each regression check.
	async function withServer(handler: RequestListener, run: (baseUrl: string) => Promise<void>): Promise<void> {
		const previousDispatcher = getGlobalDispatcher();
		const dispatcher = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
		const { createServer } = await import('http');
		const server = createServer(handler);
		try {
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			setGlobalDispatcher(dispatcher);
			await run(`http://127.0.0.1:${address.port}`);
		} finally {
			setGlobalDispatcher(previousDispatcher);
			await dispatcher.destroy();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	test('waits for a turn past the default response header and body timeouts', async function () {
		this.timeout(10_000);
		await withServer((request, response) => {
			assert.strictEqual(request.method, 'POST');
			assert.strictEqual(request.url, '/session/long-turn/message');
			// Undici checks short timeouts on a coarse timer; exceed its tick.
			const headers = setTimeout(() => {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.write('{"finished":');
				const body = setTimeout(() => response.end('true}'), 1500);
				response.once('close', () => clearTimeout(body));
			}, 1500);
			response.once('close', () => clearTimeout(headers));
		}, async baseUrl => {
			assert.deepStrictEqual(await requestOpencode(baseUrl, 'Basic test', 'POST', '/session/long-turn/message', { parts: [] }), { finished: true });
		});
	});

	test('retains the default timeout for ordinary GET requests', async function () {
		this.timeout(5000);
		await withServer((_request, _response) => { }, async baseUrl => {
			await assert.rejects(requestOpencode(baseUrl, 'Basic test', 'GET', '/session/status'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
		});
	});

	test('still aborts a long turn when its cancellation signal fires', async () => {
		const controller = new AbortController();
		await withServer((_request, _response) => controller.abort(), async baseUrl => {
			await assert.rejects(requestOpencode(baseUrl, 'Basic test', 'POST', '/session/cancel-turn/message', { parts: [] }, controller.signal), { name: 'AbortError' });
		});
	});
});
