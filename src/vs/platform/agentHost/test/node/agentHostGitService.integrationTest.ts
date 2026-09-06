/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Integration tests for {@link AgentHostGitService} that spawn real `git` against
 * temporary on-disk repositories. Kept out of the unit-test suite because they
 * require `git` on PATH and do real filesystem and process work — same split as
 * the git extension (pure parser tests in `git.test.ts`, on-disk tests in
 * `smoke.test.ts`).
 *
 * Run via `scripts/test-integration.sh`.
 */

import assert from 'assert';
import * as cp from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { NullLogService } from '../../../log/common/log.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { FileService } from '../../../files/common/fileService.js';
import { Schemas } from '../../../../base/common/network.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { AgentHostGitService } from '../../node/agentHostGitService.js';
import { IWorktreeArchiveSnapshot } from '../../common/agentHostGitService.js';

class TestLogService extends NullLogService {
	readonly warnings: string[] = [];

	override warn(message: string): void {
		this.warnings.push(message);
	}
}

function createGitService(disposables: Pick<DisposableStore, 'add'>, logService: NullLogService = new NullLogService()): AgentHostGitService {
	const fileService = disposables.add(new FileService(logService));
	disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new DiskFileSystemProvider(logService))));
	const env: Partial<INativeEnvironmentService> = { tmpDir: URI.file(tmpdir()) };
	return new AgentHostGitService(fileService, env as INativeEnvironmentService, logService);
}

function rmDirWithRetry(path: string | undefined): void {
	if (!path) {
		return;
	}
	try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best-effort temp cleanup; Windows can briefly hold git handles */ }
}

async function publishArchiveStash(service: AgentHostGitService, dir: string, snapshot: IWorktreeArchiveSnapshot, ref: string): Promise<string> {
	const indexCommit = await service.commitTree(URI.file(dir), snapshot.indexTreeOid, snapshot.baseCommit, 'archive index', { syntheticIdentity: true });
	assert.ok(indexCommit);
	const untrackedCommit = snapshot.untrackedTreeOid
		? await service.commitTree(URI.file(dir), snapshot.untrackedTreeOid, undefined, 'archive untracked', { syntheticIdentity: true })
		: undefined;
	if (snapshot.untrackedTreeOid) {
		assert.ok(untrackedCommit);
	}
	const stashCommit = await service.commitTreeWithParents(
		URI.file(dir),
		snapshot.workingTreeOid,
		[snapshot.baseCommit, indexCommit, ...(untrackedCommit ? [untrackedCommit] : [])],
		'archive worktree',
		{ syntheticIdentity: true },
	);
	assert.ok(stashCommit);
	await service.updateRef(URI.file(dir), ref, stashCommit);
	return stashCommit;
}

suite('AgentHostGitService - getSessionGitState (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// Skip the on-disk git tests when `git` is not on PATH (e.g. minimal CI).
	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;
	let logService: TestLogService;

	setup(() => {
		tmpRoot = undefined;
		logService = new TestLogService();
		svc = createGitService(disposables, logService);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	function initRepo(opts?: { remote?: string; baseBranch?: string }): string {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-'));
		const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', opts?.baseBranch ?? 'main');
		run('commit', '-q', '--allow-empty', '-m', 'initial');
		if (opts?.remote) {
			run('remote', 'add', 'origin', opts.remote);
		}
		return tmpRoot!;
	}

	(hasGit ? test : test.skip)('returns undefined for a non-git directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-'));
		tmpRoot = dir;
		const result = await svc!.getSessionGitState(URI.file(dir));
		assert.strictEqual(result, undefined);
	});

	(hasGit ? test : test.skip)('reports branch, github remote and clean state for a fresh repo', async () => {
		const dir = initRepo({ remote: 'https://github.com/owner/repo.git' });
		const result = await svc!.getSessionGitState(URI.file(dir));
		assert.ok(result, 'expected git state');
		assert.strictEqual(result.branchName, 'main');
		assert.strictEqual(result.hasGitHubRemote, true);
		assert.strictEqual(result.uncommittedChanges, 0);
		// No upstream configured for the fresh local branch.
		assert.strictEqual(result.upstreamBranchName, undefined);
		assert.strictEqual(result.outgoingChanges, undefined);
		assert.strictEqual(result.incomingChanges, undefined);
	});

	(hasGit ? test : test.skip)('reports the GitHub owner of the branch upstream remote', async () => {
		const dir = initRepo({ remote: 'https://github.com/base-owner/repo.git' });
		cp.execFileSync('git', ['remote', 'add', 'fork', 'https://github.com/fork-owner/repo.git'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['update-ref', 'refs/remotes/fork/feature', 'HEAD'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['branch', '--set-upstream-to', 'fork/feature'], { cwd: dir, stdio: 'pipe' });

		const result = await svc!.getSessionGitState(URI.file(dir));

		assert.deepStrictEqual({
			githubOwner: result?.githubOwner,
			githubHeadOwner: result?.githubHeadOwner,
			githubRepo: result?.githubRepo,
			upstreamBranchName: result?.upstreamBranchName,
		}, {
			githubOwner: 'base-owner',
			githubHeadOwner: 'fork-owner',
			githubRepo: 'repo',
			upstreamBranchName: 'fork/feature',
		});
	});

	(hasGit ? test : test.skip)('reports the GitHub owner of a branch push remote without an upstream', async () => {
		const dir = initRepo({ remote: 'https://github.com/base-owner/repo.git' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['config', 'branch.feature.remote', 'https://github.com/fork-owner/repo.git'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['config', 'branch.feature.pushremote', 'https://github.com/fork-owner/repo.git'], { cwd: dir, stdio: 'pipe' });

		const result = await svc!.getSessionGitState(URI.file(dir));

		assert.deepStrictEqual({
			githubOwner: result?.githubOwner,
			githubHeadOwner: result?.githubHeadOwner,
			githubRepo: result?.githubRepo,
			upstreamBranchName: result?.upstreamBranchName,
		}, {
			githubOwner: 'base-owner',
			githubHeadOwner: 'fork-owner',
			githubRepo: 'repo',
			upstreamBranchName: undefined,
		});
	});

	(hasGit ? test : test.skip)('resolves the default branch name and remote-tracking start point', async () => {
		const dir = initRepo();
		cp.execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'], { cwd: dir, stdio: 'pipe' });
		cp.execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: dir, stdio: 'pipe' });

		assert.deepStrictEqual(await svc!.getDefaultBranch(URI.file(dir)), {
			name: 'main',
			startPoint: 'origin/main',
		});
	});

	(hasGit ? test : test.skip)('does not warn when the default remote-tracking ref is missing', async () => {
		const dir = initRepo();

		assert.deepStrictEqual({
			defaultBranch: await svc!.getDefaultBranch(URI.file(dir)),
			warnings: logService.warnings,
		}, {
			defaultBranch: undefined,
			warnings: [],
		});
	});

	(hasGit ? test : test.skip)('falls back to the local branch when the default remote-tracking ref is missing', async () => {
		const dir = initRepo();
		cp.execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: dir, stdio: 'pipe' });

		assert.deepStrictEqual(await svc!.getDefaultBranch(URI.file(dir)), {
			name: 'main',
			startPoint: 'main',
		});
	});

	(hasGit ? test : test.skip)('counts uncommitted changes', async () => {
		const dir = initRepo({ remote: 'git@gitlab.com:owner/repo.git' });
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, 'a.txt'), 'hello');
		await fs.writeFile(join(dir, 'b.txt'), 'world');
		const result = await svc!.getSessionGitState(URI.file(dir));
		assert.ok(result);
		assert.strictEqual(result.uncommittedChanges, 2);
		assert.strictEqual(result.hasGitHubRemote, false);
	});

	(hasGit ? test : test.skip)('reports no state at all when the status probe fails', async () => {
		const dir = initRepo({ remote: 'https://github.com/owner/repo.git' });
		const before = await svc!.getSessionGitState(URI.file(dir));
		// The repository root is cached from the call above, so the probes still
		// run against a repository that can no longer answer them — the same
		// shape a probe takes when it times out under load. A partial state
		// would be persisted over the branch this session still depends on.
		rmDirWithRetry(join(dir, '.git'));

		const after = await svc!.getSessionGitState(URI.file(dir));

		assert.deepStrictEqual({ before: before?.branchName, after }, { before: 'main', after: undefined });
	});

	(hasGit ? test : test.skip)('reports outgoingChanges relative to base branch when local branch has no upstream', async () => {
		// Create a bare "remote" repo and set up the working repo so that
		// `refs/remotes/origin/HEAD` exists (required for baseBranchName parsing).
		const remoteDir = mkdtempSync(join(tmpdir(), 'agent-host-remote-'));
		const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
		try {
			cp.execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remoteDir, env, stdio: 'pipe' });
			tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-'));
			const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
			run('init', '-q', '-b', 'main');
			run('config', 'commit.gpgSign', 'false');
			run('commit', '-q', '--allow-empty', '-m', 'initial');
			run('remote', 'add', 'origin', `https://github.com/owner/repo.git`);
			// Use a separate "upload" remote pointing at the bare repo to populate
			// the origin/main remote-tracking ref without changing the GitHub URL
			// we're testing for hasGitHubRemote detection.
			run('remote', 'add', 'tmp', remoteDir);
			run('push', '-q', 'tmp', 'main:main');
			// Create the origin/main ref locally without any network round-trip.
			run('update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
			run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

			// Branch off and add two commits without setting an upstream.
			run('checkout', '-q', '-b', 'feature', '--no-track');
			run('commit', '-q', '--allow-empty', '-m', 'one');
			run('commit', '-q', '--allow-empty', '-m', 'two');

			const result = await svc!.getSessionGitState(URI.file(tmpRoot!));
			assert.ok(result, 'expected git state');
			assert.strictEqual(result.branchName, 'feature');
			assert.strictEqual(result.baseBranchName, 'main');
			assert.strictEqual(result.upstreamBranchName, undefined);
			assert.strictEqual(result.outgoingChanges, 2);
			assert.strictEqual(result.hasBaseBranchChanges, true);
			assert.strictEqual(result.uncommittedChanges, 0);

			run('branch', '-D', 'main');
			const remoteOnlyResult = await svc!.getSessionGitState(URI.file(tmpRoot!));
			assert.strictEqual(remoteOnlyResult?.hasBaseBranchChanges, true);
		} finally {
			rmDirWithRetry(remoteDir);
		}
	});
});

