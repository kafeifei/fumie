/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../../../base/common/arrays.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IMatch, IFilter, or, matchesCamelCase, matchesWords, matchesBaseContiguousSubString } from '../../../../../base/common/filters.js';
import { Emitter } from '../../../../../base/common/event.js';
import { getLanguageModelProviderDisplayName, ILanguageModelChatMetadata, ILanguageModelsService, ILanguageModelProviderDescriptor, ILanguageModelChatMetadataAndIdentifier, parseByokModelIdentifierGroup } from '../../../chat/common/languageModels.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import Severity from '../../../../../base/common/severity.js';
import { ILanguageModelSourcePresentation, languageModelSourcePresentationRegistry } from '../../common/languageModelSourcePresentation.js';

export const MODEL_ENTRY_TEMPLATE_ID = 'model.entry.template';
export const VENDOR_ENTRY_TEMPLATE_ID = 'vendor.entry.template';
export const GROUP_ENTRY_TEMPLATE_ID = 'group.entry.template';

const wordFilter = or(matchesBaseContiguousSubString, matchesWords);
const CAPABILITY_REGEX = /@capability:\s*([^\s]+)/gi;
const PROVIDER_REGEX = /@provider:\s*((".+?")|([^\s]+))/gi;

export const SEARCH_SUGGESTIONS = {
	FILTER_TYPES: [
		'@provider:',
		'@capability:',
	],
	CAPABILITIES: [
		'@capability:tools',
		'@capability:vision',
		'@capability:agent'
	],
};

export interface ILanguageModelProvider {
	vendor: ILanguageModelProviderDescriptor;
	group: ILanguageModelsProviderGroup;
	sourceId?: string;
	sourcePresentation?: ILanguageModelSourcePresentation;
	/**
	 * Whether {@link group} is an entry the user actually has in the models
	 * configuration file, as opposed to one synthesized for display — a BYOK
	 * model's upstream vendor, a model group's transport, or a vendor's own name
	 * standing in for a group that was never configured.
	 *
	 * Group commands address a group by `(vendor, name)` in that file, so they
	 * only mean anything for a real entry. Offering Rename or Delete on a
	 * synthesized row gives the user a button that silently does nothing.
	 */
	isConfiguredGroup?: boolean;
}

export interface ILanguageModel extends ILanguageModelChatMetadataAndIdentifier {
	provider: ILanguageModelProvider;
	hidden: boolean;
}

export function getManageModelsProviderLabel(model: ILanguageModel): string {
	return model.provider.group.name;
}

/**
 * Whether a provider row may offer the group commands (Open in JSON, Rename,
 * Delete, …).
 *
 * They address a group by `(vendor, name)` in the models configuration file, so
 * they need both a vendor configured through that file and a row that is a real
 * entry in it. A synthesized row — a BYOK model's upstream vendor, or a
 * transport group like the `openai` prefix a subscription model carries —
 * inherits the descriptor of whichever vendor published its models, so the
 * vendor half alone would arm Delete on a group the file has never heard of.
 */
export function canManageProviderGroup(provider: ILanguageModelProvider): boolean {
	return !!provider.vendor.configuration && !!provider.isConfiguredGroup;
}

/**
 * Whether a row's visibility is the agent host's to state rather than this window's.
 *
 * True for an agent-host copy of a BYOK model that is listed in its own right, i.e. one
 * whose original is not registered here — the Agents window in a browser. The host holds
 * the provider configuration and the Manage Models state that goes with it, so the row
 * shows what the host reports and this window's own hidden set is left out of it: keeping
 * a second set for the same model could only ever diverge from the first. Hiding from
 * here means asking the host to hide, which is not wired up yet
 * (`docs/architecture.md`).
 */
function isHostOwnedVisibility(metadata: ILanguageModelChatMetadata): boolean {
	return metadata.byokModelIdentifier !== undefined;
}

export interface ILanguageModelEntry {
	type: 'model';
	id: string;
	templateId: string;
	model: ILanguageModel;
	providerMatches?: IMatch[];
	modelNameMatches?: IMatch[];
	modelIdMatches?: IMatch[];
	capabilityMatches?: string[];
}

export interface ILanguageModelGroupEntry {
	type: 'group';
	id: string;
	label: string;
	collapsed: boolean;
	templateId: string;
}

