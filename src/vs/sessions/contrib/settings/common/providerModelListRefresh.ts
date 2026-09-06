/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { isString } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';

const CUSTOM_ENDPOINT_VENDOR = 'customendpoint';

/**
 * A new entry copies its metadata from the configured sibling sharing the
 * longest id prefix (e.g. `claude-opus-4-9` from `claude-opus-4-8`), so
 * hand-tuned fields like `thinking` or `fumieHarnesses` carry over to new
 * versions of the same family. Below this prefix length the match is noise.
 */
const MIN_SIBLING_PREFIX = 4;

/**
 * One entry of the provider's live listing. `name` is the human readable label
 * the endpoint offered, if any: Anthropic-compatible listings carry
 * `display_name`, plain OpenAI-compatible ones usually carry nothing at all.
 */
export interface IUpstreamModel {
	readonly id: string;
	readonly name?: string;
}

export interface IProviderModelListMerge {
	readonly models: readonly IStringDictionary<unknown>[];
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly renamed: readonly string[];
}

export interface IProviderGroupRefreshOutcome {
	readonly groupName: string;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly renamed: readonly string[];
	readonly error?: string;
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let index = 0;
	while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) {
		index++;
	}
	return index;
}

function newModelEntry(model: IUpstreamModel, existing: readonly IStringDictionary<unknown>[], fallbackUrl: string | undefined): IStringDictionary<unknown> {
	const { id } = model;
	const name = model.name ?? id;
	let sibling: IStringDictionary<unknown> | undefined;
	let siblingPrefix = 0;
	for (const candidate of existing) {
		if (!isString(candidate['id'])) {
			continue;
		}
		const prefix = commonPrefixLength(id, candidate['id']);
		if (prefix > siblingPrefix) {
			siblingPrefix = prefix;
			sibling = candidate;
		}
	}
	if (sibling && siblingPrefix >= MIN_SIBLING_PREFIX) {
		return { ...sibling, id, name };
	}
	return {
		id,
		name,
		...(fallbackUrl ? { url: fallbackUrl } : {}),
		toolCalling: true,
		vision: false,
		maxInputTokens: 128000,
		maxOutputTokens: 16384,
	};
}

/**
 * Merges the provider's live listing into the configured list. Entries still
 * served upstream are kept verbatim so per-model metadata survives; entries the
 * provider no longer serves are dropped; new ids are appended. The one field a
 * kept entry may lose is a `name` still equal to its `id` — that is the
 * placeholder a previous refresh wrote, not a hand-picked label, so a real
 * upstream name replaces it.
 */
export function mergeProviderModelList(existing: readonly IStringDictionary<unknown>[], upstreamModels: readonly IUpstreamModel[], fallbackUrl: string | undefined): IProviderModelListMerge {
	const upstream = new Map<string, IUpstreamModel>();
	for (const model of upstreamModels) {
		if (!upstream.has(model.id)) {
			upstream.set(model.id, model);
		}
	}
	const existingIds = new Set(existing.map(entry => entry['id']).filter(isString));
	const models: IStringDictionary<unknown>[] = [];
	const renamed: string[] = [];
	for (const entry of existing) {
		const id = entry['id'];
		if (!isString(id) || !upstream.has(id)) {
			continue;
		}
		const name = upstream.get(id)!.name;
		if (name !== undefined && name !== id && entry['name'] === id) {
			renamed.push(id);
			models.push({ ...entry, name });
		} else {
			models.push(entry);
		}
	}
	const added: string[] = [];
	for (const id of [...upstream.keys()].sort()) {
		if (existingIds.has(id)) {
			continue;
		}
		added.push(id);
		models.push(newModelEntry(upstream.get(id)!, existing, fallbackUrl));
	}
	const removed = [...existingIds].filter(id => !upstream.has(id)).sort();
	return { models, added, removed, renamed };
}

/**
 * Refreshes the static `models` arrays of Custom Endpoint provider groups from
 * the provider's OpenAI-compatible `/v1/models` listing. The configuration file
 * stays the authoritative source: a refresh is a user-triggered edit of that
 * file through the Models surface, equivalent to editing the JSON by hand.
 */
