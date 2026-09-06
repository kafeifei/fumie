/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type ComposerAttachKind = 'file' | 'image';

export const COMPOSER_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'] as const;

export const COMPOSER_IMAGE_ACCEPT = COMPOSER_IMAGE_EXTENSIONS.map(ext => `.${ext}`).join(',');

export function isComposerImagePath(path: string): boolean {
	return new RegExp(`\\.(${COMPOSER_IMAGE_EXTENSIONS.join('|')})$`, 'i').test(path);
}

export const IComposerFilePickerService = createDecorator<IComposerFilePickerService>('composerFilePickerService');

/**
 * OS file/image picker for the Agents composer's attach menu.
 *
 * Deliberately not {@link IFileDialogService}: `files.simpleDialog.enable` lets
 * that substitute the workbench overlay, and the composer must always show the
 * real OS picker — never Quick Pick or Simple File Dialog. The desktop
 * implementation lives in `electron-browser` because it needs Electron's
 * `showOpenDialog`; the web implementation below is the browser default.
 */
export interface IComposerFilePickerService {
	readonly _serviceBrand: undefined;

	/**
	 * Shows the OS picker and resolves with the picked files, or `undefined`
	 * when the user cancelled.
	 */
	pickFiles(kind: ComposerAttachKind): Promise<URI[] | undefined>;
}

/**
 * Web implementation: a hidden `<input type="file">`, which is still the OS
 * picker rather than a workbench overlay.
 */
export class HtmlComposerFilePickerService implements IComposerFilePickerService {

	declare readonly _serviceBrand: undefined;

	pickFiles(kind: ComposerAttachKind): Promise<URI[] | undefined> {
		return new Promise(resolve => {
			const input = getActiveWindow().document.createElement('input');
			input.type = 'file';
			input.multiple = true;
			if (kind === 'image') {
				input.accept = COMPOSER_IMAGE_ACCEPT;
			}
			input.style.display = 'none';
			getActiveWindow().document.body.appendChild(input);

			const finish = (uris: URI[] | undefined) => {
				input.remove();
				resolve(uris);
			};

			input.addEventListener('change', () => {
				const uris: URI[] = [];
				for (const file of Array.from(input.files ?? [])) {
					const path = getPathForFile(file);
					if (path) {
						uris.push(URI.file(path));
					}
				}
				finish(uris.length ? uris : undefined);
			});
			input.addEventListener('cancel', () => finish(undefined));
			input.click();
		});
	}
}

registerSingleton(IComposerFilePickerService, HtmlComposerFilePickerService, InstantiationType.Delayed);
