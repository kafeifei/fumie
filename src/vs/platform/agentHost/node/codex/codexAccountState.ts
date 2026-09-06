/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ICodexAccountRateLimitInfo, ICodexAccountRateLimits } from '../../common/codexAccount.js';
import type { CodexUsageSource } from '../../common/agentHostCustomizationConfig.js';
import type { ProtectedResourceMetadata } from '../../common/state/protocol/common/state.js';
import type { GetAccountRateLimitsResponse } from './protocol/generated/v2/GetAccountRateLimitsResponse.js';
import type { GetAccountResponse } from './protocol/generated/v2/GetAccountResponse.js';
import type { RateLimitWindow } from './protocol/generated/v2/RateLimitWindow.js';

export interface ICodexAccountState {
	readonly usageSource: 'openai' | 'copilot';
	readonly status: 'unknown' | 'signedIn' | 'signedOut' | 'unavailable' | 'error';
	readonly authType?: 'chatgpt' | 'apiKey' | 'other';
	readonly email?: string;
	readonly planType?: string;
	readonly requiresOpenaiAuth?: boolean;
	readonly error?: string;
}

export function codexAccountStateFromResponse(response: GetAccountResponse): ICodexAccountState {
	if (response.account?.type === 'chatgpt') {
		return { usageSource: 'openai', status: 'signedIn', authType: 'chatgpt', email: response.account.email ?? undefined, planType: response.account.planType, requiresOpenaiAuth: response.requiresOpenaiAuth };
	}
	if (response.account?.type === 'apiKey') {
		return { usageSource: 'openai', status: 'unavailable', authType: 'apiKey', requiresOpenaiAuth: response.requiresOpenaiAuth };
	}
	if (response.account) {
		return { usageSource: 'openai', status: 'unavailable', authType: 'other', requiresOpenaiAuth: response.requiresOpenaiAuth };
	}
	return { usageSource: 'openai', status: response.requiresOpenaiAuth ? 'signedOut' : 'unavailable', requiresOpenaiAuth: response.requiresOpenaiAuth };
}

export function resolveCodexUsageSourceAfterAccountRead(source: CodexUsageSource, account: ICodexAccountState, hasConfiguredCustomProvider = false): CodexUsageSource {
	return source === 'openai' && account.status === 'signedOut' && !hasConfiguredCustomProvider ? 'copilot' : source;
}

export function codexAccountStateForUsageSource(source: CodexUsageSource, openAIAccount: ICodexAccountState): ICodexAccountState {
	return source === 'openai' ? openAIAccount : { ...openAIAccount, usageSource: 'copilot' };
}

export function codexProtectedResourcesForUsageSource(
	source: CodexUsageSource,
	copilotResource: ProtectedResourceMetadata,
	repoResource: ProtectedResourceMetadata,
): ProtectedResourceMetadata[] {
	return [
		source === 'openai' ? { ...copilotResource, required: false } : copilotResource,
		repoResource,
	];
}

function codexAccountRateLimitWindow(window: RateLimitWindow | null | undefined): ICodexAccountRateLimitInfo | undefined {
	if (!window || !Number.isFinite(window.usedPercent)) {
		return undefined;
	}
	return {
		usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
		windowDurationMins: window.windowDurationMins !== null && window.windowDurationMins > 0 ? window.windowDurationMins : undefined,
		resetsAt: window.resetsAt !== null && window.resetsAt > 0 ? window.resetsAt : undefined,
	};
}

/** Inputs to {@link shouldApplyCodexRateLimits}, captured at the call site. */
export interface ICodexRateLimitWriteContext {
	/** Generation stamped on the request whose response is being applied. */
	readonly requestGeneration: number;
	/** Newest generation issued so far. */
	readonly latestGeneration: number;
	/** Whether the connection is still the ready one that issued the request. */
	readonly connectionMatches: boolean;
	/** The account state as it stands now, after the round trip. */
	readonly account: ICodexAccountState;
	/** The account the request was issued for. */
	readonly accountEmail: string | undefined;
}

/**
 * Whether an `account/rateLimits/read` response may be written to the published
 * account. Account transitions and read-triggered refreshes overlap freely (three
 * refreshes inside two seconds is routine at startup) and the responses can land
 * out of order, so an older request must never overwrite a newer one's result —
 * on top of the connection/account checks, which only catch a *changed* account.
 */
export function shouldApplyCodexRateLimits(context: ICodexRateLimitWriteContext): boolean {
	return context.requestGeneration === context.latestGeneration
		&& context.connectionMatches
		&& context.account.status === 'signedIn'
		&& context.account.authType === 'chatgpt'
		&& context.account.email === context.accountEmail;
}

/** Names the window slots an accepted snapshot carried, for the refresh log. */
export function describeCodexRateLimitWindows(rateLimits: ICodexAccountRateLimits | undefined): string {
	if (!rateLimits) {
		return 'none';
	}
	const slots = [rateLimits.primary ? 'primary' : undefined, rateLimits.secondary ? 'secondary' : undefined].filter(slot => !!slot);
	return slots.length > 0 ? slots.join('+') : 'none';
}

/** Keep both windows the snapshot carries; the account panel renders one row per window it has. */
export function codexAccountRateLimitFromResponse(response: GetAccountRateLimitsResponse): ICodexAccountRateLimits | undefined {
	const codexSnapshot = response.rateLimitsByLimitId?.codex;
	const snapshot = codexSnapshot?.primary || codexSnapshot?.secondary ? codexSnapshot : response.rateLimits;
	const primary = codexAccountRateLimitWindow(snapshot.primary);
	const secondary = codexAccountRateLimitWindow(snapshot.secondary);
	if (!primary && !secondary) {
		return undefined;
	}
	return {
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}
