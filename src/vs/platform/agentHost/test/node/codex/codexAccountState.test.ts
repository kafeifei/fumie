/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codexAccountRateLimitFromResponse, codexAccountStateFromResponse, describeCodexRateLimitWindows, shouldApplyCodexRateLimits, type ICodexAccountState } from '../../../node/codex/codexAccountState.js';

suite('CodexAccountState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps ChatGPT identities as human accounts', () => {
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: { type: 'chatgpt', email: 'private@example.com', planType: 'plus' }, requiresOpenaiAuth: true }),
			{ usageSource: 'openai', status: 'signedIn', authType: 'chatgpt', email: 'private@example.com', planType: 'plus', requiresOpenaiAuth: true },
		);
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: { type: 'chatgpt', email: null, planType: 'team' }, requiresOpenaiAuth: true }),
			{ usageSource: 'openai', status: 'signedIn', authType: 'chatgpt', email: undefined, planType: 'team', requiresOpenaiAuth: true },
		);
	});

	test('distinguishes required sign-in from providers without OpenAI auth', () => {
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: null, requiresOpenaiAuth: true }),
			{ usageSource: 'openai', status: 'signedOut', requiresOpenaiAuth: true },
		);
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: null, requiresOpenaiAuth: false }),
			{ usageSource: 'openai', status: 'unavailable', requiresOpenaiAuth: false },
		);
	});

	test('does not classify API key or Bedrock credentials as human accounts', () => {
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
			{ usageSource: 'openai', status: 'unavailable', authType: 'apiKey', requiresOpenaiAuth: true },
		);
		assert.deepStrictEqual(
			codexAccountStateFromResponse({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true }, requiresOpenaiAuth: false }),
			{ usageSource: 'openai', status: 'unavailable', authType: 'other', requiresOpenaiAuth: false },
		);
	});

	test('keeps both windows of the Codex rate-limit snapshot', () => {
		assert.deepStrictEqual(codexAccountRateLimitFromResponse({
			rateLimits: {
				limitId: null,
				limitName: null,
				primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 },
				secondary: null,
				credits: null,
				individualLimit: null,
				spendControlReached: null,
				planType: null,
				rateLimitReachedType: null,
			},
			rateLimitsByLimitId: {
				codex: {
					limitId: 'codex',
					limitName: 'Codex',
					primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 200 },
					secondary: { usedPercent: 42.4, windowDurationMins: 7 * 24 * 60, resetsAt: 300 },
					credits: null,
					individualLimit: null,
					spendControlReached: null,
					planType: null,
					rateLimitReachedType: null,
				},
			},
			rateLimitResetCredits: null,
			accountId: null,
			rateLimitUpsell: null,
		}), {
			primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 200 },
			secondary: { usedPercent: 42.4, windowDurationMins: 7 * 24 * 60, resetsAt: 300 },
		});
	});

	test('falls back to available rate-limit data and clamps percentages', () => {
		assert.deepStrictEqual(codexAccountRateLimitFromResponse({
			rateLimits: {
				limitId: null,
				limitName: null,
				primary: { usedPercent: 125, windowDurationMins: null, resetsAt: null },
				secondary: null,
				credits: null,
				individualLimit: null,
				spendControlReached: null,
				planType: null,
				rateLimitReachedType: null,
			},
			rateLimitsByLimitId: null,
			rateLimitResetCredits: null,
			accountId: null,
			rateLimitUpsell: null,
		}), { primary: { usedPercent: 100, windowDurationMins: undefined, resetsAt: undefined } });
	});

	test('reports nothing when the snapshot carries no usable window', () => {
		const emptySnapshot = {
			limitId: null,
			limitName: null,
			primary: null,
			secondary: null,
			credits: null,
			individualLimit: null,
			spendControlReached: null,
			planType: null,
			rateLimitReachedType: null,
		};
		assert.strictEqual(codexAccountRateLimitFromResponse({
			rateLimits: emptySnapshot,
			rateLimitsByLimitId: null,
			rateLimitResetCredits: null,
			accountId: null,
			rateLimitUpsell: null,
		}), undefined);
		assert.strictEqual(codexAccountRateLimitFromResponse({
			rateLimits: { ...emptySnapshot, primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: 100 } },
			rateLimitsByLimitId: null,
			rateLimitResetCredits: null,
			accountId: null,
			rateLimitUpsell: null,
		}), undefined);
	});

	test('falls back when the Codex bucket has no windows', () => {
		assert.deepStrictEqual(codexAccountRateLimitFromResponse({
			rateLimits: {
				limitId: null,
				limitName: null,
				primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 400 },
				secondary: null,
				credits: null,
				individualLimit: null,
				spendControlReached: null,
				planType: null,
				rateLimitReachedType: null,
			},
			rateLimitsByLimitId: {
				codex: {
					limitId: 'codex',
					limitName: 'Codex',
					primary: null,
					secondary: null,
					credits: null,
					individualLimit: null,
					spendControlReached: null,
					planType: null,
					rateLimitReachedType: null,
				},
			},
			rateLimitResetCredits: null,
			accountId: null,
			rateLimitUpsell: null,
		}), { primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 400 } });
	});

	test('only the newest rate-limit refresh may write its response', () => {
		const signedIn: ICodexAccountState = { usageSource: 'openai', status: 'signedIn', authType: 'chatgpt', email: 'private@example.com' };
		const context = {
			requestGeneration: 3,
			latestGeneration: 3,
			connectionMatches: true,
			account: signedIn,
			accountEmail: 'private@example.com',
		};

		assert.strictEqual(shouldApplyCodexRateLimits(context), true);
		// A response overtaken by a newer refresh must not clobber it, even though
		// every other condition still holds.
		assert.strictEqual(shouldApplyCodexRateLimits({ ...context, latestGeneration: 4 }), false);
		assert.strictEqual(shouldApplyCodexRateLimits({ ...context, connectionMatches: false }), false);
		assert.strictEqual(shouldApplyCodexRateLimits({ ...context, accountEmail: 'other@example.com' }), false);
		assert.strictEqual(shouldApplyCodexRateLimits({ ...context, account: { ...signedIn, authType: 'apiKey' } }), false);
		assert.strictEqual(shouldApplyCodexRateLimits({ ...context, account: { usageSource: 'openai', status: 'signedOut' } }), false);
	});

	test('names the window slots an accepted snapshot carried', () => {
		assert.strictEqual(describeCodexRateLimitWindows(undefined), 'none');
		assert.strictEqual(describeCodexRateLimitWindows({ primary: { usedPercent: 30 } }), 'primary');
		assert.strictEqual(describeCodexRateLimitWindows({ secondary: { usedPercent: 30 } }), 'secondary');
		assert.strictEqual(describeCodexRateLimitWindows({ primary: { usedPercent: 30 }, secondary: { usedPercent: 40 } }), 'primary+secondary');
	});
});
