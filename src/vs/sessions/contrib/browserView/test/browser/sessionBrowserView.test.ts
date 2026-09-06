/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { IOpener, IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IEditorWillOpenEvent } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IBrowserViewOpenHandler, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { AGENTS_BROWSER_EDITOR_ID, AGENTS_BROWSER_EDITOR_TYPE_ID } from '../../../../common/agentsEmbeddedBrowser.js';
import { SessionBrowserViewController } from '../../browser/sessionBrowserView.js';

suite('SessionBrowserViewController', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const openers: IOpener[] = [];
		const openHandlers: IBrowserViewOpenHandler[] = [];
		const onWillOpenEditor = store.add(new Emitter<IEditorWillOpenEvent>());
		const onDidAddGroup = store.add(new Emitter<{ id: number; editors: readonly EditorInput[] }>());
		const onDidChangeSessions = store.add(new Emitter<{ removed: readonly { resource: URI }[] }>());
		const closed: { typeId?: string; groupId: number }[] = [];

		const openerService = new class extends mock<IOpenerService>() {
			override registerOpener(opener: IOpener) {
				openers.push(opener);
				return { dispose() { } };
			}
		}();
		const browserViewService = new class extends mock<IBrowserViewWorkbenchService>() {
			override registerOpenHandler(handler: IBrowserViewOpenHandler) {
				openHandlers.push(handler);
				return { dispose() { } };
			}
			override registerContextualFilter() {
				return { dispose() { } };
			}
			override getKnownBrowserViews() {
				return new Map();
			}
		}();
		const editorService = new class extends mock<IEditorService>() {
			override readonly onWillOpenEditor = onWillOpenEditor.event;
			override async closeEditor(identifier: { editor: { typeId?: string }; groupId: number }) {
				closed.push({ typeId: identifier.editor.typeId, groupId: identifier.groupId });
			}
		}();
		const editorGroupsService = new class extends mock<IEditorGroupsService>() {
			override readonly onDidAddGroup = onDidAddGroup.event as IEditorGroupsService['onDidAddGroup'];
			override readonly groups = [];
		}();
		const sessionsService = new class extends mock<ISessionsService>() {
			override readonly activeSession = constObservable(undefined);
		}();
		const sessionManagementService = new class extends mock<ISessionsManagementService>() {
			override readonly onDidChangeSessions = onDidChangeSessions.event as ISessionsManagementService['onDidChangeSessions'];
		}();

		const controller = store.add(new SessionBrowserViewController(
			sessionManagementService,
			sessionsService,
			browserViewService,
			editorService,
			editorGroupsService,
			openerService,
		));

		return { controller, openers, openHandlers, onWillOpenEditor, closed };
	}

	test('refuses to open a browser editor and swallows vscode-browser links', async () => {
		const harness = createHarness();

		assert.strictEqual(harness.openHandlers[0].shouldOpenEditor({} as never, { type: 'user' }, {}), false);
		assert.strictEqual(await harness.openers[0].open(URI.parse('vscode-browser:/page-1')), true);
		assert.strictEqual(await harness.openers[0].open(URI.parse('https://example.com')), false);
	});

	test('closes an embedded browser that still reaches the editor area', async () => {
		const harness = createHarness();
		const editor = {
			typeId: AGENTS_BROWSER_EDITOR_TYPE_ID,
			editorId: AGENTS_BROWSER_EDITOR_ID,
			resource: URI.parse('vscode-browser:/page-1'),
		} as unknown as EditorInput;

		harness.onWillOpenEditor.fire({ editor, groupId: 1 });
		await Promise.resolve();
		await Promise.resolve();

		assert.deepStrictEqual(harness.closed, [{ typeId: AGENTS_BROWSER_EDITOR_TYPE_ID, groupId: 1 }]);
	});

	test('does not close an ordinary file editor', async () => {
		const harness = createHarness();
		const editor = {
			typeId: 'workbench.editors.files.fileEditorInput',
			editorId: 'workbench.editors.files.fileEditorInput',
			resource: URI.file('/repo/a.ts'),
		} as unknown as EditorInput;

		harness.onWillOpenEditor.fire({ editor, groupId: 1 });
		await Promise.resolve();
		await Promise.resolve();

		assert.deepStrictEqual(harness.closed, []);
	});
});
