/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AGENT_HOST_SCHEME } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ISearchComplete, ISearchResultProvider, ISearchService, SearchProviderType, TextSearchCompleteMessageType } from '../../../../workbench/services/search/common/search.js';

/**
 * Message shown in the search editor when the searched workspace lives on
 * a remote agent host. Spelled out rather than left as an empty result set
 * because "0 results" reads as "your code does not contain this".
 */
const searchUnavailableMessage = localize(
	'agentHostSearchUnavailable',
	"This workspace is on a remote agent host, which cannot be searched yet. No files were read, so this is not a \"no matches\" result.",
);

/**
 * Stand-in text search provider for the {@link AGENT_HOST_SCHEME} scheme.
 *
 * Nothing registers a real search provider for agent-host workspaces, and
 * `SearchService` waits forever on a `DeferredPromise` for a scheme that
 * has none (`workbench/services/search/common/searchService.ts`), so
 * ⌘⇧F on a remote or tunnel host spins with no way to tell the user why.
 * This completes the query immediately with a provider message instead.
 *
 * Delete this together with its contribution once the host can actually
 * search — see `docs/architecture.md`.
 */
export class AgentHostSearchResultProvider implements ISearchResultProvider {

	async getAIName(): Promise<string | undefined> {
		return undefined;
	}

	async textSearch(): Promise<ISearchComplete> {
		return this.unavailable();
	}

	async fileSearch(): Promise<ISearchComplete> {
		return this.unavailable();
	}

	async clearCache(): Promise<void> {
		// No cache to clear.
	}

	private unavailable(): ISearchComplete {
		return {
			results: [],
			limitHit: false,
			messages: [{ type: TextSearchCompleteMessageType.Warning, text: searchUnavailableMessage }],
		};
	}
}

/**
 * Registers {@link AgentHostSearchResultProvider} for text queries.
 *
 * Text queries only: `ISearchService.schemeHasFileSearchProvider` is a
 * capability probe, and registering a file provider would make callers
 * such as `promptFilesLocator.ts` swap their working file-service walk for
 * a search that returns nothing.
 */
export class AgentHostSearchProviderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.agentHostSearchProvider';

	constructor(
		@ISearchService searchService: ISearchService,
	) {
		super();

		this._register(searchService.registerSearchResultProvider(
			AGENT_HOST_SCHEME,
			SearchProviderType.text,
			new AgentHostSearchResultProvider(),
		));
	}
}
