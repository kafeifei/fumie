/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, resolve } from '../../../../base/common/path.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { AgentSignal, IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import type { UsageInfo } from '../../common/state/protocol/state.js';
import { chatReducer } from '../../common/state/sessionReducers.js';
import { MessageKind, ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ChatState, type Turn } from '../../common/state/sessionState.js';
import type { IOpencodeEvent } from './opencodeServerService.js';
import { OPENCODE_TASK_TOOL, buildOpencodeToolMeta, getOpencodeApprovalTarget, getOpencodeConfirmationTitle, getOpencodeInvocationMessage, getOpencodePastTenseMessage, getOpencodeToolDisplayName, stringifyOpencodeToolInput, type IOpencodeApprovalTarget } from './opencodeToolDisplay.js';

/**
 * opencode SSE → AHP translation. The only decoder in this connector.
 *
 * opencode publishes one global event stream for the whole server, and that is
 * the property this mapper is built around: a delegated subagent is an ordinary
 * opencode session whose parts, tool calls and permission asks arrive on the
 * same stream as its parent's. So nesting is not reconstructed from a
 * transcript afterwards — the `task` tool call names the child session it
 * spawned (`state.metadata.sessionId`), and from that moment every event
 * carrying that session id is re-addressed to the subagent chat by stamping the
 * spawning tool call on it (`parentToolCallId`), which is the same seam the
 * Claude harness uses for its inner messages.
 *
 * Because subagent chats are keyed flatly off the spawning tool call, one hop
 * is enough at any depth: a `task` inside a subagent links its own child
 * session to its own call id, and the host resolves the chain.
 *
 * One instance per attached chat; child routes survive root turn boundaries.
 * It performs no I/O — answering a permission ask is the
 * agent's job — so the whole projection is unit-testable against recorded
 * event frames.
 */

/** A part as it appears on `message.part.updated`. */
export interface IOpencodePart {
	readonly id: string;
	readonly sessionID: string;
	readonly messageID: string;
	readonly type: string;
	readonly text?: string;
	readonly tool?: string;
	readonly callID?: string;
	readonly state?: IOpencodeToolState;
	/** Set on text opencode generated rather than the user typing it. */
	readonly synthetic?: boolean;
}

export interface IOpencodeToolState {
	readonly status: 'pending' | 'running' | 'completed' | 'error';
	readonly input?: unknown;
	readonly output?: string;
	readonly error?: string;
	readonly title?: string;
	readonly metadata?: Record<string, unknown>;
}

/** Per-call token counters opencode reports on a completed assistant message. */
export interface IOpencodeTokens {
	readonly input?: number;
	readonly output?: number;
	readonly reasoning?: number;
	readonly cache?: { readonly read?: number; readonly write?: number };
}

/**
 * A permission ask, in either of the two shapes opencode publishes.
 *
 * 1.18.25 carries both `permission.asked` and `permission.v2.asked` on the same
 * stream and, in practice, asks in the **v1** shape — the v2 names are the ones
 * its schema leads with, which is exactly why this reads both. The two say the
 * same thing under different names: the permission being requested (`action` /
 * `permission`), what it concerns (`resources` / `patterns`), and the tool call
 * it belongs to (`source` / `tool`). Everything below reads the pair, so
 * whichever shape arrives is answered identically — and a version that only ever
 * sends one of them still works.
 */
export interface IOpencodePermissionAsk {
	readonly id: string;
	readonly sessionID: string;
	/** v2 name for the permission being asked about. */
	readonly action?: string;
	/** v1 name for the same thing. */
	readonly permission?: string;
	/** v2 name for what the ask concerns (paths, commands, URLs). */
	readonly resources?: readonly string[];
	/** v1 name for the same thing. */
	readonly patterns?: readonly string[];
	/** v2 link to the tool call this ask belongs to. */
	readonly source?: { readonly type: string; readonly messageID: string; readonly callID: string };
	/** v1 link to the same tool call. */
	readonly tool?: { readonly messageID: string; readonly callID: string };
}

/** The tool call an ask belongs to, whichever shape named it. */
function askCallID(ask: IOpencodePermissionAsk): string {
	// Falling back to the ask's own id keeps a non-tool ask addressable: the host
	// answers by `state.toolCallId`, so it has to be something.
	return ask.source?.callID ?? ask.tool?.callID ?? ask.id;
}

/** What the ask concerns, whichever shape named it. */
function askResources(ask: IOpencodePermissionAsk): readonly string[] {
	return ask.resources ?? ask.patterns ?? [];
}

