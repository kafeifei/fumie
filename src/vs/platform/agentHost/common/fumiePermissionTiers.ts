/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AutoApproveLevel } from './agentHostSchema.js';
import type { ClaudePermissionMode } from './claudeSessionConfigKeys.js';
import type { CodexPermissionsPreset } from './codexSessionConfigKeys.js';

/**
 * Fumie presents one permission tier set product-wide — the platform's
 * `default` / `assisted` / `autoApprove` ({@link AutoApproveLevel}) — and maps
 * it onto each agent's native permission model. This module is the ONLY place
 * those mappings live; agents call into it at their config read/write
 * boundaries instead of carrying their own translation tables.
 */

const CLAUDE_MODE_BY_TIER: Readonly<Record<AutoApproveLevel, ClaudePermissionMode>> = {
	default: 'default',
	assisted: 'acceptEdits',
	autoApprove: 'bypassPermissions',
};

const CODEX_PRESET_BY_TIER: Readonly<Record<AutoApproveLevel, CodexPermissionsPreset>> = {
	default: 'default',
	assisted: 'auto-review',
	autoApprove: 'full-access',
};

export function narrowPermissionTier(raw: unknown): AutoApproveLevel | undefined {
	switch (raw) {
		case 'default':
		case 'assisted':
		case 'autoApprove':
			return raw;
		default:
			return undefined;
	}
}

export function claudePermissionModeForTier(tier: AutoApproveLevel): ClaudePermissionMode {
	return CLAUDE_MODE_BY_TIER[tier];
}

/** Inverse of {@link claudePermissionModeForTier}; `plan`, `auto` and unknown values fold onto `default`. */
export function permissionTierForClaudeMode(raw: unknown): AutoApproveLevel {
	for (const tier of Object.keys(CLAUDE_MODE_BY_TIER) as AutoApproveLevel[]) {
		if (CLAUDE_MODE_BY_TIER[tier] === raw) {
			return tier;
		}
	}
	return 'default';
}

export function codexPermissionsPresetForTier(tier: AutoApproveLevel): CodexPermissionsPreset {
	return CODEX_PRESET_BY_TIER[tier];
}

/** Inverse of {@link codexPermissionsPresetForTier}; unknown values fold onto `default`. */
export function permissionTierForCodexPreset(raw: unknown): AutoApproveLevel {
	for (const tier of Object.keys(CODEX_PRESET_BY_TIER) as AutoApproveLevel[]) {
		if (CODEX_PRESET_BY_TIER[tier] === raw) {
			return tier;
		}
	}
	return 'default';
}
