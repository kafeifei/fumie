/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import { hasKey } from '../../../../base/common/types.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import type { ToolCallPendingConfirmationState, UsageInfo } from '../../common/state/protocol/state.js';
import { chatReducer } from '../../common/state/sessionReducers.js';
import { MessageKind, ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ChatState, type ToolResultContent, type Turn } from '../../common/state/sessionState.js';
import { buildAcpToolMeta, getAcpApprovalTarget, getAcpConfirmationTitle, getAcpInvocationMessage, getAcpPastTenseMessage, getAcpToolDisplayName, getAcpToolName, stringifyAcpToolInput, type IAcpApprovalTarget } from './acpToolDisplay.js';

/**
 * ACP → AHP translation. The only decoder in this connector.
 *
 * Everything the agent says arrives here as a typed ACP `SessionUpdate`,
 * `RequestPermissionRequest`, or `PromptResponse`, and leaves as protocol AHP
 * actions. Live streaming and (from M2) `session/load` replay both feed the
 * same mapper, so there is exactly one place where the two protocols meet.
 *
 * Invariant: this file switches on ACP discriminants only. It has no knowledge
 * of which agent produced an update and MUST never acquire any — a branch on an
 * agent's name here is the failure mode this design exists to prevent.
 */

/** Bookkeeping for one tool call across its ACP lifecycle. */
export interface IAcpToolCallRecord {
	readonly toolCallId: string;
	kind: acp.ToolKind | undefined;
	title: string | undefined;
	name: string | undefined;
	status: acp.ToolCallStatus;
	rawInput: unknown;
	rawOutput: unknown;
	locations: readonly acp.ToolCallLocation[];
	content: readonly acp.ToolCallContent[];
	/** A `ChatToolCallReady` (auto-confirmed or pending) has been produced. */
	readyEmitted: boolean;
	/** The agent asked for permission, so the host owns the ready/confirm handshake. */
	permissionRequested: boolean;
	/** A terminal `ChatToolCallComplete` has been produced. */
	completed: boolean;
}

/** Outcome of translating a `session/request_permission` request. */
export interface IAcpPermissionMapping {
	/** Actions that must be dispatched before the confirmation is surfaced. */
	readonly actions: readonly ChatAction[];
	/** Protocol-shaped pending-confirmation state for the host's approval pipeline. */
	readonly state: ToolCallPendingConfirmationState;
	/** Host auto-approval routing hints. */
	readonly target: IAcpApprovalTarget;
}

/** How the host answered a permission ask. */
export const enum AcpPermissionDecision {
	Allow = 'allow',
	Reject = 'reject',
	/** The turn was cancelled while the ask was outstanding. */
	Cancel = 'cancel',
}

/**
 * Chooses the ACP option that expresses a host decision.
 *
 * AHP's permission answer is a boolean because the host — not the agent — owns
 * persistent auto-approval rules. So a host "allow" always maps to the
 * narrowest allow the agent offers (`allow_once`), never to `allow_always`:
 * letting the agent record its own always-allow would create a second,
 * invisible policy store that Fumie's permission UI could neither show nor
 * revoke. `*_always` is only used when the agent offers nothing narrower.
 */
export function selectAcpPermissionOption(options: readonly acp.PermissionOption[], decision: AcpPermissionDecision): acp.PermissionOptionId | undefined {
	if (decision === AcpPermissionDecision.Cancel) {
		return undefined;
	}
	const preferred: readonly acp.PermissionOptionKind[] = decision === AcpPermissionDecision.Allow
		? ['allow_once', 'allow_always']
		: ['reject_once', 'reject_always'];
	for (const kind of preferred) {
		const match = options.find(option => option.kind === kind);
		if (match) {
			return match.optionId;
		}
	}
	return undefined;
}

/** Builds the `session/request_permission` response for a host decision. */
export function buildAcpPermissionResponse(options: readonly acp.PermissionOption[], decision: AcpPermissionDecision): acp.RequestPermissionResponse {
	const optionId = selectAcpPermissionOption(options, decision);
	return optionId
		? { outcome: { outcome: 'selected', optionId } }
		: { outcome: { outcome: 'cancelled' } };
}