suite('AgentHostGitService - computeSessionFileDiffs (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;

	setup(() => {
		tmpRoot = undefined;
		svc = createGitService(disposables);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	function initRepo(): { dir: string; run: (...args: string[]) => Buffer } {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-diff-'));
		const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', 'main');
		return { dir: tmpRoot!, run };
	}

	(hasGit ? test : test.skip)('returns undefined for a non-git directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-diff-'));
		tmpRoot = dir;
		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
		assert.strictEqual(result, undefined);
	});

	(hasGit ? test : test.skip)('reports modified, added (untracked) and deleted files against HEAD', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'kept.txt'), 'one\ntwo\nthree\n');
		await fs.writeFile(join(dir, 'gone.txt'), 'bye\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');

		// Modify, add (untracked), delete.
		await fs.writeFile(join(dir, 'kept.txt'), 'one\ntwo\nthree\nfour\n');
		await fs.writeFile(join(dir, 'fresh.txt'), 'hello\n');
		await fs.unlink(join(dir, 'gone.txt'));

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
		assert.ok(result, 'expected diffs');
		const byPath = new Map(result.map(d => [d.after?.uri ?? d.before?.uri, d]));

		// Find by basename to be robust against path normalization differences (e.g. macOS /private prefix).
		const findByBasename = (name: string) => result.find(d => {
			const u = d.after?.uri ?? d.before?.uri;
			return typeof u === 'string' && u.endsWith('/' + name);
		});

		const kept = findByBasename('kept.txt');
		assert.ok(kept?.before && kept.after, `modified file should have before+after; result=${JSON.stringify(result.map(d => ({ a: d.after?.uri, b: d.before?.uri })))}`);
		assert.deepStrictEqual(kept!.diff, { added: 1, removed: 0 });
		assert.strictEqual(URI.parse(kept!.before!.content.uri).scheme, 'git-blob', 'before content should be a git-blob: URI');

		const fresh = findByBasename('fresh.txt');
		assert.ok(fresh?.after && !fresh.before, 'untracked file should have only after');

		const gone = findByBasename('gone.txt');
		assert.ok(gone?.before && !gone.after, 'deleted file should have only before');
		void byPath;
	});

	(hasGit ? test : test.skip)('reports staged rename source when untracked files force temp-index staging', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'old.txt'), 'one\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');

		run('mv', 'old.txt', 'new.txt');
		await fs.writeFile(join(dir, 'fresh.txt'), 'fresh\n');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
		assert.ok(result, 'expected diffs');
		const rename = result.find(d => d.before?.uri.endsWith('/old.txt') && d.after?.uri.endsWith('/new.txt'));
		const fresh = result.find(d => !d.before && d.after?.uri.endsWith('/fresh.txt'));

		assert.deepStrictEqual({
			rename: rename && { before: URI.parse(rename.before!.uri).path.split('/').pop(), after: URI.parse(rename.after!.uri).path.split('/').pop() },
			fresh: fresh && URI.parse(fresh.after!.uri).path.split('/').pop(),
		}, {
			rename: { before: 'old.txt', after: 'new.txt' },
			fresh: 'fresh.txt',
		});
	});

	(hasGit ? test : test.skip)('ignores an index addition deleted from the worktree during temp-index staging', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'tracked.txt'), 'tracked\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');

		await fs.writeFile(join(dir, 'deleted-addition.txt'), 'temporary\n');
		run('add', 'deleted-addition.txt');
		await fs.unlink(join(dir, 'deleted-addition.txt'));
		await fs.writeFile(join(dir, 'fresh.txt'), 'fresh\n');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });

		assert.deepStrictEqual(result?.map(diff => URI.parse(diff.after?.uri ?? diff.before!.uri).path.split('/').pop()), ['fresh.txt']);
	});

	(hasGit && !isWindows ? test : test.skip)('returns undefined when temp-index staging fails', async () => {
		const fs = await import('fs/promises');
		const { dir } = initRepo();
		const blockedPath = join(dir, 'blocked.txt');
		await fs.writeFile(blockedPath, 'blocked\n');
		await fs.chmod(blockedPath, 0);
		try {
			const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
			assert.strictEqual(result, undefined);
		} finally {
			await fs.chmod(blockedPath, 0o600);
		}
	});

	(hasGit ? test : test.skip)('anchors against the merge-base of the requested base branch', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'a.txt'), 'a\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');
		// Branch off, then advance main behind us so merge-base != HEAD.
		run('checkout', '-q', '-b', 'feature');
		await fs.writeFile(join(dir, 'b.txt'), 'b\n');
		run('add', '.');
		run('commit', '-q', '-m', 'add b on feature');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s', baseBranch: 'main' });
		assert.ok(result, 'expected diffs');
		// `b.txt` was committed on `feature` after branching from `main`, so
		// it must show up in the merge-base diff even though there are no
		// uncommitted changes in the working tree.
		const paths = result.map(d => (d.after?.uri ?? d.before?.uri));
		assert.ok(paths.some(p => p?.endsWith('b.txt')), `expected b.txt in diff; got ${paths.join(', ')}`);
	});

	(hasGit ? test : test.skip)('prefers origin base branch when local base branch is stale', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'shared.txt'), 'base\n');
		run('add', '.');
		run('commit', '-q', '-m', 'base');
		run('update-ref', 'refs/remotes/origin/main', 'HEAD');

		run('checkout', '-q', '-b', 'feature');
		run('checkout', '-q', '-b', 'upstream', 'main');
		await fs.writeFile(join(dir, 'upstream.txt'), 'upstream\n');
		run('add', '.');
		run('commit', '-q', '-m', 'upstream');
		run('update-ref', 'refs/remotes/origin/main', 'HEAD');

		run('checkout', '-q', 'feature');
		run('merge', '-q', '--no-ff', 'origin/main', '-m', 'merge origin/main');
		await fs.writeFile(join(dir, 'feature.txt'), 'feature\n');
		run('add', '.');
		run('commit', '-q', '-m', 'feature');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s', baseBranch: 'main' });
		assert.ok(result, 'expected diffs');
		const paths = result.map(d => d.after?.uri ?? d.before?.uri);
		assert.deepStrictEqual({
			feature: paths.some(p => p?.endsWith('feature.txt')),
			upstream: paths.some(p => p?.endsWith('upstream.txt')),
		}, {
			feature: true,
			upstream: false,
		});
	});

	(hasGit ? test : test.skip)('returns no diffs for a clean repo', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'a.txt'), 'a\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
		assert.deepStrictEqual(result, []);
	});

	(hasGit ? test : test.skip)('handles an empty repo (no HEAD) by treating files as added', async () => {
		const fs = await import('fs/promises');
		const { dir } = initRepo();
		await fs.writeFile(join(dir, 'first.txt'), 'hello\n');

		const result = await svc!.computeSessionFileDiffs(URI.file(dir), { sessionUri: 'copilot:/s' });
		assert.ok(result, 'expected diffs');
		assert.strictEqual(result.length, 1);
		assert.ok(result[0].after && !result[0].before, 'untracked file in empty repo should be an addition');
	});

	(hasGit ? test : test.skip)('captureWorkingTreeAsTree stages scoped rename source and untracked paths', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'old.txt'), 'one\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');

		run('mv', 'old.txt', 'new.txt');
		await fs.writeFile(join(dir, 'fresh.txt'), 'fresh\n');

		const tree = await svc!.captureWorkingTreeAsTree(URI.file(dir));
		assert.ok(tree, 'expected tree object');
		const treePaths = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', tree], { cwd: dir, encoding: 'utf8' })
			.trim()
			.split(/\r?\n/g)
			.filter(Boolean)
			.sort();

		assert.deepStrictEqual(treePaths, ['fresh.txt', 'new.txt']);
	});

	(hasGit ? test : test.skip)('computes bounded per-file patches from an immutable working-tree snapshot', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'tracked.txt'), 'before\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');
		const baseline = run('rev-parse', 'HEAD').toString().trim();

		await fs.writeFile(join(dir, 'tracked.txt'), 'after\n');
		await fs.writeFile(join(dir, 'untracked.txt'), 'new\n');
		const tree = await svc!.captureWorkingTreeAsTree(URI.file(dir));
		assert.ok(tree);
		const fileDiffs = await svc!.computeFileDiffsBetweenRefs(URI.file(dir), { sessionUri: 'copilot:/s', fromRef: baseline, toRef: tree });
		assert.ok(fileDiffs);
		const snapshots = await Promise.all(fileDiffs.map(async fileDiff => {
			const before = fileDiff.before?.uri ? URI.parse(fileDiff.before.uri).path.split('/').pop() : undefined;
			const after = fileDiff.after?.uri ? URI.parse(fileDiff.after.uri).path.split('/').pop() : undefined;
			const paths = [before, after].filter((path): path is string => path !== undefined);
			const patch = await svc!.getDiffPatchBetweenRefs(URI.file(dir), { fromRef: baseline, toRef: tree, paths, maxBuffer: 900 * 1024 });
			return { before, after, patch };
		}));

		assert.deepStrictEqual(snapshots.map(snapshot => ({
			before: snapshot.before,
			after: snapshot.after,
			tooLarge: snapshot.patch?.tooLarge,
			containsExpectedContent: snapshot.after === 'tracked.txt'
				? snapshot.patch?.patch?.includes('-before\n+after')
				: snapshot.patch?.patch?.includes('+new'),
		})).sort((a, b) => (a.after ?? '').localeCompare(b.after ?? '')), [{
			before: 'tracked.txt',
			after: 'tracked.txt',
			tooLarge: false,
			containsExpectedContent: true,
		}, {
			before: undefined,
			after: 'untracked.txt',
			tooLarge: false,
			containsExpectedContent: true,
		}]);
	});

	(hasGit && !isWindows ? test : test.skip)('captureWorkingTreeAsTree returns undefined when staging fails', async () => {
		const fs = await import('fs/promises');
		const { dir } = initRepo();
		const blockedPath = join(dir, 'blocked.txt');
		await fs.writeFile(blockedPath, 'blocked\n');
		await fs.chmod(blockedPath, 0);
		try {
			const result = await svc!.captureWorkingTreeAsTree(URI.file(dir));
			assert.strictEqual(result, undefined);
		} finally {
			await fs.chmod(blockedPath, 0o600);
		}
	});

	(hasGit ? test : test.skip)('showBlob retrieves committed content', async () => {
		const fs = await import('fs/promises');
		const { dir, run } = initRepo();
		await fs.writeFile(join(dir, 'a.txt'), 'original\n');
		run('add', '.');
		run('commit', '-q', '-m', 'init');
		const ref = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
		await fs.writeFile(join(dir, 'a.txt'), 'changed\n');

		const blob = await svc!.showBlob(URI.file(dir), ref, 'a.txt');
		assert.ok(blob);
		assert.strictEqual(blob.toString(), 'original\n');
	});
});

