/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionsTitleBarWorkspaceWidget.css';
import { $, append, reset } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuItemAction, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext, SidePaneVisibleContext } from '../../../common/contextkeys.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { pickNativeSessionFolder } from '../../chat/browser/newSessionFolderQuickPickAction.js';
import { applyTitleBarPickedFolder, getTitleBarProjectChromeRenderKey, resolveTitleBarProjectChrome, SessionsTitleBarProjectChrome } from './sessionsTitleBarProjectChrome.js';

export const PICK_SESSION_FOLDER_COMMAND_ID = 'sessions.titlebar.pickFolder';

/**
 * Right-aligned titlebar cluster: folder picker, git branch, and worktree.
 * Hosts {@link SessionsTitleBarProjectChrome}; the center title stays display-only.
 */
export class SessionsTitleBarWorkspaceWidget extends BaseActionViewItem {

	private _container: HTMLElement | undefined;
	private _lastRenderKey: string | undefined;
	private readonly _projectChrome: SessionsTitleBarProjectChrome;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(undefined, action, options);

		this._projectChrome = this._register(instantiationService.createInstance(SessionsTitleBarProjectChrome));

		this._register(autorun(reader => {
			const session = this.sessionsService.activeSession.read(reader);
			session?.workspace.read(reader);
			session?.isCreated.read(reader);
			session?.isQuickChat?.read(reader);
			session?.worktreePending?.read(reader);
			this._lastRenderKey = undefined;
			this._render();
		}));

		this._register(this.sessionsManagementService.onDidChangeSessions(() => {
			this._lastRenderKey = undefined;
			this._render();
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this._container = container;
		container.classList.add('agent-sessions-titlebar-workspace');
		this._render();
	}

	override onClick(): void {
		// Chips handle their own clicks.
	}

	private _render(): void {
		if (!this._container) {
			return;
		}

		const session = this.sessionsService.activeSession.get();
		const chrome = resolveTitleBarProjectChrome(session, this.sessionsManagementService);
		if (chrome.isQuickChat) {
			this._lastRenderKey = 'quick';
			this._container.style.display = 'none';
			this._projectChrome.clear();
			reset(this._container);
			return;
		}

		const renderKey = getTitleBarProjectChromeRenderKey(chrome);
		if (renderKey === this._lastRenderKey) {
			return;
		}
		this._lastRenderKey = renderKey;
		this._container.style.display = '';
		reset(this._container);
		const row = append(this._container, $('div.agent-sessions-titlebar-workspace-row'));
		this._projectChrome.render(row, session);
	}
}

const titleBarWorkspaceWhen = ContextKeyExpr.and(
	IsAuxiliaryWindowContext.negate(),
	SessionsWelcomeVisibleContext.negate(),
	IsPhoneLayoutContext.negate(),
);

registerAction2(class PickSessionFolderAction extends Action2 {
	constructor() {
		super({
			id: PICK_SESSION_FOLDER_COMMAND_ID,
			title: localize2('sessions.titlebar.pickFolder', "Select Folder"),
			f1: false,
			// The project chrome follows the session status: it sits in the title
			// bar while the side pane is open, and moves into the floating status
			// card once the side pane is hidden. Never both at once.
			menu: [{
				id: Menus.TitleBarWorkspace,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(titleBarWorkspaceWhen, SidePaneVisibleContext),
			}, {
				id: Menus.SidebarStatusOverlay,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(titleBarWorkspaceWhen, SidePaneVisibleContext.negate()),
			}],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const sessionsService = accessor.get(ISessionsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsPartService = accessor.get(ISessionsPartService);
		const folderUri = await pickNativeSessionFolder(fileDialogService);
		if (!folderUri) {
			return;
		}
		await applyTitleBarPickedFolder(
			folderUri,
			sessionsService,
			sessionsManagementService,
			sessionsPartService,
		);
	}
});

export class SessionsTitleBarWorkspaceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessionsTitleBarWorkspace';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const onDidRegister = this._register(new Emitter<void>());
		const createWidget = (action: IAction, options: IBaseActionViewItemOptions | undefined) => {
			if (!(action instanceof MenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(SessionsTitleBarWorkspaceWidget, action, options);
		};
		this._register(actionViewItemService.register(Menus.TitleBarWorkspace, PICK_SESSION_FOLDER_COMMAND_ID, createWidget, onDidRegister.event));
		this._register(actionViewItemService.register(Menus.SidebarStatusOverlay, PICK_SESSION_FOLDER_COMMAND_ID, createWidget, onDidRegister.event));
		onDidRegister.fire();
	}
}
