/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import { join, resolve } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodexBackingStore, decodeCodexChat, encodeCodexChat, prepareFumieCodexHome, resolveCodexBackingHomes } from '../../../node/codex/codexBackingStore.js';

suite('Codex backing store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes versioned Fumie and unversioned native receipts', () => {
		const fumie = encodeCodexChat({
			storage: CodexBackingStore.Fumie,
			sessionId: 'fumie-session',
			threadId: 'fumie-thread',
			model: { id: 'openai/gpt-5' },
		});
		assert.deepStrictEqual(JSON.parse(fumie), {
			version: 1,
			storage: 'fumie',
			sessionId: 'fumie-session',
			threadId: 'fumie-thread',
			model: { id: 'openai/gpt-5' },
		});
		assert.deepStrictEqual(decodeCodexChat(fumie), {
			storage: CodexBackingStore.Fumie,
			sessionId: 'fumie-session',
			threadId: 'fumie-thread',
			model: { id: 'openai/gpt-5' },
		});
		assert.deepStrictEqual(decodeCodexChat(JSON.stringify({ sessionId: 'legacy', threadId: 'native-thread' })), {
			sessionId: 'legacy',
			threadId: 'native-thread',
			storage: CodexBackingStore.Native,
		});
	});

	test('fails closed for unknown or ambiguous receipt versions', () => {
		assert.strictEqual(decodeCodexChat(JSON.stringify({ version: 2, storage: 'fumie', sessionId: 'future' })), undefined);
		assert.strictEqual(decodeCodexChat(JSON.stringify({ storage: 'fumie', sessionId: 'ambiguous' })), undefined);
		assert.strictEqual(decodeCodexChat(JSON.stringify({ version: 1, storage: 'native', sessionId: 'invalid' })), undefined);
		assert.strictEqual(decodeCodexChat('{'), undefined);
	});

	test('resolves the Fumie store independently from configured native homes', () => {
		assert.deepStrictEqual(resolveCodexBackingHomes({
			FUMIE_HOME: '/data/fumie',
			CODEX_HOME: '/data/native-codex',
			CODEX_SQLITE_HOME: '/data/native-index',
		}, '/users/test'), {
			fumie: '/data/fumie/providers/codex',
			native: '/data/native-codex',
			nativeSqlite: '/data/native-index',
		});
	});

	test('links only the effective global AGENTS file', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-codex-backing-'));
		const native = join(root, 'native');
		const fumie = join(root, 'fumie');
		try {
			await fs.mkdir(native, { recursive: true });
			await fs.writeFile(join(native, 'auth.json'), '{"tokens":{}}');
			await fs.writeFile(join(native, 'AGENTS.md'), 'global guidance');
			await fs.writeFile(join(native, 'config.toml'), 'plugins = []');
			await fs.mkdir(join(native, 'sessions'));

			const prepared = await prepareFumieCodexHome({ fumie, native, nativeSqlite: native });
			assert.deepStrictEqual(prepared, { linked: ['AGENTS.md'], preserved: [] });
			assert.strictEqual(resolve(fumie, await fs.readlink(join(fumie, 'AGENTS.md'))), join(native, 'AGENTS.md'));
			await assert.rejects(fs.lstat(join(fumie, 'auth.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
			await assert.rejects(fs.lstat(join(fumie, 'config.toml')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
			await assert.rejects(fs.lstat(join(fumie, 'sessions')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('refreshes its own AGENTS link but preserves a non-owned target', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = await fs.mkdtemp(join(os.tmpdir(), 'fumie-codex-backing-refresh-'));
		const native = join(root, 'native');
		const fumie = join(root, 'fumie');
		try {
			await fs.mkdir(native, { recursive: true });
			await fs.writeFile(join(native, 'AGENTS.md'), 'base');
			await prepareFumieCodexHome({ fumie, native, nativeSqlite: native });
			await fs.writeFile(join(native, 'AGENTS.override.md'), 'override');
			await prepareFumieCodexHome({ fumie, native, nativeSqlite: native });
			await assert.rejects(fs.lstat(join(fumie, 'AGENTS.md')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
			assert.strictEqual(resolve(fumie, await fs.readlink(join(fumie, 'AGENTS.override.md'))), join(native, 'AGENTS.override.md'));

			await fs.unlink(join(fumie, 'AGENTS.override.md'));
			await fs.writeFile(join(fumie, 'AGENTS.override.md'), 'Fumie-owned local override');
			const preserved = await prepareFumieCodexHome({ fumie, native, nativeSqlite: native });
			assert.deepStrictEqual(preserved.preserved, ['AGENTS.override.md']);
			assert.strictEqual(await fs.readFile(join(fumie, 'AGENTS.override.md'), 'utf8'), 'Fumie-owned local override');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