/** Outcome of translating a permission ask; the agent answers it over HTTP. */
export interface IOpencodePermissionMapping {
	/** Actions to dispatch before the confirmation is surfaced (a synthesized tool-call start). */
	readonly signals: readonly AgentSignal[];
	/** The pending-confirmation signal to fire; the host answers it by `state.toolCallId`. */
	readonly confirmation: IAgentToolPendingConfirmationSignal;
}

interface IOpencodeToolRecord {
	readonly callID: string;
	readonly sessionID: string;
	toolName: string;
	input: unknown;
	title: string | undefined;
	status: IOpencodeToolState['status'];
	/** A `ChatToolCallReady` (auto-confirmed or via the host's confirmation) has been produced. */
	readyEmitted: boolean;
	/** The host owns the ready/confirm handshake because opencode asked for permission. */
	permissionRequested: boolean;
	completed: boolean;
	/** The child session this `task` call spawned, once it named one. */
	childSessionID?: string;
	background?: boolean;
}

interface IOpencodeStreamPart {
	readonly messageID: string;
	readonly kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning;
	readonly partId: string;
	readonly sessionID: string;
	/** Characters already published, so a snapshot only contributes its tail. */
	emitted: number;
}

export class OpencodeTurnMapper {

	/** Assistant parts seen this turn, keyed by opencode part id. */
	private readonly _parts = new Map<string, IOpencodeStreamPart>();
	/** Messages the user (or the parent's `task` prompt) authored; their parts are not transcript output. */
	private readonly _userMessages = new Map<string, string>();
	private readonly _submittedMessages = new Set<string>();
	private readonly _backgroundResultMessages = new Set<string>();
	private readonly _childMessages = new Map<string, string>();
	private readonly _closedMessages = new Set<string>();
	private readonly _toolCalls = new Map<string, IOpencodeToolRecord>();
	/** Child session id → the `task` call that spawned it. */
	private readonly _subagents = new Map<string, string>();
	private readonly _completedSubagents = new Set<string>();
	private readonly _backgroundSubagents = new Set<string>();
	private readonly _usageReported = new Set<string>();
	private _textPartIndex = 0;
	private _reasoningPartIndex = 0;
	/** An error has already been reported for the root chat this turn. */
	private _rootErrorReported = false;

	constructor(
		public turnId: string,
		private readonly _chat: URI,
		private readonly _rootSessionID: string,
		private readonly _cwd: string,
		private _startedAt: number,
	) { }

	beginTurn(turnId: string, startedAt: number): void {
		this.turnId = turnId;
		this._startedAt = startedAt;
		this._rootErrorReported = false;
	}

	ownsChild(sessionID: string): boolean {
		return this._subagents.has(sessionID);
	}

	recordSubmittedMessage(messageID: string): void {
		this._submittedMessages.add(messageID);
	}

