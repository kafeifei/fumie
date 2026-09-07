/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelGroupMeta, createAgentModelSourceMeta } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC, CLAUDE_PROVIDER_COPILOT } from '../../../../../../platform/agentHost/common/claudeProviders.js';
import { AgentInfo, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { CLAUDE_SUBSCRIPTION_DEFINITION, CODEX_SUBSCRIPTION_DEFINITION, SubscriptionLanguageModelProvider, createSubscriptionVendorDescriptor, subscriptionModelsFrom } from '../../browser/subscriptionModelProviders.js';

suite('subscriptionModelProviders', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function claudeModel(id: string, provider: string): SessionModelInfo {
		return { id: `@provider=${provider}:${id}`, provider: 'claude', name: id, _meta: createAgentModelGroupMeta(provider) };
	}

	function codexModel(id: string, fromSubscription: boolean): SessionModelInfo {
		const meta = createAgentModelSourceMeta(fromSubscription ? CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID : undefined);
		return { id, provider: 'chatgpt', name: id, ...(meta && { _meta: meta }) };
	}

	function agent(provider: string, models: SessionModelInfo[]): AgentInfo {
		return { provider, displayName: provider, description: provider, models };
	}

	test('takes the Claude subscription models out of the merged catalog by transport, leaving the proxy half', () => {
		const agents = [agent('claude', [
			claudeModel('claude-opus', CLAUDE_PROVIDER_ANTHROPIC),
			claudeModel('claude-opus', CLAUDE_PROVIDER_COPILOT),
			claudeModel('claude-sonnet', CLAUDE_PROVIDER_ANTHROPIC),
			{ id: 'custom/claude-opus', provider: 'claude', name: 'Custom Opus' },
		])];

		assert.deepStrictEqual(
			subscriptionModelsFrom(agents, CLAUDE_SUBSCRIPTION_DEFINITION).map(model => model.id),
			['@provider=anthropic:claude-opus', '@provider=anthropic:claude-sonnet'],
		);
	});

	test('takes the Codex subscription models by source id, leaving the BYOK projections', () => {
		const agents = [agent('codex', [
			codexModel('@provider=openai:gpt-5', true),
			codexModel('custom/gpt-5', false),
		])];

		assert.deepStrictEqual(
			subscriptionModelsFrom(agents, CODEX_SUBSCRIPTION_DEFINITION).map(model => model.id),
			['@provider=openai:gpt-5'],
		);
	});

	test('yields nothing while the agent that publishes the catalog is absent', () => {
		assert.deepStrictEqual(subscriptionModelsFrom([agent('codex', [])], CLAUDE_SUBSCRIPTION_DEFINITION), []);
		assert.deepStrictEqual(subscriptionModelsFrom([], CODEX_SUBSCRIPTION_DEFINITION), []);
	});

	test('offers each subscription once, configured by name alone', () => {
		assert.deepStrictEqual(
			[CLAUDE_SUBSCRIPTION_DEFINITION, CODEX_SUBSCRIPTION_DEFINITION].map(definition => {
				const { vendor, singleton, configuration } = createSubscriptionVendorDescriptor(definition);
				return { vendor, singleton, properties: configuration?.properties };
			}),
			[
				{ vendor: 'claude-subscription', singleton: true, properties: {} },
				{ vendor: 'codex-subscription', singleton: true, properties: {} },
			],
		);
	});

	test('supplies models and account status to the added entry only, never to the group-less pass', async () => {
		const provider = store.add(new SubscriptionLanguageModelProvider(CLAUDE_SUBSCRIPTION_DEFINITION));
		provider.updateModels([claudeModel('claude-opus', CLAUDE_PROVIDER_ANTHROPIC)]);

		const groupless = {
			models: await provider.provideLanguageModelChatInfo({ silent: true }, CancellationToken.None),
			status: await provider.provideLanguageModelChatStatus({ silent: true }, CancellationToken.None),
		};
		const grouped = await provider.provideLanguageModelChatInfo({ group: 'Claude Subscription', silent: true }, CancellationToken.None);

		assert.deepStrictEqual({
			groupless,
			grouped: grouped.map(model => ({ identifier: model.identifier, sessionType: model.metadata.targetChatSessionType })),
		}, {
			groupless: { models: [], status: undefined },
			grouped: [{
				identifier: 'claude-subscription:@provider=anthropic:claude-opus',
				sessionType: 'agent-host-claude',
			}],
		});
	});

	test('reports an empty catalog for the added entry, so the row can offer a sign-in', async () => {
		const provider = store.add(new SubscriptionLanguageModelProvider(CODEX_SUBSCRIPTION_DEFINITION));
		provider.updateModels([]);

		const options = { group: 'Codex Subscription', silent: true };
		const status = await provider.provideLanguageModelChatStatus(options, CancellationToken.None);

		assert.deepStrictEqual({
			models: await provider.provideLanguageModelChatInfo(options, CancellationToken.None),
			message: status?.message,
		}, {
			models: [],
			message: 'No models available',
		});
	});

	test('marks Codex subscription rows as the local canonical visibility owners only', async () => {
		const codex = store.add(new SubscriptionLanguageModelProvider(CODEX_SUBSCRIPTION_DEFINITION));
		codex.updateModels([{ ...codexModel('@provider=openai:gpt-test', true), underlyingModelId: 'gpt-test' }]);
		const claude = store.add(new SubscriptionLanguageModelProvider(CLAUDE_SUBSCRIPTION_DEFINITION));
		claude.updateModels([claudeModel('claude-opus', CLAUDE_PROVIDER_ANTHROPIC)]);

		const codexRows = await codex.provideLanguageModelChatInfo({ group: 'Codex Subscription', silent: true }, CancellationToken.None);
		const claudeRows = await claude.provideLanguageModelChatInfo({ group: 'Claude Subscription', silent: true }, CancellationToken.None);
		assert.deepStrictEqual(codexRows[0].metadata.sourceModel, {
			sourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID,
			modelId: 'gpt-test',
			visibilityNamespace: 'local',
			visibilityOwner: true,
		});
		assert.strictEqual(claudeRows[0].metadata.sourceModel, undefined);
	});
});
