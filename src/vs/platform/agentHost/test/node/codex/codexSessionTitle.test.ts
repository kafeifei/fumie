/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IAgentHostCheckpointService, NULL_CHECKPOINT_SERVICE } from '../../../common/agentHostCheckpointService.js';
import { AgentSession } from '../../../common/agent.js';
import { IAgentHostOTelService } from '../../../common/otel/agentHostOTelService.js';
import { ISessionDataService } from '../../../common/sessionDataService.js';
import { AgentConfigurationService, IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { IAgentHostCustomizationEnablementService } from '../../../node/agentHostCustomizationEnablementService.js';
import { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { IAgentHostGitHubEndpointService } from '../../../node/agentHostGitHubEndpointService.js';
import { IAgentHostSessionTitleSignal } from '../../../node/agentHostSessionTitleSignal.js';
import { IAgentSdkDownloader } from '../../../node/agentSdkDownloader.js';
import { CodexAgent, toCodexModelSelectionId } from '../../../node/codex/codexAgent.js';
import { CodexBackingStore } from '../../../node/codex/codexBackingStore.js';
import { ByokLmBridgeRegistry, IByokLmBridgeRegistry } from '../../../node/byokLmBridgeRegistry.js';
import { IChatGptSubscriptionService } from '../../../node/chatGptSubscription.js';
import { createTestChatGptSubscriptionService } from '../testChatGptSubscriptionService.js';
import { ICodexProxyService } from '../../../node/codex/codexProxyService.js';
import type { ItemCompletedNotification } from '../../../node/codex/protocol/generated/v2/ItemCompletedNotification.js';
import type { TurnCompletedNotification } from '../../../node/codex/protocol/generated/v2/TurnCompletedNotification.js';
import { ICopilotApiService } from '../../../node/shared/copilotApiService.js';
import { createTestGitHubEndpointService } from '../testGitHubEndpointService.js';
import { createNoopCustomizationEnablementService } from '../testCustomizationEnablementService.js';

const HIDDEN_THREAD_ID = 'hidden-title-thread';

function createAgent(disposables: Pick<DisposableStore, 'add'>): CodexAgent {
	const instantiationService = new TestInstantiationService();
	const logService = new NullLogService();
	const stateManager = disposables.add(new AgentHostStateManager(logService));
	instantiationService.stub(ISessionDataService, { _serviceBrand: undefined });
	instantiationService.stub(ICopilotApiService, { _serviceBrand: undefined, models: async () => [] });
	instantiationService.stub(ICodexProxyService, { _serviceBrand: undefined });
	instantiationService.stub(IAgentConfigurationService, disposables.add(new AgentConfigurationService(stateManager, logService)));
	instantiationService.stub(IAgentHostCustomizationEnablementService, createNoopCustomizationEnablementService());
	instantiationService.stub(IAgentHostGitHubEndpointService, createTestGitHubEndpointService());
	instantiationService.stub(IAgentSdkDownloader, {
		_serviceBrand: undefined,
		isSdkResolvableWithoutDownload: () => new Promise<boolean>(() => { }),
	});
	instantiationService.stub(IAgentHostCheckpointService, NULL_CHECKPOINT_SERVICE);
	instantiationService.stub(IAgentHostOTelService, { _serviceBrand: undefined, getNativeSdkTelemetryConfig: async () => undefined });
	instantiationService.stub(IAgentHostSessionTitleSignal, { _serviceBrand: undefined, onDidChangeSessionTitle: Event.None });
	instantiationService.stub(IProductService, { _serviceBrand: undefined, version: '1.0.0-test' } as IProductService);
	instantiationService.stub(INativeEnvironmentService, { userHome: URI.file('/tmp') });
	instantiationService.stub(ILogService, logService);
	instantiationService.stub(IByokLmBridgeRegistry, new ByokLmBridgeRegistry());
	instantiationService.stub(IChatGptSubscriptionService, createTestChatGptSubscriptionService());
	return disposables.add(instantiationService.createInstance(CodexAgent));
}

/**
 * A fake app-server connection that answers the naming turn the way codex does:
 * the turn's text arrives as a completed `agentMessage` item on the notification
 * stream (a live `turn/completed` carries no items), and every request is
 * recorded so the test can assert the exact RPC sequence.
 */
function stubConnection(agent: CodexAgent, reply: string): { readonly method: string; readonly params: unknown }[] {
	const rpcs: { readonly method: string; readonly params: unknown }[] = [];
	const item: ItemCompletedNotification = {
		threadId: HIDDEN_THREAD_ID,
		turnId: 'title-turn',
		completedAtMs: 0,
		item: { type: 'agentMessage', id: 'title-item', text: reply, phase: null, memoryCitation: null, delivery: null, questions: null },
	};
	const completed: TurnCompletedNotification = {
		threadId: HIDDEN_THREAD_ID,
		turn: { id: 'title-turn', items: [], itemsView: 'notLoaded', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null },
	};
	agent['_isSdkResolvableWithoutDownload'] = async () => false;
	agent['_ensureConnection'] = async () => ({
		kind: 'ready',
		client: {
			request: async (method: string, params: unknown) => {
				rpcs.push({ method, params });
				switch (method) {
					case 'thread/start':
						return { thread: { id: HIDDEN_THREAD_ID } };
					case 'turn/start':
						agent['_dispatchItemCompleted'](item);
						agent['_dispatchTurnCompleted'](completed);
						return { turn: { id: 'title-turn' } };
				}
				throw new Error(`Unexpected request: ${method}`);
			},
		},
		proxyHandle: { dispose() { } },
		child: { kill: () => true },
	} as never);
	return rpcs;
}

suite('CodexAgent session title', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('names a session on a hidden ephemeral thread, with nothing left to clean up', async () => {
		const agent = createAgent(disposables);
		const rpcs = stubConnection(agent, 'Fix the flaky title test');
		agent['_backingStoreBySessionId'].set('name-me', CodexBackingStore.Fumie);

		const title = await agent.generateTitle(
			AgentSession.uri('codex', 'name-me'),
			{ prompt: 'the title test keeps flaking', modelId: toCodexModelSelectionId('openai', 'gpt-5.6-sol') },
			CancellationToken.None,
		);

		assert.deepStrictEqual({ title, rpcs }, {
			// The raw model reply: sanitizing and shortening belong to the caller.
			title: 'Fix the flaky title test',
			rpcs: [
				// Hidden, unlisted, read-only, unattended — and on the session's own model.
				{
					method: 'thread/start',
					params: {
						ephemeral: true,
						cwd: os.tmpdir(),
						model: 'gpt-5.6-sol',
						modelProvider: 'openai',
						approvalPolicy: 'never',
						sandbox: 'read-only',
					},
				},
				// The user's thread is never touched: the naming prompt runs on the
				// throwaway one, at the cheapest reasoning tier — an ephemeral thread
				// would otherwise inherit the user's configured effort and spend far
				// longer than the host's naming budget on a one-line title.
				{
					method: 'turn/start',
					params: {
						threadId: HIDDEN_THREAD_ID,
						input: [{
							type: 'text',
							text: 'Reply with only a concise 3-8 word title for this coding session, no quotes, no punctuation at the end: the title test keeps flaking',
							text_elements: [],
						}],
						effort: 'low',
					},
				},
				// No `thread/delete`: an ephemeral thread never lands on disk, so
				// deleting it only earns "thread is not persisted and cannot be deleted".
			],
		});
	});
});
