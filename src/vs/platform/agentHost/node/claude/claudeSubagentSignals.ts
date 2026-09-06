/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { URI } from '../../../../base/common/uri.js';
import type { Mutable } from '../../../../base/common/types.js';
import { toToolCallMeta, type IToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import type { AgentSignal, IAgentSubagentStartedSignal } from '../../common/agent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallConfirmationReason, ToolCallContributorKind } from '../../common/state/sessionState.js';
import type { ClaudeMapperState } from './claudeMapSessionEvents.js';
import { SUBAGENT_TOOL_NAMES, type ISubagentSpawnInit, type SubagentRegistry, type SubagentSpawn } from './claudeSubagentRegistry.js';
import { buildClaudeToolCallMeta, buildClaudeToolMeta, getClaudeInvocationMessage, getClaudeToolDisplayName, getClaudeToolInputString } from './claudeToolDisplay.js';
import { hasClientToolNamePrefix, stripClientToolNamePrefix } from './clientTools/claudeClientToolMcpServer.js';

/**
 * Phase 12 — SDK tool names that spawn subagent sessions. Re-exported
 * from the registry's canonical set so callers can keep importing it
 * from this signals module (the live mapper, replay handling, etc.).
 */
export const SUBAGENT_SPAWNING_TOOL_NAMES: ReadonlySet<string> = SUBAGENT_TOOL_NAMES;

/**
 * Phase 12 — post-process the signals produced from a single SDK
 * message envelope. When the envelope's `parent_tool_use_id` is set,
 * every action / pending_confirmation gets tagged with
 * `parentToolCallId` so {@link import('../agentSideEffects.js').AgentSideEffects}
 * can re-route it to the subagent session. The first inner emission
 * for a given parent additionally prepends an `IAgentSubagentStartedSignal`
 * so the child session exists before any of its actions arrive.
 *
 * The Started signal's labels come straight off the parent's
 * {@link SubagentSpawn}: `subagentType` (e.g. `"Explore"`) for both
 * the agent name and display name, and `description` for the
 * description. When the spawn is missing (rare race) or has no
 * metadata yet, falls back to the literal `"subagent"` / `"Subagent"`.
 */
export function tagWithParent(
	signals: AgentSignal[],
	chat: URI,
	parentToolUseId: string | null,
	registry: SubagentRegistry,
): AgentSignal[] {
	if (!parentToolUseId) {
		return signals;
	}
	const tagged: AgentSignal[] = signals.map(s => {
		if (s.kind === 'action') {
			return { ...s, parentToolCallId: parentToolUseId };
		}
		if (s.kind === 'pending_confirmation') {
			return { ...s, parentToolCallId: parentToolUseId };
		}
		if (s.kind === 'model_call_completed') {
			return { ...s, parentToolCallId: parentToolUseId };
		}
		return s;
	});
	const spawn = registry.getSpawn(parentToolUseId);
	if (!spawn || !spawn.markAnnounced()) {
		return tagged;
	}
	const started: IAgentSubagentStartedSignal = {
		kind: 'subagent_started',
		chat,
		toolCallId: parentToolUseId,
		agentName: spawn.subagentType ?? 'subagent',
		agentDisplayName: spawn.subagentType ?? 'Subagent',
		agentDescription: spawn.description,
		// The Task tool's short `description` input doubles as the concise
		// per-task tab title for the subagent's read-only chat.
		taskDescription: spawn.description,
		// The Task tool's `prompt` input is the full delegated instruction
		// that seeds the subagent chat's opening request.
		taskPrompt: spawn.prompt,
		// When the spawning Task tool is itself an inner tool of another
		// subagent, its parent Task (one level up) is the tool call in
		// whose chat this spawning tool lives. The host uses it to route
		// the discovery content block to that immediate parent chat, at
		// any nesting depth.
		parentToolCallId: registry.getParentSpawn(parentToolUseId)?.toolUseId,
	};
	return [started, ...tagged];
}

/**
 * Phase 12 step 7 — handle the `type: 'system'` subtypes that drive
 * background-subagent lifecycle. A background `task_started` flips the
 * matching spawning entry so the foreground `tool_result` path skips its
 * `subagent_completed`, and announces the subagent: a
 * background subagent's inner content does not flow through the parent
 * stream, so {@link tagWithParent}'s first-inner-message announcement
 * never fires for it — without announcing here the child session (tab,
 * background-activities pill) would simply not exist in the UI.
 * Explicitly foreground starts remain on the normal tool-result path. If
 * the CLI later backgrounds one, `task_updated.patch.is_backgrounded`
 * performs the same transition using the task-id correlation recorded at
 * start. `task_notification` (with a terminal status) is the deferred
 * completion trigger for background entries.
 *
 * All other system subtypes (`compact_boundary`, `task_progress`, hooks,
 * etc.) fall through with `[]`; non-subagent
 * system handling stays in the mapper proper.
 */
export function mapSubagentSystemMessage(
	message: Extract<SDKMessage, { type: 'system' }>,
	chat: URI,
	registry: SubagentRegistry,
): AgentSignal[] {
	if (message.subtype === 'task_started') {
		const toolUseId = message.tool_use_id;
		const spawn = toolUseId ? registry.getSpawn(toolUseId) : undefined;
		if (!spawn) {
			return [];
		}
		registry.noteTask(message.task_id, spawn.toolUseId);
		// Pre-0.3.238 SDKs omitted this field and only surfaced this frame
		// for background work, so `undefined` deliberately preserves the
		// historical background interpretation.
		if (message.is_backgrounded === false) {
			return [];
		}
		return markSubagentBackgrounded(spawn, chat, registry);
	}
	if (message.subtype === 'task_updated') {
		if (message.patch.is_backgrounded !== true) {
			return [];
		}
		const spawn = registry.getSpawnForTask(message.task_id);
		return spawn ? markSubagentBackgrounded(spawn, chat, registry) : [];
	}
	if (message.subtype === 'task_notification') {
		if (!message.tool_use_id) {
			return [];
		}
		const status = message.status;
		if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
			return [];
		}
		const spawn = registry.getSpawn(message.tool_use_id);
		if (!spawn || !spawn.markCompleted()) {
			return [];
		}
		const toolUseId = message.tool_use_id;
		registry.removeSpawn(toolUseId);
		return [{ kind: 'subagent_completed', chat, toolCallId: toolUseId }];
	}
	return [];
}

