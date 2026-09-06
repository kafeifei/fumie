/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { AgentSignal, IAgentActionSignal, IAgentSubagentStartedSignal } from '../../../common/agent.js';
import { readToolCallMeta } from '../../../common/meta/agentToolCallMeta.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, TurnState } from '../../../common/state/sessionState.js';
import { OpencodeTurnMapper, replayOpencodeMessagesToTurns, type IOpencodePart, type IOpencodeStoredMessage } from '../../../node/opencode/opencodeReplayMapper.js';
import type { IOpencodeEvent } from '../../../node/opencode/opencodeServerService.js';

const CHAT = URI.parse('ahp-chat:/opencode-chat');
const ROOT = 'ses_root';
const CHILD = 'ses_child';
const GRANDCHILD = 'ses_grandchild';
const CWD = '/workspace';

function mapper(): OpencodeTurnMapper {
	return new OpencodeTurnMapper('turn-1', CHAT, ROOT, CWD, 0);
}

function partUpdated(part: Partial<IOpencodePart> & { id: string; sessionID: string; messageID: string; type: string }): IOpencodeEvent {
	return { type: 'message.part.updated', properties: { sessionID: part.sessionID, part } };
}

function partDelta(sessionID: string, partID: string, delta: string): IOpencodeEvent {
	return { type: 'message.part.delta', properties: { sessionID, partID, field: 'text', delta } };
}

function messageUpdated(info: Record<string, unknown>): IOpencodeEvent {
	return { type: 'message.updated', properties: { sessionID: info['sessionID'], info } };
}

/** A `task` tool part in `sessionID` that has just named the child it spawned. */
function taskRunning(sessionID: string, callID: string, childSessionID: string): IOpencodeEvent {
	return partUpdated({
		id: `prt_${callID}`,
		sessionID,
		messageID: 'msg_assistant',
		type: 'tool',
		tool: 'task',
		callID,
		state: {
			status: 'running',
			input: { description: 'List files', prompt: 'List the files here.', subagent_type: 'explore' },
			metadata: { parentSessionId: sessionID, sessionId: childSessionID },
		},
	});
}

function actions(signals: readonly AgentSignal[]): readonly IAgentActionSignal[] {
	return signals.filter((signal): signal is IAgentActionSignal => signal.kind === 'action');
}

function actionTypes(signals: readonly AgentSignal[]): readonly ActionType[] {
	return actions(signals).map(signal => signal.action.type);
}

