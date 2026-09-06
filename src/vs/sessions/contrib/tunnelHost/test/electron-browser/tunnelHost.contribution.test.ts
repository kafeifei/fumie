/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import type { ContextKeyExpression, ContextKeyValue } from '../../../../../platform/contextkey/common/contextkey.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext, RemoteNameContext } from '../../../../../workbench/common/contextkeys.js';
import { ITunnelHostService } from '../../../../../workbench/contrib/chat/common/tunnelHost.js';
import { Menus } from '../../../../browser/menus.js';
import { SharingIntentTunnelHostService } from '../../electron-browser/tunnelHostSharingRestore.js';

import '../../electron-browser/tunnelHost.contribution.js';

suite('Sessions - Tunnel Host Contribution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * The wrapper only reaches callers if its registration is the last one for
	 * `ITunnelHostService`, which it is because this module imports upstream's
	 * contribution — an ordering nothing else states out loud.
	 */
	test('the recording tunnel host is the registration that wins', () => {
		const registered = getSingletonServiceDescriptors().filter(([id]) => id === ITunnelHostService);

		assert.ok(registered.length > 1, 'expected to be overriding an upstream registration');
		assert.strictEqual(registered[registered.length - 1][1].ctor, SharingIntentTunnelHostService);
	});

	test('remote connections toggle is in Agents titlebar and non-Agents chat input', () => {
		const findToggle = (menu: MenuId) => MenuRegistry.getMenuItems(menu)
			.filter(isIMenuItem)
			.find(item => item.command.id === 'sessions.tunnelHost.toggleSharing');

		const summarize = (menu: MenuId) => {
			const item = findToggle(menu);
			return item && {
				group: item.group,
				order: item.order,
				icon: ThemeIcon.isThemeIcon(item.command.icon) ? item.command.icon.id : undefined,
			};
		};

		assert.deepStrictEqual({
			titlebar: summarize(Menus.TitleBarRightLayout),
			chatInput: summarize(MenuId.ChatInputSecondary),
		}, {
			titlebar: { group: 'navigation', order: 90, icon: Codicon.radioTower.id },
			chatInput: { group: 'navigation', order: 10, icon: Codicon.radioTower.id },
		});

		const titlebarToggle = findToggle(Menus.TitleBarRightLayout);
		const chatInputToggle = findToggle(MenuId.ChatInputSecondary);
		if (!titlebarToggle?.when || !chatInputToggle?.when) {
			assert.fail('remote connections menu items should have when clauses');
		}

		const evalWhen = (when: ContextKeyExpression, values: Record<string, ContextKeyValue>) => {
			return when.evaluate({ getValue: <T extends ContextKeyValue = ContextKeyValue>(key: string) => values[key] as T });
		};
		const agentHostChat = {
			[ChatContextKeys.enabled.key]: true,
			[ChatContextKeys.chatIsAgentHostSession.key]: true,
			[IsAuxiliaryWindowContext.key]: false,
			[RemoteNameContext.key]: '',
		};

		assert.deepStrictEqual({
			agentsTitlebar: evalWhen(titlebarToggle.when, { ...agentHostChat, [IsSessionsWindowContext.key]: true }),
			editorTitlebar: evalWhen(titlebarToggle.when, { ...agentHostChat, [IsSessionsWindowContext.key]: false }),
			agentsChatInput: evalWhen(chatInputToggle.when, { ...agentHostChat, [IsSessionsWindowContext.key]: true }),
			editorChatInput: evalWhen(chatInputToggle.when, { ...agentHostChat, [IsSessionsWindowContext.key]: false }),
			remoteEditorChatInput: evalWhen(chatInputToggle.when, { ...agentHostChat, [IsSessionsWindowContext.key]: false, [RemoteNameContext.key]: 'ssh-remote' }),
		}, {
			agentsTitlebar: true,
			editorTitlebar: false,
			agentsChatInput: false,
			editorChatInput: true,
			remoteEditorChatInput: false,
		});
	});
});
