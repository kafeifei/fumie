/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { IChatPhoneInputSessionContext } from '../../../../../../workbench/contrib/chat/browser/widget/input/chatPhoneInputPresenter.js';
import { IModelConfigurationAccess } from '../../../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier } from '../../../../../../workbench/contrib/chat/common/languageModels.js';
import { IAgentHostSessionsProvider } from '../../../../../common/agentHostSessionsProvider.js';
import { buildAgentHostSheetItems, createMobileModelConfigurationSheetItems } from '../../browser/mobile/mobileChatPhoneInputPresenter.js';

function createModel(withConfiguration: boolean): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: 'codex/gpt-5.6-sol',
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id: 'gpt-5.6-sol',
			name: 'GPT-5.6 Sol',
			vendor: 'codex',
			version: '1.0',
			family: 'gpt-5.6',
			maxInputTokens: 400000,
			maxOutputTokens: 128000,
			isDefaultForLocation: {},
			...(withConfiguration ? {
				configurationSchema: {
					properties: {
						thinkingLevel: { type: 'string', title: 'Thinking Effort', group: 'navigation', enum: ['medium', 'high'], enumItemLabels: ['Medium', 'High'], default: 'medium' },
						serviceTier: { type: 'string', title: 'Speed', group: 'performance', enum: ['standard', 'priority'], enumItemLabels: ['Standard', 'Fast'], enumDescriptions: ['Default speed and usage', '1.5x speed, increased usage'], default: 'standard' },
						contextSize: { type: 'number', title: 'Context Size', group: 'tokens', enum: [65536, 400000], enumItemLabels: ['64K', '400K'], default: 65536 },
					},
				},
			} : {}),
		} as ILanguageModelChatMetadata,
	};
}

/** A session whose model the provider never published, as in a remote agent-host chat. */
function createSessionContext(modelId: string | undefined): IChatPhoneInputSessionContext {
	return {
		providerId: 'agenthost-host',
		sessionId: 'agenthost-host:remote-host-codex:/1',
		sessionType: 'codex',
		chatResource: URI.parse('remote-host-codex:/1'),
		modelId,
	};
}

function createProvider(models: readonly ILanguageModelChatMetadataAndIdentifier[]): IAgentHostSessionsProvider {
	return {
		getSessionConfig: () => undefined,
		getModelsSnapshot: () => ({ models }),
		getModelPickerOptions: () => undefined,
	} as unknown as IAgentHostSessionsProvider;
}

const nullConfigurationAccess = {
	getModelConfiguration: () => ({}),
	setModelConfiguration: async () => { },
	getModelConfigurationActions: () => [],
} satisfies IModelConfigurationAccess;

suite('MobileChatPhoneInputPresenter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('checks the model the picker shows, not only the one the session wrote back', () => {
		const model = createModel(false);
		const rows = buildAgentHostSheetItems(
			createSessionContext(undefined),
			createProvider([model]),
			nullConfigurationAccess,
			() => 'row',
			model.identifier,
		);
		assert.deepStrictEqual(rows.map(row => ({ label: row.label, checked: row.checked })), [
			{ label: 'GPT-5.6 Sol', checked: true },
		]);
	});

	test('falls back to the session model when the caller has no picker state', () => {
		const model = createModel(false);
		const rows = buildAgentHostSheetItems(
			createSessionContext(model.identifier),
			createProvider([model]),
			nullConfigurationAccess,
			() => 'row',
			undefined,
		);
		assert.deepStrictEqual(rows.map(row => row.checked), [true]);
	});

	test('omits model configuration rows when the selected model advertises none', () => {
		assert.deepStrictEqual(createMobileModelConfigurationSheetItems(createModel(false), {}, () => 'unused'), []);
	});

	test('projects current model configuration in desktop group order', () => {
		const rows = createMobileModelConfigurationSheetItems(
			createModel(true),
			{ thinkingLevel: 'high', serviceTier: 'priority', contextSize: 400000 },
			(property, value) => `${property}:${value}`,
		);
		assert.deepStrictEqual(rows.map(row => ({
			id: row.id,
			label: row.label,
			description: row.description,
			checked: row.checked,
			sectionTitle: row.sectionTitle,
		})), [
			{ id: 'thinkingLevel:medium', label: 'Medium', description: 'Default', checked: false, sectionTitle: 'Thinking Effort' },
			{ id: 'thinkingLevel:high', label: 'High', description: undefined, checked: true, sectionTitle: undefined },
			{ id: 'serviceTier:standard', label: 'Standard', description: 'Default · Default speed and usage', checked: false, sectionTitle: 'Speed' },
			{ id: 'serviceTier:priority', label: 'Fast', description: '1.5x speed, increased usage', checked: true, sectionTitle: undefined },
			{ id: 'contextSize:65536', label: '64K', description: 'Default', checked: false, sectionTitle: 'Context Size' },
			{ id: 'contextSize:400000', label: '400K', description: undefined, checked: true, sectionTitle: undefined },
		]);
	});
});
