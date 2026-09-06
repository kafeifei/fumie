/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import Severity from '../../../../../base/common/severity.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostClaudeAgentEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import type { IAgentSdkSetupInfo } from '../../../../../platform/agentHost/common/agentSdkSetup.js';
import { IClaudeAccountInfo } from '../../../../../platform/agentHost/common/claudeAccount.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { createClaudeModelProviderPresentation, hasSignedInClaudeAccount, shouldShowClaudeAccount } from '../../browser/claudeAccountService.js';
import type { IAgentSdkSetupService } from '../../browser/agentSdkSetupService.js';

suite('ClaudeAccountService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function account(status: IClaudeAccountInfo['status']): IClaudeAccountInfo {
		return { status };
	}

	test('only presents a verified visible Claude identity in shared account chrome', () => {
		assert.strictEqual(hasSignedInClaudeAccount(account('signedIn')), true);
		assert.strictEqual(hasSignedInClaudeAccount(account('signedIn'), false), false);
		assert.strictEqual(hasSignedInClaudeAccount(account('unknown')), false);
		assert.strictEqual(hasSignedInClaudeAccount(account('signedOut')), false);
	});

	test('only shows the Claude account where the Claude agent host is available', () => {
		function configuration(claudeEnabled: boolean, aiDisabled = false) {
			return {
				getValue<T>(key: string): T | undefined {
					return ({
						[AgentHostClaudeAgentEnabledSettingId]: claudeEnabled,
						[ChatAIDisabledSettingId]: aiDisabled,
					} as Record<string, boolean>)[key] as T;
				}
			};
		}

		assert.deepStrictEqual({
			agentsDisabled: shouldShowClaudeAccount(configuration(false), true),
			agentsEnabled: shouldShowClaudeAccount(configuration(true), true),
			agentsAIHidden: shouldShowClaudeAccount(configuration(true, true), true),
			editorWindow: shouldShowClaudeAccount(configuration(true), false),
		}, {
			agentsDisabled: false,
			agentsEnabled: true,
			agentsAIHidden: false,
			editorWindow: false,
		});
	});
});

suite('Claude account presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function service(initial: IAgentSdkSetupInfo): IAgentSdkSetupService & { downloadCalls: number; signInCalls: number; cancelSignInCalls: number } {
		return {
			_serviceBrand: undefined,
			setups: [initial],
			onDidChangeSetups: Event.None,
			downloadCalls: 0,
			signInCalls: 0,
			cancelSignInCalls: 0,
			requestDownload() { this.downloadCalls++; },
			openSetupDocs() { },
			requestReload() { },
			signInToGitHub() { },
			signIn() { this.signInCalls++; },
			cancelSignIn() { this.cancelSignInCalls++; },
			isDownloadPending() { return false; },
			reportSetupState() { },
		};
	}

	test('offers the SDK download before sign-in', async () => {
		const setupService = service({ agent: 'claude', download: 'notDownloaded', signInProviderName: 'Claude' });
		const status = createClaudeModelProviderPresentation(setupService).provideStatus({ hasModelSnapshot: true, hasNativeModels: false });
		assert.deepStrictEqual({ message: status?.message, severity: status?.severity, action: status?.action?.label }, {
			message: 'Download Claude Agent to sign in and load native models',
			severity: Severity.Warning,
			action: 'Download Claude Agent',
		});
		await status?.action?.run();
		assert.strictEqual(setupService.downloadCalls, 1);
	});

	test('uses the direct Claude account check even when other native-looking models exist', async () => {
		const setupService = service({ agent: 'claude', download: 'ready', accountStatus: 'signedOut', signInProviderName: 'Claude' });
		const status = createClaudeModelProviderPresentation(setupService).provideStatus({ hasModelSnapshot: true, hasNativeModels: true });
		assert.deepStrictEqual({ message: status?.message, severity: status?.severity, action: status?.action?.label }, {
			message: 'Sign in to Claude to load native models',
			severity: Severity.Warning,
			action: 'Sign in to Claude',
		});
		await status?.action?.run();
		assert.strictEqual(setupService.signInCalls, 1);
	});

	test('shows in-flight and retry states, and clears only after a verified account', () => {
		const status = (accountStatus: IAgentSdkSetupInfo['accountStatus']) => createClaudeModelProviderPresentation(
			service({ agent: 'claude', download: 'ready', accountStatus, signInProviderName: 'Claude' })
		).provideStatus({ hasModelSnapshot: true, hasNativeModels: false });

		assert.deepStrictEqual({ message: status('signingIn')?.message, severity: status('signingIn')?.severity }, {
			message: 'Signing in to Claude… complete it in the browser, or sign in again to start over',
			severity: Severity.Info,
		});
		assert.deepStrictEqual({ message: status('error')?.message, action: status('error')?.action?.label }, {
			message: 'Claude sign-in needs attention',
			action: 'Retry Claude sign-in',
		});
		assert.strictEqual(status(undefined), undefined);
		assert.strictEqual(status('signedIn'), undefined);
	});

	test('a sign-in that will not finish can be abandoned from the card', async () => {
		// The shell cannot see the browser, so an abandoned authorization is only
		// ever ended by the user: this is that escape hatch.
		const setupService = service({ agent: 'claude', download: 'ready', accountStatus: 'signingIn', signInProviderName: 'Claude' });
		const status = createClaudeModelProviderPresentation(setupService).provideStatus({ hasModelSnapshot: true, hasNativeModels: false });

		assert.strictEqual(status?.action?.label, 'Cancel sign-in');
		await status?.action?.run();
		assert.deepStrictEqual({ cancelled: setupService.cancelSignInCalls, signIns: setupService.signInCalls }, { cancelled: 1, signIns: 0 });
	});
});
