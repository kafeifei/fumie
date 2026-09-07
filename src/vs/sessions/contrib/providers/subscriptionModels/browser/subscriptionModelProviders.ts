/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_AGENT_PROVIDER_ID, CODEX_AGENT_PROVIDER_ID } from '../../../../../platform/agentHost/common/agent.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, isSubscriptionCatalogModel } from '../../../../../platform/agentHost/common/agentModelSource.js';
import { LOCAL_AGENT_HOST_AUTHORITY } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { AgentInfo, SessionModelInfo } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostLanguageModelProvider } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLanguageModelProvider.js';
import { IAgentHostModelProviderPresentation } from '../../../../../workbench/services/agentHost/browser/agentHostModelProviderPresentation.js';
import { ILanguageModelChatInfoOptions, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelProviderStatus, IUserFriendlyLanguageModel } from '../../../../../workbench/contrib/chat/common/languageModels.js';

export const CLAUDE_SUBSCRIPTION_VENDOR = 'claude-subscription';
export const CODEX_SUBSCRIPTION_VENDOR = 'codex-subscription';

/**
 * A subscription the user signs in to with a CLI, presented in Manage Models as
 * a provider of its own rather than as part of the agent that happens to publish
 * its catalog.
 *
 * The agent keeps publishing the whole catalog it always did — gateway rows,
 * BYOK projections and the subscription models alike — so this reads the
 * subscription slice back out of that one published list instead of asking for a
 * second one. Routing is untouched: the models keep the agent's session type, so
 * the picker filters and the session router see exactly what they saw before.
 */
export interface ISubscriptionProviderDefinition {
	/** Language model vendor id, and the id the user's added entry is written under. */
	readonly vendor: string;
	readonly displayName: string;
	/** The agent whose published catalog carries this subscription's models. */
	readonly agentProvider: string;
	/** Stamped on every model as `targetChatSessionType`, so routing is unchanged. */
	readonly sessionType: string;
	/** Whether one published model came from this subscription. */
	isSubscriptionModel(model: SessionModelInfo): boolean;
	/** Source id whose canonical picker visibility this provider owns. */
	readonly visibilitySourceId?: string;
}

export const CLAUDE_SUBSCRIPTION_DEFINITION: ISubscriptionProviderDefinition = {
	vendor: CLAUDE_SUBSCRIPTION_VENDOR,
	displayName: localize('subscriptionModels.claude', "Claude Subscription"),
	agentProvider: CLAUDE_AGENT_PROVIDER_ID,
	sessionType: `agent-host-${CLAUDE_AGENT_PROVIDER_ID}`,
	isSubscriptionModel: model => isSubscriptionCatalogModel(CLAUDE_AGENT_PROVIDER_ID, model),
};

export const CODEX_SUBSCRIPTION_DEFINITION: ISubscriptionProviderDefinition = {
	vendor: CODEX_SUBSCRIPTION_VENDOR,
	displayName: localize('subscriptionModels.codex', "Codex Subscription"),
	agentProvider: CODEX_AGENT_PROVIDER_ID,
	sessionType: `agent-host-${CODEX_AGENT_PROVIDER_ID}`,
	isSubscriptionModel: model => isSubscriptionCatalogModel(CODEX_AGENT_PROVIDER_ID, model),
	visibilitySourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID,
};

export const SUBSCRIPTION_PROVIDER_DEFINITIONS: readonly ISubscriptionProviderDefinition[] = [
	CLAUDE_SUBSCRIPTION_DEFINITION,
	CODEX_SUBSCRIPTION_DEFINITION,
];

/**
 * The vendor descriptor that puts the subscription in the **Add Models**
 * dropdown. A `configuration` is what makes a vendor addable (and renameable and
 * deletable) at all, and an empty property bag is the honest schema here: there
 * is nothing to configure, because the credential belongs to the CLI. Adding one
 * therefore only asks for a name.
 */
export function createSubscriptionVendorDescriptor(definition: ISubscriptionProviderDefinition): IUserFriendlyLanguageModel {
	return {
		vendor: definition.vendor,
		displayName: definition.displayName,
		configuration: { type: 'object', properties: {} },
		managementCommand: undefined,
		when: undefined,
		singleton: true,
	};
}

/** The subscription's slice of the catalog the agent has published, if it is running at all. */
export function subscriptionModelsFrom(agents: readonly AgentInfo[], definition: ISubscriptionProviderDefinition): readonly SessionModelInfo[] {
	const agent = agents.find(candidate => candidate.provider === definition.agentProvider);
	return agent?.models.filter(model => definition.isSubscriptionModel(model)) ?? [];
}

/**
 * Supplies a subscription's models under its own vendor, but only to the entry
 * the user added.
 *
 * `_resolveAllLanguageModels` asks every provider twice: once with no group at
 * all, then once per configured group. The group-less pass is what a vendor
 * whose models exist regardless of configuration answers; for a subscription it
 * must stay empty, because the models are only meant to exist while the user
 * keeps an entry for them. Deleting the entry then removes the models from the
 * picker without touching the credential, and the status card goes with them
 * rather than advertising a sign-in for a provider that is no longer listed.
 */
export class SubscriptionLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _inner: AgentHostLanguageModelProvider;
	readonly onDidChange: Event<void>;

	constructor(definition: ISubscriptionProviderDefinition, presentation?: IAgentHostModelProviderPresentation) {
		super();
		// `owned`, not `projected`: a subscription is an independently manageable
		// provider, so an empty catalog is worth reporting as a sign-in prompt.
		this._inner = this._register(new AgentHostLanguageModelProvider(
			definition.sessionType,
			definition.vendor,
			'owned',
			presentation,
			definition.visibilitySourceId ? {
				namespace: LOCAL_AGENT_HOST_AUTHORITY,
				sourceId: definition.visibilitySourceId,
				owner: true,
			} : undefined,
		));
		this.onDidChange = this._inner.onDidChange;
	}

	updateModels(models: readonly SessionModelInfo[]): void {
		this._inner.updateModels(models);
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return options.group === undefined ? [] : this._inner.provideLanguageModelChatInfo(options, token);
	}

	async provideLanguageModelChatStatus(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelProviderStatus | undefined> {
		return options.group === undefined ? undefined : this._inner.provideLanguageModelChatStatus(options, token);
	}

	sendChatRequest(): Promise<never> {
		return this._inner.sendChatRequest();
	}

	provideTokenCount(): Promise<number> {
		return this._inner.provideTokenCount();
	}
}
