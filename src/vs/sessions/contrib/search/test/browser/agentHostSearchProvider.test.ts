/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { timeout } from '../../../../../base/common/async.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HOST_SCHEME } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { ISearchComplete, ITextQuery, QueryType, TextSearchCompleteMessageType } from '../../../../../workbench/services/search/common/search.js';
import { SearchService } from '../../../../../workbench/services/search/common/searchService.js';
import { AgentHostSearchProviderContribution } from '../../browser/agentHostSearchProvider.js';

/**
 * ⌘⇧F, the Files view search icon and the explorer's "Find in Folder..."
 * all open the Search Editor, so they all end up in
 * `ISearchService.textSearch`. Without a provider for the agent-host
 * scheme that call never settles — `SearchService` awaits a
 * `DeferredPromise` only `registerSearchResultProvider` can complete — so
 * these tests assert on the search *completing*, and on it saying why.
 */
suite('Sessions - agent host search provider', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createSearchService(): SearchService {
		return disposables.add(new SearchService(
			{ getModels: () => [] } as never, // IModelService
			{ editors: [] } as never, // IEditorService
			{ publicLog2: () => { } } as never, // ITelemetryService
			{ trace: () => { }, debug: () => { }, warn: () => { } } as never, // ILogService
			{ activateByEvent: async () => { }, whenInstalledExtensionsRegistered: async () => true } as never, // IExtensionService
			{ exists: async () => true, hasProvider: () => true } as never, // IFileService
			{ extUri } as never, // IUriIdentityService
		));
	}

	function agentHostQuery(): ITextQuery {
		return {
			type: QueryType.Text,
			contentPattern: { pattern: 'needle' },
			folderQueries: [{ folder: URI.from({ scheme: AGENT_HOST_SCHEME, authority: 'my-server', path: '/home/user/repo' }) }],
		};
	}

	/** Resolves to `undefined` when the search is still pending. */
	async function raceTimeout(search: Promise<ISearchComplete>): Promise<ISearchComplete | undefined> {
		return Promise.race([search, timeout(200, CancellationToken.None).then(() => undefined)]);
	}

	test('without the contribution an agent-host text search never settles', async () => {
		const searchService = createSearchService();

		const complete = await raceTimeout(searchService.textSearch(agentHostQuery()));

		assert.strictEqual(complete, undefined, 'this is the hang the contribution exists to remove');
	});

	test('a text search over an agent-host folder completes and says search is unavailable', async () => {
		const searchService = createSearchService();
		disposables.add(new AgentHostSearchProviderContribution(searchService));

		const complete = await raceTimeout(searchService.textSearch(agentHostQuery()));

		assert.ok(complete, 'the search settled');
		assert.deepStrictEqual(complete.results, []);
		assert.strictEqual(complete.messages.length, 1, 'an empty result set on its own reads as "no matches"');
		assert.strictEqual(complete.messages[0].type, TextSearchCompleteMessageType.Warning);
		assert.ok(complete.messages[0].text.length > 0);
	});

	test('file search stays unclaimed so callers keep their file-service fallback', () => {
		const searchService = createSearchService();
		disposables.add(new AgentHostSearchProviderContribution(searchService));

		assert.strictEqual(searchService.schemeHasFileSearchProvider(AGENT_HOST_SCHEME), false);
	});
});
