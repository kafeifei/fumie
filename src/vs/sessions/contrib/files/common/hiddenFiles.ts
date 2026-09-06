/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Agents Files inspector: hidden/dotfiles are off by default, like Cursor. */
export const SESSIONS_FILES_SHOW_HIDDEN_SETTING = 'sessions.files.showHidden';

/**
 * Names Cursor-style Files trees hide unless "Show Hidden Files" is on.
 * Matches `.git`, `.env`, `.cursor`, `.DS_Store`, etc. — not `.` / `..`.
 */
export function isSessionsDotfileName(name: string): boolean {
	return name.startsWith('.') && name !== '.' && name !== '..';
}

/** True when the Agents Files tree should omit this entry (dotfile, not the workspace root). */
export function shouldHideSessionsDotfile(name: string, isRoot: boolean, showHidden: boolean): boolean {
	return !showHidden && !isRoot && isSessionsDotfileName(name);
}
