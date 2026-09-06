/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostDatabase } from '../../../node/agentHostDatabase.js';
import { ISessionDeleteIntent, SessionLifecycleStore } from '../../../node/fumie/sessionLifecycleStore.js';

suite('SessionLifecycleStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let database: AgentHostDatabase;
	let store: SessionLifecycleStore;

	setup(() => {
		database = new AgentHostDatabase(':memory:');
		store = new SessionLifecycleStore(database);
	});

	teardown(async () => {
		await database.close();
	});

	function intent(overrides: Partial<ISessionDeleteIntent> = {}): ISessionDeleteIntent {
		return {
			operationId: 'operation-one',
			session: 'ahp-codex://one',
			provider: 'codex',
			phase: 'prepared',
			targets: [
				{ chat: 'ahp-chat://peer', providerData: 'opaque-peer', status: 'pending' },
				{ chat: 'ahp-chat://default', providerData: 'opaque-default', status: 'pending' },
			],
			attempt: 0,
			createdAt: 100,
			updatedAt: 100,
			...overrides,
		};
	}

	test('prepare is idempotent and preserves the original target snapshot', async () => {
		const original = intent();
		const competing = intent({
			operationId: 'operation-two',
			targets: [{ chat: 'ahp-chat://different', status: 'pending' }],
			createdAt: 200,
			updatedAt: 200,
		});

		assert.deepStrictEqual({
			prepared: await store.prepare(original),
			competing: await store.prepare(competing),
			readByUri: await store.get(URI.parse(original.session)),
			listed: await store.list(),
		}, {
			prepared: original,
			competing: original,
			readByUri: original,
			listed: [original],
		});
	});

	test('update persists phase, per-target progress, retry count, and errors', async () => {
		const original = await store.prepare(intent());
		const targets = original.targets.map((target, index) => index === 0 ? { ...target, status: 'deleted' as const } : target);

		const failed = await store.update(original.session, original.operationId, {
			phase: 'deletingBackings',
			targets,
			attempt: 1,
			updatedAt: 200,
			lastError: 'native delete failed',
		});
		const retrying = await store.update(original.session, original.operationId, {
			updatedAt: 300,
			lastError: null,
		});

		assert.deepStrictEqual({ failed, retrying, persisted: await store.get(original.session) }, {
			failed: {
				...original,
				phase: 'deletingBackings',
				targets,
				attempt: 1,
				updatedAt: 200,
				lastError: 'native delete failed',
			},
			retrying: {
				...original,
				phase: 'deletingBackings',
				targets,
				attempt: 1,
				updatedAt: 300,
				lastError: undefined,
			},
			persisted: {
				...original,
				phase: 'deletingBackings',
				targets,
				attempt: 1,
				updatedAt: 300,
			},
		});
	});

	test('stale update and finalize cannot take over another operation', async () => {
		const original = await store.prepare(intent());

		await assert.rejects(
			store.update(original.session, 'stale-operation', { phase: 'cleaningFumie', updatedAt: 200 }),
			/not owned by operation stale-operation/,
		);
		await assert.rejects(
			store.finalize(original.session, 'stale-operation'),
			/not owned by operation stale-operation/,
		);

		assert.deepStrictEqual(await store.get(original.session), original);
	});

	test('finalize removes membership and intent while leaving a durable tombstone', async () => {
		const original = intent();
		await database.registerSession(
			original.session,
			{ provider: 'codex', startTime: 50, source: 'explicit' },
			{ checkTombstone: false },
		);
		await store.prepare(original);

		await store.finalize(original.session, original.operationId);

		assert.deepStrictEqual({
			intent: await store.get(original.session),
			registered: await database.listSessions(),
			tombstoned: await database.isSessionTombstoned(original.session),
		}, {
			intent: undefined,
			registered: [],
			tombstoned: true,
		});
	});

	test('rejects malformed or ambiguous target snapshots before writing', async () => {
		await assert.rejects(
			store.prepare(intent({
				targets: [
					{ chat: 'ahp-chat://duplicate', status: 'pending' },
					{ chat: 'ahp-chat://duplicate', status: 'pending' },
				],
			})),
			/Duplicate session delete target/,
		);

		assert.deepStrictEqual(await store.list(), []);
	});
});
