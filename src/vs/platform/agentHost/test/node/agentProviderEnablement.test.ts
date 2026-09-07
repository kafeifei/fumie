/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostClaudeEnabledConfigKey, AgentHostOpencodeEnabledConfigKey } from '../../common/agentHostSchema.js';
import { AgentHostClaudeAgentEnabledEnvVar, AgentHostOpencodeAgentEnabledEnvVar } from '../../common/agentService.js';
import type { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { registerProviderWhenEnabled } from '../../node/agentProviderEnablement.js';

suite('registerProviderWhenEnabled', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Minimal stand-in for the two members the gate uses: the root value it
	 * reads and the change event it re-checks on.
	 */
	function createConfigurationService(store: DisposableStore): IAgentConfigurationService & { setRootValue(key: string, value: unknown): void } {
		const onDidRootConfigChange = store.add(new Emitter<void>());
		const values = new Map<string, unknown>();
		return {
			onDidRootConfigChange: onDidRootConfigChange.event,
			getRootValue: (_schema: unknown, key: string) => values.get(key),
			setRootValue(key: string, value: unknown): void {
				values.set(key, value);
				onDidRootConfigChange.fire();
			},
		} as unknown as IAgentConfigurationService & { setRootValue(key: string, value: unknown): void };
	}

	test('registers immediately when the environment enables the provider', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: { [AgentHostOpencodeAgentEnabledEnvVar]: 'true' },
		}, () => registrations++));

		assert.strictEqual(registrations, 1);
	});

	test('registers when the root config turns the provider on later, and only once', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: { [AgentHostOpencodeAgentEnabledEnvVar]: 'false' },
		}, () => registrations++));
		assert.strictEqual(registrations, 0);

		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, true);
		assert.strictEqual(registrations, 1);

		// Nothing unregisters, so a later `false` neither unregisters nor lets a
		// following `true` register a second provider.
		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, false);
		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, true);
		assert.strictEqual(registrations, 1);
	});

	test('an explicit environment value keeps a provider off', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: { [AgentHostOpencodeAgentEnabledEnvVar]: 'false' },
		}, () => registrations++));
		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, false);

		assert.strictEqual(registrations, 0);
	});

	test('registers by default when the environment variable is absent', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostClaudeAgentEnabledEnvVar,
			rootConfigKey: AgentHostClaudeEnabledConfigKey,
			env: {},
		}, () => registrations++));

		assert.strictEqual(registrations, 1);
	});

	test('a provider registration failure does not block another provider', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		const errors: unknown[] = [];
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostClaudeAgentEnabledEnvVar,
			rootConfigKey: AgentHostClaudeEnabledConfigKey,
			env: {},
			onRegistrationError: error => errors.push(error),
		}, () => { throw new Error('Claude unavailable'); }));

		let opencodeRegistrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: {},
		}, () => opencodeRegistrations++));

		assert.strictEqual(errors.length, 1);
		assert.strictEqual(opencodeRegistrations, 1);
	});

	test('a saved disabled setting wins over the default when no environment value is supplied', () => {
		const store = disposables.add(new DisposableStore());
		const configurationService = createConfigurationService(store);
		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, false);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(configurationService, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: {},
		}, () => registrations++));
		assert.strictEqual(registrations, 0);
		configurationService.setRootValue(AgentHostOpencodeEnabledConfigKey, true);
		assert.strictEqual(registrations, 1);
	});

	test('a value persisted by the previous host lifetime does not outvote an explicit env "false"', () => {
		const store = disposables.add(new DisposableStore());
		const restored = createConfigurationService(store);
		// Restored from `agent-host-config.json` before any client connects.
		restored.setRootValue(AgentHostOpencodeEnabledConfigKey, true);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(restored, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: { [AgentHostOpencodeAgentEnabledEnvVar]: 'false' },
		}, () => registrations++));

		assert.strictEqual(registrations, 0);
	});

	test('a value persisted by the previous host lifetime still counts when no env var was forwarded', () => {
		const store = disposables.add(new DisposableStore());
		const restored = createConfigurationService(store);
		restored.setRootValue(AgentHostOpencodeEnabledConfigKey, true);
		let registrations = 0;
		store.add(registerProviderWhenEnabled(restored, {
			enabledEnvVar: AgentHostOpencodeAgentEnabledEnvVar,
			rootConfigKey: AgentHostOpencodeEnabledConfigKey,
			env: {},
		}, () => registrations++));

		assert.strictEqual(registrations, 1);
	});
});
