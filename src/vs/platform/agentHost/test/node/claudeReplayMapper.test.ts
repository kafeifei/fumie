/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { NullLogService } from '../../../log/common/log.js';
import { MessageAttachmentKind, ResponsePartKind, ToolCallStatus, ToolResultContentType, TurnState } from '../../common/state/protocol/state.js';
import { mapSessionMessagesToTurns, missingPromptPlaceholder, resolveForkAnchorUuid } from '../../node/claude/claudeReplayMapper.js';

suite('claudeReplayMapper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const logService = new NullLogService();
	const session = URI.parse('claude:/sess-1');
	type TimestampedSessionMessage = SessionMessage & { readonly timestamp?: string };

	function makeUser(uuid: string, text: string, timestamp?: string): TimestampedSessionMessage {
		return {
			type: 'user',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { role: 'user', content: [{ type: 'text', text }] },
			timestamp,
		};
	}

	function makeAssistantText(uuid: string, text: string, timestamp?: string): TimestampedSessionMessage {
		return {
			type: 'assistant',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
			timestamp,
		};
	}

	function makeAssistantToolUse(uuid: string, toolUseId: string, name: string, input: unknown = {}, timestamp?: string): TimestampedSessionMessage {
		return {
			type: 'assistant',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: {
				id: `msg_${uuid}`,
				role: 'assistant',
				content: [{ type: 'tool_use', id: toolUseId, name, input }],
			},
			timestamp,
		};
	}

	function makeUserToolResult(uuid: string, toolUseId: string, text: string, isError = false, timestamp?: string): TimestampedSessionMessage {
		return {
			type: 'user',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }],
			},
			timestamp,
		};
	}

	function makeSystem(uuid: string, subtype: string, text?: string): SessionMessage {
		return {
			type: 'system',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { subtype, ...(text !== undefined ? { text } : {}) },
		};
	}

	test('Fixture 1: single text turn', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantText('a1', 'world'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].id, 'u1', 'Turn.id MUST equal user SessionMessage.uuid');
		assert.strictEqual(turns[0].message.text, 'hello');
		assert.strictEqual(turns[0].usage, undefined, 'no usage block in the transcript means no usage on the turn');
		assert.strictEqual(turns[0].state, TurnState.Complete);
		assert.strictEqual(turns[0].responseParts.length, 1);
		const part = turns[0].responseParts[0];
		assert.strictEqual(part.kind, ResponsePartKind.Markdown);
		if (part.kind === ResponsePartKind.Markdown) {
			assert.strictEqual(part.content, 'world');
		}
	});

	function makeAssistantTextWithUsage(uuid: string, text: string, usage: Record<string, number>, model = 'claude-test'): TimestampedSessionMessage {
		const base = makeAssistantText(uuid, text);
		return { ...base, message: { ...(base.message as Record<string, unknown>), model, usage } } as TimestampedSessionMessage;
	}

	test('restores context occupancy from replayed assistant usage blocks', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantTextWithUsage('a1', 'world', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100, output_tokens: 50 }),
			makeUser('u2', 'again'),
			makeAssistantTextWithUsage('a2', 'ok', { input_tokens: 20, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 1_500, output_tokens: 200 }),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 2);
		// The turn's last main-loop call, transcribed 1:1 — same as the live
		// mapper's mapResult, cache creation included via `_meta` because the
		// generated `UsageInfo` has no field for it. Occupancy is the client's
		// sum of the three input-side counters: 1_110 and 71_520, exactly what
		// the pre-folded `inputTokens` used to carry.
		assert.deepStrictEqual(turns[0].usage, { inputTokens: 10, outputTokens: 50, cacheReadTokens: 1_000, model: 'claude-test', _meta: { cacheCreationTokens: 100 } });
		assert.deepStrictEqual(turns[1].usage, { inputTokens: 20, outputTokens: 200, cacheReadTokens: 70_000, model: 'claude-test', _meta: { cacheCreationTokens: 1_500 } });
	});

	test('an all-zero usage block (synthetic notice) does not wipe the last real occupancy', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantTextWithUsage('a1', 'world', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 50 }),
			makeAssistantTextWithUsage('a2', 'notice', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		// Occupancy still sums to 1_010, the pre-fold `inputTokens`.
		assert.deepStrictEqual(turns[0].usage, { inputTokens: 10, outputTokens: 50, cacheReadTokens: 1_000, model: 'claude-test', _meta: { cacheCreationTokens: 0 } });
	});

	test('a non-zero usage block on a <synthetic> envelope does not wipe the known model', () => {
		// The zero-usage case above is handled by `readAssistantUsage`. This is
		// the other half: an SDK-synthesized envelope (error notice, injected
		// reminder) can carry *real* non-zero usage while naming `<synthetic>`
		// as its model. Overwriting the recorded model with `undefined` there
		// strands the turn without a model id — and since replayed usage never
		// carries `_meta.modelContextWindow`, that id is the only way the
		// context gauge can resolve its denominator from the model catalog.
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantTextWithUsage('a1', 'world', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 50 }, 'claude-sonnet-4-5-20250929'),
			makeAssistantTextWithUsage('a2', 'notice', { input_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, output_tokens: 7 }, '<synthetic>'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		// Occupancy advances to the synthetic envelope's (it is real usage), but
		// the model stays the last real one the transcript named.
		assert.deepStrictEqual(turns[0].usage, { inputTokens: 5, outputTokens: 7, cacheReadTokens: 2_000, model: 'claude-sonnet-4-5-20250929', _meta: { cacheCreationTokens: 0 } });
	});

	test('a <synthetic> envelope seen before any real model leaves the model absent', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantTextWithUsage('a1', 'notice', { input_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0, output_tokens: 7 }, '<synthetic>'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.deepStrictEqual(turns[0].usage, { inputTokens: 5, outputTokens: 7, cacheReadTokens: 2_000, _meta: { cacheCreationTokens: 0 } });
	});

	test('a later real model supersedes the previously recorded one', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello'),
			makeAssistantTextWithUsage('a1', 'world', { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 50 }, 'claude-sonnet-4-5-20250929'),
			makeAssistantTextWithUsage('a2', 'more', { input_tokens: 12, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0, output_tokens: 60 }, 'claude-opus-4-6'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].usage?.model, 'claude-opus-4-6');
	});

	test('restores turn timing from persisted message timestamps', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello', '2026-07-09T18:00:00.000Z'),
			makeAssistantText('a1', 'world', '2026-07-09T18:00:02.500Z'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.deepStrictEqual({
			startedAt: turns[0].startedAt,
			duration: turns[0].duration,
		}, {
			startedAt: '2026-07-09T18:00:00.000Z',
			duration: 2_500,
		});
	});

	test('leaves turn timing unknown when persisted timestamps are missing or invalid', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'hello', 'invalid'),
			makeAssistantText('a1', 'world'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.deepStrictEqual({
			startedAt: turns[0].startedAt,
			duration: turns[0].duration,
		}, {
			startedAt: undefined,
			duration: undefined,
		});
	});

	test('Fixture 2: tool_use + tool_result is one Turn with one Completed ToolCall', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'list files'),
			makeAssistantToolUse('a1', 'tu1', 'Bash', { command: 'ls' }),
			makeUserToolResult('synthetic1', 'tu1', 'file1.txt\nfile2.txt'),
			makeAssistantText('a2', 'two files'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1, 'tool_result MUST NOT start a new turn');
		assert.strictEqual(turns[0].state, TurnState.Complete);
		const toolCallParts = turns[0].responseParts.filter(p => p.kind === ResponsePartKind.ToolCall);
		assert.strictEqual(toolCallParts.length, 1);
		const toolCall = toolCallParts[0];
		assert.strictEqual(toolCall.kind, ResponsePartKind.ToolCall);
		if (toolCall.kind === ResponsePartKind.ToolCall) {
			assert.strictEqual(toolCall.toolCall.status, ToolCallStatus.Completed);
			assert.strictEqual(toolCall.toolCall.toolName, 'Bash');
			if (toolCall.toolCall.status === ToolCallStatus.Completed) {
				assert.strictEqual(toolCall.toolCall.success, true);
				assert.deepStrictEqual(toolCall.toolCall.content, [{ type: ToolResultContentType.Text, text: 'file1.txt\nfile2.txt' }]);
			}
		}
	});

	test('replay preserves generic semantics for client tools that collide with built-in names', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'run client tools'),
			makeAssistantToolUse('a1', 'tu_bash', 'mcp__client__Bash', { command: 'echo client' }),
			makeUserToolResult('r1', 'tu_bash', 'done'),
			makeAssistantToolUse('a2', 'tu_task', 'mcp__client__Task', { description: 'client task' }),
			makeUserToolResult('r2', 'tu_task', 'done'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);
		const tools = turns[0].responseParts.filter(part => part.kind === ResponsePartKind.ToolCall).map(part => {
			assert.strictEqual(part.kind, ResponsePartKind.ToolCall);
			return {
				toolName: part.toolCall.toolName,
				displayName: part.toolCall.displayName,
				meta: part.toolCall._meta,
				invocationMessage: part.toolCall.status === ToolCallStatus.Completed ? part.toolCall.invocationMessage : undefined,
				toolInput: part.toolCall.status === ToolCallStatus.Completed ? part.toolCall.toolInput : undefined,
				pastTenseMessage: part.toolCall.status === ToolCallStatus.Completed ? part.toolCall.pastTenseMessage : undefined,
				hasSubagentContent: part.toolCall.status === ToolCallStatus.Completed
					&& part.toolCall.content?.some(content => content.type === ToolResultContentType.Subagent),
			};
		});
		assert.deepStrictEqual(tools, [
			{
				toolName: 'Bash',
				displayName: 'Bash',
				meta: undefined,
				invocationMessage: 'Bash',
				toolInput: '{\n  "command": "echo client"\n}',
				pastTenseMessage: 'Bash',
				hasSubagentContent: false,
			},
			{
				toolName: 'Task',
				displayName: 'Task',
				meta: undefined,
				invocationMessage: 'Task',
				toolInput: '{\n  "description": "client task"\n}',
				pastTenseMessage: 'Task',
				hasSubagentContent: false,
			},
		]);
	});

	test('Fixture 3: multi-turn produces ordered Turns', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'first'),
			makeAssistantText('a1', 'reply 1'),
			makeUser('u2', 'second'),
			makeAssistantText('a2', 'reply 2'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 2);
		assert.strictEqual(turns[0].id, 'u1');
		assert.strictEqual(turns[1].id, 'u2');
	});

	test('Fixture 4: compact_boundary attaches as SystemNotification on the active turn', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'first'),
			makeAssistantText('a1', 'reply 1'),
			makeSystem('s1', 'compact_boundary', 'context compacted'),
			makeAssistantText('a2', 'reply 2'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1, 'compact_boundary is NOT a turn boundary');
		const sysParts = turns[0].responseParts.filter(p => p.kind === ResponsePartKind.SystemNotification);
		assert.strictEqual(sysParts.length, 1);
	});

	test('Fixture 5: Task / Agent tool_use produces subagent marker', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'spawn subagent'),
			makeAssistantToolUse('a1', 'tu1', 'Task', { description: 'do thing' }),
			makeUserToolResult('synthetic1', 'tu1', 'subagent done'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		const toolCallPart = turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(toolCallPart, 'expected a ToolCall part');
		if (toolCallPart && toolCallPart.kind === ResponsePartKind.ToolCall) {
			assert.strictEqual(toolCallPart.toolCall._meta?.toolKind, 'subagent');
			if (toolCallPart.toolCall.status === ToolCallStatus.Completed) {
				const hasSubagentMarker = toolCallPart.toolCall.content?.some(c => c.type === ToolResultContentType.Subagent);
				assert.strictEqual(hasSubagentMarker, true, 'subagent marker block must be present');
			} else {
				assert.fail(`expected Completed status, got ${toolCallPart.toolCall.status}`);
			}
		}
	});

	test('Fixture 5b: Agent tool name also recognised as subagent', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'spawn subagent'),
			makeAssistantToolUse('a1', 'tu1', 'Agent', { description: 'do thing' }),
			makeUserToolResult('synthetic1', 'tu1', 'done'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		const toolCallPart = turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(toolCallPart && toolCallPart.kind === ResponsePartKind.ToolCall);
		if (toolCallPart.kind === ResponsePartKind.ToolCall) {
			assert.strictEqual(toolCallPart.toolCall._meta?.toolKind, 'subagent');
		}
	});

	test('Fixture 6: tail Turn with orphan tool_use is Cancelled', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'do work'),
			makeAssistantToolUse('a1', 'tu-orphan', 'Bash', { command: 'sleep 100' }),
			// no matching tool_result — model crashed mid-turn
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].state, TurnState.Cancelled);
	});

	test('Fixture 6b: orphan in turn N does NOT cancel turn N+1', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'first'),
			makeAssistantToolUse('a1', 'tu-orphan', 'Bash', {}),
			// no tool_result for tu-orphan
			makeUser('u2', 'second'),
			makeAssistantText('a2', 'clean reply'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 2);
		assert.strictEqual(turns[0].state, TurnState.Cancelled, 'turn 1 has orphan');
		assert.strictEqual(turns[1].state, TurnState.Complete, 'turn 2 has no orphan');
	});

	test('late tool results do not extend the active turn duration', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'first', '2026-07-09T18:00:00.000Z'),
			makeAssistantToolUse('a1', 'tu-late', 'Bash', {}, '2026-07-09T18:00:01.000Z'),
			makeUser('u2', 'second', '2026-07-09T18:00:10.000Z'),
			makeAssistantText('a2', 'clean reply', '2026-07-09T18:00:12.000Z'),
			makeUserToolResult('late-result', 'tu-late', 'done', false, '2026-07-09T18:00:20.000Z'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.deepStrictEqual(turns.map(turn => turn.duration), [1_000, 2_000]);
	});

	test('Fixture 7: non-allowlisted system subtypes are dropped', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'go'),
			makeAssistantText('a1', 'reply'),
			makeSystem('s1', 'api_retry', 'retrying'),
			makeSystem('s2', 'hook_started', 'hook x'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		const sysParts = turns[0].responseParts.filter(p => p.kind === ResponsePartKind.SystemNotification);
		assert.strictEqual(sysParts.length, 0);
	});

	test('Fixture 9: CLI slash-command echo and local-command-stdout entries are dropped', () => {
		// On-disk shape verified empirically (claude-history skill):
		// the `/model` echo lacks `isSynthetic` / `isMeta`, content is a
		// raw string starting with `<command-name>`. Same for the
		// `<local-command-stdout>` paired entry.
		const messages: SessionMessage[] = [
			makeUser('u1', 'what model are you'),
			makeAssistantText('a1', 'sonnet'),
			{
				type: 'user',
				uuid: 'echo-1',
				session_id: 'sess-1',
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-4.7</command-args>' },
			},
			{
				type: 'user',
				uuid: 'echo-2',
				session_id: 'sess-1',
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: { role: 'user', content: '<local-command-stdout>Set model to claude-opus-4.7</local-command-stdout>' },
			},
			makeUser('u2', 'how about now'),
			makeAssistantText('a2', 'opus'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 2, 'CLI-echo user envelopes must NOT start new turns');
		assert.strictEqual(turns[0].id, 'u1');
		assert.strictEqual(turns[0].message.text, 'what model are you');
		assert.strictEqual(turns[1].id, 'u2');
		assert.strictEqual(turns[1].message.text, 'how about now');
	});

	test('harness-injected task notifications never render as user turns; shared envelopes keep the genuine text', () => {
		// The harness appends background-task notifications as `user`
		// envelopes: a `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble
		// followed by a `<task-notification>…</task-notification>` block.
		// A notification queued while the user types can share an envelope
		// with the genuine prompt, so stripping (not envelope-dropping) is
		// required to keep that prompt.
		const notification = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification>\n<task-id>abc123</task-id>\n<status>stopped</status>\n<summary>No completion record was found.</summary>\n</task-notification>\n';
		const messages: SessionMessage[] = [
			makeUser('u1', 'start the work'),
			makeAssistantText('a1', 'working'),
			{
				type: 'user',
				uuid: 'notif-only',
				session_id: 'sess-1',
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: { role: 'user', content: notification },
			},
			{
				type: 'user',
				uuid: 'notif-plus-prompt',
				session_id: 'sess-1',
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: { role: 'user', content: `${notification}修掉` },
			},
			makeAssistantText('a2', 'on it'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 2, 'notification-only envelope must NOT start a turn');
		assert.strictEqual(turns[0].id, 'u1');
		assert.strictEqual(turns[0].message.text, 'start the work');
		assert.strictEqual(turns[1].id, 'notif-plus-prompt');
		assert.strictEqual(turns[1].message.text, '修掉', 'genuine text sharing the envelope survives the strip');
	});

	test('host instructions persisted by the UserPromptSubmit hook never render as user text', () => {
		// The SDK persists the hook's `additionalContext` — the joined host
		// instructions — as a leading `text` block of every user envelope,
		// structurally indistinguishable from what the user typed. The history
		// read hands the send's instruction strings back so replay can take
		// them out again (`IAgentChatContext.hostInstructions`).
		const instructionA = 'You are a coding agent inside Fumie, an agent-first desktop coding environment.';
		const instructionB = 'When you produce something the user will want to open, record it once with add_artifact.';
		const hostInstructions = [instructionA, instructionB];
		const injectedBlock = `${instructionA}\n\n${instructionB}`;
		const messages: SessionMessage[] = [
			{
				type: 'user', uuid: 'u1', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
				message: { role: 'user', content: [{ type: 'text', text: injectedBlock }, { type: 'text', text: 'ACP Agent 这个名字我完全不知道' }] },
			},
			makeAssistantText('a1', 'it means Agent Client Protocol'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService, hostInstructions);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].id, 'u1');
		assert.strictEqual(turns[0].message.text, 'ACP Agent 这个名字我完全不知道', 'only the typed text survives');
	});

	test('host instructions the host no longer sends survive as ordinary text (honest failure)', () => {
		const messages: SessionMessage[] = [
			{
				type: 'user', uuid: 'u1', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
				message: { role: 'user', content: [{ type: 'text', text: 'A stale instruction from an older host.' }, { type: 'text', text: 'hello' }] },
			},
			makeAssistantText('a1', 'hi'),
		];

		const withUnrelated = mapSessionMessagesToTurns(messages, session, logService, ['A different instruction.']);
		assert.strictEqual(withUnrelated[0].message.text, 'A stale instruction from an older host.\nhello', 'unrecognised text is never guessed away');

		const withNone = mapSessionMessagesToTurns(messages, session, logService);
		assert.strictEqual(withNone[0].message.text, 'A stale instruction from an older host.\nhello', 'omitted instructions strip nothing');
	});

	test('image blocks replay as embedded attachments; host system-reminder blocks never render', () => {
		// The prompt resolver flattens image attachments into bare image blocks
		// and renders attachment references as a `<system-reminder>` text block;
		// replay must reconstitute the former as attachments and drop the latter.
		const messages: SessionMessage[] = [
			{
				type: 'user', uuid: 'u1', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
				message: {
					role: 'user', content: [
						{ type: 'text', text: '看看这两张图' },
						{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWmg' } },
						{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aWmh' } },
						{ type: 'text', text: '<system-reminder>\nThe user provided the following references:\n- /tmp/pasted.txt\n</system-reminder>' },
					],
				},
			},
			makeAssistantText('a1', 'looking'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, '看看这两张图', 'reminder block must not render as user text');
		const attachments = turns[0].message.attachments;
		assert.strictEqual(attachments?.length, 2);
		assert.deepStrictEqual(attachments.map(a => [a.displayKind, a.type === MessageAttachmentKind.EmbeddedResource ? a.contentType : undefined, a.type === MessageAttachmentKind.EmbeddedResource ? a.data : undefined]), [
			['image', 'image/png', 'aWmg'],
			['image', 'image/jpeg', 'aWmh'],
		]);
	});

	test('an image-only user envelope still opens a turn', () => {
		const messages: SessionMessage[] = [
			{
				type: 'user', uuid: 'u1', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
				message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWmg' } }] },
			},
			makeAssistantText('a1', 'nice screenshot'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, '');
		assert.strictEqual(turns[0].message.attachments?.length, 1);
	});

	test('Fixture 10: prompt-less subagent transcript (inner messages) maps to one turn', () => {
		// A subagent transcript from `getSubagentMessages` carries a
		// `parent_tool_use_id` on every envelope and has NO synthetic spawning
		// user prompt, so it opens directly with an assistant message. The
		// builder must synthesize an empty-prompt turn rather than dropping the
		// inner assistant content (which would lose the whole transcript on
		// replay). Shape mirrors a real captured subagent transcript.
		const parent = 'toolu_parent';
		const messages: SessionMessage[] = [
			{
				type: 'assistant', uuid: 'sa1', session_id: 'sess-1', parent_tool_use_id: parent, parent_agent_id: null,
				message: { id: 'msg_sa1', role: 'assistant', content: [{ type: 'thinking', thinking: 'planning', signature: 'sig' }] },
			},
			{
				type: 'assistant', uuid: 'sa2', session_id: 'sess-1', parent_tool_use_id: parent, parent_agent_id: null,
				message: { id: 'msg_sa2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_inner', name: 'Bash', input: { command: 'ls' } }] },
			},
			{
				type: 'user', uuid: 'sa3', session_id: 'sess-1', parent_tool_use_id: parent, parent_agent_id: null,
				message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_inner', content: 'file-a.txt\nfile-b.txt' }] },
			},
			{
				type: 'assistant', uuid: 'sa4', session_id: 'sess-1', parent_tool_use_id: parent, parent_agent_id: null,
				message: { id: 'msg_sa4', role: 'assistant', content: [{ type: 'text', text: 'Done. SUBAGENT_ONLY_MARKER_xyz' }] },
			},
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1, 'inner assistant messages must form a single synthesized turn');
		assert.strictEqual(turns[0].id, 'sa1', 'turn id anchors on the first inner assistant envelope');
		assert.strictEqual(turns[0].message.text, '', 'subagent turn has no user prompt');
		assert.strictEqual(turns[0].state, TurnState.Complete, 'tool_result drains the pending tool_use');
		const markdown = turns[0].responseParts.filter(p => p.kind === ResponsePartKind.Markdown);
		assert.ok(markdown.some(p => p.kind === ResponsePartKind.Markdown && p.content.includes('SUBAGENT_ONLY_MARKER_xyz')),
			'the subagent final text (with marker) must survive replay');
		const toolCall = turns[0].responseParts.find(p => p.kind === ResponsePartKind.ToolCall);
		assert.ok(toolCall && toolCall.kind === ResponsePartKind.ToolCall && toolCall.toolCall.status === ToolCallStatus.Completed,
			'inner Bash tool call must be reconstructed as Completed');
	});

	test('Fixture 10b: top-level assistant before any user message is recovered under a placeholder prompt', () => {
		// A truncated transcript slice (the SDK returns only the bytes after
		// the last compact boundary for large sessions) can open mid-turn,
		// with the user prompt cut off. The reply must still be recovered —
		// dropping it empties the whole chat when the slice contains no user
		// message at all.
		const messages: SessionMessage[] = [
			makeAssistantText('a1', 'promptless reply'),
			makeUser('u1', 'hello'),
			makeAssistantText('a2', 'world'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.deepStrictEqual(turns.map(turn => ({ id: turn.id, text: turn.message.text })), [
			{ id: 'a1', text: missingPromptPlaceholder() },
			{ id: 'u1', text: 'hello' },
		]);
	});

	test('a transcript slice with no user message at all still yields turns', () => {
		// The reported failure mode: every envelope in the slice belonged to
		// one long agentic turn whose prompt was truncated away, so the whole
		// session replayed as zero turns and the chat rendered empty.
		const messages: SessionMessage[] = [
			makeAssistantToolUse('a1', 'tu1', 'Bash', { command: 'ls' }),
			makeUserToolResult('r1', 'tu1', 'file.txt'),
			makeAssistantText('a2', 'done'),
		];

		const turns = mapSessionMessagesToTurns(messages, session, logService);

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].message.text, missingPromptPlaceholder());
		assert.strictEqual(turns[0].state, TurnState.Complete);
	});
});

suite('resolveForkAnchorUuid', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function makeUser(uuid: string, text: string): SessionMessage {
		return {
			type: 'user',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { role: 'user', content: [{ type: 'text', text }] },
		};
	}

	function makeAssistantText(uuid: string, text: string): SessionMessage {
		return {
			type: 'assistant',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
		};
	}

	function makeAssistantToolUse(uuid: string, toolUseId: string, name: string, input: unknown = {}): SessionMessage {
		return {
			type: 'assistant',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
		};
	}

	function makeUserToolResult(uuid: string, toolUseId: string, text: string): SessionMessage {
		return {
			type: 'user',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
		};
	}

	function makeSystem(uuid: string, subtype: string, text?: string): SessionMessage {
		return {
			type: 'system',
			uuid,
			session_id: 'sess-1',
			parent_tool_use_id: null,
			parent_agent_id: null,
			message: { subtype, ...(text !== undefined ? { text } : {}) },
		};
	}

	// 3-turn transcript shared by the fork-position fixtures.
	const threeTurns: SessionMessage[] = [
		makeUser('u1', 'apple'),
		makeAssistantText('a1', 'apple!'),
		makeUser('u2', 'banana'),
		makeAssistantText('a2', 'banana!'),
		makeUser('u3', 'cherry'),
		makeAssistantText('a3', 'cherry!'),
	];

	test('fork at turn 0 → last assistant uuid of turn 0', () => {
		assert.strictEqual(resolveForkAnchorUuid(threeTurns, 'u1'), 'a1');
	});

	test('fork at turn 1 → last assistant uuid of turn 1', () => {
		assert.strictEqual(resolveForkAnchorUuid(threeTurns, 'u2'), 'a2');
	});

	test('fork at the last turn → last assistant uuid of that turn', () => {
		assert.strictEqual(resolveForkAnchorUuid(threeTurns, 'u3'), 'a3');
	});

	test('turn with multiple assistant envelopes → the LAST one', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'do a thing'),
			makeAssistantText('a1', 'thinking'),
			makeAssistantToolUse('a2', 'tool-1', 'Read'),
			makeUserToolResult('r1', 'tool-1', 'file contents'),
			makeUser('u2', 'next'),
			makeAssistantText('a3', 'ok'),
		];
		assert.strictEqual(resolveForkAnchorUuid(messages, 'u1'), 'a2', 'must return the last assistant envelope of the target turn');
	});

	test('user-tool-results between assistants does not flip the turn', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'go'),
			makeAssistantToolUse('a1', 'tool-1', 'Read'),
			makeUserToolResult('r1', 'tool-1', 'contents'),
			makeAssistantText('a2', 'done'),
			makeUser('u2', 'next'),
			makeAssistantText('a3', 'ok'),
		];
		assert.strictEqual(resolveForkAnchorUuid(messages, 'u1'), 'a2', 'tool_result envelope must not end the turn');
	});

	test('system-notification mid-turn does not flip the turn', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'go'),
			makeSystem('s1', 'compact_boundary'),
			makeAssistantText('a1', 'done'),
			makeUser('u2', 'next'),
			makeAssistantText('a2', 'ok'),
		];
		assert.strictEqual(resolveForkAnchorUuid(messages, 'u1'), 'a1', 'system notification must not end the turn');
	});

	test('user-only target turn (no assistant) has no valid fork anchor', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'apple'),
			makeAssistantText('a1', 'apple!'),
			makeUser('u2', 'unanswered'),
		];
		assert.strictEqual(resolveForkAnchorUuid(messages, 'u2'), undefined);
	});

	test('turnId not found → undefined', () => {
		assert.strictEqual(resolveForkAnchorUuid(threeTurns, 'nope'), undefined);
	});

	test('a promptless leading turn is anchorable, mirroring the replay builder', () => {
		// The builder opens a turn keyed on the leading assistant envelope when
		// the prompt is missing from the slice; the resolver must agree or a
		// fork from that turn cannot be anchored.
		const messages: SessionMessage[] = [
			makeAssistantText('a1', 'promptless reply'),
			makeUser('u1', 'next'),
			makeAssistantText('a2', 'ok'),
		];
		assert.strictEqual(resolveForkAnchorUuid(messages, 'a1'), 'a1');
	});

	test('empty transcript → undefined', () => {
		assert.strictEqual(resolveForkAnchorUuid([], 'u1'), undefined);
	});

	test('CLI-echo user envelopes are skipped by the shared parser', () => {
		const messages: SessionMessage[] = [
			makeUser('u1', 'what model'),
			{
				type: 'user',
				uuid: 'echo-1',
				session_id: 'sess-1',
				parent_tool_use_id: null,
				parent_agent_id: null,
				message: { role: 'user', content: '<command-name>/model</command-name>' },
			},
			makeAssistantText('a1', 'opus'),
			makeUser('u2', 'next'),
			makeAssistantText('a2', 'ok'),
		];
		// The CLI-echo envelope must not be treated as the start of a new turn,
		// so turn u1's anchor is still a1 (not echo-1, not undefined).
		assert.strictEqual(resolveForkAnchorUuid(messages, 'u1'), 'a1');
	});
});