/**
 * Per-turn ACP decoder. One instance per prompt turn; the owning agent creates
 * it on send and discards it when the turn ends.
 */
export class AcpTurnMapper {

	private readonly _toolCalls = new Map<string, IAcpToolCallRecord>();
	private _textPartId: string | undefined;
	private _textMessageId: string | null | undefined;
	private _textPartIndex = 0;
	private _thoughtPartId: string | undefined;
	private _thoughtMessageId: string | null | undefined;
	private _thoughtPartIndex = 0;

	constructor(readonly turnId: string) { }

	/** Tool calls seen this turn, for the agent's release / cancel bookkeeping. */
	get toolCalls(): ReadonlyMap<string, IAcpToolCallRecord> {
		return this._toolCalls;
	}

	/**
	 * Translates one `session/update` notification.
	 *
	 * Updates this connector does not consume yet (plans, modes, commands,
	 * config options, compaction) return no actions rather than a placeholder:
	 * a silent omission is recoverable in M2, a fabricated transcript entry is
	 * not.
	 */
	mapSessionUpdate(update: acp.SessionUpdate): readonly ChatAction[] {
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				return this._mapContentChunk(update, false);
			case 'agent_thought_chunk':
				return this._mapContentChunk(update, true);
			case 'user_message_chunk':
				// The host already recorded the user's message on `ChatTurnStarted`;
				// echoing it back would duplicate it in the transcript.
				return [];
			case 'tool_call':
				return this._mapToolCall(update);
			case 'tool_call_update':
				return this._mapToolCallUpdate(update);
			default:
				return [];
		}
	}

	/**
	 * Translates a permission ask into the host's pending-confirmation shape.
	 *
	 * An agent may ask about a tool call it has not announced yet (the request
	 * carries a complete `ToolCallUpdate`), so this synthesises the missing
	 * `ChatToolCallStart` rather than dropping the ask.
	 */
	mapPermissionRequest(params: acp.RequestPermissionRequest): IAcpPermissionMapping {
		const actions: ChatAction[] = [];
		const record = this._toolCalls.get(params.toolCall.toolCallId)
			?? this._startToolCall(toolCallFromUpdate(params.toolCall), actions);
		applyToolCallUpdate(record, params.toolCall);
		record.permissionRequested = true;
		record.readyEmitted = true;
		const toolInput = stringifyAcpToolInput(record.rawInput);
		return {
			actions,
			state: {
				status: ToolCallStatus.PendingConfirmation,
				toolCallId: record.toolCallId,
				toolName: getAcpToolName(record.kind, record.name),
				displayName: getAcpToolDisplayName(record.kind, record.title),
				invocationMessage: getAcpInvocationMessage(record.kind, record.title, record.locations),
				confirmationTitle: getAcpConfirmationTitle(record.kind),
				...(toolInput !== undefined ? { toolInput } : {}),
				...(buildAcpToolMeta(record.kind) ? { _meta: buildAcpToolMeta(record.kind) } : {}),
			},
			target: getAcpApprovalTarget(record.kind, record.locations),
		};
	}

	/** Translates the terminal `session/prompt` response into turn-closing actions. */
	mapStop(response: acp.PromptResponse, duration: number, previousUsage: acp.Usage | undefined): readonly ChatAction[] {
		const actions: ChatAction[] = [...this._closeOpenParts()];
		const usage = acpUsageDelta(previousUsage, response.usage ?? undefined);
		if (usage) {
			actions.push({ type: ActionType.ChatUsage, turnId: this.turnId, usage });
		}
		if (response.stopReason === 'cancelled') {
			actions.push({ type: ActionType.ChatTurnCancelled, turnId: this.turnId, duration });
			return actions;
		}
		if (response.stopReason === 'refusal') {
			actions.push({
				type: ActionType.ChatError,
				turnId: this.turnId,
				duration,
				error: { errorType: 'AcpRefusal', message: 'The agent refused to continue this turn.' },
			});
		}
		actions.push({ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration });
		return actions;
	}

	/** Translates a transport or protocol failure into turn-closing actions. */
	mapFailure(error: unknown, duration: number): readonly ChatAction[] {
		const message = error instanceof Error ? error.message : String(error);
		return [
			...this._closeOpenParts(),
			{
				type: ActionType.ChatError,
				turnId: this.turnId,
				duration,
				error: {
					errorType: error instanceof Error ? error.name : 'AcpError',
					message,
					...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
				},
			},
			{ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration },
		];
	}

	/**
	 * Completes every tool call still open when the turn ends.
	 *
	 * An agent that is cancelled mid-tool may never send the closing
	 * `tool_call_update`, and a tool call left `running` would keep the chat
	 * looking busy forever.
	 */
	closeOutstandingToolCalls(reason: string): readonly ChatAction[] {
		const actions: ChatAction[] = [];
		for (const record of this._toolCalls.values()) {
			if (record.completed || !record.readyEmitted) {
				continue;
			}
			record.completed = true;
			actions.push({
				type: ActionType.ChatToolCallComplete,
				turnId: this.turnId,
				toolCallId: record.toolCallId,
				result: {
					success: false,
					pastTenseMessage: getAcpPastTenseMessage(record.kind, record.title, false),
					error: { message: reason },
				},
			});
		}
		return actions;
	}

	private _mapContentChunk(chunk: acp.ContentChunk, reasoning: boolean): readonly ChatAction[] {
		const text = contentBlockText(chunk.content);
		if (!text) {
			return [];
		}
		const actions: ChatAction[] = [];
		const partId = this._ensurePart(chunk.messageId, reasoning, actions);
		actions.push(reasoning
			? { type: ActionType.ChatReasoning, turnId: this.turnId, partId, content: text }
			: { type: ActionType.ChatDelta, turnId: this.turnId, partId, content: text });
		return actions;
	}

	private _ensurePart(messageId: string | null | undefined, reasoning: boolean, actions: ChatAction[]): string {
		const openId = reasoning ? this._thoughtPartId : this._textPartId;
		const openMessageId = reasoning ? this._thoughtMessageId : this._textMessageId;
		// ACP marks a new message by changing `messageId`. Agents that omit it
		// entirely stream one continuous part, which is the right rendering for a
		// protocol that gives no other message boundary.
		if (openId && (messageId === undefined || messageId === null || messageId === openMessageId)) {
			return openId;
		}
		const index = reasoning ? this._thoughtPartIndex++ : this._textPartIndex++;
		const partId = `${this.turnId}:${reasoning ? 'reasoning' : 'text'}:${String(index)}`;
		actions.push({
			type: ActionType.ChatResponsePart,
			turnId: this.turnId,
			part: { kind: reasoning ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown, id: partId, content: '' },
		});
		if (reasoning) {
			this._thoughtPartId = partId;
			this._thoughtMessageId = messageId;
		} else {
			this._textPartId = partId;
			this._textMessageId = messageId;
		}
		return partId;
	}

	/**
	 * Ends the currently streaming text and reasoning parts so the next chunk
	 * opens a fresh one. Called when a tool call interrupts the prose, which is
	 * what makes a transcript read as "text, tool, text" rather than one blob.
	 */
	private _closeOpenParts(): readonly ChatAction[] {
		this._textPartId = undefined;
		this._textMessageId = undefined;
		this._thoughtPartId = undefined;
		this._thoughtMessageId = undefined;
		return [];
	}

	private _mapToolCall(update: acp.ToolCall): readonly ChatAction[] {
		const actions: ChatAction[] = [];
		this._closeOpenParts();
		const existing = this._toolCalls.get(update.toolCallId);
		const record = existing ?? this._startToolCall(update, actions);
		if (existing) {
			applyToolCall(existing, update);
		}
		this._appendInputDelta(record, actions);
		this._appendLifecycle(record, actions);
		return actions;
	}

	private _mapToolCallUpdate(update: acp.ToolCallUpdate): readonly ChatAction[] {
		const record = this._toolCalls.get(update.toolCallId);
		if (!record) {
			// A tool call the agent never announced. Synthesize the start so the
			// update is not silently lost.
			const actions: ChatAction[] = [];
			this._closeOpenParts();
			const created = this._startToolCall(toolCallFromUpdate(update), actions);
			applyToolCallUpdate(created, update);
			this._appendInputDelta(created, actions);
			this._appendLifecycle(created, actions);
			return actions;
		}
		const previousInput = stringifyAcpToolInput(record.rawInput);
		applyToolCallUpdate(record, update);
		const actions: ChatAction[] = [];
		if (!record.readyEmitted && stringifyAcpToolInput(record.rawInput) !== previousInput) {
			this._appendInputDelta(record, actions);
		}
		this._appendLifecycle(record, actions);
		return actions;
	}

	private _startToolCall(update: acp.ToolCall, actions: ChatAction[]): IAcpToolCallRecord {
		const record: IAcpToolCallRecord = {
			toolCallId: update.toolCallId,
			kind: update.kind,
			title: update.title,
			name: update.name ?? undefined,
			status: update.status ?? 'pending',
			rawInput: update.rawInput,
			rawOutput: update.rawOutput,
			locations: update.locations ?? [],
			content: update.content ?? [],
			readyEmitted: false,
			permissionRequested: false,
			completed: false,
		};
		this._toolCalls.set(record.toolCallId, record);
		const meta = buildAcpToolMeta(record.kind);
		actions.push({
			type: ActionType.ChatToolCallStart,
			turnId: this.turnId,
			toolCallId: record.toolCallId,
			toolName: getAcpToolName(record.kind, record.name),
			displayName: getAcpToolDisplayName(record.kind, record.title),
			...(meta ? { _meta: meta } : {}),
		});
		return record;
	}

	private _appendInputDelta(record: IAcpToolCallRecord, actions: ChatAction[]): void {
		const toolInput = stringifyAcpToolInput(record.rawInput);
		if (toolInput === undefined) {
			return;
		}
		actions.push({
			type: ActionType.ChatToolCallDelta,
			turnId: this.turnId,
			toolCallId: record.toolCallId,
			content: toolInput,
		});
	}

	/**
	 * Drives the tool call from `streaming` to its terminal state.
	 *
	 * The host's reducer only accepts a completion for a call that already
	 * reached `running`, and a call only reaches `running` through a
	 * `ChatToolCallReady`. When the agent asked for permission the host owns
	 * that transition; when it did not — because the agent auto-approved
	 * internally — this emits the auto-confirmed ready itself, otherwise the
	 * tool call would be stranded mid-stream forever.
	 */
	private _appendLifecycle(record: IAcpToolCallRecord, actions: ChatAction[]): void {
		const terminal = record.status === 'completed' || record.status === 'failed';
		if (!record.readyEmitted && (terminal || record.status === 'in_progress')) {
			record.readyEmitted = true;
			const toolInput = stringifyAcpToolInput(record.rawInput);
			const meta = buildAcpToolMeta(record.kind);
			actions.push({
				type: ActionType.ChatToolCallReady,
				turnId: this.turnId,
				toolCallId: record.toolCallId,
				invocationMessage: getAcpInvocationMessage(record.kind, record.title, record.locations),
				confirmed: ToolCallConfirmationReason.NotNeeded,
				...(toolInput !== undefined ? { toolInput } : {}),
				...(meta ? { _meta: meta } : {}),
			});
		}
		if (!terminal || record.completed) {
			return;
		}
		record.completed = true;
		const success = record.status === 'completed';
		const content = mapToolCallContent(record.content);
		actions.push({
			type: ActionType.ChatToolCallComplete,
			turnId: this.turnId,
			toolCallId: record.toolCallId,
			result: {
				success,
				pastTenseMessage: getAcpPastTenseMessage(record.kind, record.title, success),
				...(content.length ? { content } : {}),
				...(success ? {} : { error: { message: toolFailureMessage(content, record) } }),
			},
		});
	}
}

