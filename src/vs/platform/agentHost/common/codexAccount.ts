/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RootState } from './state/protocol/state.js';

export const CODEX_ACCOUNT_META_KEY = 'vscode.codexAccount';
export const CODEX_ACCOUNT_SIGN_IN_REQUEST_KEY = 'vscode.codexAccount.signInRequest';
export const CODEX_ACCOUNT_SIGN_OUT_REQUEST_KEY = 'vscode.codexAccount.signOutRequest';

export interface ICodexAccountRateLimitInfo {
	readonly usedPercent: number;
	readonly windowDurationMins?: number;
	/** Unix epoch time in seconds, as the app-server reports it. */
	readonly resetsAt?: number;
}

/**
 * Both windows the app-server's rate-limit snapshot carries. Which duration
 * lands in which slot is the server's choice, so the label is derived from
 * `windowDurationMins` rather than from the slot.
 */
export interface ICodexAccountRateLimits {
	readonly primary?: ICodexAccountRateLimitInfo;
	readonly secondary?: ICodexAccountRateLimitInfo;
}

export interface ICodexAccountInfo {
	readonly status: 'unknown' | 'downloading' | 'signedIn' | 'signedOut' | 'unavailable' | 'error';
	readonly email?: string;
	readonly planType?: string;
	readonly requiresOpenaiAuth?: boolean;
	readonly rateLimit?: ICodexAccountRateLimits;
	readonly authUrl?: string;
	readonly authUrlNonce?: string;
}

function readRateLimitWindow(value: unknown): ICodexAccountRateLimitInfo | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const window = value as Partial<ICodexAccountRateLimitInfo>;
	if (typeof window.usedPercent !== 'number'
		|| !Number.isFinite(window.usedPercent)
		|| window.usedPercent < 0
		|| window.usedPercent > 100
		|| (window.windowDurationMins !== undefined && (typeof window.windowDurationMins !== 'number' || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0))
		|| (window.resetsAt !== undefined && (typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0))) {
		return undefined;
	}
	return {
		usedPercent: window.usedPercent,
		windowDurationMins: window.windowDurationMins,
		resetsAt: window.resetsAt,
	};
}

function readRateLimits(value: unknown): ICodexAccountRateLimits | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const limits = value as Partial<ICodexAccountRateLimits>;
	const primary = readRateLimitWindow(limits.primary);
	const secondary = readRateLimitWindow(limits.secondary);
	if (!primary && !secondary) {
		return undefined;
	}
	return {
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

export function readCodexAccountInfo(state: RootState | undefined): ICodexAccountInfo {
	// eslint-disable-next-line local/code-no-untyped-meta-access -- sanctioned reader for the namespaced Codex account slot; validated below.
	const metaValue = state?._meta?.[CODEX_ACCOUNT_META_KEY];
	const value = state?.config?.values[CODEX_ACCOUNT_META_KEY] ?? metaValue;
	if (!value || typeof value !== 'object') {
		return { status: 'unknown' };
	}
	const account = value as Partial<ICodexAccountInfo>;
	if (account.status !== 'unknown' && account.status !== 'downloading' && account.status !== 'signedIn' && account.status !== 'signedOut' && account.status !== 'unavailable' && account.status !== 'error') {
		return { status: 'unknown' };
	}
	return {
		status: account.status,
		email: typeof account.email === 'string' ? account.email : undefined,
		planType: typeof account.planType === 'string' ? account.planType : undefined,
		requiresOpenaiAuth: typeof account.requiresOpenaiAuth === 'boolean' ? account.requiresOpenaiAuth : undefined,
		rateLimit: readRateLimits(account.rateLimit),
		authUrl: typeof account.authUrl === 'string' ? account.authUrl : undefined,
		authUrlNonce: typeof account.authUrlNonce === 'string' ? account.authUrlNonce : undefined,
	};
}
