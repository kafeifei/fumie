/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelSelection } from '../../common/state/protocol/state.js';
import type { ChatState } from '../../common/state/sessionState.js';

/**
 * The conversation fields {@link resolveCurrentSessionModel} reads. Satisfied by
 * a {@link ChatState} and by `ISessionWithDefaultChat` (a session merged with
 * one of its chats), so a caller holding either can ask the same question.
 */
export type ICurrentSessionModelState = Pick<ChatState, 'turns' | 'activeTurn' | 'draft'>;

/**
 * The model a chat is currently working with: the in-flight turn's model while a
 * turn is running (it is captured once at `ChatTurnStarted` and never changes
 * mid-turn), otherwise the composer draft's selection, otherwise the model the
 * last completed turn ran with. `undefined` means no model has ever been
 * selected, and the provider's own default applies.
 */
export function resolveCurrentSessionModel(state: ICurrentSessionModelState | undefined): ModelSelection | undefined {
	if (!state) {
		return undefined;
	}
	return state.activeTurn
		? state.activeTurn.message.model
		: state.draft
			? state.draft.model
			: state.turns.at(-1)?.message.model;
}
