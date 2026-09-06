/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import type { ActionEnvelope, StateAction } from '../../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { SessionStatus, TurnState, type ChatState, type SessionState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { isTurnAcknowledged, TURN_ACKNOWLEDGEMENT_TIMEOUT_MS, turnNotAcknowledgedError, turnRejectedError, turnRejectionReason } from '../../../browser/agentSessions/agentHost/agentHostTurnWatchdog.js';

suite('agentHostTurnWatchdog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const message = { text: 'hello', origin: { kind: 'user' } } as ChatState['turns'][number]['message'];

	function chatState(overrides: Partial<ChatState>): ChatState {
		return { turns: [], ...overrides } as ChatState;
	}

	function session(overrides: Partial<SessionState> = {}): SessionState {
		return { status: SessionStatus.Idle, ...overrides } as SessionState;
	}

	function activeTurn(id: string) {
		return { id, startedAt: new Date().toISOString(), message, responseParts: [], usage: undefined };
	}

	function endedTurn(id: string, state: TurnState) {
		return { id, message, responseParts: [], usage: undefined, state };
	}

	test('a turn the host is streaming counts as acknowledged, however long it then runs', () => {
		// The only thing that disarms the watchdog is the host having the turn.
		// Nothing about output or elapsed time enters into it, which is what keeps
		// a ten-minute turn safe.
		const verified = chatState({ activeTurn: activeTurn('turn-1') });
		assert.strictEqual(isTurnAcknowledged(session(), verified, 'turn-1'), true);
	});

	test('a turn the host never confirmed is unacknowledged, even though the client sees it locally', () => {
		// This is the failure being caught: the dispatch is fire-and-forget, so the
		// client's own optimistic state shows the turn active while the verified
		// state — the only record of what the host agreed to — has nothing.
		const optimistic = chatState({ activeTurn: activeTurn('turn-1') });
		const verified = chatState({});

		assert.deepStrictEqual({
			whatTheClientSees: optimistic.activeTurn?.id,
			acknowledged: isTurnAcknowledged(session(), verified, 'turn-1'),
		}, {
			whatTheClientSees: 'turn-1',
			acknowledged: false,
		});
	});

	test('a turn that already ended is acknowledged, so the watchdog leaves finalizing to the normal path', () => {
		const errored = chatState({ turns: [endedTurn('turn-1', TurnState.Error)] });
		const completed = chatState({ turns: [endedTurn('turn-2', TurnState.Complete)] });

		assert.deepStrictEqual({
			errored: isTurnAcknowledged(session(), errored, 'turn-1'),
			completed: isTurnAcknowledged(session(), completed, 'turn-2'),
		}, {
			errored: true,
			completed: true,
		});
	});

	test('another turn on the same chat does not acknowledge this one', () => {
		const verified = chatState({ activeTurn: activeTurn('turn-2'), turns: [endedTurn('turn-0', TurnState.Complete)] });
		assert.strictEqual(isTurnAcknowledged(session(), verified, 'turn-1'), false);
	});

	test('no verified session at all is not an acknowledgement', () => {
		// The host rejected the session this turn was meant to run in, which is
		// exactly the case that used to spin forever.
		assert.strictEqual(isTurnAcknowledged(undefined, undefined, 'turn-1'), false);
	});

	test('the failure it records is readable and tells the user what to do', () => {
		const error = turnNotAcknowledgedError();
		assert.deepStrictEqual({
			errorType: error.errorType,
			mentionsRetry: /again/i.test(error.message),
			isEmpty: error.message.length === 0,
		}, {
			errorType: 'agentHostTurnNotAcknowledged',
			mentionsRetry: true,
			isEmpty: false,
		});
	});

	test('the deadline bounds acknowledgement only, and stays clear of the host hang report', () => {
		assert.deepStrictEqual({
			withinAskedRange: TURN_ACKNOWLEDGEMENT_TIMEOUT_MS >= 60_000 && TURN_ACKNOWLEDGEMENT_TIMEOUT_MS <= 120_000,
			belowHostHangThreshold: TURN_ACKNOWLEDGEMENT_TIMEOUT_MS < 5 * 60_000,
		}, {
			withinAskedRange: true,
			belowHostHangThreshold: true,
		});
	});

	suite('turn rejection', () => {
		function envelope(action: StateAction, rejectionReason?: string): ActionEnvelope {
			return { channel: 'ahp-chat://default/x', action, serverSeq: 1, origin: { clientId: 'c', clientSeq: 1 }, rejectionReason };
		}

		function turnStarted(turnId: string): StateAction {
			return { type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message } as unknown as StateAction;
		}

		test('reads the reason off a rejected turn-start for this turn', () => {
			const reason = `Codex model 'codex-subscription:@provider=openai:gpt-5.6-sol' is not available.`;
			assert.strictEqual(turnRejectionReason(envelope(turnStarted('turn-1'), reason), 'turn-1'), reason);
		});

		test('ignores a rejection that belongs to another turn', () => {
			assert.strictEqual(turnRejectionReason(envelope(turnStarted('turn-2'), 'nope'), 'turn-1'), undefined);
		});

		test('ignores an accepted turn-start — an echo with no rejection is the normal path', () => {
			// The same action comes back confirmed on the happy path; only a
			// rejectionReason must fail the turn, never the acknowledgement itself.
			assert.strictEqual(turnRejectionReason(envelope(turnStarted('turn-1')), 'turn-1'), undefined);
		});

		test('ignores a rejected action that is not the turn start', () => {
			const toolComplete = { type: ActionType.ChatToolCallComplete, turnId: 'turn-1', toolCallId: 't' } as unknown as StateAction;
			assert.strictEqual(turnRejectionReason(envelope(toolComplete, 'denied'), 'turn-1'), undefined);
		});

		test('the failure carries the host reason so the user is not left with a silent success', () => {
			const reason = `Codex model 'X' is not available.`;
			const error = turnRejectedError(reason);
			assert.deepStrictEqual({
				errorType: error.errorType,
				carriesReason: error.message.includes(reason),
			}, {
				errorType: 'agentHostTurnRejected',
				carriesReason: true,
			});
		});

		test('falls back to a readable line when the host gave no reason', () => {
			assert.deepStrictEqual({
				empty: turnRejectedError('').message,
				whitespace: turnRejectedError('   ').message,
				undef: turnRejectedError(undefined).message,
			}, {
				empty: 'The agent could not run this message. Send it again to retry.',
				whitespace: 'The agent could not run this message. Send it again to retry.',
				undef: 'The agent could not run this message. Send it again to retry.',
			});
		});
	});
});
