/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageKind, ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ResponsePart, type ToolCallResponsePart, type Turn } from '../../common/state/sessionState.js';
import type { IKimiReplayContentPart, IKimiReplayMessage, IKimiResumedSessionState } from './kimiCodeSdkService.js';
import { buildKimiToolMeta, getKimiInvocationMessage, getKimiPastTenseMessage, getKimiToolDisplayName } from './kimiToolDisplay.js';

interface IReplayTurnBuilder {
	readonly id: string;
	readonly startedAtMs: number | undefined;
	readonly message: Turn['message'];
	readonly responseParts: ResponsePart[];
	readonly toolCalls: Map<string, ToolCallResponsePart>;
	lastRecordAtMs: number | undefined;
}

/** Projects Kimi's public resume snapshot into completed AHP turns. */
export function replayKimiSessionToTurns(state: IKimiResumedSessionState | undefined, sessionId: string): readonly Turn[] {
	const replay = state?.agents.main?.replay;
	if (!replay) {
		return [];
	}
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

	for (const record of replay) {
		if (record.type !== 'message' || !record.message) {
			continue;
		}
		const message = record.message;
		if (message.role === 'user') {
			if (!isVisibleUserMessage(message)) {
				continue;
			}
			closeActive();
			const startedAtMs = finiteNumber(record.time);
			active = {
				id: `${sessionId}:${String(startedAtMs ?? 'unknown')}:${String(turnIndex++)}`,
				startedAtMs,
				message: { text: replayUserText(message), origin: { kind: MessageKind.User } },
				responseParts: [],
				toolCalls: new Map(),
				lastRecordAtMs: startedAtMs,
			};
			continue;
		}
		if (!active) {
			continue;
		}
		active.lastRecordAtMs = finiteNumber(record.time) ?? active.lastRecordAtMs;
		if (message.role === 'assistant') {
			appendAssistantMessage(active, message);
		} else if (message.role === 'tool') {
			completeToolCall(active, message);
		}
	}
	closeActive();
	return turns;
}

function appendAssistantMessage(turn: IReplayTurnBuilder, message: IKimiReplayMessage): void {
	for (const [index, part] of message.content.entries()) {
		if (part.type === 'text' && part.text) {
			turn.responseParts.push({ kind: ResponsePartKind.Markdown, id: `${turn.id}:text:${String(index)}`, content: part.text });
		} else if (part.type === 'think' && part.think) {
			turn.responseParts.push({ kind: ResponsePartKind.Reasoning, id: `${turn.id}:reasoning:${String(index)}`, content: part.think });
		}
	}
	for (const call of message.toolCalls) {
		const displayName = getKimiToolDisplayName(call.name);
		const input = parseToolArguments(call.arguments);
		const meta = buildKimiToolMeta(call.name, input);
		const part: ToolCallResponsePart = {
			kind: ResponsePartKind.ToolCall,
			toolCall: {
				status: ToolCallStatus.Cancelled,
				toolCallId: call.id,
				toolName: call.name,
				displayName,
				invocationMessage: getKimiInvocationMessage(call.name, displayName, input),
				toolInput: call.arguments ?? undefined,
				reason: ToolCallCancellationReason.Skipped,
				...(meta ? { _meta: meta } : {}),
			},
		};
		turn.responseParts.push(part);
		turn.toolCalls.set(call.id, part);
	}
}

function completeToolCall(turn: IReplayTurnBuilder, message: IKimiReplayMessage): void {
	if (!message.toolCallId) {
		return;
	}
	const part = turn.toolCalls.get(message.toolCallId);
	if (!part) {
		return;
	}
	const pending = part.toolCall;
	if (pending.status !== ToolCallStatus.Cancelled) {
		return;
	}
	const output = replayContentText(message.content);
	const input = parseToolArguments(pending.toolInput);
	part.toolCall = {
		status: ToolCallStatus.Completed,
		toolCallId: pending.toolCallId,
		toolName: pending.toolName,
		displayName: pending.displayName,
		invocationMessage: pending.invocationMessage ?? pending.displayName,
		toolInput: pending.toolInput,
		confirmed: ToolCallConfirmationReason.NotNeeded,
		success: message.isError !== true,
		pastTenseMessage: getKimiPastTenseMessage(pending.toolName, pending.displayName, input, message.isError !== true),
		...(pending._meta ? { _meta: pending._meta } : {}),
		...(output ? { content: [{ type: ToolResultContentType.Text, text: output }] } : {}),
		...(message.isError === true ? { error: { message: output || 'Kimi tool failed' } } : {}),
	};
	turn.toolCalls.delete(message.toolCallId);
}

function isVisibleUserMessage(message: IKimiReplayMessage): boolean {
	const origin = message.origin;
	const kind = typeof origin?.kind === 'string' ? origin.kind : undefined;
	if (kind === undefined || kind === 'user') {
		return true;
	}
	if (kind === 'skill_activation' || kind === 'plugin_command') {
		return origin?.trigger === 'user-slash';
	}
	return kind === 'shell_command' && origin?.phase === 'input';
}

function replayUserText(message: IKimiReplayMessage): string {
	const origin = message.origin;
	if (origin?.kind === 'skill_activation' && origin.trigger === 'user-slash' && typeof origin.skillName === 'string') {
		const args = typeof origin.skillArgs === 'string' ? origin.skillArgs.trim() : '';
		return `/skill:${origin.skillName}${args ? ` ${args}` : ''}`;
	}
	if (origin?.kind === 'plugin_command' && origin.trigger === 'user-slash' && typeof origin.pluginId === 'string' && typeof origin.commandName === 'string') {
		const args = typeof origin.commandArgs === 'string' ? origin.commandArgs.trim() : '';
		return `/${origin.pluginId}:${origin.commandName}${args ? ` ${args}` : ''}`;
	}
	return replayContentText(message.content);
}

function replayContentText(content: readonly IKimiReplayContentPart[]): string {
	return content.map(part => {
		if (part.type === 'text') {
			return part.text ?? '';
		}
		if (part.type === 'image_url') {
			return part.imageUrl?.url ?? '';
		}
		if (part.type === 'audio_url') {
			return part.audioUrl?.url ?? '';
		}
		if (part.type === 'video_url') {
			return part.videoUrl?.url ?? '';
		}
		return '';
	}).filter(Boolean).join('\n');
}

function finiteNumber(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

/** Kimi persists tool arguments as the raw JSON string the model produced. */
function parseToolArguments(input: unknown): Record<string, unknown> | undefined {
	if (typeof input !== 'string' || input.length === 0) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(input);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}
