/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Query, SDKControlInterruptResponse, SDKMessage, SDKUserMessage, WarmQuery } from '@anthropic-ai/claude-agent-sdk';

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IDiffComputeService } from '../../common/diffComputeService.js';
import { ISessionDatabase } from '../../common/sessionDataService.js';
import { AgentSignal } from '../../common/agent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, MessageKind } from '../../common/state/sessionState.js';
import { ClaudeSdkPipeline, IRematerializer } from '../../node/claude/claudeSdkPipeline.js';
import { SubagentRegistry } from '../../node/claude/claudeSubagentRegistry.js';
import {
	makeAssistantMessage,
	makeContentBlockStartText,
	makeContentBlockStartToolUse,
	makeContentBlockStop,
	makeMessageStart,
	makeResultError,
	makeResultSuccess,
	makeStreamEvent,
	makeTextDelta,
	makeUserToolResultMessage,
} from './claudeMapSessionEventsTestUtils.js';
import { createZeroDiffComputeService, TestSessionDatabase } from '../common/sessionTestHelpers.js';

// ===== Test doubles =====

/**
 * `WarmQuery` stub that records `query()` calls and async-dispose count.
 * Tests in this file deliberately do NOT drive the consumer loop — they
 * exercise the synchronous lifecycle surface (abort, dispose, rebind
 * gating). Driving the SDK message stream end-to-end is covered by
 * `claudeAgent.test.ts`.
 *
 * `query()` returns a stub `Query` whose async iterator immediately
 * resolves done. That keeps the pipeline's consumer loop from hanging
 * even when a test happens to call `send()`.
 */
class FakeWarmQuery implements WarmQuery {
	asyncDisposeCount = 0;
	closeCount = 0;
	queryCallCount = 0;

	query(_prompt: string | AsyncIterable<SDKUserMessage>): Query {
		this.queryCallCount++;
		return new ImmediatelyDoneQuery();
	}
	close(): void { this.closeCount++; }
	async [Symbol.asyncDispose](): Promise<void> { this.asyncDisposeCount++; }
}

class ImmediatelyDoneQuery implements Query {
	[Symbol.asyncIterator](): this { return this; }
	async next(): Promise<IteratorResult<never, void>> { return { done: true, value: undefined }; }
	async return(): Promise<IteratorResult<never, void>> { return { done: true, value: undefined }; }
	async throw(err: unknown): Promise<IteratorResult<never, void>> { throw err; }
	async setModel(): Promise<void> { /* not exercised here */ }
	async applyFlagSettings(_settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void> { /* not exercised here */ }
	async setPermissionMode(): Promise<void> { /* not exercised here */ }
	async setMcpPermissionModeOverride(): Promise<{ warning?: string }> { return {}; }
	async interrupt(): Promise<SDKControlInterruptResponse | undefined> { return undefined; }
	streamInput(): never { throw new Error('not modeled'); }
	stopTask(): never { throw new Error('not modeled'); }
	reloadSkills(): never { throw new Error('not modeled'); }
	backgroundTasks(): never { throw new Error('not modeled'); }
	async close(): Promise<void> { /* not exercised here */ }
	async [Symbol.asyncDispose](): Promise<void> { /* not exercised here */ }
	setMaxThinkingTokens(): never { throw new Error('not modeled'); }
	initializationResult(): never { throw new Error('not modeled'); }
	reinitialize(): never { throw new Error('not modeled'); }
	updateSettings(): never { throw new Error('not modeled'); }
	supportedCommands(): never { throw new Error('not modeled'); }
	supportedModels(): never { throw new Error('not modeled'); }
	supportedAgents(): never { throw new Error('not modeled'); }
	mcpServerStatus(): never { throw new Error('not modeled'); }
	getContextUsage(): never { throw new Error('not modeled'); }
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): never { throw new Error('not modeled'); }
	reloadPlugins(): never { throw new Error('not modeled'); }
	accountInfo(): never { throw new Error('not modeled'); }
	rewindFiles(): never { throw new Error('not modeled'); }
	readFile(): never { throw new Error('not modeled'); }
	seedReadState(): never { throw new Error('not modeled'); }
	reconnectMcpServer(): never { throw new Error('not modeled'); }
	toggleMcpServer(): never { throw new Error('not modeled'); }
	setMcpServers(): never { throw new Error('not modeled'); }
	setSlashCommandHooks(): never { throw new Error('not modeled'); }
	getServerInfo(): never { throw new Error('not modeled'); }
	getMcpResources(): never { throw new Error('not modeled'); }
	readMcpResource(): never { throw new Error('not modeled'); }
}

/**
 * `WarmQuery` whose bound `Query` records every `applyFlagSettings` call so
 * tests can assert the exact effort payload pushed to the SDK (including the
 * `{ effortLevel: null }` clear emitted when switching to a model that does
 * not support reasoning effort).
 *
 * Unlike {@link ImmediatelyDoneQuery}, its async iterator BLOCKS rather than
 * ending immediately — otherwise the consumer loop would hit "stream ended
 * without a result", null out `_query`, and the runtime setters would no-op
 * before the test can observe them. A blocking iterator models a live turn.
 *
 * The block is abort-aware: `next()` resolves `{ done: true }` once the
 * pipeline's {@link AbortController} fires (on dispose/teardown), so the
 * consumer loop and the fire-and-forget `send()` promise unwind instead of
 * pinning the pipeline/query graph for the rest of the run.
 */
class RecordingQuery extends ImmediatelyDoneQuery {
	constructor(
		private readonly _flagSettings: Array<Parameters<Query['applyFlagSettings']>[0]>,
		private readonly _signal: AbortSignal,
	) { super(); }
	override next(): Promise<IteratorResult<never, void>> {
		if (this._signal.aborted) {
			return Promise.resolve({ done: true, value: undefined });
		}
		return new Promise<IteratorResult<never, void>>(resolve => {
			this._signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
		});
	}
	override async applyFlagSettings(settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void> { this._flagSettings.push(settings); }
}

class RecordingWarmQuery extends FakeWarmQuery {
	readonly flagSettings: Array<Parameters<Query['applyFlagSettings']>[0]> = [];

	constructor(private readonly _signal: AbortSignal) { super(); }

