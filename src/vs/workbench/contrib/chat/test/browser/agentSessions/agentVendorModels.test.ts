/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelGroupMeta, createAgentModelSourceMeta, isSubscriptionCatalogModel } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC, CLAUDE_PROVIDER_COPILOT } from '../../../../../../platform/agentHost/common/claudeProviders.js';
import { AgentInfo, SessionModelInfo } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { agentVendorModels } from '../../../browser/agentSessions/agentHost/agentHostLanguageModelProvider.js';

suite('agentVendorModels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function agent(provider: string, models: SessionModelInfo[]): AgentInfo {
		return { provider, displayName: provider, description: provider, models };
	}

	function claudeModel(id: string, transport: string): SessionModelInfo {
		return { id: `@provider=${transport}:${id}`, provider: 'claude', name: id, _meta: createAgentModelGroupMeta(transport) };
	}

	test('registers the Claude subscription half unselectable and offers the gateway and projected rows', () => {
		const models = agentVendorModels(agent('claude', [
			claudeModel('claude-opus', CLAUDE_PROVIDER_ANTHROPIC),
			claudeModel('claude-opus', CLAUDE_PROVIDER_COPILOT),
			{ id: 'custom/claude-opus', provider: 'claude', name: 'Custom Opus' },
		]));

		// Every row the agent published is still here — the catalog states what the
		// agent can run — but the subscription's is not one the picker may offer.
		assert.deepStrictEqual(models.map(m => [m.id, m.isUserSelectable]), [
			['@provider=anthropic:claude-opus', false],
			['@provider=copilot:claude-opus', undefined],
			['custom/claude-opus', undefined],
		]);
	});

	test('registers the ChatGPT subscription rows unselectable and offers the BYOK projections', () => {
		const subscription = createAgentModelSourceMeta(CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID);
		const models = agentVendorModels(agent('codex', [
			{ id: '@provider=openai:gpt-5', provider: 'chatgpt', name: 'GPT-5', ...(subscription && { _meta: subscription }) },
			{ id: 'custom/gpt-5', provider: 'chatgpt', name: 'Custom GPT-5' },
		]));

		assert.deepStrictEqual(models.map(m => [m.id, m.isUserSelectable]), [
			['@provider=openai:gpt-5', false],
			['custom/gpt-5', undefined],
		]);
	});

	test('an agent with no subscription of its own offers every row it published', () => {
		const models: SessionModelInfo[] = [
			{ id: 'auto', provider: 'copilotcli', name: 'Auto' },
			// The marks the two subscription agents use mean nothing on another agent.
			{ id: 'other', provider: 'copilotcli', name: 'Other', _meta: createAgentModelGroupMeta(CLAUDE_PROVIDER_ANTHROPIC) },
		];
		assert.deepStrictEqual(agentVendorModels(agent('copilotcli', models)).map(m => [m.id, m.isUserSelectable]), [
			['auto', undefined],
			['other', undefined],
		]);
	});

	test('the predicate reads each agent by the mark that agent actually stamps', () => {
		const anthropicGrouped = { id: 'x', provider: 'p', name: 'x', _meta: createAgentModelGroupMeta(CLAUDE_PROVIDER_ANTHROPIC) };
		const chatGptSourced = { id: 'y', provider: 'p', name: 'y', _meta: { modelSourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } };

		assert.deepStrictEqual({
			claudeOnItsOwnMark: isSubscriptionCatalogModel('claude', anthropicGrouped),
			claudeOnCodexMark: isSubscriptionCatalogModel('claude', chatGptSourced),
			codexOnItsOwnMark: isSubscriptionCatalogModel('codex', chatGptSourced),
			codexOnClaudeMark: isSubscriptionCatalogModel('codex', anthropicGrouped),
			unknownAgent: isSubscriptionCatalogModel('copilotcli', anthropicGrouped),
		}, {
			claudeOnItsOwnMark: true,
			claudeOnCodexMark: false,
			codexOnItsOwnMark: true,
			codexOnClaudeMark: false,
			unknownAgent: false,
		});
	});
});
