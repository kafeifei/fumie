/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { toAgentMessageDelegationMeta } from '../../common/meta/agentMessageDelegationMeta.js';
import { toToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import { SessionServerToolName } from '../../common/serverToolNames.js';
import {
	MessageKind,
	ResponsePartKind,
	ToolCallConfirmationReason,
	ToolCallStatus,
	ToolResultContentType,
	TurnState,
	type ResponsePart,
	type ToolCallResponsePart,
	type ToolResultContent,
	type Turn,
	type ModelSelection,
} from '../../common/state/sessionState.js';
import {
	describeFileChange,
	describeWebSearch,
	codexCompactionLabels,
	codexImageGenerationLabels,
	fileChangeOutput,
	mapCodexTurnError,
	turnStateFromStatus,
	webSearchInvocationMessage,
	webSearchPastTenseMessage,
} from './codexMapAppServerEvents.js';
import { unwrapShellInvocation } from './codexShellCommand.js';
import { parseCodexDelegation } from './codexDelegation.js';
import { buildCodexThreadOpenLink, extractCodexCreatedThreadDirectives, getCodexThreadCoordinationCall, type ICodexThreadCoordinationCall } from './codexThreadCoordination.js';
import { getServerToolDisplay } from '../shared/serverToolGroups.js';
import type { Thread } from './protocol/generated/v2/Thread.js';
import type { ThreadItem } from './protocol/generated/v2/ThreadItem.js';
import type { Turn as CodexTurn } from './protocol/generated/v2/Turn.js';

/**
 * Reconstruct protocol {@link Turn}s from codex's `thread/read` response.
 *
 * Codex stores each conversation as a stream of {@link CodexTurn}, each
 * with an array of {@link ThreadItem}s. We collapse that into the agent
 * host's turn shape: each user message opens a turn; subsequent assistant
 * items become response parts on that turn until `turn/completed` closes it.
 *
 * Produces:
 *  - `userMessage`      → opens a `Turn` with `userMessage: { text }`
 *  - `agentMessage`     → `MarkdownResponsePart` with the full text
 *  - `commandExecution` → completed terminal `ToolCallResponsePart`
 *  - `webSearch`        → completed web-search `ToolCallResponsePart`
 *  - `imageGeneration`  → completed image-generation `ToolCallResponsePart`
 *  - `fileChange`       → completed file-edit `ToolCallResponsePart`
 *  - thread coordination tools → completed session-link `ToolCallResponsePart`
 *  - `contextCompaction` → completed compaction `ToolCallResponsePart`
 *  - everything else    → currently dropped (reasoning/plan/mcp/collab)
 *
 * A codex turn holding several `userMessage` items (a steered/mid-turn
 * follow-up codex folded into the running turn) is split into one host turn
 * per user message, mirroring how the live mapper promotes a steer into its
 * own turn. The codex turn id stays on the LAST segment — the id contract
 * `truncateChat`/fork rely on ("keep through this turn" keeps the whole
 * codex turn); earlier segments get derived `<id>#<n>` ids, which those
 * consumers treat as unknown and safely no-op on.
 *
 * Mirrors the live mapper's translation kernel — including the sandbox
 * pre-flight coalescing (see {@link codexMapAppServerEvents}) — so restored
 * sessions render identically to active ones.
 */
export function replayThreadToTurns(
	thread: Thread,
	modelsByTurnId?: ReadonlyMap<string, ModelSelection>,
	_threadCoordinationByTurnId?: ReadonlyMap<string, readonly ICodexThreadCoordinationCall[]>,
): Turn[] {
	const turns: Turn[] = [];
	for (const codexTurn of thread.turns ?? []) {
		turns.push(...replayTurnToTurns(
			codexTurn,
			modelsByTurnId?.get(codexTurn.id),
			_threadCoordinationByTurnId?.get(codexTurn.id),
		));
	}
	return turns;
}

/** A completed `commandExecution` item narrowed to its terminal fields. */
type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;

/** One host-visible turn segment of a codex turn: a user message plus the response parts that followed it. */
interface IReplaySegment {
	userText: string;
	parts: ResponsePart[];
}

function replayTurnToTurns(codexTurn: CodexTurn, model: ModelSelection | undefined, rolloutCoordination: readonly ICodexThreadCoordinationCall[] | undefined): Turn[] {
	const segments: IReplaySegment[] = [];
	let current: IReplaySegment = { userText: '', parts: [] };
	const linkedCreatedThreadIds = new Set<string>();
	const remainingRolloutCoordination = new Map<string, number>();
	for (const coordination of rolloutCoordination ?? []) {
		const key = threadCoordinationKey(coordination);
		remainingRolloutCoordination.set(key, (remainingRolloutCoordination.get(key) ?? 0) + 1);
		if (coordination.toolName === SessionServerToolName.CreateSession) {
			linkedCreatedThreadIds.add(coordination.targetThreadId);
		}
		current.parts.push(threadCoordinationToolCallPart(coordination));
	}
	// Separate consecutive agent messages so the chat model's separator-less
	// markdown coalescing keeps a following heading on its own line.
	let agentMessageCount = 0;
	// A successful command that produced no output may be a sandbox pre-flight
	// that codex immediately re-ran under an approval prompt (same command, new
	// item). Defer emitting it so the re-run can coalesce into a single box —
	// mirroring the live mapper's `pendingPreflight` state machine.
	let pendingPreflight: { command: string; item: CommandExecutionItem } | undefined;
	const flushPreflight = () => {
		if (pendingPreflight) {
			current.parts.push(shellToolCallPart(pendingPreflight.item, pendingPreflight.command));
			pendingPreflight = undefined;
		}
	};

	for (const item of codexTurn.items ?? []) {
		if (item.type === 'commandExecution') {
			const command = unwrapShellInvocation(item.command ?? '');
			if (pendingPreflight && pendingPreflight.command === command) {
				// Escalated re-run of the deferred pre-flight: render only this
				// item (it carries the real output/approval), dropping the
				// output-less pre-flight box.
				pendingPreflight = undefined;
				current.parts.push(shellToolCallPart(item, command));
				continue;
			}
			flushPreflight();
			const success = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null);
			const output = item.aggregatedOutput ?? '';
			if (success && !output) {
				pendingPreflight = { command, item };
				continue;
			}
			current.parts.push(shellToolCallPart(item, command));
			continue;
		}

		// Any other item supersedes a deferred pre-flight: finalize it first so
		// a genuinely output-less command still renders as a single box.
		flushPreflight();

		if (item.type === 'userMessage') {
			const collected: string[] = [];
			for (const c of item.content) {
				if (c.type === 'text') {
					collected.push(c.text);
				}
			}
			if (collected.length > 0) {
				const text = collected.join('\n\n');
				if (!current.userText) {
					current.userText = text;
				} else {
					// A second user message inside one codex turn is a steered
					// follow-up codex folded into the running turn. Split it into
					// its own host turn — mirroring the live mapper, which promotes
					// a steer into a fresh turn — instead of overwriting (and thus
					// dropping) the earlier prompt.
					segments.push(current);
					current = { userText: text, parts: [] };
					agentMessageCount = 0;
				}
			}
		} else if (item.type === 'agentMessage') {
			const message = extractCodexCreatedThreadDirectives(item.text ?? '');
			if (message.text.length > 0) {
				const separator = agentMessageCount > 0 ? '\n\n' : '';
				agentMessageCount++;
				current.parts.push({
					kind: ResponsePartKind.Markdown,
					id: generateUuid(),
					content: separator + message.text,
				});
			}
			for (const threadId of message.threadIds) {
				if (!linkedCreatedThreadIds.has(threadId)) {
					linkedCreatedThreadIds.add(threadId);
					current.parts.push(threadCoordinationToolCallPart({
						toolName: SessionServerToolName.CreateSession,
						targetThreadId: threadId,
						openLink: buildCodexThreadOpenLink(threadId),
						toolInput: { prompt: getServerToolPastTenseMessage(SessionServerToolName.CreateSession) },
					}));
				}
			}
		} else if (item.type === 'webSearch') {
			current.parts.push(webSearchToolCallPart(item));
		} else if (item.type === 'imageGeneration') {
			current.parts.push(imageGenerationToolCallPart(item));
		} else if (item.type === 'fileChange') {
			current.parts.push(fileChangeToolCallPart(item));
		} else if (item.type === 'dynamicToolCall') {
			const coordination = getCodexThreadCoordinationCall(item);
			if (coordination) {
				const key = threadCoordinationKey(coordination);
				const duplicateCount = remainingRolloutCoordination.get(key) ?? 0;
				if (duplicateCount > 0) {
					remainingRolloutCoordination.set(key, duplicateCount - 1);
				} else {
					if (coordination.toolName === SessionServerToolName.CreateSession) {
						linkedCreatedThreadIds.add(coordination.targetThreadId);
					}
					current.parts.push(threadCoordinationToolCallPart(coordination));
				}
			}
		} else if (item.type === 'contextCompaction') {
			if (!current.userText) {
				current.userText = '/compact';
			}
			current.parts.push(compactionToolCallPart());
		}
		// Other item types (plan/reasoning/mcpToolCall/collabAgentToolCall/…)
		// are not yet reconstructed in replay.
	}
	flushPreflight();
	segments.push(current);

	// Drop segments with nothing to render (an empty codex turn yields a
	// single all-empty segment; split segments always carry user text).
	const rendered = segments.filter(segment => segment.userText || segment.parts.length > 0);
	const timing = codexTurnTiming(codexTurn);
	return rendered.map((segment, index) => {
		const last = index === rendered.length - 1;
		const delegation = parseCodexDelegation(segment.userText);
		return {
			// The codex turn id names the whole codex turn for truncate/fork, so
			// it must land on exactly one host turn — the last segment, which is
			// where "keep through this turn" and the live id-correlation both
			// point. Earlier segments get derived ids those consumers ignore.
			id: last ? codexTurn.id : `${codexTurn.id}#${index}`,
			...(index === 0 ? timing : {}),
			message: {
				text: delegation?.input ?? segment.userText,
				origin: { kind: MessageKind.User },
				...(model ? { model } : {}),
				...(delegation ? { _meta: toAgentMessageDelegationMeta({ sourceThreadId: delegation.sourceThreadId }) } : {}),
			},
			responseParts: segment.parts,
			usage: model ? { model: model.id } : undefined,
			// Only the final segment reflects how the codex turn actually ended;
			// earlier segments were superseded by the follow-up user message,
			// same as a live steer completes the turn it interrupts.
			state: last ? turnStateFromStatus(codexTurn.status) : TurnState.Complete,
			...(last && codexTurn.status === 'failed' && codexTurn.error ? { error: mapCodexTurnError(codexTurn.error) } : {}),
		};
	});
}

