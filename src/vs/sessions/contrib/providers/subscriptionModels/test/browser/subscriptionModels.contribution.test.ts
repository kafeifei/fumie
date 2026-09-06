/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID, createAgentModelSourceMeta } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { IAgentSubscription } from '../../../../../../platform/agentHost/common/state/agentSubscription.js';
import { RootState } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ILanguageModelChatProvider, ILanguageModelsService } from '../../../../../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { IAgentSdkSetupService } from '../../../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';
import { IClaudeAccountService } from '../../../../../../workbench/services/agentHost/browser/claudeAccountService.js';
import { ICodexAccountService } from '../../../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY } from '../../browser/subscriptionModelDefaults.js';
import { SubscriptionModelProvidersContribution } from '../../browser/subscriptionModels.contribution.js';

suite('SubscriptionModelProvidersContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('follows a delayed host, account model changes, and replacement root subscriptions', async () => {
		function root(modelId?: string) {
			const changed = store.add(new Emitter<RootState>());
			const state = (id?: string): RootState => ({ agents: [{
				provider: 'codex', displayName: 'Codex', description: 'Codex',
				models: id ? [{ id, name: id, provider: 'chatgpt', _meta: createAgentModelSourceMeta(CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID) }] : [],
			}] } as RootState);
			let value: RootState | undefined = modelId ? state(modelId) : undefined;
			const subscription: IAgentSubscription<RootState> = {
				get value() { return value; },
				get verifiedValue() { return value; },
				onDidChange: changed.event,
				onWillApplyAction: Event.None,
				onDidApplyAction: Event.None,
			};
			return { subscription, update: (id?: string) => { value = state(id); changed.fire(value); } };
		}
		let currentRoot = root();
		const started = store.add(new Emitter<void>());
		const host = new class extends mock<IAgentHostService>() {
			override get rootState() { return currentRoot.subscription; }
			override readonly onAgentHostStart = started.event;
		};
		const providers = new Map<string, ILanguageModelChatProvider>();
		const models = new class extends mock<ILanguageModelsService>() {
			override deltaLanguageModelChatProviderDescriptors() { }
			override registerLanguageModelProvider(vendor: string, provider: ILanguageModelChatProvider) {
				providers.set(vendor, provider);
				return toDisposable(() => providers.delete(vendor));
			}
		};
		const setup = new class extends mock<IAgentSdkSetupService>() {
			override readonly onDidChangeSetups = Event.None;
		};
		const claude = new class extends mock<IClaudeAccountService>() {
			override readonly onDidChangeAccount = Event.None;
		};
		const codex = new class extends mock<ICodexAccountService>() {
			override readonly onDidChangeAccount = Event.None;
		};
		const configuration = new class extends mock<ILanguageModelsConfigurationService>() {
			override readonly whenReady = Promise.resolve();
		};
		const storage = store.add(new InMemoryStorageService());
		storage.store(SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		store.add(new SubscriptionModelProvidersContribution(host, models, setup, claude, codex, configuration, storage, new class extends mock<IFileService>() { }, store.add(new NullLogService())));
		const ids = async () => (await providers.get('codex-subscription')!.provideLanguageModelChatInfo({ group: 'Codex Subscription', silent: true }, CancellationToken.None)).map(model => model.identifier);

		assert.deepStrictEqual(await ids(), []);
		currentRoot = root('@provider=openai:first');
		started.fire();
		assert.deepStrictEqual(await ids(), ['codex-subscription:@provider=openai:first']);
		currentRoot.update();
		assert.deepStrictEqual(await ids(), []);
		currentRoot.update('@provider=openai:after-sign-in');
		assert.deepStrictEqual(await ids(), ['codex-subscription:@provider=openai:after-sign-in']);

		const previousRoot = currentRoot;
		currentRoot = root('@provider=openai:restarted');
		started.fire();
		previousRoot.update('@provider=openai:stale');
		assert.deepStrictEqual(await ids(), ['codex-subscription:@provider=openai:restarted']);
	});
});
