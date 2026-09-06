/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { AgentHostProtocolClient } from '../../../../../../platform/agentHost/browser/agentHostProtocolClient.js';
import { type IAgentHostResourceService } from '../../../../../../platform/agentHost/common/agentHostResourceService.js';
import { PROTOCOL_VERSION } from '../../../../../../platform/agentHost/common/state/protocol/version/registry.js';
import { type IProtocolTransport } from '../../../../../../platform/agentHost/common/state/sessionTransport.js';
import { type ProtocolMessage, type JsonRpcRequest, type JsonRpcNotification } from '../../../../../../platform/agentHost/common/state/sessionProtocol.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ActionType, type ActionEnvelope } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { buildDefaultChatUri, createChatState, createDefaultChatSummary, MessageKind, SessionLifecycle, SessionStatus, TurnState, StateComponents, type ChatState, type SessionState, type SessionSummary, type Turn } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { AgentHostSessionHandler } from '../../../browser/agentSessions/agentHost/agentHostSessionHandler.js';

suite('agentHostTurnRejection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	for (const { rejected, suppressErrorMarkdown, name } of [
		{ rejected: false, suppressErrorMarkdown: true, name: 'an accepted turn completes normally through the same observer' },
		{ rejected: true, suppressErrorMarkdown: true, name: 'a rejection remains an error when subscription rollback runs before the turn listener' },
		{ rejected: true, suppressErrorMarkdown: false, name: 'an inline observer emits the wire rejection reason to its progress sink' },
	]) {
		test(name, async () => {
			const backendSession = URI.parse('copilot:/rejected-turn');
			const chatURI = buildDefaultChatUri(backendSession.toString());
			const summary: SessionSummary = {
				resource: backendSession.toString(), provider: 'copilot', title: 'Rejected turn', status: SessionStatus.Idle,
				createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(),
			};
			const state: SessionState = { provider: 'copilot', title: summary.title, status: SessionStatus.Idle, lifecycle: SessionLifecycle.Ready, activeClients: [], chats: [] };
			const messages = disposables.add(new Emitter<ProtocolMessage>());
			const closed = disposables.add(new Emitter<void>());
			const sent: Parameters<IProtocolTransport['send']>[0][] = [];
			const transport: IProtocolTransport = {
				onMessage: messages.event, onClose: closed.event, dispose: () => { },
				send: message => {
					sent.push(message);
					const request = message as JsonRpcRequest;
					if (request.method === 'initialize') {
						queueMicrotask(() => messages.fire({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: PROTOCOL_VERSION, serverSeq: 0, snapshots: [] } }));
					} else if (request.method === 'subscribe') {
						const channel = (request.params as { channel: string }).channel;
						const snapshot = { resource: channel, fromSeq: 0, state: channel === chatURI ? createChatState(createDefaultChatSummary(summary, chatURI)) : state };
						queueMicrotask(() => messages.fire({ jsonrpc: '2.0', id: request.id, result: { snapshot } }));
					}
				},
			};
			const client = disposables.add(new AgentHostProtocolClient(
				'test.example:1234', transport, { hasHighLoad: () => false }, 'client', undefined,
				new NullLogService(), upcastPartial<IAgentHostResourceService>({ connectionClosed: () => { }, grantImplicitRead: () => Disposable.None }),
				new TestConfigurationService(), NullTelemetryService,
			));
			await client.connect();
			const sessionSub = disposables.add(client.getSubscription<SessionState>(StateComponents.Session, backendSession, 'test')).object;
			const chatSub = disposables.add(client.getSubscription<ChatState>(StateComponents.Chat, URI.parse(chatURI), 'test')).object;
			for (let i = 0; i < 20 && (!sessionSub.value || !chatSub.value); i++) { await Promise.resolve(); }
			assert.ok(sessionSub.value && chatSub.value, 'real subscriptions must receive their wire snapshots');
			const action = {
				type: ActionType.ChatTurnStarted as const, turnId: 'turn-1', startedAt: new Date(0).toISOString(),
				message: { text: 'hello', origin: { kind: MessageKind.User as const } },
			};
			client.dispatch(chatURI, action);
			const dispatch = sent.find(message => (message as JsonRpcNotification).method === 'dispatchAction') as JsonRpcNotification;
			assert.ok(dispatch, 'real client must send the dispatched action');
			const clientSeq = (dispatch.params as { clientSeq: number }).clientSeq;
			const optimistic = chatSub.value;
			assert.ok(optimistic && !(optimistic instanceof Error));
			assert.strictEqual(optimistic.activeTurn?.id, action.turnId);

			const handler = {
				_ensureTurnStopWatch: () => { }, _clearTurnStopWatch: () => { },
				_ensureSessionSubscription: () => sessionSub, _ensureChatSubscription: () => chatSub,
				_getSessionState: () => ({ ...state, turns: [] }), _createTurnModelLookup: () => ({}), _setupMcpAuthPrompt: () => { },
				_config: { connection: client },
				_logService: { warn: () => { }, error: () => { } },
			};
			const ended: (Turn | undefined)[] = [];
			const progress: unknown[] = [];
			const observeTurn = (AgentHostSessionHandler.prototype as unknown as { _observeTurn(opts: unknown): IDisposable })._observeTurn;
			disposables.add(observeTurn.call(handler, {
				backendSession, sessionResource: URI.parse('agent-host-copilot:/rejected-turn'), chatURI, turnId: action.turnId,
				sink: (parts: unknown[]) => progress.push(...parts), cancellationToken: CancellationToken.None, suppressErrorMarkdown,
				acknowledgementTimeoutMs: 90_000, onTurnEnded: (turn: Turn | undefined) => ended.push(turn),
			}));
			const fireAction = (envelope: ActionEnvelope) => messages.fire({ jsonrpc: '2.0', method: 'action', params: envelope });
			const reason = 'The selected model is not available';
			fireAction({ channel: chatURI, action, serverSeq: 1, origin: { clientId: 'client', clientSeq }, rejectionReason: rejected ? reason : undefined });
			if (!rejected) {
				fireAction({ channel: chatURI, action: { type: ActionType.ChatTurnComplete, turnId: action.turnId, duration: 1 }, serverSeq: 2, origin: undefined });
			}
			await Promise.resolve();
			assert.strictEqual(ended.length, 1, 'the turn must finish exactly once');
			assert.strictEqual(ended[0]?.state, rejected ? TurnState.Error : TurnState.Complete, `the observer must preserve the host outcome; actual turn: ${JSON.stringify(ended[0])}`);
			if (rejected) {
				assert.ok(ended[0]?.error?.message.includes(reason), 'the host rejection reason must reach the caller');
				assert.strictEqual(JSON.stringify(progress).includes(reason), !suppressErrorMarkdown, 'inline observers must emit the reason; request observers return it through the error result');
			}
		});
	}
});