/**
 * Folds a `session/load` replay into completed turns.
 *
 * Deliberately not a second decoder. Every replayed update goes through
 * {@link AcpTurnMapper} — the same instance type, the same methods a live turn
 * uses — and the actions it produces are folded by {@link chatReducer}, the
 * host's own function for turning those actions into turns. Both halves of
 * "what did the agent say" and "what does that look like in a transcript" are
 * therefore shared with live streaming, and a fix to either is a fix to both.
 *
 * What this class adds is the one fact ACP states only in a replay: where
 * turns begin. Live streaming learns that from the host — `sendMessage` opens
 * the turn and already knows the user's text, which is why the mapper discards
 * `user_message_chunk` as a duplicate. In a replay that chunk is the only
 * record that the user ever said anything, so here it is the turn boundary.
 */
export class AcpReplayCollector {

	/**
	 * ACP replays a transcript with no clock — no update carries a timestamp —
	 * but the reducer needs one to mint a turn. So it is handed this sentinel
	 * and {@link finish} drops it again rather than shipping it as a fact.
	 */
	private static readonly _NO_TIMESTAMP = new Date(0).toISOString();

	private _state: ChatState;
	private _mapper: AcpTurnMapper | undefined;
	private _userText: string | undefined;
	private _turnIndex = 0;

