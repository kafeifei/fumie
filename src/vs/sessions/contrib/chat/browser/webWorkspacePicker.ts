/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { AgentHostFilterScope, IAgentHostFilterService } from '../../../services/agentHostFilter/common/agentHostFilter.js';
import { isAgentHostProviderId, LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { IWorkspacePickerItem, IWorkspacePickerOptions, WorkspacePicker } from './sessionWorkspacePicker.js';
import { showMobileWorkspacePickerSheet, shouldUseMobileWorkspacePickerSheet } from './mobile/mobileWorkspacePickerSheet.js';

/**
 * Whether a workspace provider belongs to the given machine scope. The `all`
 * scope takes every agent-host provider — on web, where this picker lives,
 * that is the union of the known remote hosts — so the picker keeps working
 * when the user is not scoped to a single machine.
 */
export function isProviderInMachineScope(scope: AgentHostFilterScope, providerId: string): boolean {
	if (scope.kind === 'host') {
		return providerId === scope.providerId;
	}
	if (scope.kind === 'local') {
		return providerId === LOCAL_AGENT_HOST_PROVIDER_ID;
	}
	return isAgentHostProviderId(providerId);
}

/**
 * Web variant of {@link WorkspacePicker} for the Agents window's
 * vscode.dev / insiders.vscode.dev surface. Two responsibilities on
 * top of the desktop picker:
 *
 *  1. Scopes its contents to the machine scope of the agent host filter —
 *     recent workspaces of the in-scope hosts plus one "Select Folder..."
 *     entry per host that can browse. In the "All Machines" scope every
 *     agent-host provider qualifies.
 *  2. On phone-layout viewports renders the picker as a bottom sheet
 *     (via `showMobileWorkspacePickerSheet`) instead of the desktop
 *     action-widget popup. Falls through to `super.showPicker()` on
 *     non-phone viewports, so a single instance works correctly
 *     across rotation across the phone breakpoint.
 */
export class WebWorkspacePicker extends WorkspacePicker {

	constructor(
		options: IWorkspacePickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@ISessionsRecentWorkspacesService recentWorkspacesService: ISessionsRecentWorkspacesService,
		@IRemoteAgentHostService remoteAgentHostService: IRemoteAgentHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileDialogService fileDialogService: IFileDialogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotificationService notificationService: INotificationService,
		@IAgentHostFilterService private readonly _agentHostFilterService: IAgentHostFilterService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super(
			{
				...options,
				sessionWorkspaceProviderFilter: providerId => isProviderInMachineScope(_agentHostFilterService.scope, providerId),
			},
			actionWidgetService,
			uriIdentityService,
			sessionsProvidersService,
			recentWorkspacesService,
			remoteAgentHostService,
			configurationService,
			commandService,
			menuService,
			contextKeyService,
			instantiationService,
			fileDialogService,
			telemetryService,
			notificationService,
		);

		// When the machine scope changes, if the current selection no longer
		// belongs to it, reset it: prefer the most recent workspace in the
		// new scope, otherwise clear the selection.
		this._register(this._agentHostFilterService.onDidChange(() => this._onScopedHostChanged()));
	}

	protected override _showTabs(): boolean {
		// The picker is already filtered to the machine scope — the
		// categorical tab bar would be redundant.
		return false;
	}

	override showPicker(): void {
		if (!this._triggerElement) {
			return;
		}
		// On phone, render the picker as a bottom sheet instead of the
		// desktop action-widget popup. Falls through to `super` on non-
		// phone viewports so a single instance handles both desktop
		// browsers and rotation across the phone breakpoint.
		if (!shouldUseMobileWorkspacePickerSheet(this._layoutService)) {
			super.showPicker();
			return;
		}
		const items = this._buildItems();
		showMobileWorkspacePickerSheet(
			this._layoutService,
			this._triggerElement,
			items,
			item => this._dispatchPickerItem(item),
			this._getAllBrowseActions(),
		);
	}

	private _onScopedHostChanged(): void {
		const currentResolved = this.selectedResolved;
		if (currentResolved && this._isInScope(currentResolved.providerId)) {
			this._onDidChangeSelection.fire();
			return;
		}

		this._resetAutomaticSelection();
	}

	/** Whether a registered provider is part of the current machine scope. */
	private _isInScope(providerId: string): boolean {
		return isProviderInMachineScope(this._agentHostFilterService.scope, providerId)
			&& !!this.sessionsProvidersService.getProvider(providerId);
	}

	protected override _buildItems(): IActionListItem<IWorkspacePickerItem>[] {
		const items: IActionListItem<IWorkspacePickerItem>[] = [];

		// 1. Recent workspaces of every in-scope provider
		const recents = this._getRecentWorkspaces().filter(w => this._isInScope(w.providerId));
		for (const { workspace, providerId } of recents) {
			const folderUri = workspace.folders[0]?.root;
			if (!folderUri) {
				continue;
			}
			const checked = this._isSelectedFolder(folderUri);
			items.push({
				kind: ActionListItemKind.Action,
				label: workspace.label,
				description: workspace.description,
				group: { title: '', icon: workspace.icon },
				item: { folderUri, providerId, checked: checked || undefined },
				onRemove: () => this._removeRecentWorkspace(folderUri),
			});
		}

		// 2. "Select Folder..." — dispatches each in-scope provider's first
		// browse action. One entry per provider: in a single-host scope that
		// is the host's own browse action, in the "All Machines" scope one
		// per host, disambiguated by the provider name.
		const browseEntries: { readonly index: number; readonly providerId: string }[] = [];
		const seenProviders = new Set<string>();
		this._getAllBrowseActions().forEach((action, index) => {
			if (seenProviders.has(action.providerId)
				|| !this._isInScope(action.providerId)
				|| this._isProviderUnavailable(action.providerId)) {
				return;
			}
			seenProviders.add(action.providerId);
			browseEntries.push({ index, providerId: action.providerId });
		});

		if (browseEntries.length > 0 && items.length > 0) {
			items.push({ kind: ActionListItemKind.Separator, label: '' });
		}
		for (const { index, providerId } of browseEntries) {
			items.push({
				kind: ActionListItemKind.Action,
				label: localize('scopedWorkspacePicker.selectFolder', "Select Folder..."),
				description: browseEntries.length > 1
					? this.sessionsProvidersService.getProvider(providerId)?.label
					: undefined,
				group: { title: '', icon: Codicon.folderOpened },
				item: { browseActionIndex: index },
			});
		}

		return items;
	}
}