function threadCoordinationToolCallPart(coordination: ICodexThreadCoordinationCall): ToolCallResponsePart {
	const display = getServerToolDisplay(coordination.toolName, coordination.toolInput, { text: coordination.openLink, success: true });
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: coordination.toolName,
			displayName: display?.displayName ?? coordination.toolName,
			invocationMessage: display?.invocationMessage ?? coordination.toolName,
			toolInput: JSON.stringify(coordination.toolInput, null, 2),
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: true,
			pastTenseMessage: display?.pastTenseMessage ?? coordination.toolName,
			content: [{ type: ToolResultContentType.Text, text: coordination.openLink }],
		},
	};
}

function threadCoordinationKey(coordination: ICodexThreadCoordinationCall): string {
	return `${coordination.toolName}\0${coordination.targetThreadId}`;
}

function getServerToolPastTenseMessage(toolName: SessionServerToolName.CreateSession): string {
	const pastTenseMessage = getServerToolDisplay(toolName, {})?.pastTenseMessage;
	return typeof pastTenseMessage === 'string' ? pastTenseMessage : pastTenseMessage?.markdown ?? toolName;
}

/** Restores turn timing from codex's persisted thread: Unix-second stamps widen to ISO 8601 `startedAt` plus a millisecond `duration`. */
function codexTurnTiming(codexTurn: CodexTurn): { startedAt?: string; duration?: number } {
	const startedAtSeconds = codexTurn.startedAt;
	if (typeof startedAtSeconds !== 'number' || !Number.isFinite(startedAtSeconds)) {
		return {};
	}
	const duration = typeof codexTurn.durationMs === 'number' && Number.isFinite(codexTurn.durationMs) && codexTurn.durationMs >= 0
		? codexTurn.durationMs
		: typeof codexTurn.completedAt === 'number' && Number.isFinite(codexTurn.completedAt)
			? Math.max(0, (codexTurn.completedAt - startedAtSeconds) * 1000)
			: undefined;
	return {
		startedAt: new Date(startedAtSeconds * 1000).toISOString(),
		...(duration !== undefined ? { duration } : {}),
	};
}