	/**
	 * @param _hostInstructions The instructions the host injected into this
	 * chat's prompts, so the replay can tell them apart from what the user
	 * typed. See {@link stripAcpHostInstructions}.
	 */
	constructor(chat: string, private readonly _acpSessionId: string, private readonly _hostInstructions?: readonly string[]) {
		this._state = {
			resource: chat,
			title: '',
			status: SessionStatus.Idle,
			modifiedAt: AcpReplayCollector._NO_TIMESTAMP,
			turns: [],
		};
	}

	/** Absorbs one replayed `session/update`. */
	accept(update: acp.SessionUpdate): void {
		if (update.sessionUpdate === 'user_message_chunk') {
			// A user message ends whatever turn came before it and opens the next.
			// Consecutive chunks are one message, so only the first is a boundary.
			if (this._userText === undefined) {
				this._endTurn();
				this._userText = '';
			}
			const spoken = contentBlockText(update.content) ?? '';
			const typed = stripAcpHostInstructions(spoken, this._hostInstructions);
			// A block that was nothing but host instructions still holds the
			// separators that joined them. Contributing that would indent the
			// user's real text by however many instructions preceded it.
			this._userText += typed === spoken || typed.trim() ? typed : '';
			return;
		}
		this._beginTurn();
		// Agent output before the user ever spoke has no turn to belong to.
		// Dropping it keeps the transcript honest about who said what.
		if (this._mapper) {
			this._apply(this._mapper.mapSessionUpdate(update));
		}
	}

