/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_ACCOUNT_META_KEY, readClaudeAccountInfo } from '../../common/claudeAccount.js';

suite('Claude account metadata', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a verified first-party login', () => {
		assert.deepStrictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: {
				[CLAUDE_ACCOUNT_META_KEY]: {
					status: 'signedIn',
					email: 'person@example.com',
					organization: 'Example Org',
					subscriptionType: 'max',
					rateLimits: {
						fiveHour: { usedPercent: 42.5, resetsAt: 1_725_000_000_000 },
						sevenDay: { usedPercent: 18 },
					},
				},
			},
		}), {
			status: 'signedIn',
			email: 'person@example.com',
			organization: 'Example Org',
			subscriptionType: 'max',
			rateLimits: {
				fiveHour: { usedPercent: 42.5, resetsAt: 1_725_000_000_000 },
				sevenDay: { usedPercent: 18, resetsAt: undefined },
			},
		});
	});

	test('keeps valid rate-limit windows while dropping malformed siblings', () => {
		assert.deepStrictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: {
				[CLAUDE_ACCOUNT_META_KEY]: {
					status: 'signedIn',
					rateLimits: {
						fiveHour: { usedPercent: 42, resetsAt: 1_725_000_000_000 },
						sevenDay: { usedPercent: 101, resetsAt: 1_725_000_000_000 },
					},
				},
			},
		}).rateLimits, {
			fiveHour: { usedPercent: 42, resetsAt: 1_725_000_000_000 },
		});
	});

	test('accepts inclusive percentage bounds', () => {
		assert.deepStrictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: {
				[CLAUDE_ACCOUNT_META_KEY]: {
					status: 'signedIn',
					rateLimits: {
						fiveHour: { usedPercent: 0, resetsAt: 1 },
						sevenDay: { usedPercent: 100 },
					},
				},
			},
		}).rateLimits, {
			fiveHour: { usedPercent: 0, resetsAt: 1 },
			sevenDay: { usedPercent: 100, resetsAt: undefined },
		});
	});

	test('drops non-finite percentages and non-positive or non-finite reset times', () => {
		const invalidWindows = [
			{ usedPercent: Number.NaN },
			{ usedPercent: Number.POSITIVE_INFINITY },
			{ usedPercent: -1 },
			{ usedPercent: 101 },
			{ usedPercent: 50, resetsAt: 0 },
			{ usedPercent: 50, resetsAt: -1 },
			{ usedPercent: 50, resetsAt: Number.POSITIVE_INFINITY },
			{ usedPercent: 50, resetsAt: Number.NaN },
		];

		for (const fiveHour of invalidWindows) {
			const account = readClaudeAccountInfo({
				agents: [],
				_meta: {
					[CLAUDE_ACCOUNT_META_KEY]: { status: 'signedIn', rateLimits: { fiveHour } },
				},
			});
			assert.strictEqual(account.rateLimits, undefined);
		}
	});

	test('stays unknown for an absent or malformed account slot', () => {
		assert.strictEqual(readClaudeAccountInfo(undefined).status, 'unknown');
		assert.strictEqual(readClaudeAccountInfo({ agents: [] }).status, 'unknown');
		assert.strictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: { [CLAUDE_ACCOUNT_META_KEY]: 'signedIn' },
		}).status, 'unknown');
		assert.strictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: { [CLAUDE_ACCOUNT_META_KEY]: { status: 'downloading' } },
		}).status, 'unknown');
	});

	test('drops non-string identity fields without losing the status', () => {
		assert.deepStrictEqual(readClaudeAccountInfo({
			agents: [],
			_meta: {
				[CLAUDE_ACCOUNT_META_KEY]: { status: 'signedOut', email: 42, subscriptionType: null },
			},
		}), {
			status: 'signedOut',
			email: undefined,
			organization: undefined,
			subscriptionType: undefined,
			rateLimits: undefined,
		});
	});
});
