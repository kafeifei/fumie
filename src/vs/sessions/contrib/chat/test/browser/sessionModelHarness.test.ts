/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { SessionTypeAuthRequirement } from '../../../../services/sessions/common/session.js';
import { IProviderSessionType } from '../../../../services/sessions/common/sessionsManagement.js';
import { advertisedHarnessForModel, decodeQualifiedModelId, isClaudeFamilyText, isClaudeHarnessId, mixOfficialSubscriptionModels, modelSlug, persistableModelOnHarness, resolveModelOnHarness } from '../../browser/sessionModelHarness.js';

function model(identifier: string, targetChatSessionType: string, id = identifier.slice(identifier.indexOf(':') + 1)): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id,
			name: id,
			vendor: identifier.slice(0, identifier.indexOf(':')) || 'test',
			version: '1.0',
			family: id,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			isDefaultForLocation: {},
			targetChatSessionType,
		},
	};
}

function type(id: string, chatSessionType: string, providerId = 'local-agent-host'): IProviderSessionType {
	return {
		providerId,
		sessionType: {
			id,
			label: id,
			icon: Codicon.terminal,
			chatSessionType,
			authRequirement: SessionTypeAuthRequirement.None,
		},
	};
}

const advertised = [
	type('codex', 'agent-host-codex'),
	type('claude', 'agent-host-claude'),
	type('kimi', 'agent-host-kimi'),
];