	/** v1.18.29 native task-result envelope, never ordinary user/tool output. */
	backgroundResultForPart(part: IOpencodePart): string | undefined {
		if (part.type !== 'text' || !part.synthetic || this._submittedMessages.has(part.messageID) || this._backgroundResultMessages.has(part.messageID) || this._userMessages.get(part.messageID) !== part.sessionID) {
			return undefined;
		}
		const task = /^<task id="([^"]+)" state="(?:completed|error)">[\s\S]*<\/task>$/.exec(part.text ?? '');
		const callID = task && this._subagents.get(task[1]);
		return task && callID && this._backgroundSubagents.has(task[1]) && this._toolCalls.get(callID)?.sessionID === part.sessionID ? task[1] : undefined;
	}

	get hasActiveSubagents(): boolean {
		return this._backgroundSubagents.size > 0 || this._subagents.size > this._completedSubagents.size;
	}

	/** A native synthetic task result ends the whole job, including queued extensions. */
	mapBackgroundResult(sessionID: string): readonly AgentSignal[] {
		this._backgroundSubagents.delete(sessionID);
		const signals: AgentSignal[] = [];
		this._completeSubagent(sessionID, signals);
		return signals;
	}

	private _completeSubagent(sessionID: string, signals: AgentSignal[]): void {
		const toolCallId = this._subagents.get(sessionID);
		if (toolCallId && !this._completedSubagents.has(sessionID)) {
			this._completedSubagents.add(sessionID);
			for (const [messageID, owner] of this._childMessages) {
				if (owner === sessionID) {
					this._closedMessages.add(messageID);
				}
			}
			signals.push({ kind: 'subagent_completed', chat: this._chat, toolCallId });
		}
	}

	/** Tool calls seen this turn, for the agent's cancellation bookkeeping. */
	get toolCalls(): ReadonlyMap<string, IOpencodeToolRecord> {
		return this._toolCalls;
	}

	/**
	 * Translates one event frame.
	 *
	 * Frames for a session this turn has no route to — another workspace's chat
	 * on the same server, a child whose spawning call has not named it yet —
	 * produce nothing rather than being guessed onto the root chat.
	 */
	mapEvent(event: IOpencodeEvent): readonly AgentSignal[] {
		const info = event.properties['info'];
		const part = event.properties['part'];
		const sessionID = event.properties['sessionID'] ?? (isRecord(info) ? info['sessionID'] : undefined) ?? (isRecord(part) ? part['sessionID'] : undefined);
		const messageID = event.properties['messageID'] ?? (isRecord(info) ? info['id'] : undefined) ?? (isRecord(part) ? part['messageID'] : undefined);
		if (typeof sessionID === 'string' && this.ownsChild(sessionID)) {
			if (typeof messageID === 'string') {
				this._childMessages.set(messageID, sessionID);
			}
			if (this._completedSubagents.has(sessionID)) {
				if (typeof messageID === 'string') {
					this._closedMessages.add(messageID);
				}
				return [];
			}
			if (typeof messageID === 'string' && this._closedMessages.has(messageID)) {
				return [];
			}
		}
		switch (event.type) {
			case 'message.updated':
				return this._mapMessageUpdated(event.properties);
			case 'message.part.updated':
				return this._mapPartUpdated(event.properties);
			case 'message.part.delta':
				return this._mapPartDelta(event.properties);
			case 'session.error':
				return this._mapSessionError(event.properties);
			case 'session.status': {
				const sessionID = event.properties['sessionID'];
				const status = event.properties['status'];
				const signals: AgentSignal[] = [];
				if (typeof sessionID === 'string' && this.ownsChild(sessionID) && isRecord(status)) {
					// A background runner can idle between queued extensions. Closing
					// its AHP turn here lets late output reopen an unfinishable turn.
					if (status['type'] === 'idle' && !this._backgroundSubagents.has(sessionID)) {
						this._completeSubagent(sessionID, signals);
					}
				}
				return signals;
			}
			default:
				// Everything else is either bookkeeping the host already owns
				// (`session.status`, `session.idle`, `session.diff`, step parts) or a
				// surface this connector does not project yet. A silent omission is
				// recoverable; a fabricated transcript entry is not.
				return [];
		}
	}

	/**
	 * Translates a permission ask into the host's pending-confirmation shape.
	 *
	 * opencode asks before it runs a tool, and names the tool call it is asking
	 * about, so the confirmation is addressed by that call id — which is also the
	 * id the host answers with. An ask for a call this turn has not seen yet
	 * synthesizes its start rather than being dropped.
	 */
	mapPermissionAsk(ask: IOpencodePermissionAsk): IOpencodePermissionMapping | undefined {
		const route = this._route(ask.sessionID);
		if (!route) {
			return undefined;
		}
		const callID = askCallID(ask);
		const signals: AgentSignal[] = [];
		const record = this._toolCalls.get(callID) ?? this._startToolCall(callID, ask.sessionID, ask.action ?? ask.permission ?? 'tool', signals);
		record.permissionRequested = true;
		record.readyEmitted = true;
		const toolInput = stringifyOpencodeToolInput(record.input);
		const meta = buildOpencodeToolMeta(record.toolName, record.input);
		return {
			signals,
			confirmation: {
				kind: 'pending_confirmation',
				chat: this._chat,
				...this._approvalTarget(record, ask),
				...(route.parentToolCallId ? { parentToolCallId: route.parentToolCallId } : {}),
				state: {
					status: ToolCallStatus.PendingConfirmation,
					toolCallId: callID,
					toolName: record.toolName,
					displayName: getOpencodeToolDisplayName(record.toolName),
					invocationMessage: getOpencodeInvocationMessage(record.toolName, record.input, record.title, this._cwd),
					confirmationTitle: getOpencodeConfirmationTitle(record.toolName),
					...(toolInput !== undefined ? { toolInput } : {}),
					...(meta ? { _meta: meta } : {}),
				},
			},
		};
	}

	/**
	 * Where the host's auto-approval rules should be applied for one ask.
	 *
	 * The tool call is the better source — it knows the tool and its parsed
	 * input — so the ask only fills in the path when the tool's own row declares
	 * none. `apply_patch` is why that matters: it edits files without naming one
	 * in its input, and only the ask says which.
	 *
	 * Two things narrow the fallback. It is confined to the path-shaped kinds,
	 * because a shell ask's resource is a command line and would be a lie as a
	 * path. And only an already-absolute resource is taken: opencode states a
	 * relative one against its *worktree* root, which is not necessarily the
	 * directory this server was rooted at, so resolving it here would invent a
	 * path that points nowhere. Leaving it out costs an auto-approval rule match
	 * and nothing else — the user still sees the confirmation.
	 */
	private _approvalTarget(record: IOpencodeToolRecord, ask: IOpencodePermissionAsk): IOpencodeApprovalTarget {
		const target = getOpencodeApprovalTarget(record.toolName, record.input, this._cwd);
		if (target.permissionPath || (target.permissionKind !== 'read' && target.permissionKind !== 'write')) {
			return target;
		}
		const resource = askResources(ask).find(candidate => !!candidate && isAbsolute(candidate));
		return resource ? { ...target, permissionPath: resolve(this._cwd, resource) } : target;
	}

	/**
	 * Completes every tool call still open when the turn ends.
	 *
	 * A turn that is aborted mid-tool never gets the closing part update, and a
	 * call left running would keep the chat looking busy forever.
	 */
	closeOutstandingToolCalls(reason: string, includeChildren = true): readonly AgentSignal[] {
		const signals: AgentSignal[] = [];
		for (const record of this._toolCalls.values()) {
			if (record.completed || !record.readyEmitted || (!includeChildren && record.sessionID !== this._rootSessionID)) {
				continue;
			}
			record.completed = true;
			this._push(signals, record.sessionID, {
				type: ActionType.ChatToolCallComplete,
				turnId: this.turnId,
				toolCallId: record.callID,
				result: {
					success: false,
					pastTenseMessage: getOpencodePastTenseMessage(record.toolName, record.input, record.title, this._cwd, false),
					error: { message: reason },
				},
			});
			if (record.childSessionID && (includeChildren || !record.background)) {
				this._completeSubagent(record.childSessionID, signals);
			}
		}
		if (includeChildren) {
			this._backgroundSubagents.clear();
			for (const sessionID of this._subagents.keys()) {
				this._completeSubagent(sessionID, signals);
			}
		}
		return signals;
	}

	/** The turn ended normally. */
	mapStop(duration: number): readonly AgentSignal[] {
		return this._actions([{ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration }]);
	}

	/** The user stopped the turn. */
	mapCancelled(duration: number): readonly AgentSignal[] {
		return this._actions([{ type: ActionType.ChatTurnCancelled, turnId: this.turnId, duration }]);
	}

	/**
	 * The turn failed — a transport error, or an error opencode reported on the
	 * assistant message it answered with.
	 *
	 * opencode usually says the same thing twice: once as a `session.error` frame
	 * on the stream and again on the message it returns. The second telling is
	 * dropped so the transcript carries one error, not two.
	 */
	mapFailure(error: unknown, duration: number): readonly AgentSignal[] {
		if (this._rootErrorReported) {
			return this._actions([{ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration }]);
		}
		this._rootErrorReported = true;
		const message = error instanceof Error ? error.message : String(error);
		return this._actions([
			{
				type: ActionType.ChatError,
				turnId: this.turnId,
				duration,
				error: {
					errorType: error instanceof Error ? error.name : 'OpencodeError',
					message,
					...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
				},
			},
			{ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration },
		]);
	}

	private _mapMessageUpdated(properties: Record<string, unknown>): readonly AgentSignal[] {
		const info = properties['info'];
		if (!isRecord(info) || typeof info['id'] !== 'string' || typeof info['sessionID'] !== 'string') {
			return [];
		}
		const messageID = info['id'];
		if (info['role'] === 'user') {
			// The host recorded the user's prompt on `ChatTurnStarted`, and a child
			// session's prompt is seeded from the spawning `task` input, so neither
			// belongs in the response stream.
			this._userMessages.set(messageID, info['sessionID']);
			return [];
		}
		const route = this._route(info['sessionID']);
		const time = info['time'];
		const completed = isRecord(time) && typeof time['completed'] === 'number';
		if (!route || !completed || this._usageReported.has(messageID)) {
			return [];
		}
		this._usageReported.add(messageID);
		const usage = opencodeUsage(info['tokens'], modelId(info));
		if (!usage) {
			return [];
		}
		const signals: AgentSignal[] = [];
		this._push(signals, info['sessionID'], { type: ActionType.ChatUsage, turnId: this.turnId, usage });
		return signals;
	}

	private _mapPartUpdated(properties: Record<string, unknown>): readonly AgentSignal[] {
		const part = properties['part'];
		if (!isRecord(part) || typeof part['id'] !== 'string' || typeof part['type'] !== 'string' || typeof part['sessionID'] !== 'string' || typeof part['messageID'] !== 'string') {
			return [];
		}
		const typed = part as unknown as IOpencodePart;
		const result = this.backgroundResultForPart(typed);
		if (result) {
			this._backgroundResultMessages.add(typed.messageID);
			return this.mapBackgroundResult(result);
		}
		if (!this._route(typed.sessionID) || this._userMessages.has(typed.messageID)) {
			return [];
		}
		if (typed.type === 'tool') {
			return this._mapToolPart(typed);
		}
		if (typed.type === 'text' || typed.type === 'reasoning') {
			return this._mapContentPart(typed);
		}
		// `step-start` / `step-finish` / `snapshot` / `patch` / `agent` / `retry` /
		// `compaction` are opencode's own bookkeeping; the transcript is assembled
		// from the content parts they surround.
		return [];
	}

	/**
	 * Publishes a text or reasoning part, and whatever of it is not published yet.
	 *
	 * opencode announces a part before streaming into it and re-publishes the
	 * whole accumulated text on every update, so the tail past what was already
	 * emitted is exactly the new content — which makes this correct for a
	 * streaming provider and for one that only ever sends the finished snapshot.
	 */
	private _mapContentPart(part: IOpencodePart): readonly AgentSignal[] {
		const signals: AgentSignal[] = [];
		const reasoning = part.type === 'reasoning';
		const stream = this._ensureStreamPart(part, reasoning, signals);
		const text = part.text ?? '';
		if (text.length > stream.emitted) {
			this._pushDelta(signals, stream, text.slice(stream.emitted));
		}
		return signals;
	}

	private _ensureStreamPart(part: IOpencodePart, reasoning: boolean, signals: AgentSignal[]): IOpencodeStreamPart {
		const existing = this._parts.get(part.id);
		if (existing) {
			return existing;
		}
		const kind = reasoning ? ResponsePartKind.Reasoning : ResponsePartKind.Markdown;
		const index = reasoning ? this._reasoningPartIndex++ : this._textPartIndex++;
		const created: IOpencodeStreamPart = {
			messageID: part.messageID,
			kind,
			partId: `${this.turnId}:${reasoning ? 'reasoning' : 'text'}:${String(index)}`,
			sessionID: part.sessionID,
			emitted: 0,
		};
		this._parts.set(part.id, created);
		this._push(signals, created.sessionID, {
			type: ActionType.ChatResponsePart,
			turnId: this.turnId,
			part: { kind, id: created.partId, content: '' },
		});
		return created;
	}

	private _mapPartDelta(properties: Record<string, unknown>): readonly AgentSignal[] {
		const partID = properties['partID'];
		const delta = properties['delta'];
		if (typeof partID !== 'string' || typeof delta !== 'string' || !delta) {
			return [];
		}
		const stream = this._parts.get(partID);
		// `field` is `text` for both prose and reasoning; which one it is was
		// settled when the part announced its type.
		if (!stream || this._closedMessages.has(stream.messageID) || properties['field'] !== 'text' || properties['sessionID'] !== stream.sessionID) {
			return [];
		}
		const signals: AgentSignal[] = [];
		this._pushDelta(signals, stream, delta);
		return signals;
	}

	private _pushDelta(signals: AgentSignal[], stream: IOpencodeStreamPart, content: string): void {
		stream.emitted += content.length;
		this._push(signals, stream.sessionID, stream.kind === ResponsePartKind.Reasoning
			? { type: ActionType.ChatReasoning, turnId: this.turnId, partId: stream.partId, content }
			: { type: ActionType.ChatDelta, turnId: this.turnId, partId: stream.partId, content });
	}

	private _mapToolPart(part: IOpencodePart): readonly AgentSignal[] {
		const callID = part.callID;
		const state = part.state;
		if (!callID || !state) {
			return [];
		}
		const signals: AgentSignal[] = [];
		const record = this._toolCalls.get(callID) ?? this._startToolCall(callID, part.sessionID, part.tool ?? 'tool', signals);
		record.status = state.status;
		record.input = state.input ?? record.input;
		record.title = state.title ?? record.title;
		if (!record.background && state.metadata?.['background'] === true) {
			record.background = true;
			const childSessionID = state.metadata['sessionId'];
			if (typeof childSessionID === 'string') {
				this._backgroundSubagents.add(childSessionID);
			}
		}
		const terminal = state.status === 'completed' || state.status === 'error';
		if (!record.readyEmitted && (terminal || state.status === 'running')) {
			record.readyEmitted = true;
			const toolInput = stringifyOpencodeToolInput(record.input);
			const meta = buildOpencodeToolMeta(record.toolName, record.input);
			if (toolInput !== undefined) {
				this._push(signals, record.sessionID, { type: ActionType.ChatToolCallDelta, turnId: this.turnId, toolCallId: callID, content: toolInput });
			}
			this._push(signals, record.sessionID, {
				type: ActionType.ChatToolCallReady,
				turnId: this.turnId,
				toolCallId: callID,
				invocationMessage: getOpencodeInvocationMessage(record.toolName, record.input, record.title, this._cwd),
				confirmed: ToolCallConfirmationReason.NotNeeded,
				...(toolInput !== undefined ? { toolInput } : {}),
				...(meta ? { _meta: meta } : {}),
			});
		}
		this._linkSubagent(record, state, signals);
		if (!terminal || record.completed) {
			return signals;
		}
		record.completed = true;
		const success = state.status === 'completed';
		const output = success ? state.output : state.error;
		this._push(signals, record.sessionID, {
			type: ActionType.ChatToolCallComplete,
			turnId: this.turnId,
			toolCallId: callID,
			result: {
				success,
				pastTenseMessage: getOpencodePastTenseMessage(record.toolName, record.input, record.title, this._cwd, success),
				...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
				...(success ? {} : { error: { message: output || localize('opencode.toolResult.error', "The tool call failed.") } }),
			},
		});
		if (record.childSessionID && !record.background) {
			this._completeSubagent(record.childSessionID, signals);
		}
		return signals;
	}

	/**
	 * Adopts the child session a `task` call spawned.
	 *
	 * This is the whole nesting mechanism: from here on, every frame carrying
	 * that session id is re-addressed to the subagent chat this call owns. The
	 * announcement rides the same update, so the child chat exists before any of
	 * its content arrives.
	 */
	private _linkSubagent(record: IOpencodeToolRecord, state: IOpencodeToolState, signals: AgentSignal[]): void {
		if (record.toolName !== OPENCODE_TASK_TOOL || record.childSessionID) {
			return;
		}
		const childSessionID = state.metadata?.['sessionId'];
		if (typeof childSessionID !== 'string' || !childSessionID) {
			return;
		}
		record.childSessionID = childSessionID;
		// task_id resumes/extends the same native child, not a new peer chat.
		if (this._subagents.has(childSessionID)) {
			if (this._completedSubagents.delete(childSessionID)) {
				signals.push({ kind: 'subagent_resumed', chat: this._chat, toolCallId: this._subagents.get(childSessionID)! });
			}
			return;
		}
		this._subagents.set(childSessionID, record.callID);
		const input = isRecord(record.input) ? record.input : {};
		const agentName = typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined;
		signals.push({
			kind: 'subagent_started',
			chat: this._chat,
			toolCallId: record.callID,
			agentName: agentName ?? 'subagent',
			agentDisplayName: agentName ?? 'Subagent',
			...(typeof input['description'] === 'string' ? { agentDescription: input['description'], taskDescription: input['description'] } : {}),
			...(typeof input['prompt'] === 'string' ? { taskPrompt: input['prompt'] } : {}),
			// A `task` that itself runs inside a subagent lives in that subagent's
			// chat; naming it here is what lets the host attach the new child at any
			// depth without a per-level chain.
			...(record.sessionID === this._rootSessionID ? {} : { parentToolCallId: this._subagents.get(record.sessionID) }),
		});
	}

	/**
	 * Reports an error opencode raised on a session mid-turn.
	 *
	 * The turn is not closed here: for the root chat the prompt call is still
	 * outstanding and it — not this frame — decides when the turn ended, and a
	 * subagent's error ends only the child's work.
	 */
	private _mapSessionError(properties: Record<string, unknown>): readonly AgentSignal[] {
		const sessionID = properties['sessionID'];
		if (typeof sessionID !== 'string' || !this._route(sessionID)) {
			return [];
		}
		if (sessionID === this._rootSessionID) {
			this._rootErrorReported = true;
		}
		const signals: AgentSignal[] = [];
		this._push(signals, sessionID, {
			type: ActionType.ChatError,
			turnId: this.turnId,
			duration: Math.max(0, Date.now() - this._startedAt),
			error: opencodeError(properties['error']),
		});
		return signals;
	}

	private _startToolCall(callID: string, sessionID: string, toolName: string, signals: AgentSignal[]): IOpencodeToolRecord {
		const record: IOpencodeToolRecord = {
			callID,
			sessionID,
			toolName,
			input: undefined,
			title: undefined,
			status: 'pending',
			readyEmitted: false,
			permissionRequested: false,
			completed: false,
		};
		this._toolCalls.set(callID, record);
		const meta = buildOpencodeToolMeta(toolName);
		this._push(signals, sessionID, {
			type: ActionType.ChatToolCallStart,
			turnId: this.turnId,
			toolCallId: callID,
			toolName,
			displayName: getOpencodeToolDisplayName(toolName),
			...(meta ? { _meta: meta } : {}),
		});
		return record;
	}

	/**
	 * Where a session's events belong: the root chat, or the subagent chat owned
	 * by the `task` call that spawned it. `undefined` means this turn has no
	 * route for the session and the frame is dropped.
	 */
	private _route(sessionID: string): { readonly parentToolCallId?: string } | undefined {
		if (sessionID === this._rootSessionID) {
			return {};
		}
		const parentToolCallId = this._subagents.get(sessionID);
		return parentToolCallId && !this._completedSubagents.has(sessionID) ? { parentToolCallId } : undefined;
	}

	private _push(signals: AgentSignal[], sessionID: string, action: ChatAction): void {
		const route = this._route(sessionID);
		if (!route) {
			return;
		}
		signals.push({
			kind: 'action',
			resource: this._chat,
			action,
			...(route.parentToolCallId ? { parentToolCallId: route.parentToolCallId } : {}),
		});
	}

	private _actions(actions: readonly ChatAction[]): readonly AgentSignal[] {
		return actions.map((action): AgentSignal => ({ kind: 'action', resource: this._chat, action }));
	}
}