suite('AgentHostGitService - worktree helpers (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

	setup(() => {
		tmpRoot = undefined;
		svc = createGitService(disposables);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	function initRepo(): string {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-wt-'));
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', 'main');
		run('config', 'user.name', 't');
		run('config', 'user.email', 't@t');
		run('config', 'commit.gpgSign', 'false');
		run('commit', '-q', '--allow-empty', '-m', 'initial');
		return tmpRoot!;
	}

	(hasGit ? test : test.skip)('branchExists reports true for HEAD branch and false for missing branches', async () => {
		const dir = initRepo();
		assert.strictEqual(await svc!.branchExists(URI.file(dir), 'main'), true);
		assert.strictEqual(await svc!.branchExists(URI.file(dir), 'does-not-exist'), false);
	});

	(hasGit ? test : test.skip)('hasUncommittedChanges flips with untracked and committed work', async () => {
		const dir = initRepo();
		assert.strictEqual(await svc!.hasUncommittedChanges(URI.file(dir)), false);
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, 'a.txt'), 'hello');
		assert.strictEqual(await svc!.hasUncommittedChanges(URI.file(dir)), true);
		cp.execFileSync('git', ['add', 'a.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add a'], { cwd: dir, env, stdio: 'pipe' });
		assert.strictEqual(await svc!.hasUncommittedChanges(URI.file(dir)), false);
	});

	(hasGit ? test : test.skip)('archive stash stores Git index, working tree and untracked state without moving the branch', async () => {
		const dir = initRepo();
		writeFileSync(join(dir, '.gitignore'), [
			'node_modules/',
			'out/',
			'.eslintcache',
			'.env',
			'private/',
		].join('\n') + '\n');
		writeFileSync(join(dir, 'tracked.txt'), 'before\n');
		writeFileSync(join(dir, 'removed.txt'), 'remove me\n');
		cp.execFileSync('git', ['add', '.'], { cwd: dir });
		cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'archive base'], { cwd: dir });
		const branchHead = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

		writeFileSync(join(dir, 'tracked.txt'), 'after\n');
		rmSync(join(dir, 'removed.txt'));
		writeFileSync(join(dir, 'new.txt'), 'new\n');
		mkdirSync(join(dir, 'private'), { recursive: true });
		writeFileSync(join(dir, 'private', 'notes.txt'), 'keep me\n');
		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		writeFileSync(join(dir, 'node_modules', 'cache.bin'), 'discard');
		mkdirSync(join(dir, 'out'), { recursive: true });
		writeFileSync(join(dir, 'out', 'generated.js'), 'discard');
		writeFileSync(join(dir, '.eslintcache'), 'discard');
		writeFileSync(join(dir, '.env'), 'recreated elsewhere');

		const snapshot = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		assert.ok(snapshot?.untrackedTreeOid);
		const workingTreePaths = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', snapshot.workingTreeOid], { cwd: dir, encoding: 'utf8' })
			.trim().split(/\r?\n/g).filter(Boolean).sort();
		const untrackedTreePaths = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', snapshot.untrackedTreeOid], { cwd: dir, encoding: 'utf8' })
			.trim().split(/\r?\n/g).filter(Boolean).sort();
		assert.deepStrictEqual({
			baseCommit: snapshot.baseCommit,
			branchHead: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
			indexMatchesBase: snapshot.indexTreeOid === snapshot.baseTreeOid,
			workingTreePaths,
			untrackedTreePaths,
		}, {
			baseCommit: branchHead,
			branchHead,
			indexMatchesBase: true,
			workingTreePaths: ['.gitignore', 'tracked.txt'],
			untrackedTreePaths: ['new.txt'],
		});

		const archiveRef = 'refs/agents/test/archive';
		await publishArchiveStash(svc!, dir, snapshot, archiveRef);
		cp.execFileSync('git', ['reset', '--hard', '-q', 'HEAD'], { cwd: dir });
		cp.execFileSync('git', ['clean', '-fdx'], { cwd: dir });
		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		writeFileSync(join(dir, 'node_modules', 'cache.bin'), 'fresh dependency cache');
		writeFileSync(join(dir, '.env'), 'fresh reproducible environment');

		await svc!.applyWorktreeArchiveStash(URI.file(dir), archiveRef);
		const restored = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		assert.deepStrictEqual({
			branchHead: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
			tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
			removedExists: existsSync(join(dir, 'removed.txt')),
			untracked: readFileSync(join(dir, 'new.txt'), 'utf8'),
			ignoredUserDataExists: existsSync(join(dir, 'private', 'notes.txt')),
			dependencyCache: readFileSync(join(dir, 'node_modules', 'cache.bin'), 'utf8'),
			otherGeneratedExists: existsSync(join(dir, 'out')) || existsSync(join(dir, '.eslintcache')),
			reproducibleEnvironment: readFileSync(join(dir, '.env'), 'utf8'),
			restored,
		}, {
			branchHead,
			tracked: 'after\n',
			removedExists: false,
			untracked: 'new\n',
			ignoredUserDataExists: false,
			dependencyCache: 'fresh dependency cache',
			otherGeneratedExists: false,
			reproducibleEnvironment: 'fresh reproducible environment',
			restored: snapshot,
		});
	});

	(hasGit ? test : test.skip)('archive snapshot follows Git cleanliness and excludes all ignored output', async () => {
		const dir = initRepo();
		writeFileSync(join(dir, '.gitignore'), 'node_modules/\nout/\n.eslintcache\n.env\n.claude/\nprivate/\nextensions/mermaid-markdown-features/chat-webview-out/\ntest/automation/src/driver.d.ts\n');
		cp.execFileSync('git', ['add', '.gitignore'], { cwd: dir });
		cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore rules'], { cwd: dir });
		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		writeFileSync(join(dir, 'node_modules', 'cache.bin'), 'discard');
		mkdirSync(join(dir, 'out'), { recursive: true });
		writeFileSync(join(dir, 'out', 'generated.js'), 'discard');
		writeFileSync(join(dir, '.eslintcache'), 'discard');
		writeFileSync(join(dir, '.env'), 'recreated elsewhere');
		mkdirSync(join(dir, '.claude'), { recursive: true });
		writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'generated link stand-in');
		mkdirSync(join(dir, 'private'), { recursive: true });
		writeFileSync(join(dir, 'private', 'notes.txt'), 'undeclared ignored content');
		mkdirSync(join(dir, 'extensions', 'mermaid-markdown-features', 'chat-webview-out'), { recursive: true });
		writeFileSync(join(dir, 'extensions', 'mermaid-markdown-features', 'chat-webview-out', 'bundle.js'), 'generated');
		mkdirSync(join(dir, 'test', 'automation', 'src'), { recursive: true });
		writeFileSync(join(dir, 'test', 'automation', 'src', 'driver.d.ts'), 'generated');

		const snapshot = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		const baseCommit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
		const baseTree = cp.execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
		assert.deepStrictEqual(snapshot, {
			baseCommit,
			baseTreeOid: baseTree,
			indexTreeOid: baseTree,
			workingTreeOid: baseTree,
		});
	});

	(hasGit ? test : test.skip)('archive snapshot preserves distinct staged and working-tree versions of one file', async () => {
		const dir = initRepo();
		writeFileSync(join(dir, 'tracked.txt'), 'base\n');
		cp.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
		cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tracked base'], { cwd: dir });
		writeFileSync(join(dir, 'tracked.txt'), 'staged-only\n');
		cp.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
		writeFileSync(join(dir, 'tracked.txt'), 'working-only\n');

		const snapshot = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		assert.ok(snapshot);
		assert.deepStrictEqual({
			index: cp.execFileSync('git', ['show', `${snapshot.indexTreeOid}:tracked.txt`], { cwd: dir, encoding: 'utf8' }),
			working: cp.execFileSync('git', ['show', `${snapshot.workingTreeOid}:tracked.txt`], { cwd: dir, encoding: 'utf8' }),
		}, {
			index: 'staged-only\n',
			working: 'working-only\n',
		});

		const archiveRef = 'refs/agents/test/mm-archive';
		await publishArchiveStash(svc!, dir, snapshot, archiveRef);
		cp.execFileSync('git', ['reset', '--hard', '-q', 'HEAD'], { cwd: dir });
		await svc!.applyWorktreeArchiveStash(URI.file(dir), archiveRef);
		assert.deepStrictEqual({
			status: cp.execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(),
			index: cp.execFileSync('git', ['show', ':tracked.txt'], { cwd: dir, encoding: 'utf8' }),
			working: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
			verified: await svc!.captureWorktreeArchiveSnapshot(URI.file(dir)),
		}, {
			status: 'MM tracked.txt',
			index: 'staged-only\n',
			working: 'working-only\n',
			verified: snapshot,
		});
	});

	(hasGit ? test : test.skip)('archive verification observes a write made after the first four-state snapshot', async () => {
		const dir = initRepo();
		writeFileSync(join(dir, 'tracked.txt'), 'base\n');
		cp.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
		cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tracked base'], { cwd: dir });
		writeFileSync(join(dir, 'tracked.txt'), 'first snapshot\n');
		const first = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		writeFileSync(join(dir, 'tracked.txt'), 'written after snapshot\n');
		const second = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));

		assert.ok(first && second);
		assert.notStrictEqual(second.workingTreeOid, first.workingTreeOid);
		assert.strictEqual(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'written after snapshot\n');
	});

	(hasGit ? test : test.skip)('archive stash commits use a synthetic identity when user identity is invalid', async () => {
		const dir = initRepo();
		cp.execFileSync('git', ['config', 'user.name', ''], { cwd: dir });
		cp.execFileSync('git', ['config', 'user.email', ''], { cwd: dir });
		writeFileSync(join(dir, 'untracked.txt'), 'archive me\n');
		const snapshot = await svc!.captureWorktreeArchiveSnapshot(URI.file(dir));
		assert.ok(snapshot);

		const stashCommit = await publishArchiveStash(svc!, dir, snapshot, 'refs/agents/test/no-identity');
		assert.deepStrictEqual({
			author: cp.execFileSync('git', ['show', '-s', '--format=%an <%ae>', stashCommit], { cwd: dir, encoding: 'utf8' }).trim(),
			committer: cp.execFileSync('git', ['show', '-s', '--format=%cn <%ce>', stashCommit], { cwd: dir, encoding: 'utf8' }).trim(),
		}, {
			author: 'Fumie <fumie@localhost>',
			committer: 'Fumie <fumie@localhost>',
		});
	});

	(hasGit ? test : test.skip)('deleteRefs propagates a real ref-lock failure and leaves the ref intact', async () => {
		const dir = initRepo();
		const ref = 'refs/agents/test/strict-delete';
		await svc!.updateRef(URI.file(dir), ref, cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
		const lockPath = join(dir, '.git', `${ref}.lock`);
		mkdirSync(join(dir, '.git', 'refs', 'agents', 'test'), { recursive: true });
		writeFileSync(lockPath, 'held');

		await assert.rejects(() => svc!.deleteRefs(URI.file(dir), [ref]), /git update-ref exited with code/);
		assert.ok(await svc!.revParse(URI.file(dir), ref));
		rmSync(lockPath);
		await svc!.deleteRefs(URI.file(dir), [ref]);
		assert.strictEqual(await svc!.revParse(URI.file(dir), ref), undefined);
	});

	(hasGit ? test : test.skip)('archive snapshot fails closed for an untracked nested Git repository', async () => {
		const dir = initRepo();
		const nested = join(dir, 'nested');
		mkdirSync(nested, { recursive: true });
		cp.execFileSync('git', ['init', '-q'], { cwd: nested });
		writeFileSync(join(nested, 'data.txt'), 'nested data\n');
		cp.execFileSync('git', ['add', 'data.txt'], { cwd: nested });
		cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'nested'], { cwd: nested });

		assert.strictEqual(await svc!.captureWorktreeArchiveSnapshot(URI.file(dir)), undefined);
		assert.strictEqual(readFileSync(join(nested, 'data.txt'), 'utf8'), 'nested data\n');
	});

	(hasGit && !isWindows ? test : test.skip)('status probes do not acquire optional index locks', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		const trackedFile = join(dir, 'tracked.txt');
		await fs.writeFile(trackedFile, 'tracked');
		cp.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add tracked'], { cwd: dir, env, stdio: 'pipe' });

		const marker = join(dir, '.git', 'status-index-refreshed');
		const hook = join(dir, '.git', 'hooks', 'post-index-change');
		await fs.writeFile(hook, '#!/bin/sh\nprintf refreshed > .git/status-index-refreshed\n');
		await fs.chmod(hook, 0o755);
		const future = new Date(Date.now() + 10_000);
		await fs.utimes(trackedFile, future, future);

		const hasChanges = await svc!.hasUncommittedChanges(URI.file(dir));

		assert.deepStrictEqual({ hasChanges, refreshedIndex: existsSync(marker) }, { hasChanges: false, refreshedIndex: false });
	});

	(hasGit ? test : test.skip)('commitAll stages tracked, staged and untracked changes and creates a commit', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, 'tracked.txt'), 'before');
		cp.execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add tracked'], { cwd: dir, env, stdio: 'pipe' });

		await fs.writeFile(join(dir, 'tracked.txt'), 'after');
		await fs.writeFile(join(dir, 'staged.txt'), 'staged');
		cp.execFileSync('git', ['add', 'staged.txt'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'untracked.txt'), 'untracked');

		await svc!.commitAll(URI.file(dir), 'commit all changes');

		const status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const lastMessage = cp.execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const committedFiles = cp.execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim().split(/\r?\n/g).sort();

		assert.deepStrictEqual({ status, lastMessage, committedFiles }, {
			status: '',
			lastMessage: 'commit all changes',
			committedFiles: ['staged.txt', 'tracked.txt', 'untracked.txt'],
		});
	});

	(hasGit ? test : test.skip)('mergeBranch merges into the current branch', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		cp.execFileSync('git', ['checkout', '-q', '-b', 'agents/session'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'session.txt'), 'session changes');
		cp.execFileSync('git', ['add', 'session.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'session changes'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, env, stdio: 'pipe' });

		await svc!.mergeBranch(URI.file(dir), 'agents/session');

		const status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const source = cp.execFileSync('git', ['rev-parse', 'agents/session'], { cwd: dir, env, encoding: 'utf8' }).trim();
		assert.deepStrictEqual({ status, headMatchesSource: head === source }, { status: '', headMatchesSource: true });
	});

	(hasGit ? test : test.skip)('mergeBranch aborts a conflicted merge', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, 'shared.txt'), 'base');
		cp.execFileSync('git', ['add', 'shared.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add shared'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'agents/session'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'shared.txt'), 'session');
		cp.execFileSync('git', ['commit', '-q', '-am', 'session changes'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'shared.txt'), 'main');
		cp.execFileSync('git', ['commit', '-q', '-am', 'main changes'], { cwd: dir, env, stdio: 'pipe' });

		let mergeFailed = false;
		try {
			await svc!.mergeBranch(URI.file(dir), 'agents/session');
		} catch {
			mergeFailed = true;
		}

		const status = cp.execFileSync('git', ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const contents = await fs.readFile(join(dir, 'shared.txt'), 'utf8');
		let mergeHeadExists = true;
		try {
			cp.execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: dir, env, stdio: 'ignore' });
		} catch {
			mergeHeadExists = false;
		}
		assert.deepStrictEqual({ mergeFailed, status, contents, mergeHeadExists }, {
			mergeFailed: true,
			status: '',
			contents: 'main',
			mergeHeadExists: false,
		});
	});

	(hasGit ? test : test.skip)('mergeBranch preserves a pre-existing merge', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, 'shared.txt'), 'base');
		cp.execFileSync('git', ['add', 'shared.txt'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add shared'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'agents/session'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'shared.txt'), 'session');
		cp.execFileSync('git', ['commit', '-q', '-am', 'session changes'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'shared.txt'), 'main');
		cp.execFileSync('git', ['commit', '-q', '-am', 'main changes'], { cwd: dir, env, stdio: 'pipe' });
		try {
			cp.execFileSync('git', ['merge', '--no-edit', 'agents/session'], { cwd: dir, env, stdio: 'pipe' });
		} catch {
			// The conflict is the pre-existing merge state under test.
		}

		let errorMessage: string | undefined;
		try {
			await svc!.mergeBranch(URI.file(dir), 'agents/session');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		let mergeHeadExists = true;
		try {
			cp.execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: dir, env, stdio: 'ignore' });
		} catch {
			mergeHeadExists = false;
		} finally {
			cp.execFileSync('git', ['merge', '--abort'], { cwd: dir, env, stdio: 'pipe' });
		}

		assert.deepStrictEqual({
			rejectedExistingMerge: errorMessage?.includes('another merge is already in progress') === true,
			mergeHeadExists,
		}, {
			rejectedExistingMerge: true,
			mergeHeadExists: true,
		});
	});

	(hasGit ? test : test.skip)('addExistingWorktree attaches a worktree for an existing branch (no -b)', async () => {
		const dir = initRepo();
		cp.execFileSync('git', ['branch', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addExistingWorktree(URI.file(dir), URI.file(wtPath), 'feature');
			const fs = await import('fs/promises');
			const stat = await fs.stat(wtPath);
			assert.ok(stat.isDirectory(), 'worktree directory should exist');
		} finally {
			rmDirWithRetry(wtPath);
		}
	});

	(hasGit ? test : test.skip)('addWorktree attaches a worktree without creating a new branch', async () => {
		const dir = initRepo();
		cp.execFileSync('git', ['branch', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'feature',
				track: false,
			});

			assert.strictEqual(cp.execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, env, encoding: 'utf8' }).trim(), 'feature');
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
		}
	});

	(hasGit ? test : test.skip)('addWorktree preserves tracking when attaching an existing branch', async () => {
		const dir = initRepo();
		const remotePath = join(dir, 'remote.git');
		cp.execFileSync('git', ['init', '--bare', '-q', remotePath], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['branch', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['push', '-q', '--set-upstream', 'origin', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'feature',
				track: true,
			});

			assert.deepStrictEqual({
				branch: cp.execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, env, encoding: 'utf8' }).trim(),
				upstream: cp.execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: wtPath, env, encoding: 'utf8' }).trim(),
			}, {
				branch: 'feature',
				upstream: 'origin/feature',
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
		}
	});

	(hasGit ? test : test.skip)('addWorktree automatically tracks a remote branch when creating its local branch', async () => {
		const dir = initRepo();
		const remotePath = join(dir, 'remote.git');
		cp.execFileSync('git', ['init', '--bare', '-q', remotePath], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['push', '-q', 'origin', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['branch', '-D', 'feature'], { cwd: dir, env, stdio: 'pipe' });
		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'feature',
				newBranchName: 'feature',
				track: true,
				preferRemoteBranch: true,
			});

			assert.deepStrictEqual({
				branch: cp.execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, env, encoding: 'utf8' }).trim(),
				upstream: cp.execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: wtPath, env, encoding: 'utf8' }).trim(),
			}, {
				branch: 'feature',
				upstream: 'origin/feature',
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
		}
	});

	(hasGit ? test : test.skip)('removeWorktree preserves dirty work unless forced', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		const wtPath = join(dir, '..', `wt-dirty-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/dirty-worktree',
				track: false,
			});
			await fs.writeFile(join(wtPath, 'untracked.txt'), 'keep me');

			let safeRemovalFailed = false;
			try {
				await svc!.removeWorktree(URI.file(dir), URI.file(wtPath));
			} catch {
				safeRemovalFailed = true;
			}
			const existsAfterSafeRemoval = existsSync(wtPath);

			await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true });

			assert.deepStrictEqual({
				safeRemovalFailed,
				existsAfterSafeRemoval,
				existsAfterForcedRemoval: existsSync(wtPath),
			}, {
				safeRemovalFailed: true,
				existsAfterSafeRemoval: true,
				existsAfterForcedRemoval: false,
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/dirty-worktree'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	(hasGit ? test : test.skip)('removeWorktree prunes a lingering admin entry when the working tree is already gone', async () => {
		const dir = initRepo();
		const suffix = `wt-prune-${Date.now()}`;
		const wtPath = join(dir, '..', suffix);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/prune-worktree',
				track: false,
			});
			// Reproduce the CI teardown race: the working tree directory is gone
			// but git still holds the `.git/worktrees/<id>` admin entry, so a plain
			// `git worktree remove` fails — removeWorktree must fall back to prune.
			rmSync(wtPath, { recursive: true, force: true });
			const listedBefore = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, env, encoding: 'utf8' });

			await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true });

			const listedAfter = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, env, encoding: 'utf8' });
			assert.deepStrictEqual({
				registeredBefore: listedBefore.includes(suffix),
				registeredAfter: listedAfter.includes(suffix),
			}, {
				registeredBefore: true,
				registeredAfter: false,
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/prune-worktree'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	(hasGit ? test : test.skip)('removeWorktree rejects instead of falsely succeeding when the admin entry cannot be deleted', async () => {
		const dir = initRepo();
		const suffix = `wt-leak-${Date.now()}`;
		const wtPath = join(dir, '..', suffix);
		let worktreeLocked = false;
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/leak-worktree',
				track: false,
			});
			cp.execFileSync('git', ['worktree', 'lock', wtPath], { cwd: dir, env, stdio: 'pipe' });
			worktreeLocked = true;
			// A locked missing worktree makes prune exit 0 while retaining the admin entry on every OS.
			rmSync(wtPath, { recursive: true, force: true });

			await assert.rejects(
				svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }),
				'removeWorktree must reject when the worktree stays registered, not report a false success',
			);

			const listed = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, env, encoding: 'utf8' });
			assert.ok(listed.includes(suffix), 'the still-registered worktree must surface as a leak, not be masked');
		} finally {
			if (worktreeLocked) {
				try { cp.execFileSync('git', ['worktree', 'unlock', wtPath], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
			}
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/leak-worktree'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	// Residual case of #329982: git can de-register a worktree (drop its
	// `.git/worktrees/<id>` admin entry) while its directory still remains on
	// disk. A later removal must still succeed because git no longer tracks the path.
	(hasGit ? test : test.skip)('removeWorktree succeeds when git no longer tracks a still-present worktree directory', async () => {
		const dir = initRepo();
		const suffix = `wt-orphan-${Date.now()}`;
		const wtPath = join(dir, '..', suffix);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/orphan-worktree',
				track: false,
			});
			// De-register the worktree (delete git's admin entries) while leaving the working-tree directory in place.
			const adminRoot = join(dir, '.git', 'worktrees');
			for (const entry of readdirSync(adminRoot)) {
				rmSync(join(adminRoot, entry), { recursive: true, force: true });
			}
			// Pin the precondition so the test cannot silently rot into the prune/verify path.
			const listed = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, env, encoding: 'utf8' });
			assert.deepStrictEqual({
				dirPresent: existsSync(wtPath),
				stillRegistered: listed.includes(suffix),
			}, {
				dirPresent: true,
				stillRegistered: false,
			});

			// Removal must treat an already-de-registered worktree as success.
			await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true });
		} finally {
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/orphan-worktree'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	// Fail-closed guard: when git cannot confirm the worktree is unregistered (e.g.
	// the repository is gone), a failed removal must propagate rather than be
	// silently reported as success.
	(hasGit ? test : test.skip)('removeWorktree rethrows when git cannot confirm removal', async () => {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-nonrepo-'));
		const wtPath = join(tmpRoot, 'wt');
		mkdirSync(wtPath); // exists -> deterministic `git worktree remove` branch
		await assert.rejects(
			svc!.removeWorktree(URI.file(tmpRoot), URI.file(wtPath), { force: true }),
			/exited with code 128/,
		);
	});

	(hasGit ? test : test.skip)('deleteBranch removes only the specified worktree branch and is idempotent', async () => {
		const dir = initRepo();
		const managedBranch = 'agents/delete-worktree-branch';
		const userBranch = 'user/keep-branch';
		const wtPath = join(dir, '..', `wt-delete-${Date.now()}`);
		const branchExists = (branchName: string) => cp.spawnSync(
			'git',
			['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
			{ cwd: dir, env, stdio: 'ignore' },
		).status === 0;

		try {
			cp.execFileSync('git', ['branch', userBranch, 'main'], { cwd: dir, env, stdio: 'pipe' });
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: managedBranch,
				track: false,
			});
			await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true });

			assert.deepStrictEqual({
				managedBeforeDelete: branchExists(managedBranch),
				userBeforeDelete: branchExists(userBranch),
			}, {
				managedBeforeDelete: true,
				userBeforeDelete: true,
			});

			await svc!.deleteBranch(URI.file(dir), managedBranch, { force: true });
			await svc!.deleteBranch(URI.file(dir), managedBranch, { force: true });

			assert.deepStrictEqual({
				managedAfterDelete: branchExists(managedBranch),
				userAfterDelete: branchExists(userBranch),
			}, {
				managedAfterDelete: false,
				userAfterDelete: true,
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', managedBranch], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	(hasGit ? test : test.skip)('addWorktree prefers origin start point when local branch is stale', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		cp.execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', '-b', 'upstream', 'main'], { cwd: dir, env, stdio: 'pipe' });
		await fs.writeFile(join(dir, 'upstream.txt'), 'upstream');
		cp.execFileSync('git', ['add', '.'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'upstream'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir, env, stdio: 'pipe' });

		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/test-origin-start-point',
				preferRemoteBranch: true,
				track: false,
			});
			const stat = await fs.stat(join(wtPath, 'upstream.txt'));
			assert.ok(stat.isFile(), 'worktree should start from origin/main, not stale local main');
			assert.throws(() => cp.execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: wtPath, env, stdio: 'pipe' }), /fatal:/);
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/test-origin-start-point'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	(hasGit ? test : test.skip)('copyWorktreeIncludeFiles copies matched git-ignored files, collapsing wholly-ignored folders', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');

		await fs.writeFile(join(dir, '.gitignore'), '.env\nsecrets/\nbuild/\npartial/\n*.local\n');

		// Matched root file.
		await fs.writeFile(join(dir, '.env'), 'SECRET=1');
		// Wholly-ignored dir, fully matched by `secrets/**` -> collapsed to one recursive copy.
		await fs.mkdir(join(dir, 'secrets', 'nested'), { recursive: true });
		await fs.writeFile(join(dir, 'secrets', 'key.txt'), 'key');
		await fs.writeFile(join(dir, 'secrets', 'nested', 'deep.txt'), 'deep');
		// Wholly-ignored dir that no glob matches -> must be skipped entirely.
		await fs.mkdir(join(dir, 'build'), { recursive: true });
		await fs.writeFile(join(dir, 'build', 'output.txt'), 'artifact');
		// Wholly-ignored dir only partially matched by `partial/*.txt` -> must NOT
		// collapse; only the matched file is copied, its sibling is left behind.
		await fs.mkdir(join(dir, 'partial'), { recursive: true });
		await fs.writeFile(join(dir, 'partial', 'keep.txt'), 'keep');
		await fs.writeFile(join(dir, 'partial', 'skip.bin'), 'skip');
		// Partially-tracked dir: an ignored file is matched by `app/**`, but the
		// tracked sibling must never be copied/clobbered even though it too is
		// under `app/` (it is not a git-ignored file, so it is not a candidate).
		await fs.mkdir(join(dir, 'app'), { recursive: true });
		await fs.writeFile(join(dir, 'app', 'main.ts'), 'committed');
		await fs.writeFile(join(dir, 'app', 'config.local'), 'local');
		cp.execFileSync('git', ['add', 'app/main.ts'], { cwd: dir, env, stdio: 'pipe' });
		cp.execFileSync('git', ['commit', '-q', '-m', 'add tracked'], { cwd: dir, env, stdio: 'pipe' });
		// Uncommitted change to the tracked file: if the folder were wrongly
		// collapsed/copied, the worktree checkout would be overwritten with this.
		await fs.writeFile(join(dir, 'app', 'main.ts'), 'MODIFIED');

		const wtPath = join(dir, '..', `wt-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/include-files',
				track: false,
			});
			const progress: { filesDone: number; filesTotal: number }[] = [];
			await svc!.copyWorktreeIncludeFiles(URI.file(dir), URI.file(wtPath), ['.env', 'secrets/**', 'partial/*.txt', 'app/**'], sample => progress.push(sample));

			const read = async (relativePath: string) => {
				try { return await fs.readFile(join(wtPath, relativePath), 'utf8'); } catch { return undefined; }
			};

			assert.deepStrictEqual({
				env: await read('.env'),
				secretKey: await read(join('secrets', 'key.txt')),
				secretDeep: await read(join('secrets', 'nested', 'deep.txt')),
				buildArtifact: await read(join('build', 'output.txt')),
				partialKeep: await read(join('partial', 'keep.txt')),
				partialSkip: await read(join('partial', 'skip.bin')),
				appConfig: await read(join('app', 'config.local')),
				appTracked: await read(join('app', 'main.ts')),
				// One sample per copied entry (`secrets/` collapsed, plus three
				// standalone files), but counted in the 5 files they cover so
				// the collapsed directory isn't under-weighted. Completion order
				// is nondeterministic, so only the totals are asserted.
				progressSamples: progress.length,
				progressTotals: [...new Set(progress.map(sample => sample.filesTotal))],
				progressDone: progress.at(-1)?.filesDone,
			}, {
				env: 'SECRET=1',
				secretKey: 'key',
				secretDeep: 'deep',
				buildArtifact: undefined,
				partialKeep: 'keep',
				partialSkip: undefined,
				appConfig: 'local',
				appTracked: 'committed',
				progressSamples: 4,
				progressTotals: [5],
				progressDone: 5,
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/include-files'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	// `git ls-files --directory` stops descending at the wholly-ignored `build/`,
	// so the matched `node_modules` subtree underneath it is only visible as
	// individual files. It must still be copied as a single recursive unit —
	// the fumie repo's own `.build/` holds ~21k such files.
	(hasGit ? test : test.skip)('copyWorktreeIncludeFiles collapses a matched subtree below a partially matched ignored folder', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');

		await fs.writeFile(join(dir, '.gitignore'), 'build/\n');
		await fs.mkdir(join(dir, 'build', 'deps', 'node_modules', 'y'), { recursive: true });
		// Unmatched sibling: `build/` itself cannot be copied wholesale.
		await fs.writeFile(join(dir, 'build', 'other.txt'), 'artifact');
		await fs.writeFile(join(dir, 'build', 'deps', 'node_modules', 'x.js'), 'x');
		await fs.writeFile(join(dir, 'build', 'deps', 'node_modules', 'y', 'z.js'), 'z');

		const wtPath = join(dir, '..', `wt-nested-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/include-nested',
				track: false,
			});
			const progress: { filesDone: number; filesTotal: number }[] = [];
			await svc!.copyWorktreeIncludeFiles(URI.file(dir), URI.file(wtPath), ['**/node_modules/**'], sample => progress.push(sample));

			const read = async (relativePath: string) => {
				try { return await fs.readFile(join(wtPath, relativePath), 'utf8'); } catch { return undefined; }
			};

			assert.deepStrictEqual({
				nested: await read(join('build', 'deps', 'node_modules', 'x.js')),
				deep: await read(join('build', 'deps', 'node_modules', 'y', 'z.js')),
				unmatched: await read(join('build', 'other.txt')),
				// A single sample covering both files proves the subtree was
				// copied as one entry rather than file-by-file.
				progress,
			}, {
				nested: 'x',
				deep: 'z',
				unmatched: undefined,
				progress: [{ filesDone: 2, filesTotal: 2 }],
			});
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/include-nested'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});

	(hasGit ? test : test.skip)('copyWorktreeIncludeFiles rejects when any matched file cannot be copied', async () => {
		const dir = initRepo();
		const fs = await import('fs/promises');
		await fs.writeFile(join(dir, '.gitignore'), 'config/secret.env\n');
		await fs.mkdir(join(dir, 'config'));
		await fs.writeFile(join(dir, 'config', 'secret.env'), 'SECRET=1');

		const wtPath = join(dir, '..', `wt-copy-failure-${Date.now()}`);
		try {
			await svc!.addWorktree(URI.file(dir), {
				path: URI.file(wtPath),
				commitish: 'main',
				newBranchName: 'agents/include-copy-failure',
				track: false,
			});
			// A regular file at the target parent path makes the recursive mkdir fail
			// deterministically on every platform, without relying on permission bits.
			await fs.writeFile(join(wtPath, 'config'), 'blocks target directory');

			await assert.rejects(
				svc!.copyWorktreeIncludeFiles(URI.file(dir), URI.file(wtPath), ['config/secret.env']),
				/Failed to copy 1 configured worktree file entry/,
			);
		} finally {
			try { await svc!.removeWorktree(URI.file(dir), URI.file(wtPath), { force: true }); } catch { /* best-effort cleanup */ }
			rmDirWithRetry(wtPath);
			try { cp.execFileSync('git', ['branch', '-D', 'agents/include-copy-failure'], { cwd: dir, env, stdio: 'ignore' }); } catch { /* best-effort cleanup */ }
		}
	});
});

