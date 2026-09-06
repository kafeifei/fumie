/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsSessionsWindowContext, SideBarVisibleContext } from '../../../../workbench/common/contextkeys.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsTitleBarNewSessionEnabledContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService, inheritableSessionTarget } from '../../../services/sessions/common/sessionsManagement.js';
import { NEW_SESSION_ACTION_ID } from '../common/constants.js';

class NewChatInSessionsWindowAction extends Action2 {

	constructor() {
		super({
			id: NEW_SESSION_ACTION_ID,
			title: localize2('sessions.newSession.label', "New Session"),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				// Builtin extensions can bind Cmd+N at 300
				// (`KeybindingWeight.BuiltinExtension`). Agents Cmd+N must
				// still win over them.
				weight: KeybindingWeight.BuiltinExtension + 1,
				// Agents window only (`isSessionsWindow`). Beats workbench New
				// Untitled File even when the editor or composer has focus.
				// `activeEditor` is the wrong when — this window often has no
				// editor, and a CSS class like `agent-sessions-workbench` is
				// not a context key. The editor workbench keeps Cmd+N because
				// `isSessionsWindow` is false there.
				when: IsSessionsWindowContext,
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				secondary: [KeyMod.CtrlCmd | KeyCode.KeyL],
				mac: {
					primary: KeyMod.CtrlCmd | KeyCode.KeyN,
					secondary: [KeyMod.WinCtrl | KeyCode.KeyL]
				},
			},
			menu: [
				{
					id: Menus.SidebarNewAgent,
					group: 'navigation',
					order: 0,
				},
				{
					// Native macOS File menu accelerator. Without this item,
					// File > New Text File keeps Cmd+N and intercepts the chord
					// before the renderer keybinding service runs.
					id: MenuId.MenubarFileMenu,
					group: '1_new',
					order: 1,
					when: IsSessionsWindowContext,
				},
				{
					id: Menus.TitleBarLeftLayout,
					group: 'navigation',
					order: 1,
					// Show in the titlebar only when the sidebar is hidden, gated behind an A/B experiment.
					when: ContextKeyExpr.and(SideBarVisibleContext.toNegated(), SessionsWelcomeVisibleContext.toNegated(), SessionsTitleBarNewSessionEnabledContext)
				}
			]
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessionsService = accessor.get(ISessionsService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const activeSession = sessionsService.activeSession.get();
		// Sidebar New Agent / Cmd+N: never open a file or folder dialog.
		// Cmd+O (`NEW_SESSION_PICK_FOLDER_ACTION_ID`) is the native folder picker.
		// A quick chat never contributes its folder — it is workspace-less by
		// intent (any scratch working directory must not seed the workspace
		// composer).
		const isQuickChat = activeSession?.isQuickChat?.get() ?? false;
		const folderUri = isQuickChat ? undefined : activeSession?.workspace.get()?.uri;
		// Inherit the active session's harness so the new session defaults to
		// the kind the user is working in — but only while the folder still
		// offers it (see `inheritableSessionTarget`).
		sessionsService.openNewSession({
			folderUri,
			...inheritableSessionTarget(sessionsManagementService, activeSession, folderUri),
		});
	}
}

registerAction2(NewChatInSessionsWindowAction);
