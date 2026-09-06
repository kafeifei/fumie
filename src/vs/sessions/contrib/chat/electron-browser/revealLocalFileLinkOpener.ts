/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IOpenerService, OpenOptions } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { REVEAL_LOCAL_FILE_LINK_OPENER_ID } from '../browser/sessionsChatMarkdownRenderer.js';

/**
 * Makes plain `file://` links in Chat markdown reveal the target in the OS file
 * manager (Finder / Explorer) instead of falling through to the editor opener.
 * Files are selected in their parent folder. Non-empty folders are shown by
 * revealing their first child; empty folders are selected in their parent
 * because `showItemInFolder` cannot enter an empty folder.
 *
 * The Agents ChatWidget's scoped markdown renderer gives these opens a
 * contribution-specific marker. Generic markdown, programmatic URI opens
 * (attachments, artifacts, editor navigation), and custom action handlers
 * deliberately fall through. Selection fragments (e.g. `#L10`) also keep the
 * default editor behavior.
 */
export class RevealLocalFileLinkOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = REVEAL_LOCAL_FILE_LINK_OPENER_ID;

	constructor(
		@IOpenerService private readonly _openerService: IOpenerService,
		@IFileService private readonly _fileService: IFileService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
	) {
		super();
		this._register(this._openerService.registerOpener({
			open: async (target, options) => this._open(target, options),
		}));
	}

	private async _open(target: URI | string, options?: OpenOptions): Promise<boolean> {
		if (
			typeof target !== 'string'
			|| options?.fromUserGesture !== true
			|| options.allowContributedOpeners !== RevealLocalFileLinkOpenerContribution.ID
			|| options.allowCommands !== false
			|| options.fromWorkspace === true
			|| options.openExternal === true
			|| options.openToSide === true
			|| options.editorOptions !== undefined
		) {
			return false;
		}

		let uri: URI;
		try {
			uri = URI.parse(target);
		} catch {
			return false;
		}
		if (uri.scheme !== Schemas.file || uri.fragment) {
			return false;
		}

		let isDirectory: boolean;
		try {
			isDirectory = (await this._fileService.stat(uri)).isDirectory;
		} catch {
			return false;
		}

		try {
			await this._revealInOS(uri, isDirectory);
			return true;
		} catch {
			// Let the remaining openers handle the target if the native reveal
			// failed instead of aborting the entire opener chain.
			return false;
		}
	}

	private async _revealInOS(uri: URI, isDirectory: boolean): Promise<void> {
		if (isDirectory) {
			// Revealing a child entry makes the OS file manager open the
			// folder itself; an empty folder can only be revealed from its
			// parent. (`shell.openExternal` on a directory URI is silently
			// dropped on recent macOS.)
			const child = await this._fileService.resolve(uri).then(s => s.children?.[0], () => undefined);
			await this._nativeHostService.showItemInFolder(child ? child.resource.fsPath : uri.fsPath);
		} else {
			await this._nativeHostService.showItemInFolder(uri.fsPath);
		}
	}
}
