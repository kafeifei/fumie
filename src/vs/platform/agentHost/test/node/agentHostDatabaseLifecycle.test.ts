/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import type { Database } from '@vscode/sqlite3';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostDatabase, IAgentHostDatabaseSessionDeleteIntent, IAgentHostDatabaseSessionLifecycle } from '../../node/agentHostDatabase.js';

suite('AgentHostDatabase session lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let database: AgentHostDatabase;
	let lifecycle: IAgentHostDatabaseSessionLifecycle;
	let testDirectory: string | undefined;

	setup(() => {
		database = new AgentHostDatabase(':memory:');
		lifecycle = database.sessionLifecycle;
	});

	teardown(async () => {
		await database.close();
		if (testDirectory) {
			await rm(testDirectory, { recursive: true, force: true });
			testDirectory = undefined;
		}
	});

	async function seedDatabase(path: string, sql: string): Promise<void> {
		const sqlite3 = await import('@vscode/sqlite3');
		let seeded!: Database;
		await new Promise<void>((resolve, reject) => {
			seeded = new sqlite3.default.Database(path, error => error ? reject(error) : resolve());
		});
		try {
			await new Promise<void>((resolve, reject) => seeded.exec(sql, error => error ? reject(error) : resolve()));
		} finally {
			await new Promise<void>((resolve, reject) => seeded.close(error => error ? reject(error) : resolve()));
		}
	}

	async function useSeededDatabase(sql: string): Promise<string> {
		await database.close();
		testDirectory = await mkdtemp(join(tmpdir(), 'agent-host-database-lifecycle-'));
		const path = join(testDirectory, 'agent-host.sqlite');
		await seedDatabase(path, sql);
		database = new AgentHostDatabase(path);
		lifecycle = database.sessionLifecycle;
		return path;
	}

	async function readUserVersion(path: string): Promise<number> {
		const sqlite3 = await import('@vscode/sqlite3');
		let opened!: Database;
		await new Promise<void>((resolve, reject) => {
			opened = new sqlite3.default.Database(path, error => error ? reject(error) : resolve());
		});
		try {
			return await new Promise<number>((resolve, reject) => {
				opened.get('PRAGMA user_version', (error: Error | null, row: { user_version: number }) => error ? reject(error) : resolve(row.user_version));
			});
		} finally {
			await new Promise<void>((resolve, reject) => opened.close(error => error ? reject(error) : resolve()));
		}
	}

	function intent(session: string, operationId: string, createdAt = 100): IAgentHostDatabaseSessionDeleteIntent {
		return {
			session,
			operationId,
			provider: 'codex',
			phase: 'prepared',
			targetsJson: '[{"chat":"ahp-chat://default","status":"pending"}]',
			attempt: 0,
			createdAt,
			updatedAt: createdAt,
			lastError: undefined,
		};
	}

	test('current schema supports prepare, get, list, and conditional update', async () => {
		const first = intent('ahp-codex://one', 'operation-one', 100);
		const second = intent('ahp-codex://two', 'operation-two', 200);

		assert.deepStrictEqual(await lifecycle.prepareDeleteIntent(first), first);
		await lifecycle.prepareDeleteIntent(second);
		const updated = await lifecycle.updateDeleteIntent(first.session, first.operationId, {
			phase: 'deletingBackings',
			targetsJson: '[{"chat":"ahp-chat://default","status":"deleted"}]',
			attempt: 1,
			updatedAt: 300,
			lastError: 'retrying',
		});
		const staleUpdate = await lifecycle.updateDeleteIntent(first.session, 'stale-operation', {
			phase: 'cleaningFumie',
			targetsJson: '[]',
			attempt: 2,
			updatedAt: 400,
			lastError: undefined,
		});

		assert.deepStrictEqual({
			updated,
			staleUpdate,
			first: await lifecycle.getDeleteIntent(first.session),
			listed: await lifecycle.listDeleteIntents(),
		}, {
			updated: true,
			staleUpdate: false,
			first: {
				...first,
				phase: 'deletingBackings',
				targetsJson: '[{"chat":"ahp-chat://default","status":"deleted"}]',
				attempt: 1,
				updatedAt: 300,
				lastError: 'retrying',
			},
			listed: [
				{
					...first,
					phase: 'deletingBackings',
					targetsJson: '[{"chat":"ahp-chat://default","status":"deleted"}]',
					attempt: 1,
					updatedAt: 300,
					lastError: 'retrying',
				},
				second,
			],
		});
	});

	test('migrates the historical Fumie version-2 schema without losing deletion state', async () => {
		const path = await useSeededDatabase(`
			CREATE TABLE sessions (
				session_uri TEXT PRIMARY KEY NOT NULL,
				provider TEXT NOT NULL,
				start_time INTEGER NOT NULL
			);
			CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
			CREATE TABLE session_delete_intents (
				session_uri TEXT PRIMARY KEY NOT NULL,
				operation_id TEXT UNIQUE NOT NULL,
				provider TEXT NOT NULL,
				phase TEXT NOT NULL,
				targets_json TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE INDEX session_delete_intents_provider ON session_delete_intents (provider);
			INSERT INTO sessions VALUES ('ahp-codex://legacy-fumie', 'codex', 41);
			INSERT INTO session_delete_intents VALUES (
				'ahp-codex://deleting', 'operation-fumie-v2', 'codex', 'prepared', '[]', 1, 42, 43, 'retry'
			);
			PRAGMA user_version = 2;
		`);

		assert.deepStrictEqual(await database.listSessions(), [{
			session: 'ahp-codex://legacy-fumie',
			provider: 'codex',
			startTime: 41,
			external: undefined,
			source: 'explicit',
		}]);
		assert.deepStrictEqual(await lifecycle.listDeleteIntents(), [{
			session: 'ahp-codex://deleting',
			operationId: 'operation-fumie-v2',
			provider: 'codex',
			phase: 'prepared',
			targetsJson: '[]',
			attempt: 1,
			createdAt: 42,
			updatedAt: 43,
			lastError: 'retry',
		}]);
		await database.close();
		assert.strictEqual(await readUserVersion(path), 4);
	});

	test('migrates the upstream version-3 schema by adding Fumie deletion state', async () => {
		const path = await useSeededDatabase(`
			CREATE TABLE sessions (
				session_uri TEXT PRIMARY KEY NOT NULL,
				provider TEXT NOT NULL,
				start_time INTEGER NOT NULL,
				external INTEGER,
				registration_source TEXT NOT NULL DEFAULT 'explicit'
			);
			CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
			INSERT INTO sessions VALUES ('ahp-claude://legacy-upstream', 'claude', 51, 1, 'discovery');
			PRAGMA user_version = 3;
		`);

		assert.deepStrictEqual(await database.listSessions(), [{
			session: 'ahp-claude://legacy-upstream',
			provider: 'claude',
			startTime: 51,
			external: true,
			source: 'discovery',
		}]);
		assert.deepStrictEqual(await lifecycle.prepareDeleteIntent(intent('ahp-claude://deleting', 'operation-upstream-v3')), intent('ahp-claude://deleting', 'operation-upstream-v3'));
		await database.close();
		assert.strictEqual(await readUserVersion(path), 4);
	});

	test('prepare preserves the first operation and target snapshot for a session', async () => {
		const original = intent('ahp-codex://one', 'operation-one');
		const competing = {
			...intent(original.session, 'operation-two'),
			targetsJson: '[{"chat":"ahp-chat://other","status":"pending"}]',
		};

		await lifecycle.prepareDeleteIntent(original);

		assert.deepStrictEqual(await lifecycle.prepareDeleteIntent(competing), original);
	});

	test('finalize atomically tombstones, unregisters, and clears only the matching intent', async () => {
		const session = 'ahp-codex://one';
		const prepared = intent(session, 'operation-one');
		await database.registerSession(session, { provider: 'codex', startTime: 50, source: 'explicit' }, { checkTombstone: false });
		await lifecycle.prepareDeleteIntent(prepared);

		const staleFinalize = await lifecycle.finalizeDeleteIntent(session, 'stale-operation');
		const beforeMatchingFinalize = {
			registered: await database.listSessions(),
			tombstoned: await database.isSessionTombstoned(session),
			intent: await lifecycle.getDeleteIntent(session),
		};
		const finalized = await lifecycle.finalizeDeleteIntent(session, prepared.operationId);

		assert.deepStrictEqual({
			staleFinalize,
			beforeMatchingFinalize,
			finalized,
			registered: await database.listSessions(),
			tombstoned: await database.isSessionTombstoned(session),
			intent: await lifecycle.getDeleteIntent(session),
			restored: await database.registerSession(session, { provider: 'codex', startTime: 60, source: 'restore' }, { checkTombstone: true }),
		}, {
			staleFinalize: false,
			beforeMatchingFinalize: {
				registered: [{ session, provider: 'codex', startTime: 50, external: false, source: 'explicit' }],
				tombstoned: false,
				intent: prepared,
			},
			finalized: true,
			registered: [],
			tombstoned: true,
			intent: undefined,
			restored: false,
		});
	});
});
