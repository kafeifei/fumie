/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { isProviderInMachineScope } from '../../browser/webWorkspacePicker.js';

suite('WebWorkspacePicker - machine scope', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a host scope takes that host only', () => {
		const scope = { kind: 'host', providerId: 'agenthost-a' } as const;
		assert.strictEqual(isProviderInMachineScope(scope, 'agenthost-a'), true);
		assert.strictEqual(isProviderInMachineScope(scope, 'agenthost-b'), false);
		assert.strictEqual(isProviderInMachineScope(scope, LOCAL_AGENT_HOST_PROVIDER_ID), false);
	});

	test('the all scope takes every agent host provider', () => {
		const scope = { kind: 'all' } as const;
		assert.strictEqual(isProviderInMachineScope(scope, 'agenthost-a'), true);
		assert.strictEqual(isProviderInMachineScope(scope, 'agenthost-b'), true);
		assert.strictEqual(isProviderInMachineScope(scope, LOCAL_AGENT_HOST_PROVIDER_ID), true);
		// Providers that are not agent hosts (e.g. the Copilot cloud
		// provider) have no machine of their own to scope to.
		assert.strictEqual(isProviderInMachineScope(scope, 'default-copilot'), false);
	});

	test('the local scope takes the local agent host', () => {
		const scope = { kind: 'local' } as const;
		assert.strictEqual(isProviderInMachineScope(scope, LOCAL_AGENT_HOST_PROVIDER_ID), true);
		assert.strictEqual(isProviderInMachineScope(scope, 'agenthost-a'), false);
	});
});
