/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RootState } from './state/protocol/state.js';

export const CLAUDE_ACCOUNT_META_KEY = 'vscode.claudeAccount';

/**
 * Ask the Claude agent to run the CLI's own logout. The credential lives in the
 * system keychain and belongs to the CLI, so the only honest way to drop it is
 * to have the CLI do it — never by reaching into the keychain from here.
 */
export const CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY = 'vscode.claudeAccount.signOutRequest';

export interface IClaudeAccountRateLimitWindow {
	readonly usedPercent: number;
	/** Unix epoch time in milliseconds. */
	readonly resetsAt?: number;
}

/**
 * A per-model weekly window from the server's `limits[]` array. `displayName`
 * is the server-supplied bucket label (e.g. 'Fable') and is the only thing that
 * tells these windows apart, so a window without one is dropped.
 */
export interface IClaudeAccountModelScopedRateLimitWindow extends IClaudeAccountRateLimitWindow {
	readonly displayName: string;
}

export interface IClaudeAccountRateLimits {
	readonly fiveHour?: IClaudeAccountRateLimitWindow;
	readonly sevenDay?: IClaudeAccountRateLimitWindow;
	readonly sevenDayOpus?: IClaudeAccountRateLimitWindow;
	readonly sevenDaySonnet?: IClaudeAccountRateLimitWindow;
	readonly sevenDayOauthApps?: IClaudeAccountRateLimitWindow;
	readonly modelScoped?: readonly IClaudeAccountModelScopedRateLimitWindow[];
}

/**
 * Claude's native (first-party Anthropic) login as probed via the SDK's
 * `accountInfo()` during the model-catalog refresh. `signedIn` is only
 * published for a verified `apiProvider === 'firstParty'` login; a probe that
 * reaches the SDK but finds any other backing publishes `signedOut`. When the
 * probe cannot run at all (no local Claude setup), nothing is published and
 * the status stays `unknown`, so the UI never claims a sign-out it has not
 * observed.
 */
export interface IClaudeAccountInfo {
	readonly status: 'unknown' | 'signedIn' | 'signedOut';
	readonly email?: string;
	readonly organization?: string;
	readonly subscriptionType?: string;
	readonly rateLimits?: IClaudeAccountRateLimits;
}

function readRateLimitWindow(value: unknown): IClaudeAccountRateLimitWindow | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const window = value as Partial<IClaudeAccountRateLimitWindow>;
	if (typeof window.usedPercent !== 'number'
		|| !Number.isFinite(window.usedPercent)
		|| window.usedPercent < 0
		|| window.usedPercent > 100
		|| (window.resetsAt !== undefined && (typeof window.resetsAt !== 'number' || !Number.isFinite(window.resetsAt) || window.resetsAt <= 0))) {
		return undefined;
	}
	return {
		usedPercent: window.usedPercent,
		resetsAt: window.resetsAt,
	};
}

function readModelScopedRateLimits(value: unknown): readonly IClaudeAccountModelScopedRateLimitWindow[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const windows: IClaudeAccountModelScopedRateLimitWindow[] = [];
	for (const entry of value) {
		const window = readRateLimitWindow(entry);
		const displayName = (entry as Partial<IClaudeAccountModelScopedRateLimitWindow> | undefined)?.displayName;
		if (window && typeof displayName === 'string' && displayName.length > 0) {
			windows.push({ displayName, ...window });
		}
	}
	return windows.length > 0 ? windows : undefined;
}

function readRateLimits(value: unknown): IClaudeAccountRateLimits | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const limits = value as Partial<IClaudeAccountRateLimits>;
	const fiveHour = readRateLimitWindow(limits.fiveHour);
	const sevenDay = readRateLimitWindow(limits.sevenDay);
	const sevenDayOpus = readRateLimitWindow(limits.sevenDayOpus);
	const sevenDaySonnet = readRateLimitWindow(limits.sevenDaySonnet);
	const sevenDayOauthApps = readRateLimitWindow(limits.sevenDayOauthApps);
	const modelScoped = readModelScopedRateLimits(limits.modelScoped);
	if (!fiveHour && !sevenDay && !sevenDayOpus && !sevenDaySonnet && !sevenDayOauthApps && !modelScoped) {
		return undefined;
	}
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(sevenDayOpus ? { sevenDayOpus } : {}),
		...(sevenDaySonnet ? { sevenDaySonnet } : {}),
		...(sevenDayOauthApps ? { sevenDayOauthApps } : {}),
		...(modelScoped ? { modelScoped } : {}),
	};
}

export function readClaudeAccountInfo(state: RootState | undefined): IClaudeAccountInfo {
	// eslint-disable-next-line local/code-no-untyped-meta-access -- sanctioned reader for the namespaced Claude account slot; validated below.
	const metaValue = state?._meta?.[CLAUDE_ACCOUNT_META_KEY];
	const value = state?.config?.values[CLAUDE_ACCOUNT_META_KEY] ?? metaValue;
	if (!value || typeof value !== 'object') {
		return { status: 'unknown' };
	}
	const account = value as Partial<IClaudeAccountInfo>;
	if (account.status !== 'unknown' && account.status !== 'signedIn' && account.status !== 'signedOut') {
		return { status: 'unknown' };
	}
	return {
		status: account.status,
		email: typeof account.email === 'string' ? account.email : undefined,
		organization: typeof account.organization === 'string' ? account.organization : undefined,
		subscriptionType: typeof account.subscriptionType === 'string' ? account.subscriptionType : undefined,
		rateLimits: readRateLimits(account.rateLimits),
	};
}
