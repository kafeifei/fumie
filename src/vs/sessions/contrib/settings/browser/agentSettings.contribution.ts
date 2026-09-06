/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { InQuickPickContextKey } from '../../../../workbench/browser/quickaccess.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { CLOSE_AGENT_SETTINGS_COMMAND_ID, OPEN_AGENT_SETTINGS_COMMAND_ID, type AgentSettingsNavId } from './agentSettings.js';
import { AgentSettingsOverlayVisibleContext, IAgentSettingsOverlayService } from './agentSettingsOverlayService.js';
// Registers the overlay singleton. Kept as a side-effect import because the
// declaration above deliberately lives in a module that pulls in nothing.
import './agentSettingsOverlay.js';

registerAction2(class OpenAgentSettingsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_AGENT_SETTINGS_COMMAND_ID,
			title: localize2('agentSettings.open', "Settings"),
			category: Categories.Preferences,
			icon: Codicon.settingsGear,
			f1: true,
			precondition: IsPhoneLayoutContext.negate(),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				primary: KeyMod.CtrlCmd | KeyCode.Comma,
				when: IsPhoneLayoutContext.negate(),
			},
			menu: [
				{
					id: Menus.AccountMenu,
					group: '2_settings',
					order: 1,
					when: IsPhoneLayoutContext.negate(),
				},
				{
					id: Menus.SidebarFooter,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext.negate()),
				},
			],
		});
	}

	run(accessor: ServicesAccessor, navId?: AgentSettingsNavId): void {
		accessor.get(IAgentSettingsOverlayService).open(typeof navId === 'string' ? navId : undefined);
	}
});

registerAction2(class CloseAgentSettingsAction extends Action2 {
	constructor() {
		super({
			id: CLOSE_AGENT_SETTINGS_COMMAND_ID,
			title: localize2('agentSettings.done', "Done"),
			icon: Codicon.check,
			keybinding: {
				// Focus-independent close: right after startup the workbench can
				// steal focus from the overlay, so a DOM Escape listener on the
				// panel would never fire. Quick Input keeps its own Escape.
				weight: KeybindingWeight.WorkbenchContrib + 50,
				primary: KeyCode.Escape,
				secondary: [KeyMod.CtrlCmd | KeyCode.KeyW],
				when: ContextKeyExpr.and(AgentSettingsOverlayVisibleContext, InQuickPickContextKey.toNegated()),
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAgentSettingsOverlayService).close();
	}
});