export interface ILanguageModelProviderEntry {
	type: 'vendor';
	id: string;
	label: string;
	templateId: string;
	collapsed: boolean;
	hidden: boolean;
	sourcePresentation?: ILanguageModelSourcePresentation;
	vendorEntry: ILanguageModelProvider;
}

export interface IStatusEntry {
	type: 'status';
	id: string;
	message: string;
	severity: Severity;
	action?: IAction;
	/** See {@link ILanguageModelProviderStatus.explicitActionOnly}. */
	explicitActionOnly?: boolean;
}

export interface ILanguageModelEntriesGroup {
	group: ILanguageModelGroupEntry | ILanguageModelProviderEntry;
	models: ILanguageModel[];
	status?: IStatusEntry;
}

export function isLanguageModelProviderEntry(entry: IViewModelEntry): entry is ILanguageModelProviderEntry {
	return entry.type === 'vendor';
}

export function isLanguageModelGroupEntry(entry: IViewModelEntry): entry is ILanguageModelGroupEntry {
	return entry.type === 'group';
}

export function isStatusEntry(entry: IViewModelEntry): entry is IStatusEntry {
	return entry.type === 'status';
}

export type IViewModelEntry = ILanguageModelEntry | ILanguageModelProviderEntry | ILanguageModelGroupEntry | IStatusEntry;

export interface IViewModelChangeEvent {
	at: number;
	removed: number;
	added: IViewModelEntry[];
}

export const enum ChatModelGroup {
	Vendor = 'vendor',
}

