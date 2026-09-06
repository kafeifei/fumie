/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CODEX_ACCOUNT_META_KEY, readCodexAccountInfo } from '../../common/codexAccount.js';

suite('Codex account metadata', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads validated rate-limit metadata', () => {
		assert.deepStrictEqual(readCodexAccountInfo({
			agents: [],
			_meta: {
				[CODEX_ACCOUNT_META_KEY]: {
					status: 'signedIn',
					email: 'person@example.com',
					rateLimit: {
						primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1200 },
						secondary: { usedPercent: 42.4, windowDurationMins: 10080, resetsAt: 1234 },
					},
				},
			},
		}), {
			status: 'signedIn',
			email: 'person@example.com',
			planType: undefined,
			requiresOpenaiAuth: undefined,
			rateLimit: {
				primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1200 },
				secondary: { usedPercent: 42.4, windowDurationMins: 10080, resetsAt: 1234 },
			},
			authUrl: undefined,
			authUrlNonce: undefined,
		});
	});

	test('drops malformed rate-limit windows without losing the usable one', () => {
		const account = readCodexAccountInfo({
			agents: [],
			_meta: {
				[CODEX_ACCOUNT_META_KEY]: {
					status: 'signedIn',
					rateLimit: {
						primary: { usedPercent: 101 },
						secondary: { usedPercent: 42.4, windowDurationMins: 10080, resetsAt: 1234 },
					},
				},
			},
		});
		assert.strictEqual(account.status, 'signedIn');
		assert.deepStrictEqual(account.rateLimit, { secondary: { usedPercent: 42.4, windowDurationMins: 10080, resetsAt: 1234 } });

		assert.strictEqual(readCodexAccountInfo({
			agents: [],
			_meta: {
				[CODEX_ACCOUNT_META_KEY]: { status: 'signedIn', rateLimit: { primary: { usedPercent: 101 } } },
			},
		}).rateLimit, undefined);
	});

	test('reads the downloading account state', () => {
		const account = readCodexAccountInfo({
			agents: [],
			_meta: { [CODEX_ACCOUNT_META_KEY]: { status: 'downloading' } },
		});

		assert.strictEqual(account.status, 'downloading');
	});
});
