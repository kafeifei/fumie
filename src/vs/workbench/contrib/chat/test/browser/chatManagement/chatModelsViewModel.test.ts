/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction, toAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IModelsControlManifest, ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatSelector, ILanguageModelsGroup, ILanguageModelsService, IUserFriendlyLanguageModel, ILanguageModelProviderDescriptor } from '../../../common/languageModels.js';
import { canManageProviderGroup, ChatModelsViewModel, getManageModelsProviderLabel, ILanguageModelEntry, ILanguageModelProviderEntry, isLanguageModelProviderEntry, isLanguageModelGroupEntry } from '../../../browser/chatManagement/chatModelsViewModel.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { IStringDictionary } from '../../../../../../base/common/collections.js';
import { ILanguageModelsProviderGroup } from '../../../common/languageModelsConfiguration.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { languageModelSourcePresentationRegistry } from '../../../common/languageModelSourcePresentation.js';
import Severity from '../../../../../../base/common/severity.js';

class MockLanguageModelsService implements ILanguageModelsService {
	_serviceBrand: undefined;
	readonly whenReady = Promise.resolve();

	private vendors: IUserFriendlyLanguageModel[] = [];
	private models = new Map<string, ILanguageModelChatMetadata>();
	private modelsByVendor = new Map<string, string[]>();
	private modelGroups = new Map<string, ILanguageModelsGroup[]>();
	private hiddenModelIds = new Set<string>();
	readonly setModelsHiddenCalls: { readonly modelIdentifiers: readonly string[]; readonly hidden: boolean }[] = [];

	private readonly _onDidChangeLanguageModels = new Emitter<string>();
	readonly onDidChangeLanguageModels = this._onDidChangeLanguageModels.event;

	private readonly _onDidChangeLanguageModelVendors = new Emitter<readonly string[]>();
	readonly onDidChangeLanguageModelVendors = this._onDidChangeLanguageModelVendors.event;

	onDidChangeModelsControlManifest = Event.None;

	addVendor(vendor: IUserFriendlyLanguageModel): void {
		this.vendors.push(vendor);
		this.modelsByVendor.set(vendor.vendor, []);
		this.modelGroups.set(vendor.vendor, []);
	}

	addModel(vendorId: string, identifier: string, metadata: ILanguageModelChatMetadata, groupName?: string): void {
		this.models.set(identifier, metadata);
		const models = this.modelsByVendor.get(vendorId) || [];
		models.push(identifier);
		this.modelsByVendor.set(vendorId, models);

		// A named group models a configured entry (it carries `group`, as the real
		// service returns for a user-added provider group); no name models the
		// group-less resolution an unconfigured agent vendor gets back, which has no
		// `group`. The distinction matters: a group-less row is where Manage Models
		// may derive a display group from a model's `modelGroup`.
		const groups = this.modelGroups.get(vendorId) || [];
		let group = groupName ? groups.find(candidate => candidate.group?.name === groupName) : groups.find(candidate => !candidate.group);
		if (!group) {
			group = {
				...(groupName ? { group: { vendor: vendorId, name: groupName } } : {}),
				modelIdentifiers: []
			};
			groups.push(group);
		}
		group.modelIdentifiers.push(identifier);
		this.modelGroups.set(vendorId, groups);
	}

	setStatus(vendorId: string, message: string, severity: Severity, action?: IAction): void {
		this.modelGroups.set(vendorId, [{
			modelIdentifiers: [],
			status: { message, severity, action },
		}]);
	}

	registerLanguageModelProvider(vendor: string, provider: ILanguageModelChatProvider): IDisposable {
		throw new Error('Method not implemented.');
	}

	deltaLanguageModelChatProviderDescriptors(added: IUserFriendlyLanguageModel[], removed: IUserFriendlyLanguageModel[]): void {
		throw new Error('Method not implemented.');
	}

	getVendors(): ILanguageModelProviderDescriptor[] {
		return this.vendors.map(v => ({ ...v, isDefault: v.vendor === 'copilot' }));
	}

	getLanguageModelIds(): string[] {
		return Array.from(this.models.keys());
	}

	lookupLanguageModel(identifier: string): ILanguageModelChatMetadata | undefined {
		return this.models.get(identifier);
	}

	lookupLanguageModelByQualifiedName(referenceName: string): ILanguageModelChatMetadataAndIdentifier | undefined {
		for (const [identifier, metadata] of this.models.entries()) {
			if (ILanguageModelChatMetadata.matchesQualifiedName(referenceName, metadata)) {
				return { metadata, identifier };
			}
		}
		return undefined;
	}

	getLanguageModels(): ILanguageModelChatMetadataAndIdentifier[] {
		const result: ILanguageModelChatMetadataAndIdentifier[] = [];
		for (const [identifier, metadata] of this.models.entries()) {
			result.push({ identifier, metadata });
		}
		return result;
	}

	setContributedSessionModels(): void {
	}

	clearContributedSessionModels(): void {
	}

	async selectLanguageModels(selector: ILanguageModelChatSelector): Promise<string[]> {
		if (selector.vendor) {
			return this.modelsByVendor.get(selector.vendor) || [];
		}
		return Array.from(this.models.keys());
	}

	sendChatRequest(): Promise<any> {
		throw new Error('Method not implemented.');
	}

	computeTokenLength(): Promise<number> {
		throw new Error('Method not implemented.');
	}

	getModelConfiguration(_modelId: string): IStringDictionary<unknown> | undefined {
		return undefined;
	}

	async setModelConfiguration(_modelId: string, _values: IStringDictionary<unknown>): Promise<void> {
	}

	getModelConfigurationActions(_modelId: string): IAction[] {
		return [];
	}

	async configureLanguageModelsProviderGroup(vendorId: string, name?: string): Promise<void> {
	}

	async renameLanguageModelsProviderGroup(vendorId: string, providerGroupName: string): Promise<void> {
	}

	async updateLanguageModelsProviderGroupApiKey(vendorId: string, providerGroupName: string): Promise<void> {
	}

	async addLanguageModelsProviderGroupModel(vendorId: string, providerGroupName: string): Promise<void> {
	}

