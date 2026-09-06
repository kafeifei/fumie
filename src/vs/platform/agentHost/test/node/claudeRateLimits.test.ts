/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeRateLimitsFromUsage, describeClaudeUsageWindows, mergeClaudeRateLimitEvent } from '../../node/claude/claudeRateLimits.js';

function usage(rateLimitsAvailable: boolean, rateLimits: SDKControlGetUsageResponse['rate_limits']): SDKControlGetUsageResponse {
	return { rate_limits_available: rateLimitsAvailable, rate_limits: rateLimits } as SDKControlGetUsageResponse;
}

suite('Claude rate limits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects the five-hour and seven-day snapshot with epoch-millisecond resets', () => {
		assert.deepStrictEqual(claudeRateLimitsFromUsage(usage(true, {
			five_hour: { utilization: 12.5, resets_at: '2026-08-28T05:00:00.000Z' },
			seven_day: { utilization: 42, resets_at: '2026-09-01T00:00:00.000Z' },
		})), {
			fiveHour: { usedPercent: 12.5, resetsAt: Date.parse('2026-08-28T05:00:00.000Z') },
			sevenDay: { usedPercent: 42, resetsAt: Date.parse('2026-09-01T00:00:00.000Z') },
		});
	});

	test('omits unavailable and unusable snapshot windows', () => {
		assert.strictEqual(claudeRateLimitsFromUsage(usage(false, {
			five_hour: { utilization: 10, resets_at: '2026-08-28T05:00:00.000Z' },
		})), undefined);
		assert.deepStrictEqual(claudeRateLimitsFromUsage(usage(true, {
			five_hour: { utilization: Number.NaN, resets_at: 'not-a-date' },
			seven_day: { utilization: 125, resets_at: null },
		})), {
			sevenDay: { usedPercent: 100 },
		});
	});

	test('merges live seconds-or-milliseconds events without dropping the other window', () => {
		const current = {
			fiveHour: { usedPercent: 10, resetsAt: 1_800_000_000_000 },
			sevenDay: { usedPercent: 20, resetsAt: 1_900_000_000_000 },
		};
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed_warning',
			rateLimitType: 'five_hour',
			utilization: 55,
			resetsAt: 2_000_000_000,
		} as SDKRateLimitInfo), {
			fiveHour: { usedPercent: 55, resetsAt: 2_000_000_000_000 },
			sevenDay: current.sevenDay,
		});
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed',
			rateLimitType: 'seven_day',
			utilization: 25,
			resetsAt: 2_100_000_000_000,
		} as SDKRateLimitInfo), {
			fiveHour: current.fiveHour,
			sevenDay: { usedPercent: 25, resetsAt: 2_100_000_000_000 },
		});
	});

	test('preserves current utilization when a live event only refreshes reset time', () => {
		const current = { fiveHour: { usedPercent: 33 } };
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2_000_000_000,
		} as SDKRateLimitInfo), {
			fiveHour: { usedPercent: 33, resetsAt: 2_000_000_000_000 },
		});
	});

	test('projects the model-scoped and per-model weekly windows the SDK adds', () => {
		assert.deepStrictEqual(claudeRateLimitsFromUsage(usage(true, {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 42, resets_at: null },
			seven_day_opus: { utilization: 61, resets_at: '2026-09-01T00:00:00.000Z' },
			seven_day_sonnet: { utilization: 7, resets_at: null },
			seven_day_oauth_apps: { utilization: 3, resets_at: null },
			model_scoped: [
				{ display_name: 'Fable', utilization: 55, resets_at: '2026-09-02T00:00:00.000Z' },
				{ display_name: 'Nameless', utilization: null, resets_at: null },
				{ display_name: '', utilization: 80, resets_at: null },
			],
		})), {
			fiveHour: { usedPercent: 12 },
			sevenDay: { usedPercent: 42 },
			sevenDayOpus: { usedPercent: 61, resetsAt: Date.parse('2026-09-01T00:00:00.000Z') },
			sevenDaySonnet: { usedPercent: 7 },
			sevenDayOauthApps: { usedPercent: 3 },
			modelScoped: [{ displayName: 'Fable', usedPercent: 55, resetsAt: Date.parse('2026-09-02T00:00:00.000Z') }],
		});
	});

	test('a live event alone populates an account that never got a usage snapshot', () => {
		// The `/usage` control request can be gated off (`rate_limits_available:
		// false`), leaving the published account with no `rateLimits` at all. The
		// panel must still fill in from the live `rate_limit_event` stream, so the
		// merge has to create the structure rather than require one.
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(undefined, {
			status: 'allowed', rateLimitType: 'five_hour', utilization: 44, resetsAt: 2_000_000_000,
		} as SDKRateLimitInfo), {
			fiveHour: { usedPercent: 44, resetsAt: 2_000_000_000_000 },
		});
		assert.deepStrictEqual(mergeClaudeRateLimitEvent({}, {
			status: 'allowed', rateLimitType: 'seven_day', utilization: 8,
		} as SDKRateLimitInfo), {
			sevenDay: { usedPercent: 8 },
		});
		// Without a utilization there is nothing to seed the window with, so an
		// empty account stays empty rather than publishing a 0% row.
		assert.strictEqual(mergeClaudeRateLimitEvent(undefined, {
			status: 'allowed', rateLimitType: 'five_hour', resetsAt: 2_000_000_000,
		} as SDKRateLimitInfo), undefined);
	});

	test('describes which usage windows the snapshot carried', () => {
		assert.strictEqual(describeClaudeUsageWindows(usage(true, {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: null, resets_at: null },
			model_scoped: [{ display_name: 'Fable', utilization: 55, resets_at: null }],
		})), 'five_hour=12 seven_day=null seven_day_opus=absent seven_day_sonnet=absent seven_day_oauth_apps=absent model_scoped=1');
		assert.strictEqual(describeClaudeUsageWindows(undefined), 'none');
	});

	test('separates a suppressed usage fetch from a snapshot that carried no window', () => {
		// `rate_limits_available: true` with `rate_limits: null` is what the CLI
		// reports when it never fetched `/usage` (the availability flag is a plan
		// predicate, not a data-presence one). Both publish nothing, so only the
		// log can tell them apart.
		assert.strictEqual(describeClaudeUsageWindows(usage(true, null)), 'rate_limits=null');
		assert.strictEqual(describeClaudeUsageWindows(usage(true, {})),
			'five_hour=absent seven_day=absent seven_day_opus=absent seven_day_sonnet=absent seven_day_oauth_apps=absent model_scoped=0');
		assert.strictEqual(claudeRateLimitsFromUsage(usage(true, null)), undefined);
	});

	test('traces every window dropped for a missing utilization', () => {
		const traced: string[] = [];
		claudeRateLimitsFromUsage(usage(true, {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: null, resets_at: null },
			model_scoped: [{ display_name: 'Fable', utilization: null, resets_at: null }],
		}), message => traced.push(message));

		assert.deepStrictEqual(traced, [
			`[Claude] Usage window 'seven_day' dropped: utilization is null`,
			`[Claude] Usage window 'model_scoped:Fable' dropped: utilization is null`,
		]);
	});

	test('merges the scoped live events into their own slots and ignores types without one', () => {
		const current = { fiveHour: { usedPercent: 33 } };
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 99, resetsAt: 2_000_000_000,
		} as SDKRateLimitInfo), {
			fiveHour: { usedPercent: 33 },
			sevenDayOpus: { usedPercent: 99, resetsAt: 2_000_000_000_000 },
		});
		assert.deepStrictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed', rateLimitType: 'seven_day_sonnet', utilization: 12,
		} as SDKRateLimitInfo), {
			fiveHour: { usedPercent: 33 },
			sevenDaySonnet: { usedPercent: 12 },
		});
		assert.strictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed', rateLimitType: 'overage', utilization: 99,
		} as SDKRateLimitInfo), current);
		assert.strictEqual(mergeClaudeRateLimitEvent(current, {
			status: 'allowed', utilization: 99,
		} as SDKRateLimitInfo), current);
	});
});
