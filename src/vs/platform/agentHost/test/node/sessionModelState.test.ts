/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { ActionType, type ActionEnvelope } from '../../common/state/sessionActions.js';
import { type ModelSelection } from '../../common/state/protocol/state.js';
import { MessageKind, buildDefaultChatUri } from '../../common/state/sessionState.js';
import { MockAgent } from './mockAgent.js';
import { createNoopGitService, createSessionDataService, TestSessionDatabase } from '../common/sessionTestHelpers.js';
import { createTestAgentService, getTestAgentStateManager } from './agentServiceTestUtils.js';

/**
 * Polls a session database for a persisted chat draft until it matches
 * `expected`, mirroring the fire-and-forget persistence path in
 * `AgentSideEffects._persistChatDraft`.
 */
async function waitForPersistedDraft(db: TestSessionDatabase, chat: URI, expected: unknown): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (JSON.stringify(await db.getChatDraft(chat)) === JSON.stringify(expected)) {
			return;
		}
		await timeout(5);
	}
	assert.deepStrictEqual(await db.getChatDraft(chat), expected);
}

/**
 * Plan requirement (docs/architecture.md): the model is
 * switchable and broadcast to every client as session-level shared state, and
 * survives persistence. Upstream already models this as the default chat's
 * `draft.model` (synced both ways via the client-dispatchable
 * `chat/draftChanged` action, persisted/restored by the host) rather than a
 * dedicated protocol concept — these tests pin that contract, including the
 * existing (intentional) precedence of a provider-reported current model
 * over a persisted draft's own model on restore.
 */
