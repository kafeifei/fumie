/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { derived } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../platform/agentHost/common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC, CLAUDE_PROVIDER_COPILOT } from '../../../../platform/agentHost/common/claudeProviders.js';
import type { IModelPickerDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { getModelProviderIcon } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelProviderIcons.js';
import { ILanguageModelChatMetadataAndIdentifier, isAutoLanguageModel } from '../../../../workbench/contrib/chat/common/languageModels.js';

const OFFICIAL_PROVIDER_TOKENS = new Set([
	CLAUDE_PROVIDER_ANTHROPIC,
	CLAUDE_PROVIDER_COPILOT,
	'openai',
	'vscode-proxy',
	'chatgpt',
]);

/**
 * Catalog transport/group token from `@provider=<token>:` or `modelGroup.id`.
 * Display names do not determine provider identity.
 */
export function catalogProviderToken(model: ILanguageModelChatMetadataAndIdentifier): string | undefined {
	const fromId = providerTokenFromQualifiedId(model.metadata.id);
	if (fromId) {
		return fromId;
	}
	const fromIdentifier = providerTokenFromQualifiedId(model.identifier);
	if (fromIdentifier) {
		return fromIdentifier;
	}
	const groupId = model.metadata.modelGroup?.id?.trim();
	if (groupId) {
		return groupId;
	}
	return undefined;
}

/** ChatGPT / Anthropic / GitHub Copilot subscription rows. */
export function isOfficialSubscriptionModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	const token = catalogProviderToken(model);
	if (model.metadata.modelGroup?.sourceId === CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID) {
		return true;
	}
	if (token && OFFICIAL_PROVIDER_TOKENS.has(token)) {
		return true;
	}
	const vendor = model.metadata.vendor.toLowerCase();
	return vendor === 'copilot' || vendor.endsWith('-copilot') || vendor.includes('copilotcli');
}

/**
 * Copilot / ChatGPT subscription rows that may mix into a harness picker.
 * Native Anthropic SDK rows stay within their own authenticated catalog.
 */
export function isMixableOfficialSubscriptionModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	if (!isOfficialSubscriptionModel(model)) {
		return false;
	}
	return catalogProviderToken(model) !== CLAUDE_PROVIDER_ANTHROPIC;
}

/**
 * Presentation only, and only the picker's vendor icon: which rows exist, what
 * they are called and which group they sit in belong to the model provider.
 * Returns the input array untouched when no row needs an icon it does not
 * already carry.
 */
export function presentSessionPickerModels(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
): readonly ILanguageModelChatMetadataAndIdentifier[] {
	if (models.length === 0) {
		return models;
	}
	let changed = false;
	const presented = models.map(model => {
		const next = presentSessionPickerModel(model);
		if (next !== model) {
			changed = true;
		}
		return next;
	});
	return changed ? presented : models;
}

export function presentSessionPickerModel(model: ILanguageModelChatMetadataAndIdentifier): ILanguageModelChatMetadataAndIdentifier {
	if (isAutoLanguageModel(model)) {
		return model;
	}
	const statusIcon = model.metadata.statusIcon ?? officialVendorIcon(model);
	if (statusIcon === model.metadata.statusIcon) {
		return model;
	}
	return {
		...model,
		metadata: {
			...model.metadata,
			statusIcon,
		},
	};
}

/**
 * Applies the Sessions picker presentation while leaving model selection,
 * configuration and cache state owned by the native delegate.
 */
export function adaptSessionModelPickerDelegate(delegate: IModelPickerDelegate): IModelPickerDelegate {
	return {
		currentModel: derived(reader => {
			const currentModel = delegate.currentModel.read(reader);
			return currentModel ? presentSessionPickerModel(currentModel) : undefined;
		}),
		setModel: model => {
			const sourceModel = delegate.getModels().find(candidate => candidate.identifier === model.identifier);
			delegate.setModel(sourceModel ?? model);
		},
		getModels: () => [...presentSessionPickerModels(delegate.getModels())],
		getPresentationOptions: () => ({
			...delegate.getPresentationOptions(),
			useGroupedModelPicker: false,
			showFeatured: false,
			showUnavailableFeatured: false,
			showModelIcon: true,
		}),
		getChatSessionId: delegate.getChatSessionId?.bind(delegate),
		isCacheWarm: delegate.isCacheWarm?.bind(delegate),
		modelConfiguration: delegate.modelConfiguration,
	};
}

function officialVendorIcon(model: ILanguageModelChatMetadataAndIdentifier): ThemeIcon {
	const token = catalogProviderToken(model);
	if (token === CLAUDE_PROVIDER_ANTHROPIC) {
		return Codicon.claude;
	}
	if (token === CLAUDE_PROVIDER_COPILOT || token === 'vscode-proxy') {
		return Codicon.copilotCompact;
	}
	if (token === 'openai' || token === 'chatgpt' || model.metadata.modelGroup?.sourceId === CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID) {
		return Codicon.openai;
	}
	const vendor = model.metadata.vendor.toLowerCase();
	if (vendor === 'copilot' || vendor.endsWith('-copilot') || vendor.includes('copilotcli')) {
		return Codicon.copilotCompact;
	}
	return getModelProviderIcon(model);
}

function providerTokenFromQualifiedId(value: string): string | undefined {
	const match = /@provider=([^:]+):/.exec(value);
	if (!match) {
		return undefined;
	}
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}