function textContent(output: string): ToolResultContent[] | undefined {
	return output ? [{ type: ToolResultContentType.Text, text: output }] : undefined;
}

function shellToolCallPart(item: CommandExecutionItem, command: string): ToolCallResponsePart {
	const success = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null);
	const output = item.aggregatedOutput ?? '';
	const exit = item.exitCode;
	const pastTense = success
		? `Ran \`${command}\``
		: exit !== null
			? `Ran \`${command}\` (exit ${exit})`
			: `Ran \`${command}\` (failed)`;
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: 'shell',
			displayName: 'Run shell command',
			_meta: toToolCallMeta({ toolKind: 'terminal' }),
			invocationMessage: command,
			toolInput: command,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success,
			pastTenseMessage: pastTense,
			content: textContent(output),
			error: success ? undefined : { message: exit !== null ? `Exit code ${exit}` : 'Command failed' },
		},
	};
}

function webSearchToolCallPart(item: Extract<ThreadItem, { type: 'webSearch' }>): ToolCallResponsePart {
	const query = describeWebSearch(item.query, item.action);
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: 'web_search',
			displayName: 'Web search',
			_meta: toToolCallMeta({ toolKind: 'search' }),
			invocationMessage: webSearchInvocationMessage(query),
			toolInput: query,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: true,
			pastTenseMessage: webSearchPastTenseMessage(query),
		},
	};
}

