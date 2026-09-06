/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isLinux } from '../../../../../base/common/platform.js';
import { basename, dirname, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getManagedWorktreePath, getManagedWorktreeRepositoryRoot, getManagedWorktreesRoot, sanitizeWorktreeSessionId } from '../../../node/worktree/worktreePaths.js';

suite('WorktreePaths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fumieHome = URI.file('/tmp/.fumie');

	test('builds the managed root without an internal version directory', () => {
		assert.strictEqual(getManagedWorktreesRoot(fumieHome).fsPath, URI.file('/tmp/.fumie/worktrees').fsPath);
	});

	test('keeps same-named repositories in distinct directories', () => {
		const first = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/one/fumie'));
		const second = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/two/fumie'));

		assert.notStrictEqual(first.toString(), second.toString());
		assert.match(basename(first), /^fumie-[0-9a-f]{12}$/);
		assert.match(basename(second), /^fumie-[0-9a-f]{12}$/);
	});

	test('derives a stable repository directory from a canonical root', () => {
		const plain = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/team/fumie'));
		const normalized = getManagedWorktreeRepositoryRoot(fumieHome, URI.parse('FILE:///projects/team/other/../fumie/'));

		assert.strictEqual(normalized.toString(), plain.toString());
		assert.strictEqual(
			getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/team/fumie')).toString(),
			plain.toString(),
		);
	});

	test('uses the local filesystem case rule for repository identity', () => {
		const lower = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/team/fumie'));
		const mixed = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/Projects/Team/Fumie'));

		assert.strictEqual(lower.toString() === mixed.toString(), !isLinux);
	});

	test('preserves an already-safe recognizable session id', () => {
		assert.strictEqual(sanitizeWorktreeSessionId('session-123_abc'), 'session-123_abc');
		assert.strictEqual(
			basename(getManagedWorktreePath(fumieHome, URI.file('/projects/team/fumie'), 'session-123_abc')),
			'session-123_abc',
		);
	});

	test('keeps an unsafe session id inside its repository directory', () => {
		const repositoryDirectory = getManagedWorktreeRepositoryRoot(fumieHome, URI.file('/projects/team/fumie'));
		const worktree = getManagedWorktreePath(fumieHome, URI.file('/projects/team/fumie'), '../../outside\\checkout');
		const sessionSegment = basename(worktree);

		assert.ok(isEqual(dirname(worktree), repositoryDirectory));
		assert.ok(!sessionSegment.includes('/') && !sessionSegment.includes('\\'));
		assert.match(sessionSegment, /^outside-checkout-[0-9a-f]{8}$/);
	});

	test('does not collapse distinct unsafe session ids', () => {
		assert.notStrictEqual(sanitizeWorktreeSessionId('session/a'), sanitizeWorktreeSessionId('session:a'));
	});
});