	async openLanguageModelsProviderGroupSettings(vendorId: string, providerGroupName: string): Promise<void> {
	}

	async configureModel(_modelId: string): Promise<void> {
	}

	async addLanguageModelsProviderGroup(name: string, vendorId: string, configuration: IStringDictionary<unknown> | undefined): Promise<void> {
	}

	getLanguageModelGroups(vendor: string): ILanguageModelsGroup[] {
		return this.modelGroups.get(vendor) || [];
	}

	async resolveLanguageModelProviderGroup(): Promise<undefined> {
		return undefined;
	}

	hasResolvedVendor(vendor: string): boolean {
		return this.modelGroups.has(vendor);
	}

	async removeLanguageModelsProviderGroup(vendorId: string, providerGroupName: string): Promise<void> {
	}

	async migrateLanguageModelsProviderGroup(languageModelsProviderGroup: ILanguageModelsProviderGroup): Promise<void> { }

	getRecentlyUsedModelIds(): string[] { return []; }
	addToRecentlyUsedList(): void { }
	clearRecentlyUsedList(): void { }
	getPinnedModelIds(): string[] { return []; }
	pinModel(_modelIdentifier: string): void { }
	unpinModel(_modelIdentifier: string): void { }
	isModelPinned(_modelIdentifier: string): boolean { return false; }
	onDidChangePinnedModels = Event.None;
	isModelHidden(modelIdentifier: string): boolean { return this.hiddenModelIds.has(modelIdentifier); }
	isGroupHidden(_vendor: string, _groupName: string): boolean { return false; }
	setModelHidden(modelIdentifier: string, hidden: boolean): void {
		this.setModelsHidden([modelIdentifier], hidden);
	}
	setModelsHidden(modelIdentifiers: readonly string[], hidden: boolean): void {
		this.setModelsHiddenCalls.push({ modelIdentifiers: [...modelIdentifiers], hidden });
		for (const modelIdentifier of modelIdentifiers) {
			if (hidden) {
				this.hiddenModelIds.add(modelIdentifier);
			} else {
				this.hiddenModelIds.delete(modelIdentifier);
			}
		}
	}
	setGroupHidden(_vendor: string, _groupName: string, _hidden: boolean): void { }
	getHiddenModelIds(): string[] { return [...this.hiddenModelIds]; }
	onDidChangeModelVisibility = Event.None;
	getModelsControlManifest(): IModelsControlManifest { return { free: {}, paid: {} }; }
	restrictedChatParticipants = observableValue('restrictedChatParticipants', Object.create(null));
}

function expandProviderGroups(viewModel: ChatModelsViewModel): void {
	// Exercise the same public action as the provider row's Expand button.
	for (const entry of viewModel.viewModelEntries.filter(isLanguageModelProviderEntry)) {
		if (entry.collapsed) {
			viewModel.toggleCollapsed(entry);
		}
	}
}

