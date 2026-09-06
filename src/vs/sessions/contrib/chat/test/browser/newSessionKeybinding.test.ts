/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { OpenFileAction, OpenFileFolderAction, OpenFolderAction } from '../../../../../workbench/browser/actions/workspaceActions.js';
import { NEW_UNTITLED_FILE_COMMAND_ID } from '../../../../../workbench/contrib/files/browser/fileConstants.js';
import { NEW_SESSION_ACTION_ID, NEW_SESSION_PICK_FOLDER_ACTION_ID } from '../../common/constants.js';

import '../../browser/newSessionAction.js';
import '../../browser/newSessionFolderQuickPickAction.js';
import '../../../../../workbench/contrib/files/browser/fileCommands.js';
import '../../../../../workbench/contrib/files/browser/fileActions.contribution.js';

const CMD_N = decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyN, OS)!.getHashCode();
const CMD_O = decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyO, OS)!.getHashCode();

function context(values: Record<string, boolean | string>): IContext {
	return { getValue: <T>(key: string) => values[key] as T | undefined };
}

function bindingsFor(hash: string) {
	return KeybindingsRegistry.getDefaultKeybindings()
		.filter(item => item.keybinding?.getHashCode() === hash);
}

function menuItem(commandId: string) {
	return MenuRegistry.getMenuItems(MenuId.MenubarFileMenu)
		.find(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('Sessions - Cmd+N New Session keybinding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('takes Cmd+N from New Untitled File only in the Agents window, including with an active editor', () => {
		const newSession = bindingsFor(CMD_N).find(item => item.command === NEW_SESSION_ACTION_ID)!;
		const untitledFile = bindingsFor(CMD_N).find(item => item.command === NEW_UNTITLED_FILE_COMMAND_ID)!;
		const evaluate = (rule: { when?: { evaluate(ctx: IContext): boolean } | null }, values: Record<string, boolean | string>) => rule.when?.evaluate(context(values)) ?? true;

		assert.deepStrictEqual({
			winsOverUntitledFile: newSession.weight1 > untitledFile.weight1 && newSession.weight1 > KeybindingWeight.WorkbenchContrib,
			winsOverBuiltinExtension: newSession.weight1 > KeybindingWeight.BuiltinExtension,
			whenIsSessionsWindow: newSession.when?.serialize(),
			untitledFileWhen: untitledFile.when?.serialize(),
			editorWorkbench: evaluate(newSession, {}),
			agentsWindow: evaluate(newSession, { isSessionsWindow: true }),
			agentsWindowWithEditor: evaluate(newSession, { isSessionsWindow: true, activeEditor: 'workbench.editors.files.fileEditorInput', editorAreaFocus: true }),
			untitledFileInEditorWorkbench: evaluate(untitledFile, {}),
			untitledFileInAgentsWindow: evaluate(untitledFile, { isSessionsWindow: true }),
			cmdNIsNotPickFolder: bindingsFor(CMD_N).every(item => item.command !== NEW_SESSION_PICK_FOLDER_ACTION_ID),
			cmdNIsNotOpenFile: bindingsFor(CMD_N).every(item => item.command !== OpenFileAction.ID && item.command !== OpenFileFolderAction.ID),
		}, {
			winsOverUntitledFile: true,
			winsOverBuiltinExtension: true,
			whenIsSessionsWindow: 'isSessionsWindow',
			untitledFileWhen: '!isSessionsWindow',
			editorWorkbench: false,
			agentsWindow: true,
			agentsWindowWithEditor: true,
			untitledFileInEditorWorkbench: true,
			untitledFileInAgentsWindow: false,
			cmdNIsNotPickFolder: true,
			cmdNIsNotOpenFile: true,
		});
	});

	test('File menu gives native Cmd+N to New Session, not Open File / Open Folder', () => {
		const untitledFile = menuItem(NEW_UNTITLED_FILE_COMMAND_ID)!;
		const newSession = menuItem(NEW_SESSION_ACTION_ID)!;
		const pickFolder = menuItem(NEW_SESSION_PICK_FOLDER_ACTION_ID)!;
		const openFolder = menuItem(OpenFolderAction.ID)!;
		const openFileFolder = menuItem(OpenFileFolderAction.ID)!;
		const evaluate = (rule: { when?: { evaluate(ctx: IContext): boolean } | undefined }, values: Record<string, boolean>) => rule.when?.evaluate(context(values)) ?? true;
		const agentsMac = { isSessionsWindow: true, isMacNative: true, openFolderWorkspaceSupport: true };
		const editorMac = { isMacNative: true, openFolderWorkspaceSupport: true };

		assert.deepStrictEqual({
			editorWorkbenchUntitledFile: evaluate(untitledFile, {}),
			agentsWindowUntitledFile: evaluate(untitledFile, { isSessionsWindow: true }),
			editorWorkbenchNewSession: evaluate(newSession, {}),
			agentsWindowNewSession: evaluate(newSession, { isSessionsWindow: true }),
			editorWorkbenchPickFolder: evaluate(pickFolder, {}),
			agentsWindowPickFolder: evaluate(pickFolder, { isSessionsWindow: true }),
			editorWorkbenchOpenFileFolder: evaluate(openFileFolder, editorMac),
			agentsWindowOpenFileFolder: evaluate(openFileFolder, agentsMac),
			openFolderWhenHidesInSessions: evaluate(openFolder, { openFolderWorkspaceSupport: true, isSessionsWindow: true }) === false
				&& evaluate(openFolder, { openFolderWorkspaceSupport: true }) === true,
		}, {
			editorWorkbenchUntitledFile: true,
			agentsWindowUntitledFile: false,
			editorWorkbenchNewSession: false,
			agentsWindowNewSession: true,
			editorWorkbenchPickFolder: false,
			agentsWindowPickFolder: true,
			editorWorkbenchOpenFileFolder: true,
			agentsWindowOpenFileFolder: false,
			openFolderWhenHidesInSessions: true,
		});
	});

	test('Cmd+O opens New Session in Folder only in the Agents window', () => {
		const pickFolder = bindingsFor(CMD_O).find(item => item.command === NEW_SESSION_PICK_FOLDER_ACTION_ID)!;
		const openFileFolder = bindingsFor(CMD_O).find(item => item.command === OpenFileFolderAction.ID)!;
		const evaluate = (rule: { when?: { evaluate(ctx: IContext): boolean } | null }, values: Record<string, boolean | string>) => rule.when?.evaluate(context(values)) ?? true;

		const macEditor = { isMacNative: true, openFolderWorkspaceSupport: true };
		assert.deepStrictEqual({
			winsOverOpenFileFolder: pickFolder.weight1 > openFileFolder.weight1 && pickFolder.weight1 > KeybindingWeight.WorkbenchContrib,
			pickFolderWhen: pickFolder.when?.serialize(),
			openFileFolderWhenIncludesSessionsNegation: openFileFolder.when?.serialize()?.includes('!isSessionsWindow'),
			pickFolderInEditorWorkbench: evaluate(pickFolder, {}),
			pickFolderInAgentsWindow: evaluate(pickFolder, { isSessionsWindow: true }),
			openFileFolderInEditorWorkbench: evaluate(openFileFolder, macEditor),
			openFileFolderInAgentsWindow: evaluate(openFileFolder, { ...macEditor, isSessionsWindow: true }),
			cmdOIsNotNewSession: bindingsFor(CMD_O).every(item => item.command !== NEW_SESSION_ACTION_ID),
		}, {
			winsOverOpenFileFolder: true,
			pickFolderWhen: 'isSessionsWindow',
			openFileFolderWhenIncludesSessionsNegation: true,
			pickFolderInEditorWorkbench: false,
			pickFolderInAgentsWindow: true,
			openFileFolderInEditorWorkbench: true,
			openFileFolderInAgentsWindow: false,
			cmdOIsNotNewSession: true,
		});
	});
});