/** One stored message and its parts, as `GET /session/{id}/message` returns them. */
export interface IOpencodeStoredMessage {
	readonly info: {
		readonly id: string;
		readonly role: string;
		readonly sessionID: string;
		readonly time?: { readonly created?: number; readonly completed?: number };
		readonly tokens?: unknown;
		readonly error?: unknown;
		readonly providerID?: string;
		readonly modelID?: string;
	};
	readonly parts: readonly IOpencodePart[];
}

/**
 * Folds a stored opencode conversation into completed turns.
 *
 * Deliberately not a second decoder: every stored part is pushed through
 * {@link OpencodeTurnMapper} as the very `message.part.updated` frame the live
 * stream would have delivered, and the actions that come out are folded by
 * {@link chatReducer} — the host's own function for turning actions into turns.
 * So "what did opencode say" and "what does that look like in a transcript" are
 * shared with live streaming, and a fix to either is a fix to both.
 *
 * What replay adds is the turn boundary, which live streaming learns from the
 * host instead: each stored user message opens a turn. Synthetic text (the
 * host's own instructions, which ride a part opencode marks as not user-typed)
 * is left out of the user's message, which is what keeps the host's promise
 * that its instructions never surface as user content.
 *
 * A subagent's own messages live in its own opencode session and so are absent
 * here; the spawning `task` call and its result are present, which is what the
 * host re-derives the child chats from on restore.
 */