suite('AgentHostGitService - restore (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

	setup(() => {
		tmpRoot = undefined;
		svc = createGitService(disposables);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	async function initRepoWithFiles(files: Record<string, string>): Promise<string> {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-restore-'));
		const fs = await import('fs/promises');
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', 'main');
		for (const [name, content] of Object.entries(files)) {
			await fs.writeFile(join(tmpRoot!, name), content);
		}
		run('add', '.');
		run('commit', '-q', '-m', 'init');
		return tmpRoot!;
	}

	(hasGit ? test : test.skip)('reverts a modified working-tree file to the committed content', async () => {
		const fs = await import('fs/promises');
		const dir = await initRepoWithFiles({ 'a.txt': 'original' });
		await fs.writeFile(join(dir, 'a.txt'), 'changed');

		await svc!.restore(URI.file(dir), ['a.txt']);

		assert.strictEqual(await fs.readFile(join(dir, 'a.txt'), 'utf8'), 'original');
	});

	(hasGit ? test : test.skip)('with `staged: true` un-stages a file without touching the working tree', async () => {
		const fs = await import('fs/promises');
		const dir = await initRepoWithFiles({ 'a.txt': 'original' });
		await fs.writeFile(join(dir, 'a.txt'), 'changed');
		cp.execFileSync('git', ['add', 'a.txt'], { cwd: dir, env, stdio: 'pipe' });

		await svc!.restore(URI.file(dir), ['a.txt'], { staged: true });

		const stagedDiff = cp.execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, env, encoding: 'utf8' }).trim();
		const workingTree = await fs.readFile(join(dir, 'a.txt'), 'utf8');
		assert.deepStrictEqual({ stagedDiff, workingTree }, { stagedDiff: '', workingTree: 'changed' });
	});

	(hasGit ? test : test.skip)('with `ref` restores content from a specific commit', async () => {
		const fs = await import('fs/promises');
		const dir = await initRepoWithFiles({ 'a.txt': 'v1' });
		const v1Sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
		await fs.writeFile(join(dir, 'a.txt'), 'v2');
		cp.execFileSync('git', ['commit', '-q', '-am', 'v2'], { cwd: dir, env, stdio: 'pipe' });

		await svc!.restore(URI.file(dir), ['a.txt'], { ref: v1Sha });

		assert.strictEqual(await fs.readFile(join(dir, 'a.txt'), 'utf8'), 'v1');
	});

	(hasGit ? test : test.skip)('with no paths restores every modified file in the working tree', async () => {
		const fs = await import('fs/promises');
		const dir = await initRepoWithFiles({ 'a.txt': 'one', 'b.txt': 'two' });
		await fs.writeFile(join(dir, 'a.txt'), 'mutated-a');
		await fs.writeFile(join(dir, 'b.txt'), 'mutated-b');

		await svc!.restore(URI.file(dir), []);

		const [a, b] = await Promise.all([
			fs.readFile(join(dir, 'a.txt'), 'utf8'),
			fs.readFile(join(dir, 'b.txt'), 'utf8'),
		]);
		assert.deepStrictEqual({ a, b }, { a: 'one', b: 'two' });
	});

	(hasGit ? test : test.skip)('rejects when run against a non-git directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-restore-'));
		tmpRoot = dir;
		await assert.rejects(() => svc!.restore(URI.file(dir), ['a.txt']));
	});
});