	override query(_prompt: string | AsyncIterable<SDKUserMessage>): Query {
		this.queryCallCount++;
		return new RecordingQuery(this.flagSettings, this._signal);
	}
}

/** A {@link Query}-shaped stub whose async stream the test ends on demand. */
type IControllableQuery = Query & {
	/** Ends the stream (models a dispose-driven close of the underlying query). */
	end(): void;
	/** Emits one SDK message from this query's output stream. */
	emit(message: SDKMessage): void;
	/** Pulls one prompt from the iterable bound to this query. */
	pullPrompt(): Promise<IteratorResult<SDKUserMessage, void>>;
	/** Resolves when the consumer closes this query's output iterator. */
	readonly returned: Promise<void>;
	/** How many times the consumer loop has pulled from this query's iterator. */
	readonly nextCallCount: number;
};

/**
 * Builds a {@link Query} whose async iterator blocks (modelling a live turn)
 * until {@link IControllableQuery.end}, and records how many times the consumer
 * loop pulled from it. Lets a test hold the consumer loop on one query while a
 * rebind swaps in the next, then observe whether the new query gets drained.
 */
function makeControllableQuery(prompt: string | AsyncIterable<SDKUserMessage>): IControllableQuery {
	let ended = false;
	let wake: (() => void) | undefined;
	const messages: SDKMessage[] = [];
	const promptIterator = typeof prompt === 'string' ? undefined : prompt[Symbol.asyncIterator]();
	const returned = new DeferredPromise<void>();
	const q = Object.assign(new ImmediatelyDoneQuery(), {
		nextCallCount: 0,
		returned: returned.p,
		end(): void { ended = true; wake?.(); wake = undefined; },
		emit(message: SDKMessage): void { messages.push(message); wake?.(); wake = undefined; },
		async pullPrompt(): Promise<IteratorResult<SDKUserMessage, void>> {
			if (!promptIterator) {
				return { done: true, value: undefined };
			}
			return promptIterator.next();
		},
		[Symbol.asyncIterator]() { return this; },
		async next(this: { nextCallCount: number }): Promise<IteratorResult<SDKMessage, void>> {
			this.nextCallCount++;
			while (messages.length === 0 && !ended) {
				await new Promise<void>(resolve => { wake = resolve; });
			}
			if (messages.length > 0) {
				return { done: false, value: messages.shift()! };
			}
			return { done: true, value: undefined };
		},
		async return() { returned.complete(); return { done: true, value: undefined }; },
		async throw(err: unknown) { throw err; },
	});
	return q as unknown as IControllableQuery;
}

/** {@link WarmQuery} that hands out {@link makeControllableQuery} instances and records them. */
class ControllableWarmQuery extends FakeWarmQuery {
	readonly queries: IControllableQuery[] = [];

	override query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
		this.queryCallCount++;
		const q = makeControllableQuery(prompt);
		this.queries.push(q);
		return q;
	}
}

// ===== Harness =====

interface IPipelineHarness {
	readonly pipeline: ClaudeSdkPipeline;
	readonly warm: FakeWarmQuery;
	readonly controller: AbortController;
	readonly subagents: SubagentRegistry;
}

function createPipeline(
	disposables: Pick<DisposableStore, 'add'>,
	warmOrFactory: FakeWarmQuery | ((signal: AbortSignal) => FakeWarmQuery) = new FakeWarmQuery(),
): IPipelineHarness {
	const controller = new AbortController();
	const warm = typeof warmOrFactory === 'function' ? warmOrFactory(controller.signal) : warmOrFactory;
	const fileService = disposables.add(new FileService(new NullLogService()));
	const fs = disposables.add(new InMemoryFileSystemProvider());
	disposables.add(fileService.registerProvider('file', fs));

	const db = new TestSessionDatabase();
	const dbRef: IReference<ISessionDatabase> = { object: db, dispose: () => { } };

	const services = new ServiceCollection(
		[ILogService, new NullLogService()],
		[IFileService, fileService],
		[IDiffComputeService, createZeroDiffComputeService()],
	);
	const inst: IInstantiationService = disposables.add(new InstantiationService(services));
	const subagents = disposables.add(new SubagentRegistry());
	const pipeline = disposables.add(inst.createInstance(
		ClaudeSdkPipeline,
		'sess-1',
		URI.parse(buildDefaultChatUri('claude:/sess-1')),
		URI.parse('claude:/sess-1'),
		warm,
		controller,
		dbRef,
		subagents,
		undefined,
	));
	return { pipeline, warm, controller, subagents };
}

function makePrompt(uuid: string, text: string = uuid): SDKUserMessage {
	return {
		type: 'user',
		uuid: makeUuid(uuid),
		parent_tool_use_id: null,
		message: { role: 'user', content: text },
	};
}

/** Build a SDK-shaped UUID from a short label so test ids stay readable. */
function makeUuid(label: string): `${string}-${string}-${string}-${string}-${string}` {
	const pad = (s: string, n: number) => s.padEnd(n, '0').slice(0, n);
	return `${pad(label, 8)}-0000-0000-0000-000000000000`;
}

/**
 * Let the pipeline's fire-and-forget `send()` run far enough to bind the
 * Query and finish its synchronous `_replayCurrentConfig` (a no-op when the
 * seeded config already matches). A generous number of microtask turns; the
 * stub Query never awaits real I/O, but a rebind now chains through the
 * outgoing subprocess's exit handshake before it even calls the
 * rematerializer, so the count has to cover that too.
 */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 25; i++) {
		await Promise.resolve();
	}
}