export function replayOpencodeMessagesToTurns(messages: readonly IOpencodeStoredMessage[], chat: URI, sessionID: string, cwd: string): readonly Turn[] {
	// Stored messages carry a creation time but a replay has no turn clock, so
	// the reducer is handed this sentinel and `finish` drops it again rather than
	// shipping it as a fact.
	const noTimestamp = new Date(0).toISOString();
	let state: ChatState = { resource: chat.toString(), title: '', status: SessionStatus.Idle, modifiedAt: noTimestamp, turns: [] };
	const apply = (actions: readonly AgentSignal[]): void => {
		for (const signal of actions) {
			if (signal.kind === 'action') {
				state = chatReducer(state, signal.action as ChatAction);
			}
		}
	};
	let mapper: OpencodeTurnMapper | undefined;
	let turnIndex = 0;
	const closeTurn = (): void => {
		if (mapper) {
			// Tool calls the transcript never resolved are left to the reducer, which
			// cancels them — the same treatment a live turn's stragglers get.
			apply(mapper.mapStop(0));
			mapper = undefined;
		}
	};
	for (const message of messages) {
		if (message.info.role === 'user') {
			closeTurn();
			const notification = message.parts.find(part => part.synthetic && part.type === 'text' && /^<task id="[^"]+" state="(?:completed|error)">/.test(part.text ?? ''));
			// Derived from the opencode session id rather than minted fresh, so
			// replaying the same conversation twice names the same turns and the host
			// sees a restore instead of a brand-new history.
			const turnId = `${sessionID}:${String(turnIndex++)}`;
			mapper = new OpencodeTurnMapper(turnId, chat, sessionID, cwd, 0);
			apply([{
				kind: 'action',
				resource: chat,
				action: {
					type: ActionType.ChatTurnStarted,
					turnId,
					startedAt: noTimestamp,
					message: { text: notification?.text ?? storedUserText(message.parts), origin: { kind: notification ? MessageKind.SystemNotification : MessageKind.User } },
				},
			}]);
			continue;
		}
		// Assistant output before the user ever spoke has no turn to belong to.
		if (!mapper) {
			continue;
		}
		for (const part of message.parts) {
			apply(mapper.mapEvent({ type: 'message.part.updated', properties: { part } }));
		}
		const usage = opencodeUsage(message.info.tokens, storedModelId(message.info));
		if (usage) {
			apply([{ kind: 'action', resource: chat, action: { type: ActionType.ChatUsage, turnId: mapper.turnId, usage } }]);
		}
		if (message.info.error) {
			const error = opencodeError(message.info.error);
			apply([{ kind: 'action', resource: chat, action: { type: ActionType.ChatError, turnId: mapper.turnId, duration: 0, error } }]);
		}
	}
	closeTurn();
	return state.turns.map((turn): Turn => ({
		id: turn.id,
		message: turn.message,
		responseParts: turn.responseParts,
		usage: turn.usage,
		state: turn.state,
		...(turn.error ? { error: turn.error } : {}),
	}));
}

