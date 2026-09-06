/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ToolCallConfirmationReason, ToolCallContributorKind } from '../../common/state/sessionState.js';
import { ClaudeMapperState, mapSDKMessageToAgentSignals } from '../../node/claude/claudeMapSessionEvents.js';
import { SubagentRegistry } from '../../node/claude/claudeSubagentRegistry.js';
import { buildTopLevelSubagentReadyAction, mapSubagentProcessRebuild, mapSubagentSystemMessage } from '../../node/claude/claudeSubagentSignals.js';
import {
	makeAssistantMessage,
	makeContentBlockStartText,
	makeContentBlockStartToolUse,
	makeContentBlockStop,
	makeMessageStart,
	makeStreamEvent,
	makeUserToolResultMessage,
} from './claudeMapSessionEventsTestUtils.js';

/**
 * Direct tests for Phase 12 subagent signal emission.
 *
 * Drives `mapSDKMessageToAgentSignals` end-to-end for the integrated
 * paths, and the two newly-exported `claudeSubagentSignals` functions
 * directly for their contract-level assertions. Uses a fresh real
 * {@link SubagentRegistry} per test so subagent state is visible
 * across mapper invocations and assertable directly on the spawn record.
 */
suite('claudeSubagentSignals — Phase 12 emission', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const SESSION = URI.parse('agent-session://test/abc');
	const SESSION_ID = 'sid-1';
	const TURN_ID = 'turn-1';

	function r(): SubagentRegistry {
		return disposables.add(new SubagentRegistry());
	}

	test('top-level Task tool_use records a spawn; non-subagent tools do not', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, 'toolu_task', 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(1, 'toolu_agent', 'Agent')),
			SESSION, TURN_ID, state, log, registry,
		);
		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(2, 'toolu_read', 'Read')),
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			task: registry.getSpawn('toolu_task')?.toolUseId,
			agent: registry.getSpawn('toolu_agent')?.toolUseId,
			read: registry.getSpawn('toolu_read'),
		}, {
			task: 'toolu_task',
			agent: 'toolu_agent',
			read: undefined,
		});
	});

	test('top-level Task ChatToolCallStart carries _meta.toolKind=subagent so the workbench renders the subagent UI', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();

		const taskSignals = mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, 'toolu_task', 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		const readSignals = mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(1, 'toolu_read', 'Read')),
			SESSION, TURN_ID, state, log, registry,
		);

		const taskAction = taskSignals[0];
		const readAction = readSignals[0];
		assert.ok(taskAction.kind === 'action' && taskAction.action.type === ActionType.ChatToolCallStart, 'Task signal is ChatToolCallStart');
		assert.ok(readAction.kind === 'action' && readAction.action.type === ActionType.ChatToolCallStart, 'Read signal is ChatToolCallStart');

		assert.deepStrictEqual({
			taskMeta: taskAction.action._meta,
			readMeta: readAction.action._meta,
		}, {
			taskMeta: { toolKind: 'subagent' },
			readMeta: { toolKind: 'read' },
		});
	});

	test('top-level canonical assistant for Task emits ChatToolCallReady with confirmed:NotNeeded + _meta.subagentDescription/AgentName AND records metadata onto the spawn', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, 'toolu_top_task', 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		const canonical = makeAssistantMessage(SESSION_ID, [{
			type: 'tool_use',
			id: 'toolu_top_task',
			name: 'Task',
			input: { description: 'Count TS files', subagent_type: 'Explore', prompt: 'Count how many TS files...' },
		}]);
		const out = mapSDKMessageToAgentSignals(canonical, SESSION, TURN_ID, state, log, registry);

		const ready = out.find(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallReady);
		assert.ok(ready && ready.kind === 'action' && ready.action.type === ActionType.ChatToolCallReady, 'Ready emitted');

		const spawn = registry.getSpawn('toolu_top_task');
		assert.deepStrictEqual({
			toolCallId: ready.action.toolCallId,
			invocationMessage: ready.action.invocationMessage,
			confirmed: ready.action.confirmed,
			meta: ready.action._meta,
			parentToolCallId: ready.parentToolCallId,
			spawnSubagentType: spawn?.subagentType,
			spawnDescription: spawn?.description,
		}, {
			toolCallId: 'toolu_top_task',
			invocationMessage: 'Count TS files',
			confirmed: ToolCallConfirmationReason.NotNeeded,
			meta: {
				toolKind: 'subagent',
				subagentDescription: 'Count TS files',
				subagentAgentName: 'Explore',
			},
			parentToolCallId: undefined,
			spawnSubagentType: 'Explore',
			spawnDescription: 'Count TS files',
		});
	});

	test('inner subagent message: prepends subagent_started exactly once, tags emitted action with parentToolCallId, records inner-tool→parent edge', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_parent';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		const innerText = makeStreamEvent(SESSION_ID, makeContentBlockStartText(0));
		innerText.parent_tool_use_id = PARENT;
		const first = mapSDKMessageToAgentSignals(innerText, SESSION, TURN_ID, state, log, registry);

		const innerToolUse = makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(1, 'toolu_inner', 'Read'));
		innerToolUse.parent_tool_use_id = PARENT;
		const second = mapSDKMessageToAgentSignals(innerToolUse, SESSION, TURN_ID, state, log, registry);

		assert.deepStrictEqual({
			firstKinds: first.map(s => s.kind),
			firstStartedToolCallId: first[0]?.kind === 'subagent_started' ? first[0].toolCallId : null,
			firstActionParent: first.filter(s => s.kind === 'action').map(s => s.kind === 'action' ? s.parentToolCallId : null),
			secondKinds: second.map(s => s.kind),
			secondActionParent: second.filter(s => s.kind === 'action').map(s => s.kind === 'action' ? s.parentToolCallId : null),
			innerToolParentSpawnId: registry.getParentSpawn('toolu_inner')?.toolUseId,
		}, {
			firstKinds: ['subagent_started', 'action'],
			firstStartedToolCallId: PARENT,
			firstActionParent: [PARENT],
			secondKinds: ['action'],
			secondActionParent: [PARENT],
			innerToolParentSpawnId: PARENT,
		});
	});

	test('inner emission with unknown parent_tool_use_id (no spawn recorded) does NOT prepend subagent_started — tagging still applies', () => {
		// New model: "no spawn means no announcement". If the registry
		// has never seen the parent (and thus has no metadata), emitting
		// a subagent_started would be lying about a session that never
		// existed. The action is still tagged with parentToolCallId so
		// AgentSideEffects can route it (or buffer / drop).
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();

		const innerText = makeStreamEvent(SESSION_ID, makeContentBlockStartText(0));
		innerText.parent_tool_use_id = 'toolu_unknown';
		const out = mapSDKMessageToAgentSignals(innerText, SESSION, TURN_ID, state, log, registry);

		assert.deepStrictEqual({
			kinds: out.map(s => s.kind),
			actionParents: out.filter(s => s.kind === 'action').map(s => s.kind === 'action' ? s.parentToolCallId : null),
		}, {
			kinds: ['action'],
			actionParents: ['toolu_unknown'],
		});
	});

	test('inner subagent canonical assistant message emits text/thinking/tool_use signals + tags them with parentToolCallId, lets the matching tool_result complete', () => {
		// Empirically the SDK delivers inner content via canonical messages,
		// not partials — this exercises that integration path end-to-end.
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_parent_inner';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		const innerAssistant = makeAssistantMessage(SESSION_ID, [
			{ type: 'text', text: 'looking up files', citations: null },
			{ type: 'tool_use', id: 'toolu_inner_glob', name: 'Glob', input: { pattern: '**/*.ts' } },
		]);
		innerAssistant.parent_tool_use_id = PARENT;
		const fromAssistant = mapSDKMessageToAgentSignals(innerAssistant, SESSION, TURN_ID, state, log, registry);

		const innerToolResult = makeUserToolResultMessage(SESSION_ID, 'toolu_inner_glob', 'a.ts\nb.ts');
		innerToolResult.parent_tool_use_id = PARENT;
		const fromToolResult = mapSDKMessageToAgentSignals(innerToolResult, SESSION, TURN_ID, state, log, registry);

		const kinds = fromAssistant.map(s => s.kind);
		const allParentIds = [...fromAssistant, ...fromToolResult].filter(s => s.kind === 'action').map(s => s.kind === 'action' ? s.parentToolCallId : null);
		const modelCallParentId = fromAssistant.find(s => s.kind === 'model_call_completed')?.parentToolCallId;
		const completeAction = fromToolResult.find(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallComplete);
		const completePastTense = completeAction?.kind === 'action' && completeAction.action.type === ActionType.ChatToolCallComplete
			? completeAction.action.result.pastTenseMessage
			: undefined;

		assert.deepStrictEqual({
			fromAssistantKinds: kinds,
			toolUseEdge: registry.getParentSpawn('toolu_inner_glob')?.toolUseId,
			fromToolResultHasComplete: completeAction !== undefined,
			everyActionTaggedWithParent: allParentIds.every(p => p === PARENT),
			modelCallParentId,
			// D6 parity: inner-tool past-tense must use the rich helper
			// (seeded by `seedParsedInput` at start time), not fall back to
			// the generic "{displayName} finished" — replay always renders
			// rich text, so a generic live message would silently diverge.
			completePastTense,
		}, {
			fromAssistantKinds: ['subagent_started', 'model_call_completed', 'action', 'action', 'action'],
			toolUseEdge: PARENT,
			fromToolResultHasComplete: true,
			everyActionTaggedWithParent: true,
			modelCallParentId: PARENT,
			completePastTense: { markdown: 'Find files matching `**/*.ts`' },
		});
	});

	test('inner client tools preserve client ownership and generic input across the lifecycle', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const parentToolCallId = 'toolu_parent_client';
		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, parentToolCallId, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		const innerAssistant = makeAssistantMessage(SESSION_ID, [
			{ type: 'tool_use', id: 'toolu_inner_client', name: 'mcp__client__Bash', input: { command: 'echo client' } },
		]);
		innerAssistant.parent_tool_use_id = parentToolCallId;
		const fromAssistant = mapSDKMessageToAgentSignals(innerAssistant, SESSION, TURN_ID, state, log, registry, () => 'client-1');
		const innerToolResult = makeUserToolResultMessage(SESSION_ID, 'toolu_inner_client', 'done');
		innerToolResult.parent_tool_use_id = parentToolCallId;
		const fromResult = mapSDKMessageToAgentSignals(innerToolResult, SESSION, TURN_ID, state, log, registry);

		const actions = [...fromAssistant, ...fromResult].filter(signal => signal.kind === 'action').map(signal => signal.kind === 'action' ? signal.action : undefined);
		assert.deepStrictEqual(actions.map(action => {
			switch (action?.type) {
				case ActionType.ChatToolCallStart:
					return {
						type: action.type,
						toolName: action.toolName,
						displayName: action.displayName,
						contributor: action.contributor,
						meta: action._meta,
					};
				case ActionType.ChatToolCallReady:
					return {
						type: action.type,
						invocationMessage: action.invocationMessage,
						toolInput: action.toolInput,
					};
				case ActionType.ChatToolCallComplete:
					return {
						type: action.type,
						pastTenseMessage: action.result.pastTenseMessage,
					};
				default:
					return undefined;
			}
		}).filter(item => item !== undefined), [
			{
				type: ActionType.ChatToolCallStart,
				toolName: 'Bash',
				displayName: 'Bash',
				contributor: { kind: ToolCallContributorKind.Client, clientId: 'client-1' },
				meta: undefined,
			},
			{
				type: ActionType.ChatToolCallReady,
				invocationMessage: 'Bash',
				toolInput: '{\n  "command": "echo client"\n}',
			},
			{
				type: ActionType.ChatToolCallComplete,
				pastTenseMessage: 'Bash',
			},
		]);
	});

	test('foreground subagent completion: tool_result for a Task spawn emits ChatToolCallComplete AND IAgentSubagentCompletedSignal, then clears the spawn from the registry', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_fg_task';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		const signals = mapSDKMessageToAgentSignals(
			makeUserToolResultMessage(SESSION_ID, PARENT, 'done'),
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			kinds: signals.map(s => s.kind),
			completedToolCallId: signals.find(s => s.kind === 'subagent_completed')?.toolCallId,
			spawnCleared: registry.getSpawn(PARENT),
		}, {
			kinds: ['action', 'subagent_completed'],
			completedToolCallId: PARENT,
			spawnCleared: undefined,
		});
	});

	test('background subagent completion: task_started then tool_result yields NO completion; later task_notification fires it', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_bg_task';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);

		mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: PARENT, description: 'bg', is_backgrounded: true } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		const afterToolResult = mapSDKMessageToAgentSignals(
			makeUserToolResultMessage(SESSION_ID, PARENT, 'tool returned'),
			SESSION, TURN_ID, state, log, registry,
		);
		const isBackgroundAfterToolResult = registry.getSpawn(PARENT)?.background;

		const afterNotification = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: PARENT, status: 'completed', output_file: 'o', summary: 's' } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		const afterNotificationAgain = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: PARENT, status: 'completed', output_file: 'o', summary: 's' } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			afterToolResultKinds: afterToolResult.map(s => s.kind),
			isBackgroundAfterToolResult,
			afterNotificationKinds: afterNotification.map(s => s.kind),
			completedToolCallId: afterNotification.find(s => s.kind === 'subagent_completed')?.toolCallId,
			afterNotificationAgainKinds: afterNotificationAgain.map(s => s.kind),
			spawnClearedAfterNotification: registry.getSpawn(PARENT),
		}, {
			afterToolResultKinds: ['action'],
			isBackgroundAfterToolResult: true,
			afterNotificationKinds: ['subagent_completed'],
			completedToolCallId: PARENT,
			afterNotificationAgainKinds: [],
			spawnClearedAfterNotification: undefined,
		});
	});

	test('foreground task_started stays on the tool_result completion path', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_fg_task';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		const onStart = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't-fg', tool_use_id: PARENT, description: 'fg', is_backgrounded: false } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const isBackground = registry.getSpawn(PARENT)?.background;
		const afterToolResult = mapSDKMessageToAgentSignals(
			makeUserToolResultMessage(SESSION_ID, PARENT, 'done'),
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			onStartKinds: onStart.map(s => s.kind),
			isBackground,
			afterToolResultKinds: afterToolResult.map(s => s.kind),
			completedToolCallId: afterToolResult.find(s => s.kind === 'subagent_completed')?.toolCallId,
			spawnCleared: registry.getSpawn(PARENT),
		}, {
			onStartKinds: [],
			isBackground: false,
			afterToolResultKinds: ['action', 'subagent_completed'],
			completedToolCallId: PARENT,
			spawnCleared: undefined,
		});
	});

	test('legacy task_started without is_backgrounded keeps the historical background behavior', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_legacy_bg_task';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		const onStart = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't-legacy-bg', tool_use_id: PARENT, description: 'legacy bg' } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			onStartKinds: onStart.map(s => s.kind),
			isBackground: registry.getSpawn(PARENT)?.background,
		}, {
			onStartKinds: ['subagent_started'],
			isBackground: true,
		});
	});

	test('task_updated moves a foreground subagent to deferred background completion', () => {
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_later_bg_task';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		const onStart = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't-later-bg', tool_use_id: PARENT, description: 'fg', is_backgrounded: false } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const onBackground = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_updated', task_id: 't-later-bg', patch: { is_backgrounded: true } } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const afterToolResult = mapSDKMessageToAgentSignals(
			makeUserToolResultMessage(SESSION_ID, PARENT, 'now running in background'),
			SESSION, TURN_ID, state, log, registry,
		);
		const afterNotification = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_notification', task_id: 't-later-bg', tool_use_id: PARENT, status: 'completed' } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const updateAfterCompletion = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_updated', task_id: 't-later-bg', patch: { is_backgrounded: true } } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		assert.deepStrictEqual({
			onStartKinds: onStart.map(s => s.kind),
			onBackgroundKinds: onBackground.map(s => s.kind),
			backgroundToolCallId: onBackground.find(s => s.kind === 'subagent_started')?.toolCallId,
			afterToolResultKinds: afterToolResult.map(s => s.kind),
			afterNotificationKinds: afterNotification.map(s => s.kind),
			updateAfterCompletionKinds: updateAfterCompletion.map(s => s.kind),
		}, {
			onStartKinds: [],
			onBackgroundKinds: ['subagent_started'],
			backgroundToolCallId: PARENT,
			afterToolResultKinds: ['action'],
			afterNotificationKinds: ['subagent_completed'],
			updateAfterCompletionKinds: [],
		});
	});

	test('background task_started announces subagent_started once with the spawn metadata; inner messages and repeat task_started do not duplicate it', () => {
		// A background subagent's inner content never flows through the
		// parent stream, so `task_started` is the only place its child
		// session can be announced — without this the subagent is
		// invisible in the UI for its entire lifetime.
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_bg_announce';

		mapSDKMessageToAgentSignals(
			makeStreamEvent(SESSION_ID, makeContentBlockStartToolUse(0, PARENT, 'Task')),
			SESSION, TURN_ID, state, log, registry,
		);
		mapSDKMessageToAgentSignals(
			makeAssistantMessage(SESSION_ID, [{
				type: 'tool_use',
				id: PARENT,
				name: 'Task',
				input: { description: 'Trace composer race', subagent_type: 'Explore', prompt: 'Find the race...' },
			}]),
			SESSION, TURN_ID, state, log, registry,
		);

		const onStart = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: PARENT, description: 'bg', is_backgrounded: true } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const onStartAgain = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: PARENT, description: 'bg', is_backgrounded: true } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);
		const unknownStart = mapSDKMessageToAgentSignals(
			{ type: 'system', subtype: 'task_started', task_id: 't2', tool_use_id: 'toolu_never_spawned', description: 'bg' } as unknown as SDKMessage,
			SESSION, TURN_ID, state, log, registry,
		);

		const innerText = makeStreamEvent(SESSION_ID, makeContentBlockStartText(0));
		innerText.parent_tool_use_id = PARENT;
		const inner = mapSDKMessageToAgentSignals(innerText, SESSION, TURN_ID, state, log, registry);

		const started = onStart[0];
		assert.ok(started?.kind === 'subagent_started', 'task_started announces the subagent');
		assert.deepStrictEqual({
			onStartKinds: onStart.map(s => s.kind),
			toolCallId: started.toolCallId,
			agentName: started.agentName,
			agentDisplayName: started.agentDisplayName,
			taskDescription: started.taskDescription,
			taskPrompt: started.taskPrompt,
			isBackground: registry.getSpawn(PARENT)?.background,
			onStartAgainKinds: onStartAgain.map(s => s.kind),
			unknownStartKinds: unknownStart.map(s => s.kind),
			innerKinds: inner.map(s => s.kind),
		}, {
			onStartKinds: ['subagent_started'],
			toolCallId: PARENT,
			agentName: 'Explore',
			agentDisplayName: 'Explore',
			taskDescription: 'Trace composer race',
			taskPrompt: 'Find the race...',
			isBackground: true,
			onStartAgainKinds: [],
			unknownStartKinds: [],
			innerKinds: ['action'],
		});
	});

	test('a Task nested inside a subagent is recorded as its own spawn, so the nested child is announced with its metadata and its immediate parent', () => {
		// E2: without a spawn record for the nested Task, `tagWithParent`
		// finds nothing to announce for it, the host never creates the
		// nested chat, and every signal the nested subagent produces is
		// buffered against a subagent that never starts — the whole nested
		// transcript is lost.
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const OUTER = 'toolu_outer_task';
		const NESTED = 'toolu_nested_task';

		mapSDKMessageToAgentSignals(
			makeAssistantMessage(SESSION_ID, [{
				type: 'tool_use', id: OUTER, name: 'Task',
				input: { description: 'Audit', subagent_type: 'Explore', prompt: 'Audit the diff' },
			}]),
			SESSION, TURN_ID, state, log, registry,
		);

		const outerInner = makeAssistantMessage(SESSION_ID, [{
			type: 'tool_use', id: NESTED, name: 'Task',
			input: { description: 'Count files', subagent_type: 'Plan', prompt: 'Count the TS files' },
		}]);
		outerInner.parent_tool_use_id = OUTER;
		mapSDKMessageToAgentSignals(outerInner, SESSION, TURN_ID, state, log, registry);

		const nestedOutput = makeAssistantMessage(SESSION_ID, [{ type: 'text', text: 'found 12 files', citations: null }]);
		nestedOutput.parent_tool_use_id = NESTED;
		const out = mapSDKMessageToAgentSignals(nestedOutput, SESSION, TURN_ID, state, log, registry);
		const started = out.find(s => s.kind === 'subagent_started');

		assert.deepStrictEqual({
			kinds: out.map(s => s.kind),
			startedToolCallId: started?.kind === 'subagent_started' ? started.toolCallId : undefined,
			// The one-hop reference the host resolves into the immediate
			// parent chat, so the nested chat is rendered inside its
			// spawning subagent rather than the top-level chat.
			startedParentToolCallId: started?.kind === 'subagent_started' ? started.parentToolCallId : undefined,
			startedAgentName: started?.kind === 'subagent_started' ? started.agentName : undefined,
			startedTaskPrompt: started?.kind === 'subagent_started' ? started.taskPrompt : undefined,
			outputParent: out.find(s => s.kind === 'action')?.parentToolCallId,
		}, {
			kinds: ['subagent_started', 'model_call_completed', 'action'],
			startedToolCallId: NESTED,
			startedParentToolCallId: OUTER,
			startedAgentName: 'Plan',
			startedTaskPrompt: 'Count the TS files',
			outputParent: NESTED,
		});
	});

	test('an inner tool block does not occupy the top-level content-block index namespace', () => {
		// E7: inner content carries the SDK's per-message block index, but
		// that index namespace belongs to the top-level partial stream. A
		// background subagent reporting mid-stream would otherwise leave a
		// residue the next top-level `content_block_stop` picks up: it
		// re-finalizes the inner tool (dropping its seeded rich input) and
		// emits a `ChatToolCallReady` for the inner tool on the top-level
		// turn, where no matching `ChatToolCallStart` exists.
		const state = new ClaudeMapperState();
		const log = new NullLogService();
		const registry = r();
		const PARENT = 'toolu_bg_task';

		mapSDKMessageToAgentSignals(
			makeAssistantMessage(SESSION_ID, [{
				type: 'tool_use', id: PARENT, name: 'Task',
				input: { description: 'Audit', subagent_type: 'Explore', prompt: 'Audit the diff' },
			}]),
			SESSION, TURN_ID, state, log, registry,
		);

		// Top-level text block opens at index 0.
		mapSDKMessageToAgentSignals(makeStreamEvent(SESSION_ID, makeMessageStart('msg_top')), SESSION, TURN_ID, state, log, registry);
		mapSDKMessageToAgentSignals(makeStreamEvent(SESSION_ID, makeContentBlockStartText(0)), SESSION, TURN_ID, state, log, registry);

		// The subagent reports while that block is still open; its own
		// tool_use also sits at block index 0 of ITS message.
		const innerAssistant = makeAssistantMessage(SESSION_ID, [
			{ type: 'tool_use', id: 'toolu_inner_glob', name: 'Glob', input: { pattern: '**/*.ts' } },
		]);
		innerAssistant.parent_tool_use_id = PARENT;
		mapSDKMessageToAgentSignals(innerAssistant, SESSION, TURN_ID, state, log, registry);

		// The top-level text block closes.
		const stop = mapSDKMessageToAgentSignals(makeStreamEvent(SESSION_ID, makeContentBlockStop(0)), SESSION, TURN_ID, state, log, registry);

		const innerResult = makeUserToolResultMessage(SESSION_ID, 'toolu_inner_glob', 'a.ts\nb.ts');
		innerResult.parent_tool_use_id = PARENT;
		const complete = mapSDKMessageToAgentSignals(innerResult, SESSION, TURN_ID, state, log, registry)
			.find(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallComplete);

		assert.deepStrictEqual({
			stopKinds: stop.map(s => s.kind),
			stopToolCallIds: stop.map(s => s.kind === 'action' && s.action.type === ActionType.ChatToolCallReady ? s.action.toolCallId : undefined),
			completePastTense: complete?.kind === 'action' && complete.action.type === ActionType.ChatToolCallComplete
				? complete.action.result.pastTenseMessage
				: undefined,
		}, {
			stopKinds: [],
			stopToolCallIds: [],
			completePastTense: { markdown: 'Find files matching `**/*.ts`' },
		});
	});

	// #region focused contract tests on the extracted exports

	test('buildTopLevelSubagentReadyAction omits _meta description/agentName when input fields are missing or wrong-typed; still records the spawn', () => {
		const registry = r();
		const malformed = buildTopLevelSubagentReadyAction(
			{ type: 'tool_use', id: 'toolu_bad', name: 'Task', input: { description: 42, subagent_type: null } as unknown as Record<string, unknown> },
			SESSION,
			TURN_ID,
			registry,
		);

		assert.ok(malformed.kind === 'action' && malformed.action.type === ActionType.ChatToolCallReady);
		const spawn = registry.getSpawn('toolu_bad');
		assert.deepStrictEqual({
			meta: malformed.action._meta,
			invocationMessage: malformed.action.invocationMessage,
			spawnRecorded: spawn?.toolUseId,
			spawnSubagentType: spawn?.subagentType,
			spawnDescription: spawn?.description,
		}, {
			meta: { toolKind: 'subagent' },
			invocationMessage: 'Run subagent task',
			spawnRecorded: 'toolu_bad',
			spawnSubagentType: undefined,
			spawnDescription: undefined,
		});
	});

	test('mapSubagentSystemMessage ignores task_notification with non-terminal status, missing tool_use_id, or unknown spawn', () => {
		const registry = r();
		registry.recordSpawn('toolu_known');

		const inProgress = mapSubagentSystemMessage({ type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'toolu_known', status: 'in_progress' } as unknown as SDKMessage & { type: 'system' }, SESSION, registry);
		const missingId = mapSubagentSystemMessage({ type: 'system', subtype: 'task_notification', task_id: 't', status: 'completed' } as unknown as SDKMessage & { type: 'system' }, SESSION, registry);
		const unknownEntry = mapSubagentSystemMessage({ type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'toolu_unknown', status: 'completed' } as unknown as SDKMessage & { type: 'system' }, SESSION, registry);

		assert.deepStrictEqual({
			inProgressKinds: inProgress.map(s => s.kind),
			missingIdKinds: missingId.map(s => s.kind),
			unknownEntryKinds: unknownEntry.map(s => s.kind),
		}, {
			inProgressKinds: [],
			missingIdKinds: [],
			unknownEntryKinds: [],
		});
	});

	test('mapSubagentProcessRebuild completes every open spawn, foreground and background alike', () => {
		// A rebind replaces the CLI subprocess. Both completion routes — the
		// foreground `tool_result` and the background `task_notification` —
		// were emissions of the process that just died, so every open spawn
		// must be closed here or its chat keeps a live turn forever and the
		// session summary stays pinned to InProgress.
		const registry = r();
		registry.recordSpawn('toolu_fg');
		const bg = registry.recordSpawn('toolu_bg');
		bg.background = true;

		const signals = mapSubagentProcessRebuild(SESSION, registry);

		assert.deepStrictEqual({
			signals: signals.map(s => ({ kind: s.kind, toolCallId: (s as { toolCallId?: string }).toolCallId })).sort((a, b) => (a.toolCallId ?? '').localeCompare(b.toolCallId ?? '')),
			registryDrained: [registry.getSpawn('toolu_fg'), registry.getSpawn('toolu_bg')],
		}, {
			signals: [
				{ kind: 'subagent_completed', toolCallId: 'toolu_bg' },
				{ kind: 'subagent_completed', toolCallId: 'toolu_fg' },
			],
			registryDrained: [undefined, undefined],
		});
	});

	test('mapSubagentProcessRebuild does not re-complete a spawn a real completion route already closed, and is a no-op with nothing open', () => {
		const registry = r();
		const alreadyDone = registry.recordSpawn('toolu_done');
		alreadyDone.markCompleted(); // the real `tool_result` / `task_notification` route got there first
		registry.recordSpawn('toolu_open');

		const first = mapSubagentProcessRebuild(SESSION, registry);
		const second = mapSubagentProcessRebuild(SESSION, registry);

		assert.deepStrictEqual({
			firstIds: first.map(s => (s as { toolCallId?: string }).toolCallId),
			secondIds: second.map(s => (s as { toolCallId?: string }).toolCallId),
		}, {
			firstIds: ['toolu_open'],
			secondIds: [],
		});
	});

	// #endregion
});
