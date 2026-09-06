/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { mergeSessionWithDefaultChat, type ChatState, type ErrorInfo, type SessionState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import type { ActionEnvelope } from '../../../../../../platform/agentHost/common/state/protocol/common/actions.js';

/**
 * How long a dispatched turn may go unacknowledged by the agent host before the
 * client gives up on it and fails it.
 *
 * This bounds the *acknowledgement*, never the turn. Dispatching a turn is a
 * fire-and-forget notification that the client reduces into its own optimistic
 * state immediately, so a turn the host never received — its session failed to
 * create, the agent threw before starting the turn — still renders as a response
 * that streams nothing and never ends.
 *
 * The host confirms a turn as soon as it has one, long before any token, so a
 * model that then thinks for ten minutes is unaffected: it was acknowledged in
 * the first second and this watchdog is disarmed for the rest of the turn. That
 * is the whole point of keying on acknowledgement rather than on output — a
 * limit on output would kill exactly the long, legitimate turns.
 *
 * 90s rather than something tighter because acknowledgement can legitimately
 * wait on session creation, SDK startup and MCP server launch on a cold host;
 * and well below the 5 minute `TURN_HANG_THRESHOLD_MS` the host uses to report a
 * turn that *is* running as hung, so the two never race.
 */
export const TURN_ACKNOWLEDGEMENT_TIMEOUT_MS = 90_000;

/**
 * Whether the agent host has confirmed this turn, as opposed to the turn
 * existing only because this client optimistically applied its own dispatch.
 *
 * `verified` is the state the host has actually acknowledged; the state the rest
 * of the handler observes also carries this client's un-acknowledged writes, so
 * it cannot tell a turn the agent is working on from one it never heard of.
 *
 * A turn that has already ended counts as acknowledged: the host clearly had it,
 * and finalizing it is the normal path's job, not the watchdog's.
 */
export function isTurnAcknowledged(
	verifiedSession: SessionState | undefined,
	verifiedChat: ChatState | undefined,
	turnId: string,
): boolean {
	if (!verifiedSession) {
		return false;
	}
	const state = mergeSessionWithDefaultChat(verifiedSession, verifiedChat);
	return state.activeTurn?.id === turnId || state.turns.some(turn => turn.id === turnId);
}

/** The failure recorded on a turn the agent never picked up. */
export function turnNotAcknowledgedError(): ErrorInfo {
	return {
		errorType: 'agentHostTurnNotAcknowledged',
		message: localize('agentHost.turnNotAcknowledged', "The agent did not respond to this message. It may have failed to start. Send it again to retry."),
	};
}

/**
 * The reason the host gave for rejecting this turn, or `undefined` when the
 * envelope is not a rejection of this turn's start.
 *
 * Dispatching a turn is a fire-and-forget notification the client applies to its
 * own optimistic state at once; when the host cannot run it — an unavailable
 * model, say — it echoes the turn-start action back carrying a
 * {@link ActionEnvelope.rejectionReason}, and the subscription rolls the
 * optimistic turn back to nothing. Left alone, the turn then simply vanishes and
 * the response completes looking successful, with the reason never read. The
 * turn-start dispatch is the one that carries the "run this message" intent, so
 * its rejection is the one that fails the turn; other client actions have their
 * own paths.
 */
export function turnRejectionReason(envelope: ActionEnvelope, turnId: string): string | undefined {
	if (!envelope.rejectionReason) {
		return undefined;
	}
	const action = envelope.action;
	return action.type === ActionType.ChatTurnStarted && action.turnId === turnId
		? envelope.rejectionReason
		: undefined;
}

/** The failure recorded on a turn the host refused, carrying its reason when it gave one. */
export function turnRejectedError(reason: string | undefined): ErrorInfo {
	const trimmed = reason?.trim();
	return {
		errorType: 'agentHostTurnRejected',
		message: trimmed
			? localize('agentHost.turnRejected.reason', "The agent could not run this message: {0}", trimmed)
			: localize('agentHost.turnRejected', "The agent could not run this message. Send it again to retry."),
	};
}
