/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Menus } from '../../../../browser/menus.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { closeAgentSettingsOverlay, CLOSE_AGENT_SETTINGS_COMMAND_ID, customizationNavId, CUSTOMIZATION_OVERVIEW_SECTION, OPEN_AGENT_SETTINGS_COMMAND_ID } from '../../browser/agentSettings.js';
import '../../browser/agentSettings.contribution.js';

suite('Sessions - Agent Settings contribution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('account menu opens Agents Settings, not VS Code Preferences', () => {
		const settings = MenuRegistry.getMenuItems(Menus.AccountMenu)
			.filter(isIMenuItem)
			.find(item => item.command.id === OPEN_AGENT_SETTINGS_COMMAND_ID);

		if (!settings) {
			assert.fail('expected Account menu Settings item');
		}
		assert.strictEqual(typeof settings.command.title === 'string' ? settings.command.title : settings.command.title.value, 'Settings');
		assert.ok(!MenuRegistry.getMenuItems(Menus.AccountMenu)
			.filter(isIMenuItem)
			.some(item => item.command.id === 'workbench.action.openSettings'));
	});

	test('sidebar footer contributes the Settings entry instead of the title bar', () => {
		const settings = MenuRegistry.getMenuItems(Menus.SidebarFooter)
			.filter(isIMenuItem)
			.find(item => item.command.id === OPEN_AGENT_SETTINGS_COMMAND_ID);
		assert.ok(settings);
		assert.deepStrictEqual({ group: settings.group, order: settings.order }, { group: 'navigation', order: 2 });
		assert.ok((settings.when?.serialize() ?? '').includes(`!${IsPhoneLayoutContext.key}`));
		assert.ok(!MenuRegistry.getMenuItems(Menus.TitleBarRightLayout)
			.filter(isIMenuItem)
			.some(item => item.command.id === OPEN_AGENT_SETTINGS_COMMAND_ID));
	});

	test('open command opens the Settings overlay and forwards the nav id', () => {
		const opened: (string | undefined)[] = [];
		const command = CommandsRegistry.getCommand(OPEN_AGENT_SETTINGS_COMMAND_ID);
		if (!command) {
			assert.fail('expected sessions.settings.open command');
		}
		const accessor = {
			get: () => ({
				open: (navId?: string) => opened.push(navId),
			}),
		} as ServicesAccessor;
		command.handler(accessor);
		command.handler(accessor, customizationNavId(CUSTOMIZATION_OVERVIEW_SECTION));
		command.handler(accessor, { not: 'a nav id' });

		assert.deepStrictEqual(opened, [undefined, customizationNavId(CUSTOMIZATION_OVERVIEW_SECTION), undefined]);
	});

	test('closeAgentSettingsOverlay runs the close command before revealing an editor', () => {
		const executed: string[] = [];
		closeAgentSettingsOverlay({
			executeCommand: (id: string) => {
				executed.push(id);
				return Promise.resolve();
			},
		} as ICommandService);
		assert.deepStrictEqual(executed, [CLOSE_AGENT_SETTINGS_COMMAND_ID]);
	});

	test('close keybindings are gated on overlay visibility, not DOM focus', () => {
		const items = KeybindingsRegistry.getDefaultKeybindings()
			.filter(item => item.command === CLOSE_AGENT_SETTINGS_COMMAND_ID);
		// Escape (primary) and Cmd+W (secondary) register as separate rules.
		assert.strictEqual(items.length, 2);
		for (const item of items) {
			const when = item.when?.serialize() ?? '';
			assert.ok(when.includes('agentSettingsOverlayVisible'), when);
			assert.ok(when.includes('!inQuickOpen'), when);
		}
	});
});
