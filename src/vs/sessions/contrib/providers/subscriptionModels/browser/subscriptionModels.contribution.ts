/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { AgentInfo } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IAgentSdkSetupService } from '../../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';
import { IClaudeAccountService } from '../../../../../workbench/services/agentHost/browser/claudeAccountService.js';
import { ICodexAccountService } from '../../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IAgentHostModelProviderPresentation } from '../../../../../workbench/services/agentHost/browser/agentHostModelProviderPresentation.js';
import { registerAgentHostModelSourcePresentations } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostModelSourcePresentations.js';
import { createClaudeSubscriptionPresentation, createCodexSubscriptionPresentation } from './subscriptionModelPresentations.js';
import { CLAUDE_SUBSCRIPTION_VENDOR, ISubscriptionProviderDefinition, SUBSCRIPTION_PROVIDER_DEFINITIONS, SubscriptionLanguageModelProvider, createSubscriptionVendorDescriptor, subscriptionModelsFrom } from './subscriptionModelProviders.js';

/**
 * Offers the user's Claude and Codex subscriptions as providers they can add in
 * Manage Models, each showing its own catalog, who is signed in, and the way in
 * and out of that account.
 *
 * The vendors are registered for the life of the window whether or not an entry
 * exists — a vendor absent from the registry is a vendor absent from the **Add
 * Models** dropdown, so unregistering one when its entry is deleted would make
 * it unaddable again. What follows the entry is the models: the provider answers
 * only the per-group resolution, so deleting the entry takes the subscription's
 * models out of the picker and leaves the CLI's credential exactly where it was.
 */
class SubscriptionModelProvidersContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.subscriptionModelProviders';

	private readonly _providers = new Map<string, SubscriptionLanguageModelProvider>();

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IAgentSdkSetupService private readonly _agentSdkSetupService: IAgentSdkSetupService,
		@IClaudeAccountService private readonly _claudeAccountService: IClaudeAccountService,
		@ICodexAccountService private readonly _codexAccountService: ICodexAccountService,
	) {
		super();

		for (const definition of SUBSCRIPTION_PROVIDER_DEFINITIONS) {
			this._register(this._registerSubscription(definition));
		}

		const initialState = this._agentHostService.rootState.value;
		this._updateModels(initialState instanceof Error || !initialState ? [] : initialState.agents);
		this._register(this._agentHostService.rootState.onDidChange(state => this._updateModels(state.agents)));
	}

	private _registerSubscription(definition: ISubscriptionProviderDefinition) {
		// Order matters, as it does for the agent host's own registration:
		// `updateModels` must run after `registerLanguageModelProvider` so the
		// initial `onDidChange` is observed.
		const descriptor = createSubscriptionVendorDescriptor(definition);
		this._languageModelsService.deltaLanguageModelChatProviderDescriptors([descriptor], []);
		// The source presentation is keyed by owning vendor, and these models now
		// reach the picker under this one. Without it the group they sit in would
		// be headed by the raw source id instead of "ChatGPT".
		const sourcePresentations = registerAgentHostModelSourcePresentations(definition.agentProvider, definition.vendor);
		const provider = new SubscriptionLanguageModelProvider(definition, this._presentationFor(definition));
		this._providers.set(definition.vendor, provider);
		const registration = this._languageModelsService.registerLanguageModelProvider(definition.vendor, provider);
		return toDisposable(() => {
			registration.dispose();
			provider.dispose();
			sourcePresentations.dispose();
			this._providers.delete(definition.vendor);
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors([], [descriptor]);
		});
	}

	private _presentationFor(definition: ISubscriptionProviderDefinition): IAgentHostModelProviderPresentation {
		return definition.vendor === CLAUDE_SUBSCRIPTION_VENDOR
			? createClaudeSubscriptionPresentation(this._agentSdkSetupService, this._claudeAccountService)
			: createCodexSubscriptionPresentation(this._codexAccountService);
	}

	private _updateModels(agents: readonly AgentInfo[]): void {
		for (const definition of SUBSCRIPTION_PROVIDER_DEFINITIONS) {
			this._providers.get(definition.vendor)?.updateModels(subscriptionModelsFrom(agents, definition));
		}
	}
}

registerWorkbenchContribution2(SubscriptionModelProvidersContribution.ID, SubscriptionModelProvidersContribution, WorkbenchPhase.AfterRestored);