suite('AgentHostGitService - overlayPathIntoTree (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

	setup(() => {
		tmpRoot = undefined;
		svc = createGitService(disposables);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	async function initRepoWithFiles(files: Record<string, string>): Promise<{ dir: string; run: (...args: string[]) => Buffer }> {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-overlay-'));
		const fs = await import('fs/promises');
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', 'main');
		for (const [name, content] of Object.entries(files)) {
			await fs.writeFile(join(tmpRoot!, name), content);
		}
		run('add', '.');
		run('commit', '-q', '-m', 'init');
		return { dir: tmpRoot!, run };
	}

	const headTree = (dir: string) => cp.execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, env, encoding: 'utf8' }).trim();
	const lsTree = (dir: string, tree: string) => cp.execFileSync('git', ['ls-tree', '-r', '--name-only', tree], { cwd: dir, env, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
	const blobAt = (dir: string, tree: string, path: string) => cp.execFileSync('git', ['cat-file', 'blob', `${tree}:${path}`], { cwd: dir, env, encoding: 'utf8' });

	(hasGit ? test : test.skip)('overlays a modified path from the source tree, leaving other paths untouched', async () => {
		const fs = await import('fs/promises');
		const { dir } = await initRepoWithFiles({ 'a.txt': 'a-v1\n', 'b.txt': 'b-v1\n' });
		const base = headTree(dir);

		// Working tree modifies a.txt only; capture it as the source tree.
		await fs.writeFile(join(dir, 'a.txt'), 'a-v2\n');
		const source = await svc!.captureWorkingTreeAsTree(URI.file(dir));
		assert.ok(source, 'expected a working-tree snapshot');

		const result = await svc!.overlayPathIntoTree(URI.file(dir), base, 'a.txt', source!);
		assert.ok(result, 'expected a result tree');

		assert.deepStrictEqual(
			{
				files: lsTree(dir, result!),
				aContent: blobAt(dir, result!, 'a.txt'),
				bContent: blobAt(dir, result!, 'b.txt'),
			},
			{
				files: ['a.txt', 'b.txt'],
				aContent: 'a-v2\n', // overlaid from the source tree
				bContent: 'b-v1\n', // copied verbatim from the base tree
			});
	});

	(hasGit ? test : test.skip)('overlays an added path from the source tree', async () => {
		const fs = await import('fs/promises');
		const { dir } = await initRepoWithFiles({ 'a.txt': 'a-v1\n' });
		const base = headTree(dir);

		// Working tree adds an untracked file; capture it as the source tree.
		await fs.writeFile(join(dir, 'fresh.txt'), 'fresh\n');
		const source = await svc!.captureWorkingTreeAsTree(URI.file(dir));
		assert.ok(source, 'expected a working-tree snapshot');

		const result = await svc!.overlayPathIntoTree(URI.file(dir), base, 'fresh.txt', source!);
		assert.ok(result, 'expected a result tree');

		assert.deepStrictEqual(
			{ files: lsTree(dir, result!), freshContent: blobAt(dir, result!, 'fresh.txt') },
			{ files: ['a.txt', 'fresh.txt'], freshContent: 'fresh\n' });
	});

	(hasGit ? test : test.skip)('removes a path absent from the source tree', async () => {
		const fs = await import('fs/promises');
		const { dir } = await initRepoWithFiles({ 'a.txt': 'a-v1\n', 'b.txt': 'b-v1\n' });

		// Base = working tree that includes an untracked file; source = HEAD tree
		// (which lacks it). Overlaying that path removes it from the base.
		await fs.writeFile(join(dir, 'fresh.txt'), 'fresh\n');
		const base = await svc!.captureWorkingTreeAsTree(URI.file(dir));
		assert.ok(base, 'expected a working-tree snapshot');
		const source = headTree(dir);

		const result = await svc!.overlayPathIntoTree(URI.file(dir), base!, 'fresh.txt', source);
		assert.ok(result, 'expected a result tree');

		assert.deepStrictEqual(lsTree(dir, result!), ['a.txt', 'b.txt']);
	});

	(hasGit ? test : test.skip)('returns undefined for a non-git directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-overlay-'));
		tmpRoot = dir;
		const result = await svc!.overlayPathIntoTree(URI.file(dir), 'HEAD', 'a.txt', 'HEAD');
		assert.strictEqual(result, undefined);
	});
});

