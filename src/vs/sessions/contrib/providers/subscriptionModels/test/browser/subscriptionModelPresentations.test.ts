/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IClaudeAccountInfo } from '../../../../../../platform/agentHost/common/claudeAccount.js';
import { ICodexAccountInfo } from '../../../../../../platform/agentHost/common/codexAccount.js';
import { claudeSignedInMessage, codexSignedInMessage } from '../../browser/subscriptionModelPresentations.js';

suite('subscriptionModelPresentations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('claudeSignedInMessage', () => {
		test('leads with the email and appends the subscription so several accounts are told apart', () => {
			const account: IClaudeAccountInfo = { status: 'signedIn', email: 'person@example.com', subscriptionType: 'Claude Max', organization: 'Acme' };
			assert.strictEqual(claudeSignedInMessage(account), 'Signed in to Claude · person@example.com (Claude Max)');
		});

		test('falls back to organization, then subscription, when the SDK reports no email', () => {
			assert.deepStrictEqual({
				org: claudeSignedInMessage({ status: 'signedIn', organization: 'Acme', subscriptionType: 'Claude Max' }),
				sub: claudeSignedInMessage({ status: 'signedIn', subscriptionType: 'Claude Max' }),
			}, {
				// The subscription is the label here, so it is not repeated in parens.
				org: 'Signed in to Claude · Acme (Claude Max)',
				sub: 'Signed in to Claude · Claude Max',
			});
		});

		test('shows the plain line when nothing identifies the account', () => {
			assert.strictEqual(claudeSignedInMessage({ status: 'signedIn' }), 'Signed in to Claude');
		});
	});

	suite('codexSignedInMessage', () => {
		test('leads with the email and appends the plan', () => {
			const account: ICodexAccountInfo = { status: 'signedIn', email: 'person@example.com', planType: 'pro' };
			assert.strictEqual(codexSignedInMessage(account), 'Signed in to ChatGPT · person@example.com (pro)');
		});

		test('uses the plan alone when there is no email, without repeating it', () => {
			assert.strictEqual(codexSignedInMessage({ status: 'signedIn', planType: 'pro' }), 'Signed in to ChatGPT · pro');
		});

		test('shows the plain line when nothing identifies the account', () => {
			assert.strictEqual(codexSignedInMessage({ status: 'signedIn' }), 'Signed in to ChatGPT');
		});
	});
});