suite('OpencodeTurnMapper', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('announces a text part once and publishes only what is new', () => {
		const subject = mapper();
		const announced = subject.mapEvent(partUpdated({ id: 'prt_text', sessionID: ROOT, messageID: 'msg_a', type: 'text', text: '' }));
		assert.deepStrictEqual(actionTypes(announced), [ActionType.ChatResponsePart]);
		const first = actions(announced)[0].action;
		assert.strictEqual(first.type === ActionType.ChatResponsePart ? first.part.kind : undefined, ResponsePartKind.Markdown);

		const streamed = subject.mapEvent(partDelta(ROOT, 'prt_text', 'Hello'));
		const delta = actions(streamed)[0].action;
		assert.strictEqual(delta.type, ActionType.ChatDelta);
		assert.strictEqual(delta.type === ActionType.ChatDelta ? delta.content : undefined, 'Hello');

		// opencode re-publishes the whole accumulated text; the already-streamed
		// prefix must not be sent a second time.
		const snapshot = subject.mapEvent(partUpdated({ id: 'prt_text', sessionID: ROOT, messageID: 'msg_a', type: 'text', text: 'Hello' }));
		assert.deepStrictEqual(snapshot, []);

		const tail = subject.mapEvent(partUpdated({ id: 'prt_text', sessionID: ROOT, messageID: 'msg_a', type: 'text', text: 'Hello there' }));
		const tailAction = actions(tail)[0].action;
		assert.strictEqual(tailAction.type === ActionType.ChatDelta ? tailAction.content : undefined, ' there');
	});

	test('routes a reasoning part to the thinking stream', () => {
		const subject = mapper();
		subject.mapEvent(partUpdated({ id: 'prt_think', sessionID: ROOT, messageID: 'msg_a', type: 'reasoning', text: '' }));
		const streamed = subject.mapEvent(partDelta(ROOT, 'prt_think', 'Considering'));
		assert.deepStrictEqual(actionTypes(streamed), [ActionType.ChatReasoning]);
	});

	test('leaves the user message out of the response stream', () => {
		const subject = mapper();
		subject.mapEvent(messageUpdated({ id: 'msg_user', role: 'user', sessionID: ROOT }));
		const signals = subject.mapEvent(partUpdated({ id: 'prt_prompt', sessionID: ROOT, messageID: 'msg_user', type: 'text', text: 'do the thing' }));
		assert.deepStrictEqual(signals, []);
	});

	test('drops frames from a session this turn cannot route', () => {
		const subject = mapper();
		const signals = subject.mapEvent(partUpdated({ id: 'prt_other', sessionID: 'ses_someone_else', messageID: 'msg_x', type: 'text', text: 'not ours' }));
		assert.deepStrictEqual(signals, []);
	});

	test('drives a tool call from start through ready to completion', () => {
		const subject = mapper();
		const pending = subject.mapEvent(partUpdated({
			id: 'prt_read', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'read', callID: 'call_read',
			state: { status: 'pending', input: {} },
		}));
		assert.deepStrictEqual(actionTypes(pending), [ActionType.ChatToolCallStart]);
		const start = actions(pending)[0].action;
		assert.strictEqual(start.type === ActionType.ChatToolCallStart ? start.toolName : undefined, 'read');
		assert.strictEqual(readToolCallMeta(start as { _meta?: Record<string, unknown> }).toolKind, 'read');

		const running = subject.mapEvent(partUpdated({
			id: 'prt_read', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'read', callID: 'call_read',
			state: { status: 'running', input: { filePath: 'src/main.ts' }, title: 'src/main.ts' },
		}));
		assert.deepStrictEqual(actionTypes(running), [ActionType.ChatToolCallDelta, ActionType.ChatToolCallReady]);

		const completed = subject.mapEvent(partUpdated({
			id: 'prt_read', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'read', callID: 'call_read',
			state: { status: 'completed', input: { filePath: 'src/main.ts' }, output: 'file body', title: 'src/main.ts' },
		}));
		assert.deepStrictEqual(actionTypes(completed), [ActionType.ChatToolCallComplete]);
		const complete = actions(completed)[0].action;
		assert.strictEqual(complete.type === ActionType.ChatToolCallComplete ? complete.result.success : undefined, true);

		// A repeated terminal frame must not complete the call twice.
		assert.deepStrictEqual(subject.mapEvent(partUpdated({
			id: 'prt_read', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'read', callID: 'call_read',
			state: { status: 'completed', input: { filePath: 'src/main.ts' }, output: 'file body' },
		})), []);
	});

	test('reports a failed tool call with the error opencode gave', () => {
		const subject = mapper();
		subject.mapEvent(partUpdated({
			id: 'prt_bash', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'bash', callID: 'call_bash',
			state: { status: 'error', input: { command: 'false' }, error: 'exit status 1' },
		}));
		const signals = subject.mapEvent(partUpdated({
			id: 'prt_bash2', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'bash', callID: 'call_bash2',
			state: { status: 'error', input: { command: 'false' }, error: 'exit status 1' },
		}));
		const complete = actions(signals).map(signal => signal.action).find(action => action.type === ActionType.ChatToolCallComplete);
		assert.ok(complete && complete.type === ActionType.ChatToolCallComplete);
		assert.strictEqual(complete.result.success, false);
		assert.strictEqual(complete.result.error?.message, 'exit status 1');
	});

	suite('subagents', () => {

		test('a task call adopts its child session and announces the subagent', () => {
			const subject = mapper();
			subject.mapEvent(partUpdated({
				id: 'prt_task', sessionID: ROOT, messageID: 'msg_assistant', type: 'tool', tool: 'task', callID: 'call_task',
				state: { status: 'pending', input: {} },
			}));
			const signals = subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));
			assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatToolCallDelta, ActionType.ChatToolCallReady]);
			const ready = actions(signals)[1].action;
			const meta = readToolCallMeta(ready as { _meta?: Record<string, unknown> });
			assert.strictEqual(meta.toolKind, 'subagent');
			assert.strictEqual(meta.subagentAgentName, 'explore');
			assert.strictEqual(meta.subagentDescription, 'List files');

			const started = signals.find((signal): signal is IAgentSubagentStartedSignal => signal.kind === 'subagent_started');
			assert.ok(started, 'the spawning call announces its subagent');
			assert.strictEqual(started.toolCallId, 'call_task');
			assert.strictEqual(started.agentName, 'explore');
			assert.strictEqual(started.taskDescription, 'List files');
			assert.strictEqual(started.taskPrompt, 'List the files here.');
			assert.strictEqual(started.parentToolCallId, undefined, 'a top-level subagent has no parent call');
			// Announced before any of the child's own content can arrive.
			assert.ok(signals.indexOf(started) > 0);
		});

		test('the child session\'s content is re-addressed to the subagent chat', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));

			const text = subject.mapEvent(partUpdated({ id: 'prt_child_text', sessionID: CHILD, messageID: 'msg_child', type: 'text', text: '' }));
			assert.strictEqual(actions(text)[0].parentToolCallId, 'call_task');

			const streamed = subject.mapEvent(partDelta(CHILD, 'prt_child_text', 'events.jsonl'));
			assert.strictEqual(actions(streamed)[0].parentToolCallId, 'call_task');

			const tool = subject.mapEvent(partUpdated({
				id: 'prt_child_read', sessionID: CHILD, messageID: 'msg_child', type: 'tool', tool: 'read', callID: 'call_child_read',
				state: { status: 'running', input: { filePath: '/workspace/README.md' } },
			}));
			assert.ok(actions(tool).length > 0);
			assert.ok(actions(tool).every(signal => signal.parentToolCallId === 'call_task'));

			// The parent's own frames stay on the parent chat.
			const parentText = subject.mapEvent(partUpdated({ id: 'prt_root_text', sessionID: ROOT, messageID: 'msg_assistant', type: 'text', text: '' }));
			assert.strictEqual(actions(parentText)[0].parentToolCallId, undefined);
		});

		test('a task inside a subagent names the call one hop up', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));
			const nested = subject.mapEvent(taskRunning(CHILD, 'call_inner_task', GRANDCHILD));

			const started = nested.find((signal): signal is IAgentSubagentStartedSignal => signal.kind === 'subagent_started');
			assert.ok(started);
			assert.strictEqual(started.toolCallId, 'call_inner_task');
			assert.strictEqual(started.parentToolCallId, 'call_task', 'the spawning call lives in the outer subagent\'s chat');

			// The grandchild's own frames are keyed off the call that spawned it,
			// flatly — no per-level chain.
			const grandchild = subject.mapEvent(partUpdated({ id: 'prt_gc', sessionID: GRANDCHILD, messageID: 'msg_gc', type: 'text', text: 'done' }));
			assert.strictEqual(actions(grandchild)[0].parentToolCallId, 'call_inner_task');
		});

		test('completing the task call completes the subagent', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));
			const signals = subject.mapEvent(partUpdated({
				id: 'prt_task', sessionID: ROOT, messageID: 'msg_assistant', type: 'tool', tool: 'task', callID: 'call_task',
				state: { status: 'completed', input: { description: 'List files' }, output: '<task_result>ok</task_result>' },
			}));
			assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatToolCallComplete]);
			assert.ok(signals.some(signal => signal.kind === 'subagent_completed' && signal.toolCallId === 'call_task'));
		});

		test('an unfinished subagent is closed out with the turn', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));
			const closed = subject.closeOutstandingToolCalls('opencode stopped.');
			const complete = actions(closed)[0].action;
			assert.ok(complete.type === ActionType.ChatToolCallComplete);
			assert.strictEqual(complete.result.success, false);
			assert.strictEqual(complete.result.error?.message, 'opencode stopped.');
			assert.ok(closed.some(signal => signal.kind === 'subagent_completed'));
		});

		test('a background launch or promotion receipt is not a child terminal event', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'task', CHILD));
			const receipt = partUpdated({
				id: 'prt_task', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'task', callID: 'task',
				state: { status: 'completed', metadata: { sessionId: CHILD, background: true, jobId: CHILD }, output: 'running' },
			});
			assert.ok(!subject.mapEvent(receipt).some(signal => signal.kind === 'subagent_completed'));
			assert.deepStrictEqual(subject.mapEvent(receipt), []);
			assert.deepStrictEqual(subject.closeOutstandingToolCalls('root ended', false), []);
			assert.strictEqual(subject.hasActiveSubagents, true);
			const idle: IOpencodeEvent = { type: 'session.status', properties: { sessionID: CHILD, status: { type: 'idle' } } };
			assert.deepStrictEqual(subject.mapEvent(idle), []);
			assert.deepStrictEqual(subject.mapEvent(idle), []);
			assert.strictEqual(subject.hasActiveSubagents, true, 'runner idle does not end a job with queued extensions');
			assert.deepStrictEqual(subject.mapBackgroundResult(CHILD), [{ kind: 'subagent_completed', chat: CHAT, toolCallId: 'task' }]);
			assert.deepStrictEqual(subject.mapBackgroundResult(CHILD), []);
			assert.strictEqual(subject.hasActiveSubagents, false);
		});

		test('child routes and permission ownership survive beginTurn; task_id reuses the original peer', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'original', CHILD));
			subject.mapEvent({ type: 'session.status', properties: { sessionID: CHILD, status: { type: 'idle' } } });
			subject.beginTurn('turn-2', 100);
			const resumedTask = subject.mapEvent(taskRunning(ROOT, 'resume-call', CHILD));
			assert.ok(!resumedTask.some(signal => signal.kind === 'subagent_started'));
			assert.ok(resumedTask.some(signal => signal.kind === 'subagent_resumed' && signal.toolCallId === 'original'));
			const busy: IOpencodeEvent = { type: 'session.status', properties: { sessionID: CHILD, status: { type: 'busy' } } };
			assert.deepStrictEqual(subject.mapEvent(busy), []);
			assert.deepStrictEqual(subject.mapEvent(busy), []);
			const permission = subject.mapPermissionAsk({ id: 'per_resume', sessionID: CHILD, permission: 'write' });
			assert.strictEqual(permission?.confirmation.parentToolCallId, 'original');
			const output = subject.mapEvent(partUpdated({ id: 'new-text', sessionID: CHILD, messageID: 'new-message', type: 'text', text: 'Resumed' }));
			assert.ok(actions(output).every(signal => signal.parentToolCallId === 'original'));
		});

		test('child failure is routed, and native idle completes it once without failing the parent', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'task', CHILD));
			const error = subject.mapEvent({ type: 'session.error', properties: { sessionID: CHILD, error: { name: 'Error', data: { message: 'failed' } } } });
			assert.strictEqual(actions(error)[0].parentToolCallId, 'task');
			assert.ok(!error.some(signal => signal.kind === 'subagent_completed'));
			const complete = subject.mapEvent({ type: 'session.status', properties: { sessionID: CHILD, status: { type: 'idle' } } });
			assert.strictEqual(complete.filter(signal => signal.kind === 'subagent_completed').length, 1);
			assert.ok(!subject.closeOutstandingToolCalls('released').some(signal => signal.kind === 'subagent_completed'));
		});
	});

	suite('permissions', () => {

		test('an ask becomes a confirmation on the tool call it names', () => {
			const subject = mapper();
			subject.mapEvent(partUpdated({
				id: 'prt_bash', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'bash', callID: 'call_bash',
				state: { status: 'pending', input: { command: 'rm -rf build' } },
			}));
			const mapping = subject.mapPermissionAsk({
				id: 'per_1', sessionID: ROOT, action: 'bash', resources: ['rm -rf build'],
				source: { type: 'tool', messageID: 'msg_a', callID: 'call_bash' },
			});
			assert.ok(mapping);
			assert.deepStrictEqual(mapping.signals, [], 'the call was already announced');
			assert.strictEqual(mapping.confirmation.state.toolCallId, 'call_bash');
			assert.strictEqual(mapping.confirmation.permissionKind, 'shell');
			assert.strictEqual(mapping.confirmation.shellLanguage, 'bash');
			assert.strictEqual(mapping.confirmation.parentToolCallId, undefined);

			// The host now owns the ready/confirm handshake, so the running frame
			// must not slip an auto-confirmed ready past it.
			const running = subject.mapEvent(partUpdated({
				id: 'prt_bash', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'bash', callID: 'call_bash',
				state: { status: 'running', input: { command: 'rm -rf build' } },
			}));
			assert.deepStrictEqual(actionTypes(running), []);
		});

		test('reads the v1 ask shape opencode actually sends', () => {
			const subject = mapper();
			subject.mapEvent(partUpdated({
				id: 'prt_patch', sessionID: ROOT, messageID: 'msg_a', type: 'tool', tool: 'apply_patch', callID: 'call_patch',
				state: { status: 'pending', input: {} },
			}));
			// `permission.asked` names the same things as `permission.v2.asked` under
			// different keys, and is what 1.18.25 publishes in practice.
			const mapping = subject.mapPermissionAsk({
				id: 'per_v1', sessionID: ROOT, permission: 'edit', patterns: ['/workspace/notes/note.txt'],
				tool: { messageID: 'msg_a', callID: 'call_patch' },
			});
			assert.ok(mapping);
			assert.strictEqual(mapping.confirmation.state.toolCallId, 'call_patch');
			assert.strictEqual(mapping.confirmation.state.toolName, 'apply_patch');
			assert.strictEqual(mapping.confirmation.permissionKind, 'write');
			// `apply_patch` names no path in its own input, so the ask supplies one —
			// without it the host would have no path to apply its rules to.
			assert.strictEqual(mapping.confirmation.permissionPath, '/workspace/notes/note.txt');
		});

		test('does not invent a path from a worktree-relative resource', () => {
			const subject = mapper();
			// opencode states a relative resource against its worktree root, which
			// need not be the directory the server was rooted at. Resolving it here
			// produced a doubled, nonexistent path in the real smoke.
			const mapping = subject.mapPermissionAsk({
				id: 'per_v1c', sessionID: ROOT, permission: 'edit', patterns: ['private/tmp/probe/note.txt'],
				tool: { messageID: 'msg_a', callID: 'call_patch2' },
			});
			assert.ok(mapping);
			assert.strictEqual(mapping.confirmation.permissionPath, undefined);
		});

		test('does not mistake a shell ask\'s command for a path', () => {
			const subject = mapper();
			const mapping = subject.mapPermissionAsk({
				id: 'per_v1b', sessionID: ROOT, permission: 'bash', patterns: ['rm -rf build'],
				tool: { messageID: 'msg_a', callID: 'call_sh' },
			});
			assert.ok(mapping);
			assert.strictEqual(mapping.confirmation.permissionKind, 'shell');
			assert.strictEqual(mapping.confirmation.permissionPath, undefined);
		});

		test('an ask for an unannounced call synthesizes its start', () => {
			const subject = mapper();
			const mapping = subject.mapPermissionAsk({
				id: 'per_2', sessionID: ROOT, action: 'webfetch', resources: ['https://example.com'],
				source: { type: 'tool', messageID: 'msg_a', callID: 'call_fetch' },
			});
			assert.ok(mapping);
			assert.deepStrictEqual(actionTypes(mapping.signals), [ActionType.ChatToolCallStart]);
			assert.strictEqual(mapping.confirmation.permissionKind, 'url');
		});

		test('an ask from a subagent is confirmed against the subagent chat', () => {
			const subject = mapper();
			subject.mapEvent(taskRunning(ROOT, 'call_task', CHILD));
			subject.mapEvent(partUpdated({
				id: 'prt_child_write', sessionID: CHILD, messageID: 'msg_child', type: 'tool', tool: 'write', callID: 'call_child_write',
				state: { status: 'pending', input: { filePath: 'notes.md' } },
			}));
			const mapping = subject.mapPermissionAsk({
				id: 'per_3', sessionID: CHILD, action: 'write', resources: ['notes.md'],
				source: { type: 'tool', messageID: 'msg_child', callID: 'call_child_write' },
			});
			assert.ok(mapping);
			assert.strictEqual(mapping.confirmation.parentToolCallId, 'call_task');
			assert.strictEqual(mapping.confirmation.permissionKind, 'write');
			assert.strictEqual(mapping.confirmation.permissionPath, '/workspace/notes.md');
		});

		test('an ask for a session with no route is not surfaced', () => {
			const subject = mapper();
			assert.strictEqual(subject.mapPermissionAsk({
				id: 'per_4', sessionID: 'ses_unrelated', action: 'bash', resources: [],
				source: { type: 'tool', messageID: 'msg_x', callID: 'call_x' },
			}), undefined);
		});
	});

	test('reports a completed assistant message\'s usage exactly once', () => {
		const subject = mapper();
		const info = {
			id: 'msg_a', role: 'assistant', sessionID: ROOT, providerID: 'openai', modelID: 'gpt-5.4-mini',
			time: { created: 1, completed: 2 },
			tokens: { total: 3333, input: 3200, output: 80, reasoning: 53, cache: { read: 12, write: 7 } },
		};
		const first = subject.mapEvent(messageUpdated(info));
		const usage = actions(first)[0].action;
		assert.ok(usage.type === ActionType.ChatUsage);
		assert.strictEqual(usage.usage.inputTokens, 3200);
		assert.strictEqual(usage.usage.outputTokens, 80);
		assert.strictEqual(usage.usage.cacheReadTokens, 12);
		assert.strictEqual(usage.usage._meta?.['cacheCreationTokens'], 7);
		assert.strictEqual(usage.usage.model, 'openai/gpt-5.4-mini');
		// opencode publishes the completed message twice on the stream, and the
		// agent replays the very same message a third time out of the prompt call's
		// answer — which regularly beats the stream frame, and has to, because a
		// usage action that lands after `ChatTurnComplete` is dropped by the
		// reducer. Whichever telling arrives first wins; the rest are dropped.
		assert.deepStrictEqual(subject.mapEvent(messageUpdated(info)), []);
		assert.deepStrictEqual(subject.mapEvent(messageUpdated(info)), []);
	});

	test('an in-flight message reports no usage yet', () => {
		const subject = mapper();
		const signals = subject.mapEvent(messageUpdated({
			id: 'msg_a', role: 'assistant', sessionID: ROOT, time: { created: 1 },
			tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } },
		}));
		assert.deepStrictEqual(signals, []);
	});

	test('a session error is reported without closing the turn', () => {
		const subject = mapper();
		const signals = subject.mapEvent({
			type: 'session.error',
			properties: { sessionID: ROOT, error: { name: 'ProviderAuthError', data: { message: 'not signed in' } } },
		});
		assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatError]);
		const error = actions(signals)[0].action;
		assert.strictEqual(error.type === ActionType.ChatError ? error.error.message : undefined, 'not signed in');

		// The prompt call decides when the turn ended, and it must not tell the
		// same story twice.
		assert.deepStrictEqual(actionTypes(subject.mapFailure(new Error('not signed in'), 5)), [ActionType.ChatTurnComplete]);
	});
});