suite('AgentHostGitService - resolveBranchBaselineCommit (real git)', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hasGit = (() => {
		try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
	})();

	let tmpRoot: string | undefined;
	let svc: AgentHostGitService | undefined;
	const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

	setup(() => {
		tmpRoot = undefined;
		svc = createGitService(disposables);
	});

	teardown(() => {
		rmDirWithRetry(tmpRoot);
	});

	function initRepo(): (...args: string[]) => Buffer {
		tmpRoot = mkdtempSync(join(tmpdir(), 'agent-host-git-baseline-'));
		const run = (...args: string[]) => cp.execFileSync('git', args, { cwd: tmpRoot!, env, stdio: 'pipe' });
		run('init', '-q', '-b', 'main');
		return run;
	}

	(hasGit ? test : test.skip)('returns the merge-base of HEAD and the base branch', async () => {
		const fs = await import('fs/promises');
		const run = initRepo();
		await fs.writeFile(join(tmpRoot!, 'a.txt'), 'base\n');
		run('add', '.');
		run('commit', '-q', '-m', 'base');
		const baseCommit = run('rev-parse', 'HEAD').toString().trim();

		// Diverge onto a feature branch with an extra commit.
		run('checkout', '-q', '-b', 'feature');
		await fs.writeFile(join(tmpRoot!, 'a.txt'), 'feature\n');
		run('commit', '-q', '-am', 'feature');

		const result = await svc!.resolveBranchBaselineCommit(URI.file(tmpRoot!), 'main');
		assert.strictEqual(result, baseCommit);
	});

	(hasGit ? test : test.skip)('falls back to HEAD when no base branch is given', async () => {
		const fs = await import('fs/promises');
		const run = initRepo();
		await fs.writeFile(join(tmpRoot!, 'a.txt'), 'base\n');
		run('add', '.');
		run('commit', '-q', '-m', 'base');
		const headCommit = run('rev-parse', 'HEAD').toString().trim();

		const result = await svc!.resolveBranchBaselineCommit(URI.file(tmpRoot!));
		assert.strictEqual(result, headCommit);
	});

	(hasGit ? test : test.skip)('falls back to the empty tree for a repo with no commits', async () => {
		initRepo();
		const result = await svc!.resolveBranchBaselineCommit(URI.file(tmpRoot!));
		assert.strictEqual(result, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
	});

	(hasGit ? test : test.skip)('returns undefined for a non-git directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-host-nongit-baseline-'));
		tmpRoot = dir;
		const result = await svc!.resolveBranchBaselineCommit(URI.file(dir), 'main');
		assert.strictEqual(result, undefined);
	});
});
