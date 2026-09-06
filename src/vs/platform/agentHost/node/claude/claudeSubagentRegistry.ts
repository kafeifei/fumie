/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	ResponsePartKind,
	ToolCallStatus,
	ToolResultContentType,
	type ResponsePart,
	type Turn,
} from '../../common/state/protocol/state.js';

/**
 * Tool names whose `tool_use` blocks spawn a subagent. The SDK's
 * `Task` (and legacy `Agent`) tools encode subagent invocations as
 * normal tool_use entries; we observe them here at spawn time and
 * track each one as a {@link SubagentSpawn}.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

/**
 * Regex matching the SDK's synthetic per-subagent suffix appended to
 * `Task`/`Agent` `tool_result` text blocks. Empirically observed
 * format: `agentId: <hex> (use SendMessage with to: '<hex>') ...`.
 * Tolerant by design — case-insensitive, lenient whitespace, anchored
 * only by line start — so minor wording drift between SDK versions
 * doesn't silently break correlation.
 */
export const SUBAGENT_ID_SUFFIX_REGEX = /^\s*agentId:\s+([a-z0-9]+)\b/im;

/**
 * One Task tool_use in the parent session that did (or may have)
 * spawned a subagent. All lifecycle state for *this* spawn lives here:
 *
 *   - {@link agentId}: the SDK's identity for the spawned subagent.
 *     Set when learned (`canUseTool` `options.agentID`, strategy
 *     resolution, or transcript priming).
 *   - {@link background}: foreground vs. background mode. Defaults to
 *     `false` (foreground is the common case); flipped to `true` when
 *     the SDK emits `system.task_started`. Background spawns have
 *     deferred completion via `system.task_notification`.
 *   - {@link subagentType} / {@link description} / {@link prompt}:
 *     metadata from the `tool_use.input` (`subagent_type`,
 *     `description` and `prompt` fields). Available once the canonical
 *     `assistant` message arrives with the complete input bag (the
 *     early `content_block_start` has empty input). Used for UI labels
 *     and to seed the subagent's opening request.
 *   - {@link markAnnounced} / {@link markCompleted}: idempotency
 *     guards for the workbench-facing `subagent_started` /
 *     `subagent_completed` signals.
 */
export class SubagentSpawn {
	subagentType: string | undefined;
	description: string | undefined;
	prompt: string | undefined;

	private _agentId: string | undefined;
	private _announced = false;
	private _completed = false;
	background = false;

	constructor(readonly toolUseId: string) { }

	get agentId(): string | undefined {
		return this._agentId;
	}

	/** Whether one of the completion routes has already closed this spawn out. */
	get completed(): boolean {
		return this._completed;
	}

	/**
	 * Set the SDK's agent id for this spawn. First-writer-wins: once
	 * set, subsequent calls are no-ops. Multiple call sites converge on
	 * the same value (canUseTool's `options.agentID`, the strategy chain,
	 * and transcript priming all surface the SDK's single identity), so
	 * the invariant is enforced here rather than at every caller.
	 */
	setAgentId(agentId: string): void {
		if (this._agentId === undefined) {
			this._agentId = agentId;
		}
	}

	markAnnounced(): boolean {
		if (this._announced) {
			return false;
		}
		this._announced = true;
		return true;
	}

	markCompleted(): boolean {
		if (this._completed) {
			return false;
		}
		this._completed = true;
		return true;
	}
}

/**
 * Optional fields that may be supplied to {@link SubagentRegistry.recordSpawn}.
 * Each field is **first-writer-wins**: once set on a spawn, subsequent
 * `recordSpawn` calls with a new value for the same field are ignored.
 * The invariant is enforced inside the registry so multiple converging
 * call sites (canUseTool, canonical assistant, transcript priming)
 * agree on a single record per `toolUseId`.
 */
export interface ISubagentSpawnInit {
	readonly agentId?: string;
	readonly subagentType?: string;
	readonly description?: string;
	readonly prompt?: string;
}