export class ChatModelsViewModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IViewModelChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeGrouping = this._register(new Emitter<ChatModelGroup>());
	readonly onDidChangeGrouping = this._onDidChangeGrouping.event;

	private languageModels: ILanguageModel[];
	private languageModelGroupStatuses: Array<{ provider: ILanguageModelProvider; status: { severity: Severity; message: string; action?: IAction; explicitActionOnly?: boolean } }> = [];
	private languageModelGroups: ILanguageModelEntriesGroup[] = [];

	private readonly collapsedGroups = new Set<string>();
	private readonly seenGroups = new Set<string>();
	private searchValue: string = '';
	private modelsSorted: boolean = false;

	private _groupBy: ChatModelGroup = ChatModelGroup.Vendor;
	get groupBy(): ChatModelGroup { return this._groupBy; }
	set groupBy(groupBy: ChatModelGroup) {
		if (this._groupBy !== groupBy) {
			this._groupBy = groupBy;
			this.collapsedGroups.clear();
			this.languageModelGroups = this.groupModels(this.languageModels);
			this.doFilter();
			this._onDidChangeGrouping.fire(groupBy);
		}
	}

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super();
		this.languageModels = [];
		this._register(this.languageModelsService.onDidChangeLanguageModels(vendor => this.refreshVendor(vendor)));
		this._register(this.languageModelsService.onDidChangeModelVisibility(() => this.refreshVisibility()));
	}

	private readonly _viewModelEntries: IViewModelEntry[] = [];
	get viewModelEntries(): readonly IViewModelEntry[] {
		return this._viewModelEntries;
	}
	private splice(at: number, removed: number, added: IViewModelEntry[]): void {
		this._viewModelEntries.splice(at, removed, ...added);
		if (this.selectedEntry) {
			this.selectedEntry = this._viewModelEntries.find(entry => entry.id === this.selectedEntry?.id);
		}
		this._onDidChange.fire({ at, removed, added });
	}

	selectedEntry: IViewModelEntry | undefined;

	public shouldRefilter(): boolean {
		return !this.modelsSorted;
	}

	filter(searchValue: string): readonly IViewModelEntry[] {
		if (searchValue !== this.searchValue) {
			this.searchValue = searchValue;
			this.collapsedGroups.clear();
			if (!this.modelsSorted) {
				this.languageModelGroups = this.groupModels(this.languageModels);
			}
			this.doFilter();
		}
		return this.viewModelEntries;
	}

	private doFilter(): void {
		const viewModelEntries: IViewModelEntry[] = [];
		const shouldShowGroupHeaders = this.languageModelGroups.length > 1
			|| this.languageModelGroups.some(group => isLanguageModelProviderEntry(group.group) && group.group.sourcePresentation !== undefined);

		for (const group of this.languageModelGroups) {
			// A collapsed group without a visible header row would make its
			// models unreachable, so collapsing only applies with headers.
			if (shouldShowGroupHeaders && this.collapsedGroups.has(group.group.id)) {
				group.group.collapsed = true;
				if (shouldShowGroupHeaders) {
					viewModelEntries.push(group.group);
				}
				continue;
			}

			const groupEntries: IViewModelEntry[] = [];
			if (group.status) {
				groupEntries.push(group.status);
			}

			groupEntries.push(...this.filterModels(group.models, this.searchValue));

			if (groupEntries.length > 0) {
				group.group.collapsed = false;
				if (shouldShowGroupHeaders) {
					viewModelEntries.push(group.group);
				}
				viewModelEntries.push(...groupEntries);
			}
		}
		this.splice(0, this._viewModelEntries.length, viewModelEntries);
	}

	private filterModels(modelEntries: ILanguageModel[], searchValue: string): IViewModelEntry[] {
		const providerNames: string[] = [];
		let providerMatch: RegExpExecArray | null;
		PROVIDER_REGEX.lastIndex = 0;
		while ((providerMatch = PROVIDER_REGEX.exec(searchValue)) !== null) {
			const providerName = providerMatch[2] ? providerMatch[2].substring(1, providerMatch[2].length - 1) : providerMatch[3];
			providerNames.push(providerName);
		}
		if (providerNames.length > 0) {
			searchValue = searchValue.replace(PROVIDER_REGEX, '');
		}

		const capabilities: string[] = [];
		let capabilityMatch: RegExpExecArray | null;
		CAPABILITY_REGEX.lastIndex = 0;
		while ((capabilityMatch = CAPABILITY_REGEX.exec(searchValue)) !== null) {
			capabilities.push(capabilityMatch[1].toLowerCase());
		}
		if (capabilities.length > 0) {
			searchValue = searchValue.replace(CAPABILITY_REGEX, '');
		}

		const quoteAtFirstChar = searchValue.charAt(0) === '"';
		const quoteAtLastChar = searchValue.charAt(searchValue.length - 1) === '"';
		const completeMatch = quoteAtFirstChar && quoteAtLastChar;
		if (quoteAtFirstChar) {
			searchValue = searchValue.substring(1);
		}
		if (quoteAtLastChar) {
			searchValue = searchValue.substring(0, searchValue.length - 1);
		}
		searchValue = searchValue.trim();

		const result: IViewModelEntry[] = [];
		const words = searchValue.split(' ');
		const lowerProviders = providerNames.map(p => p.toLowerCase().trim());

		for (const modelEntry of modelEntries) {
			if (lowerProviders.length > 0) {
				const matchesProvider = lowerProviders.some(provider =>
					modelEntry.provider.vendor.vendor.toLowerCase() === provider ||
					modelEntry.provider.vendor.displayName.toLowerCase() === provider ||
					modelEntry.provider.group.vendor.toLowerCase() === provider ||
					modelEntry.provider.group.name.toLowerCase() === provider
				);
				if (!matchesProvider) {
					continue;
				}
			}

			// Filter by capabilities
			let matchedCapabilities: string[] = [];
			if (capabilities.length > 0) {
				if (!modelEntry.metadata.capabilities) {
					continue;
				}
				let matchesAll = true;
				for (const capability of capabilities) {
					const matchedForThisCapability = this.getMatchingCapabilities(modelEntry, capability);
					if (matchedForThisCapability.length === 0) {
						matchesAll = false;
						break;
					}
					matchedCapabilities.push(...matchedForThisCapability);
				}
				if (!matchesAll) {
					continue;
				}
				matchedCapabilities = distinct(matchedCapabilities);
			}

			// Filter by text
			let modelMatches: ModelItemMatches | undefined;
			if (searchValue) {
				modelMatches = new ModelItemMatches(modelEntry, searchValue, words, completeMatch);
				if (!modelMatches.modelNameMatches && !modelMatches.modelIdMatches && !modelMatches.providerMatches && !modelMatches.capabilityMatches) {
					continue;
				}
			}

			const modelId = this.getModelId(modelEntry);
			result.push({
				type: 'model',
				id: modelId,
				templateId: MODEL_ENTRY_TEMPLATE_ID,
				model: modelEntry,
				modelNameMatches: modelMatches?.modelNameMatches || undefined,
				modelIdMatches: modelMatches?.modelIdMatches || undefined,
				providerMatches: modelMatches?.providerMatches || undefined,
				capabilityMatches: matchedCapabilities.length ? matchedCapabilities : undefined,
			});
		}
		return result;
	}

	private getMatchingCapabilities(modelEntry: ILanguageModel, capability: string): string[] {
		const matchedCapabilities: string[] = [];
		if (!modelEntry.metadata.capabilities) {
			return matchedCapabilities;
		}

		switch (capability) {
			case 'tools':
			case 'toolcalling':
				if (modelEntry.metadata.capabilities.toolCalling === true) {
					matchedCapabilities.push('toolCalling');
				}
				break;
			case 'vision':
				if (modelEntry.metadata.capabilities.vision === true) {
					matchedCapabilities.push('vision');
				}
				break;
			case 'agent':
			case 'agentmode':
				if (modelEntry.metadata.capabilities.agentMode === true) {
					matchedCapabilities.push('agentMode');
				}
				break;
			default:
				// Check edit tools
				if (modelEntry.metadata.capabilities.editTools) {
					for (const tool of modelEntry.metadata.capabilities.editTools) {
						if (tool.toLowerCase().includes(capability)) {
							matchedCapabilities.push(tool);
						}
					}
				}
				break;
		}
		return matchedCapabilities;
	}

	private groupModels(languageModels: ILanguageModel[]): ILanguageModelEntriesGroup[] {
		const result: ILanguageModelEntriesGroup[] = [];
		if (this.groupBy === ChatModelGroup.Vendor) {
			// One row per model. Identifiers are unique per registered model, so this
			// only bites for agent-host BYOK copies keyed by their shared original:
			// every agent that can run the model contributes one, and the provider's
			// group must list it once, as it would if the provider were configured here.
			const placed = new Set<string>();
			for (const model of languageModels) {
				if (placed.has(model.identifier)) {
					continue;
				}
				placed.add(model.identifier);
				const groupId = this.getProviderGroupId(model.provider);
				let group = result.find(group => group.group.id === groupId);
				if (!group) {
					group = {
						group: this.createLanguageModelProviderEntry(model.provider),
						models: [],
					};
					result.push(group);
				}
				group.models.push(model);
			}
			for (const statusGroup of this.languageModelGroupStatuses) {
				const groupId = this.getProviderGroupId(statusGroup.provider);
				let group = result.find(group => group.group.id === groupId);
				if (!group) {
					group = {
						group: this.createLanguageModelProviderEntry(statusGroup.provider),
						models: [],
					};
					result.push(group);
				}
				group.status = {
					id: `status.${group.group.id}`,
					type: 'status',
					...statusGroup.status,
				};
			}
			result.sort((a, b) => {
				if (a.models[0]?.provider.vendor.isDefault) { return -1; }
				if (b.models[0]?.provider.vendor.isDefault) { return 1; }
				return a.group.label.localeCompare(b.group.label);
			});
		}
		for (const group of result) {
			if (isLanguageModelProviderEntry(group.group)) {
				group.group.hidden = group.models.length > 0 && group.models.every(model => model.hidden);
			}
			group.models.sort((a, b) => {
				if (a.provider.vendor.isDefault && b.provider.vendor.isDefault) {
					return a.metadata.name.localeCompare(b.metadata.name);
				}
				if (a.provider.vendor.isDefault) { return -1; }
				if (b.provider.vendor.isDefault) { return 1; }
				if (a.provider.group.name === b.provider.group.name) {
					return a.metadata.name.localeCompare(b.metadata.name);
				}
				return a.provider.group.name.localeCompare(b.provider.group.name);
			});
		}
		this.modelsSorted = true;
		return result;
	}

	private createLanguageModelProviderEntry(provider: ILanguageModelProvider): ILanguageModelProviderEntry {
		const id = this.getProviderGroupId(provider);
		// Provider groups start collapsed the first time they appear (vendors
		// resolve asynchronously, so seeding happens per group, not once).
		// While a search is active the group must stay expanded to show matches.
		if (!this.seenGroups.has(id)) {
			this.seenGroups.add(id);
			if (!this.searchValue) {
				this.collapsedGroups.add(id);
			}
		}
		return {
			type: 'vendor',
			id,
			label: provider.group.name,
			templateId: VENDOR_ENTRY_TEMPLATE_ID,
			collapsed: this.collapsedGroups.has(id),
			hidden: false,
			sourcePresentation: provider.sourcePresentation,
			vendorEntry: provider,
		};
	}

	/**
	 * The vendors this list is about. A vendor marked `hiddenFromManagement` is
	 * dropped here rather than at render time, so it takes its models with it —
	 * and with them the groups derived from those models, such as a ChatGPT
	 * source row, which exist only for as long as something is in them.
	 */
	getVendors(): ILanguageModelProviderDescriptor[] {
		return this.languageModelsService.getVendors()
			.filter(vendor => !vendor.hiddenFromManagement)
			.sort((a, b) => {
				if (a.isDefault) { return -1; }
				if (b.isDefault) { return 1; }
				return a.displayName.localeCompare(b.displayName);
			});
	}

	async refresh(): Promise<void> {
		await this.languageModelsService.selectLanguageModels({});
		await this.refreshAllVendors();
	}

	private async refreshAllVendors(): Promise<void> {
		this.languageModels = [];
		this.languageModelGroupStatuses = [];
		for (const vendor of this.getVendors()) {
			this.addVendorModels(vendor);
		}
		this.languageModelGroups = this.groupModels(this.languageModels);
		this.doFilter();
	}

	private refreshVendor(vendorId: string): void {
		const vendor = this.getVendors().find(v => v.vendor === vendorId);
		if (!vendor) {
			return;
		}

		// Remove existing models for this vendor
		this.languageModels = this.languageModels.filter(m => m.provider.vendor.vendor !== vendorId);
		this.languageModelGroupStatuses = this.languageModelGroupStatuses.filter(s => s.provider.vendor.vendor !== vendorId);

		// Add updated models for this vendor
		this.addVendorModels(vendor);
		this.languageModelGroups = this.groupModels(this.languageModels);
		this.doFilter();
	}

	private addVendorModels(vendor: ILanguageModelProviderDescriptor): void {
		const models: ILanguageModel[] = [];
		const languageModelsGroups = this.languageModelsService.getLanguageModelGroups(vendor.vendor);
		for (const group of languageModelsGroups) {
			const defaultProvider: ILanguageModelProvider = {
				group: group.group ?? {
					vendor: vendor.vendor,
					name: vendor.displayName
				},
				vendor,
				isConfiguredGroup: !!group.group
			};
			if (group.status) {
				this.languageModelGroupStatuses.push({
					provider: defaultProvider,
					status: {
						message: group.status.message,
						severity: group.status.severity,
						action: group.status.action,
						explicitActionOnly: group.status.explicitActionOnly
					}
				});
			}
			for (const identifier of group.modelIdentifiers) {
				const metadata = this.languageModelsService.lookupLanguageModel(identifier);
				if (!metadata) {
					continue;
				}
				if (vendor.isDefault && metadata.id === 'auto') {
					continue;
				}
				// Agent-host BYOK models are copies of the user's own BYOK models surfaced
				// by an agent host (e.g. Copilot CLI). Where the original is registered here
				// it already has a row under its real provider group, so listing the copies
				// too would duplicate the entire BYOK catalogue (e.g. hundreds of OpenRouter
				// models under "Copilot"). Skip them there. A window that reaches the
				// catalogue only through a host — the Agents window in a browser — has no
				// original to defer to, so the copy is the row: it keeps the provider name
				// carried in the identifier, and is keyed by that identifier so one toggle
				// covers every agent that offers the same model.
				const byokIdentifier = ILanguageModelChatMetadata.getAgentHostByokManageModelsIdentifier(metadata);
				if (byokIdentifier !== undefined && this.languageModelsService.lookupLanguageModel(byokIdentifier)) {
					continue;
				}
				const byokGroup = byokIdentifier !== undefined ? parseByokModelIdentifierGroup(byokIdentifier) : undefined;
				const sourcePresentation = metadata.modelGroup?.sourceId
					? languageModelSourcePresentationRegistry.get(metadata.vendor, metadata.modelGroup.sourceId)
					: undefined;
				// A session model's transport group is picker presentation (for example,
				// Claude can offer the same subscription model through `anthropic` and
				// `copilot`). Manage Models must keep those native subscription rows without
				// manufacturing configurable transport Providers from their group ids. A
				// trusted source presentation, such as ChatGPT subscription, remains its own
				// explicit group; otherwise native session rows stay under the owning Agent.
				//
				// But only when there is no real group to fall into. A subscription provider
				// the user added *has* a configured group — its own entry — and its models
				// belong under that row. Deriving a separate group from their `modelGroup`
				// (the ChatGPT transport, say) would strand every model in a phantom row with
				// no delete, leaving the added provider empty. The derivation is for vendors
				// with no configured group of their own, where the alternative is a bare
				// source id. The picker keeps its own ChatGPT group regardless: it reads
				// `modelGroup` and the source registry directly, untouched by this.
				const provider = byokGroup ? {
					vendor,
					group: {
						vendor: byokGroup.vendor,
						name: byokGroup.name ?? getLanguageModelProviderDisplayName(this.languageModelsService, byokGroup.vendor),
					},
				} satisfies ILanguageModelProvider : !group.group && metadata.modelGroup && (metadata.targetChatSessionType === undefined || sourcePresentation !== undefined) ? {
					vendor,
					group: {
						vendor: metadata.modelGroup.id,
						name: sourcePresentation?.label ?? getLanguageModelProviderDisplayName(this.languageModelsService, metadata.modelGroup.id),
					},
					sourceId: metadata.modelGroup.sourceId,
					sourcePresentation,
				} satisfies ILanguageModelProvider : defaultProvider;
				const rowIdentifier = byokIdentifier ?? identifier;
				models.push({
					identifier: rowIdentifier,
					metadata,
					provider,
					hidden: isHostOwnedVisibility(metadata) ? metadata.byokModelHidden === true : this.languageModelsService.isModelHidden(rowIdentifier),
				});
			}
		}
		this.languageModels.push(...models.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)));
	}

	getModelsForGroup(group: ILanguageModelProviderEntry | ILanguageModelGroupEntry): ILanguageModel[] {
		if (isLanguageModelProviderEntry(group)) {
			return this.languageModels.filter(m =>
				this.getProviderGroupId(m.provider) === group.id
			);
		}

		// return all models ungrouped
		return this.languageModels;
	}

	toggleModelHidden(entry: ILanguageModelEntry): void {
		this.setModelsHidden([entry], !entry.model.hidden);
	}

	toggleGroupHidden(entry: ILanguageModelProviderEntry): void {
		this.languageModelsService.setModelsHidden(this.getModelsForGroup(entry).filter(model => !isHostOwnedVisibility(model.metadata)).map(model => model.identifier), !entry.hidden);
	}

	setModelsHidden(entries: readonly ILanguageModelEntry[], hidden: boolean): void {
		// Host-owned rows are skipped rather than stored: their state is the host's, and
		// a local entry for them would show nowhere while quietly disagreeing with it.
		this.languageModelsService.setModelsHidden(entries.filter(entry => !isHostOwnedVisibility(entry.model.metadata)).map(entry => entry.model.identifier), hidden);
	}

	private refreshVisibility(): void {
		for (const model of this.languageModels) {
			if (isHostOwnedVisibility(model.metadata)) {
				continue;
			}
			model.hidden = this.languageModelsService.isModelHidden(model.identifier);
		}
		// Rebuild groups so provider/group header `hidden` reflects the new state.
		this.languageModelGroups = this.groupModels(this.languageModels);
		this.doFilter();
	}

	private getModelId(modelEntry: ILanguageModel): string {
		return `${modelEntry.provider.group.name}.${modelEntry.identifier}.${modelEntry.metadata.version}`;
	}

	private getProviderGroupId(provider: ILanguageModelProvider): string {
		return `${provider.group.vendor}-${provider.group.name}-${provider.sourceId ?? 'configured'}`;
	}

	toggleCollapsed(viewModelEntry: IViewModelEntry): void {
		const id = isLanguageModelGroupEntry(viewModelEntry) ? viewModelEntry.id : isLanguageModelProviderEntry(viewModelEntry) ? viewModelEntry.id : undefined;
		if (!id) {
			return;
		}
		this.selectedEntry = viewModelEntry;
		if (!this.collapsedGroups.delete(id)) {
			this.collapsedGroups.add(id);
		}
		this.doFilter();
	}

	collapseAll(): void {
		this.collapsedGroups.clear();
		for (const entry of this.viewModelEntries) {
			if (isLanguageModelProviderEntry(entry) || isLanguageModelGroupEntry(entry)) {
				this.collapsedGroups.add(entry.id);
			}
		}
		this.doFilter();
	}

	getConfiguredVendors(): ILanguageModelProvider[] {
		const result: ILanguageModelProvider[] = [];
		const seenVendors = new Set<string>();
		for (const modelEntry of this.languageModels) {
			if (!seenVendors.has(modelEntry.provider.group.name)) {
				seenVendors.add(modelEntry.provider.group.name);
				result.push(modelEntry.provider);
			}
		}
		return result;
	}
}

