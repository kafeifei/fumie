/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { migrateLegacyFumieData } from '../../../node/fumie/fumieDataMigration.js';

suite('FumieDataMigration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let legacy: string;
	let fumieHome: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'fumie-data-migration-'));
		legacy = join(root, 'legacy');
		fumieHome = join(root, '.fumie');
		await mkdir(join(legacy, 'User', 'globalStorage'), { recursive: true });
		await mkdir(join(legacy, 'agentSessionData', 'session-1'), { recursive: true });
		await mkdir(join(legacy, 'agentHost', 'kimi'), { recursive: true });
		await writeFile(join(legacy, 'User', 'globalStorage', 'agent-host.db'), 'catalog');
		await writeFile(join(legacy, 'User', 'globalStorage', 'agent-host.db-shm'), 'catalog-shm');
		await writeFile(join(legacy, 'User', 'globalStorage', 'agent-host.db-wal'), 'catalog-wal');
		await writeFile(join(legacy, 'agentSessionData', 'session-1', 'session.db'), 'session');
		await writeFile(join(legacy, 'agentHost', 'kimi', 'state.json'), 'kimi');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('moves legacy catalog, sessions, and provider state without replacing new data', async () => {
		await mkdir(join(fumieHome, 'sessions', 'session-1'), { recursive: true });
		await writeFile(join(fumieHome, 'sessions', 'session-1', 'session.db'), 'new-session');
		await migrateLegacyFumieData(legacy, fumieHome, new NullLogService());
		await migrateLegacyFumieData(legacy, fumieHome, new NullLogService());

		assert.deepStrictEqual({
			catalog: await readFile(join(fumieHome, 'sessions', 'catalog.db'), 'utf8'),
			catalogShm: await readFile(join(fumieHome, 'sessions', 'catalog.db-shm'), 'utf8'),
			catalogWal: await readFile(join(fumieHome, 'sessions', 'catalog.db-wal'), 'utf8'),
			session: await readFile(join(fumieHome, 'sessions', 'session-1', 'session.db'), 'utf8'),
			kimi: await readFile(join(fumieHome, 'providers', 'kimi', 'state.json'), 'utf8'),
		}, {
			catalog: 'catalog',
			catalogShm: 'catalog-shm',
			catalogWal: 'catalog-wal',
			session: 'new-session',
			kimi: 'kimi',
		});
		await assert.rejects(access(join(legacy, 'agentSessionData')), { code: 'ENOENT' });
		await assert.rejects(access(join(legacy, 'agentHost', 'kimi')), { code: 'ENOENT' });
		await assert.rejects(access(join(legacy, 'User', 'globalStorage', 'agent-host.db')), { code: 'ENOENT' });
	});

	test('never combines legacy sidecars with an existing Fumie catalog', async () => {
		const sessionsHome = join(fumieHome, 'sessions');
		const legacyGlobalStorage = join(legacy, 'User', 'globalStorage');
		await mkdir(sessionsHome, { recursive: true });
		await writeFile(join(sessionsHome, 'catalog.db'), 'new-catalog');
		await writeFile(join(sessionsHome, 'catalog.db-shm'), 'new-catalog-shm');

		await migrateLegacyFumieData(legacy, fumieHome, new NullLogService());
		await migrateLegacyFumieData(legacy, fumieHome, new NullLogService());

		assert.deepStrictEqual({
			catalog: await readFile(join(sessionsHome, 'catalog.db'), 'utf8'),
			catalogShm: await readFile(join(sessionsHome, 'catalog.db-shm'), 'utf8'),
		}, {
			catalog: 'new-catalog',
			catalogShm: 'new-catalog-shm',
		});
		await assert.rejects(access(join(sessionsHome, 'catalog.db-wal')), { code: 'ENOENT' });
		for (const file of ['agent-host.db', 'agent-host.db-shm', 'agent-host.db-wal']) {
			await assert.rejects(access(join(legacyGlobalStorage, file)), { code: 'ENOENT' });
		}
	});
});
