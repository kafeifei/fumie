/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { GitRefType, IAgentHostGitService, type IAddWorktreeOptions } from '../../../common/agentHostGitService.js';
import { AgentHostFumieHomeEnvVar } from '../../../common/agentHostProductEnv.js';
import { SessionConfigKey } from '../../../common/sessionConfigKeys.js';
import { AH_META_IS_ARCHIVED_DB_KEY, AH_META_IS_DONE_DB_KEY, MessageKind, ResponsePartKind, TurnState, type Turn } from '../../../common/state/sessionState.js';
import { AgentBranchNameGenerator, IAgentBranchNameGenerator } from '../../../node/shared/agentBranchNameGenerator.js';
import { ICopilotApiService } from '../../../node/shared/copilotApiService.js';
import { buildWorktreeFailureNotification, normalizeWorktreeFailureDiagnostic, SessionWorkingDirectoryMissingError, WorktreeArchiveChangesConfirmationRequiredError, WorktreeArchiveUnrecoverableError, WorktreeIsolation, getWorktreeArchiveRef, getWorktreeName, getWorktreesRoot } from '../../../node/shared/worktreeIsolation.js';
import { FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR, WorktreeDiskBudgetExceededError } from '../../../node/worktree/worktreeDiskBudget.js';
import { getManagedWorktreePath, getManagedWorktreeRepositoryRoot } from '../../../node/worktree/worktreePaths.js';
import { TestSessionDatabase, createNoopGitService, createSessionDataService } from '../../common/sessionTestHelpers.js';

/**
 * Minimal {@link ICopilotApiService} stub for constructing {@link WorktreeIsolation}
 * in tests. Tests inject their own branch-name generator, so its methods are never called.
 */
function createNullCopilotApiService(): ICopilotApiService {
	return {
		_serviceBrand: undefined,
		messages: (..._args: unknown[]): never => { throw new Error('not implemented'); },
		countTokens: async () => { throw new Error('not implemented'); },
		models: async () => [],
		responses: async () => { throw new Error('not implemented'); },
		utilityChatCompletion: async () => { throw new Error('not implemented'); },
		resolveRestrictedTelemetryContext: async () => { throw new Error('not implemented'); },
		resolveApiEndpoint: async () => undefined,
	};
}