	/** The replayed conversation, as completed turns. */
	finish(): readonly Turn[] {
		// A trailing user message the agent never answered is still a turn: the
		// app may have died mid-response, and hiding the prompt would be a lie.
		this._beginTurn();
		this._endTurn();
		return this._state.turns.map((turn): Turn => ({
			id: turn.id,
			message: turn.message,
			responseParts: turn.responseParts,
			usage: turn.usage,
			state: turn.state,
			...(turn.error ? { error: turn.error } : {}),
		}));
	}

	private _beginTurn(): void {
		const text = this._userText;
		if (text === undefined) {
			return;
		}
		this._userText = undefined;
		// Derived from the ACP session id rather than minted fresh, so replaying
		// the same conversation twice names the same turns and the host sees a
		// restore instead of a brand-new history.
		const turnId = `${this._acpSessionId}:${String(this._turnIndex++)}`;
		this._mapper = new AcpTurnMapper(turnId);
		this._apply([{
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: AcpReplayCollector._NO_TIMESTAMP,
			message: { text, origin: { kind: MessageKind.User } },
		}]);
	}

	private _endTurn(): void {
		const mapper = this._mapper;
		if (!mapper) {
			return;
		}
		this._mapper = undefined;
		// Tool calls the transcript never resolved are left to the reducer, which
		// cancels them — the same treatment a live turn's stragglers get, and a
		// truer account than reporting a failure the agent never reported.
		this._apply([{ type: ActionType.ChatTurnComplete, turnId: mapper.turnId, duration: 0 }]);
		this._dropIfEmpty(mapper.turnId);
	}

