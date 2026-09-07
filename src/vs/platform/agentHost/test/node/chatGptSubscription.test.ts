/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CHATGPT_SUBSCRIPTION_MODELS, ChatGptSubscriptionService, chatGptAccountIdFromAccessToken, chatGptSubscriptionAgentModelId, chatGptSubscriptionMaxOutputTokens, parseChatGptSubscriptionModelId } from '../../node/chatGptSubscription.js';
import { Emitter } from '../../../../base/common/event.js';
import { ByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import type { IByokLmModelInfo, IManagedChatGptModelInfo } from '../../common/agentHostByokLm.js';

function accessToken(claims: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.signature`;
}

suite('chatGptSubscription', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('requires a visible configured Provider model as well as a signed-in account', () => {
		const registry = new ByokLmBridgeRegistry();
		const byok = store.add(new Emitter<IByokLmModelInfo[]>());
		const managed = store.add(new Emitter<IManagedChatGptModelInfo[]>());
		const account = store.add(new Emitter<void>());
		let signedIn = true;
		const registration = store.add(registry.register('renderer', {
			chat: async () => { throw new Error('Subscription models must not call the BYOK bridge'); },
			onDidChangeModels: byok.event,
			onDidChangeChatGptModels: managed.event,
		}));
		byok.fire([]);
		const service = store.add(new ChatGptSubscriptionService(registry));
		store.add(service.registerSource({
			onDidChangeSignedIn: account.event,
			isSignedIn: () => signedIn,
			readCredentials: async () => { throw new Error('Catalog reads must not read credentials'); },
		}));
		let changes = 0;
		store.add(service.onDidChangeSignedIn(() => changes++));
		assert.deepStrictEqual(service.getModels(), []);
		managed.fire([{ id: 'gpt-5.6-sol', name: 'Provider model', maxContextWindowTokens: 200000, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }]);
		assert.deepStrictEqual(service.getModels().map(model => [model.id, model.name, model.supportedReasoningEfforts, model.defaultReasoningEffort]), [['gpt-5.6-sol', 'Provider model', ['low', 'high'], 'high']]);
		assert.strictEqual(service.getModels()[0].maxContextWindowTokens, 200000);
		managed.fire([]); // Hiding every model or deleting the Provider revokes the catalog.
		assert.deepStrictEqual(service.getModels(), []);
		managed.fire([{ id: 'gpt-5.6-sol', name: 'Restored model' }]);
		assert.strictEqual(service.getModels().length, 1);
		signedIn = false;
		account.fire();
		assert.deepStrictEqual(service.getModels(), []);
		signedIn = true;
		account.fire();
		assert.strictEqual(service.getModels().length, 1);
		registration.dispose();
		assert.deepStrictEqual(service.getModels(), []);
		assert.ok(changes >= 6);
	});

	test('qualifies subscription model ids so they never collide with BYOK routing ids', () => {
		assert.deepStrictEqual({
			qualified: chatGptSubscriptionAgentModelId('gpt-5.5'),
			roundTrip: parseChatGptSubscriptionModelId(chatGptSubscriptionAgentModelId('gpt-5.5')),
			byokId: parseChatGptSubscriptionModelId('customendpoint/custom/gpt-5.5'),
			otherSource: parseChatGptSubscriptionModelId('@provider=anthropic:claude-opus-4-6'),
			empty: parseChatGptSubscriptionModelId('@provider=chatgpt-subscription:'),
		}, {
			qualified: '@provider=chatgpt-subscription:gpt-5.5',
			roundTrip: { modelId: 'gpt-5.5' },
			byokId: undefined,
			otherSource: undefined,
			empty: undefined,
		});
	});

	test('carries a chosen service tier inside the model id, and the standard one as no tier at all', () => {
		assert.deepStrictEqual({
			qualified: chatGptSubscriptionAgentModelId('gpt-5.5', 'priority'),
			roundTrip: parseChatGptSubscriptionModelId(chatGptSubscriptionAgentModelId('gpt-5.5', 'priority')),
			// The harness sends no tier for the standard one, so no id carries it.
			untiered: parseChatGptSubscriptionModelId(chatGptSubscriptionAgentModelId('gpt-5.5', undefined)),
			// A trailing separator names no tier, and must not become an empty one.
			emptyTier: parseChatGptSubscriptionModelId('@provider=chatgpt-subscription:gpt-5.5?serviceTier='),
			modelless: parseChatGptSubscriptionModelId('@provider=chatgpt-subscription:?serviceTier=priority'),
		}, {
			qualified: '@provider=chatgpt-subscription:gpt-5.5?serviceTier=priority',
			roundTrip: { modelId: 'gpt-5.5', serviceTier: 'priority' },
			untiered: { modelId: 'gpt-5.5' },
			emptyTier: { modelId: 'gpt-5.5' },
			modelless: undefined,
		});
	});

	test('publishes the speed tiers upstream offers, and none for the models that offer none', () => {
		assert.deepStrictEqual(CHATGPT_SUBSCRIPTION_MODELS.map(model => [model.id, model.serviceTiers?.map(tier => `${tier.id}/${tier.name}`)]), [
			['gpt-6-astra', ['priority/Fast']],
			['gpt-5.6-sol', ['priority/Fast']],
			['gpt-5.6-terra', ['priority/Fast']],
			['gpt-5.6-luna', ['priority/Fast']],
			['gpt-5.5', ['priority/Fast']],
			['gpt-5.4', ['priority/Fast']],
			['gpt-5.4-mini', undefined],
			['gpt-5.3-codex-spark', undefined],
		]);
	});

	test('offers the models the subscription publishes for chatting, and none of its internal ones', () => {
		assert.deepStrictEqual(CHATGPT_SUBSCRIPTION_MODELS.map(model => model.id), [
			'gpt-6-astra',
			'gpt-5.6-sol',
			'gpt-5.6-terra',
			'gpt-5.6-luna',
			'gpt-5.5',
			'gpt-5.4',
			'gpt-5.4-mini',
			'gpt-5.3-codex-spark',
		]);
	});

	test('describes every model well enough to run it, and never past its own window', () => {
		assert.deepStrictEqual(CHATGPT_SUBSCRIPTION_MODELS.filter(model =>
			parseChatGptSubscriptionModelId(chatGptSubscriptionAgentModelId(model.id))?.modelId !== model.id
			|| model.name.length === 0
			|| model.maxContextWindowTokens <= 0
			|| chatGptSubscriptionMaxOutputTokens(model) > model.maxContextWindowTokens
			|| !model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
		), []);
	});

	test('reads the account id out of the access token rather than a second source', () => {
		assert.deepStrictEqual({
			chatgpt: chatGptAccountIdFromAccessToken(accessToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } })),
			withoutClaim: chatGptAccountIdFromAccessToken(accessToken({ sub: 'user' })),
			notAToken: chatGptAccountIdFromAccessToken('not-a-json-web-token'),
			empty: chatGptAccountIdFromAccessToken(''),
		}, {
			chatgpt: 'acct-42',
			withoutClaim: undefined,
			notAToken: undefined,
			empty: undefined,
		});
	});
});
