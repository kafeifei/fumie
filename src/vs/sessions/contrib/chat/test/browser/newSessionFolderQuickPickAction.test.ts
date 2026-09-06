/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { pickFolderAndOpenNewSession, pickNativeSessionFolder } from '../../browser/newSessionFolderQuickPickAction.js';

suite('New Session Folder Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens a new session for the folder chosen in the native dialog', async () => {
		const folderUri = URI.file('/repo');
		let opened: URI | undefined;
		await pickFolderAndOpenNewSession(
			upcastPartial<IFileDialogService>({ showOpenDialog: async () => [folderUri] }),
			upcastPartial<ISessionsService>({
				openNewSession: async options => {
					opened = options?.folderUri;
					return { session: undefined, trustDeclined: false };
				},
			}),
		);
		assert.strictEqual(opened?.toString(), folderUri.toString());
	});

	test('does nothing when the native dialog is cancelled', async () => {
		let opened = false;
		await pickFolderAndOpenNewSession(
			upcastPartial<IFileDialogService>({ showOpenDialog: async () => undefined }),
			upcastPartial<ISessionsService>({
				openNewSession: async () => {
					opened = true;
					return { session: undefined, trustDeclined: false };
				},
			}),
		);
		assert.strictEqual(opened, false);
	});

	test('returns the folder chosen in the native dialog', async () => {
		const folderUri = URI.file('/repo');
		const picked = await pickNativeSessionFolder(
			upcastPartial<IFileDialogService>({ showOpenDialog: async () => [folderUri] }),
		);
		assert.strictEqual(picked?.toString(), folderUri.toString());
	});
});
