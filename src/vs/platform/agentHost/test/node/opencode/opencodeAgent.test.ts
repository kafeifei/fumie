/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { IProductService } from '../../../../product/common/productService.js';
import { OPENCODE_AGENT_PROVIDER_ID, type AgentSignal, type IAgentModelInfo } from '../../../common/agent.js';
import type { ModelSelection } from '../../../common/state/protocol/state.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { MessageKind, type PendingMessage } from '../../../common/state/sessionState.js';
import { OpencodeAgent, opencodeCatalogModels, opencodeVariant } from '../../../node/opencode/opencodeAgent.js';
import type { IOpencodeEvent, IOpencodeServer, IOpencodeServerService } from '../../../node/opencode/opencodeServerService.js';

type CatalogModel = { name?: string; variants?: Record<string, unknown> };

function rowFor(models: Record<string, CatalogModel>): IAgentModelInfo {
	const rows = opencodeCatalogModels(OPENCODE_AGENT_PROVIDER_ID, { providers: [{ id: 'openai', models }] });
	assert.strictEqual(rows.length, 1);
	return rows[0];
}

function thinkingLevel(row: IAgentModelInfo) {
	return row.configSchema?.properties['thinkingLevel'];
}

suite('opencodeCatalogModels - thinking level', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects a model variants map onto a thinkingLevel picker entry', () => {
		const row = rowFor({
			'gpt-5.4-mini': {
				name: 'GPT-5.4 mini',
				variants: { high: {}, none: {}, medium: {}, low: {}, xhigh: {} },
			},
		});
		const property = thinkingLevel(row);
		assert.ok(property);
		assert.strictEqual(property.type, 'string');
		// Effort order, not the order opencode happened to list them in.
		assert.deepStrictEqual(property.enum, ['none', 'low', 'medium', 'high', 'xhigh']);
		assert.deepStrictEqual(property.enumLabels, ['None', 'Low', 'Medium', 'High', 'Extra High']);
		assert.strictEqual(property.enumDescriptions?.length, 5);
		// No declared default: an unpicked level sends no variant at all.
		assert.strictEqual(property.default, undefined);
	});

	test('keeps a model without variants free of a config schema', () => {
		assert.strictEqual(rowFor({ 'gpt-5.4-mini': { name: 'GPT-5.4 mini' } }).configSchema, undefined);
		assert.strictEqual(rowFor({ 'gpt-5.4-mini': { name: 'GPT-5.4 mini', variants: {} } }).configSchema, undefined);
	});

	test('orders every tier opencode actually publishes', () => {
		// The `opencode` provider's own models really do carry `minimal`, which
		// belongs between `none` and `low` rather than after `xhigh`.
		const property = thinkingLevel(rowFor({
			'muse-spark-1.3': { variants: { high: {}, minimal: {}, xhigh: {}, low: {}, medium: {} } },
		}));
		assert.deepStrictEqual(property?.enum, ['minimal', 'low', 'medium', 'high', 'xhigh']);
	});

	test('appends variant keys it does not know after the ordered ones', () => {
		const property = thinkingLevel(rowFor({
			'gpt-5.6': { variants: { max: {}, turbo: {}, low: {}, glacial: {} } },
		}));
		assert.deepStrictEqual(property?.enum, ['low', 'max', 'turbo', 'glacial']);
		// An unknown key still gets a presentable label rather than surfacing raw.
		assert.deepStrictEqual(property?.enumLabels, ['Low', 'Max', 'Turbo', 'Glacial']);
	});
});

