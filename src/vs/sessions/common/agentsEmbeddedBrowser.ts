/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';

/** `BrowserEditorInput.typeId` — keep this string so common/ does not import workbench contrib. */
export const AGENTS_BROWSER_EDITOR_TYPE_ID = 'workbench.editorinputs.browser';

/** `BrowserEditorInput.EDITOR_ID` */
export const AGENTS_BROWSER_EDITOR_ID = 'workbench.editor.browser';

/** Simple Browser webview editor ids (extension view type and the main-thread wrapper). */
export const AGENTS_SIMPLE_BROWSER_EDITOR_IDS = new Set<string>([
	'simpleBrowser.view',
	'mainThreadWebview-simpleBrowser.view',
]);

export interface IAgentsEmbeddedBrowserEditorLike {
	readonly typeId?: string;
	readonly editorId?: string;
	readonly resource?: { readonly scheme: string } | undefined;
}

/**
 * True for the in-app browser surfaces that must not occupy the Agents
 * window editor area: the integrated `BrowserEditorInput`, Simple Browser
 * webviews, and any `vscode-browser:` resource.
 */
export function isAgentsEmbeddedBrowserEditor(editor: IAgentsEmbeddedBrowserEditorLike | undefined): boolean {
	if (!editor) {
		return false;
	}
	if (editor.typeId === AGENTS_BROWSER_EDITOR_TYPE_ID || editor.editorId === AGENTS_BROWSER_EDITOR_ID) {
		return true;
	}
	if (editor.editorId && AGENTS_SIMPLE_BROWSER_EDITOR_IDS.has(editor.editorId)) {
		return true;
	}
	return isAgentsEmbeddedBrowserResource(editor.resource);
}

export function isAgentsEmbeddedBrowserResource(resource: URI | { readonly scheme: string } | string | undefined): boolean {
	if (!resource) {
		return false;
	}
	if (typeof resource === 'string') {
		try {
			return URI.parse(resource).scheme === Schemas.vscodeBrowser;
		} catch {
			return false;
		}
	}
	return resource.scheme === Schemas.vscodeBrowser;
}