class ModelItemMatches {

	readonly modelNameMatches: IMatch[] | null = null;
	readonly modelIdMatches: IMatch[] | null = null;
	readonly providerMatches: IMatch[] | null = null;
	readonly capabilityMatches: IMatch[] | null = null;

	constructor(modelEntry: ILanguageModel, searchValue: string, words: string[], completeMatch: boolean) {
		if (!completeMatch) {
			// Match against model name
			this.modelNameMatches = modelEntry.metadata.name ?
				this.matches(searchValue, modelEntry.metadata.name, (word, wordToMatchAgainst) => matchesWords(word, wordToMatchAgainst, true), words) :
				null;

			this.modelIdMatches = this.matches(searchValue, modelEntry.metadata.id, or(matchesWords, matchesCamelCase), words);

			// Match against vendor display name
			this.providerMatches = this.matches(searchValue, modelEntry.provider.group.name, (word, wordToMatchAgainst) => matchesWords(word, wordToMatchAgainst, true), words);

			// Match against capabilities
			if (modelEntry.metadata.capabilities) {
				const capabilityStrings: string[] = [];
				if (modelEntry.metadata.capabilities.toolCalling) {
					capabilityStrings.push('tools', 'toolCalling');
				}
				if (modelEntry.metadata.capabilities.vision) {
					capabilityStrings.push('vision');
				}
				if (modelEntry.metadata.capabilities.agentMode) {
					capabilityStrings.push('agent', 'agentMode');
				}
				if (modelEntry.metadata.capabilities.editTools) {
					capabilityStrings.push(...modelEntry.metadata.capabilities.editTools);
				}

				const capabilityString = capabilityStrings.join(' ');
				if (capabilityString) {
					this.capabilityMatches = this.matches(searchValue, capabilityString, or(matchesWords, matchesCamelCase), words);
				}
			}
		}
	}

	private matches(searchValue: string | null, wordToMatchAgainst: string, wordMatchesFilter: IFilter, words: string[]): IMatch[] | null {
		let matches = searchValue ? wordFilter(searchValue, wordToMatchAgainst) : null;
		if (!matches) {
			matches = this.matchesWords(words, wordToMatchAgainst, wordMatchesFilter);
		}
		if (matches) {
			matches = this.filterAndSort(matches);
		}
		return matches;
	}

	private matchesWords(words: string[], wordToMatchAgainst: string, wordMatchesFilter: IFilter): IMatch[] | null {
		let matches: IMatch[] | null = [];
		for (const word of words) {
			const wordMatches = wordMatchesFilter(word, wordToMatchAgainst);
			if (wordMatches) {
				matches = [...(matches || []), ...wordMatches];
			} else {
				matches = null;
				break;
			}
		}
		return matches;
	}

	private filterAndSort(matches: IMatch[]): IMatch[] {
		return distinct(matches, (a => a.start + '.' + a.end))
			.filter(match => !matches.some(m => !(m.start === match.start && m.end === match.end) && (m.start <= match.start && m.end >= match.end)))
			.sort((a, b) => a.start - b.start);
	}
}
