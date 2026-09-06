/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TreeVisibility } from '../../../../base/browser/ui/tree/tree.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ExplorerItem } from '../../../../workbench/contrib/files/common/explorerModel.js';
import { IExplorerService } from '../../../../workbench/contrib/files/browser/files.js';
import { FilesFilter } from '../../../../workbench/contrib/files/browser/views/explorerViewer.js';
import { shouldHideSessionsDotfile, SESSIONS_FILES_SHOW_HIDDEN_SETTING } from '../common/hiddenFiles.js';

/**
 * Sessions Files tree filter: still honors `files.exclude`, and also hides
 * every dotfile unless {@link SESSIONS_FILES_SHOW_HIDDEN_SETTING} is on.
 * Does not change the editor-workbench Explorer.
 */
export class SessionsFilesFilter extends FilesFilter {

	constructor(
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IConfigurationService private readonly sessionsConfigurationService: IConfigurationService,
		@IExplorerService explorerService: IExplorerService,
		@IEditorService editorService: IEditorService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IFileService fileService: IFileService,
	) {
		super(contextService, sessionsConfigurationService, explorerService, editorService, uriIdentityService, fileService);
	}

	override filter(stat: ExplorerItem, parentVisibility: TreeVisibility): boolean {
		if (shouldHideSessionsDotfile(
			stat.name,
			stat.isRoot,
			this.sessionsConfigurationService.getValue<boolean>(SESSIONS_FILES_SHOW_HIDDEN_SETTING) === true,
		)) {
			return false;
		}
		return super.filter(stat, parentVisibility);
	}
}