	/**
	 * Discards a turn that has nothing left to show.
	 *
	 * A prompt the host built entirely out of its own instructions scrubs to
	 * nothing. When the agent answered it with nothing too, what remains is not
	 * an empty user bubble but an exchange that never belonged in the
	 * transcript, and keeping it would render a blank row. A turn that still
	 * carries an answer, an error, or an attachment is kept whatever became of
	 * its text — the agent said something, and that is the transcript.
	 */
	private _dropIfEmpty(turnId: string): void {
		const turns = this._state.turns;
		const turn = turns[turns.length - 1];
		if (!turn || turn.id !== turnId) {
			return;
		}
		if (turn.message.text.trim() || turn.message.attachments?.length || turn.responseParts.length || turn.error) {
			return;
		}
		this._state = { ...this._state, turns: turns.slice(0, -1) };
	}

	private _apply(actions: readonly ChatAction[]): void {
		for (const action of actions) {
			this._state = chatReducer(this._state, action);
		}
	}
}

/**
 * Removes host-injected instructions from a replayed user message.
 *
 * The host attaches per-operation instructions to a send on the explicit
 * promise that they reach the model "without persisting as user content"
 * (`IAgentChatContext.hostInstructions`). Every other provider keeps that
 * promise through its SDK's system-prompt channel. ACP v1 has none, so this
 * connector rides them in as a leading text block of the user's message — see
 * `acpPromptBlocks` — and the agent, which was never told the block was
 * special, writes it into its transcript as user content and replays it back
 * verbatim. That is how a restored chat starts showing the host's instructions
 * to the user, in their own voice, on every turn. Undoing it on the way out is
 * what keeps the host's promise on a protocol that cannot.
 *
 * Only text the host itself supplied is removed, so this can never eat
 * something the user typed: an instruction the host has since stopped sending
 * simply is not recognised and survives as ordinary text, which is the honest
 * failure — a stale line the user can read beats a guess at what they meant.
 */
export function stripAcpHostInstructions(text: string, instructions: readonly string[] | undefined): string {
	let result = text;
	for (const instruction of instructions ?? []) {
		if (instruction) {
			result = result.split(instruction).join('');
		}
	}
	return result;
}

/**
 * Per-turn token usage from ACP's cumulative session totals.
 *
 * ACP reports `Usage` as running session-wide sums while AHP's `ChatUsage` is
 * per-turn, so this differences the two snapshots. A decrease means the agent
 * reset its counters (a restarted process, a compaction); that snapshot becomes
 * the new baseline and is reported as-is rather than as a negative delta.
 *
 * Each delta is transcribed into the protocol counter that means the same thing
 * and nothing is summed here; the client derives occupancy centrally. ACP has
 * no cache-write counter, so `_meta.cacheCreationTokens` stays unset — an
 * absent field, not a zero, because the agent said nothing about it.
 */
export function acpUsageDelta(previous: acp.Usage | undefined, current: acp.Usage | undefined): UsageInfo | undefined {
	if (!current) {
		return undefined;
	}
	const delta = (now: number | null | undefined, before: number | null | undefined): number => {
		const value = typeof now === 'number' ? now : 0;
		const base = typeof before === 'number' ? before : 0;
		return value >= base ? value - base : value;
	};
	const inputTokens = delta(current.inputTokens, previous?.inputTokens);
	const outputTokens = delta(current.outputTokens, previous?.outputTokens);
	const cacheReadTokens = delta(current.cachedReadTokens, previous?.cachedReadTokens);
	if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) {
		return undefined;
	}
	return {
		inputTokens,
		outputTokens,
		...(cacheReadTokens ? { cacheReadTokens } : {}),
	};
}