suite('opencode background replay', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('native synthetic task results replay as system notifications, not empty user turns', () => {
		const messages: IOpencodeStoredMessage[] = [{
			info: { id: 'native-notice', role: 'user', sessionID: ROOT },
			parts: [{ id: 'notice', sessionID: ROOT, messageID: 'native-notice', type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' }],
		}, {
			info: { id: 'follow-up', role: 'assistant', sessionID: ROOT },
			parts: [{ id: 'answer', sessionID: ROOT, messageID: 'follow-up', type: 'text', text: 'Result summarized' }],
		}];
		const first = replayOpencodeMessagesToTurns(messages, CHAT, ROOT, CWD);
		assert.strictEqual(first.length, 1);
		assert.strictEqual(first[0].message.origin.kind, MessageKind.SystemNotification);
		assert.ok(first[0].message.text.includes('Done'));
		assert.deepStrictEqual(replayOpencodeMessagesToTurns(messages, CHAT, ROOT, CWD), first);
	});
});

suite('replayOpencodeMessagesToTurns', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function stored(info: IOpencodeStoredMessage['info'], parts: readonly Partial<IOpencodePart>[]): IOpencodeStoredMessage {
		return { info, parts: parts.map(part => ({ sessionID: ROOT, messageID: info.id, ...part }) as IOpencodePart) };
	}

	test('rebuilds turns from a stored conversation', () => {
		const turns = replayOpencodeMessagesToTurns([
			stored({ id: 'msg_u1', role: 'user', sessionID: ROOT }, [
				{ id: 'prt_ctx', type: 'text', text: 'host briefing', synthetic: true },
				{ id: 'prt_u1', type: 'text', text: 'read the readme' },
			]),
			stored({ id: 'msg_a1', role: 'assistant', sessionID: ROOT, time: { created: 1, completed: 2 }, tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } }, [
				{ id: 'prt_tool', type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed', input: { filePath: 'README.md' }, output: '# Title' } },
				{ id: 'prt_a1', type: 'text', text: 'It is the readme.' },
			]),
			stored({ id: 'msg_u2', role: 'user', sessionID: ROOT }, [{ id: 'prt_u2', type: 'text', text: 'thanks' }]),
		], CHAT, ROOT, CWD);

		assert.strictEqual(turns.length, 2);
		// The host's own synthetic context is not something the user said.
		assert.strictEqual(turns[0].message.text, 'read the readme');
		assert.strictEqual(turns[0].state, TurnState.Complete);
		assert.strictEqual(turns[0].usage?.inputTokens, 10);
		assert.deepStrictEqual(turns[0].responseParts.map(part => part.kind), [ResponsePartKind.ToolCall, ResponsePartKind.Markdown]);
		// Replaying the same conversation names the same turns, so the host sees a
		// restore rather than a new history.
		assert.strictEqual(turns[0].id, `${ROOT}:0`);
		assert.strictEqual(turns[1].message.text, 'thanks');
	});

	test('assistant output with no user message before it has no turn to join', () => {
		const turns = replayOpencodeMessagesToTurns([
			stored({ id: 'msg_a0', role: 'assistant', sessionID: ROOT }, [{ id: 'prt_a0', type: 'text', text: 'orphan' }]),
		], CHAT, ROOT, CWD);
		assert.deepStrictEqual(turns, []);
	});

	test('carries an error opencode recorded on the message', () => {
		const turns = replayOpencodeMessagesToTurns([
			stored({ id: 'msg_u1', role: 'user', sessionID: ROOT }, [{ id: 'prt_u1', type: 'text', text: 'go' }]),
			stored({ id: 'msg_a1', role: 'assistant', sessionID: ROOT, error: { name: 'ContextOverflowError', data: { message: 'too long' } } }, []),
		], CHAT, ROOT, CWD);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].state, TurnState.Error);
		assert.strictEqual(turns[0].error?.message, 'too long');
	});
});