function imageGenerationToolCallPart(item: Extract<ThreadItem, { type: 'imageGeneration' }>): ToolCallResponsePart {
	const success = item.status === 'completed' && item.result.length > 0;
	const labels = codexImageGenerationLabels(item.status);
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: 'image_gen.imagegen',
			displayName: labels.displayName,
			invocationMessage: labels.invocationMessage,
			toolInput: JSON.stringify({ prompt: item.revisedPrompt ?? labels.displayName }),
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success,
			pastTenseMessage: success ? labels.pastTenseMessage : labels.failedMessage,
			content: success ? [{ type: ToolResultContentType.EmbeddedResource, data: item.result, contentType: 'image/png' }] : undefined,
			error: success ? undefined : { message: labels.errorMessage },
		},
	};
}

function fileChangeToolCallPart(item: Extract<ThreadItem, { type: 'fileChange' }>): ToolCallResponsePart {
	const success = item.status === 'completed';
	const summary = describeFileChange(item.changes) || 'Apply file changes';
	const output = fileChangeOutput(item.changes);
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: 'file_edit',
			displayName: 'Apply file changes',
			invocationMessage: summary,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success,
			pastTenseMessage: success ? summary : 'Failed to apply file changes',
			content: textContent(output),
			error: success ? undefined : { message: `Patch ${item.status}` },
		},
	};
}

function compactionToolCallPart(): ToolCallResponsePart {
	const labels = codexCompactionLabels();
	return {
		kind: ResponsePartKind.ToolCall,
		toolCall: {
			status: ToolCallStatus.Completed,
			toolCallId: generateUuid(),
			toolName: 'compact',
			displayName: labels.displayName,
			invocationMessage: labels.invocationMessage,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: true,
			pastTenseMessage: labels.pastTenseMessage,
		},
	};
}
