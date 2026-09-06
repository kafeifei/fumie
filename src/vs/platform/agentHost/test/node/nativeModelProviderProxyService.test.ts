/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IByokLmProviderConfiguration } from '../../common/agentHostByokLm.js';
import type { IAgentHostProxyResolver } from '../../node/agentHostProxyResolver.js';
import type { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { chatGptSubscriptionAgentModelId, type IChatGptSubscriptionCredentials, type IChatGptSubscriptionService } from '../../node/chatGptSubscription.js';
import { NativeModelProviderProxyService, describeUpstreamModel, readUpstreamModel } from '../../node/nativeModelProviderProxyService.js';

suite('NativeModelProviderProxyService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const modelIdentifier = 'customendpoint/Example/claude-opus-4-6';

	/** Captures `info` so the upstream-model diagnostic can be asserted. */
	class RecordingLogService extends NullLogService {
		readonly infos: string[] = [];
		override info(message: string): void {
			this.infos.push(message);
		}
	}

	/** The proxy logs after the client's body has been flushed; give it a tick. */
	async function upstreamModelLines(log: RecordingLogService): Promise<string[]> {
		for (let attempt = 0; attempt < 100; attempt++) {
			const lines = log.infos.filter(line => line.includes('upstream model:'));
			if (lines.length > 0) {
				return lines;
			}
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		return [];
	}

	function chatGptSubscription(credentials?: IChatGptSubscriptionCredentials): IChatGptSubscriptionService {
		return {
			_serviceBrand: undefined,
			onDidChangeSignedIn: Event.None,
			registerSource: () => Disposable.None,
			isSignedIn: () => !!credentials,
			readCredentials: async () => {
				if (!credentials) {
					throw new Error('No ChatGPT subscription is available in this agent host.');
				}
				return credentials;
			},
		};
	}

	function providerConfiguration(overrides: Partial<IByokLmProviderConfiguration> = {}): IByokLmProviderConfiguration {
		return {
			modelIdentifier,
			vendor: 'customendpoint',
			groupName: 'Example',
			modelId: 'claude-opus-4-6',
			configuration: {
				apiKey: 'real-provider-key',
				apiType: 'responses',
				fumieProvider: 'litellm',
				models: [{ id: 'claude-opus-4-6', url: 'https://provider.test/v1', requestHeaders: { 'X-Provider': 'custom' } }],
			},
			...overrides,
		};
	}

	function registry(configuration: IByokLmProviderConfiguration | undefined): IByokLmBridgeRegistry {
		return {
			_serviceBrand: undefined,
			register: () => Disposable.None,
			getModels: () => [],
			getServingConnection: () => undefined,
			resolveProviderConfiguration: async identifier => identifier === configuration?.modelIdentifier ? configuration : undefined,
			onDidChangeModels: () => Disposable.None,
		};
	}

	test('forwards the native wire unchanged except for the provider-local model id', async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				captured = { url: String(input), init };
				return new Response('event: message\ndata: {"delta":"unchanged"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' } });
			},
		} satisfies IAgentHostProxyResolver;
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(providerConfiguration()), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('messages')}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': `${handle.nonce}.claude`, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify({
					model: modelIdentifier,
					messages: [{ role: 'user', content: 'hello' }],
					tool_choice: { type: 'any' },
					thinking: { type: 'enabled', budget_tokens: 4096 },
					stream: true,
				}),
			});
			assert.strictEqual(response.status, 200);
			const forwardedBody = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
			const forwardedHeaders = captured?.init?.headers as Headers;
			assert.deepStrictEqual({
				url: captured?.url,
				body: forwardedBody,
				authorization: forwardedHeaders.get('Authorization'),
				providerHeader: forwardedHeaders.get('X-Provider'),
				responseEncoding: response.headers.get('Content-Encoding'),
				response: await response.text(),
			}, {
				url: 'https://provider.test/v1/messages',
				body: {
					model: 'claude-opus-4-6',
					messages: [{ role: 'user', content: 'hello' }],
					tool_choice: { type: 'any' },
					thinking: { type: 'enabled', budget_tokens: 4096 },
					stream: true,
				},
				authorization: 'Bearer real-provider-key',
				providerHeader: 'custom',
				responseEncoding: null,
				response: 'event: message\ndata: {"delta":"unchanged"}\n\n',
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('rejects a wire the configured endpoint does not advertise', async () => {
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => { throw new Error('must not fetch'); },
		} satisfies IAgentHostProxyResolver;
		const generic = providerConfiguration({
			configuration: { apiKey: 'key', apiType: 'responses', models: [{ id: 'claude-opus-4-6', url: 'https://provider.test/v1' }] },
		});
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(generic), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('messages')}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.claude` },
				body: JSON.stringify({ model: modelIdentifier, messages: [] }),
			});
			assert.strictEqual(response.status, 400);
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('uses Anthropic authentication for a generic Messages custom endpoint', async () => {
		let capturedHeaders: Headers | undefined;
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async (_input: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = init?.headers as Headers;
				return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
			},
		} satisfies IAgentHostProxyResolver;
		const generic = providerConfiguration({
			configuration: { apiKey: 'anthropic-key', apiType: 'messages', models: [{ id: 'claude-opus-4-6', url: 'https://anthropic.example.test/v1/messages' }] },
		});
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(generic), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('messages')}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': `${handle.nonce}.claude` },
				body: JSON.stringify({ model: modelIdentifier, messages: [] }),
			});
			assert.deepStrictEqual({
				status: response.status,
				xApiKey: capturedHeaders?.get('x-api-key'),
				authorization: capturedHeaders?.get('authorization'),
				anthropicVersion: capturedHeaders?.get('anthropic-version'),
			}, {
				status: 200,
				xApiKey: 'anthropic-key',
				authorization: null,
				anthropicVersion: '2023-06-01',
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('routes a ChatGPT subscription model to the ChatGPT backend as the Codex client', async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				captured = { url: String(input), init };
				return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
			},
		} satisfies IAgentHostProxyResolver;
		const subscription = chatGptSubscription({ accessToken: 'chatgpt-access-token', accountId: 'acct-42', clientVersion: '0.147.0' });
		// No provider group owns the model: the bridge would answer "unknown", and
		// the subscription branch is what has to recognize the id instead.
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(undefined), proxyResolver, subscription);
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('responses')}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.pi`, 'User-Agent': 'pi-sdk/1.0', originator: 'pi' },
				body: JSON.stringify({ model: chatGptSubscriptionAgentModelId('gpt-5.5'), input: 'hello', stream: true, max_output_tokens: 128_000 }),
			});
			const headers = captured?.init?.headers as Headers;
			assert.deepStrictEqual({
				status: response.status,
				url: captured?.url,
				// `max_output_tokens` is gone: this endpoint rejects the whole request over it.
				body: JSON.parse(String(captured?.init?.body)),
				authorization: headers.get('Authorization'),
				originator: headers.get('originator'),
				userAgent: headers.get('User-Agent'),
				accountId: headers.get('ChatGPT-Account-ID'),
				beta: headers.get('OpenAI-Beta'),
			}, {
				status: 200,
				url: 'https://chatgpt.com/backend-api/codex/responses',
				body: { model: 'gpt-5.5', input: 'hello', stream: true },
				authorization: 'Bearer chatgpt-access-token',
				originator: 'codex_cli_rs',
				userAgent: 'codex_cli_rs/0.147.0',
				accountId: 'acct-42',
				beta: 'responses=experimental',
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('turns the service tier carried in a subscription model id back into a body parameter', async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				captured = { url: String(input), init };
				return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
			},
		} satisfies IAgentHostProxyResolver;
		const subscription = chatGptSubscription({ accessToken: 'chatgpt-access-token', accountId: 'acct-42', clientVersion: '0.147.0' });
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(undefined), proxyResolver, subscription);
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('responses')}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.pi` },
				body: JSON.stringify({ model: chatGptSubscriptionAgentModelId('gpt-5.5', 'priority'), input: 'hello', stream: true }),
			});
			assert.deepStrictEqual({
				status: response.status,
				// The tier travelled inside the id, and the model reaching upstream is
				// the plain one it publishes.
				body: JSON.parse(String(captured?.init?.body)),
			}, {
				status: 200,
				body: { model: 'gpt-5.5', input: 'hello', stream: true, service_tier: 'priority' },
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('forwards an upstream rejection body instead of leaving a streaming client with a bare status', async () => {
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => new Response('{"error":{"message":"Unsupported parameter: max_output_tokens","param":"max_output_tokens"}}', {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			}),
		} satisfies IAgentHostProxyResolver;
		const logService = new NullLogService();
		const warnings: string[] = [];
		logService.warn = (message: string) => { warnings.push(message); };
		const subscription = chatGptSubscription({ accessToken: 'chatgpt-access-token', accountId: 'acct-42', clientVersion: '0.147.0' });
		const service = new NativeModelProviderProxyService(logService, registry(undefined), proxyResolver, subscription);
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('responses')}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.pi` },
				body: JSON.stringify({
					model: chatGptSubscriptionAgentModelId('gpt-5.5'),
					instructions: 'you are a coding agent',
					input: [{ role: 'user', content: 'my private prompt' }],
					tools: [{ type: 'function', name: 'bash' }],
					max_output_tokens: 128_000,
					reasoning: { effort: 'medium', summary: 'auto' },
					store: false,
					stream: true,
				}),
			});
			const warning = warnings.find(candidate => candidate.includes('upstream rejected')) ?? '';
			// The upstream's own text names the parameter too, so the "sent" half is
			// the only place that can show whether it was actually forwarded.
			const sent = warning.slice(warning.indexOf('; sent '));
			assert.deepStrictEqual({
				status: response.status,
				body: await response.text(),
				status400: warning.includes('upstream rejected model \'gpt-5.5\' with 400'),
				upstreamDetail: warning.includes('Unsupported parameter: max_output_tokens'),
				// The parameters are the point of the diagnostic: they are what gets rejected.
				parameters: sent.includes('"reasoning":{"effort":"medium","summary":"auto"}') && sent.includes('"store":false'),
				// The log reports what was actually sent, so a stripped parameter is absent from it.
				strippedParameterAbsent: !sent.includes('max_output_tokens'),
				toolNames: warning.includes('"tools":["bash"]'),
				// The payload is the user's, and is never what a 400 is about.
				elidedPrompt: !warning.includes('my private prompt') && warning.includes('"input":"<1 item(s)>"'),
				elidedInstructions: !warning.includes('you are a coding agent') && warning.includes('"instructions":"<22 chars>"'),
				// The credentials travel in request headers, which the diagnostic never reads.
				leakedToken: warning.includes('chatgpt-access-token'),
			}, {
				status: 400,
				body: '{"error":{"message":"Unsupported parameter: max_output_tokens","param":"max_output_tokens"}}',
				status400: true,
				upstreamDetail: true,
				parameters: true,
				strippedParameterAbsent: true,
				toolNames: true,
				elidedPrompt: true,
				elidedInstructions: true,
				leakedToken: false,
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('restates a ChatGPT `detail` rejection under the `error.message` its reader keys on', async () => {
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => new Response('{"detail":"Unsupported parameter: max_output_tokens"}', {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			}),
		} satisfies IAgentHostProxyResolver;
		const subscription = chatGptSubscription({ accessToken: 'chatgpt-access-token', accountId: 'acct-42', clientVersion: '0.147.0' });
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(undefined), proxyResolver, subscription);
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('responses')}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.pi` },
				body: JSON.stringify({ model: chatGptSubscriptionAgentModelId('gpt-5.5'), input: 'hello' }),
			});
			assert.deepStrictEqual({ status: response.status, body: JSON.parse(await response.text()) }, {
				status: 400,
				body: {
					detail: 'Unsupported parameter: max_output_tokens',
					error: { type: 'invalid_request_error', message: 'Unsupported parameter: max_output_tokens' },
				},
			});
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('leaves an error body that already carries an envelope byte for byte', async () => {
		const upstreamBody = '{"error":{"message":"context_length_exceeded","type":"invalid_request_error"}}';
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => new Response(upstreamBody, { status: 400, headers: { 'Content-Type': 'application/json' } }),
		} satisfies IAgentHostProxyResolver;
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(providerConfiguration()), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('messages')}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': `${handle.nonce}.claude` },
				body: JSON.stringify({ model: modelIdentifier, messages: [] }),
			});
			assert.deepStrictEqual({ status: response.status, body: await response.text() }, { status: 400, body: upstreamBody });
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('rejects a ChatGPT subscription model when no subscription is signed in', async () => {
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => { throw new Error('must not fetch'); },
		} satisfies IAgentHostProxyResolver;
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(undefined), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('responses')}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.pi` },
				body: JSON.stringify({ model: chatGptSubscriptionAgentModelId('gpt-5.5'), input: 'hello' }),
			});
			assert.strictEqual(response.status, 400);
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('reads the answering model out of every wire shape it forwards', () => {
		assert.deepStrictEqual({
			anthropic: readUpstreamModel('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6-20260514","content":[]}}\n\n'),
			responses: readUpstreamModel('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5-2026-04-01","output":[]}}\n\n'),
			chatCompletions: readUpstreamModel('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"qwen3-max","choices":[]}\n\n'),
			nonStreaming: readUpstreamModel('{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-6-20260514","content":[]}'),
			truncated: readUpstreamModel('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6-20260514","con'),
			done: readUpstreamModel('data: [DONE]\n\n'),
			silent: readUpstreamModel('event: ping\ndata: {"type":"ping"}\n\n'),
			empty: readUpstreamModel(''),
		}, {
			anthropic: 'claude-opus-4-6-20260514',
			responses: 'gpt-5.5-2026-04-01',
			chatCompletions: 'qwen3-max',
			nonStreaming: 'claude-opus-4-6-20260514',
			truncated: 'claude-opus-4-6-20260514',
			done: undefined,
			silent: undefined,
			empty: undefined,
		});
	});

	test('states whether the answering model is the one that was sent', () => {
		assert.deepStrictEqual([
			describeUpstreamModel(modelIdentifier, 'claude-opus-4-6', 'claude-opus-4-6'),
			describeUpstreamModel(modelIdentifier, 'claude-opus-4-6', 'claude-sonnet-4-6'),
			describeUpstreamModel(modelIdentifier, 'claude-opus-4-6', undefined),
		], [
			`upstream model: sent 'claude-opus-4-6' (routed from '${modelIdentifier}'), upstream reported 'claude-opus-4-6' (same)`,
			`upstream model: sent 'claude-opus-4-6' (routed from '${modelIdentifier}'), upstream reported 'claude-sonnet-4-6' (differs)`,
			`upstream model: sent 'claude-opus-4-6' (routed from '${modelIdentifier}'), upstream reported none`,
		]);
	});

	test('records the answering model once per request without altering the forwarded stream', async () => {
		const frames = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6-20260514","content":[]}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async () => new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					// Split mid-frame: the model must survive chunk boundaries.
					const bytes = new TextEncoder().encode(frames.join(''));
					controller.enqueue(bytes.slice(0, 40));
					controller.enqueue(bytes.slice(40));
					controller.close();
				},
			}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
		} satisfies IAgentHostProxyResolver;
		const log = new RecordingLogService();
		const service = new NativeModelProviderProxyService(log, registry(providerConfiguration()), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			const response = await fetch(`${handle.providerBaseUrl('messages')}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': `${handle.nonce}.claude` },
				body: JSON.stringify({ model: modelIdentifier, messages: [{ role: 'user', content: 'hello' }], stream: true }),
			});
			assert.strictEqual(await response.text(), frames.join(''));
			assert.deepStrictEqual(await upstreamModelLines(log), [
				`[NativeModelProviderProxyService] upstream model: sent 'claude-opus-4-6' (routed from '${modelIdentifier}'), upstream reported 'claude-opus-4-6-20260514' (differs)`,
			]);
		} finally {
			handle.dispose();
			service.dispose();
		}
	});

	test('routes Ollama models over every native wire without forwarding proxy authentication', async () => {
		const ollamaIdentifier = 'ollama/Ollama (Deprecated)/gemma4:31b-mlx';
		const captured: Array<{ url: string; body: Record<string, unknown>; authorization: string | null; xApiKey: string | null }> = [];
		const proxyResolver = {
			_serviceBrand: undefined,
			onDidRegisterConnection: Event.None,
			onDidChangeConfiguration: Event.None,
			register: () => Disposable.None,
			getConfigurationValue: () => undefined,
			resolveProxy: async () => undefined,
			fetch: async (input: string | URL | Request, init?: RequestInit) => {
				const headers = init?.headers as Headers;
				captured.push({
					url: String(input),
					body: JSON.parse(String(init?.body)),
					authorization: headers.get('authorization'),
					xApiKey: headers.get('x-api-key'),
				});
				return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
			},
		} satisfies IAgentHostProxyResolver;
		const ollama: IByokLmProviderConfiguration = {
			modelIdentifier: ollamaIdentifier,
			vendor: 'ollama',
			groupName: 'Ollama (Deprecated)',
			modelId: 'gemma4:31b-mlx',
			configuration: { url: 'http://127.0.0.1:11434' },
		};
		const service = new NativeModelProviderProxyService(new NullLogService(), registry(ollama), proxyResolver, chatGptSubscription());
		const handle = await service.start();
		try {
			for (const { wire, suffix, body } of [
				{ wire: 'responses' as const, suffix: '/v1/responses', body: { model: ollamaIdentifier, input: 'hello' } },
				{ wire: 'messages' as const, suffix: '/v1/messages', body: { model: ollamaIdentifier, messages: [] } },
				{ wire: 'chat-completions' as const, suffix: '/chat/completions', body: { model: ollamaIdentifier, messages: [] } },
			]) {
				const response = await fetch(`${handle.providerBaseUrl(wire)}${suffix}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle.nonce}.session` },
					body: JSON.stringify(body),
				});
				assert.strictEqual(response.status, 200);
			}
			assert.deepStrictEqual(captured, [
				{ url: 'http://127.0.0.1:11434/v1/responses', body: { model: 'gemma4:31b-mlx', input: 'hello' }, authorization: null, xApiKey: null },
				{ url: 'http://127.0.0.1:11434/v1/messages', body: { model: 'gemma4:31b-mlx', messages: [] }, authorization: null, xApiKey: null },
				{ url: 'http://127.0.0.1:11434/v1/chat/completions', body: { model: 'gemma4:31b-mlx', messages: [] }, authorization: null, xApiKey: null },
			]);
		} finally {
			handle.dispose();
			service.dispose();
		}
	});
});
