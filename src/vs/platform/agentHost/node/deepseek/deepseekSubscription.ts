/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { DEEPSEEK_AGENT_PROVIDER_ID, type IAgentModelInfo } from '../../common/agent.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelSourceMeta } from '../../common/agentModelSource.js';
import { getReasoningEffortLabel, resolveDefaultReasoningEffort } from '../../common/reasoningEffort.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { CHATGPT_SUBSCRIPTION_MODELS, chatGptSubscriptionAgentModelId, chatGptSubscriptionMaxOutputTokens, parseChatGptSubscriptionModelId, type IChatGptSubscriptionModel } from '../chatGptSubscription.js';

export const DeepSeekChatGptProviderRoute = 'fumie-chatgpt';
export const DeepSeekChatGptCredentialRef = 'FUMIE_DEEPSEEK_CHATGPT_PROXY_KEY';

// These are the levels the bundled dsh-llm-pi-ai adapter accepts. Do not map
// an unsupported upstream effort to a different level.
const supportedEfforts = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const thinkingLevelKey = 'thinkingLevel';

function reasoningEfforts(model: IChatGptSubscriptionModel): string[] {
	return model.supportedReasoningEfforts.filter(level => supportedEfforts.has(level));
}

export function deepSeekSubscriptionModels(): IAgentModelInfo[] {
	return CHATGPT_SUBSCRIPTION_MODELS.map(model => {
		const levels = reasoningEfforts(model);
		return {
			provider: DEEPSEEK_AGENT_PROVIDER_ID,
			id: chatGptSubscriptionAgentModelId(model.id),
			underlyingModelId: model.id,
			name: model.name,
			maxContextWindow: model.maxContextWindowTokens,
			maxOutputTokens: chatGptSubscriptionMaxOutputTokens(model),
			supportsVision: model.supportsVision,
			_meta: createAgentModelSourceMeta(CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID),
			...(levels.length ? {
				configSchema: {
					type: 'object' as const,
					properties: {
						[thinkingLevelKey]: {
							type: 'string' as const,
							title: localize('deepseek.thinkingLevel', "Thinking Level"),
							enum: levels,
							enumLabels: levels.map(getReasoningEffortLabel),
							default: resolveDefaultReasoningEffort(levels, model.defaultReasoningEffort),
						},
					},
				},
			} : {}),
		};
	});
}

/** Configures the SDK's own Responses adapter; only its loopback credential reference is persisted. */
export function deepSeekSubscriptionProviderConfig(baseURL: string) {
	return {
		providers: {
			[DeepSeekChatGptProviderRoute]: {
				displayName: 'ChatGPT',
				api: 'openai-responses',
				baseURL,
				apiKeyEnv: DeepSeekChatGptCredentialRef,
				models: CHATGPT_SUBSCRIPTION_MODELS.map(model => ({
					id: chatGptSubscriptionAgentModelId(model.id),
					name: model.name,
					contextWindow: model.maxContextWindowTokens,
					maxTokens: chatGptSubscriptionMaxOutputTokens(model),
					input: model.supportsVision ? ['text', 'image'] : ['text'],
					reasoningEfforts: Object.fromEntries(reasoningEfforts(model).map(level => [level, level])),
				})),
			},
		},
	};
}

export function deepSeekSubscriptionAgentOptions(selection: ModelSelection): { provider: string; model: string; reasoningEffort?: string } | undefined {
	const route = parseChatGptSubscriptionModelId(selection.id);
	if (!route) {
		return undefined;
	}
	const model = CHATGPT_SUBSCRIPTION_MODELS.find(model => model.id === route.modelId);
	if (!model || route.serviceTier) {
		throw new Error(`DeepSeek cannot run the selected ChatGPT subscription model '${selection.id}'.`);
	}
	const levels = reasoningEfforts(model);
	const effort = selection.config?.[thinkingLevelKey] ?? resolveDefaultReasoningEffort(levels, model.defaultReasoningEffort);
	if (effort !== undefined && (typeof effort !== 'string' || !levels.includes(effort))) {
		throw new Error(`DeepSeek cannot use reasoning effort '${String(effort)}' for '${model.id}'.`);
	}
	return {
		provider: DeepSeekChatGptProviderRoute,
		model: selection.id,
		...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
	};
}