/**
 * Close every subagent chat orphaned by an SDK subprocess that is being
 * replaced (a pipeline rebind: crash/abort recovery, or a deliberate
 * yield-restart).
 *
 * A subagent chat's turn is only ever closed by a `subagent_completed`
 * signal, and the SDK raises exactly one of those per spawn — either from the
 * foreground `tool_result` or, for a backgrounded task, from a later
 * `system.task_notification`. Both are emissions of the subprocess that owns
 * the spawn, so when that subprocess dies mid-turn neither can arrive: the
 * child chat keeps a live `activeTurn` forever, and because the session
 * summary aggregates `InProgress` across the whole chat catalog, the session
 * is pinned to "running" for the rest of its life with nothing left to
 * finish it.
 *
 * Draining here is safe precisely because the rebind is the moment the old
 * subprocess is known dead — there is no live executor left to mis-kill, at
 * any nesting depth. The child chats stay registered host-side, so a subagent
 * the rebuilt process genuinely carries on with simply opens a fresh turn
 * through the normal resume path.
 *
 * Scope: Claude only. Codex spawns child threads through its own lifecycle
 * (`codexAgent.ts`) and may have the symmetric gap, but it is deliberately
 * not touched here.
 */
export function mapSubagentProcessRebuild(chat: URI, registry: SubagentRegistry): AgentSignal[] {
	const signals: AgentSignal[] = [];
	for (const spawn of registry.drainAllSpawns()) {
		// `markCompleted` is the same idempotency guard the two real
		// completion routes take, so a spawn already closed by one of them
		// contributes nothing.
		if (spawn.markCompleted()) {
			signals.push({ kind: 'subagent_completed', chat, toolCallId: spawn.toolUseId });
		}
	}
	return signals;
}

function markSubagentBackgrounded(
	spawn: SubagentSpawn,
	chat: URI,
	registry: SubagentRegistry,
): AgentSignal[] {
	spawn.background = true;
	if (!spawn.markAnnounced()) {
		return [];
	}
	const started: IAgentSubagentStartedSignal = {
		kind: 'subagent_started',
		chat,
		toolCallId: spawn.toolUseId,
		agentName: spawn.subagentType ?? 'subagent',
		agentDisplayName: spawn.subagentType ?? 'Subagent',
		agentDescription: spawn.description,
		taskDescription: spawn.description,
		taskPrompt: spawn.prompt,
		parentToolCallId: registry.getParentSpawn(spawn.toolUseId)?.toolUseId,
	};
	return [started];
}

