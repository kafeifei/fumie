/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorktreeDiskBudgetCandidate, measureWorktreeDiskUsage, parseWorktreeDiskBudgetBytes, FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR, WorktreeDiskBudget, WorktreeDiskBudgetExceededError } from '../../../node/worktree/worktreeDiskBudget.js';

suite('WorktreeDiskBudget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let temporaryRoot: string;

	setup(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), 'fumie-worktree-budget-'));
	});

	teardown(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	test('defaults to disabled disk-budget enforcement', async () => {
		const budget = new WorktreeDiskBudget();
		let removerCalled = false;
		const result = await budget.reclaim([{
			sessionId: 'unlimited',
			worktreePath: join(temporaryRoot, 'unlimited'),
			lastUsedAt: 0,
			running: false,
			pinned: false,
			dirty: false,
		}], async () => { removerCalled = true; });

		assert.deepStrictEqual({ budget: budget.budget, isEnabled: budget.isEnabled, result, removerCalled }, {
			budget: undefined,
			isEnabled: false,
			result: undefined,
			removerCalled: false,
		});
	});

	test('parses the optional budget environment value', () => {
		assert.deepStrictEqual({
			environmentVariable: FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR,
			unset: parseWorktreeDiskBudgetBytes(undefined),
			zero: parseWorktreeDiskBudgetBytes('0'),
			configured: parseWorktreeDiskBudgetBytes('8589934592'),
		}, {
			environmentVariable: 'FUMIE_WORKTREE_DISK_BUDGET_BYTES',
			unset: undefined,
			zero: 0,
			configured: 8_589_934_592,
		});

		for (const invalid of ['', '-1', '1.5', 'Infinity', 'not-a-number', `${Number.MAX_SAFE_INTEGER + 1}`]) {
			assert.throws(
				() => parseWorktreeDiskBudgetBytes(invalid),
				error => error instanceof RangeError && error.message.includes(FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR),
			);
		}
	});

	test('measures recursively without following symbolic links', async () => {
		const worktree = join(temporaryRoot, 'worktree');
		const external = join(temporaryRoot, 'external');
		await mkdir(join(worktree, 'nested'), { recursive: true });
		await mkdir(external);
		await writeFile(join(worktree, 'nested', 'tracked.txt'), 'tracked');
		await writeFile(join(worktree, 'nested', 'invalid-fixture.asar'), 'not an asar archive');
		await writeFile(join(external, 'dependency.bin'), 'x');
		await symlink(external, join(worktree, 'node_modules'), isWindows ? 'junction' : 'dir');

		const beforeExternalGrowth = await measureWorktreeDiskUsage(worktree);
		await writeFile(join(external, 'dependency.bin'), Buffer.alloc(1024 * 1024));
		const afterExternalGrowth = await measureWorktreeDiskUsage(worktree);

		assert.deepStrictEqual({ beforeExternalGrowth, afterExternalGrowth }, {
			beforeExternalGrowth,
			afterExternalGrowth: beforeExternalGrowth,
		});
	});

	test('reclaims only clean idle candidates in LRU order', async () => {
		const createCandidate = async (sessionId: string, lastUsedAt: number, protection: Partial<Pick<IWorktreeDiskBudgetCandidate, 'running' | 'pinned' | 'dirty'>> = {}) => {
			const worktreePath = join(temporaryRoot, sessionId);
			await mkdir(worktreePath);
			await writeFile(join(worktreePath, 'payload.bin'), Buffer.alloc(1024));
			return { sessionId, worktreePath, lastUsedAt, running: false, pinned: false, dirty: false, ...protection };
		};

		const candidates = [
			await createCandidate('running', 0, { running: true }),
			await createCandidate('pinned', 1, { pinned: true }),
			await createCandidate('dirty', 2, { dirty: true }),
			await createCandidate('clean-old', 3),
			await createCandidate('clean-new', 4),
		];
		const before = await new WorktreeDiskBudget(Number.MAX_SAFE_INTEGER).getUsage(candidates);
		const cleanOldBytes = await measureWorktreeDiskUsage(candidates[3].worktreePath);
		const cleanNewBytes = await measureWorktreeDiskUsage(candidates[4].worktreePath);
		const removed: string[] = [];
		const budget = new WorktreeDiskBudget(before - cleanOldBytes - Math.floor(cleanNewBytes / 2));

		const result = await budget.reclaim(candidates, async candidate => {
			removed.push(candidate.sessionId);
			await rm(candidate.worktreePath, { recursive: true });
		});

		assert.deepStrictEqual({ removed, result }, {
			removed: ['clean-old', 'clean-new'],
			result: {
				before,
				after: before - cleanOldBytes - cleanNewBytes,
				reclaimed: cleanOldBytes + cleanNewBytes,
			},
		});
	});

	test('throws a clear error when protected worktrees keep usage over budget', async () => {
		const worktreePath = join(temporaryRoot, 'dirty');
		await mkdir(worktreePath);
		await writeFile(join(worktreePath, 'change.txt'), 'unsaved');
		const candidate: IWorktreeDiskBudgetCandidate = {
			sessionId: 'dirty',
			worktreePath,
			lastUsedAt: 0,
			running: false,
			pinned: false,
			dirty: true,
		};
		const usage = await measureWorktreeDiskUsage(worktreePath);
		let removerCalled = false;

		await assert.rejects(
			new WorktreeDiskBudget(usage - 1).reclaim([candidate], async () => { removerCalled = true; }),
			error => error instanceof WorktreeDiskBudgetExceededError
				&& error.message.includes(`${usage} bytes`)
				&& error.result.before === usage
				&& error.result.after === usage
				&& error.result.reclaimed === 0,
		);
		assert.strictEqual(removerCalled, false);
	});
});