/**
 * Flattens ACP tool-call content into AHP tool-result content.
 *
 * `diff` blocks degrade to a text summary: AHP's structured `fileEdit` result
 * requires host-hosted before/after content references, which the connector
 * cannot mint from an inline diff. Fumie's own changeset watcher still shows
 * the real file change, so the information is not lost — only the inline
 * preview is. `terminal` blocks are dropped because this client does not
 * advertise the terminal capability and so can never own the referenced
 * terminal.
 */
export function mapToolCallContent(content: readonly acp.ToolCallContent[]): ToolResultContent[] {
	const result: ToolResultContent[] = [];
	for (const item of content) {
		if (item.type === 'content') {
			const text = contentBlockText(item.content);
			if (text) {
				result.push({ type: ToolResultContentType.Text, text });
			}
		} else if (item.type === 'diff') {
			result.push({ type: ToolResultContentType.Text, text: describeDiff(item) });
		}
	}
	return result;
}

/** Plain text carried by an ACP content block, when it carries any. */
export function contentBlockText(block: acp.ContentBlock | undefined): string | undefined {
	if (!block) {
		return undefined;
	}
	if (block.type === 'text') {
		return block.text;
	}
	if (block.type === 'resource_link') {
		return block.uri;
	}
	if (block.type === 'resource' && hasKey(block.resource, { text: true }) && typeof block.resource.text === 'string') {
		return block.resource.text;
	}
	return undefined;
}

function describeDiff(diff: acp.Diff): string {
	const added = countLines(diff.newText);
	const removed = countLines(diff.oldText ?? undefined);
	return `${diff.path} (+${String(added)} -${String(removed)})`;
}

function countLines(text: string | undefined): number {
	if (!text) {
		return 0;
	}
	return text.split('\n').length;
}

function toolFailureMessage(content: readonly ToolResultContent[], record: IAcpToolCallRecord): string {
	for (const item of content) {
		if (item.type === ToolResultContentType.Text && item.text) {
			return item.text;
		}
	}
	return `${getAcpToolDisplayName(record.kind, record.title)} failed.`;
}

/** Promotes a partial `ToolCallUpdate` into a full `ToolCall` for a first sighting. */
function toolCallFromUpdate(update: acp.ToolCallUpdate): acp.ToolCall {
	return {
		toolCallId: update.toolCallId,
		title: update.title ?? '',
		...(update.name ? { name: update.name } : {}),
		...(update.kind ? { kind: update.kind } : {}),
		...(update.status ? { status: update.status } : {}),
		...(update.content ? { content: update.content } : {}),
		...(update.locations ? { locations: update.locations } : {}),
		...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
		...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
	};
}

function applyToolCall(record: IAcpToolCallRecord, update: acp.ToolCall): void {
	record.kind = update.kind ?? record.kind;
	record.title = update.title || record.title;
	record.name = update.name ?? record.name;
	record.status = update.status ?? record.status;
	record.rawInput = update.rawInput ?? record.rawInput;
	record.rawOutput = update.rawOutput ?? record.rawOutput;
	record.locations = update.locations ?? record.locations;
	record.content = update.content ?? record.content;
}

/** Applies ACP patch semantics: an omitted or null field leaves the value unchanged. */
function applyToolCallUpdate(record: IAcpToolCallRecord, update: acp.ToolCallUpdate): void {
	record.kind = update.kind ?? record.kind;
	record.title = update.title ?? record.title;
	record.name = update.name ?? record.name;
	record.status = update.status ?? record.status;
	record.rawInput = update.rawInput ?? record.rawInput;
	record.rawOutput = update.rawOutput ?? record.rawOutput;
	record.locations = update.locations ?? record.locations;
	record.content = update.content ?? record.content;
}