export class ProviderModelListRefresher {

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService private readonly _languageModelsConfigurationService: ILanguageModelsConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
	) { }

	getRefreshableGroups(): readonly ILanguageModelsProviderGroup[] {
		return this._languageModelsConfigurationService.getLanguageModelsProviderGroups()
			.filter(group => group.vendor === CUSTOM_ENDPOINT_VENDOR && this._baseUrl(group) !== undefined);
	}

	async refreshAll(token: CancellationToken): Promise<IProviderGroupRefreshOutcome[]> {
		await this._languageModelsConfigurationService.whenReady;
		const outcomes: IProviderGroupRefreshOutcome[] = [];
		for (const group of this.getRefreshableGroups()) {
			outcomes.push(await this._refreshGroup(group, token));
		}
		return outcomes;
	}

	private async _refreshGroup(group: ILanguageModelsProviderGroup, token: CancellationToken): Promise<IProviderGroupRefreshOutcome> {
		try {
			const baseUrl = this._baseUrl(group)!;
			const apiKey = await this._resolveApiKey(group);
			const upstreamModels = await this._fetchUpstreamModels(baseUrl, apiKey, token);
			if (!upstreamModels.length) {
				// An empty listing is indistinguishable from a broken endpoint;
				// never wipe the configured list over it.
				return { groupName: group.name, added: [], removed: [], renamed: [], error: localize('modelListRefresh.emptyListing', "The endpoint returned no models; the configured list was left unchanged.") };
			}
			// One line per group, not per model: whether this endpoint labels its
			// models at all is the only thing worth knowing after the fact.
			const named = upstreamModels.filter(model => model.name !== undefined).length;
			this._logService.info(named
				? `[ProviderModelListRefresher] group '${group.name}': ${named}/${upstreamModels.length} upstream models carry a name field`
				: `[ProviderModelListRefresher] group '${group.name}': upstream provided no name field for any of its ${upstreamModels.length} models; falling back to ids`);
			const existing = Array.isArray(group['models'])
				? (group['models'] as unknown[]).filter((entry): entry is IStringDictionary<unknown> => !!entry && typeof entry === 'object')
				: [];
			const merge = mergeProviderModelList(existing, upstreamModels, baseUrl);
			if (merge.added.length || merge.removed.length || merge.renamed.length) {
				const { range, modelsRange, ...persistable } = group;
				const updated: ILanguageModelsProviderGroup = { ...persistable, name: group.name, vendor: group.vendor, models: merge.models };
				await this._languageModelsConfigurationService.updateLanguageModelsProviderGroup(group, updated);
			}
			return { groupName: group.name, added: merge.added, removed: merge.removed, renamed: merge.renamed };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._logService.warn(`[ProviderModelListRefresher] refresh failed for group '${group.name}': ${message}`);
			return { groupName: group.name, added: [], removed: [], renamed: [], error: message };
		}
	}

	private _baseUrl(group: ILanguageModelsProviderGroup): string | undefined {
		const candidates: unknown[] = [group['url']];
		if (Array.isArray(group['models'])) {
			for (const entry of group['models'] as unknown[]) {
				if (entry && typeof entry === 'object') {
					candidates.push((entry as IStringDictionary<unknown>)['url']);
				}
			}
		}
		for (const candidate of candidates) {
			if (isString(candidate) && candidate.trim()) {
				return candidate.trim().replace(/\/+$/, '');
			}
		}
		return undefined;
	}

	private async _resolveApiKey(group: ILanguageModelsProviderGroup): Promise<string | undefined> {
		// The persisted group holds `${input:...}` secret placeholders; the
		// resolved view of any model in the group carries the real key.
		const modelIdentifier = this._languageModelsService.getLanguageModelGroups(CUSTOM_ENDPOINT_VENDOR)
			.find(candidate => candidate.group?.name === group.name)?.modelIdentifiers[0];
		if (!modelIdentifier) {
			return undefined;
		}
		const resolved = await this._languageModelsService.resolveLanguageModelProviderGroup(modelIdentifier);
		const apiKey = resolved?.configuration['apiKey'];
		return isString(apiKey) && apiKey.trim() ? apiKey.trim() : undefined;
	}

	private async _fetchUpstreamModels(baseUrl: string, apiKey: string | undefined, token: CancellationToken): Promise<IUpstreamModel[]> {
		const url = /\/v\d+$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
		const context = await this._requestService.request({
			type: 'GET',
			url,
			callSite: 'sessions.providerModelListRefresh',
			...(apiKey ? { headers: { 'Authorization': `Bearer ${apiKey}` } } : {}),
		}, token);
		if (context.res.statusCode !== 200) {
			throw new Error(localize('modelListRefresh.httpError', "GET {0} failed with status {1}", url, String(context.res.statusCode)));
		}
		const body = await asJson<{ data?: readonly { id?: unknown; display_name?: unknown; name?: unknown }[] }>(context);
		const models: IUpstreamModel[] = [];
		for (const entry of body?.data ?? []) {
			if (!entry || typeof entry !== 'object' || !isString(entry.id)) {
				continue;
			}
			// Anthropic-compatible listings label the model with `display_name`;
			// some OpenAI-compatible ones use `name`. Anything else — missing,
			// blank, or not a string — counts as unlabelled.
			const name = [entry.display_name, entry.name].find(candidate => isString(candidate) && !!candidate.trim());
			models.push({ id: entry.id, ...(isString(name) ? { name: name.trim() } : {}) });
		}
		return models;
	}
}
