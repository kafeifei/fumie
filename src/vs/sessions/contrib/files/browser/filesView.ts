/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/filesView.css';
import * as dom from '../../../../base/browser/dom.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IViewPaneLocationColors, IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { agentsPanelBackground } from '../../../common/theme.js';
import { ExplorerView } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { FilesFilter } from '../../../../workbench/contrib/files/browser/views/explorerViewer.js';
import { localize } from '../../../../nls.js';
import { IAction } from '../../../../base/common/actions.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { SyncChangesActionViewItem } from './syncChangesActionViewItem.js';
import { SessionsFilesFilter } from './sessionsFilesFilter.js';
import { SESSIONS_FILES_SHOW_HIDDEN_SETTING } from '../common/hiddenFiles.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';

const $ = dom.$;

export const SESSIONS_FILES_VIEW_ID = 'sessions.files.explorer';
export const SESSIONS_FILES_EMPTY_VIEW_ID = 'sessions.files.explorer.empty';

export class SessionsExplorerView extends ExplorerView {
	/**
	 * Keep the inspector tab labeled "Files". ExplorerView otherwise replaces
	 * the title with the workspace folder name, which doubles the pane chrome
	 * and makes the Files/Changes switch look like a VS Code Explorer section.
	 */
	override get title(): string {
		return localize('files', "Files");
	}

	override get singleViewPaneContainerTitle(): string {
		return localize('files', "Files");
	}

	protected override get primaryActionGroups(): string[] | undefined {
		return ['1_files'];
	}

	protected override createFilesFilter(): FilesFilter {
		return this.instantiationService.createInstance(SessionsFilesFilter);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SESSIONS_FILES_SHOW_HIDDEN_SETTING)) {
				void this.refresh(true);
			}
		}));
	}

	protected override getLocationBasedColors(): IViewPaneLocationColors {
		const colors = super.getLocationBasedColors();
		return {
			...colors,
			background: agentsPanelBackground,
			listOverrideStyles: {
				...colors.listOverrideStyles,
				listBackground: agentsPanelBackground,
			}
		};
	}

	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === 'sessions.files.action.syncChanges') {
			return this.instantiationService.createInstance(SyncChangesActionViewItem, action, options);
		}
		return super.createActionViewItem(action, options);
	}
}

export class SessionsExplorerEmptyView extends ViewPane {
	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const bodyContainer = dom.append(container, $('.files-empty-view-body'));
		const welcomeContainer = dom.append(bodyContainer, $('.files-empty-welcome'));

		const welcomeIcon = dom.append(welcomeContainer, $('.files-empty-welcome-icon'));
		welcomeIcon.appendChild(renderIcon(Codicon.files));
		welcomeIcon.setAttribute('aria-hidden', 'true');

		const welcomeTitle = dom.append(welcomeContainer, $('.files-empty-welcome-title'));
		welcomeTitle.textContent = localize('filesView.emptyTitle', "No folder yet");

		const welcomeMessage = dom.append(welcomeContainer, $('.files-empty-welcome-message'));
		welcomeMessage.textContent = localize('filesView.noFiles', "Pick a workspace to browse files here.");
	}
}
