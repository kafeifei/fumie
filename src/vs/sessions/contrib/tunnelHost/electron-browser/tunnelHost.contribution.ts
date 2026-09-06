/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService, type IActionViewItemFactory } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ITunnelHostService } from '../../../../workbench/contrib/chat/common/tunnelHost.js';
import { ToggleRemoteConnectionsActionViewItem } from '../../../../workbench/contrib/chat/electron-browser/toggleRemoteConnectionsActionViewItem.js';
import { TOGGLE_SHARING_ID, TUNNEL_HOST_SHARING_KEY } from '../../../../workbench/contrib/chat/electron-browser/tunnelHost.contribution.js';
import { TunnelHostService } from '../../../../workbench/contrib/chat/electron-browser/tunnelHostService.js';
import { Menus } from '../../../browser/menus.js';
import product from '../../../../platform/product/common/product.js';
import { ITunnelHostDelegate, SharingIntentTunnelHostService, TunnelHostRestoreSharingSettingId, TunnelHostSharingRestoreContribution } from './tunnelHostSharingRestore.js';

const remoteConnectionsUIEnabled = !product.sessionsMinimalShell || product.sessionsRemoteConnectionsUI === true;

if (remoteConnectionsUIEnabled) {
	// Sidebar footer, immediately left of the Settings gear (account widget is
	// order 1, the gear is order 2).
	MenuRegistry.appendMenuItem(Menus.SidebarFooter, {
		command: {
			id: TOGGLE_SHARING_ID,
			title: localize('toggleSharing', "Allow Remote Connections"),
			icon: Codicon.radioTower,
			toggled: ContextKeyExpr.equals(TUNNEL_HOST_SHARING_KEY, true),
		},
		group: 'navigation',
		order: 1.5,
		when: ContextKeyExpr.and(
			product.sessionsRemoteConnectionsUI === true ? undefined : ChatContextKeys.enabled,
			IsSessionsWindowContext,
			IsAuxiliaryWindowContext.toNegated(),
			IsPhoneLayoutContext.negate(),
		)
	});
}

class SessionsTunnelHostTitlebarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsTunnelHostTitlebar';

	constructor(
		@ITunnelHostService tunnelHostService: ITunnelHostService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();

		const viewItemFactory: IActionViewItemFactory = (action, _options, instantiationService) => {
			return instantiationService.createInstance(ToggleRemoteConnectionsActionViewItem, action);
		};
		this._register(actionViewItemService.register(Menus.SidebarFooter, TOGGLE_SHARING_ID, viewItemFactory, tunnelHostService.onDidChangeStatus));
	}
}

if (remoteConnectionsUIEnabled) {
	registerWorkbenchContribution2(SessionsTunnelHostTitlebarContribution.ID, SessionsTunnelHostTitlebarContribution, WorkbenchPhase.BlockRestore);

	// Take over `ITunnelHostService` so every caller of `startSharing` records
	// the user's intent. The upstream contribution imported above registers the
	// service it wraps, and its module body has already run by the time this
	// one does, so the last registration — this one — is the one the workbench
	// hands out.
	registerSingleton(ITunnelHostDelegate, TunnelHostService, InstantiationType.Delayed);
	registerSingleton(ITunnelHostService, SharingIntentTunnelHostService, InstantiationType.Delayed);

	// Gated on the same flag as the toggle: never re-expose the machine in a
	// shell that does not show the control that turns it back off.
	registerWorkbenchContribution2(TunnelHostSharingRestoreContribution.ID, TunnelHostSharingRestoreContribution, WorkbenchPhase.Eventually);

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		properties: {
			[TunnelHostRestoreSharingSettingId]: {
				type: 'boolean',
				description: localize('tunnelHost.restoreOnStartup', "Turn \"Allow Remote Connections\" back on at startup when it was on the last time this machine shared. Sharing hosts a dev tunnel that exposes this machine, so the restore only happens after you enabled it yourself, stops as soon as you turn it off, and never signs you in — if no tunnel credential is cached, sharing stays off until you enable it again."),
				default: true,
				scope: ConfigurationScope.APPLICATION,
				tags: ['usesOnlineServices'],
			},
		},
	});
}
