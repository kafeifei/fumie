/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import type { Database } from '@vscode/sqlite3';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { prepareOpencodeBackingStore, resolveOpencodeBackingStorePaths } from '../../../node/opencode/opencodeBackingStore.js';

function openDatabase(path: string): Promise<Database> {
	return new Promise((resolve, reject) => {
		void import('@vscode/sqlite3').then(module => {
			const database = new module.default.Database(path, error => error ? reject(error) : resolve(database));
		}, reject);
	});
}

function exec(database: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
}

function all(database: Database, sql: string): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		database.all(sql, (error: Error | null, rows: Record<string, unknown>[]) => error ? reject(error) : resolve(rows));
	});
}

function closeDatabase(database: Database): Promise<void> {
	return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

async function createNativeDatabase(path: string): Promise<Database> {
	await fs.mkdir(join(path, '..'), { recursive: true });
	const database = await openDatabase(path);
	await exec(database, `
		PRAGMA journal_mode = WAL;
		PRAGMA wal_autocheckpoint = 0;
		CREATE TABLE account (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			url TEXT NOT NULL,
			access_token TEXT NOT NULL,
			refresh_token TEXT NOT NULL,
			token_expiry INTEGER
		);
		CREATE TABLE account_state (
			id INTEGER PRIMARY KEY,
			active_account_id TEXT REFERENCES account(id) ON DELETE SET NULL,
			active_org_id TEXT
		);
		CREATE TABLE credential (
			id TEXT PRIMARY KEY,
			integration_id TEXT,
			label TEXT,
			value TEXT
		);
		CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, body TEXT NOT NULL);
	`);
	await exec(database, 'PRAGMA wal_checkpoint(TRUNCATE)');
	await exec(database, `
		BEGIN;
		INSERT INTO account VALUES ('account-a', 'person@example.invalid', 'https://example.invalid', 'access-placeholder', 'refresh-placeholder', 123);
		INSERT INTO account_state VALUES (1, 'account-a', 'org-a');
		INSERT INTO credential VALUES ('credential-a', 'integration-a', 'default', '{"type":"api","key":"placeholder"}');
		INSERT INTO session VALUES ('session-a', 'kept session');
		INSERT INTO message VALUES ('message-a', 'session-a', 'kept message');
		INSERT INTO part VALUES ('part-a', 'message-a', 'kept part');
		COMMIT;
	`);
	return database;
}

suite('OpenCode backing store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the Fumie provider database independently from the native store', () => {
		assert.deepStrictEqual(resolveOpencodeBackingStorePaths({
			FUMIE_HOME: '/data/fumie',
			XDG_DATA_HOME: '/data/native',
			OPENCODE_DB: 'channel.db',
		}, '/users/test'), {
			nativeDbPath: '/data/native/opencode/channel.db',
			dbPath: '/data/fumie/providers/opencode/opencode.db',
		});
	});

	test('backs up live WAL transcripts while removing only native account state from the copy', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-backing-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			assert.ok((await fs.stat(`${nativeDbPath}-wal`)).size > 0, 'fixture rows remain in the live WAL');
			assert.strictEqual(await prepareOpencodeBackingStore({ nativeDbPath, dbPath }), dbPath);

			const copy = await openDatabase(dbPath);
			try {
				assert.deepStrictEqual(await all(copy, 'SELECT id, title FROM session'), [{ id: 'session-a', title: 'kept session' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id, session_id, body FROM message'), [{ id: 'message-a', session_id: 'session-a', body: 'kept message' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id, message_id, body FROM part'), [{ id: 'part-a', message_id: 'message-a', body: 'kept part' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id, integration_id FROM credential'), [{ id: 'credential-a', integration_id: 'integration-a' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id FROM account'), []);
				assert.deepStrictEqual(await all(copy, 'SELECT id FROM account_state'), []);
			} finally {
				await closeDatabase(copy);
			}
			const copiedBytes = await fs.readFile(dbPath);
			assert.ok(!copiedBytes.includes(Buffer.from('access-placeholder')), 'deleted access token is removed from database pages');
			assert.ok(!copiedBytes.includes(Buffer.from('refresh-placeholder')), 'deleted refresh token is removed from database pages');

			assert.deepStrictEqual(await all(native, 'SELECT id, access_token, refresh_token FROM account'), [{
				id: 'account-a',
				access_token: 'access-placeholder',
				refresh_token: 'refresh-placeholder',
			}]);
			assert.deepStrictEqual(await all(native, 'SELECT active_account_id, active_org_id FROM account_state'), [{
				active_account_id: 'account-a',
				active_org_id: 'org-a',
			}]);

			if (process.platform !== 'win32') {
				assert.strictEqual((await fs.stat(join(dbPath, '..'))).mode & 0o777, 0o700);
				assert.strictEqual((await fs.stat(dbPath)).mode & 0o777, 0o600);
			}
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('preserves an older transcript database that has no account tables', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-old-schema-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		await fs.mkdir(join(nativeDbPath, '..'), { recursive: true });
		const native = await openDatabase(nativeDbPath);
		try {
			await exec(native, `
				CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL);
				INSERT INTO session VALUES ('old-session', 'older schema');
			`);
			assert.strictEqual(await prepareOpencodeBackingStore({ nativeDbPath, dbPath }), dbPath);
			const copy = await openDatabase(dbPath);
			try {
				assert.deepStrictEqual(await all(copy, 'SELECT id, title FROM session'), [{ id: 'old-session', title: 'older schema' }]);
			} finally {
				await closeDatabase(copy);
			}
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('leaves both endpoints intact when a partial account schema cannot be isolated', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-failed-migration-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		await fs.mkdir(join(nativeDbPath, '..'), { recursive: true });
		const native = await openDatabase(nativeDbPath);
		try {
			await exec(native, `
				CREATE TABLE account (id TEXT PRIMARY KEY, access_token TEXT NOT NULL);
				CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL);
				INSERT INTO account VALUES ('account-a', 'source-token');
				INSERT INTO session VALUES ('session-a', 'source session');
			`);
			await assert.rejects(
				prepareOpencodeBackingStore({ nativeDbPath, dbPath }),
				/does not contain the account tables required for safe isolation/,
			);
			assert.deepStrictEqual(await all(native, 'SELECT id, access_token FROM account'), [{ id: 'account-a', access_token: 'source-token' }]);
			assert.deepStrictEqual(await all(native, 'SELECT id FROM session'), [{ id: 'session-a' }]);
			await assert.rejects(fs.stat(dbPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('does not overwrite an existing isolated store on later starts', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-repeat-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			await prepareOpencodeBackingStore({ nativeDbPath, dbPath });
			const copy = await openDatabase(dbPath);
			try {
				await exec(copy, `INSERT INTO session VALUES ('fumie-session', 'created after migration')`);
			} finally {
				await closeDatabase(copy);
			}
			await exec(native, `INSERT INTO session VALUES ('later-native-session', 'must not be resynced')`);

			await prepareOpencodeBackingStore({ nativeDbPath, dbPath });
			const reopened = await openDatabase(dbPath);
			try {
				assert.deepStrictEqual(await all(reopened, 'SELECT id FROM session ORDER BY id'), [
					{ id: 'fumie-session' },
					{ id: 'session-a' },
				]);
			} finally {
				await closeDatabase(reopened);
			}
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('fails closed without editing an existing isolated store that gained a native account', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-account-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			await prepareOpencodeBackingStore({ nativeDbPath, dbPath });
			const copy = await openDatabase(dbPath);
			try {
				await exec(copy, `
					INSERT INTO account VALUES ('external-account', 'person@example.invalid', 'https://example.invalid', 'external-access', 'external-refresh', 456);
					INSERT INTO account_state VALUES (1, 'external-account', 'external-org');
				`);
			} finally {
				await closeDatabase(copy);
			}

			await assert.rejects(
				prepareOpencodeBackingStore({ nativeDbPath, dbPath }),
				/contains a native account or active organization/,
			);
			const unchanged = await openDatabase(dbPath);
			try {
				assert.deepStrictEqual(await all(unchanged, 'SELECT id FROM account'), [{ id: 'external-account' }]);
				assert.deepStrictEqual(await all(unchanged, 'SELECT active_org_id FROM account_state'), [{ active_org_id: 'external-org' }]);
			} finally {
				await closeDatabase(unchanged);
			}
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('recovers a lock owned by a process that no longer exists', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-stale-lock-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const lockPath = join(dbPath, '..', '.opencode.db.initialize.lock');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(join(lockPath, 'owner.json'), JSON.stringify({ version: 1, pid: 2_147_483_647, token: 'stale-owner' }));
			assert.strictEqual(await prepareOpencodeBackingStore({ nativeDbPath, dbPath }), dbPath);
			await assert.rejects(fs.stat(lockPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('does not remove a live owner lock while waiting', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-live-lock-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const lockPath = join(dbPath, '..', '.opencode.db.initialize.lock');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(join(lockPath, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid, token: 'live-owner' }));
			const preparing = prepareOpencodeBackingStore({ nativeDbPath, dbPath });
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.strictEqual(JSON.parse(await fs.readFile(join(lockPath, 'owner.json'), 'utf8')).token, 'live-owner');
			await fs.rm(lockPath, { recursive: true });
			assert.strictEqual(await preparing, dbPath);
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('serializes concurrent first-time initialization without exposing a partial database', async () => {
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-opencode-concurrent-'));
		const nativeDbPath = join(root, 'native', 'opencode.db');
		const dbPath = join(root, 'fumie', 'providers', 'opencode', 'opencode.db');
		const native = await createNativeDatabase(nativeDbPath);
		try {
			const paths = { nativeDbPath, dbPath };
			assert.deepStrictEqual(await Promise.all([
				prepareOpencodeBackingStore(paths),
				prepareOpencodeBackingStore(paths),
				prepareOpencodeBackingStore(paths),
			]), [dbPath, dbPath, dbPath]);

			const copy = await openDatabase(dbPath);
			try {
				assert.deepStrictEqual(await all(copy, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id FROM session'), [{ id: 'session-a' }]);
				assert.deepStrictEqual(await all(copy, 'SELECT id FROM account'), []);
			} finally {
				await closeDatabase(copy);
			}
			assert.deepStrictEqual((await fs.readdir(join(dbPath, '..'))).sort(), ['opencode.db']);
		} finally {
			await closeDatabase(native);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
