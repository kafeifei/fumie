/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventType } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { ISessionsPartService } from '../../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionFolder, ISessionGitRepository, ISessionWorkspace, SessionTypeAuthRequirement } from '../../../../services/sessions/common/session.js';
import { IActiveSession, IProviderSessionType, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionsTitleBarWorkspaceWidget } from '../../browser/sessionsTitleBarWorkspaceWidget.js';

suite('Sessions - TitleBar Workspace Widget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createWorkspace(label: string, branch?: string, workTreeUri?: URI): ISessionWorkspace {
		const root = URI.file(`/Users/dev/${label}`);
		const gitRepository: ISessionGitRepository | undefined = branch ? {
			uri: root,
			workTreeUri,
			branchName: branch,
			baseBranchName: 'main',
			gitHubInfo: constObservable(undefined),
		} : undefined;
		const folder = new class extends mock<ISessionFolder>() {
			override readonly root = root;
			override readonly workingDirectory = workTreeUri ?? root;
			override readonly name = label;
			override readonly gitRepository = gitRepository;
		}();
		return new class extends mock<ISessionWorkspace>() {
			override readonly label = label;
			override readonly folders = [folder];
			override readonly isVirtualWorkspace = false;
		}();
	}

	function createActiveSession(options: {
		workspace?: ISessionWorkspace;
		quickChat?: boolean;
		created?: boolean;
	} = {}): IActiveSession {
		return new class extends mock<IActiveSession>() {
			override readonly sessionId = 'session';
			override readonly providerId = 'test';
			override readonly sessionType = 'test';
			override readonly title: IObservable<string> = constObservable('Session');
			override readonly isQuickChat: IObservable<boolean> = constObservable(options.quickChat ?? false);
			override readonly isCreated: IObservable<boolean> = constObservable(options.created ?? true);
			override readonly workspace: IObservable<ISessionWorkspace | undefined> = constObservable(options.workspace);
			override readonly worktreePending: IObservable<boolean> = constObservable(false);
		}();
	}

	function renderWidget(options: {
		activeSession?: IActiveSession;
		pickedFolder?: URI;
		openedFolders?: URI[];
		supportsWorktree?: boolean;
		dialogCalls?: URI[][];
	}): HTMLElement {
		const store = disposables.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, store);
		const openedFolders = options.openedFolders ?? [];

		instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession: IObservable<IActiveSession | undefined> = constObservable(options.activeSession);
			override async openNewSession(openOptions?: { folderUri?: URI }) {
				if (openOptions?.folderUri) {
					openedFolders.push(openOptions.folderUri);
				}
				return { session: undefined, trustDeclined: false };
			}
		}());
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = Event.None;
			override getSessionTypesForFolder(): IProviderSessionType[] {
				return options.supportsWorktree
					? [{
						providerId: 'test',
						sessionType: {
							id: 'test',
							label: 'Test',
							icon: Codicon.robot,
							supportsWorktreeConfiguration: true,
							authRequirement: SessionTypeAuthRequirement.None,
						},
					}]
					: [];
			}
		}());
		instantiationService.stub(ISessionsPartService, new class extends mock<ISessionsPartService>() {
			override getSessionView() { return undefined; }
		}());
		instantiationService.stub(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
			override getProvider() { return undefined; }
			override getProviders() { return []; }
		}());
		instantiationService.stub(IFileDialogService, new class extends mock<IFileDialogService>() {
			override async showOpenDialog() {
				options.dialogCalls?.push(options.pickedFolder ? [options.pickedFolder] : []);
				return options.pickedFolder ? [options.pickedFolder] : undefined;
			}
		}());
		instantiationService.stub(IGitService, new class extends mock<IGitService>() {
			override readonly repositories = [];
			override async openRepository() { return undefined; }
		}());
		instantiationService.stub(IActionWidgetService, new class extends mock<IActionWidgetService>() {
			override get isVisible() { return false; }
			override show(): void { }
			override hide(): void { }
			override updateItems(): void { }
		}());
		instantiationService.stub(IHoverService, new class extends mock<IHoverService>() {
			override setupDelayedHover() { return { dispose() { } }; }
		}());

		const action = new class extends mock<SubmenuItemAction>() {
			override readonly id = 'sessions.titlebar.workspace';
			override readonly label = 'Workspace';
			override readonly tooltip = '';
			override readonly enabled = true;
			override async run() { }
		}();
		const host = mainWindow.document.createElement('div');
		host.className = 'action-item';
		const widget = store.add(instantiationService.createInstance(SessionsTitleBarWorkspaceWidget, action, undefined));
		widget.render(host);
		return host;
	}

	test('renders folder git and worktree chips on the right-side widget', () => {
		const host = renderWidget({
			activeSession: createActiveSession({
				workspace: createWorkspace('fumie', 'main', URI.file('/Users/dev/fumie/.worktrees/fix')),
			}),
			supportsWorktree: true,
		});

		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-folder .agent-sessions-titlebar-chip-label')?.textContent, 'fumie');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-git .agent-sessions-titlebar-chip-label')?.textContent, 'main');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-worktree .agent-sessions-titlebar-chip-label')?.textContent, 'Worktree');
	});

	test('renders folder git and worktree chips without worktree capability advertised', () => {
		const host = renderWidget({
			activeSession: createActiveSession({
				workspace: createWorkspace('fumie', 'main'),
			}),
		});

		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-folder .agent-sessions-titlebar-chip-label')?.textContent, 'fumie');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-git .agent-sessions-titlebar-chip-label')?.textContent, 'main');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-worktree .agent-sessions-titlebar-chip-label')?.textContent, 'This folder');
	});

	test('clicking the folder chip uses the native folder dialog', async () => {
		const openedFolders: URI[] = [];
		const dialogCalls: URI[][] = [];
		const pickedFolder = URI.file('/tmp/new-project');
		const host = renderWidget({
			activeSession: createActiveSession({ workspace: createWorkspace('fumie', 'main') }),
			pickedFolder,
			openedFolders,
			dialogCalls,
		});

		const folderChip = host.querySelector('.agent-sessions-titlebar-folder') as HTMLElement;
		assert.ok(folderChip);
		folderChip.dispatchEvent(new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true, cancelable: true }));
		folderChip.dispatchEvent(new MouseEvent(EventType.CLICK, { bubbles: true, cancelable: true }));
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(dialogCalls.map(uris => uris.map(uri => uri.toString())), [[pickedFolder.toString()]]);
		assert.deepStrictEqual(openedFolders.map(uri => uri.toString()), [pickedFolder.toString()]);
	});

	test('quick chat hides the workspace chrome', () => {
		const host = renderWidget({
			activeSession: createActiveSession({
				quickChat: true,
				workspace: createWorkspace('fumie', 'main'),
			}),
		});

		assert.strictEqual(host.style.display, 'none');
		assert.strictEqual(host.querySelector('.agent-sessions-titlebar-folder'), null);
	});
});