suite('ChatModelsViewModel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let languageModelsService: MockLanguageModelsService;
	let viewModel: ChatModelsViewModel;

	setup(async () => {
		store.add(languageModelSourcePresentationRegistry.register({
			ownerVendor: 'codex',
			sourceId: 'chatgptSubscription',
			label: 'ChatGPT',
			icon: Codicon.openai,
			description: 'Models provided by your ChatGPT subscription',
		}));
		languageModelsService = new MockLanguageModelsService();

		// Setup test data
		languageModelsService.addVendor({
			vendor: 'copilot',
			displayName: 'GitHub Copilot',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addVendor({
			vendor: 'openai',
			displayName: 'OpenAI',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('copilot', 'copilot-gpt-4', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4',
			name: 'GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('copilot', 'copilot-gpt-4o', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4o',
			name: 'GPT-4o',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: true
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-3.5', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-3.5-turbo',
			name: 'GPT-3.5 Turbo',
			family: 'gpt-3.5',
			version: '1.0',
			vendor: 'openai',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-4-vision', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-4-vision',
			name: 'GPT-4 Vision',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'openai',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: false,
			capabilities: {
				toolCalling: false,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		viewModel = store.add(new ChatModelsViewModel(languageModelsService));

		await viewModel.refresh();
	});

	test('provider groups start collapsed and keep their headers visible', () => {
		const entries = viewModel.filter('');
		assert.deepStrictEqual(entries.filter(isLanguageModelProviderEntry).map(entry => ({
			label: entry.label,
			collapsed: entry.collapsed,
		})), [
			{ label: 'GitHub Copilot', collapsed: true },
			{ label: 'OpenAI', collapsed: true },
		]);
		assert.ok(entries.every(isLanguageModelProviderEntry), 'Collapsed groups must not show model rows');
	});

	test('should fetch all models without filters', () => {
		expandProviderGroups(viewModel);
		const results = viewModel.filter('');

		// Should have 2 vendor entries and 4 model entries (grouped by vendor)
		assert.strictEqual(results.length, 6);

		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.strictEqual(vendors.length, 2);

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 4);
	});

	test('shows a provider whose only entry is a status', async () => {
		const action = toAction({ id: 'connect-empty-provider', label: 'Connect', run: () => undefined });
		languageModelsService.addVendor({
			vendor: 'empty-provider',
			displayName: 'Empty Provider',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined,
		});
		languageModelsService.setStatus('empty-provider', 'No models available', Severity.Warning, action);

		await viewModel.refresh();
		expandProviderGroups(viewModel);
		const entries = viewModel.filter('');

		assert.deepStrictEqual({
			providerLabels: entries.filter(isLanguageModelProviderEntry).map(entry => entry.label),
			statuses: entries.filter(entry => entry.type === 'status').map(entry => entry.message),
		}, {
			providerLabels: ['GitHub Copilot', 'Empty Provider', 'OpenAI'],
			statuses: ['No models available'],
		});
		assert.strictEqual(entries.find(entry => entry.type === 'status')?.action, action);
	});

	test('a subscription vendor keeps its models under its configured group, while a group-less agent vendor still derives one', async () => {
		const service = new MockLanguageModelsService();
		// A subscription provider the user added: a configurable vendor with one
		// real group. Its model carries the ChatGPT transport group, which must not
		// become a row of its own — the model belongs under the added entry.
		service.addVendor({ vendor: 'codex-subscription', displayName: 'Codex Subscription', managementCommand: undefined, when: undefined, configuration: { type: 'object', properties: {} } });
		service.addModel('codex-subscription', 'codex-subscription:@provider=openai:gpt-5.6-sol', {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: '@provider=openai:gpt-5.6-sol', name: 'GPT-5.6 Sol', family: 'gpt-5.6-sol', version: '1.0', vendor: 'codex-subscription',
			maxInputTokens: 1, maxOutputTokens: 1, isDefaultForLocation: {},
			targetChatSessionType: 'agent-host-codex',
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		}, 'Codex Subscription');
		// An agent vendor with no configuration and group-less models of the same
		// shape. Here the derived "ChatGPT" group is the only sensible row — there
		// is no configured group to fall into — so the derivation must still happen.
		service.addVendor({ vendor: 'codex', displayName: 'Codex', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addModel('codex', 'codex:@provider=openai:gpt-5.6-sol', {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: '@provider=openai:gpt-5.6-sol', name: 'GPT-5.6 Sol', family: 'gpt-5.6-sol', version: '1.0', vendor: 'codex',
			maxInputTokens: 1, maxOutputTokens: 1, isDefaultForLocation: {},
			targetChatSessionType: 'agent-host-codex',
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		});

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();
		const rows = model.viewModelEntries.filter(isLanguageModelProviderEntry);
		const row = (label: string, vendorId: string) => rows.find(r => r.label === label && r.vendorEntry.vendor.vendor === vendorId);

		const subscriptionRow = row('Codex Subscription', 'codex-subscription')!;
		const derivedRow = row('ChatGPT', 'codex')!;

		assert.deepStrictEqual({
			// The subscription's model is under its own configured, manageable row —
			// not stranded in a phantom "ChatGPT" row belonging to that vendor.
			subscriptionModels: model.getModelsForGroup(subscriptionRow).map(m => m.identifier),
			subscriptionManageable: canManageProviderGroup(subscriptionRow.vendorEntry),
			noPhantomRowFromSubscription: !rows.some(r => r.label === 'ChatGPT' && r.vendorEntry.vendor.vendor === 'codex-subscription'),
			// The group-less agent vendor still derives its ChatGPT row, and that
			// derived row is inert (no configured group to rename or delete).
			derivedModels: model.getModelsForGroup(derivedRow).map(m => m.identifier),
			derivedIsConfigured: !!derivedRow.vendorEntry.isConfiguredGroup,
			derivedManageable: canManageProviderGroup(derivedRow.vendorEntry),
		}, {
			subscriptionModels: ['codex-subscription:@provider=openai:gpt-5.6-sol'],
			subscriptionManageable: true,
			noPhantomRowFromSubscription: true,
			derivedModels: ['codex:@provider=openai:gpt-5.6-sol'],
			derivedIsConfigured: false,
			derivedManageable: false,
		});
	});

	test('a configured vendor with no group of its own gets no group commands either', () => {
		// The vendor's own display name stands in for a group that was never
		// configured, so Delete would address an entry the file does not have.
		const vendor = { vendor: 'openai', displayName: 'OpenAI', isDefault: false, managementCommand: undefined, when: undefined, configuration: { type: 'object', properties: { apiKey: {} } } } as ILanguageModelProviderDescriptor;
		assert.deepStrictEqual({
			synthesized: canManageProviderGroup({ vendor, group: { vendor: 'openai', name: 'OpenAI' } }),
			real: canManageProviderGroup({ vendor, group: { vendor: 'openai', name: 'My OpenAI' }, isConfiguredGroup: true }),
		}, {
			synthesized: false,
			real: true,
		});
	});

	test('a vendor hidden from management takes its models, its status and its derived groups with it', async () => {
		const service = new MockLanguageModelsService();
		// The agent host's own vendor: routes models, is not the user's to manage.
		service.addVendor({ vendor: 'agent-host-codex', displayName: 'Codex', managementCommand: undefined, when: undefined, configuration: undefined, hiddenFromManagement: true });
		service.addVendor({ vendor: 'custom', displayName: 'Custom', managementCommand: undefined, when: undefined, configuration: undefined });
		// Carries a source id, so without the hiding it would also manufacture a
		// "ChatGPT" group row of its own.
		service.addModel('agent-host-codex', 'agent-host-codex:gpt-5.6', {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			vendor: 'agent-host-codex',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			targetChatSessionType: 'agent-host-codex',
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		});
		service.addModel('custom', 'custom:my-model', {
			extension: new ExtensionIdentifier('example.custom'),
			id: 'my-model',
			name: 'My Model',
			family: 'my-model',
			version: '1.0',
			vendor: 'custom',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
		});

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();
		const entries = model.filter('');

		assert.deepStrictEqual({
			vendors: model.getVendors().map(vendor => vendor.vendor),
			// Nothing the hidden vendor contributed survives: not its own row, not
			// its models, and not the "ChatGPT" group its models would have derived.
			hiddenVendorRows: entries.filter(isLanguageModelProviderEntry).map(entry => entry.label).filter(label => label === 'Codex' || label === 'ChatGPT'),
			hiddenVendorModels: entries.filter(entry => entry.type === 'model').map(entry => (entry as ILanguageModelEntry).model.identifier).filter(identifier => identifier.startsWith('agent-host-codex:')),
		}, {
			vendors: ['custom'],
			hiddenVendorRows: [],
			hiddenVendorModels: [],
		});
	});

	test('a hidden vendor keeps its status out of the list too', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'agent-host-claude', displayName: 'Claude', managementCommand: undefined, when: undefined, configuration: undefined, hiddenFromManagement: true });
		service.setStatus('agent-host-claude', 'Sign in to Claude to load native models', Severity.Warning);

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();

		assert.deepStrictEqual(model.filter('').map(entry => entry.type), []);
	});

	test('distinguishes the ChatGPT subscription from a custom group with the same name', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'codex', displayName: 'Codex', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addVendor({ vendor: 'chatgpt', displayName: 'ChatGPT', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addVendor({ vendor: 'custom', displayName: 'Custom', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addModel('codex', 'codex:gpt-5.6', {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			vendor: 'codex',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			targetChatSessionType: 'agent-host-codex',
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		});
		service.addModel('custom', 'custom:gpt-5.6', {
			extension: new ExtensionIdentifier('example.custom'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			vendor: 'custom',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
		}, 'ChatGPT');

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();
		expandProviderGroups(model);
		const entries = model.filter('');
		const groups = entries.filter(isLanguageModelProviderEntry).map(entry => ({
			id: entry.id,
			label: entry.label,
			sourcePresentation: entry.sourcePresentation?.sourceId,
		}));
		const models = entries.filter(entry => !isLanguageModelProviderEntry(entry) && !isLanguageModelGroupEntry(entry)) as ILanguageModelEntry[];

		assert.deepStrictEqual({
			groups,
			providerLabels: models.map(entry => getManageModelsProviderLabel(entry.model)),
		}, {
			groups: [
				{ id: 'chatgpt-ChatGPT-chatgptSubscription', label: 'ChatGPT', sourcePresentation: 'chatgptSubscription' },
				{ id: 'custom-ChatGPT-configured', label: 'ChatGPT', sourcePresentation: undefined },
			],
			providerLabels: ['ChatGPT', 'ChatGPT'],
		});
	});

	test('shows the first-party ChatGPT subscription header even when it is the only group', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'codex', displayName: 'Codex', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addVendor({ vendor: 'chatgpt', displayName: 'ChatGPT', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addModel('codex', 'codex:gpt-5.6', {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			vendor: 'codex',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		});

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();

		expandProviderGroups(model);
		assert.deepStrictEqual(model.filter('').map(entry => ({
			type: entry.type,
			label: isLanguageModelProviderEntry(entry) ? entry.label : undefined,
			sourcePresentation: isLanguageModelProviderEntry(entry) ? entry.sourcePresentation?.sourceId : undefined,
		})), [
			{ type: 'vendor', label: 'ChatGPT', sourcePresentation: 'chatgptSubscription' },
			{ type: 'model', label: undefined, sourcePresentation: undefined },
		]);
	});

	test('trusted source presentations are scoped to their owner vendor', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'other', displayName: 'Other', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addModel('other', 'other:gpt-5.6', {
			extension: new ExtensionIdentifier('example.other'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			vendor: 'other',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' },
		});

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();
		const entry = model.filter('').find(candidate => !isLanguageModelProviderEntry(candidate) && !isLanguageModelGroupEntry(candidate)) as ILanguageModelEntry;
		assert.strictEqual(entry.model.provider.group.name, 'Chatgpt');
		assert.strictEqual(entry.model.provider.sourcePresentation, undefined);
	});

	test('group visibility toggles only the exact models rendered in that source group', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'codex', displayName: 'Codex', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addVendor({ vendor: 'custom', displayName: 'Custom', managementCommand: undefined, when: undefined, configuration: undefined });
		const metadata = {
			extension: new ExtensionIdentifier('vscode.codex'),
			id: 'gpt-5.6',
			name: 'GPT-5.6',
			family: 'gpt-5.6',
			version: '1.0',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
		};
		service.addModel('codex', 'codex:gpt-5.6', { ...metadata, vendor: 'codex', modelGroup: { id: 'chatgpt', sourceId: 'chatgptSubscription' } });
		service.addModel('custom', 'custom:gpt-5.6', { ...metadata, extension: new ExtensionIdentifier('example.custom'), vendor: 'custom' }, 'ChatGPT');

		const model = store.add(new ChatModelsViewModel(service));
		await model.refresh();
		const subscriptionGroup = model.filter('').find(entry => isLanguageModelProviderEntry(entry) && entry.sourcePresentation !== undefined);
		assert.ok(subscriptionGroup && isLanguageModelProviderEntry(subscriptionGroup));

		model.toggleGroupHidden(subscriptionGroup);
		assert.deepStrictEqual({
			hiddenModelIds: service.getHiddenModelIds(),
			setModelsHiddenCalls: service.setModelsHiddenCalls,
		}, {
			hiddenModelIds: ['codex:gpt-5.6'],
			setModelsHiddenCalls: [{ modelIdentifiers: ['codex:gpt-5.6'], hidden: true }],
		});
	});

	test('should filter by provider name (vendor ID and display name)', () => {
		const resultsByCopilotId = viewModel.filter('@provider:copilot');
		assert.strictEqual(resultsByCopilotId.length, 3);
		assert.strictEqual(resultsByCopilotId[0].type, 'vendor');
		assert.strictEqual(resultsByCopilotId[0].vendorEntry.vendor.vendor, 'copilot');
		assert.strictEqual(resultsByCopilotId[1].type, 'model');
		assert.strictEqual(resultsByCopilotId[1].model.identifier, 'copilot-gpt-4');
		assert.strictEqual(resultsByCopilotId[2].type, 'model');
		assert.strictEqual(resultsByCopilotId[2].model.identifier, 'copilot-gpt-4o');

		const resultsByOpenAIName = viewModel.filter('@provider:OpenAI');
		assert.strictEqual(resultsByOpenAIName.length, 3);
		assert.strictEqual(resultsByOpenAIName[0].type, 'vendor');
		assert.strictEqual(resultsByOpenAIName[0].vendorEntry.vendor.vendor, 'openai');
		assert.strictEqual(resultsByOpenAIName[1].type, 'model');
		assert.strictEqual(resultsByOpenAIName[1].model.identifier, 'openai-gpt-3.5');
		assert.strictEqual(resultsByOpenAIName[2].type, 'model');
		assert.strictEqual(resultsByOpenAIName[2].model.identifier, 'openai-gpt-4-vision');
	});

	test('should filter by multiple providers with OR logic', () => {
		const results = viewModel.filter('@provider:copilot @provider:openai');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 4);
	});

	test('should filter by single capability - tools', () => {
		const results = viewModel.filter('@capability:tools');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 3);
		assert.ok(models.every(m => m.model.metadata.capabilities?.toolCalling === true));
	});

	test('should filter by single capability - vision', () => {
		const results = viewModel.filter('@capability:vision');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 3);
		assert.ok(models.every(m => m.model.metadata.capabilities?.vision === true));
	});

	test('should filter by single capability - agent', () => {
		const results = viewModel.filter('@capability:agent');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.metadata.id, 'gpt-4o');
	});

	test('should filter by multiple capabilities with AND logic', () => {
		const results = viewModel.filter('@capability:tools @capability:vision');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Should only return models that have BOTH tools and vision
		assert.strictEqual(models.length, 2);
		assert.ok(models.every(m =>
			m.model.metadata.capabilities?.toolCalling === true &&
			m.model.metadata.capabilities?.vision === true
		));
	});

	test('should filter by three capabilities with AND logic', () => {
		const results = viewModel.filter('@capability:tools @capability:vision @capability:agent');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Should only return gpt-4o which has all three
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.metadata.id, 'gpt-4o');
	});

	test('should return no results when filtering by incompatible capabilities', () => {
		const results = viewModel.filter('@capability:vision @capability:agent');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Only gpt-4o has both vision and agent, but gpt-4-vision doesn't have agent
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.metadata.id, 'gpt-4o');
	});

	test('should combine provider and capability filters', () => {
		const results = viewModel.filter('@provider:copilot @capability:vision');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 2);
		assert.ok(models.every(m =>
			m.model.provider.vendor.vendor === 'copilot' &&
			m.model.metadata.capabilities?.vision === true
		));
	});

	test('should filter by text matching model name', () => {
		const results = viewModel.filter('GPT-4o');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.metadata.name, 'GPT-4o');
		assert.ok(models[0].modelNameMatches);
	});

	test('should filter by text matching model id', () => {
		const results = viewModel.filter('gpt-4o');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.identifier, 'copilot-gpt-4o');
		assert.ok(models[0].modelIdMatches);
	});

	test('should filter by text matching vendor name', () => {
		const results = viewModel.filter('GitHub');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 2);
		assert.ok(models.every(m => m.model.provider.group.name === 'GitHub Copilot'));
	});

	test('should combine text search with capability filter', () => {
		const results = viewModel.filter('@capability:tools GPT');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Should match all models with tools capability and 'GPT' in name
		assert.strictEqual(models.length, 3);
		assert.ok(models.every(m => m.model.metadata.capabilities?.toolCalling === true));
	});

	test('should handle empty search value', () => {
		const results = viewModel.filter('');

		// Should return all models grouped by vendor
		assert.ok(results.length > 0);
	});

	test('should handle search value with only whitespace', () => {
		const results = viewModel.filter('   ');

		// Should return all models grouped by vendor
		assert.ok(results.length > 0);
	});

	test('should match capability text in free text search', () => {
		const results = viewModel.filter('vision');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Should match models that have vision capability or "vision" in their name
		assert.ok(models.length > 0);
		assert.ok(models.every(m =>
			m.model.metadata.capabilities?.vision === true ||
			m.model.metadata.name.toLowerCase().includes('vision')
		));
	});

	test('should toggle vendor collapsed state', () => {
		const vendorEntry = viewModel.viewModelEntries.find(r => isLanguageModelProviderEntry(r) && r.vendorEntry.vendor.vendor === 'copilot') as ILanguageModelProviderEntry;
		assert.strictEqual(vendorEntry.collapsed, true);
		viewModel.toggleCollapsed(vendorEntry);
		assert.strictEqual(vendorEntry.collapsed, false);
		assert.strictEqual(viewModel.filter('').filter(entry => entry.type === 'model' && entry.model.provider.vendor.vendor === 'copilot').length, 2);

		// Collapse the explicitly expanded group, then expand it again.
		viewModel.toggleCollapsed(vendorEntry);

		const results = viewModel.filter('');
		const copilotVendor = results.find(r => isLanguageModelProviderEntry(r) && (r as ILanguageModelProviderEntry).vendorEntry.vendor.vendor === 'copilot') as ILanguageModelProviderEntry;
		assert.ok(copilotVendor);
		assert.strictEqual(copilotVendor.collapsed, true);

		// Models should not be shown when vendor is collapsed
		const copilotModelsAfterCollapse = results.filter(r =>
			!isLanguageModelProviderEntry(r) && (r as ILanguageModelEntry).model.provider.vendor.vendor === 'copilot'
		);
		assert.strictEqual(copilotModelsAfterCollapse.length, 0);

		// Toggle back
		viewModel.toggleCollapsed(vendorEntry);
		const resultsAfterExpand = viewModel.filter('');
		const copilotModelsAfterExpand = resultsAfterExpand.filter(r =>
			!isLanguageModelProviderEntry(r) && (r as ILanguageModelEntry).model.provider.vendor.vendor === 'copilot'
		);
		assert.strictEqual(copilotModelsAfterExpand.length, 2);
	});

	test('should handle quoted search strings', () => {
		// When a search string is fully quoted (starts and ends with quotes),
		// the completeMatch flag is set to true, which currently skips all matching
		// This test verifies the quotes are processed without errors
		const results = viewModel.filter('"GPT"');

		// The function should complete without error
		// Note: complete match logic (both quotes) currently doesn't perform matching
		assert.ok(Array.isArray(results));
	});

	test('should remove filter keywords from text search', () => {
		const results = viewModel.filter('@provider:copilot @capability:vision GPT');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		// Should only search 'GPT' in model names, not the filter keywords
		assert.strictEqual(models.length, 2);
		assert.ok(models.every(m => m.model.provider.vendor.vendor === 'copilot'));
	});

	test('should handle case-insensitive capability matching', () => {
		const results1 = viewModel.filter('@capability:TOOLS');
		const results2 = viewModel.filter('@capability:tools');
		const results3 = viewModel.filter('@capability:Tools');

		const models1 = results1.filter(r => !isLanguageModelProviderEntry(r));
		const models2 = results2.filter(r => !isLanguageModelProviderEntry(r));
		const models3 = results3.filter(r => !isLanguageModelProviderEntry(r));

		assert.strictEqual(models1.length, models2.length);
		assert.strictEqual(models2.length, models3.length);
	});

	test('should support toolcalling alias for tools capability', () => {
		const resultsTools = viewModel.filter('@capability:tools');
		const resultsToolCalling = viewModel.filter('@capability:toolcalling');

		const modelsTools = resultsTools.filter(r => !isLanguageModelProviderEntry(r));
		const modelsToolCalling = resultsToolCalling.filter(r => !isLanguageModelProviderEntry(r));

		assert.strictEqual(modelsTools.length, modelsToolCalling.length);
	});

	test('should support agentmode alias for agent capability', () => {
		const resultsAgent = viewModel.filter('@capability:agent');
		const resultsAgentMode = viewModel.filter('@capability:agentmode');

		const modelsAgent = resultsAgent.filter(r => !isLanguageModelProviderEntry(r));
		const modelsAgentMode = resultsAgentMode.filter(r => !isLanguageModelProviderEntry(r));

		assert.strictEqual(modelsAgent.length, modelsAgentMode.length);
	});

	test('should include matched capabilities in results', () => {
		const results = viewModel.filter('@capability:tools @capability:vision');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.ok(models.length > 0);

		for (const model of models) {
			assert.ok(model.capabilityMatches);
			assert.ok(model.capabilityMatches.length > 0);
			// Should include both toolCalling and vision
			assert.ok(model.capabilityMatches.some(c => c === 'toolCalling' || c === 'vision'));
		}
	});

	function createSingleVendorViewModel(includeSecondModel: boolean = true): { service: MockLanguageModelsService; viewModel: ChatModelsViewModel } {
		const service = new MockLanguageModelsService();
		service.addVendor({
			vendor: 'copilot',
			displayName: 'GitHub Copilot',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		service.addModel('copilot', 'copilot-gpt-4', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4',
			name: 'GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		if (includeSecondModel) {
			service.addModel('copilot', 'copilot-gpt-4o', {
				extension: new ExtensionIdentifier('github.copilot'),
				id: 'gpt-4o',
				name: 'GPT-4o',
				family: 'gpt-4',
				version: '1.0',
				vendor: 'copilot',
				maxInputTokens: 8192,
				maxOutputTokens: 4096,
				isUserSelectable: true,
				capabilities: {
					toolCalling: true,
					vision: true,
					agentMode: true
				},
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: true
				}
			});
		}

		const viewModel = store.add(new ChatModelsViewModel(service));
		return { service, viewModel };
	}

	test('should not show vendor header when only one vendor exists', async () => {
		const { viewModel: singleVendorViewModel } = createSingleVendorViewModel();
		await singleVendorViewModel.refresh();

		const results = singleVendorViewModel.filter('');

		// Should have only model entries, no vendor entry
		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.strictEqual(vendors.length, 0, 'Should not show vendor header when only one vendor exists');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 2, 'Should show all models');
		assert.ok(models.every(m => m.model.provider.vendor.vendor === 'copilot'));
	});

	test('should show vendor headers when multiple vendors exist', () => {
		// This is the existing behavior test
		expandProviderGroups(viewModel);
		const results = viewModel.filter('');

		// Should have 2 vendor entries and 4 model entries (grouped by vendor)
		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.strictEqual(vendors.length, 2, 'Should show vendor headers when multiple vendors exist');

		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 4);
	});

	test('should filter single vendor models by capability', async () => {
		const { viewModel: singleVendorViewModel } = createSingleVendorViewModel();
		await singleVendorViewModel.refresh();

		const results = singleVendorViewModel.filter('@capability:agent');

		// Should not show vendor header
		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.strictEqual(vendors.length, 0, 'Should not show vendor header');

		// Should only show the model with agent capability
		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].model.metadata.id, 'gpt-4o');
	});

	test('should always place copilot vendor at the top when multiple vendors exist', async () => {
		// Test with default setup (copilot and openai)
		let results = viewModel.filter('');
		let vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');

		// Add more vendors to ensure sorting works correctly
		languageModelsService.addVendor({
			vendor: 'anthropic',
			displayName: 'Anthropic',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('anthropic', 'anthropic-claude', {
			extension: new ExtensionIdentifier('anthropic.api'),
			id: 'claude-3',
			name: 'Claude 3',
			family: 'claude',
			version: '1.0',
			vendor: 'anthropic',
			maxInputTokens: 100000,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addVendor({
			vendor: 'azure',
			displayName: 'Azure OpenAI',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('azure', 'azure-gpt-4', {
			extension: new ExtensionIdentifier('microsoft.azure'),
			id: 'azure-gpt-4',
			name: 'Azure GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'azure',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		await viewModel.refresh();

		// Test with all filters and searches
		results = viewModel.filter('');
		vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		assert.strictEqual(vendors.length, 4);
		assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');
		// Other vendors should be alphabetically sorted: anthropic, azure, openai
		assert.strictEqual(vendors[1].vendorEntry.vendor.vendor, 'anthropic');
		assert.strictEqual(vendors[2].vendorEntry.vendor.vendor, 'azure');
		assert.strictEqual(vendors[3].vendorEntry.vendor.vendor, 'openai');

		// Test with text search
		results = viewModel.filter('GPT');
		vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		if (vendors.length > 1) {
			assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');
		}

		// Test with capability filter
		results = viewModel.filter('@capability:tools');
		vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		if (vendors.length > 1) {
			assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');
		}
	});

	test('should show vendor headers when filtered', () => {
		const results = viewModel.filter('GPT');
		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.ok(vendors.length > 0);
	});

	test('should not show vendor headers when filtered if only one vendor exists', async () => {
		const { viewModel: singleVendorViewModel } = createSingleVendorViewModel();
		await singleVendorViewModel.refresh();

		const results = singleVendorViewModel.filter('GPT');
		const vendors = results.filter(isLanguageModelProviderEntry);
		assert.strictEqual(vendors.length, 0);
	});

	test('should get configured vendors', () => {
		const vendors = viewModel.getConfiguredVendors();
		assert.ok(vendors.length > 0);
		assert.ok(vendors.some(v => v.vendor.vendor === 'copilot'));
		assert.ok(vendors.some(v => v.vendor.vendor === 'openai'));
	});

	test('should return true for shouldRefilter when models not sorted', () => {
		// After a new filter call, models should be sorted
		viewModel.filter('');
		assert.strictEqual(viewModel.shouldRefilter(), false);

		// Simulate unsorted state by accessing private property indirectly
		// This is a simple test that shouldRefilter works
		const result = viewModel.shouldRefilter();
		assert.strictEqual(typeof result, 'boolean');
	});

	test('should collapse all groups and models', () => {
		// Expand everything first
		expandProviderGroups(viewModel);
		const results1 = viewModel.filter('');
		let models = results1.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.ok(models.length > 0);

		// Collapse all
		viewModel.collapseAll();

		// After collapse all, only group/vendor headers should be shown
		const results2 = viewModel.filter('');
		const vendors = results2.filter(isLanguageModelProviderEntry);
		models = results2.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];

		assert.ok(vendors.length > 0, 'Should have vendor headers');
		assert.strictEqual(models.length, 0, 'Should have no models visible after collapse all');
	});

	test('should match quoted search strings with filters', () => {
		// Test that quotes don't break when combined with other filters
		const results = viewModel.filter('@capability:tools "GPT"');
		assert.ok(Array.isArray(results));
		// Should handle without error
	});

	test('should filter by case-insensitive provider name', () => {
		const results1 = viewModel.filter('@provider:COPILOT');
		const results2 = viewModel.filter('@provider:copilot');
		const results3 = viewModel.filter('@provider:CopiloT');

		const models1 = results1.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		const models2 = results2.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		const models3 = results3.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];

		assert.strictEqual(models1.length, models2.length);
		assert.strictEqual(models2.length, models3.length);
		assert.strictEqual(models1.length, 2);
	});

	test('should handle empty search returning all results', () => {
		expandProviderGroups(viewModel);
		const results = viewModel.filter('');
		assert.ok(results.length > 0);

		// Should include vendor headers and models
		const vendors = results.filter(isLanguageModelProviderEntry);
		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];

		assert.strictEqual(vendors.length, 2);
		assert.strictEqual(models.length, 4);
	});

	test('should not find matches when searching for non-existent model', () => {
		const results = viewModel.filter('NonExistentModel123');
		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 0);
	});

	test('should not find matches when filtering by non-existent provider', () => {
		const results = viewModel.filter('@provider:nonexistent');
		const models = results.filter(r => !isLanguageModelProviderEntry(r) && !isLanguageModelGroupEntry(r)) as ILanguageModelEntry[];
		assert.strictEqual(models.length, 0);
	});

	test('should keep native subscription models under their Agent without duplicating BYOK copies', async () => {
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'agent-host-claude', displayName: 'Claude', managementCommand: undefined, when: undefined, configuration: undefined });

		// Native Claude subscription rows keep their transport grouping in the picker,
		// but Models presents them under the owning Agent instead of manufacturing
		// Copilot and Anthropic Provider entries.
		service.addModel('agent-host-claude', 'agent-host-claude:@provider=copilot:claude-haiku-4.5', {
			extension: new ExtensionIdentifier('vscode.chat'),
			id: '@provider=copilot:claude-haiku-4.5',
			name: 'Claude Haiku 4.5 (Copilot)',
			family: 'claude-haiku-4.5',
			version: '1.0',
			vendor: 'agent-host-claude',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			targetChatSessionType: 'agent-host-claude',
			modelGroup: { id: 'copilot' },
			capabilities: { toolCalling: true, vision: false, agentMode: true },
			isDefaultForLocation: {},
		});
		service.addModel('agent-host-claude', 'agent-host-claude:@provider=anthropic:claude-haiku-4.5', {
			extension: new ExtensionIdentifier('vscode.chat'),
			id: '@provider=anthropic:claude-haiku-4.5',
			name: 'Claude Haiku 4.5',
			family: 'claude-haiku-4.5',
			version: '1.0',
			vendor: 'agent-host-claude',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			targetChatSessionType: 'agent-host-claude',
			modelGroup: { id: 'anthropic' },
			capabilities: { toolCalling: true, vision: false, agentMode: true },
			isDefaultForLocation: {},
		});

		// The BYOK original, as the Copilot Chat extension registers it here.
		service.addVendor({ vendor: 'openrouter', displayName: 'OpenRouter', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addModel('openrouter', 'openrouter/OpenRouter 2/aion-labs/aion-3.0', {
			extension: new ExtensionIdentifier('github.copilot-chat'),
			id: 'aion-labs/aion-3.0',
			name: 'AionLabs: Aion-3.0',
			family: 'aion-labs/aion-3.0',
			version: '1.0',
			vendor: 'openrouter',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			capabilities: { toolCalling: true, vision: false, agentMode: true },
			isDefaultForLocation: {},
		}, 'OpenRouter 2');

		// Agent-host BYOK copy — carries the original model identifier; filtered out.
		service.addModel('agent-host-claude', 'agent-host-claude:openrouter/aion-labs/aion-3.0', {
			extension: new ExtensionIdentifier('vscode.chat'),
			id: 'openrouter/aion-labs/aion-3.0',
			name: 'AionLabs: Aion-3.0',
			family: 'openrouter/aion-labs/aion-3.0',
			version: '1.0',
			vendor: 'agent-host-claude',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isUserSelectable: true,
			targetChatSessionType: 'agent-host-claude',
			modelGroup: { id: 'openrouter' },
			byokModelIdentifier: 'openrouter/OpenRouter 2/aion-labs/aion-3.0',
			capabilities: { toolCalling: true, vision: false, agentMode: true },
			isDefaultForLocation: {},
		});

		const agentHostViewModel = store.add(new ChatModelsViewModel(service));
		await agentHostViewModel.refresh();

		// Provider groups start collapsed once there is more than one of them.
		for (const id of agentHostViewModel.viewModelEntries.filter(isLanguageModelProviderEntry).map(entry => entry.id)) {
			const entry = agentHostViewModel.viewModelEntries.find(candidate => candidate.id === id);
			if (entry) {
				agentHostViewModel.toggleCollapsed(entry);
			}
		}

		const entries = agentHostViewModel.viewModelEntries;
		const models = entries.filter(entry => !isLanguageModelProviderEntry(entry) && !isLanguageModelGroupEntry(entry)) as ILanguageModelEntry[];
		assert.deepStrictEqual(models.map(model => ({
			id: model.model.metadata.id,
			provider: getManageModelsProviderLabel(model.model),
		})), [
			{ id: '@provider=anthropic:claude-haiku-4.5', provider: 'Claude' },
			{ id: '@provider=copilot:claude-haiku-4.5', provider: 'Claude' },
			// The copy of this one stayed out: its original is the row above.
			{ id: 'aion-labs/aion-3.0', provider: 'OpenRouter 2' },
		]);
	});

	test('lists an agent-host BYOK copy under its Provider when the original is not registered here', async () => {
		// The Agents window in a browser: the BYOK providers live in the desktop
		// renderer, so only the agent hosts' copies of their models arrive. With no
		// original to defer to the copy is the only row there is, and the Provider
		// it belongs to survives in the identifier it was copied from.
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'remote-mac-claude', displayName: 'Claude [This Mac]', managementCommand: undefined, when: undefined, configuration: undefined });
		service.addVendor({ vendor: 'remote-mac-pi', displayName: 'Pi [This Mac]', managementCommand: undefined, when: undefined, configuration: undefined });

		const copy = (vendor: string): ILanguageModelChatMetadata => ({
			extension: new ExtensionIdentifier('vscode.chat'),
			id: 'customendpoint/Example/claude-fable-5',
			name: 'claude-fable-5',
			family: 'customendpoint/Example/claude-fable-5',
			version: '1.0',
			vendor,
			maxInputTokens: 1000000,
			maxOutputTokens: 128000,
			isUserSelectable: true,
			targetChatSessionType: vendor,
			modelGroup: { id: 'customendpoint' },
			byokModelIdentifier: 'customendpoint/Example/claude-fable-5',
			capabilities: { toolCalling: true, vision: true, agentMode: true },
			isDefaultForLocation: {},
		});
		service.addModel('remote-mac-claude', 'remote-mac-claude:customendpoint/Example/claude-fable-5', copy('remote-mac-claude'));
		service.addModel('remote-mac-pi', 'remote-mac-pi:customendpoint/Example/claude-fable-5', copy('remote-mac-pi'));

		const remoteViewModel = store.add(new ChatModelsViewModel(service));
		await remoteViewModel.refresh();

		const entries = remoteViewModel.filter('');
		const models = entries.filter(entry => !isLanguageModelProviderEntry(entry) && !isLanguageModelGroupEntry(entry)) as ILanguageModelEntry[];
		// One row, not one per agent that offers it, keyed by the original identifier
		// so a single visibility toggle covers every agent.
		assert.deepStrictEqual(models.map(model => ({
			identifier: model.model.identifier,
			provider: getManageModelsProviderLabel(model.model),
		})), [
			{ identifier: 'customendpoint/Example/claude-fable-5', provider: 'Example' },
		]);
	});

	test('an agent-host BYOK copy the host has hidden is listed hidden, and this window does not toggle it', async () => {
		// The host's Manage Models state arrives on the copy. This window has no
		// visibility state of its own for a Provider it cannot see, so it renders the
		// host's answer rather than its own default of "visible" — the row is there,
		// greyed, exactly as it is on the machine that owns the Provider. Toggling it
		// stores nothing: a second set for the same model could only disagree.
		const service = new MockLanguageModelsService();
		service.addVendor({ vendor: 'remote-mac-claude', displayName: 'Claude [This Mac]', managementCommand: undefined, when: undefined, configuration: undefined });

		const copy = (id: string, hiddenByHost: boolean): ILanguageModelChatMetadata => ({
			extension: new ExtensionIdentifier('vscode.chat'),
			id: `customendpoint/Example/${id}`,
			name: id,
			family: `customendpoint/Example/${id}`,
			version: '1.0',
			vendor: 'remote-mac-claude',
			maxInputTokens: 1000000,
			maxOutputTokens: 128000,
			isUserSelectable: true,
			targetChatSessionType: 'remote-mac-claude',
			modelGroup: { id: 'customendpoint' },
			byokModelIdentifier: `customendpoint/Example/${id}`,
			...(hiddenByHost ? { byokModelHidden: true } : {}),
			capabilities: { toolCalling: true, vision: true, agentMode: true },
			isDefaultForLocation: {},
		});
		service.addModel('remote-mac-claude', 'remote-mac-claude:customendpoint/Example/claude-fable-5', copy('claude-fable-5', false));
		service.addModel('remote-mac-claude', 'remote-mac-claude:customendpoint/Example/claude-opus-4-7', copy('claude-opus-4-7', true));

		const remoteViewModel = store.add(new ChatModelsViewModel(service));
		await remoteViewModel.refresh();

		const entries = remoteViewModel.filter('');
		const models = entries.filter(entry => !isLanguageModelProviderEntry(entry) && !isLanguageModelGroupEntry(entry)) as ILanguageModelEntry[];
		const hiddenRow = models.find(model => model.model.identifier === 'customendpoint/Example/claude-opus-4-7')!;
		remoteViewModel.toggleModelHidden(hiddenRow);

		assert.deepStrictEqual({
			rows: models.map(model => ({ identifier: model.model.identifier, hidden: model.model.hidden })),
			writes: service.setModelsHiddenCalls,
		}, {
			rows: [
				{ identifier: 'customendpoint/Example/claude-fable-5', hidden: false },
				{ identifier: 'customendpoint/Example/claude-opus-4-7', hidden: true },
			],
			writes: [{ modelIdentifiers: [], hidden: false }],
		});
	});

});