suite('AgentService — session-level model state (default chat draft.model)', () => {

	const disposables = new DisposableStore();
	let fileService: FileService;

	setup(async () => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createAgentService(db: TestSessionDatabase = new TestSessionDatabase()) {
		const svc = disposables.add(createTestAgentService(new NullLogService(), fileService, createSessionDataService(db), { _serviceBrand: undefined } as IProductService, createNoopGitService()));
		const stateManager = getTestAgentStateManager(svc);
		const agent = new MockAgent('mock');
		disposables.add(toDisposable(() => agent.dispose()));
		svc.registerProvider(agent);
		return { svc, stateManager, agent, db };
	}

	test('a draft model change from one client is broadcast to all clients sharing the chat', async () => {
		const { svc, stateManager } = createAgentService();
		const session = await svc.createSession({ provider: 'mock' });
		const chatUri = buildDefaultChatUri(session.toString());
		const modelX: ModelSelection = { id: 'model-x' };

		const envelopes: ActionEnvelope[] = [];
		disposables.add(stateManager.onDidEmitEnvelope(e => envelopes.push(e)));

		// Client A syncs its composer's model selection into the shared draft.
		svc.dispatchAction(chatUri, {
			type: ActionType.ChatDraftChanged,
			draft: { text: 'hi', origin: { kind: MessageKind.User }, model: modelX },
		}, 'client-A', 1);

		// A second subscriber (client B) reads the same shared chat state.
		const clientBView = stateManager.getChatState(chatUri);

		assert.deepStrictEqual({
			broadcast: envelopes.map(e => ({
				channel: e.channel,
				type: e.action.type,
				model: e.action.type === ActionType.ChatDraftChanged ? e.action.draft?.model : undefined,
				origin: e.origin,
			})),
			clientBDraftModel: clientBView?.draft?.model,
		}, {
			broadcast: [{ channel: chatUri, type: ActionType.ChatDraftChanged, model: modelX, origin: { clientId: 'client-A', clientSeq: 1 } }],
			clientBDraftModel: modelX,
		});
	});

	test('an in-flight turn keeps its original model even after the draft model changes mid-turn, and the next turn uses the new model', async () => {
		const { svc, stateManager, agent } = createAgentService();
		const session = await svc.createSession({ provider: 'mock' });
		const chatUri = buildDefaultChatUri(session.toString());
		const modelY: ModelSelection = { id: 'model-y' };
		const modelZ: ModelSelection = { id: 'model-z' };

		svc.dispatchAction(chatUri, {
			type: ActionType.ChatTurnStarted,
			turnId: 'turn-1',
			startedAt: '2025-01-01T00:00:00.000Z',
			message: { text: 'first turn', origin: { kind: MessageKind.User }, model: modelY },
		}, 'client-A', 1);

		// The user switches models in the composer while the first turn is still running.
		svc.dispatchAction(chatUri, {
			type: ActionType.ChatDraftChanged,
			draft: { text: 'next prompt', origin: { kind: MessageKind.User }, model: modelZ },
		}, 'client-A', 2);

		assert.deepStrictEqual({
			activeTurnModel: stateManager.getChatState(chatUri)?.activeTurn?.message.model,
			draftModel: stateManager.getChatState(chatUri)?.draft?.model,
		}, {
			activeTurnModel: modelY,
			draftModel: modelZ,
		});

		svc.dispatchAction(chatUri, { type: ActionType.ChatTurnComplete, turnId: 'turn-1', duration: 1 }, 'client-A', 3);

		// The next turn is sent with the now-current (changed) model.
		svc.dispatchAction(chatUri, {
			type: ActionType.ChatTurnStarted,
			turnId: 'turn-2',
			startedAt: '2025-01-01T00:00:01.000Z',
			message: { text: 'second turn', origin: { kind: MessageKind.User }, model: modelZ },
		}, 'client-A', 4);

		await timeout(10);

		assert.deepStrictEqual({
			activeTurnModel: stateManager.getChatState(chatUri)?.activeTurn?.message.model,
			changeModelCalls: agent.changeModelCalls.map(c => c.model),
		}, {
			activeTurnModel: modelZ,
			changeModelCalls: [modelY, modelZ],
		});
	});

	test('a persisted draft (including its model) survives a restore verbatim when the provider reports no current model', async () => {
		const db = new TestSessionDatabase();
		const { svc, stateManager } = createAgentService(db);
		const draftModel: ModelSelection = { id: 'draft-model' };

		const session = await svc.createSession({ provider: 'mock' });
		const chatUri = buildDefaultChatUri(session.toString());
		const draft = { text: 'unsent prompt', origin: { kind: MessageKind.User }, model: draftModel };

		svc.dispatchAction(chatUri, { type: ActionType.ChatDraftChanged, draft }, 'client-A', 1);
		await waitForPersistedDraft(db, URI.parse(chatUri), draft);

		// Evict the in-memory session (non-destructive to persisted data) to
		// simulate a host restart; the agent instance is reused, mirroring a
		// provider CLI that still remembers the session from its own backing
		// store independently of the host's session database.
		stateManager.removeSession(session.toString());

		await svc.restoreSession(session);

		assert.deepStrictEqual(stateManager.getSessionState(session.toString())?.draft, draft);
	});

	/**
	 * Intentional, existing precedence (not a gap): a provider-reported
	 * current model is the source of truth for session continuity — e.g. a
	 * Codex Desktop session whose model changed out-of-band, outside AHP's
	 * `chat/draftChanged` flow — so it overrides a persisted draft's own
	 * (possibly stale) model on restore. Mirrors, with a generic provider,
	 * the Codex-specific coverage in agentService.test.ts ("restoreSession
	 * seeds the provider model into the default chat draft").
	 */
	test('the provider-reported model takes priority over a persisted draft\'s own model on restore', async () => {
		const db = new TestSessionDatabase();
		const { svc, stateManager, agent } = createAgentService(db);
		const draftModel: ModelSelection = { id: 'draft-model' };
		const providerModel: ModelSelection = { id: 'provider-model' };
		agent.sessionMetadataOverrides = { model: providerModel };

		const session = await svc.createSession({ provider: 'mock' });
		const chatUri = buildDefaultChatUri(session.toString());
		const draft = { text: 'unsent prompt', origin: { kind: MessageKind.User }, model: draftModel };

		svc.dispatchAction(chatUri, { type: ActionType.ChatDraftChanged, draft }, 'client-A', 1);
		await waitForPersistedDraft(db, URI.parse(chatUri), draft);
		stateManager.removeSession(session.toString());

		await svc.restoreSession(session);

		assert.deepStrictEqual(stateManager.getSessionState(session.toString())?.draft, {
			text: 'unsent prompt',
			origin: { kind: MessageKind.User },
			model: providerModel,
		});
	});

	test('restoring a session with no persisted draft falls back to the provider-reported model', async () => {
		const db = new TestSessionDatabase();
		const { svc, stateManager, agent } = createAgentService(db);
		const providerModel: ModelSelection = { id: 'provider-model' };
		agent.sessionMetadataOverrides = { model: providerModel };

		const session = await svc.createSession({ provider: 'mock' });
		stateManager.removeSession(session.toString());

		await svc.restoreSession(session);

		assert.deepStrictEqual(stateManager.getSessionState(session.toString())?.draft?.model, providerModel);
	});
});
