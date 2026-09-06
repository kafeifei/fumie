/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, type IReference } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { ISessionDatabase, ISessionDataService } from '../../../common/sessionDataService.js';
import { AH_META_PROVISIONAL_DB_KEY, AH_META_WORKSPACELESS_DB_KEY } from '../../../common/state/sessionState.js';
import { AgentHostDatabase } from '../../../node/agentHostDatabase.js';
import { AgentSessionRegistry } from '../../../node/agentSessionRegistry.js';
import { AgentSessionCatalog } from '../../../node/fumie/agentSessionCatalog.js';
import { SessionRecordStore } from '../../../node/fumie/sessionRecordStore.js';
import { SESSION_CUSTOM_TITLE_KEY } from '../../../node/shared/persistSessionMetadata.js';
import { createSessionDataService, TestSessionDatabase } from '../../common/sessionTestHelpers.js';

suite('AgentSessionCatalog', () => {
	const disposables = new DisposableStore();
	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists only registry rows and classifies missing provider backings from durable facts', async () => {
		const database = disposables.add(new AgentHostDatabase(':memory:'));
		const registry = disposables.add(new AgentSessionRegistry(database));
		const described = URI.parse('copilot:/described');
		const unavailable = URI.parse('copilot:/provider-unavailable');
		const cold = URI.parse('copilot:/materialized-cold');
		const orphan = URI.parse('copilot:/untouched-orphan');
		const touched = URI.parse('copilot:/touched-draft');
		for (const [index, session] of [described, unavailable, cold, orphan, touched].entries()) {
			await registry.register(
				session,
				{ provider: 'copilot', startTime: index + 1, source: 'explicit' },
				{ checkTombstone: false },
			);
		}

		const databases = new Map<string, TestSessionDatabase>();
		const databaseFor = (session: URI) => {
			let value = databases.get(session.toString());
			if (!value) {
				value = disposables.add(new TestSessionDatabase());
				databases.set(session.toString(), value);
			}
			return value;
		};
		await databaseFor(cold).setMetadata(AH_META_WORKSPACELESS_DB_KEY, 'false');
		await databaseFor(orphan).setMetadata(AH_META_PROVISIONAL_DB_KEY, '{}');
		await databaseFor(touched).setMetadata(AH_META_PROVISIONAL_DB_KEY, '{}');
		await databaseFor(touched).setMetadata(SESSION_CUSTOM_TITLE_KEY, 'Named draft');

		const baseDataService = createSessionDataService();
		const sessionDataService: ISessionDataService = {
			...baseDataService,
			openDatabase: session => {
				const object = databaseFor(session);
				return { object, dispose: () => { } } satisfies IReference<ISessionDatabase>;
			},
			tryOpenDatabase: async session => {
				const object = databases.get(session.toString());
				return object ? { object, dispose: () => { } } : undefined;
			},
		};
		const logService = new NullLogService();
		const readSessions: string[] = [];
		const swept: string[] = [];
		const catalog = new AgentSessionCatalog(
			registry,
			sessionDataService,
			new SessionRecordStore(sessionDataService, logService),
			{
				isCreationReserved: () => false,
				hasLiveState: () => false,
				readProviderMetadata: async entry => {
					readSessions.push(entry.session.toString());
					if (entry.session.toString() === unavailable.toString()) {
						return { providerAvailable: false };
					}
					return entry.session.toString() === described.toString()
						? { providerAvailable: true, metadata: { session: described, startTime: 10, modifiedTime: 20, summary: 'Provider row' } }
						: { providerAvailable: true };
				},
				sweepOrphanedDraft: session => swept.push(session.toString()),
			},
			logService,
		);

		const rows = await catalog.listBaseSessions();
		const touchedDraft = await catalog.classifyColdProvisionalDraft(touched);

		assert.deepStrictEqual(rows.map(row => [row.session.toString(), row.summary]).sort(), [
			[cold.toString(), 'New Session'],
			[described.toString(), 'Provider row'],
			[touched.toString(), 'New Session'],
			[unavailable.toString(), 'New Session'],
		].sort());
		assert.deepStrictEqual(readSessions.sort(), [described, unavailable, cold, orphan, touched].map(session => session.toString()).sort());
		assert.deepStrictEqual(swept, [orphan.toString()]);
		assert.deepStrictEqual(touchedDraft, {
			untouched: false,
			facts: { marker: {}, customTitle: 'Named draft', isArchived: false, isRead: false },
		});
	});
});
