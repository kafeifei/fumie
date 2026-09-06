/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeBackingStore } from '../../node/claude/claudeBackingStore.js';

suite('claudeBackingStore / prepareFumieHome', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let nativeHome: string;
	let store: ClaudeBackingStore;

	setup(async () => {
		root = await fs.promises.mkdtemp(join(os.tmpdir(), 'fumie-claude-home-'));
		nativeHome = join(root, '.claude');
		await fs.promises.mkdir(nativeHome, { recursive: true });
		store = disposables.add(new ClaudeBackingStore({ FUMIE_HOME: join(root, '.fumie') }, root));
	});

	teardown(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	const fumieInstructions = () => join(root, '.fumie', 'providers', 'claude', 'CLAUDE.md');
	const nativeInstructions = () => join(nativeHome, 'CLAUDE.md');

	test('links the global CLAUDE.md so the isolated home reads the same file', async () => {
		// One source of truth: isolating the config dir must not silently drop
		// the user's global instructions, and a copy would drift.
		await fs.promises.writeFile(nativeInstructions(), 'be brief');
		await store.prepareFumieHome();

		assert.strictEqual(await fs.promises.readFile(fumieInstructions(), 'utf8'), 'be brief');
		assert.ok((await fs.promises.lstat(fumieInstructions())).isSymbolicLink(), 'a link, not a copy');

		// Editing through either path is editing the one file.
		await fs.promises.writeFile(nativeInstructions(), 'be briefer');
		assert.strictEqual(await fs.promises.readFile(fumieInstructions(), 'utf8'), 'be briefer');
	});

	test('running twice is a no-op', async () => {
		await fs.promises.writeFile(nativeInstructions(), 'be brief');
		await store.prepareFumieHome();
		await store.prepareFumieHome();
		assert.strictEqual(await fs.promises.readFile(fumieInstructions(), 'utf8'), 'be brief');
	});

	test('never replaces a file the user authored in the isolated home', async () => {
		await fs.promises.writeFile(nativeInstructions(), 'native');
		await fs.promises.mkdir(join(root, '.fumie', 'providers', 'claude'), { recursive: true });
		await fs.promises.writeFile(fumieInstructions(), 'fumie-only');

		await store.prepareFumieHome();

		assert.strictEqual(await fs.promises.readFile(fumieInstructions(), 'utf8'), 'fumie-only');
		assert.ok(!(await fs.promises.lstat(fumieInstructions())).isSymbolicLink());
	});

	test('drops its own link once the native file is gone', async () => {
		// A dangling link reads as an empty instruction file to the CLI, which
		// is worse than having none at all.
		await fs.promises.writeFile(nativeInstructions(), 'be brief');
		await store.prepareFumieHome();
		await fs.promises.rm(nativeInstructions());

		await store.prepareFumieHome();

		assert.strictEqual(fs.existsSync(fumieInstructions()), false);
	});

	test('no global CLAUDE.md is not an error', async () => {
		await store.prepareFumieHome();
		assert.strictEqual(fs.existsSync(fumieInstructions()), false);
	});
});