/** What the user actually typed: opencode's own synthetic text is not theirs. */
function storedUserText(parts: readonly IOpencodePart[]): string {
	return parts
		.filter(part => part.type === 'text' && !part.synthetic && part.text)
		.map(part => part.text ?? '')
		.join('\n\n');
}

function storedModelId(info: IOpencodeStoredMessage['info']): string | undefined {
	return info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
}

/**
 * Transcribes opencode's per-message counters into the protocol's, 1:1.
 *
 * `cache.write` rides in `_meta` because the generated `UsageInfo` has no
 * cache-creation field, matching what the other harnesses do; nothing is summed
 * here, the client derives occupancy centrally.
 */
export function opencodeUsage(tokens: unknown, model?: string): UsageInfo | undefined {
	if (!isRecord(tokens)) {
		return undefined;
	}
	const typed = tokens as unknown as IOpencodeTokens;
	const inputTokens = finite(typed.input);
	const outputTokens = finite(typed.output);
	const cacheReadTokens = finite(typed.cache?.read);
	const cacheCreationTokens = finite(typed.cache?.write);
	if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
		return undefined;
	}
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		...(model ? { model } : {}),
		_meta: { cacheCreationTokens },
	};
}

/** The agent-side model id an assistant message reports, in picker form. */
function modelId(info: Record<string, unknown>): string | undefined {
	const providerID = info['providerID'];
	const modelID = info['modelID'];
	return typeof providerID === 'string' && typeof modelID === 'string' ? `${providerID}/${modelID}` : undefined;
}

/** opencode's error envelope: a named error with an optional message in `data`. */
export function opencodeError(error: unknown): { readonly errorType: string; readonly message: string } {
	if (!isRecord(error)) {
		return { errorType: 'OpencodeError', message: localize('opencode.error.unknown', "opencode reported an error.") };
	}
	const name = typeof error['name'] === 'string' ? error['name'] : 'OpencodeError';
	const data = error['data'];
	const message = isRecord(data) && typeof data['message'] === 'string' && data['message'] ? data['message'] : name;
	return { errorType: name, message };
}

function finite(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