suite('opencodeVariant', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const catalog = opencodeCatalogModels(OPENCODE_AGENT_PROVIDER_ID, {
		providers: [
			{ id: 'openai', models: { 'gpt-5.4-mini': { variants: { low: {}, medium: {}, high: {}, max: {} } }, 'gpt-4.1': {} } },
			{ id: 'opencode', models: { 'muse-spark-1.3': { variants: { minimal: {}, low: {}, high: {} } } } },
		],
	});

	function selection(id: string, config?: ModelSelection['config']): ModelSelection {
		return { id, ...(config ? { config } : {}) };
	}

	test('reads the picked level off the model selection', () => {
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: 'low' }), catalog), 'low');
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: 'max' }), catalog), 'max');
		assert.strictEqual(opencodeVariant(selection('opencode/muse-spark-1.3', { thinkingLevel: 'minimal' }), catalog), 'minimal');
	});

	test('sends nothing when no level is picked', () => {
		assert.strictEqual(opencodeVariant(undefined, catalog), undefined);
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini'), catalog), undefined);
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: '' }), catalog), undefined);
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: 3 }), catalog), undefined);
	});

	test('drops a level the picked model does not publish', () => {
		// A pick carried over from a model whose variant set is a different one:
		// `minimal` is opencode-zen's, `max` is OpenAI's, and neither model has
		// the other's.
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: 'minimal' }), catalog), undefined);
		assert.strictEqual(opencodeVariant(selection('opencode/muse-spark-1.3', { thinkingLevel: 'max' }), catalog), undefined);
		// A model with no variants at all takes no level either.
		assert.strictEqual(opencodeVariant(selection('openai/gpt-4.1', { thinkingLevel: 'low' }), catalog), undefined);
	});

	test('drops a level when the model is not in the catalog', () => {
		assert.strictEqual(opencodeVariant(selection('openai/gpt-9', { thinkingLevel: 'low' }), catalog), undefined);
		assert.strictEqual(opencodeVariant(selection('openai/gpt-5.4-mini', { thinkingLevel: 'low' }), []), undefined);
	});
});