suite('ClaudeSdkPipeline', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	suite('reloadPlugins', () => {

		test('forwards to the SDK Query', async () => {
			let reloadCallCount = 0;
			class WarmWithReload extends FakeWarmQuery {
				override query(_prompt: string | AsyncIterable<SDKUserMessage>): Query {
					this.queryCallCount++;
					const q = new ImmediatelyDoneQuery();
					(q as unknown as { reloadPlugins: () => Promise<{ commands: { name: string }[] }> }).reloadPlugins =
						async () => { reloadCallCount++; return { commands: [] }; };
					return q;
				}
			}
			const controller = new AbortController();
			const warm = new WarmWithReload();
			const fileService = disposables.add(new FileService(new NullLogService()));
			const fs = disposables.add(new InMemoryFileSystemProvider());
			disposables.add(fileService.registerProvider('file', fs));
			const db = new TestSessionDatabase();
			const dbRef: IReference<ISessionDatabase> = { object: db, dispose: () => { } };
			const services = new ServiceCollection(
				[ILogService, new NullLogService()],
				[IFileService, fileService],
				[IDiffComputeService, createZeroDiffComputeService()],
			);
			const inst: IInstantiationService = disposables.add(new InstantiationService(services));
			const subagents = disposables.add(new SubagentRegistry());
			const pipeline = disposables.add(inst.createInstance(
				ClaudeSdkPipeline,
				'sess-2',
				URI.parse(buildDefaultChatUri('claude:/sess-2')),
				URI.parse('claude:/sess-2'),
				warm,
				controller,
				dbRef,
				subagents,
				undefined,
			));
			// Bind the query by issuing a send (iterator closes immediately).
			pipeline.send(makePrompt('p1'), 'turn-A').catch(() => { /* expected */ });
			await Promise.resolve();

			await pipeline.reloadPlugins();
			assert.strictEqual(reloadCallCount, 1);
		});
	});

	suite('generateSessionTitle', () => {

		test('uses the SDK control plane and leaves the transcript alone (persist: false)', async () => {
			const calls: Array<{ description: string; persist: boolean | undefined }> = [];
			class WarmWithTitleGeneration extends FakeWarmQuery {
				override query(_prompt: string | AsyncIterable<SDKUserMessage>): Query {
					this.queryCallCount++;
					const query = new ImmediatelyDoneQuery();
					(query as unknown as { generateSessionTitle: (description: string, options?: { persist?: boolean }) => Promise<string> }).generateSessionTitle = async (description, options) => {
						calls.push({ description, persist: options?.persist });
						return '  Backend title  ';
					};
					return query;
				}
			}
			const { pipeline } = createPipeline(disposables, new WarmWithTitleGeneration());

			assert.strictEqual(await pipeline.generateSessionTitle('Explain the sync bug'), 'Backend title');
			assert.deepStrictEqual(calls, [{ description: 'Explain the sync bug', persist: false }]);
		});

		test('falls back cleanly when the installed SDK lacks the method', async () => {
			const { pipeline } = createPipeline(disposables);
			assert.strictEqual(await pipeline.generateSessionTitle('Legacy SDK'), undefined);
		});
	});

	suite('initial state', () => {

		test('isResumed starts false and isAborted starts false', () => {
			const { pipeline } = createPipeline(disposables);
			assert.strictEqual(pipeline.isResumed, false);
			assert.strictEqual(pipeline.isAborted, false);
		});
	});

	suite('hasOpenBackgroundSubagents', () => {
		async function startDrainedPipeline() {
			const warm = new ControllableWarmQuery();
			const harness = createPipeline(disposables, warm);
			const sent = harness.pipeline.send(makePrompt('level-test'), 'turn-level');
			await flushMicrotasks();
			const query = warm.queries[0];
			disposables.add(toDisposable(() => query.end()));
			await query.pullPrompt();
			query.emit(makeResultSuccess('sess-1'));
			await sent;
			return { ...harness, query };
		}

		function level(tasks: { task_id: string; ambient?: boolean }[]): SDKMessage {
			return {
				type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', uuid: makeUuid('level'),
				tasks: tasks.map(task => ({ ...task, task_type: 'agent', description: 'Background work' })),
			};
		}

		test('an empty SDK level releases a stale spawn whose completion bookend was lost', async () => {
			const { pipeline, subagents, query } = await startDrainedPipeline();
			subagents.recordSpawn('toolu_missing_completion').background = true;
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, true, 'no level yet: use the registry');
			query.emit(level([]));
			await flushMicrotasks();
			assert.strictEqual(subagents.hasOpenBackgroundSpawns(), true, 'the level does not correlate task ids with tool ids');
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, false, 'explicit empty membership supersedes stale bookends');
		});

		test('SDK level wins when it precedes task bookends, including late starts after an empty level', async () => {
			const { pipeline, subagents, query } = await startDrainedPipeline();
			query.emit(level([{ task_id: 'task-independent-of-tool-id' }]));
			await flushMicrotasks();
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, true, 'a level needs no preceding spawn');
			assert.strictEqual(pipeline.hasActiveTurn, false, 'background level does not create a foreground turn');
			query.emit(level([]));
			await flushMicrotasks();
			subagents.recordSpawn('toolu_late_start').background = true;
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, false, 'a late edge cannot override the full level');
		});

		test('ambient-only SDK levels do not keep the process alive and ambient changes replace the level', async () => {
			const { pipeline, query } = await startDrainedPipeline();
			for (const [tasks, expected] of [
				[[{ task_id: 'watcher', ambient: true }], false],
				[[{ task_id: 'watcher', ambient: true }, { task_id: 'work' }], true],
				[[{ task_id: 'watcher', ambient: true }, { task_id: 'work', ambient: true }], false],
			] as const) {
				query.emit(level([...tasks]));
				await flushMicrotasks();
				assert.strictEqual(pipeline.hasOpenBackgroundSubagents, expected);
			}
		});

		test('background SDK level resets on rebind, process exit and abort', async () => {
			const { pipeline, subagents, query } = await startDrainedPipeline();
			query.emit(level([{ task_id: 'old-process-task' }]));
			await flushMicrotasks();
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, true);
			const nextWarm = new ControllableWarmQuery();
			pipeline.attachRematerializer(async () => ({ warm: nextWarm, abortController: new AbortController() }));
			await pipeline.rebindForRestart();
			query.end();
			await flushMicrotasks();
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, false, 'new process does not inherit the old level');
			subagents.recordSpawn('toolu_new_process').background = true;
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, true, 'new process can use bookends until its first level');
			const nextQuery = nextWarm.queries[0];
			nextQuery.emit(level([{ task_id: 'new-process-task' }]));
			await flushMicrotasks();
			nextQuery.end();
			await flushMicrotasks();
			assert.strictEqual(pipeline.hasOpenBackgroundSubagents, false, 'dead stream cannot retain its level or old bookends');

			const another = await startDrainedPipeline();
			another.query.emit(level([{ task_id: 'abort-task' }]));
			await flushMicrotasks();
			assert.strictEqual(another.pipeline.hasOpenBackgroundSubagents, true);
			another.pipeline.abort();
			assert.strictEqual(another.controller.signal.aborted, true, 'explicit stop still aborts the subprocess');
			assert.strictEqual(another.pipeline.hasOpenBackgroundSubagents, false, 'explicit abort clears the level');
		});

		test('reflects the session registry: false when idle or foreground-only, true while a background spawn is open, false again once it completes', () => {
			// The pipeline getter is the seam the release gates read; it must
			// track the same registry the message router writes to, without
			// disturbing `hasActiveTurn` (which stays about the prompt queue).
			const { pipeline, subagents } = createPipeline(disposables);
			const idle = { background: pipeline.hasOpenBackgroundSubagents, activeTurn: pipeline.hasActiveTurn };

			subagents.recordSpawn('toolu_fg');
			const foregroundOnly = { background: pipeline.hasOpenBackgroundSubagents, activeTurn: pipeline.hasActiveTurn };

			const bg = subagents.recordSpawn('toolu_bg');
			bg.background = true;
			const backgrounded = { background: pipeline.hasOpenBackgroundSubagents, activeTurn: pipeline.hasActiveTurn };

			bg.markCompleted();
			subagents.removeSpawn('toolu_bg');
			const completed = { background: pipeline.hasOpenBackgroundSubagents, activeTurn: pipeline.hasActiveTurn };

			assert.deepStrictEqual({ idle, foregroundOnly, backgrounded, completed }, {
				idle: { background: false, activeTurn: false },
				foregroundOnly: { background: false, activeTurn: false },
				// Background work is deliberately NOT reported as an active turn.
				backgrounded: { background: true, activeTurn: false },
				completed: { background: false, activeTurn: false },
			});
		});
	});

	suite('abort', () => {

		test('flips the controller signal and isAborted', () => {
			const { pipeline, controller } = createPipeline(disposables);
			pipeline.abort();
			assert.strictEqual(controller.signal.aborted, true);
			assert.strictEqual(pipeline.isAborted, true);
		});

		test('is idempotent', () => {
			const { pipeline, controller } = createPipeline(disposables);
			pipeline.abort();
			pipeline.abort();
			assert.strictEqual(controller.signal.aborted, true);
		});

		test('send after abort with no rematerializer attached throws a clear error (not a silent hang)', async () => {
			const { pipeline } = createPipeline(disposables);
			pipeline.abort();
			await pipeline.send(makePrompt('p1'), 'turn-A').then(
				() => assert.fail('expected rejection'),
				err => {
					// _rebindQuery throws synchronously when no rematerializer is attached
					assert.match(String(err), /no rematerializer attached/);
				},
			);
		});
	});

	suite('rematerializer wiring', () => {

		test('after abort, send invokes the attached rematerializer in "recover" mode and clears the rebind flag', async () => {
			const { pipeline } = createPipeline(disposables);
			const reasons: Array<'restart' | 'recover'> = [];
			const built: { warm: FakeWarmQuery; controller: AbortController }[] = [];
			const rematerializer: IRematerializer = async (reason) => {
				reasons.push(reason);
				const ctl = new AbortController();
				const warm = new FakeWarmQuery();
				built.push({ warm, controller: ctl });
				return { warm, abortController: ctl };
			};
			pipeline.attachRematerializer(rematerializer);

			pipeline.abort();
			// Don't await — the consumer loop on the rebound query will end
			// almost immediately, but the matching SDK `result` never
			// arrives (FakeWarmQuery's iterator just closes), so the
			// deferred ends up failed with the "stream ended without
			// result" guard. We only care that the rematerializer ran.
			pipeline.send(makePrompt('p1'), 'turn-A').catch(() => { /* expected */ });
			// Yield for the async rebind to await the outgoing subprocess's
			// exit and then call the callback.
			await flushMicrotasks();

			assert.deepStrictEqual(reasons, ['recover']);
			assert.strictEqual(built.length, 1);
			assert.strictEqual(pipeline.isAborted, false, 'rebind installed a fresh, non-aborted controller');
		});

		test('rematerializer rejection propagates from send', async () => {
			const { pipeline } = createPipeline(disposables);
			const rebuildErr = new Error('rematerialize failed');
			let calls = 0;
			pipeline.attachRematerializer(async () => {
				calls++;
				throw rebuildErr;
			});

			pipeline.abort();
			await pipeline.send(makePrompt('p1'), 'turn-A').then(
				() => assert.fail('expected rejection'),
				err => assert.strictEqual(err, rebuildErr),
			);
			assert.strictEqual(calls, 1);
		});

		test('a successful rebind completes the subagent spawns the replaced subprocess left open', async () => {
			// The orphaned-subagent fix. A subagent chat's turn is only ever
			// closed by a `subagent_completed` signal, and both routes that
			// raise one (the foreground `tool_result`, the background
			// `task_notification`) are emissions of the subprocess being
			// replaced. Without re-issuing them here the child chat keeps a
			// live turn and the session summary aggregates to `InProgress`
			// forever.
			const { pipeline, subagents } = createPipeline(disposables);
			pipeline.attachRematerializer(async () => ({ warm: new FakeWarmQuery(), abortController: new AbortController() }));

			subagents.recordSpawn('toolu_fg');
			const bg = subagents.recordSpawn('toolu_bg');
			bg.background = true;

			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			await pipeline.rebindForRestart();

			assert.deepStrictEqual({
				completed: signals
					.filter(s => s.kind === 'subagent_completed')
					.map(s => (s as { toolCallId: string }).toolCallId)
					.sort(),
				registryDrained: [subagents.getSpawn('toolu_fg'), subagents.getSpawn('toolu_bg')],
			}, {
				completed: ['toolu_bg', 'toolu_fg'],
				registryDrained: [undefined, undefined],
			});
		});

		test('a rebind with no open subagent spawns produces no completion signals', async () => {
			const { pipeline } = createPipeline(disposables);
			pipeline.attachRematerializer(async () => ({ warm: new FakeWarmQuery(), abortController: new AbortController() }));

			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			await pipeline.rebindForRestart();

			assert.deepStrictEqual(signals.filter(s => s.kind === 'subagent_completed'), []);
		});

		test('a failed rebind restores the live controller so abort and recovery still work', async () => {
			const { pipeline, controller } = createPipeline(disposables);
			let calls = 0;
			const freshController = new AbortController();
			pipeline.attachRematerializer(async () => {
				calls++;
				if (calls === 1) {
					throw new Error('rebuild failed');
				}
				return { warm: new FakeWarmQuery(), abortController: freshController };
			});

			await pipeline.rebindForRestart().then(
				() => assert.fail('expected rejection'),
				err => assert.strictEqual((err as Error).message, 'rebuild failed'),
			);

			// The old subprocess is still the live one: abort must reach ITS
			// controller, not the discarded placeholder.
			pipeline.abort();
			assert.strictEqual(controller.signal.aborted, true, 'abort reached the original subprocess controller');

			// The pipeline stays marked for recovery: the next send retries
			// the rebind and succeeds with the freshly built pair.
			pipeline.send(makePrompt('p2'), 'turn-2').catch(() => { /* unwound on teardown */ });
			await flushMicrotasks();
			assert.strictEqual(calls, 2, 'send retried the rebind');
			assert.strictEqual(pipeline.isAborted, false, 'recovered onto the fresh controller');
		});

		test('abort issued while the rematerializer is still resolving cancels the freshly-built controller (rebind-window race)', async () => {
			const { pipeline } = createPipeline(disposables);
			const releaseRebuild = new DeferredPromise<{ warm: FakeWarmQuery; controller: AbortController }>();
			const built: { warm: FakeWarmQuery; controller: AbortController }[] = [];
			pipeline.attachRematerializer(async () => {
				const pair = await releaseRebuild.p;
				built.push(pair);
				return { warm: pair.warm, abortController: pair.controller };
			});

			// Trigger rebind by aborting the seed controller and starting a send.
			// The send awaits _rebindQuery, which awaits releaseRebuild.
			pipeline.abort();
			const sendPromise = pipeline.send(makePrompt('p1'), 'turn-A');
			await Promise.resolve(); // let _rebindQuery start its await

			// Issue a SECOND abort while rebind is in-flight. This must
			// land on the not-yet-installed controller — abort returning
			// early as idempotent here would silently drop the user's
			// cancel.
			pipeline.abort();

			// Now release the rematerializer with a fresh, non-aborted controller.
			const freshController = new AbortController();
			releaseRebuild.complete({ warm: new FakeWarmQuery(), controller: freshController });

			await sendPromise.then(
				() => assert.fail('expected cancellation after rebind-window abort'),
				err => assert.ok(isCancellationError(err), `expected CancellationError, got ${err}`),
			);
			assert.strictEqual(built.length, 1);
			assert.strictEqual(built[0].controller.signal.aborted, true, 'fresh controller cancelled before being installed');
			assert.strictEqual(pipeline.isAborted, true);
		});

		test('a rebind hands the consumer loop off to the new query so the post-rebind turn is not lost', async () => {
			// Regression: a rebind swaps in a fresh `_query` while the consumer
			// loop is still draining the OLD one. The post-rebind `send` queues
			// its prompt while the old loop is still marked running, so
			// `_ensureConsumerLoop` no-ops. If the old loop then just stopped,
			// nothing would ever read the new query and `send` would hang
			// ("Restore Checkpoint then send" never responds).
			const warm1 = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm1);

			// Bind Q1 and start the consumer loop draining it. No result is
			// pushed, so this send never resolves — we only need the live loop.
			pipeline.send(makePrompt('p1'), 'turn-1').catch(() => { /* unwound on teardown */ });
			await flushMicrotasks();
			const q1 = warm1.queries[0];
			assert.ok(q1.nextCallCount > 0, 'consumer loop drains Q1');

			// Rebind to a fresh warm/Q2 while Q1's loop is still parked.
			const warm2 = new ControllableWarmQuery();
			pipeline.attachRematerializer(async () => ({ warm: warm2, abortController: new AbortController() }));
			await pipeline.rebindForRestart();
			const q2 = warm2.queries[0];
			assert.strictEqual(q2.nextCallCount, 0, 'new query not drained yet — the old loop is still running');

			// The old query's stream now ends (as a real dispose would). The
			// loop must hand off to Q2 rather than stopping.
			q1.end();
			await flushMicrotasks();

			assert.ok(q2.nextCallCount > 0, 'consumer loop handed off to the new query after the old one ended');

			// Clean teardown: let the re-armed loop unwind before dispose.
			q2.end();
			await flushMicrotasks();
		});

		test('a late result from the pre-rebind query cannot settle the post-rebind prompt', async () => {
			const warm1 = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm1);
			let producedSignalCount = 0;
			let secondTurnCompleteCount = 0;
			disposables.add(pipeline.onDidProduceSignal(signal => {
				producedSignalCount++;
				if (signal.kind === 'action' && signal.action.type === ActionType.ChatTurnComplete && signal.action.turnId === 'turn-2') {
					secondTurnCompleteCount++;
				}
			}));

			const firstSend = pipeline.send(makePrompt('p1'), 'turn-1');
			await flushMicrotasks();
			const q1 = warm1.queries[0];
			assert.strictEqual((await q1.pullPrompt()).value?.uuid, makeUuid('p1'));
			q1.emit(makeResultSuccess('sess-1'));
			await firstSend;
			const parkedOldPrompt = q1.pullPrompt();

			const warm2 = new ControllableWarmQuery();
			pipeline.attachRematerializer(async () => ({ warm: warm2, abortController: new AbortController() }));
			await pipeline.rebindForRestart();
			assert.strictEqual((await parkedOldPrompt).done, true, 'the old query prompt iterator is retired on rebind');
			const q2 = warm2.queries[0];

			let secondSendResolved = false;
			const secondSend = pipeline.send(makePrompt('p2'), 'turn-2').then(() => { secondSendResolved = true; });
			assert.strictEqual((await q2.pullPrompt()).value?.uuid, makeUuid('p2'));

			const signalCountBeforeLateResult = producedSignalCount;
			q1.emit(makeResultSuccess('sess-1'));
			await q1.returned;
			assert.strictEqual(secondSendResolved, false, 'the old query must not settle the new query\'s prompt');
			assert.strictEqual(producedSignalCount, signalCountBeforeLateResult, 'the old query must not route signals into the new turn');
			assert.strictEqual(secondTurnCompleteCount, 0, 'the old query must not complete the new turn');

			q1.end();
			await flushMicrotasks();
			q2.emit(makeResultSuccess('sess-1'));
			await secondSend;
			assert.strictEqual(secondTurnCompleteCount, 1, 'the new query completes its own turn exactly once');
			q2.end();
			await flushMicrotasks();
		});
	});

	suite('rebind exit ordering', () => {

		// Regression: `_rebindQuery` used to materialize the replacement FIRST
		// and dispose the outgoing warm query fire-and-forget afterwards. The
		// replacement resumes by loading this session's transcript back out of
		// the SessionStore, and the outgoing subprocess writes that
		// transcript's tail as it shuts down — so the resumed CLI came up on a
		// truncated, sometimes near-empty snapshot and the session lost its
		// memory of the conversation (a turn producing no output at all).

		test('the outgoing subprocess is fully torn down before the replacement is materialized', async () => {
			const order: string[] = [];
			const releaseExit = new DeferredPromise<void>();
			class SlowExitWarm extends FakeWarmQuery {
				override async [Symbol.asyncDispose](): Promise<void> {
					this.asyncDisposeCount++;
					order.push('warm.dispose');
					await releaseExit.p;
					order.push('process.exited');
				}
			}
			const { pipeline } = createPipeline(disposables, new SlowExitWarm());
			pipeline.attachRematerializer(async () => {
				order.push('rematerialize');
				return { warm: new FakeWarmQuery(), abortController: new AbortController() };
			});

			const rebind = pipeline.rebindForRestart();
			await flushMicrotasks();
			assert.deepStrictEqual(order, ['warm.dispose'], 'the replacement must not be built while the old subprocess is still exiting');

			releaseExit.complete();
			await rebind;
			assert.deepStrictEqual(order, ['warm.dispose', 'process.exited', 'rematerialize']);
		});

		test('the bound Query.return() — the step that actually awaits process exit — is awaited too', async () => {
			// `WarmQuery[Symbol.asyncDispose]()` only *fires* the SDK cleanup;
			// only `Query.return()` awaits it through to
			// `transport.waitForExit()`. Disposing without returning would
			// leave exactly the race this fix closes.
			const order: string[] = [];
			const releaseExit = new DeferredPromise<void>();
			class ExitTrackingWarm extends FakeWarmQuery {
				constructor(private readonly _signal: AbortSignal) { super(); }
				override async [Symbol.asyncDispose](): Promise<void> {
					this.asyncDisposeCount++;
					order.push('warm.dispose');
				}
				override query(_prompt: string | AsyncIterable<SDKUserMessage>): Query {
					this.queryCallCount++;
					const q = new RecordingQuery([], this._signal);
					q.return = async () => {
						order.push('query.return');
						await releaseExit.p;
						order.push('process.exited');
						return { done: true, value: undefined };
					};
					return q;
				}
			}
			const { pipeline } = createPipeline(disposables, signal => new ExitTrackingWarm(signal));
			// Bind a live query so the rebind has something to return().
			pipeline.send(makePrompt('p1'), 'turn-1').catch(() => { /* unwound on teardown */ });
			await flushMicrotasks();

			pipeline.attachRematerializer(async () => {
				order.push('rematerialize');
				return { warm: new FakeWarmQuery(), abortController: new AbortController() };
			});
			const rebind = pipeline.rebindForRestart();
			await flushMicrotasks();
			assert.deepStrictEqual(order, ['warm.dispose', 'query.return']);

			releaseExit.complete();
			await rebind;
			assert.deepStrictEqual(order, ['warm.dispose', 'query.return', 'process.exited', 'rematerialize']);
		});

		test('a subprocess that never exits cannot wedge the rebind forever', () => {
			// Bounded on purpose: resuming without the transcript tail costs
			// one turn, never rebinding costs the whole session.
			return runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 100 }, async () => {
				const order: string[] = [];
				class WedgedWarm extends FakeWarmQuery {
					override async [Symbol.asyncDispose](): Promise<void> {
						this.asyncDisposeCount++;
						order.push('warm.dispose');
						await new Promise<void>(() => { /* never exits */ });
					}
				}
				const { pipeline } = createPipeline(disposables, new WedgedWarm());
				pipeline.attachRematerializer(async () => {
					order.push('rematerialize');
					return { warm: new FakeWarmQuery(), abortController: new AbortController() };
				});

				await pipeline.rebindForRestart();
				assert.deepStrictEqual(order, ['warm.dispose', 'rematerialize'], 'the rebind proceeds once the exit wait times out');
			});
		});

		test('a teardown failure is logged, not fatal — the rebind still completes', async () => {
			class FailingDisposeWarm extends FakeWarmQuery {
				override async [Symbol.asyncDispose](): Promise<void> {
					this.asyncDisposeCount++;
					throw new Error('dispose blew up');
				}
			}
			const { pipeline } = createPipeline(disposables, new FailingDisposeWarm());
			let rematerialized = 0;
			pipeline.attachRematerializer(async () => {
				rematerialized++;
				return { warm: new FakeWarmQuery(), abortController: new AbortController() };
			});

			await pipeline.rebindForRestart();
			assert.strictEqual(rematerialized, 1);
		});
	});

	suite('seedCurrentConfig', () => {

		test('seeded values match the post-materialize SDK state, so first send does NOT push a redundant setModel/applyFlagSettings/setPermissionMode', async () => {
			// We can't observe the SDK calls without driving the consumer
			// loop, but we CAN observe that send does not throw and that
			// the warm query is bound exactly once.
			const { pipeline, warm } = createPipeline(disposables);
			pipeline.seedCurrentConfig('claude-sonnet-4-5', 'high', 'default');
			pipeline.send(makePrompt('p1'), 'turn-A').catch(() => { /* expected: stream ends without result */ });
			await Promise.resolve();
			assert.strictEqual(warm.queryCallCount, 1);
		});
	});

	suite('setEffort', () => {

		// Bind a live Query (send() lazily binds it) seeded as if the session
		// materialized on an effort-capable model. Returns the recorder so each
		// test asserts the exact applyFlagSettings payloads pushed afterwards.
		async function seededHighThenBind(disposables: Pick<DisposableStore, 'add'>): Promise<{ pipeline: ClaudeSdkPipeline; warm: RecordingWarmQuery }> {
			let warm!: RecordingWarmQuery;
			const { pipeline } = createPipeline(disposables, signal => (warm = new RecordingWarmQuery(signal)));
			pipeline.seedCurrentConfig('claude-opus-4-7', 'high', 'default');
			pipeline.send(makePrompt('p1'), 'turn-A').catch(() => { /* stream ends without result */ });
			await flushMicrotasks();
			assert.strictEqual(warm.queryCallCount, 1, 'query should be bound after send');
			warm.flagSettings.length = 0; // drop any replay from bind; isolate the switch
			return { pipeline, warm };
		}

		test('switching to a model with no effort clears the stale effort via applyFlagSettings({ effortLevel: null })', async () => {
			// Repro of the Haiku 400: a session materialized on Opus applies
			// effort 'high' at SDK startup; switching to Haiku must CLEAR it, not
			// leave 'high' to be replayed onto a model the API 400s on.
			const { pipeline, warm } = await seededHighThenBind(disposables);
			await pipeline.setEffort(undefined);
			assert.deepStrictEqual(warm.flagSettings, [{ effortLevel: null }]);
		});

		test('switching between two effort-capable levels pushes the new value', async () => {
			const { pipeline, warm } = await seededHighThenBind(disposables);
			await pipeline.setEffort('low');
			assert.deepStrictEqual(warm.flagSettings, [{ effortLevel: 'low' }]);
		});

		test('re-applying the already-applied effort is a no-op (no redundant SDK call)', async () => {
			const { pipeline, warm } = await seededHighThenBind(disposables);
			await pipeline.setEffort('high');
			assert.deepStrictEqual(warm.flagSettings, []);
		});

		test('clearing an already-clear effort is a no-op', async () => {
			let warm!: RecordingWarmQuery;
			const { pipeline } = createPipeline(disposables, signal => (warm = new RecordingWarmQuery(signal)));
			pipeline.seedCurrentConfig('claude-haiku-4-5', undefined, 'default');
			pipeline.send(makePrompt('p1'), 'turn-A').catch(() => { /* stream ends without result */ });
			await flushMicrotasks();
			warm.flagSettings.length = 0;
			await pipeline.setEffort(undefined);
			assert.deepStrictEqual(warm.flagSettings, []);
		});

		test('setEffort while awaiting rebind (post-abort) is buffered, not pushed to the dead query, then replayed on rebind', async () => {
			// After an abort the `_query` handle is intentionally retained (it is
			// what teardown awaits) but the stream is dead; `_needsRebind` is the
			// health signal. setEffort must NOT steer that dead query — it should
			// buffer the value and let `_replayCurrentConfig` push it onto the
			// freshly-bound query after the rebind.
			const { pipeline, warm } = await seededHighThenBind(disposables);
			pipeline.abort();
			warm.flagSettings.length = 0; // isolate: ignore anything from the dead query
			await pipeline.setEffort('low');
			assert.deepStrictEqual(warm.flagSettings, [], 'effort must not be pushed while needsRebind');

			let warm2!: RecordingWarmQuery;
			pipeline.attachRematerializer(async () => {
				const ctl = new AbortController();
				warm2 = new RecordingWarmQuery(ctl.signal);
				return { warm: warm2, abortController: ctl };
			});
			pipeline.send(makePrompt('p2'), 'turn-B').catch(() => { /* stream ends without result */ });
			await flushMicrotasks();
			assert.deepStrictEqual(warm2.flagSettings, [{ effortLevel: 'low' }], 'buffered effort replayed on the rebound query');
		});
	});

	suite('dispose', () => {

		test('disposing the pipeline aborts the controller and async-disposes the WarmQuery', async () => {
			const store = new DisposableStore();
			const { pipeline, warm, controller } = createPipeline(store);
			assert.strictEqual(controller.signal.aborted, false);
			assert.strictEqual(warm.asyncDisposeCount, 0);

			pipeline.dispose();
			// asyncDispose is fire-and-forget; let the microtask run.
			await Promise.resolve();

			assert.strictEqual(controller.signal.aborted, true);
			assert.strictEqual(warm.asyncDisposeCount, 1);
			store.dispose();
		});
	});

	suite('post-drain SDK output', () => {

		const SESSION_ID = 'sess-1';

		/**
		 * Let the consumer loop finish every message emitted so far. The router
		 * awaits file-edit observation per message, so a macrotask hop is needed
		 * rather than a fixed number of microtask turns.
		 */
		function drainStream(): Promise<void> {
			return new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		/** Run one ordinary turn to completion so the prompt queue is drained. */
		async function runFirstTurnToDrain(
			pipeline: ClaudeSdkPipeline,
			warm: ControllableWarmQuery,
			beforeResult?: (q: IControllableQuery) => void,
		): Promise<IControllableQuery> {
			const firstSend = pipeline.send(makePrompt('p1'), 'turn-1');
			await flushMicrotasks();
			const q = warm.queries[0];
			assert.strictEqual((await q.pullPrompt()).value?.uuid, makeUuid('p1'));
			beforeResult?.(q);
			await drainStream();
			q.emit(makeResultSuccess(SESSION_ID));
			await firstSend;
			await drainStream();
			return q;
		}

		function turnStartedActions(signals: readonly AgentSignal[]) {
			return signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnStarted);
		}

		test('a top-level SDK message after the queue drains opens one autonomous turn and renders its output', async () => {
			// E-NEW: the SDK continues on its own after a background task wakes
			// it. With the queue drained there is no queue entry to attribute the
			// output to, so without an autonomous turn the whole continuation —
			// final report included — never reaches the chat.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const q = await runFirstTurnToDrain(pipeline, warm);
			signals.length = 0;

			q.emit(makeStreamEvent(SESSION_ID, makeMessageStart('msg_auto')));
			q.emit(makeStreamEvent(SESSION_ID, makeContentBlockStartText(0)));
			q.emit(makeStreamEvent(SESSION_ID, makeTextDelta(0, 'final report')));
			await drainStream();

			const started = turnStartedActions(signals);
			assert.strictEqual(started.length, 1, 'exactly one autonomous turn opened');
			const startedAction = started[0].kind === 'action' && started[0].action.type === ActionType.ChatTurnStarted ? started[0].action : undefined;
			assert.ok(startedAction, 'ChatTurnStarted action');
			const autonomousTurnId = startedAction.turnId;
			assert.strictEqual(startedAction.message.origin.kind, MessageKind.SystemNotification);
			assert.notStrictEqual(autonomousTurnId, 'turn-1', 'the completed turn is not reopened');

			const delta = signals.find(s => s.kind === 'action' && s.action.type === ActionType.ChatDelta);
			assert.ok(delta && delta.kind === 'action' && delta.action.type === ActionType.ChatDelta, 'ChatDelta emitted');
			assert.strictEqual(delta.action.content, 'final report');
			assert.strictEqual(delta.action.turnId, autonomousTurnId, 'output lands on the autonomous turn');

			q.emit(makeResultSuccess(SESSION_ID));
			await drainStream();

			// The closing result must map like any other terminal result, not be
			// mistaken for a steering preemption — that path suppresses the
			// result's own signals, which would drop the turn's usage and hide a
			// failed continuation behind an empty, silently-closed turn.
			const usage = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatUsage && s.action.turnId === autonomousTurnId);
			assert.strictEqual(usage.length, 1, 'the autonomous turn reports its own usage');
			const completed = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnComplete && s.action.turnId === autonomousTurnId);
			assert.strictEqual(completed.length, 1, 'the autonomous turn is closed by its own result');
			assert.strictEqual(turnStartedActions(signals).length, 1, 'the closing result does not open another turn');
		});

		test('aborting while an autonomous turn is open cancels it instead of leaving it running forever', async () => {
			// The autonomous turn has no queue entry, so `failAll` cannot surface
			// the stop on it the way it does for a queued prompt.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const q = await runFirstTurnToDrain(pipeline, warm);
			signals.length = 0;
			q.emit(makeStreamEvent(SESSION_ID, makeMessageStart('msg_auto')));
			await drainStream();
			const started = turnStartedActions(signals);
			const autonomousTurnId = started[0]?.kind === 'action' && started[0].action.type === ActionType.ChatTurnStarted ? started[0].action.turnId : undefined;
			assert.ok(autonomousTurnId, 'autonomous turn opened');

			pipeline.abort();
			await drainStream();

			const cancelled = signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatTurnCancelled && s.action.turnId === autonomousTurnId);
			assert.strictEqual(cancelled.length, 1, 'the open autonomous turn is cancelled exactly once');

			q.end();
			await flushMicrotasks();
		});

		test('lifecycle-only SDK messages after the queue drains never open an autonomous turn', async () => {
			// Negative control for the rule above: the envelopes that trail a
			// settled turn (task lifecycle, status, compaction, a re-init after
			// rebind) carry no top-level model output and must not manufacture a
			// visible turn.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const q = await runFirstTurnToDrain(pipeline, warm);
			signals.length = 0;

			for (const message of [
				{ type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_task', description: 'still running', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } },
				{ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } },
				{ type: 'system', subtype: 'status', status: 'idle' },
				{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } },
			] as unknown as SDKMessage[]) {
				q.emit(message);
			}
			await drainStream();

			assert.deepStrictEqual(turnStartedActions(signals), [], 'no autonomous turn for trailing lifecycle messages');
		});

		test('an account rate-limit event is delivered after the queue drains without opening a turn', async () => {
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const rateLimits: unknown[] = [];
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidRateLimitInfo(info => rateLimits.push(info)));
			disposables.add(pipeline.onDidProduceSignal(signal => signals.push(signal)));

			const q = await runFirstTurnToDrain(pipeline, warm);
			signals.length = 0;
			q.emit({
				type: 'rate_limit_event',
				rate_limit_info: {
					status: 'allowed_warning',
					rateLimitType: 'five_hour',
					utilization: 72,
					resetsAt: 2_000_000_000,
				},
				uuid: makeUuid('limit'),
				session_id: SESSION_ID,
			} as SDKMessage);
			await drainStream();

			assert.deepStrictEqual(rateLimits, [{
				status: 'allowed_warning',
				rateLimitType: 'five_hour',
				utilization: 72,
				resetsAt: 2_000_000_000,
			}]);
			assert.deepStrictEqual(turnStartedActions(signals), [], 'account state does not manufacture a protocol turn');
		});

		test('a background subagent that finishes after the parent turn still completes, without a fake turn in the main chat', async () => {
			// E1: the `task_notification` that closes a background subagent, and
			// the subagent's own late output, arrive with the queue drained. Both
			// must reach the mapper; neither may open a turn in the main chat —
			// they belong to the subagent's own chat.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const PARENT = 'toolu_bg_task';
			const q = await runFirstTurnToDrain(pipeline, warm, inner => {
				inner.emit(makeAssistantMessage(SESSION_ID, [{
					type: 'tool_use',
					id: PARENT,
					name: 'Task',
					input: { description: 'Audit the diff', subagent_type: 'Explore', prompt: 'Audit…' },
				}]));
				inner.emit({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: PARENT, description: 'Audit the diff' } as unknown as SDKMessage);
			});
			signals.length = 0;

			const lateInner = makeAssistantMessage(SESSION_ID, [{ type: 'text', text: 'audit finding', citations: null }]);
			lateInner.parent_tool_use_id = PARENT;
			q.emit(lateInner);
			q.emit({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: PARENT, status: 'completed', output_file: 'o', summary: 'done' } as unknown as SDKMessage);
			await drainStream();

			const lateResponsePart = signals.find(s => s.kind === 'action' && s.action.type === ActionType.ChatResponsePart);
			assert.ok(lateResponsePart && lateResponsePart.kind === 'action', 'the subagent\'s late output reaches the mapper');
			assert.strictEqual(lateResponsePart.parentToolCallId, PARENT, 'tagged for the subagent chat');

			const completedSubagents = signals.filter(s => s.kind === 'subagent_completed').map(s => s.kind === 'subagent_completed' ? s.toolCallId : undefined);
			assert.deepStrictEqual(completedSubagents, [PARENT], 'task_notification fires subagent_completed');
			assert.deepStrictEqual(turnStartedActions(signals), [], 'subagent output does not open a turn in the main chat');
		});
	});

	suite('steering preemption', () => {

		const SESSION_ID = 'sess-1';

		function drainStream(): Promise<void> {
			return new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		test('a tool still running when steering preempts the turn keeps its cross-message state, so its result still maps and its subagent still closes', async () => {
			// E3: a steering preemption is not the end of the SDK session — the
			// tools the interrupted request had in flight report afterwards,
			// under the same ids. Dropping the mapper's cross-message state at
			// that boundary makes those results hit "unknown tool_use_id": the
			// tool call never completes and the Task's subagent chat is never
			// told to close.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const PARENT = 'toolu_task';
			const send = pipeline.send(makePrompt('p1'), 'turn-1');
			await flushMicrotasks();
			const q = warm.queries[0];
			assert.strictEqual((await q.pullPrompt()).value?.uuid, makeUuid('p1'));

			q.emit(makeStreamEvent(SESSION_ID, makeMessageStart('msg_1')));
			q.emit(makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')));
			q.emit(makeStreamEvent(SESSION_ID, makeContentBlockStop(0)));
			q.emit(makeAssistantMessage(SESSION_ID, [{
				type: 'tool_use', id: PARENT, name: 'Task',
				input: { description: 'Audit', subagent_type: 'Explore', prompt: 'Audit the diff' },
			}]));
			await drainStream();

			// The user steers while the Task is still running: the SDK ends the
			// interrupted request with an execution error and picks up the
			// steering prompt.
			pipeline.injectSteering(makePrompt('p2'), { id: 'steer-1', message: { text: 'actually, stop', origin: { kind: MessageKind.User } } });
			assert.strictEqual((await q.pullPrompt()).value?.uuid, makeUuid('p2'));
			q.emit(makeResultError(SESSION_ID, ['Request was aborted']));
			await drainStream();
			signals.length = 0;

			// The interrupted Task reports in the steering turn's stream.
			q.emit(makeUserToolResultMessage(SESSION_ID, PARENT, 'agentId: abc123\nInterrupted by user'));
			await drainStream();

			const complete = signals.find(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallComplete);
			assert.deepStrictEqual({
				completeToolCallId: complete?.kind === 'action' && complete.action.type === ActionType.ChatToolCallComplete ? complete.action.toolCallId : undefined,
				// Attribution is unchanged: the tool call belongs to the turn
				// that opened it, not to the steering turn that outlived it.
				completeTurnId: complete?.kind === 'action' && complete.action.type === ActionType.ChatToolCallComplete ? complete.action.turnId : undefined,
				completedSubagents: signals.filter(s => s.kind === 'subagent_completed').map(s => s.kind === 'subagent_completed' ? s.toolCallId : undefined),
			}, {
				completeToolCallId: PARENT,
				completeTurnId: 'turn-1',
				completedSubagents: [PARENT],
			});

			q.emit(makeResultSuccess(SESSION_ID));
			await send;
			q.end();
			await flushMicrotasks();
		});

		test('the terminal result still drains cross-message state, so nothing leaks past the end of the turn', async () => {
			// Negative control for the rule above: the drain is not removed, it
			// is moved back to the only boundary that owns it. A tool_use whose
			// tool_result never arrives must not survive into the next turn.
			const warm = new ControllableWarmQuery();
			const { pipeline } = createPipeline(disposables, warm);
			const signals: AgentSignal[] = [];
			disposables.add(pipeline.onDidProduceSignal(s => signals.push(s)));

			const ORPHAN = 'toolu_orphan';
			const send = pipeline.send(makePrompt('p1'), 'turn-1');
			await flushMicrotasks();
			const q = warm.queries[0];
			assert.strictEqual((await q.pullPrompt()).value?.uuid, makeUuid('p1'));

			q.emit(makeStreamEvent(SESSION_ID, makeMessageStart('msg_1')));
			q.emit(makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, ORPHAN, 'Read')));
			q.emit(makeStreamEvent(SESSION_ID, makeContentBlockStop(0)));
			q.emit(makeResultSuccess(SESSION_ID));
			await send;
			await drainStream();
			signals.length = 0;

			q.emit(makeUserToolResultMessage(SESSION_ID, ORPHAN, 'too late'));
			await drainStream();

			assert.deepStrictEqual(
				signals.filter(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallComplete),
				[],
				'a tool_use dropped by the previous turn does not complete in a later one',
			);

			q.end();
			await flushMicrotasks();
		});
	});

	suite('CancellationError plumbing', () => {

		test('abort + send rejects with a CancellationError-shaped error after the rematerializer runs (when rematerializer rejects with one)', async () => {
			const { pipeline } = createPipeline(disposables);
			pipeline.attachRematerializer(async () => {
				const err = new Error('Canceled');
				err.name = 'Canceled';
				throw err;
			});
			pipeline.abort();
			await pipeline.send(makePrompt('p1'), 'turn-A').then(
				() => assert.fail('expected rejection'),
				err => assert.ok(isCancellationError(err), `expected cancellation, got ${err}`),
			);
		});
	});
});