/**
 * Per-parent-session collection of {@link SubagentSpawn} entries plus
 * reverse indexes from SDK task ids and inner `tool_use_id`s to their
 * parent Task. Owned by `ClaudeAgentSession` (the registry dies with
 * the session).
 *
 * Replaces the singleton-keyed-by-URI `IClaudeSubagentResolver`
 * tracker surface from earlier Phase 12: lifecycle is implicit, no
 * `parentUri` parameter on any method, no `disposeParent` needed, and
 * the parallel `noteX` / `getX` accessor pairs collapse to one
 * `getSpawn(toolUseId)` plus direct field reads/writes on the spawn.
 */
export class SubagentRegistry extends Disposable {
	private readonly _spawns = new Map<string, SubagentSpawn>();
	private readonly _taskToSpawn = new Map<string, string>();
	private readonly _innerToParent = new Map<string, string>();

	override dispose(): void {
		this._spawns.clear();
		this._taskToSpawn.clear();
		this._innerToParent.clear();
		super.dispose();
	}

	/**
	 * Insert a spawn (or return the existing one) for `toolUseId`.
	 * Any fields supplied in `init` are written to the spawn under
	 * first-writer-wins semantics (see {@link ISubagentSpawnInit}).
	 * Idempotent so live writes (canUseTool / strategy resolution /
	 * transcript priming / canonical assistant) can converge on the
	 * same record.
	 */
	recordSpawn(toolUseId: string, init?: ISubagentSpawnInit): SubagentSpawn {
		let spawn = this._spawns.get(toolUseId);
		if (!spawn) {
			spawn = new SubagentSpawn(toolUseId);
			this._spawns.set(toolUseId, spawn);
		}
		if (init?.agentId !== undefined) {
			spawn.setAgentId(init.agentId);
		}
		if (init?.subagentType !== undefined && spawn.subagentType === undefined) {
			spawn.subagentType = init.subagentType;
		}
		if (init?.description !== undefined && spawn.description === undefined) {
			spawn.description = init.description;
		}
		if (init?.prompt !== undefined && spawn.prompt === undefined) {
			spawn.prompt = init.prompt;
		}
		return spawn;
	}

	getSpawn(toolUseId: string): SubagentSpawn | undefined {
		return this._spawns.get(toolUseId);
	}

	removeSpawn(toolUseId: string): void {
		this._spawns.delete(toolUseId);
		this._evictTaskEdgesFor(toolUseId);
		this._evictInnerEdgesFor(toolUseId);
	}

	/** Correlate a `task_started.task_id` with the Task tool call that spawned it. */
	noteTask(taskId: string, toolUseId: string): void {
		if (this._spawns.has(toolUseId)) {
			this._taskToSpawn.set(taskId, toolUseId);
		}
	}

	/** Resolve a later `task_updated` frame, which carries only the SDK task id. */
	getSpawnForTask(taskId: string): SubagentSpawn | undefined {
		const toolUseId = this._taskToSpawn.get(taskId);
		return toolUseId !== undefined ? this._spawns.get(toolUseId) : undefined;
	}

	/** Mapper records the parent of an inner `tool_use` block when an inner subagent message arrives. */
	noteInnerTool(innerToolUseId: string, parentToolUseId: string): void {
		this._innerToParent.set(innerToolUseId, parentToolUseId);
	}

	/** canUseTool reads this to attach `parentToolCallId` onto a `pending_confirmation` / `ChatInputRequested`. */
	getParentSpawn(innerToolUseId: string): SubagentSpawn | undefined {
		const parentId = this._innerToParent.get(innerToolUseId);
		return parentId !== undefined ? this._spawns.get(parentId) : undefined;
	}

