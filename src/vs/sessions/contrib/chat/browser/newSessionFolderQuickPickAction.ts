/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { NEW_SESSION_PICK_FOLDER_ACTION_ID } from '../common/constants.js';

/** Native OS folder dialog used by Cmd+O and the Agents titlebar folder chip. */
export async function pickNativeSessionFolder(
	fileDialogService: IFileDialogService,
	defaultUri?: URI,
): Promise<URI | undefined> {
	const result = await fileDialogService.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: localize('sessions.newSession.pickFolder.title', "Select Folder"),
		defaultUri,
	});
	return result?.[0];
}

/** Opens the native folder dialog and starts a new session in the chosen folder. */
export async function pickFolderAndOpenNewSession(
	fileDialogService: IFileDialogService,
	sessionsService: ISessionsService,
): Promise<void> {
	const folderUri = await pickNativeSessionFolder(fileDialogService);
	if (!folderUri) {
		return;
	}

	await sessionsService.openNewSession({ folderUri });
}

class NewSessionPickFolderAction extends Action2 {

	constructor() {
		super({
			id: NEW_SESSION_PICK_FOLDER_ACTION_ID,
			title: localize2('sessions.newSession.pickFolderQuickPick.label', "New Session in Folder..."),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				// Wins over the desktop Open File/Folder actions' Cmd+O when both match.
				weight: KeybindingWeight.SessionsContrib,
				when: IsSessionsWindowContext,
				primary: KeyMod.CtrlCmd | KeyCode.KeyO,
			},
			menu: {
				// Native macOS File menu accelerator. File > Open... must not
				// keep Cmd+O (or steal Cmd+N) in the Agents window.
				id: MenuId.MenubarFileMenu,
				group: '2_open',
				order: 1,
				when: IsSessionsWindowContext,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await pickFolderAndOpenNewSession(
			accessor.get(IFileDialogService),
			accessor.get(ISessionsService),
		);
	}
}

registerAction2(NewSessionPickFolderAction);
