/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { AGENTS_BROWSER_EDITOR_ID, AGENTS_BROWSER_EDITOR_TYPE_ID, isAgentsEmbeddedBrowserEditor, isAgentsEmbeddedBrowserResource } from '../../common/agentsEmbeddedBrowser.js';

suite('agentsEmbeddedBrowser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes integrated browser, Simple Browser, and vscode-browser resources', () => {
		assert.deepStrictEqual({
			browserInput: isAgentsEmbeddedBrowserEditor({ typeId: AGENTS_BROWSER_EDITOR_TYPE_ID, editorId: AGENTS_BROWSER_EDITOR_ID }),
			simpleBrowser: isAgentsEmbeddedBrowserEditor({ editorId: 'simpleBrowser.view' }),
			simpleBrowserMainThread: isAgentsEmbeddedBrowserEditor({ editorId: 'mainThreadWebview-simpleBrowser.view' }),
			vscodeBrowserResource: isAgentsEmbeddedBrowserEditor({ resource: URI.parse('vscode-browser:/page-1') }),
			fileEditor: isAgentsEmbeddedBrowserEditor({ typeId: 'workbench.editors.files.fileEditorInput', editorId: 'workbench.editors.files.fileEditorInput', resource: URI.file('/repo/a.ts') }),
			missing: isAgentsEmbeddedBrowserEditor(undefined),
		}, {
			browserInput: true,
			simpleBrowser: true,
			simpleBrowserMainThread: true,
			vscodeBrowserResource: true,
			fileEditor: false,
			missing: false,
		});
	});

	test('swallows vscode-browser URIs and ignores other schemes', () => {
		assert.deepStrictEqual({
			uri: isAgentsEmbeddedBrowserResource(URI.parse('vscode-browser:/86072bb9-9d1d-4be8-b6cb-9d5c3b143ea2')),
			string: isAgentsEmbeddedBrowserResource('vscode-browser:/page-1?vscodeLinkType=browser'),
			https: isAgentsEmbeddedBrowserResource(URI.parse('https://status.openai.com')),
			empty: isAgentsEmbeddedBrowserResource(undefined),
		}, {
			uri: true,
			string: true,
			https: false,
			empty: false,
		});
	});
});