suite('OpencodeAgent native turn lifecycle', () => {
	const chat = URI.parse('ahp-chat:/opencode-test');
	const cwd = URI.file('/workspace');
	let agent: OpencodeAgent;
	let events: Emitter<IOpencodeEvent>;
	let close: Emitter<string>;
	let signals: AgentSignal[];
	let requests: { path: string; body?: unknown }[];
	let prompts: { sessionID: string; messageID: string; result: DeferredPromise<unknown> }[];
	let sessions: number;
	let sessionCreation: DeferredPromise<{ id: string }> | undefined;

	teardown(async () => {
		await agent.shutdown();
		for (const prompt of prompts) {
			if (!prompt.result.isSettled) {
				await prompt.result.complete({});
			}
		}
		await flush();
	});
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function message(sessionID: string, id: string, role: string, parentID?: string): void {
		events.fire({ type: 'message.updated', properties: { info: { sessionID, id, role, parentID } } });
	}
	function part(sessionID: string, messageID: string, id: string, fields: Record<string, unknown>): void {
		events.fire({ type: 'message.part.updated', properties: { part: { sessionID, messageID, id, ...fields } } });
	}
	function status(sessionID: string, type: string): void {
		events.fire({ type: 'session.status', properties: { sessionID, status: { type } } });
	}
	function task(sessionID = 'ses_1', callID = 'task', child = 'ses_child', state = 'completed', background = true): void {
		part(sessionID, 'assistant', `prt_${callID}`, {
			type: 'tool', tool: 'task', callID,
			state: { status: state, input: { prompt: 'Investigate', subagent_type: 'explore' }, metadata: { sessionId: child, background }, output: 'Background launch receipt' },
		});
	}
	function actions(type: ActionType) {
		return signals.filter(signal => signal.kind === 'action' && signal.action.type === type);
	}
	function pending(id: string): PendingMessage {
		return { id, message: { text: id, origin: { kind: MessageKind.User } } };
	}
	async function flush(): Promise<void> {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	async function start(target = chat, turnId = 'turn-1'): Promise<{ done: Promise<void>; prompt: typeof prompts[number] }> {
		const done = agent.chats.sendMessage(target, 'Go', [cwd], undefined, turnId);
		await flush();
		const prompt = prompts[prompts.length - 1];
		assert.ok(prompt);
		message(prompt.sessionID, turnId === 'turn-1' ? 'assistant' : `assistant:${turnId}`, 'assistant', prompt.messageID);
		return { done, prompt };
	}

	setup(async () => {
		events = store.add(new Emitter<IOpencodeEvent>());
		close = store.add(new Emitter<string>());
		signals = [];
		requests = [];
		prompts = [];
		sessions = 0;
		sessionCreation = undefined;
		const server: IOpencodeServer = {
			cwd: cwd.fsPath, baseUrl: 'http://fake-opencode', onDidReceiveEvent: events.event, onDidClose: close.event,
			dispose() { },
			async request<T>(_method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
				requests.push({ path, body });
				if (path === '/config/providers') {
					return { providers: [] } as T;
				}
				if (path === '/session') {
					if (sessionCreation) {
						return await sessionCreation.p as T;
					}
					return { id: `ses_${++sessions}` } as T;
				}
				if (path.endsWith('/message')) {
					const sessionID = path.split('/')[2];
					const input = body as { messageID: string; parts: Record<string, unknown>[] };
					const result = new DeferredPromise<unknown>();
					prompts.push({ sessionID, messageID: input.messageID, result });
					message(sessionID, input.messageID, 'user');
					for (const [index, value] of input.parts.entries()) {
						part(sessionID, input.messageID, `${input.messageID}:${index}`, value);
					}
					return await result.p as T;
				}
				return undefined as T;
			},
		};
		const service: IOpencodeServerService = { _serviceBrand: undefined, acquire: async () => server, close: async () => { } };
		agent = store.add(new OpencodeAgent(service, new NullLogService(), {} as IProductService));
		store.add(agent.onDidChatProgress(signal => signals.push(signal)));
		await agent.chats.createChat(chat, chat, { workingDirectories: [cwd] });
	});

	test('steers without waiting for send or aborting; acknowledges only correlated model activity and leaves FIFO alone', async () => {
		const { done, prompt } = await start();
		agent.setPendingMessages(chat, pending('steer'), [pending('queued-1'), pending('queued-2')]);
		agent.setPendingMessages(chat, pending('steer'), []);
		assert.strictEqual(prompts.length, 2, 'steering POST is not behind the original response');
		assert.ok(!requests.some(request => request.path.endsWith('/abort')));
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'steering_consumed'), []);
		await prompts[1].result.complete({});
		await flush();
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'steering_consumed'), [], 'HTTP acceptance is not consumption');
		part('ses_1', 'assistant', 'old-step', { type: 'step-start' });
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'steering_consumed'), [], 'old model call did not see steering');
		message('ses_1', 'steered-assistant', 'assistant', prompts[1].messageID);
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'steering_consumed'), [], 'assistant allocation precedes the model call');
		part('ses_1', 'steered-assistant', 'new-step', { type: 'step-start' });
		part('ses_1', 'steered-assistant', 'new-step', { type: 'step-start' });
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'steering_consumed'), [{ kind: 'steering_consumed', chat, id: 'steer' }]);
		assert.strictEqual(actions(ActionType.ChatTurnStarted).length, 1);
		status('ses_1', 'idle');
		await prompt.result.complete({});
		await done;
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 1);
	});

	test('background receipt preserves child tools, output and permissions while parent is idle and in its next turn', async () => {
		const first = await start();
		task();
		part('ses_child', 'child-a', 'read', { type: 'tool', tool: 'read', callID: 'child-read', state: { status: 'running', input: {} } });
		await first.prompt.result.complete({});
		await first.done;
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 0);
		assert.strictEqual(await agent.chats.canReleaseChat!(chat, chat), false, 'automatic idle release must not cancel background work');
		assert.ok(!actions(ActionType.ChatToolCallComplete).some(signal => signal.kind === 'action' && signal.parentToolCallId));
		part('ses_child', 'child-a', 'child-text', { type: 'text', text: 'Still working' });
		events.fire({ type: 'permission.asked', properties: { id: 'per_idle', sessionID: 'ses_child', permission: 'write', patterns: ['/workspace/a'], tool: { messageID: 'child-a', callID: 'write-idle' } } });
		const ask = signals.find(signal => signal.kind === 'pending_confirmation');
		assert.ok(ask?.kind === 'pending_confirmation');
		assert.strictEqual(ask.parentToolCallId, 'task');
		agent.respondToPermissionRequest('write-idle', true);
		await flush();
		assert.deepStrictEqual(requests.find(request => request.path.endsWith('/permissions/per_idle'))?.body, { response: 'once' });
		const second = await start(chat, 'turn-2');
		part('ses_child', 'child-a', 'child-text', { type: 'text', text: 'Still working, now done' });
		assert.ok(actions(ActionType.ChatDelta).every(signal => signal.kind === 'action' && signal.parentToolCallId === 'task'));
		status('ses_child', 'idle');
		status('ses_child', 'idle');
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 0);
		part('ses_child', 'child-a', 'late-child-text', { type: 'text', text: 'Final output after runner idle' });
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 1);
		await second.prompt.result.complete({});
		await second.done;
	});

	test('follow-up before the original HTTP response stays in its active host turn until native idle', async () => {
		const first = await start();
		task();
		status('ses_1', 'idle');
		status('ses_child', 'idle');
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notification-text', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">\n<task_result>OK</task_result>\n</task>' });
		assert.strictEqual(actions(ActionType.ChatTurnStarted).length, 1, 'a stored notification alone is not model activity');
		message('ses_1', 'follow-up', 'assistant', 'notification');
		message('ses_1', 'follow-up', 'assistant', 'notification');
		part('ses_1', 'follow-up', 'follow-up-text', { type: 'text', text: 'The child found it.' });
		await first.prompt.result.complete({});
		await first.done;
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 0);
		const starts = actions(ActionType.ChatTurnStarted);
		assert.strictEqual(starts.length, 1);
		status('ses_1', 'idle');
		status('ses_1', 'idle');
		message('ses_1', 'follow-up', 'assistant', 'notification');
		assert.strictEqual(actions(ActionType.ChatTurnStarted).length, 1);
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 1);
	});

	test('native follow-up during an active parent stays in that AHP turn', async () => {
		const first = await start();
		task();
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="error">Failed</task>' });
		message('ses_1', 'follow-up', 'assistant', 'notification');
		part('ses_1', 'follow-up', 'answer', { type: 'text', text: 'Child failed' });
		assert.strictEqual(actions(ActionType.ChatTurnStarted).length, 1);
		const delta = actions(ActionType.ChatDelta)[0];
		assert.ok(delta.kind === 'action' && delta.action.type === ActionType.ChatDelta);
		assert.strictEqual(delta.action.turnId, 'turn-1');
		await first.prompt.result.complete({});
		await first.done;
	});

	test('idle before HTTP retains fallback output and usage once, before the originating turn completes', async () => {
		const first = await start();
		const info = { sessionID: 'ses_1', id: 'final-assistant', role: 'assistant', parentID: first.prompt.messageID, time: { completed: 1 }, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } };
		status('ses_1', 'idle');
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 0);
		await first.prompt.result.complete({ info, parts: [{ sessionID: 'ses_1', messageID: info.id, id: 'fallback', type: 'text', text: 'HTTP fallback' }] });
		await first.done;
		assert.strictEqual(actions(ActionType.ChatUsage).length, 1);
		assert.strictEqual(actions(ActionType.ChatDelta).length, 1);
		assert.ok(signals.indexOf(actions(ActionType.ChatUsage)[0]) < signals.indexOf(actions(ActionType.ChatTurnComplete)[0]));
		assert.ok(signals.indexOf(actions(ActionType.ChatDelta)[0]) < signals.indexOf(actions(ActionType.ChatTurnComplete)[0]));
		const second = await start(chat, 'turn-2');
		events.fire({ type: 'message.updated', properties: { info } });
		part('ses_1', info.id, 'fallback', { type: 'text', text: 'HTTP fallback' });
		assert.strictEqual(actions(ActionType.ChatUsage).length, 1);
		assert.strictEqual(actions(ActionType.ChatDelta).length, 1);
		await second.prompt.result.complete({});
		await second.done;
	});

	test('a reserved normal send absorbs spontaneous follow-up without opening a competing host turn', async () => {
		const first = await start();
		task();
		await first.prompt.result.complete({});
		await first.done;
		const done = agent.chats.sendMessage(chat, 'Next', [cwd], undefined, 'turn-2');
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		message('ses_1', 'native-followup', 'assistant', 'notification');
		part('ses_1', 'native-followup', 'followup-text', { type: 'text', text: 'Native result' });
		await flush();
		assert.strictEqual(actions(ActionType.ChatTurnStarted).length, 2);
		const delta = actions(ActionType.ChatDelta)[0];
		assert.ok(delta.kind === 'action' && delta.action.type === ActionType.ChatDelta && delta.action.turnId === 'turn-2');
		await prompts[1].result.complete({});
		await done;
	});

	test('root SSE errors share the HTTP completion barrier rather than ending the host turn early', async () => {
		const first = await start();
		events.fire({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'Error', data: { message: 'Native failure' } } } });
		status('ses_1', 'idle');
		assert.strictEqual(actions(ActionType.ChatError).length, 0);
		await first.prompt.result.complete({});
		await first.done;
		assert.strictEqual(actions(ActionType.ChatError).length, 1);
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 1);
	});

	test('a follow-up after HTTP completion opens one system turn', async () => {
		const first = await start();
		task();
		await first.prompt.result.complete({});
		await first.done;
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		message('ses_1', 'follow-up', 'assistant', 'notification');
		message('ses_1', 'follow-up', 'assistant', 'notification');
		const starts = actions(ActionType.ChatTurnStarted);
		assert.strictEqual(starts.length, 2);
		assert.ok(starts[1].kind === 'action' && starts[1].action.type === ActionType.ChatTurnStarted && starts[1].action.message.origin.kind === MessageKind.SystemNotification);
		status('ses_1', 'idle');
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 2);
	});

	test('only a native synthetic user result from the direct parent can complete a background child', async () => {
		const first = await start();
		task();
		task('ses_child', 'nested-task', 'ses_nested');
		const text = '<task id="ses_nested" state="completed">Done</task>';
		part('ses_1', 'assistant', 'assistant-fake', { type: 'text', synthetic: true, text });
		part('ses_1', first.prompt.messageID, 'submitted-fake', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		message('ses_1', 'user-quote', 'user');
		part('ses_1', 'user-quote', 'ordinary-quote', { type: 'text', text: '<task id="ses_child" state="completed">Done</task>' });
		part('ses_1', 'user-quote', 'wrong-parent', { type: 'text', synthetic: true, text });
		part('ses_child', 'unknown-message', 'unknown-notice', { type: 'text', synthetic: true, text });
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 0);
		message('ses_child', 'native-notice', 'user');
		part('ses_child', 'native-notice', 'real-notice', { type: 'text', synthetic: true, text });
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'subagent_completed'), [{ kind: 'subagent_completed', chat, toolCallId: 'nested-task' }]);
		await first.prompt.result.complete({});
		await first.done;
	});

	test('late completed child frames cannot reopen it; a new task resumes only new messages', async () => {
		const first = await start();
		task();
		part('ses_child', 'old-child-message', 'old-child-text', { type: 'text', text: 'Old' });
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		const count = signals.length;
		status('ses_child', 'busy');
		part('ses_child', 'old-child-message', 'old-child-text', { type: 'text', text: 'Old late' });
		assert.strictEqual(signals.length, count);
		task('ses_1', 'resume', 'ses_child', 'running');
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_resumed').length, 1);
		const resumedCount = signals.length;
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		part('ses_child', 'old-child-message', 'old-child-text', { type: 'text', text: 'Old even later' });
		events.fire({ type: 'message.part.delta', properties: { sessionID: 'ses_child', partID: 'old-child-text', field: 'text', delta: 'late delta' } });
		assert.strictEqual(signals.length, resumedCount);
		part('ses_child', 'new-child-message', 'new-child-text', { type: 'text', text: 'New' });
		assert.ok(signals.length > resumedCount);
		await first.prompt.result.complete({});
		await first.done;
	});

	test('cancel with idle parent aborts native descendants, denies permissions and suppresses late activity', async () => {
		const first = await start();
		task();
		await first.prompt.result.complete({});
		await first.done;
		events.fire({ type: 'permission.v2.asked', properties: { id: 'per_cancel', sessionID: 'ses_child', action: 'write', source: { type: 'tool', messageID: 'child', callID: 'write-cancel' } } });
		await agent.chats.abort(chat, chat);
		await flush();
		assert.ok(requests.some(request => request.path === '/session/ses_1/abort'));
		assert.deepStrictEqual(requests.find(request => request.path.endsWith('/permission/per_cancel/reply'))?.body, { reply: 'reject' });
		const count = signals.length;
		status('ses_child', 'busy');
		part('ses_child', 'child', 'late', { type: 'text', text: 'late' });
		assert.strictEqual(signals.length, count);
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 1);
	});

	test('release bypasses the pending send response and drops subscriptions without closing the shared server', async () => {
		const first = await start();
		task();
		await agent.chats.releaseChat(chat, chat);
		assert.ok(requests.some(request => request.path === '/session/ses_1/abort'));
		assert.strictEqual(actions(ActionType.ChatTurnCancelled).length, 1);
		const count = signals.length;
		part('ses_child', 'child', 'late', { type: 'text', text: 'late' });
		await first.prompt.result.complete({});
		await first.done;
		assert.strictEqual(signals.length, count);
	});

	test('stop suppresses root output and notifications before the pending HTTP response settles', async () => {
		const first = await start();
		task();
		await agent.chats.abort(chat, chat);
		const count = signals.length;
		part('ses_1', 'assistant', 'late-root', { type: 'text', text: 'Late root output' });
		message('ses_1', 'notification', 'user');
		part('ses_1', 'notification', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_child" state="completed">Done</task>' });
		message('ses_1', 'late-followup', 'assistant', 'notification');
		assert.strictEqual(signals.length, count);
		await first.prompt.result.complete({ parts: [{ sessionID: 'ses_1', messageID: 'assistant', id: 'late-http', type: 'text', text: 'Late HTTP output' }] });
		await first.done;
		assert.strictEqual(actions(ActionType.ChatTurnCancelled).length, 1);
		assert.strictEqual(actions(ActionType.ChatDelta).length, 0);
	});

	test('release while native session creation is pending prevents late materialization', async () => {
		sessionCreation = new DeferredPromise<{ id: string }>();
		let materialized = 0;
		store.add(agent.onDidMaterializeChat(() => materialized++));
		const done = agent.chats.sendMessage(chat, 'Go', [cwd], undefined, 'turn-1');
		const rejected = assert.rejects(done, /released while creating a session/);
		await flush();
		await agent.chats.releaseChat(chat, chat);
		await sessionCreation.complete({ id: 'ses_late' });
		await rejected;
		assert.strictEqual(materialized, 0);
		assert.strictEqual(prompts.length, 0);
	});

	test('nested background results complete the nested child without ending its parent', async () => {
		const first = await start();
		task();
		task('ses_child', 'nested-task', 'ses_nested');
		status('ses_nested', 'idle');
		message('ses_child', 'nested-notice', 'user');
		part('ses_child', 'nested-notice', 'notice', { type: 'text', synthetic: true, text: '<task id="ses_nested" state="completed">Done</task>' });
		assert.deepStrictEqual(signals.filter(signal => signal.kind === 'subagent_completed'), [{ kind: 'subagent_completed', chat, toolCallId: 'nested-task' }]);
		await first.prompt.result.complete({});
		await first.done;
	});

	test('one shared stream routes each child permission and output only to its owning chat', async () => {
		const first = await start();
		task();
		const other = URI.parse('ahp-chat:/other');
		await agent.chats.createChat(other, other, { workingDirectories: [cwd] });
		const second = await start(other, 'other-turn');
		part('ses_child', 'child', 'text', { type: 'text', text: 'Only first' });
		events.fire({ type: 'permission.asked', properties: { id: 'per_shared', sessionID: 'ses_child', permission: 'read', tool: { messageID: 'child', callID: 'read-shared' } } });
		const asks = signals.filter(signal => signal.kind === 'pending_confirmation');
		assert.strictEqual(asks.length, 1);
		assert.strictEqual(asks[0].chat.toString(), chat.toString());
		agent.respondToPermissionRequest('read-shared', true);
		await flush();
		assert.strictEqual(requests.filter(request => request.path.endsWith('/permissions/per_shared')).length, 1);
		await first.prompt.result.complete({});
		await second.prompt.result.complete({});
		await Promise.all([first.done, second.done]);
	});

	test('server failure completes idle children and fails an active parent once', async () => {
		const first = await start();
		task();
		close.fire('server stopped');
		await first.prompt.result.error(new Error('connection closed'));
		await assert.rejects(first.done, /connection closed/);
		assert.strictEqual(signals.filter(signal => signal.kind === 'subagent_completed').length, 1);
		assert.strictEqual(actions(ActionType.ChatError).length, 1);
		assert.strictEqual(actions(ActionType.ChatTurnComplete).length, 1);
	});
});
