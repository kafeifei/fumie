/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostDatabase } from '../../../node/agentHostDatabase.js';
import { AgentSessionLifecycleService, IAgentSessionLifecycleHost } from '../../../node/fumie/agentSessionLifecycleService.js';
import { ISessionDeleteTarget, SessionLifecycleStore } from '../../../node/fumie/sessionLifecycleStore.js';

suite('AgentSessionLifecycleService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const session = URI.parse('codex:/lifecycle-test');

	async function createContext(targets: readonly Omit<ISessionDeleteTarget, 'status'>[] = [
		{ chat: 'ahp-chat://peer/lifecycle-test', providerData: 'peer-receipt' },
		{ chat: 'ahp-chat://default/lifecycle-test', providerData: 'default-receipt' },
	]) {
		const database = new AgentHostDatabase(':memory:');
		await database.registerSession(
			session.toString(),
			{ provider: 'codex', startTime: 1, source: 'explicit' },
			{ checkTombstone: false },
		);
		const store = new SessionLifecycleStore(database);
		const calls: string[] = [];
		const failures = new Map<string, Error>();
		let cleanupFailure: Error | undefined;
		const host: IAgentSessionLifecycleHost = {
			captureDeleteTargets: async () => {
				calls.push('capture');
				return targets;
			},
			stopSessionForDelete: async () => { calls.push('stop'); },
			deleteBacking: async (_session, target) => {
				const intent = await store.get(session);
				assert.strictEqual(intent?.phase, 'deletingBackings', 'intent must commit before native delete');
				calls.push(`delete:${target.chat}`);
				const failure = failures.get(target.chat);
				if (failure) {
					throw failure;
				}
			},
			cleanupFumieSession: async () => {
				calls.push('cleanup');
				if (cleanupFailure) {
					throw cleanupFailure;
				}
			},
			onSessionDeleteFinalized: () => { calls.push('finalized'); },
		};
		const service = new AgentSessionLifecycleService(store, host, new NullLogService());
		await service.whenReady();
		return {
			database,
			store,
			service,
			calls,
			failures,
			setCleanupFailure: (error: Error | undefined) => { cleanupFailure = error; },
		};
	}

	test('persists intent and per-target completion before final catalog commit', async () => {
		const context = await createContext();
		try {
			await context.service.deleteSession(session, 'codex');

			assert.deepStrictEqual(context.calls, [
				'capture',
				'stop',
				'delete:ahp-chat://peer/lifecycle-test',
				'delete:ahp-chat://default/lifecycle-test',
				'cleanup',
				'finalized',
			]);
			assert.strictEqual(await context.store.get(session), undefined);
			assert.strictEqual((await context.database.listSessions()).length, 0);
			assert.strictEqual(await context.database.isSessionTombstoned(session.toString()), true);
		} finally {
			context.database.dispose();
		}
	});

	test('continues other targets after one failure and retries only the pending target', async () => {
		const context = await createContext();
		try {
			context.failures.set('ahp-chat://peer/lifecycle-test', new Error('peer delete failed'));
			await assert.rejects(context.service.deleteSession(session, 'codex'), /peer delete failed/);
			const failedIntent = await context.store.get(session);
			assert.deepStrictEqual(failedIntent?.targets.map(target => [target.chat, target.status]), [
				['ahp-chat://peer/lifecycle-test', 'pending'],
				['ahp-chat://default/lifecycle-test', 'deleted'],
			]);
			await assert.rejects(context.service.assertMutable(session), /being deleted/);

			context.failures.clear();
			context.calls.length = 0;
			await context.service.deleteSession(session, 'codex');
			assert.deepStrictEqual(context.calls, [
				'stop',
				'delete:ahp-chat://peer/lifecycle-test',
				'cleanup',
				'finalized',
			]);
		} finally {
			context.database.dispose();
		}
	});

	test('a new service resumes cleanup from the durable intent after a crash boundary', async () => {
		const first = await createContext();
		try {
			first.setCleanupFailure(new Error('cleanup interrupted'));
			await assert.rejects(first.service.deleteSession(session, 'codex'), /cleanup interrupted/);
			assert.strictEqual((await first.store.get(session))?.phase, 'cleaningFumie');

			const resumedCalls: string[] = [];
			const resumed = new AgentSessionLifecycleService(first.store, {
				captureDeleteTargets: async () => { throw new Error('must reuse durable target snapshot'); },
				stopSessionForDelete: async () => { resumedCalls.push('stop'); },
				deleteBacking: async () => { throw new Error('completed targets must not be deleted again'); },
				cleanupFumieSession: async () => { resumedCalls.push('cleanup'); },
				onSessionDeleteFinalized: () => { resumedCalls.push('finalized'); },
			}, new NullLogService());
			await resumed.whenReady();
			await resumed.resumePendingDeletes('codex');

			assert.deepStrictEqual(resumedCalls, ['stop', 'cleanup', 'finalized']);
			assert.strictEqual(await first.store.get(session), undefined);
		} finally {
			first.database.dispose();
		}
	});
});
