/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageKind, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ResponsePart, type ToolCallResponsePart, type ToolResultTodoItem, type Turn } from '../../common/state/sessionState.js';
import type { IDeepSeekEvent } from './deepseekSdkService.js';
import { buildDeepSeekToolMeta, getDeepSeekInvocationMessage, getDeepSeekPastTenseMessage, getDeepSeekToolDisplayName, mapDeepSeekTodos } from './deepseekToolDisplay.js';

interface IReplayTurnBuilder {
	readonly id: string;
	readonly startedAtMs: number | undefined;
	readonly message: Turn['message'];
	readonly responseParts: ResponsePart[];
	readonly toolCalls: Map<string, ToolCallResponsePart>;
	/** Latest `todo/write` snapshot, attached to the next `todo_write` tool result. */
	latestTodos?: ToolResultTodoItem[];
	lastRecordAtMs: number | undefined;
}

/** Projects a DeepSeek session log (append-only events) into completed AHP turns. */
export function replayDeepSeekSessionToTurns(events: readonly IDeepSeekEvent[], sessionId: string): readonly Turn[] {
	const turns: Turn[] = [];
	let active: IReplayTurnBuilder | undefined;
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
			usage: undefined,
			state: TurnState.Complete,
		});
		active = undefined;
	};

	for (const event of events) {
		const data = event.data;
		switch (event.type) {
			case 'user/message': {
				const source = asRecord(data.source);
				if (!isVisibleUserMessage(source)) {
					continue;
				}
				closeActive();
				const startedAtMs = finiteNumber(data.time) ?? finiteNumber(eventTime(data));
				active = {
					id: `${sessionId}:${String(startedAtMs ?? 'unknown')}:${String(turnIndex++)}`,
					startedAtMs,
					message: { text: contentText(asBlocks(data.content)), origin: { kind: MessageKind.User } },
					responseParts: [],
					toolCalls: new Map(),
					lastRecordAtMs: startedAtMs,
				};
				break;
			}
			case 'assistant/message': {
				if (!active) {
					continue;
				}
				const message = asRecord(data.message);
				appendAssistantMessage(active, asBlocks(message.content));
				break;
			}
			case 'tool/call': {
				if (!active) {
					continue;
				}
				const callId = stringValue(data.callId);
				const name = stringValue(data.name) || 'tool';
				const displayName = getDeepSeekToolDisplayName(name);
				const input = parseToolArguments(optionalString(data.arguments));
				const meta = buildDeepSeekToolMeta(name, input);
				const part: ToolCallResponsePart = {
					kind: ResponsePartKind.ToolCall,
					toolCall: {
						status: ToolCallStatus.Cancelled,
						toolCallId: callId,
						toolName: name,
						displayName,
						invocationMessage: getDeepSeekInvocationMessage(name, displayName, input),
						toolInput: optionalString(data.arguments),
						reason: ToolCallCancellationReason.Skipped,
						...(meta ? { _meta: meta } : {}),
					},
				};
				active.responseParts.push(part);
				active.toolCalls.set(callId, part);
				break;
			}
			case 'tool/result': {
				if (!active) {
					continue;
				}
				const callId = toolResultCallId(data);
				if (!callId) {
					continue;
				}
				const part = active.toolCalls.get(callId);
				if (!part || part.toolCall.status !== ToolCallStatus.Cancelled) {
					continue;
				}
				const pending = part.toolCall;
				const isError = toolResultIsError(data);
				const output = toolResultText(data);
				const input = parseToolArguments(pending.toolInput);
				const todos = pending.toolName === 'todo_write' ? active.latestTodos : undefined;
				part.toolCall = {
					status: ToolCallStatus.Completed,
					toolCallId: pending.toolCallId,
					toolName: pending.toolName,
					displayName: pending.displayName,
					invocationMessage: pending.invocationMessage ?? pending.displayName,
					toolInput: pending.toolInput,
					confirmed: ToolCallConfirmationReason.NotNeeded,
					success: !isError,
					pastTenseMessage: getDeepSeekPastTenseMessage(pending.toolName, pending.displayName, input, !isError, output),
					...(pending._meta ? { _meta: pending._meta } : {}),
					...(todos ? { content: [{ type: ToolResultContentType.TodoList, todos }] } : output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
					...(isError ? { error: { message: output || 'DeepSeek tool failed' } } : {}),
				};
				active.toolCalls.delete(callId);
				break;
			}
			case 'todo/write': {
				if (!active) {
					continue;
				}
				active.latestTodos = mapDeepSeekTodos(data.todos);
				break;
			}
			case 'turn/end': {
				closeActive();
				break;
			}
		}
	}
	closeActive();
	return turns;
}

function appendAssistantMessage(turn: IReplayTurnBuilder, blocks: readonly IDeepSeekBlock[]): void {
	blocks.forEach((block, index) => {
		if (block.type === 'text' && block.text) {
			turn.responseParts.push({ kind: ResponsePartKind.Markdown, id: `${turn.id}:text:${String(index)}`, content: block.text });
		} else if (block.type === 'reasoning' && block.text) {
			turn.responseParts.push({ kind: ResponsePartKind.Reasoning, id: `${turn.id}:reasoning:${String(index)}`, content: block.text });
		}
	});
}

function isVisibleUserMessage(source: Readonly<Record<string, unknown>> | undefined): boolean {
	const kind = typeof source?.kind === 'string' ? source.kind : undefined;
	return kind === undefined || kind === 'user';
}

function toolResultCallId(data: Readonly<Record<string, unknown>>): string | undefined {
	const message = asRecord(data.message);
	const source = asRecord(message.source);
	if (typeof source.callId === 'string') {
		return source.callId;
	}
	const blocks = asBlocks(message.content);
	const first = blocks[0];
	return typeof first?.callId === 'string' ? first.callId : undefined;
}

function toolResultIsError(data: Readonly<Record<string, unknown>>): boolean {
	if (data.error !== undefined && data.error !== null) {
		return true;
	}
	const message = asRecord(data.message);
	const blocks = asBlocks(message.content);
	return blocks[0]?.isError === true;
}

function toolResultText(data: Readonly<Record<string, unknown>>): string {
	const message = asRecord(data.message);
	const blocks = asBlocks(message.content);
	const first = blocks[0];
	const inner = asBlocks(first?.content);
	return contentText(inner) || (typeof first?.text === 'string' ? first.text : '');
}

function contentText(blocks: readonly IDeepSeekBlock[]): string {
	return blocks.map(block => (block.type === 'text' ? block.text ?? '' : '')).filter(Boolean).join('\n');
}

// ---- small typed accessors (the downloaded log is lossless JSON) -----------

interface IDeepSeekBlock {
	readonly type: string;
	readonly text?: string;
	readonly callId?: string;
	readonly isError?: boolean;
	readonly content?: readonly IDeepSeekBlock[];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {};
}

function asBlocks(value: unknown): readonly IDeepSeekBlock[] {
	if (Array.isArray(value)) {
		return value as readonly IDeepSeekBlock[];
	}
	const records = asRecord(value);
	const content = records.content;
	if (!Array.isArray(content)) {
		return [];
	}
	return content as readonly IDeepSeekBlock[];
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : String(value ?? '');
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseToolArguments(input: unknown): Record<string, unknown> | undefined {
	if (typeof input !== 'string' || input.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(input);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventTime(data: Readonly<Record<string, unknown>>): unknown {
	return data.time;
}