	/**
	 * Liveness query: is at least one *background* spawn still open — i.e.
	 * recorded, flipped to background mode, and not yet closed by its deferred
	 * `system.task_notification`?
	 *
	 * Purely non-destructive: unlike {@link drainForegroundSpawns} and
	 * {@link drainAllSpawns} (which are orphan *cleanup* at the turn and
	 * process-rebuild boundaries) this mutates nothing and may be polled
	 * freely.
	 *
	 * Why it exists: a background subagent is an in-process task of the warm
	 * CLI subprocess, so its life is bound to that subprocess. The lifecycle
	 * rules that tear a subprocess down keyed only off "is a foreground turn in
	 * flight" (the prompt queue), and therefore killed background work the
	 * moment the user's turn finished. This is the missing half of that
	 * liveness signal.
	 *
	 * Task age is not a completion signal. Keep unfinished work alive until
	 * the SDK reports completion or the owning process is gone.
	 */
	hasOpenBackgroundSpawns(): boolean {
		for (const spawn of this._spawns.values()) {
			if (spawn.background && !spawn.completed) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Turn-end cleanup: remove and return foreground spawns whose
	 * completion never closed them. Background spawns survive across
	 * turns by design (their completion arrives later via
	 * `system.task_notification`). Inner-edge entries pointing at
	 * drained spawns are evicted too. Caller logs each returned orphan.
	 */
	drainForegroundSpawns(): readonly SubagentSpawn[] {
		const drained: SubagentSpawn[] = [];
		for (const spawn of this._spawns.values()) {
			if (!spawn.background) {
				drained.push(spawn);
			}
		}
		for (const spawn of drained) {
			this._spawns.delete(spawn.toolUseId);
			this._evictTaskEdgesFor(spawn.toolUseId);
			this._evictInnerEdgesFor(spawn.toolUseId);
		}
		return drained;
	}

	/**
	 * Process-rebuild cleanup: remove and return **every** spawn still open,
	 * background ones included.
	 *
	 * Unlike {@link drainForegroundSpawns} — the per-turn boundary, which
	 * deliberately preserves background spawns because their completion arrives
	 * later via `system.task_notification` — this is the boundary at which the
	 * CLI subprocess that owned those spawns is replaced. Both completion
	 * routes (a foreground `tool_result` and a deferred background
	 * `task_notification`) belong to the dead process, so neither can ever
	 * arrive for these spawns and every one of them is definitively orphaned.
	 */
	drainAllSpawns(): readonly SubagentSpawn[] {
		const drained = [...this._spawns.values()];
		this._spawns.clear();
		this._taskToSpawn.clear();
		this._innerToParent.clear();
		return drained;
	}

	/**
	 * Replay-path bulk populate: scan a parent transcript for the
	 * SDK's synthetic `agentId: <hex>` suffix on Task/Agent tool_result
	 * text blocks and record each `(toolUseId, agentId)` pair. Idempotent.
	 */
	primeFromTranscript(transcript: readonly Turn[]): void {
		for (const [toolCallId, agentId] of scanTranscriptForAgentIds(transcript)) {
			this.recordSpawn(toolCallId, { agentId });
		}
	}

	private _evictInnerEdgesFor(parentToolUseId: string): void {
		for (const [innerId, parentId] of this._innerToParent) {
			if (parentId === parentToolUseId) {
				this._innerToParent.delete(innerId);
			}
		}
	}

	private _evictTaskEdgesFor(toolUseId: string): void {
		for (const [taskId, spawnId] of this._taskToSpawn) {
			if (spawnId === toolUseId) {
				this._taskToSpawn.delete(taskId);
			}
		}
	}
}

/**
 * Pure scan: locate `(toolCallId, agentId)` pairs encoded by the SDK
 * in Task/Agent `tool_result` text blocks. Exported for the resolver's
 * `TextSuffixStrategy` (which scans on demand) — registry priming
 * uses {@link SubagentRegistry.primeFromTranscript}.
 */
export function scanTranscriptForAgentIds(transcript: readonly Turn[]): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const turn of transcript) {
		for (const part of turn.responseParts) {
			const pair = extractAgentIdPair(part);
			if (pair) {
				out.set(pair.toolCallId, pair.agentId);
			}
		}
	}
	return out;
}

function extractAgentIdPair(part: ResponsePart): { toolCallId: string; agentId: string } | undefined {
	if (part.kind !== ResponsePartKind.ToolCall) {
		return undefined;
	}
	const state = part.toolCall;
	if (!SUBAGENT_TOOL_NAMES.has(state.toolName)) {
		return undefined;
	}
	if (state.status !== ToolCallStatus.Completed && state.status !== ToolCallStatus.PendingResultConfirmation) {
		return undefined;
	}
	const content = state.content;
	if (!content) {
		return undefined;
	}
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type !== ToolResultContentType.Text) {
			continue;
		}
		const m = SUBAGENT_ID_SUFFIX_REGEX.exec(block.text);
		if (m) {
			return { toolCallId: state.toolCallId, agentId: m[1] };
		}
	}
	return undefined;
}
