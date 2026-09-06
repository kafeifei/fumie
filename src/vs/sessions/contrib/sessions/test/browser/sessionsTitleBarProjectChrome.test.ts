/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable, IObservable } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionFolder, ISessionGitRepository, ISessionWorkspace, SessionWorkspaceKind } from '../../../../services/sessions/common/session.js';
import { applyTitleBarPickedFolder, formatTitleBarGitChipLabel, getTitleBarProjectChromeState } from '../../browser/sessionsTitleBarProjectChrome.js';
import { ISessionsPartService } from '../../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';

suite('Sessions - TitleBar Project Chrome', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createSession(options: {
		created?: boolean;
		quickChat?: boolean;
		worktreePending?: boolean;
		workspace?: ISessionWorkspace;
		sessionId?: string;
		providerId?: string;
	} = {}): IActiveSession {
		return new class extends mock<IActiveSession>() {
			override readonly sessionId = options.sessionId ?? 'session';
			override readonly providerId = options.providerId ?? 'test';
			override readonly title: IObservable<string> = constObservable('Session');
			override readonly isCreated: IObservable<boolean> = constObservable(options.created ?? false);
			override readonly isQuickChat: IObservable<boolean> = constObservable(options.quickChat ?? false);
			override readonly worktreePending: IObservable<boolean> = constObservable(options.worktreePending ?? false);
			override readonly workspace: IObservable<ISessionWorkspace | undefined> = constObservable(options.workspace);
		}();
	}

	function createWorkspace(options: {
		label: string;
		path: string;
		branch?: string;
		workTreeUri?: URI;
		uncommitted?: number;
		incoming?: number;
		outgoing?: number;
		virtual?: boolean;
	}): ISessionWorkspace {
		const root = URI.file(options.path);
		const gitRepository: ISessionGitRepository | undefined = options.virtual ? undefined : {
			uri: root,
			workTreeUri: options.workTreeUri,
			branchName: options.branch,
			baseBranchName: 'main',
			uncommittedChanges: options.uncommitted,
			incomingChanges: options.incoming,
			outgoingChanges: options.outgoing,
			gitHubInfo: constObservable(undefined),
		};
		const folder = new class extends mock<ISessionFolder>() {
			override readonly root = root;
			override readonly workingDirectory = options.workTreeUri ?? root;
			override readonly name = options.label;
			override readonly gitRepository = gitRepository;
		}();
		return new class extends mock<ISessionWorkspace>() {
			override readonly label = options.label;
			override readonly folders = [folder];
			override readonly isVirtualWorkspace = options.virtual ?? false;
		}();
	}

	test('no session shows a select-folder chip and hides git/worktree', () => {
		const chrome = getTitleBarProjectChromeState(undefined);
		assert.strictEqual(chrome.hasFolder, false);
		assert.strictEqual(chrome.folderLabel, 'Select Folder');
		assert.strictEqual(chrome.showGit, false);
		assert.strictEqual(chrome.showWorktree, false);
		assert.strictEqual(chrome.canApplyToDraft, false);
	});

	test('git folder shows the worktree chip even without supportsWorktreeConfiguration', () => {
		const chrome = getTitleBarProjectChromeState(createSession({
			workspace: createWorkspace({
				label: 'fumie',
				path: '/Users/dev/fumie',
				branch: 'main',
			}),
		}));
		assert.strictEqual(chrome.showGit, true);
		assert.strictEqual(chrome.showWorktree, true);
		assert.strictEqual(chrome.worktreeLabel, 'This folder');
		assert.strictEqual(chrome.supportsWorktree, false);
	});

	test('untitled workspace session exposes folder, branch, and worktree options', () => {
		const chrome = getTitleBarProjectChromeState(createSession({
			workspace: createWorkspace({
				label: 'fumie',
				path: '/Users/dev/fumie',
				branch: 'main',
				uncommitted: 3,
			}),
		}), true);
		assert.strictEqual(chrome.folderLabel, 'fumie');
		assert.strictEqual(chrome.branchName, 'main');
		assert.strictEqual(chrome.gitDirty, true);
		assert.strictEqual(chrome.showGit, true);
		assert.strictEqual(chrome.showWorktree, true);
		assert.strictEqual(chrome.worktreeLabel, 'This folder');
		assert.strictEqual(chrome.workspaceKind, SessionWorkspaceKind.Folder);
		assert.strictEqual(chrome.canApplyToDraft, true);
	});

	test('worktree session labels the worktree chip', () => {
		const chrome = getTitleBarProjectChromeState(createSession({
			created: true,
			workspace: createWorkspace({
				label: 'fumie',
				path: '/Users/dev/fumie',
				branch: 'fix/auth',
				workTreeUri: URI.file('/Users/dev/fumie/.worktrees/fix-auth'),
			}),
		}), true);
		assert.strictEqual(chrome.workspaceKind, SessionWorkspaceKind.Worktree);
		assert.strictEqual(chrome.worktreeLabel, 'Worktree');
		assert.strictEqual(chrome.canApplyToDraft, false);
	});

	test('quick chat hides folder git and worktree', () => {
		const chrome = getTitleBarProjectChromeState(createSession({
			quickChat: true,
			workspace: createWorkspace({ label: 'fumie', path: '/Users/dev/fumie', branch: 'main' }),
		}), true);
		assert.strictEqual(chrome.hasFolder, false);
		assert.strictEqual(chrome.showGit, false);
		assert.strictEqual(chrome.showWorktree, false);
	});

	test('git chip includes dirty and ahead/behind counts', () => {
		const chrome = getTitleBarProjectChromeState(createSession({
			workspace: createWorkspace({
				label: 'fumie',
				path: '/Users/dev/fumie',
				branch: 'main',
				uncommitted: 2,
				outgoing: 1,
				incoming: 3,
			}),
		}), true);
		assert.strictEqual(formatTitleBarGitChipLabel(chrome), 'main* ↑1 ↓3');
	});

	test('picking a folder on an untitled session applies it in place', async () => {
		const folderUri = URI.file('/tmp/picked');
		const selected: { uri?: URI; providerId?: string } = {};
		const opened: URI[] = [];
		const session = createSession({
			sessionId: 'draft',
			providerId: 'agent-host',
			workspace: createWorkspace({ label: 'fumie', path: '/Users/dev/fumie', branch: 'main' }),
		});

		await applyTitleBarPickedFolder(
			folderUri,
			new class extends mock<ISessionsService>() {
				override readonly activeSession = constObservable(session);
				override async openNewSession(options?: { folderUri?: URI }) {
					if (options?.folderUri) {
						opened.push(options.folderUri);
					}
					return { session: undefined, trustDeclined: false };
				}
			}(),
			new class extends mock<ISessionsManagementService>() {
				override resolveWorkspace() {
					return { providerId: 'agent-host', workspace: session.workspace.get()! };
				}
			}(),
			new class extends mock<ISessionsPartService>() {
				override getSessionView() {
					return {
						selectWorkspace(uri: URI, providerId?: string) {
							selected.uri = uri;
							selected.providerId = providerId;
						},
					} as never;
				}
			}(),
		);

		assert.strictEqual(selected.uri?.toString(), folderUri.toString());
		assert.strictEqual(selected.providerId, 'agent-host');
		assert.deepStrictEqual(opened, []);
	});

	test('picking a folder on a created session opens a new session', async () => {
		const folderUri = URI.file('/tmp/picked');
		const opened: URI[] = [];
		const session = createSession({
			created: true,
			workspace: createWorkspace({ label: 'fumie', path: '/Users/dev/fumie', branch: 'main' }),
		});

		await applyTitleBarPickedFolder(
			folderUri,
			new class extends mock<ISessionsService>() {
				override readonly activeSession = constObservable(session);
				override async openNewSession(options?: { folderUri?: URI }) {
					if (options?.folderUri) {
						opened.push(options.folderUri);
					}
					return { session: undefined, trustDeclined: false };
				}
			}(),
			new class extends mock<ISessionsManagementService>() { }(),
			new class extends mock<ISessionsPartService>() {
				override getSessionView() { return undefined; }
			}(),
		);

		assert.deepStrictEqual(opened.map(uri => uri.toString()), [folderUri.toString()]);
	});
});
