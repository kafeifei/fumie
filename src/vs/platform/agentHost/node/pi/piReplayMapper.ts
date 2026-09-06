/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageKind, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ResponsePart, type ToolCallResponsePart, type Turn, type UsageInfo } from '../../common/state/sessionState.js';
import type { IPiAgentMessage, IPiAssistantMessage, IPiToolResultMessage, IPiUserMessage, PiMessageContent } from './piSdkService.js';
import { buildPiToolMeta, getPiInvocationMessage, getPiPastTenseMessage, getPiToolDisplayName, stringifyPiToolInput } from './piToolDisplay.js';

interface IPiReplayTurn {
	readonly id: string;
	readonly startedAtMs: number | undefined;
	readonly message: Turn['message'];
	readonly responseParts: ResponsePart[];
	readonly toolCalls: Map<string, ToolCallResponsePart>;
	usage: UsageInfo | undefined;
	state: TurnState;
	errorMessage?: string;
	lastRecordAtMs: number | undefined;
}

export function replayPiMessagesToTurns(messages: readonly IPiAgentMessage[], sessionId: string, cwd: string): readonly Turn[] {
	const turns: Turn[] = [];
	let active: IPiReplayTurn | undefined;
	let turnIndex = 0;
	const closeActive = () => {
		if (!active) {
			return;
		}
		const duration = active.startedAtMs !== undefined && active.lastRecordAtMs !== undefined
			? Math.max(0, active.lastRecordAtMs - active.startedAtMs)
			: undefined;
		turns.push({
			id: active.id,
			...(active.startedAtMs !== undefined ? { startedAt: new Date(active.startedAtMs).toISOString() } : {}),
			...(duration !== undefined ? { duration } : {}),
			message: active.message,
			responseParts: active.responseParts,
			usage: active.usage,
			state: active.state,
			...(active.errorMessage ? { error: { errorType: 'PiError', message: active.errorMessage } } : {}),
		});
		active = undefined;
	};

	for (const message of messages) {
		if (message.role === 'user') {
			closeActive();
			const user = message as IPiUserMessage;
			const startedAtMs = finiteNumber(user.timestamp);
			active = {
				id: `${sessionId}:${String(startedAtMs ?? 'unknown')}:${String(turnIndex++)}`,
				startedAtMs,
				message: { text: piContentText(user.content), origin: { kind: MessageKind.User } },
				responseParts: [],
				toolCalls: new Map(),
				usage: undefined,
				state: TurnState.Complete,
				lastRecordAtMs: startedAtMs,
			};
			continue;
		}
		if (!active) {
			continue;
		}
		active.lastRecordAtMs = finiteNumber(message.timestamp) ?? active.lastRecordAtMs;
		if (message.role === 'assistant') {
			appendAssistant(active, message as IPiAssistantMessage, cwd);
		} else if (message.role === 'toolResult') {
			completeToolCall(active, message as IPiToolResultMessage, cwd);
		}
	}
	closeActive();
	return turns;
}

function appendAssistant(turn: IPiReplayTurn, message: IPiAssistantMessage, cwd: string): void {
	message.content.forEach((content, index) => {
		switch (content.type) {
			case 'text':
				if (content.text) {
					turn.responseParts.push({ kind: ResponsePartKind.Markdown, id: `${turn.id}:text:${String(index)}`, content: content.text });
				}
				break;
			case 'thinking':
				if (content.thinking) {
					turn.responseParts.push({ kind: ResponsePartKind.Reasoning, id: `${turn.id}:reasoning:${String(index)}`, content: content.thinking });
				}
				break;
			case 'toolCall': {
				const displayName = getPiToolDisplayName(content.name);
				const input = content.arguments;
				const meta = buildPiToolMeta(content.name);
				const part: ToolCallResponsePart = {
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						status: ToolCallStatus.Cancelled,
						toolCallId: content.id,
						toolName: content.name,
						displayName,
						invocationMessage: getPiInvocationMessage(content.name, input, cwd),
						toolInput: stringifyPiToolInput(input),
						reason: ToolCallCancellationReason.Skipped,
						...(meta ? { _meta: meta } : {}),
					},
				};
				turn.responseParts.push(part);
				turn.toolCalls.set(content.id, part);
				break;
			}
		}
	});
	turn.usage = piUsage(message);
	if (message.stopReason === 'aborted') {
		turn.state = TurnState.Cancelled;
	} else if (message.stopReason === 'error') {
		turn.state = TurnState.Error;
		turn.errorMessage = message.errorMessage ?? 'Pi request failed';
	}
}

function completeToolCall(turn: IPiReplayTurn, message: IPiToolResultMessage, cwd: string): void {
	const part = turn.toolCalls.get(message.toolCallId);
	if (!part || part.toolCall.status !== ToolCallStatus.Cancelled) {
		return;
	}
	const pending = part.toolCall;
	const output = piContentText(message.content);
	const input = parseToolInput(pending.toolInput);
	part.toolCall = {
		status: ToolCallStatus.Completed,
		toolCallId: pending.toolCallId,
		toolName: pending.toolName,
		displayName: pending.displayName,
		invocationMessage: pending.invocationMessage ?? pending.displayName,
		toolInput: pending.toolInput,
		confirmed: ToolCallConfirmationReason.NotNeeded,
		success: !message.isError,
		pastTenseMessage: getPiPastTenseMessage(pending.toolName, input, cwd, !message.isError),
		...(pending._meta ? { _meta: pending._meta } : {}),
		...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
		...(message.isError ? { error: { message: output || 'Pi tool failed' } } : {}),
	};
	turn.toolCalls.delete(message.toolCallId);
}

function piContentText(content: string | readonly PiMessageContent[]): string {
	if (typeof content === 'string') {
		return content;
	}
	return content.map(part => part.type === 'text' ? part.text : part.type === 'image' ? `[${part.mimeType} image]` : '').filter(Boolean).join('\n');
}

/** Replay counterpart of the live mapper's `piUsage`: same 1:1 transcription. */
function piUsage(message: IPiAssistantMessage): UsageInfo | undefined {
	const { input, output, cacheRead, cacheWrite } = message.usage;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
		return undefined;
	}
	return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, _meta: { cacheCreationTokens: cacheWrite } };
}

function parseToolInput(input: unknown): unknown {
	if (typeof input !== 'string') {
		return input;
	}
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