/**
 * Phase 12 fix — build the `ChatToolCallReady` signal for a top-level
 * Task/Agent tool_use block AND record the spawn's metadata onto the
 * registry. The workbench's
 * [stateToProgressAdapter.ts](../../../../workbench/contrib/chat/browser/agentSessions/agentHost/stateToProgressAdapter.ts)
 * reads `_meta.subagentDescription` and `_meta.subagentAgentName` to
 * render the subagent UI before any inner content arrives.
 *
 * The metadata side effect (`spawn.description = ...`,
 * `spawn.subagentType = ...`) is written here because the canonical
 * `assistant` envelope is the first place where `block.input` is
 * complete (the early `content_block_start` carries an empty input bag
 * that gets filled in via `input_json_delta` events).
 *
 * Inputs:
 *   - `block.id` / `block.name` — SDK-supplied tool_use identifiers.
 *   - `block.input.description` → `spawn.description` and
 *     `_meta.subagentDescription` and `action.invocationMessage`.
 *   - `block.input.subagent_type` → `spawn.subagentType` and
 *     `_meta.subagentAgentName`.
 *   - `block.input.prompt` → `spawn.prompt` (seeds the subagent's
 *     opening request via the `subagent_started` signal's `taskPrompt`).
 */
export function buildTopLevelSubagentReadyAction(
	block: Extract<import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage['message']['content'][number], { type: 'tool_use' }>,
	chat: URI,
	turnId: string,
	registry: SubagentRegistry,
): AgentSignal {
	const { subagentType: agentName, description, prompt } = readSubagentSpawnInit(block.input);
	const inputJson = block.input !== undefined ? safeStringify(block.input) : undefined;
	registry.recordSpawn(block.id, { subagentType: agentName, description, prompt });
	const meta: Mutable<IToolCallMeta> = { ...buildClaudeToolCallMeta(block.name) };
	if (!meta.toolKind) {
		meta.toolKind = 'subagent';
	}
	if (description) {
		meta.subagentDescription = description;
	}
	if (agentName) {
		meta.subagentAgentName = agentName;
	}
	return {
		kind: 'action',
		resource: chat,
		action: {
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: block.id,
			invocationMessage: getClaudeInvocationMessage(block.name, getClaudeToolDisplayName(block.name), block.input),
			...(inputJson !== undefined ? { toolInput: inputJson } : {}),
			confirmed: ToolCallConfirmationReason.NotNeeded,
			_meta: toToolCallMeta(meta),
		},
	};
}

/**
 * Phase 12 fix — walk an inner subagent canonical assistant message
 * (`parent_tool_use_id !== null`) and emit one signal per content block.
 *
 * The SDK does NOT deliver inner subagent content via `stream_event`
 * partials, only via canonical `assistant` (and `user` for tool_result)
 * envelopes. So this canonical envelope IS the only signal source for
 * inner content. We emit:
 *
 *   - `text` / `thinking` → `ChatResponsePart` (Markdown / Reasoning)
 *     with the full block content.
 *   - `tool_use` → `ChatToolCallStart` + `ChatToolCallReady`
 *     (`confirmed: NotNeeded`, since the SDK runs inner tools in
 *     `bypassPermissions` and the parent's `canUseTool` is skipped),
 *     plus side effects on `state` (cross-message lookup) and
 *     `registry` (inner→parent edge for the canUseTool bridge).
 *
 * Returns the emitted signals; the caller (`tagWithParent`) is
 * responsible for stamping `parentToolCallId` on every action.
 */
