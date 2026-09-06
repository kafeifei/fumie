/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, isISubmenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { Menus } from '../../../../browser/menus.js';
import { NEW_SESSION_ACTION_ID } from '../../../chat/common/constants.js';
import '../../browser/views/sessionsViewActions.js';

suite('Sessions - WORKSPACES header actions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders New Chat, Search and Filter, in that order', () => {
		const entries = MenuRegistry.getMenuItems(Menus.SidebarSessionsHeader)
			.filter(item => item.group === 'navigation')
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
			.map(item => {
				if (isIMenuItem(item)) {
					return { id: item.command.id, icon: item.command.icon };
				}
				return { id: isISubmenuItem(item) ? item.submenu.id : '', icon: item.icon };
			});

		assert.deepStrictEqual(entries, [
			{ id: NEW_SESSION_ACTION_ID, icon: Codicon.add },
			{ id: 'sessionsViewPane.find', icon: Codicon.search },
			{ id: 'SessionsViewPaneFilterSubMenu', icon: Codicon.filter },
		]);
	});
});