suite('sessionModelHarness', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes vendor, @provider slugs, and URI-encoded ids', () => {
		assert.deepStrictEqual(decodeQualifiedModelId('agent-host-codex:moonshotai/kimi-example'), {
			vendor: 'agent-host-codex',
			slug: 'moonshotai/kimi-example',
		});
		assert.deepStrictEqual(decodeQualifiedModelId('claude:@provider=anthropic:claude-opus-4.6'), {
			vendor: 'claude',
			slug: 'claude-opus-4.6',
		});
		assert.deepStrictEqual(decodeQualifiedModelId('agent-host-codex:@provider=moonshotai:moonshotai%2Fkimi-example'), {
			vendor: 'agent-host-codex',
			slug: 'moonshotai/kimi-example',
		});
	});

	test('maps LiteLLM Kimi slugs onto the advertised Kimi harness, not Codex', () => {
		const kimiOnCodex = model('agent-host-codex:moonshotai/kimi-example', 'agent-host-codex', 'moonshotai/kimi-example');
		assert.deepStrictEqual(advertisedHarnessForModel(kimiOnCodex, advertised), {
			providerId: 'local-agent-host',
			sessionTypeId: 'kimi',
		});
	});

	test('does not send LiteLLM Claude-named slugs to the Claude SDK harness', () => {
		const litellmClaude = model('agent-host-codex:anthropic/claude-sonnet-4', 'agent-host-codex', 'anthropic/claude-sonnet-4');
		assert.deepStrictEqual(advertisedHarnessForModel(litellmClaude, advertised), {
			providerId: 'local-agent-host',
			sessionTypeId: 'codex',
		});
	});

	test('Claude SDK models follow targetChatSessionType onto the Claude harness', () => {
		const sdkClaude = model('agent-host-claude:@provider=anthropic:claude-opus-4.6', 'agent-host-claude', '@provider=anthropic:claude-opus-4.6');
		assert.deepStrictEqual(advertisedHarnessForModel(sdkClaude, advertised), {
			providerId: 'local-agent-host',
			sessionTypeId: 'claude',
		});
	});

	test('falls back to the catalog harness when Kimi is not advertised', () => {
		const kimiOnCodex = model('agent-host-codex:moonshotai/kimi-example', 'agent-host-codex', 'moonshotai/kimi-example');
		assert.deepStrictEqual(advertisedHarnessForModel(kimiOnCodex, [type('codex', 'agent-host-codex')]), {
			providerId: 'local-agent-host',
			sessionTypeId: 'codex',
		});
	});

	test('resolves a Codex Kimi slug onto the Kimi harness model by last path segment', () => {
		const pending = model('agent-host-codex:moonshotai/kimi-example', 'agent-host-codex', 'moonshotai/kimi-example');
		const kimiModel = model('agent-host-kimi:moonshot/kimi-example', 'agent-host-kimi', 'moonshot/kimi-example');
		assert.strictEqual(modelSlug(pending), 'moonshotai/kimi-example');
		assert.strictEqual(resolveModelOnHarness(pending, [kimiModel])?.identifier, kimiModel.identifier);
	});

	test('falls back to the only model on the destination harness', () => {
		const pending = model('agent-host-codex:moonshotai/kimi-example', 'agent-host-codex', 'moonshotai/kimi-example');
		const only = model('agent-host-kimi:kimi-only-model', 'agent-host-kimi', 'kimi-only-model');
		assert.strictEqual(resolveModelOnHarness(pending, [only])?.identifier, only.identifier);
	});

	test('Kimi persists the matching harness model without a fixed model preference', () => {
		const customKimi = model('agent-host-codex:@provider=custom:moonshotai%2Fkimi-example', 'agent-host-codex', '@provider=custom:moonshotai%2Fkimi-example');
		const kimi = model('agent-host-kimi:moonshot/kimi-example', 'agent-host-kimi', 'moonshot/kimi-example');
		const persisted = persistableModelOnHarness(customKimi, [kimi], 'kimi', 'agent-host-kimi');
		assert.strictEqual(persisted.identifier, 'agent-host-kimi:moonshot/kimi-example');
		assert.strictEqual(modelSlug(persisted), 'moonshot/kimi-example');
		assert.ok(!persisted.identifier.includes('agent-host-codex'));
		assert.ok(!persisted.identifier.includes('@provider=custom'));
	});

	test('Kimi retains an exact catalog selection when other models are available', () => {
		const first = model('agent-host-kimi:moonshot/kimi-first', 'agent-host-kimi');
		const selected = model('agent-host-kimi:moonshot/kimi-selected', 'agent-host-kimi');
		assert.strictEqual(persistableModelOnHarness(selected, [first, selected], 'kimi'), selected);
	});

	test('Codex picker mixes official ChatGPT GPT onto the custom 5.6 list', () => {
		const sol = model('agent-host-codex:@provider=custom:codex/gpt-5.6-sol', 'agent-host-codex', '@provider=custom:codex/gpt-5.6-sol');
		const chatgpt = model('agent-host-codex:@provider=openai:gpt-5.6-sol', 'agent-host-codex', '@provider=openai:gpt-5.6-sol');
		const mixed = mixOfficialSubscriptionModels('codex', [sol], [sol, chatgpt], 'agent-host-codex');
		assert.deepStrictEqual(mixed.map(item => item.identifier), [sol.identifier, chatgpt.identifier]);
	});

	test('the Claude harness picker is the harness list plus its subscription rows, untouched', () => {
		// allow-any-unicode-next-line
		const byokOpus = model('agent-host-claude:customendpoint/Example/claude-opus-4-6', 'agent-host-claude', 'customendpoint/Example/claude-opus-4-6');
		const copilot = model('agent-host-claude:@provider=copilot:claude-sonnet-4', 'agent-host-claude', '@provider=copilot:claude-sonnet-4');
		const sdk = model('agent-host-claude:@provider=anthropic:claude-opus-4.6', 'agent-host-claude', '@provider=anthropic:claude-opus-4.6');
		const gpt = model('agent-host-codex:codex/gpt-5.6-sol', 'agent-host-codex', 'codex/gpt-5.6-sol');
		const mixed = mixOfficialSubscriptionModels('claude', [byokOpus], [byokOpus, copilot, sdk, gpt], 'agent-host-claude');
		assert.deepStrictEqual({
			// The native Anthropic SDK row is not mixable, and another harness's
			// row does not belong to this one.
			identifiers: mixed.map(item => item.identifier),
			// Filter only: no row is renamed or re-grouped.
			names: mixed.map(item => item.metadata.name),
		}, {
			identifiers: [byokOpus.identifier, copilot.identifier],
			// allow-any-unicode-next-line
			names: ['customendpoint/Example/claude-opus-4-6', '@provider=copilot:claude-sonnet-4'],
		});
		assert.ok(isClaudeFamilyText('anthropic/claude-sonnet-4'));
		assert.ok(isClaudeHarnessId('claude', 'agent-host-claude'));
	});
});