export function emitInnerAssistantSignals(
	message: Extract<SDKMessage, { type: 'assistant' }>,
	chat: URI,
	turnId: string,
	state: ClaudeMapperState,
	parentToolUseId: string,
	registry: SubagentRegistry,
	clientToolOwner?: (toolName: string) => string | undefined,
): AgentSignal[] {
	const messageId = message.message.id;
	const signals: AgentSignal[] = [];
	for (let index = 0; index < message.message.content.length; index++) {
		const block = message.message.content[index];
		if (block.type === 'text') {
			signals.push({
				kind: 'action',
				resource: chat,
				action: {
					type: ActionType.ChatResponsePart,
					turnId,
					part: {
						kind: ResponsePartKind.Markdown,
						id: `${turnId}#${messageId}#${index}`,
						content: block.text,
					},
				},
			});
			continue;
		}
		if (block.type === 'thinking') {
			signals.push({
				kind: 'action',
				resource: chat,
				action: {
					type: ActionType.ChatResponsePart,
					turnId,
					part: {
						kind: ResponsePartKind.Reasoning,
						id: `${turnId}#${messageId}#${index}`,
						content: block.thinking,
					},
				},
			});
			continue;
		}
		if (block.type === 'tool_use') {
			// Strip the in-process MCP server prefix so subagent client-tool
			// calls render with their real name (matches the top-level stream
			// mapper). SDK-owned tools and Task/Agent passes through unchanged.
			const toolName = stripClientToolNamePrefix(block.name);
			const isClientTool = hasClientToolNamePrefix(block.name);
			const clientId = isClientTool ? clientToolOwner?.(toolName) : undefined;
			// Cross-message tracking only. `index` is this inner message's
			// own content-block index, not a position in the top-level
			// partial stream, so it must not be published into the shared
			// per-message index map: a subagent reporting mid-stream would
			// leave a residue the next top-level `content_block_stop` picks
			// up as its own tool block.
			state.toolCalls.begin(block.id, toolName, turnId, isClientTool);
			// Inner tool input arrives pre-parsed on the synthesized
			// `assistant` message (not via `input_json_delta` chunks), so
			// seed the registry directly. Without this the live
			// `tool_result` handler falls back to a generic
			// `"{displayName} finished"` past-tense and replay (which
			// always computes rich text) drifts from live — violating D6.
			state.toolCalls.seedParsedInput(block.id, block.input);
			if (!isClientTool && SUBAGENT_SPAWNING_TOOL_NAMES.has(toolName)) {
				// A Task inside a subagent spawns a nested subagent. Its input
				// bag is complete on this canonical envelope, so record the
				// spawn here: without it nothing announces the nested child and
				// every signal it produces is buffered against a subagent that
				// never starts.
				registry.recordSpawn(block.id, readSubagentSpawnInit(block.input));
			}
			registry.noteInnerTool(block.id, parentToolUseId);
			const displayName = isClientTool ? toolName : getClaudeToolDisplayName(toolName);
			const meta = isClientTool ? undefined : buildClaudeToolMeta(toolName);
			const info = state.toolCalls.lookup(block.id)?.info;
			const toolInputStr = info?.toolInput ?? getClaudeToolInputString(toolName, block.input);
			signals.push({
				kind: 'action',
				resource: chat,
				action: {
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId: block.id,
					toolName,
					displayName,
					...(clientId ? { contributor: { kind: ToolCallContributorKind.Client, clientId } } : {}),
					...(meta ? { _meta: meta } : {}),
				},
			});
			signals.push({
				kind: 'action',
				resource: chat,
				action: {
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: block.id,
					invocationMessage: isClientTool ? displayName : getClaudeInvocationMessage(toolName, displayName, block.input),
					...(toolInputStr !== undefined ? { toolInput: toolInputStr } : {}),
					confirmed: ToolCallConfirmationReason.NotNeeded,
				},
			});
			continue;
		}
		// Unknown inner block kind — skip silently (caller will trace at
		// the mapper level if needed; we don't want to import ILogService
		// here just for one trace).
	}
	return signals;
}

/**
 * Read the Task/Agent `tool_use.input` fields the registry tracks per
 * spawn. Wrong-typed fields read as absent — the input bag is model
 * output, so a missing label must not become a rendered `"42"`.
 */
function readSubagentSpawnInit(rawInput: unknown): ISubagentSpawnInit {
	const input = rawInput as Record<string, unknown> | undefined;
	return {
		subagentType: typeof input?.subagent_type === 'string' ? input.subagent_type : undefined,
		description: typeof input?.description === 'string' ? input.description : undefined,
		prompt: typeof input?.prompt === 'string' ? input.prompt : undefined,
	};
}

function safeStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}
