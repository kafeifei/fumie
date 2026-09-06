/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY, agentSdkSetupStatusKey } from '../../../../../platform/agentHost/common/agentSdkSetup.js';
import type { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import type { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import type { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import type { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { AgentSdkSetupService } from '../../browser/agentSdkSetupService.js';
import type { ICodexAccountService } from '../../browser/codexAccountService.js';

class TestAgentHostService extends mock<IAgentHostService>() {
	override readonly onAgentHostStart = Event.None;
	readonly dispatches: Array<{ channel: string; action: Parameters<IAgentHostService['dispatch']>[1] }> = [];
	override readonly rootState = {
		value: {
			config: {
				values: {
					[agentSdkSetupStatusKey('claude')]: { download: 'ready', signInProviderName: 'Claude', accountStatus: 'signedOut' },
				},
			},
		} as RootState,
		onDidChange: Event.None,
	} as IAgentSubscription<RootState>;

	override dispatch(channel: string, action: Parameters<IAgentHostService['dispatch']>[1]): void {
		this.dispatches.push({ channel, action });
	}
}

suite('AgentSdkSetupService sign-in routing', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('dispatches only declared non-Codex sign-in capabilities and preserves Codex routing', () => {
		const host = new TestAgentHostService();
		let codexSignInCalls = 0;
		const codex: ICodexAccountService = {
			_serviceBrand: undefined,
			agent: 'codex',
			account: { status: 'signedOut' },
			onDidChangeAccount: Event.None,
			signIn: () => { codexSignInCalls++; },
			signOut: () => { },
		};
		const storage = new class extends mock<IStorageService>() {
			override get(key: string, scope: StorageScope, fallbackValue: string): string;
			override get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
			override get(_key: string, _scope: StorageScope, fallbackValue?: string): string | undefined { return fallbackValue; }
			override store(): void { }
		}();
		const service = store.add(new AgentSdkSetupService(
			host,
			storage,
			new NullTelemetryServiceShape(),
			new NullLogService(),
			new class extends mock<IOpenerService>() { }(),
			new class extends mock<ICommandService>() { }(),
			codex,
		));

		service.signIn('unknown');
		assert.strictEqual(host.dispatches.length, 0);

		service.signIn('claude');
		const request = (host.dispatches[0]?.action as { config?: Record<string, unknown> } | undefined)?.config?.[AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY] as { agent?: string; request?: string } | undefined;
		assert.strictEqual(request?.agent, 'claude');
		assert.strictEqual(typeof request?.request, 'string');

		service.signIn('codex');
		assert.deepStrictEqual({ genericDispatches: host.dispatches.length, codexSignInCalls }, {
			genericDispatches: 1,
			codexSignInCalls: 1,
		});
	});
});
