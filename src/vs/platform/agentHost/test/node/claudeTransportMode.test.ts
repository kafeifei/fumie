/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isClaudeAccountSetUp, resolveClaudeTransportMode } from '../../node/claude/claudeTransportMode.js';

suite('claudeTransportMode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses native only for a live first-party login without a GitHub token', () => {
		const bools: readonly boolean[] = [false, true];
		const actual: Record<string, string> = {};
		for (const allowSignedOutWhenUsable of bools) {
			for (const hasGitHubToken of bools) {
				for (const hasExistingSetup of bools) {
					const key = `flag=${allowSignedOutWhenUsable},token=${hasGitHubToken},setup=${hasExistingSetup}`;
					actual[key] = resolveClaudeTransportMode({ allowSignedOutWhenUsable, hasGitHubToken, hasExistingSetup });
				}
			}
		}
		assert.deepStrictEqual(actual, {
			'flag=false,token=false,setup=false': 'proxy',
			'flag=false,token=false,setup=true': 'proxy',
			'flag=false,token=true,setup=false': 'proxy',
			'flag=false,token=true,setup=true': 'proxy',
			'flag=true,token=false,setup=false': 'proxy',  // nothing usable ⇒ safe end (fails at use, not here)
			'flag=true,token=false,setup=true': 'native',  // signed out + own creds ⇒ native
			'flag=true,token=true,setup=false': 'proxy',   // signed in ⇒ prefer Copilot
			'flag=true,token=true,setup=true': 'proxy',    // signed in wins over setup
		});
	});

	suite('isClaudeAccountSetUp', () => {
		// Every row is a shape observed from a real `accountInfo()` probe — the
		// rule exists to match what the SDK actually reports.
		const cases: readonly (readonly [name: string, account: AccountInfo | undefined, expected: boolean])[] = [
			// The SDK could not be asked at all (not downloaded, or the query
			// failed). Publishing models we cannot back is the bug being fixed.
			['no report at all', undefined, false],
			// Measured with an empty `HOME` and a stripped environment. The
			// real-looking `apiProvider` here is exactly why it is not a presence
			// signal — this user has nothing configured.
			['nothing configured', { tokenSource: 'none', apiProvider: 'firstParty' }, false],
			// Same verdict without the provider field, so absence is not read as
			// third-party.
			['nothing configured, no provider field', { tokenSource: 'none' }, false],
			['empty report', {}, false],
			// Legacy token-backed OAuth report.
			['oauth token', { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' }, true],
			// Current Claude Code (2.1.220) Keychain login report. A normal
			// claude.ai subscription deliberately omits tokenSource.
			['claude.ai subscription', { email: 'user@example.com', organization: 'Example', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, true],
			['empty subscription identity', { subscriptionType: '', apiProvider: 'firstParty' }, false],
			// Provider credentials belong to Fumie's renderer-owned catalog, not
			// the official native subscription row.
			['api key', { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }, false],
			['third-party backend (bedrock)', { apiProvider: 'bedrock' }, false],
			['third-party backend (vertex)', { apiProvider: 'vertex' }, false],
			['enterprise gateway', { apiProvider: 'gateway' }, false],
		];

		test('maps observed SDK account reports onto one set-up answer', () => {
			assert.deepStrictEqual(
				Object.fromEntries(cases.map(([name, account]) => [name, isClaudeAccountSetUp(account)])),
				Object.fromEntries(cases.map(([name, , expected]) => [name, expected])));
		});
	});
});
