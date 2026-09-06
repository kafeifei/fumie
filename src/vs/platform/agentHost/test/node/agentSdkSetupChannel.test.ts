/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY, AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY, agentSdkSetupStatusKey, type AgentSdkAccountStatus, type IAgentSdkSetupInfo } from '../../common/agentSdkSetup.js';
import type { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { AgentSdkSetupChannel, type IAgentSdkSetupChannelAgent } from '../../node/agentSdkSetupChannel.js';
import type { IAgentSdkDownloader, IAgentSdkPackage } from '../../node/agentSdkDownloader.js';

class TestConfigurationService extends mock<IAgentConfigurationService>() {
	readonly rootConfigChange = new Emitter<void>();
	override readonly onDidRootConfigChange = this.rootConfigChange.event;
	readonly values: Record<string, unknown> = {};
	readonly published: Readonly<Record<string, unknown>>[] = [];

	override getRootConfigValues(): Readonly<Record<string, unknown>> {
		return this.values;
	}

	override updateRootConfig(patch: Record<string, unknown>): void {
		Object.assign(this.values, patch);
		this.rootConfigChange.fire();
	}

	override publishRootTransientValues(patch: Readonly<Record<string, unknown>>): void {
		this.published.push(patch);
	}
}

suite('AgentSdkSetupChannel sign-in', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const sdkPackage: IAgentSdkPackage = {
		id: 'claude',
		displayName: 'Claude',
		devOverrideEnvVar: 'TEST_CLAUDE_SDK_ROOT',
		hasSeparateMuslLinuxPackage: true,
	};

	async function waitFor(predicate: () => boolean): Promise<void> {
		for (let i = 0; i < 50 && !predicate(); i++) {
			await Promise.resolve();
		}
		assert.ok(predicate(), 'condition did not settle');
	}

	function latestSetup(config: TestConfigurationService): IAgentSdkSetupInfo | undefined {
		return config.published.at(-1)?.[agentSdkSetupStatusKey('claude')] as IAgentSdkSetupInfo | undefined;
	}

	function dispatchSignIn(config: TestConfigurationService, request: string): void {
		config.updateRootConfig({ [AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY]: { agent: 'claude', request } });
	}

	function dispatchCancelSignIn(config: TestConfigurationService, request: string): void {
		config.updateRootConfig({ [AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY]: { agent: 'claude', request } });
	}

	function createChannel(agent: IAgentSdkSetupChannelAgent): { channel: AgentSdkSetupChannel; config: TestConfigurationService } {
		const config = new TestConfigurationService();
		store.add(config.rootConfigChange);
		const channel = store.add(new AgentSdkSetupChannel(agent, config, new class extends mock<IAgentSdkDownloader>() { }(), new NullLogService()));
		return { channel, config };
	}

	test('publishes signing-in, then rechecks before publishing the account', async () => {
		const gate = new DeferredPromise<void>();
		const events: string[] = [];
		let accountStatus: AgentSdkAccountStatus = 'signedOut';
		let signInCalls = 0;
		const { config } = createChannel({
			id: 'claude',
			sdkPackage,
			setupInfo: { signInProviderName: 'Claude' },
			isSdkLocal: async () => true,
			downloadSdk: async () => { },
			signIn: async () => { signInCalls++; events.push('signIn'); await gate.p; },
			getAccountStatus: () => accountStatus,
			restartChatDiscovery: () => { events.push('restart'); },
			refreshModels: async () => { events.push('refresh'); accountStatus = 'signedIn'; },
		});

		dispatchSignIn(config, 'press-1');
		await waitFor(() => signInCalls === 1);
		assert.strictEqual(latestSetup(config)?.accountStatus, 'signingIn');

		gate.complete();
		await waitFor(() => latestSetup(config)?.accountStatus === 'signedIn');
		assert.deepStrictEqual({ events, request: config.values[AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY] }, {
			events: ['signIn', 'restart', 'refresh'],
			request: undefined,
		});
	});

	test('pressing sign in again abandons the running attempt and starts a fresh one', async () => {
		// The whole point: the shell cannot see the browser, so a running attempt is
		// never a reason to refuse. A user who cancelled the authorization out there
		// gets a new flow from pressing again, not a swallowed press.
		const cancelled: boolean[] = [];
		const started: DeferredPromise<void>[] = [];
		const { config } = createChannel({
			id: 'claude',
			sdkPackage,
			setupInfo: { signInProviderName: 'Claude' },
			isSdkLocal: async () => true,
			downloadSdk: async () => { },
			// Models the real `claude auth login`: it waits on a browser round-trip
			// that never comes, and only ends when the attempt is abandoned.
			signIn: async token => {
				const attempt = new DeferredPromise<void>();
				started.push(attempt);
				store.add(token.onCancellationRequested(() => { cancelled.push(true); attempt.complete(); }));
				await attempt.p;
			},
			getAccountStatus: () => 'signedOut',
			restartChatDiscovery: () => { },
			refreshModels: async () => { },
		});

		dispatchSignIn(config, 'press-1');
		await waitFor(() => started.length === 1);
		assert.strictEqual(latestSetup(config)?.accountStatus, 'signingIn');

		dispatchSignIn(config, 'press-2');
		await waitFor(() => started.length === 2);

		assert.deepStrictEqual({
			attempts: started.length,
			abandonedTheFirst: cancelled.length,
			// Still signing in: the second attempt owns the state, and the first one
			// finishing must not publish over it.
			status: latestSetup(config)?.accountStatus,
		}, {
			attempts: 2,
			abandonedTheFirst: 1,
			status: 'signingIn',
		});
	});

	test('cancelling a sign-in abandons the process and leaves signing-in at once', async () => {
		let cancelledAttempts = 0;
		const started: DeferredPromise<void>[] = [];
		const { config } = createChannel({
			id: 'claude',
			sdkPackage,
			setupInfo: { signInProviderName: 'Claude' },
			isSdkLocal: async () => true,
			downloadSdk: async () => { },
			signIn: async token => {
				const attempt = new DeferredPromise<void>();
				started.push(attempt);
				store.add(token.onCancellationRequested(() => { cancelledAttempts++; attempt.complete(); }));
				await attempt.p;
			},
			getAccountStatus: () => 'signedOut',
			restartChatDiscovery: () => { },
			refreshModels: async () => { },
		});

		dispatchSignIn(config, 'press-1');
		await waitFor(() => started.length === 1);
		assert.strictEqual(latestSetup(config)?.accountStatus, 'signingIn');

		dispatchCancelSignIn(config, 'cancel-1');
		await waitFor(() => cancelledAttempts === 1);

		assert.deepStrictEqual({
			abandoned: cancelledAttempts,
			// Back to what the agent actually reports, without waiting for the killed
			// process to be noticed.
			status: latestSetup(config)?.accountStatus,
			request: config.values[AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY],
		}, {
			abandoned: 1,
			status: 'signedOut',
			request: undefined,
		});
	});

	test('and afterwards a fresh sign-in can still be started', async () => {
		let cancelledAttempts = 0;
		const started: DeferredPromise<void>[] = [];
		const { config } = createChannel({
			id: 'claude',
			sdkPackage,
			setupInfo: { signInProviderName: 'Claude' },
			isSdkLocal: async () => true,
			downloadSdk: async () => { },
			signIn: async token => {
				const attempt = new DeferredPromise<void>();
				started.push(attempt);
				store.add(token.onCancellationRequested(() => { cancelledAttempts++; attempt.complete(); }));
				await attempt.p;
			},
			getAccountStatus: () => 'signedOut',
			restartChatDiscovery: () => { },
			refreshModels: async () => { },
		});

		dispatchSignIn(config, 'press-1');
		await waitFor(() => started.length === 1);
		dispatchCancelSignIn(config, 'cancel-1');
		await waitFor(() => cancelledAttempts === 1);

		dispatchSignIn(config, 'press-2');
		await waitFor(() => started.length === 2);
		assert.strictEqual(latestSetup(config)?.accountStatus, 'signingIn');
	});

	test('a failed or cancelled official process is still followed by the authoritative recheck', async () => {
		const events: string[] = [];
		let accountStatus: AgentSdkAccountStatus = 'unknown';
		const { config } = createChannel({
			id: 'claude',
			sdkPackage,
			setupInfo: { signInProviderName: 'Claude' },
			isSdkLocal: async () => true,
			downloadSdk: async () => { },
			signIn: async () => { events.push('signIn'); throw new Error('cancelled'); },
			getAccountStatus: () => accountStatus,
			restartChatDiscovery: () => { events.push('restart'); },
			refreshModels: async () => { events.push('refresh'); accountStatus = 'signedOut'; },
		});

		dispatchSignIn(config, 'press-1');
		await waitFor(() => latestSetup(config)?.accountStatus === 'signedOut');
		assert.deepStrictEqual(events, ['signIn', 'restart', 'refresh']);
	});
});