suite('WorktreeIsolation', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let repoRoot: URI;
	let worktreesRoot: URI;
	let db: TestSessionDatabase;
	let addWorktreeCalls: IAddWorktreeOptions[];
	let addExistingCalls: { worktree: URI; branchName: string }[];
	let removeCalls: { worktree: URI; force: boolean }[];
	let deleteBranchCalls: { repositoryRoot: URI; branchName: string; force: boolean }[];
	let archiveRefCommit: string | undefined;
	let archiveIndexTree: string | undefined;
	let archiveTree: string | undefined;
	let archiveRestoreCalls: string[];
	let copyIncludeCalls: { repositoryRoot: URI; worktree: URI; globs: readonly string[] }[];
	let copyIncludeError: Error | undefined;
	let branchName: string;
	let hasUncommittedChanges: boolean;
	let branchExists: boolean;
	let headCommit: string | undefined;

	const sessionUri = URI.parse('agent-session://test/s1');
	const sessionId = 's1';

	function createGitService(): IAgentHostGitService {
		return {
			...createNoopGitService(),
			getRepositoryRoot: async () => repoRoot,
			getWorktreeRoots: async workingDirectory => existsSync(workingDirectory.fsPath) ? [
				repoRoot,
				...addWorktreeCalls.map(call => call.path).filter(worktree => existsSync(worktree.fsPath)),
				...addExistingCalls.map(call => call.worktree).filter(worktree => existsSync(worktree.fsPath)),
			] : [],
			revParse: async (_root, expr) => {
				const archiveRef = getWorktreeArchiveRef(sessionId);
				if (expr === 'HEAD' || expr.startsWith('refs/heads/')) {
					return headCommit;
				}
				if (expr === archiveRef) {
					return archiveRefCommit;
				}
				if (expr === `${archiveRef}^` || expr === `${archiveRef}^1`) {
					return archiveRefCommit ? headCommit : undefined;
				}
				if (expr === `${archiveRef}^1^{tree}`) {
					return archiveRefCommit ? 'base-tree' : undefined;
				}
				if (expr === `${archiveRef}^2^{tree}`) {
					return archiveRefCommit ? archiveIndexTree : undefined;
				}
				if (expr === `${archiveRef}^{tree}`) {
					return archiveRefCommit ? archiveTree : undefined;
				}
				return undefined;
			},
			getCurrentBranch: async () => 'feature',
			getCurrentBranchName: async workingDirectory =>
				addExistingCalls.find(call => call.worktree.toString() === workingDirectory.toString())?.branchName
				?? addWorktreeCalls.find(call => call.path.toString() === workingDirectory.toString())?.newBranchName
				?? addWorktreeCalls.find(call => call.path.toString() === workingDirectory.toString())?.commitish
				?? 'feature',
			getDefaultBranch: async () => ({ name: 'main', startPoint: 'main' }),
			getBranches: async () => [
				{ ref: 'refs/heads/main', name: 'main', kind: GitRefType.Head },
				{ ref: 'refs/heads/feature', name: 'feature', kind: GitRefType.Head },
			],
			branchExists: async () => branchExists,
			hasUncommittedChanges: async () => hasUncommittedChanges,
			captureWorktreeArchiveSnapshot: async () => ({
				baseCommit: headCommit!,
				baseTreeOid: 'base-tree',
				indexTreeOid: hasUncommittedChanges ? archiveIndexTree ?? 'index-tree' : 'base-tree',
				workingTreeOid: hasUncommittedChanges ? archiveTree ?? 'archive-tree' : 'base-tree',
			}),
			commitTree: async (_repositoryRoot, treeOid, _parents, message) => {
				if (message.includes('index')) {
					archiveIndexTree = treeOid;
					return 'archive-index-commit';
				}
				archiveTree = treeOid;
				return 'archive-commit';
			},
			commitTreeWithParents: async (_repositoryRoot, treeOid) => {
				archiveTree = treeOid;
				return 'archive-commit';
			},
			updateRef: async (_repositoryRoot, _ref, oid) => { archiveRefCommit = oid; },
			deleteRefs: async (_repositoryRoot, refs) => {
				if (refs.includes(getWorktreeArchiveRef(sessionId))) {
					archiveRefCommit = undefined;
					archiveIndexTree = undefined;
					archiveTree = undefined;
				}
			},
			applyWorktreeArchiveStash: async (_workingDirectory, ref) => {
				archiveRestoreCalls.push(ref);
			},
			restore: async (_workingDirectory, _paths, options) => {
				if (options?.ref) {
					archiveRestoreCalls.push(options.ref);
				}
			},
			addWorktree: async (_root, options) => {
				addWorktreeCalls.push(options);
				mkdirSync(options.path.fsPath, { recursive: true });
			},
			copyWorktreeIncludeFiles: async (repositoryRoot, worktree, globs) => {
				copyIncludeCalls.push({ repositoryRoot, worktree, globs: [...globs] });
				if (copyIncludeError) {
					throw copyIncludeError;
				}
			},
			addExistingWorktree: async (_root, worktree, branch) => {
				addExistingCalls.push({ worktree, branchName: branch });
				mkdirSync(worktree.fsPath, { recursive: true });
			},
			removeWorktree: async (_root, worktree, options) => {
				removeCalls.push({ worktree, force: options?.force === true });
				rmSync(worktree.fsPath, { recursive: true, force: true });
			},
			deleteBranch: async (repositoryRoot, candidate, options) => {
				deleteBranchCalls.push({ repositoryRoot, branchName: candidate, force: options?.force === true });
				branchExists = false;
			},
		};
	}

	function createIsolation(disposableStore: Pick<DisposableStore, 'add'>, options?: { readonly branchNameGenerator?: IAgentBranchNameGenerator; readonly gitService?: IAgentHostGitService }): WorktreeIsolation {
		const branchNameGenerator = options?.branchNameGenerator ?? {
			generateBranchName: async () => branchName,
		};
		return disposableStore.add(new WorktreeIsolation(
			branchNameGenerator,
			options?.gitService ?? createGitService(),
			createNullCopilotApiService(),
			createSessionDataService(db),
			new NullLogService(),
		));
	}

	setup(() => {
		repoRoot = URI.file(mkdtempSync(join(tmpdir(), 'wt-iso-')));
		worktreesRoot = getWorktreesRoot(repoRoot);
		db = new TestSessionDatabase();
		addWorktreeCalls = [];
		addExistingCalls = [];
		removeCalls = [];
		deleteBranchCalls = [];
		archiveRefCommit = undefined;
		archiveIndexTree = undefined;
		archiveTree = undefined;
		archiveRestoreCalls = [];
		copyIncludeCalls = [];
		copyIncludeError = undefined;
		branchName = 'agents/my-feature';
		hasUncommittedChanges = false;
		branchExists = true;
		headCommit = 'abc123';
	});

	teardown(() => {
		rmSync(repoRoot.fsPath, { recursive: true, force: true });
		rmSync(worktreesRoot.fsPath, { recursive: true, force: true });
	});

	test('getWorktreesRoot / getWorktreeName derive legacy and Fumie-home paths and strip the agents/ prefix', () => {
		assert.deepStrictEqual({
			root: getWorktreesRoot(URI.file('/src/vscode')).fsPath,
			fumieRoot: getWorktreesRoot(URI.file('/src/vscode'), URI.file('/home/user/.fumie')).fsPath,
			named: getWorktreeName('agents/add-config'),
			namedFlattened: getWorktreeName('agents/feature/sub-topic'),
			namedNoPrefix: getWorktreeName('plain-branch'),
			namedWithBranchPrefix: getWorktreeName('users/alice/agents/add-config', 'users/alice/'),
		}, {
			root: URI.file('/src/vscode.worktrees').fsPath,
			fumieRoot: URI.file('/home/user/.fumie/worktrees/vscode').fsPath,
			named: 'add-config',
			namedFlattened: 'feature-sub-topic',
			namedNoPrefix: 'plain-branch',
			namedWithBranchPrefix: 'add-config',
		});
	});

	test('resolveIsolationConfig advertises folder/worktree + branch based on git state', async () => {
		const isolation = createIsolation(disposables);

		const noRepo = await isolation.resolveIsolationConfig({ workingDirectory: undefined, config: undefined });
		const repoWorktree = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: undefined });
		const repoWorktreeSelected = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'feature' } });
		const repoFolder = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'folder' } });
		const repoFolderSelected = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'folder', [SessionConfigKey.Branch]: 'main' } });
		headCommit = undefined; // unborn HEAD (no commits)
		const noCommits = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: undefined });

		assert.deepStrictEqual({
			noRepo: { enum: noRepo.isolationProperty.protocol.enum, value: noRepo.isolationValue, branch: noRepo.branchProperty, prefix: noRepo.worktreeBranchPrefixProperty, includeFiles: noRepo.worktreeIncludeFilesProperty, branchTrack: noRepo.worktreeBranchTrackProperty, createNewBranch: noRepo.worktreeCreateNewBranchProperty },
			repoWorktree: { enum: repoWorktree.isolationProperty.protocol.enum, value: repoWorktree.isolationValue, branchDefault: repoWorktree.branchDefault, branchReadOnly: repoWorktree.branchProperty?.protocol.readOnly, prefixReadOnly: repoWorktree.worktreeBranchPrefixProperty?.protocol.readOnly, includeFilesReadOnly: repoWorktree.worktreeIncludeFilesProperty?.protocol.readOnly, branchTrackReadOnly: repoWorktree.worktreeBranchTrackProperty?.protocol.readOnly, createNewBranchReadOnly: repoWorktree.worktreeCreateNewBranchProperty?.protocol.readOnly },
			repoWorktreeSelected: { branchDefault: repoWorktreeSelected.branchDefault, branchValue: repoWorktreeSelected.branchValue, branchEnum: repoWorktreeSelected.branchProperty?.protocol.enum },
			repoFolder: { value: repoFolder.isolationValue, branchDefault: repoFolder.branchDefault, branchReadOnly: repoFolder.branchProperty?.protocol.readOnly, hasPrefix: !!repoFolder.worktreeBranchPrefixProperty, hasIncludeFiles: !!repoFolder.worktreeIncludeFilesProperty, hasBranchTrack: !!repoFolder.worktreeBranchTrackProperty, hasCreateNewBranch: !!repoFolder.worktreeCreateNewBranchProperty },
			repoFolderSelected: { branchValue: repoFolderSelected.branchValue, branchDynamic: repoFolderSelected.branchProperty?.protocol.enumDynamic },
			noCommits: { enum: noCommits.isolationProperty.protocol.enum, value: noCommits.isolationValue, branch: noCommits.branchProperty, prefix: noCommits.worktreeBranchPrefixProperty, includeFiles: noCommits.worktreeIncludeFilesProperty, branchTrack: noCommits.worktreeBranchTrackProperty, createNewBranch: noCommits.worktreeCreateNewBranchProperty },
		}, {
			noRepo: { enum: ['folder'], value: 'folder', branch: undefined, prefix: undefined, includeFiles: undefined, branchTrack: undefined, createNewBranch: undefined },
			repoWorktree: { enum: ['folder', 'worktree'], value: 'worktree', branchDefault: 'main', branchReadOnly: false, prefixReadOnly: true, includeFilesReadOnly: true, branchTrackReadOnly: true, createNewBranchReadOnly: true },
			repoWorktreeSelected: { branchDefault: 'main', branchValue: 'feature', branchEnum: ['main'] },
			repoFolder: { value: 'folder', branchDefault: 'feature', branchReadOnly: false, hasPrefix: true, hasIncludeFiles: true, hasBranchTrack: true, hasCreateNewBranch: true },
			repoFolderSelected: { branchValue: 'main', branchDynamic: true },
			noCommits: { enum: ['folder'], value: 'folder', branch: undefined, prefix: undefined, includeFiles: undefined, branchTrack: undefined, createNewBranch: undefined },
		});
	});

	test('branchCompletions returns current then default then recent git branches, empty without a working directory', async () => {
		const isolation = createIsolation(disposables);
		assert.deepStrictEqual({
			withDir: await isolation.branchCompletions(repoRoot),
			noDir: await isolation.branchCompletions(undefined),
		}, {
			withDir: { items: [{ value: 'feature', label: 'feature' }, { value: 'main', label: 'main' }] },
			noDir: { items: [] },
		});
	});

	test('uses the local default branch name in config and its remote ref as the worktree start point', async () => {
		const gitService = createGitService();
		gitService.getDefaultBranch = async () => ({ name: 'main', startPoint: 'origin/main' });
		const isolation = createIsolation(disposables, { gitService });

		const config = await isolation.resolveIsolationConfig({ workingDirectory: repoRoot, config: undefined });
		await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
			},
			prompt: 'do a thing',
		});

		assert.deepStrictEqual({
			branchDefault: config.branchDefault,
			branchEnum: config.branchProperty?.protocol.enum,
			startPoint: addWorktreeCalls[0]?.commitish,
		}, {
			branchDefault: 'main',
			branchEnum: ['main'],
			startPoint: 'origin/main',
		});
	});

	test('checks out an existing selected branch and uses the default branch as the diff base', async () => {
		const gitService = createGitService();
		gitService.getDefaultBranch = async () => ({ name: 'main', startPoint: 'origin/main' });
		const isolation = createIsolation(disposables, {
			gitService,
			branchNameGenerator: { generateBranchName: async () => { throw new Error('should not generate a branch'); } },
		});

		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'feature',
				[SessionConfigKey.WorktreeBranchTrack]: true,
				[SessionConfigKey.WorktreeCreateNewBranch]: false,
			},
		});

		assert.deepStrictEqual({
			worktree: worktree?.toString(),
			addWorktreeArgs: addWorktreeCalls.map(call => ({
				commitish: call.commitish,
				newBranchName: call.newBranchName,
				track: call.track,
				preferRemoteBranch: call.preferRemoteBranch,
			})),
			branchName: await db.getMetadata('copilot.worktree.branchName'),
			diffBaseBranch: await db.getMetadata('agentHost.diffBaseBranch'),
		}, {
			worktree: URI.joinPath(worktreesRoot, 'feature').toString(),
			addWorktreeArgs: [{
				commitish: 'feature',
				newBranchName: undefined,
				track: true,
				preferRemoteBranch: false,
			}],
			branchName: 'feature',
			diffBaseBranch: 'origin/main',
		});
	});

	test('resolveWorkingDirectory creates a worktree, persists metadata, queues the announcement, and is idempotent', async () => {
		const isolation = createIsolation(disposables);
		const config = { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' };

		const first = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config, prompt: 'do a thing' });
		const meta = await isolation.readWorktreeMetadata(sessionUri);
		const announcement = isolation.takePendingAnnouncement(sessionId);
		const second = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config, prompt: 'do a thing' });

		const expectedWorktree = URI.joinPath(worktreesRoot, getWorktreeName(branchName));
		assert.deepStrictEqual({
			returnedWorktree: first!.toString(),
			addWorktreeCallCount: addWorktreeCalls.length,
			addWorktreeArgs: addWorktreeCalls.map(c => ({ worktree: c.path.toString(), branchName: c.newBranchName, startPoint: c.commitish })),
			metaBranch: meta?.branchName,
			metaWorktree: meta?.worktreePath?.toString(),
			metaRepo: meta?.repositoryRoot?.toString(),
			announcementHasBranch: announcement?.includes(branchName) ?? false,
			secondTakeAnnouncement: isolation.takePendingAnnouncement(sessionId),
			idempotentReturn: second!.toString(),
			resolvedWorktree: isolation.getResolvedWorktree(sessionId)?.toString(),
		}, {
			returnedWorktree: expectedWorktree.toString(),
			addWorktreeCallCount: 1,
			addWorktreeArgs: [{ worktree: expectedWorktree.toString(), branchName, startPoint: 'main' }],
			metaBranch: branchName,
			metaWorktree: expectedWorktree.toString(),
			metaRepo: repoRoot.toString(),
			announcementHasBranch: true,
			secondTakeAnnouncement: undefined,
			idempotentReturn: expectedWorktree.toString(),
			resolvedWorktree: expectedWorktree.toString(),
		});
	});

	test('Fumie home creates new sessions at the repository-hash/session path', async () => {
		const fumieHome = URI.file(mkdtempSync(join(tmpdir(), 'fumie-home-')));
		const previousFumieHome = process.env[AgentHostFumieHomeEnvVar];
		process.env[AgentHostFumieHomeEnvVar] = fumieHome.fsPath;
		try {
			const isolation = createIsolation(disposables);
			const worktree = await isolation.resolveWorkingDirectory({
				sessionUri,
				sessionId,
				workingDirectory: repoRoot,
				config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
				diskBudgetSessions: [{ sessionId, running: true, pinned: false }],
			});
			assert.strictEqual(worktree?.toString(), getManagedWorktreePath(fumieHome, repoRoot, sessionId).toString());
		} finally {
			if (previousFumieHome === undefined) {
				delete process.env[AgentHostFumieHomeEnvVar];
			} else {
				process.env[AgentHostFumieHomeEnvVar] = previousFumieHome;
			}
			rmSync(fumieHome.fsPath, { recursive: true, force: true });
		}
	});

	test('the configured total disk budget rejects and rolls back a new worktree that cannot fit', async () => {
		const fumieHome = URI.file(mkdtempSync(join(tmpdir(), 'fumie-budget-')));
		const previousFumieHome = process.env[AgentHostFumieHomeEnvVar];
		const previousBudget = process.env[FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR];
		process.env[AgentHostFumieHomeEnvVar] = fumieHome.fsPath;
		process.env[FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR] = '0';
		try {
			const isolation = createIsolation(disposables);
			await assert.rejects(() => isolation.resolveWorkingDirectory({
				sessionUri,
				sessionId,
				workingDirectory: repoRoot,
				config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
				diskBudgetSessions: [{ sessionId, running: true, pinned: false }],
			}), error => error instanceof WorktreeDiskBudgetExceededError);
			assert.deepStrictEqual({
				checkoutExists: existsSync(getManagedWorktreePath(fumieHome, repoRoot, sessionId).fsPath),
				repositoryDirectoryExists: existsSync(getManagedWorktreeRepositoryRoot(fumieHome, repoRoot).fsPath),
				removeCalls: removeCalls.map(call => call.force),
				deletedBranches: deleteBranchCalls.map(call => call.branchName),
				pendingWorktree: isolation.getResolvedWorktree(sessionId),
			}, {
				checkoutExists: false,
				repositoryDirectoryExists: false,
				removeCalls: [true],
				deletedBranches: [branchName],
				pendingWorktree: undefined,
			});
		} finally {
			if (previousFumieHome === undefined) {
				delete process.env[AgentHostFumieHomeEnvVar];
			} else {
				process.env[AgentHostFumieHomeEnvVar] = previousFumieHome;
			}
			if (previousBudget === undefined) {
				delete process.env[FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR];
			} else {
				process.env[FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR] = previousBudget;
			}
			rmSync(fumieHome.fsPath, { recursive: true, force: true });
		}
	});

	test('resolveOnFirstSend clears pending only after a worktree is materialized', async () => {
		const gitService = createGitService();
		const isolation = createIsolation(disposables, { gitService });
		const request = {
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
		};

		isolation.notePending(sessionId);
		gitService.getRepositoryRoot = async () => undefined;
		assert.strictEqual((await isolation.resolveOnFirstSend(request))?.toString(), repoRoot.toString());
		assert.strictEqual(isolation.isWorkingDirectoryPending(sessionId), true);

		gitService.getRepositoryRoot = async () => repoRoot;
		await isolation.resolveOnFirstSend(request);
		assert.strictEqual(isolation.isWorkingDirectoryPending(sessionId), false);
	});

	test('resolveOnFirstSend keeps pending after creation fails so the first send can retry', async () => {
		const gitService = createGitService();
		gitService.addWorktree = async () => { throw new Error('checkout failed'); };
		const isolation = createIsolation(disposables, { gitService });
		isolation.notePending(sessionId);

		await assert.rejects(() => isolation.resolveOnFirstSend({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
		}), /checkout failed/);

		assert.strictEqual(isolation.isWorkingDirectoryPending(sessionId), true);
	});

	test('resolveWorkingDirectory creates from the primary worktree while copying include files from the selected checkout', async () => {
		const checkoutRoot = URI.joinPath(repoRoot, 'linked-checkout');
		const gitService = createGitService();
		let addWorktreeRoot: URI | undefined;
		gitService.getRepositoryRoot = async () => checkoutRoot;
		gitService.getWorktreeRoots = async () => [repoRoot, checkoutRoot];
		gitService.addWorktree = async (repositoryRoot, options) => {
			addWorktreeRoot = repositoryRoot;
			addWorktreeCalls.push(options);
			mkdirSync(options.path.fsPath, { recursive: true });
		};
		const isolation = createIsolation(disposables, { gitService });
		const includeFiles = ['.env'];

		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: checkoutRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: includeFiles,
			},
		});
		const meta = await isolation.readWorktreeMetadata(sessionUri);
		const project = isolation.sessionWorktreeProject(sessionId);

		assert.deepStrictEqual({
			worktree: worktree?.toString(),
			addWorktreeRoot: addWorktreeRoot?.toString(),
			includeFileRoot: copyIncludeCalls[0]?.repositoryRoot.toString(),
			metaRepositoryRoot: meta?.repositoryRoot?.toString(),
			project: project && { uri: project.uri.toString(), displayName: project.displayName },
		}, {
			worktree: URI.joinPath(worktreesRoot, getWorktreeName(branchName)).toString(),
			addWorktreeRoot: repoRoot.toString(),
			includeFileRoot: checkoutRoot.toString(),
			metaRepositoryRoot: repoRoot.toString(),
			project: { uri: repoRoot.toString(), displayName: basename(repoRoot) },
		});
	});

	test('resolveWorkingDirectory falls back to the selected checkout when primary worktree resolution fails', async () => {
		const checkoutRoot = URI.joinPath(repoRoot, 'linked-checkout');
		const gitService = createGitService();
		gitService.getRepositoryRoot = async () => checkoutRoot;
		gitService.getWorktreeRoots = async () => { throw new Error('worktree enumeration failed'); };
		const isolation = createIsolation(disposables, { gitService });

		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: checkoutRoot,
			config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
		});
		const meta = await isolation.readWorktreeMetadata(sessionUri);
		const fallbackWorktreesRoot = getWorktreesRoot(checkoutRoot);

		assert.deepStrictEqual({
			worktree: worktree?.toString(),
			metaRepositoryRoot: meta?.repositoryRoot?.toString(),
		}, {
			worktree: URI.joinPath(fallbackWorktreesRoot, getWorktreeName(branchName)).toString(),
			metaRepositoryRoot: checkoutRoot.toString(),
		});
	});

	test('resolveWorkingDirectory names each creation phase, rounding percentages down and debouncing updates', async () => {
		const gitService = createGitService();
		gitService.addWorktree = async (_root, options) => {
			addWorktreeCalls.push(options);
			mkdirSync(options.path.fsPath, { recursive: true });
			options.onProgress?.({ filesDone: 7, filesTotal: 800 });
			options.onProgress?.({ filesDone: 96, filesTotal: 800 });
			options.onProgress?.({ filesDone: 100, filesTotal: 800 });
			await timeout(50);
			options.onProgress?.({ filesDone: 800, filesTotal: 800 });
		};
		gitService.copyWorktreeIncludeFiles = async (_root, _worktree, _globs, onProgress) => {
			onProgress?.({ filesDone: 1, filesTotal: 4 });
			onProgress?.({ filesDone: 4, filesTotal: 4 });
		};
		const isolation = createIsolation(disposables, { gitService });
		const activities: string[] = [];

		await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: ['.env'],
			},
			prompt: 'do a thing',
			onProgress: activity => activities.push(activity),
		});

		assert.deepStrictEqual(activities, [
			'Creating isolated worktree',
			'Creating isolated worktree (naming branch)',
			'Creating isolated worktree (checking out files)',
			'Creating isolated worktree (checking out files, 12%)',
			'Creating isolated worktree (checking out files, 100%)',
			'Creating isolated worktree (copying additional files)',
			'Creating isolated worktree (copying additional files, 100%)',
		]);
	});

	test('resolveWorkingDirectory avoids an existing worktree directory', async () => {
		const collisionSessionId = '12345678-aaaa-bbbb-cccc-123456789abc';
		const collisionSessionUri = URI.parse(`agent-session://test/${collisionSessionId}`);
		const existingWorktree = URI.joinPath(worktreesRoot, 'add-feature');
		mkdirSync(existingWorktree.fsPath, { recursive: true });
		branchExists = false;
		const isolation = createIsolation(disposables, {
			branchNameGenerator: new AgentBranchNameGenerator(createNullCopilotApiService(), new NullLogService()),
		});

		const resolved = await isolation.resolveWorkingDirectory({
			sessionUri: collisionSessionUri,
			sessionId: collisionSessionId,
			workingDirectory: repoRoot,
			config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
			prompt: 'Add feature',
		});

		assert.deepStrictEqual({
			branchName: addWorktreeCalls[0]?.newBranchName,
			worktree: resolved?.toString(),
		}, {
			branchName: 'agents/add-feature-12345678',
			worktree: URI.joinPath(worktreesRoot, 'add-feature-12345678').toString(),
		});
	});

	test('resolveWorkingDirectory treats a failed branch check as a collision', async () => {
		const collisionSessionId = '12345678-aaaa-bbbb-cccc-123456789abc';
		const collisionSessionUri = URI.parse(`agent-session://test/${collisionSessionId}`);
		const gitService = createGitService();
		let branchExistsCalls = 0;
		gitService.branchExists = async () => {
			if (branchExistsCalls++ === 0) {
				throw new Error('transient failure');
			}
			return false;
		};
		const isolation = createIsolation(disposables, {
			branchNameGenerator: new AgentBranchNameGenerator(createNullCopilotApiService(), new NullLogService()),
			gitService,
		});

		const resolved = await isolation.resolveWorkingDirectory({
			sessionUri: collisionSessionUri,
			sessionId: collisionSessionId,
			workingDirectory: repoRoot,
			config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
			prompt: 'Add feature',
		});

		assert.deepStrictEqual({
			branchExistsCalls,
			branchName: addWorktreeCalls[0]?.newBranchName,
			worktree: resolved?.toString(),
		}, {
			branchExistsCalls: 2,
			branchName: 'agents/add-feature-12345678',
			worktree: URI.joinPath(worktreesRoot, 'add-feature-12345678').toString(),
		});
	});

	test('resolveWorkingDirectory serializes concurrent creation in the same repository', async () => {
		const gitService = createGitService();
		const checkoutRootA = URI.joinPath(repoRoot, 'linked-checkout-a');
		const checkoutRootB = URI.joinPath(repoRoot, 'linked-checkout-b');
		const existingBranches = new Set<string>();
		let activeAddWorktrees = 0;
		let maxActiveAddWorktrees = 0;
		gitService.getRepositoryRoot = async workingDirectory => workingDirectory;
		gitService.getWorktreeRoots = async () => [repoRoot, checkoutRootA, checkoutRootB];
		gitService.branchExists = async (_repositoryRoot, candidate) => existingBranches.has(candidate);
		gitService.addWorktree = async (_repositoryRoot, options) => {
			activeAddWorktrees++;
			maxActiveAddWorktrees = Math.max(maxActiveAddWorktrees, activeAddWorktrees);
			await timeout(10);
			addWorktreeCalls.push(options);
			if (options.newBranchName) {
				existingBranches.add(options.newBranchName);
			}
			mkdirSync(options.path.fsPath, { recursive: true });
			activeAddWorktrees--;
		};
		const isolation = createIsolation(disposables, {
			branchNameGenerator: new AgentBranchNameGenerator(createNullCopilotApiService(), new NullLogService()),
			gitService,
		});
		const config = { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' };

		const worktrees = await Promise.all([
			isolation.resolveWorkingDirectory({ sessionUri: URI.parse('agent-session://test/12345678-aaaa-bbbb-cccc-123456789abc'), sessionId: '12345678-aaaa-bbbb-cccc-123456789abc', workingDirectory: checkoutRootA, config, prompt: 'Add feature' }),
			isolation.resolveWorkingDirectory({ sessionUri: URI.parse('agent-session://test/87654321-aaaa-bbbb-cccc-123456789abc'), sessionId: '87654321-aaaa-bbbb-cccc-123456789abc', workingDirectory: checkoutRootB, config, prompt: 'Add feature' }),
		]);

		assert.deepStrictEqual({
			maxActiveAddWorktrees,
			branchNames: addWorktreeCalls.map(call => call.newBranchName),
			worktrees: worktrees.map(worktree => worktree?.toString()),
		}, {
			maxActiveAddWorktrees: 1,
			branchNames: ['agents/add-feature', 'agents/add-feature-87654321'],
			worktrees: [
				URI.joinPath(worktreesRoot, 'add-feature').toString(),
				URI.joinPath(worktreesRoot, 'add-feature-87654321').toString(),
			],
		});
	});

	test('resolveWorkingDirectory is a no-op for folder isolation or a missing branch', async () => {
		const isolation = createIsolation(disposables);

		const folder = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'folder', [SessionConfigKey.Branch]: 'main' } });
		const noBranch = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree' } });

		assert.deepStrictEqual({
			folder: folder?.toString(),
			noBranch: noBranch?.toString(),
			addWorktreeCallCount: addWorktreeCalls.length,
			resolvedWorktree: isolation.getResolvedWorktree(sessionId),
		}, {
			folder: repoRoot.toString(),
			noBranch: repoRoot.toString(),
			addWorktreeCallCount: 0,
			resolvedWorktree: undefined,
		});
	});

	test('resolveWorkingDirectory rejects include-file bootstrap failures and removes the partial worktree', async () => {
		const isolation = createIsolation(disposables);
		const includeFiles = ['.env', '.env.local', 'config/**'];
		copyIncludeError = new Error('copy failed');
		isolation.notePending(sessionId);

		await assert.rejects(() => isolation.resolveOnFirstSend({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: includeFiles,
			},
		}), /copy failed/);

		assert.deepStrictEqual({
			copyIncludeCalls: copyIncludeCalls.map(call => ({
				repositoryRoot: call.repositoryRoot.toString(),
				worktree: call.worktree.toString(),
				globs: call.globs,
			})),
			removeCalls: removeCalls.map(call => ({ worktree: call.worktree.toString(), force: call.force })),
			deleteBranchCalls: deleteBranchCalls.map(call => ({ branchName: call.branchName, force: call.force })),
			resolvedWorktree: isolation.getResolvedWorktree(sessionId),
			pending: isolation.isWorkingDirectoryPending(sessionId),
			persistedOwnership: await db.getMetadata('copilot.worktree.ownership'),
		}, {
			copyIncludeCalls: [{
				repositoryRoot: repoRoot.toString(),
				worktree: URI.joinPath(worktreesRoot, getWorktreeName(branchName)).toString(),
				globs: includeFiles,
			}],
			removeCalls: [{ worktree: URI.joinPath(worktreesRoot, getWorktreeName(branchName)).toString(), force: true }],
			deleteBranchCalls: [{ branchName, force: true }],
			resolvedWorktree: undefined,
			pending: true,
			persistedOwnership: undefined,
		});
	});

	test('resolveWorkingDirectory ignores legacy node_modules include patterns before creating a worktree', async () => {
		const isolation = createIsolation(disposables);
		await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: ['.env', '**/node_modules/**'],
			},
		});
		assert.strictEqual(addWorktreeCalls.length, 1);
		assert.deepStrictEqual(copyIncludeCalls.map(call => call.globs), [['.env']]);
		assert.deepStrictEqual(JSON.parse((await db.getMetadata('copilot.worktree.includeFiles'))!), ['.env']);
	});

	test('resolveWorkingDirectoryForResume recreates a missing live worktree and preserves an existing directory', async () => {
		const isolation = createIsolation(disposables);
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-live-worktree');
		const existingWorktree = URI.joinPath(worktreesRoot, 'existing-live-worktree');
		mkdirSync(existingWorktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
		]);

		const outcomes = {
			missingWorktreeRecreated: (await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree)).toString(),
			existingWorktreeUsedUnchanged: (await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, existingWorktree)).toString(),
			recreatedWorktrees: addExistingCalls.map(call => ({ worktree: call.worktree.toString(), branchName: call.branchName })),
		};

		assert.deepStrictEqual(outcomes, {
			missingWorktreeRecreated: missingWorktree.toString(),
			existingWorktreeUsedUnchanged: existingWorktree.toString(),
			recreatedWorktrees: [{ worktree: missingWorktree.toString(), branchName: 'feature/x' }],
		});
	});

	test('live resume recovers a private delta left after archive removal crashed before the catalog commit', async () => {
		let applied = false;
		const gitService = createGitService();
		gitService.captureWorktreeArchiveSnapshot = async () => ({
			baseCommit: headCommit!,
			baseTreeOid: 'base-tree',
			indexTreeOid: applied ? 'index-tree' : 'base-tree',
			workingTreeOid: applied ? 'archive-tree' : 'base-tree',
		});
		gitService.applyWorktreeArchiveStash = async (_workingDirectory, ref) => {
			archiveRestoreCalls.push(ref);
			applied = true;
		};
		const isolation = createIsolation(disposables, { gitService });
		const missingWorktree = URI.joinPath(worktreesRoot, 'archive-crash-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', branchName),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata('copilot.worktree.ownership', 'fumie'),
		]);
		hasUncommittedChanges = true;
		archiveIndexTree = 'index-tree';
		archiveTree = 'archive-tree';
		archiveRefCommit = 'archive-commit';

		const restored = await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree);

		assert.deepStrictEqual({
			restored: restored.toString(),
			archiveRestoreCalls,
			archiveRefCommit,
			checkoutExists: existsSync(missingWorktree.fsPath),
		}, {
			restored: missingWorktree.toString(),
			archiveRestoreCalls: [getWorktreeArchiveRef(sessionId)],
			archiveRefCommit: undefined,
			checkoutExists: true,
		});
	});

	test('resolveWorkingDirectoryForResume rejects a stale directory that Git does not register as the managed worktree', async () => {
		const isolation = createIsolation(disposables);
		const staleWorktree = URI.joinPath(worktreesRoot, 'stale-managed-worktree');
		mkdirSync(staleWorktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', staleWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata('copilot.worktree.ownership', 'fumie'),
		]);

		await assert.rejects(
			() => isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, staleWorktree),
			/Git does not register its managed worktree/,
		);
	});

	test('resolveWorkingDirectoryForResume accepts a Git-registered real path through a parent symlink alias', async () => {
		const actualParent = URI.file(mkdtempSync(join(tmpdir(), 'wt-iso-real-')));
		const aliasParent = URI.file(`${actualParent.fsPath}-alias`);
		const actualWorktree = URI.joinPath(actualParent, 'managed');
		const aliasWorktree = URI.joinPath(aliasParent, 'managed');
		mkdirSync(actualWorktree.fsPath);
		symlinkSync(actualParent.fsPath, aliasParent.fsPath, process.platform === 'win32' ? 'junction' : 'dir');
		try {
			await Promise.all([
				db.setMetadata('copilot.worktree.branchName', 'feature'),
				db.setMetadata('copilot.worktree.path', aliasWorktree.toString()),
				db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
				db.setMetadata('copilot.worktree.ownership', 'fumie'),
			]);
			const gitService = createGitService();
			gitService.getWorktreeRoots = async () => [repoRoot, actualWorktree];
			const isolation = createIsolation(disposables, { gitService });

			assert.strictEqual(
				(await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, aliasWorktree)).toString(),
				aliasWorktree.toString(),
			);
		} finally {
			unlinkSync(aliasParent.fsPath);
			rmSync(actualParent.fsPath, { recursive: true, force: true });
		}
	});

	test('resolveWorkingDirectoryForResume recreates a missing live worktree from legacy metadata', async () => {
		const isolation = createIsolation(disposables);
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-legacy-live-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.workingDirectory', missingWorktree.toString()),
		]);

		const resolved = await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree);

		assert.deepStrictEqual({
			resolved: resolved.toString(),
			recreatedWorktrees: addExistingCalls.map(call => ({ worktree: call.worktree.toString(), branchName: call.branchName })),
		}, {
			resolved: missingWorktree.toString(),
			recreatedWorktrees: [{ worktree: missingWorktree.toString(), branchName: 'feature/x' }],
		});
	});

	test('resolveWorkingDirectoryForResume uses the repository root for archived history', async () => {
		const isolation = createIsolation(disposables);
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-archived-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata(AH_META_IS_ARCHIVED_DB_KEY, 'true'),
		]);

		const resolved = await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree);

		assert.deepStrictEqual({ resolved: resolved.toString(), worktreesRecreated: addExistingCalls.length }, {
			resolved: repoRoot.toString(),
			worktreesRecreated: 0,
		});
	});

	test('resolveWorkingDirectoryForResume falls back to legacy isDone archived metadata', async () => {
		const isolation = createIsolation(disposables);
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-legacy-archived-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata(AH_META_IS_DONE_DB_KEY, 'true'),
		]);

		const resolved = await isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree);

		assert.strictEqual(resolved.toString(), repoRoot.toString());
	});

	test('resolveWorkingDirectoryForResume reports a missing preserved branch', async () => {
		const isolation = createIsolation(disposables);
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-branch-worktree');
		branchExists = false;
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
		]);

		await assert.rejects(
			() => isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree),
			(error: Error) => error instanceof SessionWorkingDirectoryMissingError
				&& error.reason !== undefined
				&& /branch 'feature\/x' no longer exists/.test(error.message),
		);
		assert.strictEqual(addExistingCalls.length, 0);
	});

	test('resolveWorkingDirectoryForResume reports a missing live directory without worktree metadata', async () => {
		const isolation = createIsolation(disposables);
		const missingDirectory = URI.joinPath(repoRoot, 'missing-directory');

		await assert.rejects(
			() => isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingDirectory),
			(error: Error) => error instanceof SessionWorkingDirectoryMissingError,
		);
	});

	test('resolveWorkingDirectoryForResume reports an archived session when its repository root is also missing', async () => {
		const isolation = createIsolation(disposables);
		const missingRepositoryRoot = URI.joinPath(repoRoot, 'missing-repository');
		const missingWorktree = URI.joinPath(worktreesRoot, 'missing-archived-no-root-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', missingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', missingRepositoryRoot.toString()),
			db.setMetadata(AH_META_IS_ARCHIVED_DB_KEY, 'true'),
		]);

		await assert.rejects(
			() => isolation.resolveWorkingDirectoryForResume(sessionUri, sessionId, missingWorktree),
			(error: Error) => error instanceof SessionWorkingDirectoryMissingError,
		);
	});

	test('resolveWorktreeProject / sessionWorktreeProject expose the repository as the session project', async () => {
		// The worktree lives at `<repo>.worktrees/<name>`, but a worktree session
		// must group under the repository in the sessions UI. Both accessors return
		// the repo root as the project so agents can merge it into the reported
		// `IAgentSessionMetadata` / materialize event. Folder (non-worktree)
		// sessions have no worktree metadata and get `undefined`.
		const isolation = createIsolation(disposables);
		const expectedDisplayName = basename(repoRoot);

		const beforeAsync = await isolation.resolveWorktreeProject(sessionUri);
		const beforeSync = isolation.sessionWorktreeProject(sessionId);

		await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		const afterAsync = await isolation.resolveWorktreeProject(sessionUri);
		const afterSync = isolation.sessionWorktreeProject(sessionId);

		assert.deepStrictEqual({
			beforeAsync,
			beforeSync,
			afterAsync: { uri: afterAsync?.uri.toString(), displayName: afterAsync?.displayName },
			afterSync: { uri: afterSync?.uri.toString(), displayName: afterSync?.displayName },
			unknownSession: isolation.sessionWorktreeProject('does-not-exist'),
		}, {
			beforeAsync: undefined,
			beforeSync: undefined,
			afterAsync: { uri: repoRoot.toString(), displayName: expectedDisplayName },
			afterSync: { uri: repoRoot.toString(), displayName: expectedDisplayName },
			unknownSession: undefined,
		});
	});

	test('resolveWorktreeProject normalizes persisted linked-checkout metadata', async () => {
		const checkoutRoot = URI.joinPath(repoRoot, 'linked-checkout');
		const existingWorktree = URI.joinPath(repoRoot, 'existing-worktree');
		mkdirSync(existingWorktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', existingWorktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', checkoutRoot.toString()),
		]);
		const gitService = createGitService();
		let resolvedFrom: URI | undefined;
		let resolutionCount = 0;
		gitService.getWorktreeRoots = async workingDirectory => {
			resolvedFrom = workingDirectory;
			resolutionCount++;
			return [repoRoot, checkoutRoot, existingWorktree];
		};
		const isolation = createIsolation(disposables, { gitService });

		const project = await isolation.resolveWorktreeProject(sessionUri);
		await isolation.resolveWorktreeProject(sessionUri);

		assert.deepStrictEqual({
			resolutionCount,
			resolvedFrom: resolvedFrom?.toString(),
			project: project && { uri: project.uri.toString(), displayName: project.displayName },
			persistedRepositoryRoot: await db.getMetadata('copilot.worktree.repositoryRoot'),
		}, {
			resolutionCount: 1,
			resolvedFrom: existingWorktree.toString(),
			project: { uri: repoRoot.toString(), displayName: basename(repoRoot) },
			persistedRepositoryRoot: repoRoot.toString(),
		});
	});

	test('adoptExistingWorktreeMetadata bridges a linked worktree into worktree metadata', async () => {
		const worktreeCheckout = URI.joinPath(worktreesRoot, 'adopted');
		const gitService = createGitService();
		gitService.getRepositoryRoot = async () => worktreeCheckout;
		gitService.getWorktreeRoots = async () => [repoRoot, worktreeCheckout];
		gitService.getCurrentBranch = async () => 'agents/adopted';
		gitService.getDefaultBranch = async () => ({ name: 'main', startPoint: 'main' });
		const isolation = createIsolation(disposables, { gitService });

		const recorded = await isolation.adoptExistingWorktreeMetadata(sessionUri, worktreeCheckout);
		const project = await isolation.resolveWorktreeProject(sessionUri);

		assert.deepStrictEqual({
			recorded,
			branchName: await db.getMetadata('copilot.worktree.branchName'),
			path: await db.getMetadata('copilot.worktree.path'),
			repositoryRoot: await db.getMetadata('copilot.worktree.repositoryRoot'),
			diffBaseBranch: await db.getMetadata('agentHost.diffBaseBranch'),
			project: project && { uri: project.uri.toString(), displayName: project.displayName },
		}, {
			recorded: true,
			branchName: 'agents/adopted',
			path: worktreeCheckout.toString(),
			repositoryRoot: repoRoot.toString(),
			diffBaseBranch: 'main',
			project: { uri: repoRoot.toString(), displayName: basename(repoRoot) },
		});
	});

	test('adoptExistingWorktreeMetadata is a no-op for a primary checkout', async () => {
		const gitService = createGitService();
		gitService.getRepositoryRoot = async () => repoRoot;
		gitService.getWorktreeRoots = async () => [repoRoot];
		const isolation = createIsolation(disposables, { gitService });

		const recorded = await isolation.adoptExistingWorktreeMetadata(sessionUri, repoRoot);

		assert.deepStrictEqual({
			recorded,
			branchName: await db.getMetadata('copilot.worktree.branchName'),
			repositoryRoot: await db.getMetadata('copilot.worktree.repositoryRoot'),
		}, {
			recorded: false,
			branchName: undefined,
			repositoryRoot: undefined,
		});
	});

	test('applyRestoreAnnouncement prepends a markdown part when worktree metadata exists', async () => {
		const isolation = createIsolation(disposables);
		const turn: Turn = {
			id: 't1',
			message: { text: 'hi', origin: { kind: MessageKind.User } },
			responseParts: [],
			usage: undefined,
			state: TurnState.Complete,
		};

		const withoutMeta = await isolation.applyRestoreAnnouncement(sessionUri, [turn]);
		await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		const withMeta = await isolation.applyRestoreAnnouncement(sessionUri, [turn]);
		const firstPart = withMeta[0].responseParts[0];

		assert.deepStrictEqual({
			unchangedWhenNoMeta: withoutMeta[0].responseParts.length,
			firstPartKind: firstPart?.kind,
			firstPartHasBranch: firstPart?.kind === ResponsePartKind.Markdown ? firstPart.content.includes(branchName) : false,
		}, {
			unchangedWhenNoMeta: 0,
			firstPartKind: ResponsePartKind.Markdown,
			firstPartHasBranch: true,
		});
	});

	test('worktree failure notification bounds and escapes diagnostics', () => {
		const diagnostic = `git-lfs \`filter\`\n${'x'.repeat(250)}`;
		const notification = buildWorktreeFailureNotification(diagnostic);

		assert.deepStrictEqual({
			normalizedLength: normalizeWorktreeFailureDiagnostic(diagnostic)?.length,
			kind: notification.kind,
			content: notification.content,
			meta: notification._meta,
		}, {
			normalizedLength: 200,
			kind: ResponsePartKind.SystemNotification,
			content: `Couldn't create the isolated worktree. This session hasn't started; retry to try again.\n\n\`\`git-lfs \`filter\` ${'x'.repeat(180)}...\`\``,
			meta: { kind: 'worktreeCreationFailure', severity: 'warning' },
		});
	});

	test('applyRestoreAnnouncement restores a worktree failure only for its originating session', async () => {
		const isolation = createIsolation(disposables);
		const turn: Turn = {
			id: 't1',
			message: { text: 'hi', origin: { kind: MessageKind.User } },
			responseParts: [],
			usage: undefined,
			state: TurnState.Complete,
		};
		await isolation.persistCreationFailure(sessionUri, sessionId, 'git worktree exited with code 128');

		const matching = await isolation.applyRestoreAnnouncement(sessionUri, [turn]);
		const copied = await isolation.applyRestoreAnnouncement(URI.parse('agent-session://test/copied'), [turn]);
		const empty = await isolation.applyRestoreAnnouncement(sessionUri, []);

		assert.deepStrictEqual({
			matching: matching[0].responseParts[0],
			copiedPartCount: copied[0].responseParts.length,
			emptyTurnCount: empty.length,
		}, {
			matching: {
				kind: ResponsePartKind.SystemNotification,
				content: 'Couldn\'t create the isolated worktree. This session hasn\'t started; retry to try again.\n\n`git worktree exited with code 128`',
				_meta: { kind: 'worktreeCreationFailure', severity: 'warning' },
			},
			copiedPartCount: 0,
			emptyTurnCount: 0,
		});
	});

	test('cleanup on archive removes a clean worktree and unarchive recreates it', async () => {
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await isolation.cleanupWorktreeOnArchive(sessionUri, sessionId);
		const removedDuringArchive = worktree ? !existsSync(worktree.fsPath) : false;
		await isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId);
		const restoredDuringUnarchive = worktree ? existsSync(worktree.fsPath) : false;

		assert.deepStrictEqual({
			removeCalls: removeCalls.map(call => ({ worktree: call.worktree.toString(), force: call.force })),
			removedDuringArchive,
			addExistingCalls: addExistingCalls.map(c => ({ worktree: c.worktree.toString(), branchName: c.branchName })),
			restoredDuringUnarchive,
		}, {
			removeCalls: [{ worktree: worktree!.toString(), force: true }],
			removedDuringArchive: true,
			addExistingCalls: [{ worktree: worktree!.toString(), branchName }],
			restoredDuringUnarchive: true,
		});
	});

	test('unarchive restores configured environment files before the checkout becomes ready', async () => {
		const isolation = createIsolation(disposables);
		const includeFiles = ['.env', 'config/**'];
		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: includeFiles,
			},
		});
		await isolation.cleanupWorktreeOnArchive(sessionUri, sessionId);
		await isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId);

		assert.deepStrictEqual({
			copyCalls: copyIncludeCalls.map(call => ({ source: call.repositoryRoot.toString(), worktree: call.worktree.toString(), globs: call.globs })),
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			copyCalls: [
				{ source: repoRoot.toString(), worktree: worktree!.toString(), globs: includeFiles },
				{ source: repoRoot.toString(), worktree: worktree!.toString(), globs: includeFiles },
			],
			checkoutExists: true,
		});
	});

	test('unarchive removes a partial checkout and rejects when environment restore fails', async () => {
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'main',
				[SessionConfigKey.WorktreeIncludeFiles]: ['.env'],
			},
		});
		await isolation.cleanupWorktreeOnArchive(sessionUri, sessionId);
		copyIncludeError = new Error('restore environment failed');

		await assert.rejects(() => isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId), /restore environment failed/);
		assert.strictEqual(existsSync(worktree!.fsPath), false);
	});

	test('cleanup on archive stores dirty contents in a private ref without changing the branch', async () => {
		hasUncommittedChanges = true;
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await isolation.cleanupWorktreeOnArchive(sessionUri, sessionId);

		assert.deepStrictEqual({
			archiveRefCommit,
			archiveTree,
			branchHead: headCommit,
			removeCalls: removeCalls.map(call => ({ worktree: call.worktree.toString(), force: call.force })),
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			archiveRefCommit: 'archive-commit',
			archiveTree: 'archive-tree',
			branchHead: 'abc123',
			removeCalls: [{ worktree: worktree!.toString(), force: true }],
			checkoutExists: false,
		});
	});

	test('legacy dirty archive requires confirmation before creating a ref or removing the checkout', async () => {
		hasUncommittedChanges = true;
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await assert.rejects(
			isolation.cleanupWorktreeOnArchive(sessionUri, sessionId, { preserveChanges: false }),
			WorktreeArchiveChangesConfirmationRequiredError,
		);

		assert.deepStrictEqual({
			archiveRefCommit,
			removeCalls: removeCalls.length,
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			archiveRefCommit: undefined,
			removeCalls: 0,
			checkoutExists: true,
		});
	});

	test('unarchive reapplies and verifies the private delta before consuming its ref', async () => {
		hasUncommittedChanges = true;
		let applied = false;
		const gitService = createGitService();
		gitService.captureWorktreeArchiveSnapshot = async () => {
			const dirty = removeCalls.length === 0 || applied;
			return {
				baseCommit: headCommit!,
				baseTreeOid: 'base-tree',
				indexTreeOid: dirty ? 'index-tree' : 'base-tree',
				workingTreeOid: dirty ? 'archive-tree' : 'base-tree',
			};
		};
		gitService.applyWorktreeArchiveStash = async (_workingDirectory, ref) => {
			archiveRestoreCalls.push(ref);
			applied = true;
		};
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await isolation.cleanupWorktreeOnArchive(sessionUri, sessionId);
		assert.strictEqual(archiveRefCommit, 'archive-commit');
		await isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId);

		assert.deepStrictEqual({
			archiveRestoreCalls,
			archiveRefCommit,
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			archiveRestoreCalls: [getWorktreeArchiveRef(sessionId)],
			archiveRefCommit: undefined,
			checkoutExists: true,
		});
	});

	test('unarchive consumes a retained private ref without reapplying when the live four-state already matches', async () => {
		hasUncommittedChanges = true;
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		archiveIndexTree = 'index-tree';
		archiveTree = 'archive-tree';
		archiveRefCommit = 'archive-commit';

		await isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId);

		assert.deepStrictEqual({
			archiveRestoreCalls,
			archiveRefCommit,
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			archiveRestoreCalls: [],
			archiveRefCommit: undefined,
			checkoutExists: true,
		});
	});

	test('unarchive applies a retained private ref when the checkout is still clean after a crash', async () => {
		let applied = false;
		const gitService = createGitService();
		gitService.captureWorktreeArchiveSnapshot = async () => ({
			baseCommit: headCommit!,
			baseTreeOid: 'base-tree',
			indexTreeOid: applied ? 'index-tree' : 'base-tree',
			workingTreeOid: applied ? 'archive-tree' : 'base-tree',
		});
		gitService.applyWorktreeArchiveStash = async (_workingDirectory, ref) => {
			archiveRestoreCalls.push(ref);
			applied = true;
		};
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		archiveIndexTree = 'index-tree';
		archiveTree = 'archive-tree';
		archiveRefCommit = 'archive-commit';

		await isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId);

		assert.deepStrictEqual({
			archiveRestoreCalls,
			archiveRefCommit,
			checkoutExists: existsSync(worktree!.fsPath),
		}, {
			archiveRestoreCalls: [getWorktreeArchiveRef(sessionId)],
			archiveRefCommit: undefined,
			checkoutExists: true,
		});
	});

	test('cleanup on archive rejects snapshot-commit and removal failures without pretending archive cleanup succeeded', async () => {
		hasUncommittedChanges = true;
		const commitGitService = createGitService();
		commitGitService.commitTree = async () => { throw new Error('snapshot commit failed'); };
		const commitIsolation = createIsolation(disposables, { gitService: commitGitService });
		const commitWorktree = await commitIsolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		await assert.rejects(() => commitIsolation.cleanupWorktreeOnArchive(sessionUri, sessionId), /snapshot commit failed/);
		assert.strictEqual(existsSync(commitWorktree!.fsPath), true);
		assert.strictEqual(removeCalls.length, 0);

		hasUncommittedChanges = false;
		const removeGitService = createGitService();
		removeGitService.removeWorktree = async () => { throw new Error('archive remove failed'); };
		const secondSessionUri = URI.parse('agent-session://test/s2');
		const secondDb = new TestSessionDatabase();
		const removeIsolation = disposables.add(new WorktreeIsolation(
			{ generateBranchName: async () => 'agents/second' },
			removeGitService,
			createNullCopilotApiService(),
			createSessionDataService(secondDb),
			new NullLogService(),
		));
		const removeWorktree = await removeIsolation.resolveWorkingDirectory({ sessionUri: secondSessionUri, sessionId: 's2', workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		await assert.rejects(() => removeIsolation.cleanupWorktreeOnArchive(secondSessionUri, 's2'), /archive remove failed/);
		assert.strictEqual(existsSync(removeWorktree!.fsPath), true);
	});

	test('final archive snapshot mismatch makes unarchive fail closed with the checkout and private ref intact', async () => {
		hasUncommittedChanges = true;
		const gitService = createGitService();
		let captureCount = 0;
		gitService.captureWorktreeArchiveSnapshot = async () => ({
			baseCommit: headCommit!,
			baseTreeOid: 'base-tree',
			indexTreeOid: 'index-tree',
			workingTreeOid: captureCount++ === 0 ? 'archive-tree' : 'changed-after-snapshot',
		});
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await assert.rejects(
			isolation.cleanupWorktreeOnArchive(sessionUri, sessionId),
			/index or working tree changed/,
		);
		await assert.rejects(
			isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId),
			/retained checkout differs from both the archived changes and the clean archived base/,
		);
		assert.deepStrictEqual({
			checkoutExists: existsSync(worktree!.fsPath),
			archiveRefCommit,
			archiveRestoreCalls,
			removeCalls: removeCalls.length,
		}, {
			checkoutExists: true,
			archiveRefCommit: 'archive-commit',
			archiveRestoreCalls: [],
			removeCalls: 0,
		});
	});

	test('cleanup on archive retains the checkout when its dirty state cannot be represented by a Git snapshot', async () => {
		const gitService = createGitService();
		gitService.captureWorktreeArchiveSnapshot = async () => undefined;
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await assert.rejects(
			isolation.cleanupWorktreeOnArchive(sessionUri, sessionId),
			/working-tree delta could not be captured/,
		);
		assert.deepStrictEqual({ checkoutExists: existsSync(worktree!.fsPath), removeCalls: removeCalls.length }, { checkoutExists: true, removeCalls: 0 });
	});

	test('cleanup and restore reject when the preserved Fumie branch is missing', async () => {
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });
		branchExists = false;

		await assert.rejects(
			() => isolation.cleanupWorktreeOnArchive(sessionUri, sessionId),
			(error: unknown) => error instanceof WorktreeArchiveUnrecoverableError && /preserved branch .* is missing/.test(error.message),
		);
		assert.strictEqual(existsSync(worktree!.fsPath), true);

		rmSync(worktree!.fsPath, { recursive: true, force: true });
		await assert.rejects(() => isolation.recreateWorktreeOnUnarchive(sessionUri, sessionId), /branch .* no longer exists/);
	});

	test('removeSessionWorktree force-removes a worktree for explicit session deletion', async () => {
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		assert.deepStrictEqual({
			removeCalls: removeCalls.map(call => ({ worktree: call.worktree.toString(), force: call.force })),
			deleteBranchCalls: deleteBranchCalls.map(call => ({ branchName: call.branchName, force: call.force })),
			resolvedWorktree: isolation.getResolvedWorktree(sessionId),
		}, {
			removeCalls: [{ worktree: worktree!.toString(), force: true }],
			deleteBranchCalls: [{ branchName, force: true }],
			resolvedWorktree: undefined,
		});
	});

	test('session deletion preserves an existing user branch when worktreeCreateNewBranch is false', async () => {
		const isolation = createIsolation(disposables);
		const worktree = await isolation.resolveWorkingDirectory({
			sessionUri,
			sessionId,
			workingDirectory: repoRoot,
			config: {
				[SessionConfigKey.Isolation]: 'worktree',
				[SessionConfigKey.Branch]: 'feature',
				[SessionConfigKey.WorktreeCreateNewBranch]: false,
			},
		});

		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		assert.deepStrictEqual({
			addWorktreeCalls: addWorktreeCalls.map(call => ({ commitish: call.commitish, newBranchName: call.newBranchName })),
			branchOwned: await db.getMetadata('copilot.worktree.branchOwned'),
			checkoutExists: existsSync(worktree!.fsPath),
			deletedBranches: deleteBranchCalls.map(call => call.branchName),
		}, {
			addWorktreeCalls: [{ commitish: 'feature', newBranchName: undefined }],
			branchOwned: 'false',
			checkoutExists: false,
			deletedBranches: [],
		});
	});

	test('session deletion removes the empty managed repository directory', async () => {
		const fumieHome = URI.file(mkdtempSync(join(tmpdir(), 'fumie-delete-')));
		const previousFumieHome = process.env[AgentHostFumieHomeEnvVar];
		process.env[AgentHostFumieHomeEnvVar] = fumieHome.fsPath;
		try {
			const isolation = createIsolation(disposables);
			const worktree = await isolation.resolveWorkingDirectory({
				sessionUri,
				sessionId,
				workingDirectory: repoRoot,
				config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' },
				diskBudgetSessions: [{ sessionId, running: true, pinned: false }],
			});
			const repositoryDirectory = getManagedWorktreeRepositoryRoot(fumieHome, repoRoot);

			await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

			assert.deepStrictEqual({
				checkoutExists: existsSync(worktree!.fsPath),
				repositoryDirectoryExists: existsSync(repositoryDirectory.fsPath),
			}, {
				checkoutExists: false,
				repositoryDirectoryExists: false,
			});
		} finally {
			if (previousFumieHome === undefined) {
				delete process.env[AgentHostFumieHomeEnvVar];
			} else {
				process.env[AgentHostFumieHomeEnvVar] = previousFumieHome;
			}
			rmSync(fumieHome.fsPath, { recursive: true, force: true });
		}
	});

	test('session deletion preserves a Fumie branch once it has been published', async () => {
		const gitService = createGitService();
		gitService.hasUpstream = async () => true;
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		assert.deepStrictEqual({ checkoutExists: existsSync(worktree!.fsPath), deletedBranches: deleteBranchCalls }, {
			checkoutExists: false,
			deletedBranches: [],
		});
	});

	test('archive refuses to remove a checkout that switched away from its Fumie branch', async () => {
		const gitService = createGitService();
		gitService.getCurrentBranchName = async () => 'user/other';
		const isolation = createIsolation(disposables, { gitService });
		const worktree = await isolation.resolveWorkingDirectory({ sessionUri, sessionId, workingDirectory: repoRoot, config: { [SessionConfigKey.Isolation]: 'worktree', [SessionConfigKey.Branch]: 'main' } });

		await assert.rejects(
			() => isolation.cleanupWorktreeOnArchive(sessionUri, sessionId),
			(error: unknown) => error instanceof WorktreeArchiveUnrecoverableError && /switched from the Fumie branch/.test(error.message),
		);
		assert.strictEqual(existsSync(worktree!.fsPath), true);
	});

	test('session deletion removes a persisted worktree after a process restart', async () => {
		const worktree = URI.joinPath(worktreesRoot, 'persisted-worktree');
		mkdirSync(worktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', worktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata('copilot.worktree.ownership', 'fumie'),
		]);
		const isolation = createIsolation(disposables);

		const worktreeToRemove = await isolation.prepareSessionDeletion(sessionUri, sessionId);
		await isolation.removeSessionWorktree(sessionId, worktreeToRemove);

		assert.deepStrictEqual({
			removeCalls: removeCalls.map(call => ({ worktree: call.worktree.toString(), force: call.force })),
			deletedBranches: deleteBranchCalls.map(call => call.branchName),
			resolvedWorktree: isolation.getResolvedWorktree(sessionId),
		}, {
			removeCalls: [{ worktree: worktree.toString(), force: true }],
			deletedBranches: ['feature/x'],
			resolvedWorktree: undefined,
		});
	});

	test('legacy metadata under the historical managed root is durably migrated to Fumie ownership', async () => {
		const worktree = URI.joinPath(worktreesRoot, 'legacy-managed');
		mkdirSync(worktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'agents/legacy-managed'),
			db.setMetadata('copilot.worktree.path', worktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
		]);
		const isolation = createIsolation(disposables);

		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		assert.deepStrictEqual({
			ownership: await db.getMetadata('copilot.worktree.ownership'),
			removeCalls: removeCalls.map(call => call.worktree.toString()),
			deletedBranches: deleteBranchCalls.map(call => call.branchName),
		}, {
			ownership: 'fumie',
			removeCalls: [worktree.toString()],
			deletedBranches: ['agents/legacy-managed'],
		});
	});

	test('failed worktree removal rejects and remains available for retry', async () => {
		const gitService = createGitService();
		gitService.removeWorktree = async () => { throw new Error('remove failed'); };
		const isolation = createIsolation(disposables, { gitService });
		const worktree = URI.joinPath(worktreesRoot, 'persisted-worktree');
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'feature/x'),
			db.setMetadata('copilot.worktree.path', worktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata('copilot.worktree.ownership', 'fumie'),
		]);

		const worktreeToRemove = await isolation.prepareSessionDeletion(sessionUri, sessionId);
		await assert.rejects(() => isolation.removeSessionWorktree(sessionId, worktreeToRemove), /remove failed/);
		const retry = await isolation.prepareSessionDeletion(sessionUri, sessionId);

		assert.deepStrictEqual({
			retryRepositoryRoot: retry?.repositoryRoot.toString(),
			retryWorktree: retry?.worktree.toString(),
		}, {
			retryRepositoryRoot: repoRoot.toString(),
			retryWorktree: worktree.toString(),
		});
	});

	test('branch deletion failure rejects and a retry is reconstructed from persisted metadata', async () => {
		const gitService = createGitService();
		let deleteAttempts = 0;
		gitService.deleteBranch = async (_repositoryRoot, candidate) => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error('branch delete failed');
			}
			deleteBranchCalls.push({ repositoryRoot: repoRoot, branchName: candidate, force: true });
			branchExists = false;
		};
		const isolation = createIsolation(disposables, { gitService });
		const worktree = URI.joinPath(worktreesRoot, 'persisted-worktree');
		mkdirSync(worktree.fsPath, { recursive: true });
		await Promise.all([
			db.setMetadata('copilot.worktree.branchName', 'agents/persisted'),
			db.setMetadata('copilot.worktree.path', worktree.toString()),
			db.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
			db.setMetadata('copilot.worktree.ownership', 'fumie'),
		]);

		await assert.rejects(async () => isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId)), /branch delete failed/);
		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		assert.deepStrictEqual({ deleteAttempts, removeAttempts: removeCalls.length, deletedBranches: deleteBranchCalls.map(call => call.branchName) }, {
			deleteAttempts: 2,
			removeAttempts: 2,
			deletedBranches: ['agents/persisted'],
		});
	});

	test('deletion never removes externally adopted or legacy unknown-ownership worktrees', async () => {
		const externalWorktree = URI.joinPath(repoRoot, 'user-worktrees', 'external');
		mkdirSync(externalWorktree.fsPath, { recursive: true });
		const gitService = createGitService();
		gitService.getRepositoryRoot = async () => externalWorktree;
		gitService.getWorktreeRoots = async () => [repoRoot, externalWorktree];
		gitService.getCurrentBranch = async () => 'user/external';
		const isolation = createIsolation(disposables, { gitService });
		await isolation.adoptExistingWorktreeMetadata(sessionUri, externalWorktree);
		await isolation.removeSessionWorktree(sessionId, await isolation.prepareSessionDeletion(sessionUri, sessionId));

		const legacySessionUri = URI.parse('agent-session://test/legacy');
		const legacyDb = new TestSessionDatabase();
		await Promise.all([
			legacyDb.setMetadata('copilot.worktree.branchName', 'agents/legacy'),
			legacyDb.setMetadata('copilot.worktree.path', externalWorktree.toString()),
			legacyDb.setMetadata('copilot.worktree.repositoryRoot', repoRoot.toString()),
		]);
		const legacyIsolation = disposables.add(new WorktreeIsolation(
			{ generateBranchName: async () => 'agents/unused' },
			createGitService(),
			createNullCopilotApiService(),
			createSessionDataService(legacyDb),
			new NullLogService(),
		));
		await legacyIsolation.removeSessionWorktree('legacy', await legacyIsolation.prepareSessionDeletion(legacySessionUri, 'legacy'));

		assert.deepStrictEqual({
			externalOwnership: await db.getMetadata('copilot.worktree.ownership'),
			legacyOwnership: await legacyDb.getMetadata('copilot.worktree.ownership'),
			checkoutExists: existsSync(externalWorktree.fsPath),
			removeCalls: removeCalls.length,
			deleteBranchCalls: deleteBranchCalls.length,
		}, {
			externalOwnership: 'external',
			legacyOwnership: undefined,
			checkoutExists: true,
			removeCalls: 0,
			deleteBranchCalls: 0,
		});
	});
});
