/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { RemoteAgentHostsEnabledSettingId } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import type { ContextKeyValue, IContext } from '../../../../../../platform/contextkey/common/contextkey.js';
import { Menus } from '../../../../../browser/menus.js';
import { SessionWorkspacePickerGroupContext } from '../../../../../common/contextkeys.js';
import { SESSION_WORKSPACE_GROUP_REMOTE } from '../../../../../services/sessions/common/session.js';
import { RemoteAgentHostCommandIds } from '../../browser/remoteAgentHostActions.js';

/**
 * A context in which every remote-agent-host entry point is otherwise
 * available: the feature is enabled and the workspace picker is on its Remote
 * tab. `isWeb` is a folded constant (see `CONSTANT_VALUES` in `contextkey.ts`),
 * so the web gate is already baked into the registered expressions — in the
 * browser test runner it is always on.
 */
const permissiveContext: IContext = {
	getValue: <T extends ContextKeyValue>(key: string) => ({
		[`config.${RemoteAgentHostsEnabledSettingId}`]: true,
		[SessionWorkspacePickerGroupContext.key]: SESSION_WORKSPACE_GROUP_REMOTE,
	} as Record<string, ContextKeyValue>)[key] as T | undefined,
};

function whenFor(menu: MenuId, commandId: string) {
	const item = MenuRegistry.getMenuItems(menu)
		.filter(isIMenuItem)
		.find(item => item.command.id === commandId);
	assert.ok(item, `expected ${commandId} in menu ${menu.id}`);
	assert.ok(item.when, `expected ${commandId} in menu ${menu.id} to carry a when clause`);
	return item.when;
}

suite('remote agent host actions — web gating', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// SSH is dialled from the client process over a raw socket, so the web
	// bundle registers `NullSSHRemoteAgentHostService`, whose methods throw.
	// The commands must not be offered there.
	const sshCommands = [
		RemoteAgentHostCommandIds.connectViaSSH,
		RemoteAgentHostCommandIds.addNewSSHHost,
		RemoteAgentHostCommandIds.configureSSHHosts,
	];

	test('SSH commands are hidden from the command palette in web', () => {
		for (const commandId of sshCommands) {
			assert.strictEqual(whenFor(MenuId.CommandPalette, commandId).evaluate(permissiveContext), false, commandId);
		}
	});

	test('SSH is hidden from the workspace picker in web', () => {
		assert.strictEqual(whenFor(Menus.SessionWorkspaceManage, RemoteAgentHostCommandIds.connectViaSSH).evaluate(permissiveContext), false);
	});

	// WSL shells out to a local `wsl.exe`. On a non-Windows client the platform
	// gate already hides it, so in this runner the assertion only proves that
	// the two gates together keep it out of the web UI.
	test('WSL is hidden from the command palette in web', () => {
		assert.strictEqual(whenFor(MenuId.CommandPalette, RemoteAgentHostCommandIds.connectViaWSL).evaluate(permissiveContext), false);
	});

	// The control: Dev Tunnel connect goes over a relay the browser can reach,
	// so it stays available and the context above is otherwise permissive.
	test('Dev Tunnel connect stays available in web', () => {
		assert.strictEqual(whenFor(Menus.SessionWorkspaceManage, RemoteAgentHostCommandIds.connectViaTunnel).evaluate(permissiveContext), true);
	});
});
