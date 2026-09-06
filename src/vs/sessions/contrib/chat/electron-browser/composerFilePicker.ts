/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { COMPOSER_IMAGE_EXTENSIONS, ComposerAttachKind, IComposerFilePickerService } from '../browser/composerFilePicker.js';

/**
 * Desktop implementation of {@link IComposerFilePickerService}. Goes straight to
 * Electron's `showOpenDialog` so `files.simpleDialog.enable` cannot substitute
 * the workbench overlay. Overrides the browser default registered in
 * `browser/composerFilePicker.ts`.
 */
export class NativeComposerFilePickerService implements IComposerFilePickerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) { }

	async pickFiles(kind: ComposerAttachKind): Promise<URI[] | undefined> {
		const result = await this.nativeHostService.showOpenDialog({
			title: kind === 'image'
				? localize('sessions.composer.pickImage', "Select Image")
				: localize('sessions.composer.pickFile', "Select File"),
			filters: kind === 'image'
				? [{ name: localize('sessions.composer.images', "Images"), extensions: [...COMPOSER_IMAGE_EXTENSIONS] }]
				: undefined,
			properties: ['openFile', 'multiSelections', 'treatPackageAsDirectory'],
			targetWindowId: getActiveWindow().vscodeWindowId,
		});
		if (result.canceled || result.filePaths.length === 0) {
			return undefined;
		}
		return result.filePaths.map(URI.file);
	}
}

registerSingleton(IComposerFilePickerService, NativeComposerFilePickerService, InstantiationType.Delayed);
