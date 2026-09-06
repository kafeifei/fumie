/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { IClaudeAccountModelScopedRateLimitWindow, IClaudeAccountRateLimits, IClaudeAccountRateLimitWindow } from '../../common/claudeAccount.js';

function normalizeUsedPercent(value: number | null | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(100, Math.max(0, value))
		: undefined;
}

function normalizeIsoResetAt(value: string | null | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const resetAt = Date.parse(value);
	return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
}

/**
 * SDK rate-limit events currently report a numeric reset timestamp without
 * declaring its unit. Accept both Unix seconds and milliseconds at this seam
 * and publish one stable account contract: Unix epoch milliseconds.
 */
function normalizeNumericResetAt(value: number | undefined): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * Optional sink for the per-window drop decisions this file makes. The chain is
 * otherwise silent, and a window the SDK reported with a `null` utilization is
 * indistinguishable in the panel from one the SDK never sent at all.
 */
export type ClaudeRateLimitTrace = (message: string) => void;

function fromUsageWindow(window: { readonly utilization: number | null; readonly resets_at: string | null } | null | undefined, name?: string, trace?: ClaudeRateLimitTrace): IClaudeAccountRateLimitWindow | undefined {
	const usedPercent = normalizeUsedPercent(window?.utilization);
	if (usedPercent === undefined) {
		if (window && name) {
			trace?.(`[Claude] Usage window '${name}' dropped: utilization is ${window.utilization === null ? 'null' : String(window.utilization)}`);
		}
		return undefined;
	}
	const resetsAt = normalizeIsoResetAt(window?.resets_at);
	return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

type SDKUsageRateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;

function fromModelScopedUsageWindows(windows: SDKUsageRateLimits['model_scoped'], trace?: ClaudeRateLimitTrace): readonly IClaudeAccountModelScopedRateLimitWindow[] | undefined {
	if (!windows?.length) {
		return undefined;
	}
	const modelScoped: IClaudeAccountModelScopedRateLimitWindow[] = [];
	for (const entry of windows) {
		const window = fromUsageWindow(entry, `model_scoped:${entry.display_name ?? 'unnamed'}`, trace);
		if (window && entry.display_name) {
			modelScoped.push({ displayName: entry.display_name, ...window });
		}
	}
	return modelScoped.length > 0 ? modelScoped : undefined;
}

/**
 * One-line summary of which plan-wide windows the SDK's `/usage` response
 * actually carried, for the log at the call site: `absent` (key not sent),
 * `null` (sent without a utilization, so dropped), or the utilization itself.
 *
 * Three no-window outcomes have to stay distinguishable in the log, because
 * they have different causes: no response at all (`none`), a response whose
 * `rate_limits` is missing entirely (`rate_limits=null` — the CLI never
 * fetched `/usage`, or the fetch failed), and a `rate_limits` object that is
 * present but carries nothing usable (every key reported `absent`/`null`).
 */
export function describeClaudeUsageWindows(response: SDKControlGetUsageResponse | undefined): string {
	if (!response) {
		return 'none';
	}
	const rateLimits = response.rate_limits;
	if (!rateLimits) {
		return 'rate_limits=null';
	}
	const keys = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const;
	const described = keys.map(key => {
		const window = rateLimits[key];
		if (!window) {
			return `${key}=absent`;
		}
		return `${key}=${normalizeUsedPercent(window.utilization) ?? 'null'}`;
	});
	described.push(`model_scoped=${rateLimits.model_scoped?.length ?? 0}`);
	return described.join(' ');
}

/**
 * Convert the SDK's experimental structured `/usage` response to account chrome
 * state.
 *
 * The two halves of the guard mean different things. `rate_limits_available`
 * is a *plan predicate* — whether this account has plan-wide windows at all —
 * not a statement about the payload. A response can therefore report
 * `rate_limits_available: true` with `rate_limits: null`, which means the CLI
 * never fetched `/usage` (for example under
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) or the fetch failed, not that
 * the account has no limits. Either way there is nothing to publish, so both
 * yield `undefined`; {@link describeClaudeUsageWindows} keeps them apart in
 * the log.
 */
export function claudeRateLimitsFromUsage(response: SDKControlGetUsageResponse | undefined, trace?: ClaudeRateLimitTrace): IClaudeAccountRateLimits | undefined {
	if (!response?.rate_limits_available || !response.rate_limits) {
		return undefined;
	}
	const fiveHour = fromUsageWindow(response.rate_limits.five_hour, 'five_hour', trace);
	const sevenDay = fromUsageWindow(response.rate_limits.seven_day, 'seven_day', trace);
	const sevenDayOpus = fromUsageWindow(response.rate_limits.seven_day_opus, 'seven_day_opus', trace);
	const sevenDaySonnet = fromUsageWindow(response.rate_limits.seven_day_sonnet, 'seven_day_sonnet', trace);
	const sevenDayOauthApps = fromUsageWindow(response.rate_limits.seven_day_oauth_apps, 'seven_day_oauth_apps', trace);
	const modelScoped = fromModelScopedUsageWindows(response.rate_limits.model_scoped, trace);
	return fiveHour || sevenDay || sevenDayOpus || sevenDaySonnet || sevenDayOauthApps || modelScoped ? {
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
		...(sevenDayOpus ? { sevenDayOpus } : {}),
		...(sevenDaySonnet ? { sevenDaySonnet } : {}),
		...(sevenDayOauthApps ? { sevenDayOauthApps } : {}),
		...(modelScoped ? { modelScoped } : {}),
	} : undefined;
}

function mergeWindow(current: IClaudeAccountRateLimitWindow | undefined, info: SDKRateLimitInfo): IClaudeAccountRateLimitWindow | undefined {
	const usedPercent = normalizeUsedPercent(info.utilization) ?? current?.usedPercent;
	if (usedPercent === undefined) {
		return current;
	}
	const resetsAt = normalizeNumericResetAt(info.resetsAt) ?? current?.resetsAt;
	return { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * The account slots a live `rate_limit_event` can refresh, keyed by the SDK's
 * own event type. Types without a slot of their own — overage windows, and any
 * type a newer SDK adds — are ignored rather than guessed at.
 */
const claudeRateLimitEventSlots: Partial<Record<NonNullable<SDKRateLimitInfo['rateLimitType']>, 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'>> = {
	five_hour: 'fiveHour',
	seven_day: 'sevenDay',
	seven_day_opus: 'sevenDayOpus',
	seven_day_sonnet: 'sevenDaySonnet',
};

/** Merge one live SDK rate-limit event into the latest account snapshot. */
export function mergeClaudeRateLimitEvent(current: IClaudeAccountRateLimits | undefined, info: SDKRateLimitInfo): IClaudeAccountRateLimits | undefined {
	const key = info.rateLimitType ? claudeRateLimitEventSlots[info.rateLimitType] : undefined;
	if (!key) {
		return current;
	}
	const window = mergeWindow(current?.[key], info);
	if (!window) {
		return current;
	}
	return {
		...current,
		[key]: window,
	};
}
