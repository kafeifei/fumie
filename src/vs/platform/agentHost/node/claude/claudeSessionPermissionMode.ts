/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import { type ClaudePermissionMode, ClaudeSessionConfigKey, narrowClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { claudePermissionModeForTier, narrowPermissionTier } from '../../common/fumiePermissionTiers.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Translate a session-config bag into the SDK's `PermissionMode` union
 * (5/6 values, excluding `dontAsk`; sdk.d.ts:1560). The platform
 * {@link SessionConfigKey.AutoApprove} tier is authoritative; a bag that
 * still carries only the legacy `permissionMode` key (sessions persisted
 * before the tier switch, or a provider-native injection) is narrowed
 * directly. Returns `undefined` when neither key is present or usable —
 * callers pick the fallback (the create-time intent at materialize,
 * `'default'` at the canUseTool gate, etc.).
 */
export function claudePermissionModeFromValues(values: Record<string, unknown> | undefined): ClaudePermissionMode | undefined {
	const tier = narrowPermissionTier(values?.[SessionConfigKey.AutoApprove]);
	return tier !== undefined
		? claudePermissionModeForTier(tier)
		: narrowClaudePermissionMode(values?.[ClaudeSessionConfigKey.PermissionMode]);
}

/**
 * Read the live permission mode for a session from
 * {@link IAgentConfigurationService}.
 *
 * Called on every canUseTool entry, on every rebind, and before each
 * `session.send` so a mid-turn `SessionConfigChanged` action wins over
 * the materialize-time seed (plan S3.6).
 */
export function readClaudePermissionMode(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
): ClaudePermissionMode | undefined {
	return claudePermissionModeFromValues(configurationService.getSessionConfigValues(sessionUri.toString()));
}
