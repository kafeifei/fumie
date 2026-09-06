/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../../platform/agentHost/common/agentModelSource.js';
import { IModelConfigurationAccess, IModelPickerDelegate } from '../../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { getModelProviderIcon } from '../../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelProviderIcons.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { adaptSessionModelPickerDelegate, catalogProviderToken, isMixableOfficialSubscriptionModel, isOfficialSubscriptionModel, presentSessionPickerModels } from '../../browser/sessionModelPickerPresentation.js';

function model(identifier: string, id: string, extra?: Partial<ILanguageModelChatMetadata>): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id,
			name: extra?.name ?? id,
			vendor: identifier.slice(0, identifier.indexOf(':')) || 'test',
			version: '1.0',
			family: extra?.family ?? id,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			isDefaultForLocation: {},
			...extra,
		},
	};
}

suite('sessionModelPickerPresentation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('identifies subscriptions from provider metadata, not model display names', () => {
		const customGpt = model('agent-host-codex:@provider=custom:codex/gpt-5.6-sol', '@provider=custom:codex/gpt-5.6-sol', { name: 'GPT-5.6 Sol' });
		const customClaude = model('agent-host-claude:@provider=custom:claude-opus-4-8', '@provider=custom:claude-opus-4-8', { name: 'Claude Opus 4.8' });
		const grouped = model('agent-host-claude:claude-opus-4-8', 'claude-opus-4-8', { name: 'Claude Opus 4.8', modelGroup: { id: 'custom' } });
		const chatgpt = model('agent-host-codex:@provider=openai:gpt-5.6-sol', '@provider=openai:gpt-5.6-sol', {
			name: 'GPT-5.6 Sol',
			modelGroup: { id: 'chatgpt', sourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID },
		});
		const copilot = model('agent-host-codex:@provider=vscode-proxy:gpt-5.6-sol', '@provider=vscode-proxy:gpt-5.6-sol', { name: 'GPT-5.6 Sol' });
		const anthropic = model('agent-host-claude:@provider=anthropic:claude-opus-4.6', '@provider=anthropic:claude-opus-4.6', { name: 'Claude Opus 4.6' });
		const unnamedCodex = model('agent-host-codex:codex/gpt-5.6-sol', 'codex/gpt-5.6-sol', { name: 'GPT-5.6 Sol' });

		assert.deepStrictEqual([
			catalogProviderToken(customGpt),
			isOfficialSubscriptionModel(customGpt),
			isOfficialSubscriptionModel(customClaude),
			isOfficialSubscriptionModel(grouped),
			isOfficialSubscriptionModel(chatgpt),
			isOfficialSubscriptionModel(copilot),
			isOfficialSubscriptionModel(anthropic),
			isOfficialSubscriptionModel(unnamedCodex),
		], ['custom', false, false, false, true, true, true, false]);
	});

	test('mixed picker uses provider icons and preserves catalog names', () => {
		const custom = model('agent-host-codex:@provider=custom:codex/gpt-5.6-sol', '@provider=custom:codex/gpt-5.6-sol', { name: 'GPT-5.6 Sol' });
		// allow-any-unicode-next-line
		const alreadySuffixed = model('agent-host-codex:@provider=custom:claude-opus-4-8', '@provider=custom:claude-opus-4-8', { name: 'Claude Opus 4.8 · Preview' });
		const chatgpt = model('agent-host-codex:@provider=openai:gpt-5.6-sol', '@provider=openai:gpt-5.6-sol', {
			name: 'GPT-5.6 Sol',
			modelGroup: { id: 'chatgpt', sourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID },
		});
		const copilot = model('agent-host-codex:@provider=vscode-proxy:gpt-5.6-sol', '@provider=vscode-proxy:gpt-5.6-sol', { name: 'GPT-5.6 Sol' });
		const anthropic = model('agent-host-claude:@provider=anthropic:claude-opus-4.6', '@provider=anthropic:claude-opus-4.6', { name: 'Claude Opus 4.6' });
		const presented = presentSessionPickerModels([custom, alreadySuffixed, chatgpt, copilot, anthropic]);

		assert.deepStrictEqual(presented.map(item => ({
			id: item.identifier,
			name: item.metadata.name,
			icon: item.metadata.statusIcon?.id,
		})), [
			{ id: custom.identifier, name: 'GPT-5.6 Sol', icon: getModelProviderIcon(custom).id },
			// allow-any-unicode-next-line
			{ id: alreadySuffixed.identifier, name: 'Claude Opus 4.8 · Preview', icon: getModelProviderIcon(alreadySuffixed).id },
			{ id: chatgpt.identifier, name: 'GPT-5.6 Sol', icon: Codicon.openai.id },
			{ id: copilot.identifier, name: 'GPT-5.6 Sol', icon: Codicon.copilotCompact.id },
			{ id: anthropic.identifier, name: 'Claude Opus 4.6', icon: Codicon.claude.id },
		]);
	});

	test('Kimi catalog rows use their provider icons and remain non-subscription', () => {
		const kimi = model('agent-host-kimi:moonshot/kimi-example', 'moonshot/kimi-example', { name: 'Kimi Example' });
		const custom = model('agent-host-codex:@provider=custom:moonshotai%2Fkimi-example', '@provider=custom:moonshotai%2Fkimi-example', { name: 'Kimi Example' });
		for (const source of [kimi, custom]) {
			const presented = presentSessionPickerModels([source])[0];
			assert.strictEqual(presented.metadata.statusIcon, getModelProviderIcon(source));
			assert.strictEqual(presented.metadata.name, source.metadata.name);
			assert.strictEqual(isOfficialSubscriptionModel(source), false);
			assert.strictEqual(isMixableOfficialSubscriptionModel(source), false);
		}
	});

	test('custom endpoint groups preserve configured icons and remain non-subscription', () => {
		const byok = model('agent-host-claude:customendpoint/Example/claude-example', 'customendpoint/Example/claude-example', {
			name: 'Custom Claude',
			modelGroup: { id: 'customendpoint' },
			byokModelIdentifier: 'customendpoint/Example/claude-example',
			statusIcon: Codicon.starFull,
		});
		const catalog = [byok];
		assert.strictEqual(presentSessionPickerModels(catalog), catalog);
		assert.strictEqual(isOfficialSubscriptionModel(byok), false);
		assert.strictEqual(isMixableOfficialSubscriptionModel(byok), false);
	});

	test('delegate adapter projects presentation and preserves native state callbacks', async () => {
		const custom = model('agent-host-codex:@provider=custom:codex/gpt-5.6-sol', '@provider=custom:codex/gpt-5.6-sol', {
			name: 'GPT-5.6 Sol',
			modelGroup: { id: 'custom' },
		});
		const configured = model('agent-host-codex:configured', 'configured', {
			name: 'Configured',
			statusIcon: Codicon.starFull,
		});
		const auto = model('copilot/auto', 'auto', { name: 'Auto', detail: 'Automatic routing' });
		const catalog = [custom, configured, auto];
		let selected: ILanguageModelChatMetadataAndIdentifier | undefined;
		const configuration: IModelConfigurationAccess = {
			getModelConfiguration: () => undefined,
			setModelConfiguration: async () => { },
			getModelConfigurationActions: () => [],
		};
		const delegate: IModelPickerDelegate = {
			currentModel: observableValue('sessionModelPickerPresentation.test', custom),
			setModel: value => selected = value,
			getModels: () => catalog,
			getPresentationOptions: () => ({
				useGroupedModelPicker: true,
				showManageModelsAction: true,
				showUnavailableFeatured: true,
				showFeatured: true,
				showAutoModel: true,
				showModelIcon: false,
			}),
			getChatSessionId: () => 'session-id',
			isCacheWarm: () => true,
			modelConfiguration: configuration,
		};

		const adapted = adaptSessionModelPickerDelegate(delegate);
		const presented = adapted.getModels();
		const current = adapted.currentModel.get();

		assert.deepStrictEqual(presented.map(item => ({
			identifier: item.identifier,
			name: item.metadata.name,
			group: item.metadata.modelGroup?.id,
			icon: item.metadata.statusIcon?.id,
		})), [
			{ identifier: custom.identifier, name: 'GPT-5.6 Sol', group: 'custom', icon: getModelProviderIcon(custom).id },
			{ identifier: configured.identifier, name: 'Configured', group: undefined, icon: Codicon.starFull.id },
			{ identifier: auto.identifier, name: 'Auto', group: undefined, icon: undefined },
		]);
		assert.strictEqual(current?.metadata.statusIcon, presented[0].metadata.statusIcon);
		assert.strictEqual(custom.metadata.statusIcon, undefined, 'the source catalog row must remain unchanged');
		assert.strictEqual(configured.metadata.statusIcon, Codicon.starFull, 'an existing catalog icon must remain unchanged');
		assert.strictEqual(presented[2], auto, 'Auto must keep its original metadata object');

		adapted.setModel(presented[2]);
		assert.strictEqual(selected, auto, 'Auto selection must return the native Auto model unchanged');
		adapted.setModel(presented[0]);
		assert.strictEqual(selected, custom, 'selection must return the source catalog row to the native delegate');
		assert.deepStrictEqual(adapted.getPresentationOptions(), {
			useGroupedModelPicker: false,
			showManageModelsAction: true,
			showUnavailableFeatured: false,
			showFeatured: false,
			showAutoModel: true,
			showModelIcon: true,
		});
		assert.strictEqual(adapted.getChatSessionId?.(), 'session-id');
		assert.strictEqual(adapted.isCacheWarm?.(), true);
		assert.strictEqual(adapted.modelConfiguration, configuration);
		await adapted.modelConfiguration?.setModelConfiguration(custom.identifier, {});
	});

	test('Anthropic SDK rows are official for icons but not mixable into the custom picker', () => {
		const anthropic = model('agent-host-claude:@provider=anthropic:claude-opus-4.6', '@provider=anthropic:claude-opus-4.6', { name: 'Claude Opus 4.6' });
		const copilot = model('agent-host-claude:@provider=copilot:claude-sonnet-4', '@provider=copilot:claude-sonnet-4', { name: 'Claude Sonnet 4' });
		assert.deepStrictEqual([
			isOfficialSubscriptionModel(anthropic),
			isMixableOfficialSubscriptionModel(anthropic),
			isOfficialSubscriptionModel(copilot),
			isMixableOfficialSubscriptionModel(copilot),
		], [true, false, true, true]);
	});
});
