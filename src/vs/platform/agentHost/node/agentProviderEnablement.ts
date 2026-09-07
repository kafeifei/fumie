/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';
import { platformRootSchema, type AgentHostProviderEnabledConfigKey } from '../common/agentHostSchema.js';
import { isAgentEnabled } from '../common/agentService.js';
import type { IAgentConfigurationService } from './agentConfigurationService.js';

export interface IProviderEnablementOptions {
	/** Environment form of the setting, set by the starters when they spawn us. */
	readonly enabledEnvVar: string;
	/** Value to assume when the environment variable is absent or unparsable. */
	readonly enabledByDefault?: boolean;
	/** Root config key the renderer mirrors the same setting onto. */
	readonly rootConfigKey: AgentHostProviderEnabledConfigKey;
	/** Reports a provider-specific registration failure without stopping the host. */
	readonly onRegistrationError?: (error: unknown) => void;
	/** Test seam; defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Register-on-enable gate shared by every provider whose enable toggle takes
 * effect without restarting the agent host.
 *
 * Two inputs carry the same setting at different times: the starter's env var
 * holds the value this process was spawned with, and the renderer mirrors every
 * later change onto the root config (declared as `agentHost: { key }` on the
 * setting). Registration is one-way — nothing unregisters a provider — so
 * `register` runs at most once and disabling still needs a restart.
 *
 * At startup the root config is whatever the *previous* host lifetime persisted
 * to `agent-host-config.json`, so an explicit env var wins over it: otherwise a
 * stale `true` would outvote the `false` the starter just forwarded and the
 * restart meant to drop a disabled provider would keep registering it. Once the
 * connected client has pushed a config change the root config is live, and from
 * then on it is what enables the provider.
 *
 * Returns the root-config subscription; the caller owns its lifetime.
 */
export function registerProviderWhenEnabled(
	configurationService: IAgentConfigurationService,
	options: IProviderEnablementOptions,
	register: () => void,
): IDisposable {
	const env = options.env ?? process.env;
	let registered = false;
	let rootConfigIsLive = env[options.enabledEnvVar] === undefined;
	const registerIfEnabled = (): void => {
		if (registered) {
			return;
		}
		const rootValue = configurationService.getRootValue(platformRootSchema, options.rootConfigKey);
		const enabledByEnv = env[options.enabledEnvVar] === undefined
			? (typeof rootValue === 'boolean' ? rootValue : options.enabledByDefault ?? true)
			: isAgentEnabled(env[options.enabledEnvVar], options.enabledByDefault ?? true);
		const enabledByRootConfig = rootConfigIsLive && rootValue === true;
		if (!enabledByEnv && !enabledByRootConfig) {
			return;
		}
		registered = true;
		try {
			register();
		} catch (error) {
			options.onRegistrationError?.(error);
		}
	};
	registerIfEnabled();
	return configurationService.onDidRootConfigChange(() => {
		rootConfigIsLive = true;
		registerIfEnabled();
	});
}
