/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentInfo, McpServerStatus, PermissionMode, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage, SlashCommand, WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { localize } from '../../../../nls.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IReference, toDisposable } from '../../../../base/common/lifecycle.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { ClaudeRuntimeEffortLevel } from '../../common/claudeModelConfig.js';
import { AgentSignal } from '../../common/agent.js';
import type { IAgentHostClientTelemetryContext } from '../../common/agentHostTelemetry.js';
import { ISessionDatabase } from '../../common/sessionDataService.js';
import { MessageKind, type PendingMessage } from '../../common/state/sessionState.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { ClaudePromptQueue, IPendingSdkMessage } from './claudePromptQueue.js';
import { ClaudeSdkMessageRouter } from './claudeSdkMessageRouter.js';
import { type SubagentRegistry } from './claudeSubagentRegistry.js';
import { mapSubagentProcessRebuild } from './claudeSubagentSignals.js';

/**
 * Callback the agent supplies via {@link ClaudeSdkPipeline.attachRematerializer}
 * so the pipeline can rebuild its underlying {@link WarmQuery} /
 * {@link AbortController} on abort or crash recovery without depending on
 * the materializer service directly. The callback MUST start the SDK in
 * `resume` mode (i.e. pass `Options.resume = sessionId` instead of
 * `Options.sessionId`) and MUST NOT re-fire the agent's
 * `onDidMaterializeChat` event — that event is once-per-provisional
 * promotion (see `claudeAgent.ts` materialize path).
 */
export interface IRematerializer {
	(reason: 'restart' | 'recover'): Promise<{ readonly warm: WarmQuery; readonly abortController: AbortController }>;
}

/**
 * Owns one SDK Query lifecycle for a Claude session. Knows nothing about
 * protocol turns, the workbench mapper, file-edit observers, or
 * permission registries — the consuming session subscribes to
 * {@link onDidProduceSignal} and fans out to its own collaborators.
 *
 * Responsibilities:
 *   • Hold the {@link WarmQuery} + {@link AbortController} for the
 *     active SDK subprocess. Both are mutable: rebind on abort/crash
 *     recovery via the supplied {@link IRematerializer}.
 *   • Drive a {@link ClaudePromptQueue} whose iterable is handed to
 *     `WarmQuery.query()`.
 *   • Apply the current model / effort / permissionMode to the SDK
 *     eagerly when the consumer calls {@link setModel} /
 *     {@link setEffort} / {@link setPermissionMode}. The SDK only takes
 *     these into account on the NEXT user request, so mid-turn calls
 *     are safe — no need to align the SDK setter with the prompt yield.
 *     Re-applied to a fresh Query on rebind.
 *   • Drain the SDK message stream, dispatch each message to the
 *     {@link ClaudeSdkMessageRouter}, settle the matching entry's
 *     deferred on `result`. An intermediate result during steering
 *     preemption closes the interrupted protocol turn and promotes the
 *     pending steering message into a fresh visible turn; the terminal
 *     result closes that new turn (CONTEXT.md M10). Output that keeps
 *     coming after the queue drained is owned by {@link IPostDrainTurn}.
 *
 * Disposing the pipeline aborts the controller (terminating the SDK
 * subprocess per `sdk.d.ts:982`) and async-disposes the WarmQuery.
 */
/**
 * Snapshot of everything the SDK has currently resolved for this
 * session. Returned by {@link ClaudeSdkPipeline.snapshotResolvedCustomizations}.
 */
export interface ISdkResolvedCustomizations {
	readonly commands: readonly SlashCommand[];
	readonly agents: readonly AgentInfo[];
	readonly mcpServers: readonly McpServerStatus[];
	/**
	 * Native plugins the live session actually loaded, as reported by the
	 * SDK `system/init` message. Used to filter the disk-discovered native
	 * plugins post-materialize: a plugin declared in `enabledPlugins` but
	 * absent here (bad path, manifest error, untrusted workspace) is hidden.
	 *
	 * `source` is the plugin id (`<plugin>@<marketplace>`) and is the
	 * authoritative match key — the SDK's `path` is unreliable for
	 * workspace-`local`-scoped plugins (it can report a non-cache path). The
	 * SDK `.d.ts` types the element as `{ name, path }` but the runtime adds
	 * `source`, so it is captured as optional.
	 */
	readonly plugins: readonly { readonly name: string; readonly path: string; readonly source?: string }[];
}

/**
 * The Claude SDK runtime exposes this control-plane method, but the currently
 * published TypeScript declaration omits it. Keep the compatibility shim
 * deliberately narrow so an older SDK can degrade to the transcript summary
 * without weakening the rest of the strongly-typed Query surface.
 */
interface IQueryWithSessionTitleGeneration extends Query {
	generateSessionTitle?(description: string, options?: { readonly persist?: boolean }): Promise<string>;
}

/**
 * Turn identity for SDK output that arrives while the prompt queue is drained.
 *
 * The queue only holds entries the host itself pushed (`send` / `injectSteering`),
 * so it says nothing about the stream once the matching `result` settled — yet
 * the SDK keeps producing: a background subagent reports late, and the harness
 * runs its own top-level turn when that subagent's completion wakes it. Both
 * need a turn id or {@link ClaudeSdkMessageRouter.handle} drops the message
 * whole, which is why neither used to reach the chat at all.
 *
 * `isAutonomous` distinguishes the two:
 *   • `false` — the turn the settled entry owned. It is closed already, so its
 *     id is only an attribution anchor for output that belongs to work that
 *     turn started (a background subagent's late messages, its
 *     `task_notification`). Those signals carry `parentToolCallId` and the host
 *     re-keys them onto the subagent's own chat, so nothing surfaces on the
 *     closed turn.
 *   • `true` — a turn this pipeline opened for the harness's own top-level
 *     continuation, and must therefore close on the next `result`.
 */
interface IPostDrainTurn {
	readonly turnId: string;
	readonly stopWatch: StopWatch;
	readonly clientContext?: IAgentHostClientTelemetryContext;
	readonly isAutonomous: boolean;
}

/**
 * How long a rebind waits for the outgoing subprocess to actually exit before
 * it materializes the replacement anyway. A healthy CLI shutdown is well under
 * a second, and in the `recover` case the process is usually dead already, so
 * this only ever fires for a wedged subprocess. Bounded on purpose: resuming
 * from a transcript that is missing its tail is bad, but never rebinding at all
 * (a session that answers nothing, forever) is worse.
 */
const REBIND_EXIT_TIMEOUT_MS = 10_000;

/**
 * True for SDK output that belongs to the harness's own top-level model turn.
 * Subagent-scoped envelopes (`parent_tool_use_id`) are excluded because they
 * render in the subagent's chat, and every lifecycle / status `system` envelope
 * is excluded because those trail a settled turn as a matter of course — a
 * turn opened for one would be empty.
 */
function isTopLevelModelOutput(message: SDKMessage): boolean {
	return (message.type === 'stream_event' || message.type === 'assistant') && message.parent_tool_use_id === null;
}

export class ClaudeSdkPipeline extends Disposable {
	private _shutdownPromise: Promise<void> | undefined;
	/**
	 * Ask the live Claude backend to generate a title for `description`.
	 *
	 * This is a Query control request, not a second user turn, and it runs
	 * with `persist: false` so the backend answers with a title without
	 * appending a custom-title entry to the session's own transcript — the
	 * title is host-owned state, and the harness transcript must stay exactly
	 * as the user's turns left it.
	 *
	 * `undefined` means the installed SDK predates the control method and
	 * callers should keep whatever title they already have.
	 */
	async generateSessionTitle(description: string): Promise<string | undefined> {
		const query = await this._ensureQueryBound() as IQueryWithSessionTitleGeneration;
		if (!query.generateSessionTitle) {
			return undefined;
		}
		const title = await query.generateSessionTitle(description, { persist: false });
		return title.trim() || undefined;
	}

	/**
	 * Phase 11 — hot-swap the SDK's plugin set in place via
	 * `Query.reloadPlugins()`. Commands / agents / mcpServers added or
	 * removed by the new plugin set become visible to the SDK
	 * immediately, without a session restart. Throws if the query is
	 * not yet bound (session not materialized).
	 */
	async reloadPlugins(): Promise<void> {
		const query = await this._ensureQueryBound();
		await query.reloadPlugins();
	}

	/**
	 * Phase 11 — snapshot the SDK's currently-resolved customization
	 * surface (slash commands / skills, subagents, MCP servers). This
	 * is the SDK's view of "what does this session actually have
	 * access to right now" — covers everything the SDK loaded itself
	 * (`~/.claude/**`, `.claude/agents/`, `settings.json` MCP) AND
	 * anything we fed in via `Options.plugins`. The host overlays
	 * client-side enablement separately.
	 */
	async snapshotResolvedCustomizations(): Promise<ISdkResolvedCustomizations> {
		const query = await this._ensureQueryBound();
		const [commands, agents, mcpServers] = await Promise.all([
			query.supportedCommands(),
			query.supportedAgents(),
			query.mcpServerStatus(),
		]);
		return { commands, agents, mcpServers, plugins: this._initPlugins };
	}

	async startMcpServer(serverName: string): Promise<boolean> {
		const query = await this._ensureQueryBound();
		return this._applyMcpServerEnablement(query, serverName, true);
	}

	async stopMcpServer(serverName: string): Promise<boolean> {
		const query = await this._ensureQueryBound();
		return this._applyMcpServerEnablement(query, serverName, false);
	}

	async reconcileMcpServerEnablement(desired: ReadonlyMap<string, boolean>): Promise<boolean> {
		const query = await this._ensureQueryBound();
		const observed = new Map((await query.mcpServerStatus()).map(server => [server.name, server.status !== 'disabled']));
		for (const [serverName, enabled] of desired) {
			// `desired` is session-scoped state, so it can name servers this
			// particular chat's query does not have (another chat that has not
			// finished connecting its servers, or a chat created after the
			// session state was published). Toggling one of those always fails
			// with `Server not found: <name>` and would take the turn down with
			// it, so only reconcile servers the live query actually reports.
			const current = observed.get(serverName);
			if (current === undefined || current === enabled) {
				continue;
			}
			if (!await this._applyMcpServerEnablement(query, serverName, enabled)) {
				return false;
			}
		}
		return true;
	}

	private async _applyMcpServerEnablement(query: Query, serverName: string, enabled: boolean): Promise<boolean> {
		if (!query.toggleMcpServer || (enabled && !query.reconnectMcpServer)) {
			return false;
		}
		await query.toggleMcpServer(serverName, enabled);
		if (enabled) {
			await query.reconnectMcpServer!(serverName);
		}
		return true;
	}

	/**
	 * Bind the SDK Query if needed, recovering a dead one first. Mirrors the
	 * gate in {@link send}: if the pipeline is marked for rebind (after an
	 * abort/crash the `_query` handle is retained for teardown but its stream
	 * is dead), rebuild via the rematerializer so pre-flight helpers never
	 * operate on a disposed stream. Then lazily bind if nothing is bound yet.
	 */
	private async _ensureQueryBound(): Promise<Query> {
		if (this._needsRebind) {
			await this._rebindQuery('recover');
		}
		if (!this._query) {
			this._bindWarmQuery();
			await this._replayCurrentConfig();
		}
		return this._query!;
	}

	/**
	 * Bind a fresh SDK stream off the current warm subprocess. The stream is
	 * long-lived: it spans every turn until a rebind swaps the subprocess (the
	 * prompt iterable parks between turns rather than ending), so {@link _query}
	 * tracks the lifetime of {@link _warm} and is only swapped here.
	 */
	private _bindWarmQuery(): Query {
		this._backgroundTasksActive = undefined;
		const query = this._warm.query(this._queue.iterable);
		this._query = query;
		return query;
	}

	/**
	 * The SDK stream bound to the current {@link _warm} subprocess, or
	 * `undefined` before the first bind. Health is tracked separately by
	 * {@link _needsRebind}: a non-`undefined` `_query` with `_needsRebind`
	 * set is a *dead* stream awaiting rebuild. Cleared only on dispose.
	 */
	private _query: Query | undefined;
	private _warm: WarmQuery;
	private _abortController: AbortController;

	/**
	 * The session's subagent spawn book. The router owns the live reads and
	 * writes; the pipeline keeps the handle only so a rebind can close out the
	 * spawns the replaced subprocess left open (see
	 * {@link mapSubagentProcessRebuild}).
	 */
	private readonly _subagents: SubagentRegistry;
	/** Undefined until this process reports its first full background-task level. */
	private _backgroundTasksActive: boolean | undefined;

	private readonly _queue: ClaudePromptQueue;

	/** Flips to `true` on the first `system:init` SDK message. Drives `Options.resume` decisions for downstream phases. */
	private _isResumed = false;

	/**
	 * Native plugins reported by the most recent `system:init` message.
	 * Captured on *every* init (including resume) so the post-materialize
	 * native-plugin filter always reflects the live set. `source` is the
	 * plugin id and is the reliable match key (see {@link ISdkResolvedCustomizations}).
	 */
	private _initPlugins: readonly { readonly name: string; readonly path: string; readonly source?: string }[] = [];

	/** Last model / effort / permission mode applied to the SDK via the runtime setters. Reset on rebind. */
	private _appliedModel: string | undefined;
	private _appliedEffort: ClaudeRuntimeEffortLevel | undefined;
	private _appliedPermissionMode: PermissionMode | undefined;

	/** Current values the consumer has asked for. Replayed to a fresh Query on bind / rebind. */
	private _currentModel: string | undefined;
	private _currentEffort: ClaudeRuntimeEffortLevel | undefined;
	private _currentPermissionMode: PermissionMode | undefined;

	private _rematerializer: IRematerializer | undefined;

	/** Set when the consumer loop ends in error (cancellation OR crash). Read by {@link send} to trigger rebind. */
	private _needsRebind = false;

	/** Tracks whether the consumer loop is currently draining {@link _query}. */
	private _consumerLoopRunning = false;

	/** Turn identity for SDK output that arrives with the prompt queue drained. See {@link IPostDrainTurn}. */
	private _postDrainTurn: IPostDrainTurn | undefined;

	private readonly _onDidProduceSignal = this._register(new Emitter<AgentSignal>());
	/**
	 * Single fan-out for every {@link AgentSignal} this session produces:
	 *   • Router-mapped per-message signals (response parts, tool calls,
	 *     pending confirmations, etc.).
	 *   • `ChatTurnComplete` / `ChatTurnStarted` actions at the steering
	 *     preemption boundary, followed by `ChatTurnComplete` when the new
	 *     turn drains.
	 */
	readonly onDidProduceSignal: Event<AgentSignal> = this._onDidProduceSignal.event;

	private readonly _onDidRateLimitInfo = this._register(new Emitter<SDKRateLimitInfo>());
	/** Account-level Claude plan utilization, independent of protocol turn ownership. */
	readonly onDidRateLimitInfo: Event<SDKRateLimitInfo> = this._onDidRateLimitInfo.event;

	private readonly _router: ClaudeSdkMessageRouter;

	constructor(
		readonly sessionId: string,
		readonly chatChannelUri: URI,
		resource: URI,
		warm: WarmQuery,
		abortController: AbortController,
		dbRef: IReference<ISessionDatabase>,
		subagents: SubagentRegistry,
		clientToolOwner: ((toolName: string) => string | undefined) | undefined = undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._subagents = subagents;
		this._warm = warm;
		this._abortController = abortController;
		this._wireAbortHandler(abortController);
		this._queue = this._register(instantiationService.createInstance(
			ClaudePromptQueue,
			sessionId,
			() => this._abortController.signal,
		));
		this._router = this._register(instantiationService.createInstance(
			ClaudeSdkMessageRouter, chatChannelUri, resource, dbRef, subagents, clientToolOwner,
		));
		this._register(this._router.onDidProduceSignal(s => this._onDidProduceSignal.fire(s)));
		// Dispose chain → abort → SDK cleanup. Reads the *current*
		// `_abortController` so a swap aborts the live subprocess.
		this._register(toDisposable(() => this._abortController.abort()));
		this._register(toDisposable(() => {
			if (this._shutdownPromise) {
				return;
			}
			void Promise.resolve(this._warm[Symbol.asyncDispose]()).catch((err: unknown) =>
				this._logService.warn(`[ClaudeSdkPipeline] WarmQuery dispose failed: ${err}`));
		}));
	}

	get isResumed(): boolean { return this._isResumed; }

	get isAborted(): boolean { return this._abortController.signal.aborted; }

	/**
	 * Whether a turn is currently in flight or queued. False between turns (the
	 * warm query parks with a drained queue). Used by non-destructive idle
	 * release to avoid tearing the pipeline down mid-turn.
	 */
	get hasActiveTurn(): boolean { return !this._queue.isEmpty; }

	/**
	 * Whether a background subagent is still running inside the warm
	 * subprocess. Deliberately a *sibling* of {@link hasActiveTurn} rather than
	 * folded into it: `hasActiveTurn` means "a foreground turn is in flight or
	 * queued" and is read by steering, preemption and abort logic that must not
	 * start treating background work as a live turn.
	 *
	 * The two are only combined at the teardown gates
	 * (`ClaudeAgent._canReleaseChat` / `_releaseChat`), where both answer the
	 * same question: would tearing this pipeline down destroy work in progress?
	 * A background subagent is an in-process task of this very subprocess
	 * (sdk.d.ts: "in-process background subagent"), so releasing the session
	 * aborts it and its `system.task_notification` can never arrive.
	 *
	 * The SDK's full task level supersedes edge bookends as soon as it arrives.
	 * Older SDKs without that signal fall back to open registry entries, never
	 * task age. Ambient housekeeping does not keep a session alive.
	 */
	get hasOpenBackgroundSubagents(): boolean {
		return this._backgroundTasksActive ?? this._subagents.hasOpenBackgroundSpawns();
	}

	/**
	 * Abort the live SDK subprocess and **await its actual exit**.
	 *
	 * `WarmQuery[Symbol.asyncDispose]()` calls the query's `close()`, which
	 * *fires* the SDK cleanup but does not await it — so it returns while the
	 * subprocess is still shutting down (and still re-flushing its transcript).
	 * `Query.return()` awaits the same (memoized) cleanup, which in turn awaits
	 * `transport.waitForExit()` — the OS process actually exiting after its
	 * final transcript flush. Awaiting that is what lets a caller safely reuse
	 * the `--session-id` (the CLI rejects a fresh spawn while `<id>.jsonl`
	 * still exists, and the dying process would otherwise recreate it).
	 */
	shutdownAndWait(): Promise<void> {
		return this._shutdownPromise ??= (async () => {
			this._abortController.abort();
			try {
				await this._warm[Symbol.asyncDispose]();
				await this._query?.return(undefined);
			} catch (err) {
				this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] shutdownAndWait: teardown failed`, err);
			}
		})();
	}

	/**
	 * Phase 10 \u2014 narrow public wrapper around the internal
	 * {@link _rebindQuery} so {@link ClaudeAgentSession.rebindForClientTools}
	 * can drive a yield-restart without exposing the private rebind
	 * machinery to every collaborator.
	 */
	rebindForRestart(): Promise<void> {
		return this._rebindQuery('restart');
	}

	/**
	 * Phase 10 — update the resolver the stream mapper uses to stamp the
	 * owning workbench `clientId` onto subsequent `ChatToolCallStart` events.
	 */
	setClientToolOwner(clientToolOwner: ((toolName: string) => string | undefined) | undefined): void {
		this._router.setClientToolOwner(clientToolOwner);
	}

	/** Attach the rematerializer hook for abort / crash recovery. Optional — tests that exercise only the dispose path skip this. */
	attachRematerializer(rematerializer: IRematerializer): void {
		this._rematerializer = rematerializer;
	}

	/**
	 * Seed the current + applied config from materialize-time `Options`.
	 * The SDK already starts with these values, so we mark them as both
	 * "current" (what the consumer wants) and "applied" (what the SDK has)
	 * to avoid a redundant `setModel` / `applyFlagSettings` on first use.
	 */
	seedCurrentConfig(model: string | undefined, effort: ClaudeRuntimeEffortLevel | undefined, permissionMode: PermissionMode | undefined): void {
		this._currentModel = model;
		this._currentEffort = effort;
		this._currentPermissionMode = permissionMode;
		this._appliedModel = model;
		this._appliedEffort = effort;
		this._appliedPermissionMode = permissionMode;
	}

	/**
	 * Eagerly push a model change to the SDK. Safe to call mid-turn:
	 * `Query.setModel` only takes effect on the NEXT user request. No-op
	 * if the value is unchanged. Buffered as `_currentModel` until the
	 * Query is bound (and replayed on rebind).
	 */
	async setModel(model: string): Promise<void> {
		this._currentModel = model;
		if (this._query && !this._needsRebind && model !== this._appliedModel) {
			try {
				await this._query.setModel(model);
				this._appliedModel = model;
			} catch (err) {
				this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] setModel failed: ${err}`);
			}
		}
	}

	/**
	 * Eagerly push an effort-level change to the SDK via
	 * `applyFlagSettings({ effortLevel })`. Same mid-turn safety as
	 * {@link setModel}.
	 *
	 * `undefined` means "clear the effort the SDK is currently applying" —
	 * issued as `applyFlagSettings({ effortLevel: null })` (sdk.d.ts:2263:
	 * passing `null` clears a key from the flag layer). This is what makes a
	 * switch to a model that does not support reasoning effort (e.g. Haiku)
	 * drop a `'high'` left over from a prior effort-capable model instead of
	 * replaying it onto a model the API will 400 on.
	 */
	async setEffort(effort: ClaudeRuntimeEffortLevel | undefined): Promise<void> {
		this._currentEffort = effort;
		if (this._query && !this._needsRebind && effort !== this._appliedEffort) {
			try {
				await this._query.applyFlagSettings({ effortLevel: effort ?? null });
				this._appliedEffort = effort;
			} catch (err) {
				this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] setEffort failed: ${err}`);
			}
		}
	}

	/**
	 * Advance the *desired* model / effort for the NEXT rebind WITHOUT pushing
	 * them to the live Query.
	 *
	 * A cross-transport provider switch is about to discard the running
	 * subprocess (it is pinned to the old transport / credential), so
	 * hot-swapping it via {@link setModel} / {@link setEffort} is pointless —
	 * and would 400 on a model the old transport does not serve. But
	 * {@link _currentModel} / {@link _currentEffort} must still move to the new
	 * selection: after the rebuild, {@link _rebindQuery} resets the applied
	 * cache and {@link _replayCurrentConfig} re-asserts `_currentModel` onto the
	 * fresh Query. The rebuild resumes the transcript, which replays the
	 * pre-switch `/model`; without advancing the buffer here that stale replay
	 * would win and the rebuilt subprocess would silently run the old model on
	 * the new transport (→ `model_not_supported`).
	 */
	bufferConfigForRebind(model: string, effort: ClaudeRuntimeEffortLevel | undefined): void {
		this._currentModel = model;
		this._currentEffort = effort;
	}

	/**
	 * Queue a user prompt for the SDK. Resolves when the matching
	 * `result` message arrives.
	 *
	 * If a previous turn aborted or crashed, this triggers a rebind via
	 * the attached rematerializer before queueing.
	 */
	async send(prompt: SDKUserMessage, turnId: string, clientContext?: IAgentHostClientTelemetryContext): Promise<void> {
		if (this._needsRebind) {
			await this._rebindQuery('recover');
		}
		if (this._abortController.signal.aborted) {
			throw new CancellationError();
		}
		if (!this._query) {
			this._bindWarmQuery();
			await this._replayCurrentConfig();
		}
		this._ensureConsumerLoop();
		const entry: IPendingSdkMessage = {
			sdkMessage: prompt,
			sdkUuid: typeof prompt.uuid === 'string' ? prompt.uuid : turnId,
			turnId,
			clientContext,
			stopWatch: StopWatch.create(false),
			deferred: new DeferredPromise<void>(),
		};
		return this._queue.push(entry);
	}

	/**
	 * Push a `priority: 'now'` steering message into the iterable. The
	 * caller pre-builds the {@link SDKUserMessage}. The complete protocol
	 * {@link PendingMessage} is retained until the SDK emits the intermediate
	 * result that proves the interrupted request has ended; at that boundary
	 * the pending bubble is atomically promoted into a permanent user turn.
	 *
	 * No-op if the pipeline is aborted or no in-flight / queued request exists.
	 */
	injectSteering(prompt: SDKUserMessage, steeringMessage: PendingMessage): void {
		if (this._abortController.signal.aborted) {
			this._logService.warn(`[Claude:${this.sessionId}] injectSteering: dropped (controller aborted) id=${steeringMessage.id}`);
			return;
		}
		const parent = this._queue.peekParent();
		if (!parent) {
			this._logService.warn(`[Claude:${this.sessionId}] injectSteering: dropped (no in-flight turn) id=${steeringMessage.id}`);
			return;
		}
		const sdkUuid = typeof prompt.uuid === 'string' ? prompt.uuid : steeringMessage.id;
		// Steering deferreds aren't observed by anyone (the agent's send
		// promise is the original entry's deferred); attach a no-op catch
		// so a `failAll` rejection on abort/crash doesn't surface as an
		// unhandled rejection.
		this._queue.push({
			sdkMessage: prompt,
			sdkUuid,
			// The SDK transcript keys this top-level user message by the same
			// uuid. Reusing it as the live turn id keeps live and replayed
			// transcript identities stable.
			turnId: steeringMessage.id,
			clientContext: parent.clientContext,
			stopWatch: StopWatch.create(false),
			deferred: new DeferredPromise<void>(),
			steeringMessage,
		}).catch(() => { /* expected on abort/crash */ });
		this._logService.info(`[Claude:${this.sessionId}] injectSteering: enqueued id=${steeringMessage.id} sdkUuid=${sdkUuid} parentTurnId=${parent.turnId}`);
	}

	/**
	 * Cancel the in-flight SDK turn via the abort controller. Drops every
	 * pending entry's deferred (rejected with `CancellationError`),
	 * marks the pipeline for rebind on next {@link send}. Idempotent.
	 *
	 * Safe to call during rebind: {@link _rebindQuery} swaps in a fresh
	 * placeholder {@link AbortController} before awaiting the
	 * rematerializer, so an abort issued during recovery lands on that
	 * placeholder and is honored when the freshly-built pair arrives
	 * (the rebind discards the new pair and surfaces a cancellation).
	 */
	abort(): void {
		if (this._abortController.signal.aborted) {
			return;
		}
		this._abortController.abort();
		this._queue.failAll(new CancellationError());
		this._cancelAutonomousTurn();
		// Mark unhealthy but keep the `_query` handle: the next `send` rebinds,
		// and `shutdownAndWait` still needs it to await the subprocess exit.
		this._needsRebind = true;
	}

	/**
	 * Forwards to {@link Query.setPermissionMode} once the query is
	 * bound; the value is also remembered so it's re-applied after a
	 * rebind. Permission mode is whole-session (not per-entry).
	 */
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		this._currentPermissionMode = mode;
		if (this._query && !this._needsRebind && mode !== this._appliedPermissionMode) {
			await this._query.setPermissionMode(mode);
			this._appliedPermissionMode = mode;
		}
	}

	private _wireAbortHandler(controller: AbortController): void {
		controller.signal.addEventListener('abort', () => {
			if (this._abortController === controller) {
				this._backgroundTasksActive = false;
			}
			this._queue.notifyAborted();
		}, { once: true });
	}

	private _ensureConsumerLoop(): void {
		if (this._consumerLoopRunning) {
			return;
		}
		this._consumerLoopRunning = true;
		this._runConsumerLoop();
	}

	/**
	 * Runs one {@link _processMessages} pass over the live {@link _query} and,
	 * when it ends, decides whether to hand off to a fresh pass.
	 *
	 * A rebind ({@link _rebindQuery}) swaps in a new `_query` while the loop is
	 * still draining the OLD (now-disposed) one; that old pass then ends with
	 * the "stream ended without a result" guard. Because `_consumerLoopRunning`
	 * stays `true` for the whole handoff, the {@link send} that queued the
	 * post-rebind prompt already saw {@link _ensureConsumerLoop} no-op — so if
	 * this pass just stopped, nothing would ever read the new query and `send`
	 * would hang. Detect the swap (current `_query` differs from the one this
	 * pass bound) and re-arm for it instead. Abort / crash / dispose leave
	 * `_query` cleared (or the store disposed), so they fall through to stop.
	 */
	private _runConsumerLoop(): void {
		const boundQuery = this._query;
		void this._processMessages()
			.catch(err => this._logService.error(`[ClaudeSdkPipeline:${this.sessionId}] _processMessages crashed: ${err}`))
			.finally(() => {
				if (!this._store.isDisposed && this._query && this._query !== boundQuery) {
					this._runConsumerLoop();
				} else {
					this._consumerLoopRunning = false;
				}
			});
	}

	/**
	 * Push the current model / effort / permissionMode to the SDK if they
	 * diverge from what was last applied. Called after binding a fresh
	 * Query (initial first-send and after rebind). Failures are logged.
	 */
	private async _replayCurrentConfig(): Promise<void> {
		try {
			if (this._currentModel !== undefined && this._currentModel !== this._appliedModel) {
				await this._query?.setModel(this._currentModel);
				this._appliedModel = this._currentModel;
			}
			if (this._currentEffort !== undefined && this._currentEffort !== this._appliedEffort) {
				await this._query?.applyFlagSettings({ effortLevel: this._currentEffort });
				this._appliedEffort = this._currentEffort;
			}
			if (this._currentPermissionMode !== undefined && this._currentPermissionMode !== this._appliedPermissionMode) {
				await this._query?.setPermissionMode(this._currentPermissionMode);
				this._appliedPermissionMode = this._currentPermissionMode;
			}
		} catch (err) {
			this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] _replayCurrentConfig failed: ${err}`);
		}
	}

	/**
	 * Wait for the outgoing SDK subprocess to actually exit, bounded by
	 * {@link REBIND_EXIT_TIMEOUT_MS}.
	 *
	 * A rebind rebuilds the session in `resume` mode, which makes the SDK read
	 * this session's transcript back out of the `SessionStore` and materialize
	 * a temp dir for the fresh CLI. The outgoing subprocess writes the tail of
	 * that transcript as it shuts down, so materializing the replacement first
	 * races that final flush: the new CLI resumes onto a truncated — often
	 * near-empty — snapshot, and the session comes back with no memory of what
	 * it was doing (a turn that produces no output at all).
	 *
	 * Waiting is a two-step, exactly as {@link shutdownAndWait} documents:
	 * `WarmQuery[Symbol.asyncDispose]()` only *fires* the SDK cleanup, while
	 * `Query.return()` awaits it through to `transport.waitForExit()` — the OS
	 * process actually exiting after its last flush.
	 *
	 * Never rejects: a teardown failure or a subprocess that refuses to die is
	 * logged and the rebind continues. Losing the transcript tail is the very
	 * bug this guards against, but wedging the rebind forever would take the
	 * whole session down instead of one turn.
	 */
	private async _awaitPreviousWarmExit(reason: 'restart' | 'recover', oldWarm: WarmQuery, oldQuery: Query | undefined): Promise<void> {
		const exited = (async () => {
			await oldWarm[Symbol.asyncDispose]();
			await oldQuery?.return(undefined);
			return true;
		})().catch((err: unknown) => {
			this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] rebind (${reason}): previous WarmQuery teardown failed: ${err}`);
			return true;
		});
		if (await raceTimeout(exited, REBIND_EXIT_TIMEOUT_MS) === undefined) {
			this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] rebind (${reason}): previous subprocess did not exit within ${REBIND_EXIT_TIMEOUT_MS}ms; resuming anyway (transcript tail may be missing)`);
		}
	}

	/**
	 * Dispose the dead SDK plumbing and rebuild via the agent-supplied
	 * rematerializer in `resume` mode. Re-applies the current model /
	 * effort / permission mode to the fresh Query.
	 *
	 * Ordering is load-bearing: the outgoing subprocess must be *gone* before
	 * the replacement is materialized. See {@link _awaitPreviousWarmExit}.
	 */
	private async _rebindQuery(reason: 'restart' | 'recover'): Promise<void> {
		if (!this._rematerializer) {
			throw new Error(`ClaudeSdkPipeline.rebind: no rematerializer attached (reason=${reason})`);
		}
		const oldWarm = this._warm;
		const oldQuery = this._query;
		const oldController = this._abortController;
		// Install a placeholder controller BEFORE awaiting the
		// rematerializer so a concurrent {@link abort} has a live target
		// instead of returning early as idempotent against the already-
		// aborted old controller.
		const placeholder = new AbortController();
		this._abortController = placeholder;
		// Drop ownership of the outgoing stream first. Tearing it down ends its
		// `for await`, and the consumer loop must read that as "a rebind
		// retired me" (return quietly) rather than "the stream died"
		// (`failAll` on entries the rebind is about to replay). This is the
		// same `_query`-identity handoff the loop already uses post-rebind.
		this._query = undefined;
		this._backgroundTasksActive = false;
		await this._awaitPreviousWarmExit(reason, oldWarm, oldQuery);
		const built = await this._rematerializer(reason).catch((err: unknown) => {
			// The outgoing subprocess is gone, but `_warm` still points at it,
			// so put its controller back: `_abortController` must stay paired
			// with `_warm` for abort()/dispose, and the orphaned placeholder
			// would answer for neither. The pipeline stays marked for recovery
			// so the next send retries the rebind.
			this._abortController = oldController;
			this._needsRebind = true;
			if (placeholder.signal.aborted) {
				oldController.abort();
				this._queue.failAll(new CancellationError());
			}
			throw err;
		});
		// Dispose may have run while we were awaiting the rematerializer.
		// The dispose chain has already torn down the OLD warm/controller;
		// the freshly-built pair would otherwise leak its subprocess. Mirror
		// the post-await abort gate in `_materializeProvisional`.
		if (this._store.isDisposed) {
			built.abortController.abort();
			void Promise.resolve(built.warm[Symbol.asyncDispose]()).catch((err: unknown) =>
				this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] rebind-after-dispose: warm dispose failed: ${err}`));
			throw new CancellationError();
		}
		// Abort issued while we were awaiting the rematerializer landed on
		// the placeholder. Discard the freshly-built pair and surface a
		// cancellation to the in-flight `send`.
		if (placeholder.signal.aborted) {
			built.abortController.abort();
			void Promise.resolve(built.warm[Symbol.asyncDispose]()).catch((err: unknown) =>
				this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] rebind-aborted: warm dispose failed: ${err}`));
			this._queue.failAll(new CancellationError());
			this._needsRebind = true;
			throw new CancellationError();
		}
		this._warm = built.warm;
		this._abortController = built.abortController;
		this._wireAbortHandler(built.abortController);
		this._queue.resetForRebind();
		this._needsRebind = false;
		// New SDK starts with the materializer's `Options.model` / effort /
		// permissionMode but we don't trust that to match `_currentModel`
		// etc. — reset the applied cache and let `_replayCurrentConfig`
		// push whatever the consumer last set.
		this._appliedModel = undefined;
		this._appliedEffort = undefined;
		this._appliedPermissionMode = undefined;
		this._bindWarmQuery();
		this._closeOrphanedSubagents(reason);
		await this._replayCurrentConfig();
	}

	/**
	 * The subprocess just swapped, so every subagent spawn still open belonged
	 * to the dead one and can never report its own completion. Close their
	 * chats through the ordinary `subagent_completed` route so the host's own
	 * reduction runs (turn ended, session summary re-aggregated, `InProgress`
	 * cleared) — nothing here mutates state directly.
	 */
	private _closeOrphanedSubagents(reason: 'restart' | 'recover'): void {
		const orphans = mapSubagentProcessRebuild(this.chatChannelUri, this._subagents);
		if (orphans.length === 0) {
			return;
		}
		this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] rebind (${reason}) orphaned ${orphans.length} open subagent(s); completing their chats so the session does not stay 'running'`);
		for (const orphan of orphans) {
			this._onDidProduceSignal.fire(orphan);
		}
	}

	/**
	 * Consumer loop. Drains the SDK iterator, dispatches each message
	 * to the {@link ClaudeSdkMessageRouter} (awaited so async file-edit
	 * observation completes before the next message). A terminal `result`
	 * maps normally and closes the active protocol turn. An intermediate
	 * steering-preempt result suppresses its SDK diagnostic, closes the
	 * interrupted turn, and atomically promotes the retained pending message
	 * into a fresh protocol turn. Subsequent SDK output is therefore routed to
	 * the new user message rather than folded into the original turn.
	 *
	 * On any uncaught error (cancellation, transport failure, or the
	 * post-loop "stream ended without result" guard) the catch block
	 * rejects every pending entry's deferred with the same error and
	 * marks `_needsRebind=true`. Cancellation is swallowed (don't
	 * rethrow); other errors propagate to the void caller's `.catch` for
	 * logging.
	 */
	private async _processMessages(): Promise<void> {
		const query = this._query;
		if (!query) {
			throw new Error('ClaudeSdkPipeline._processMessages called before query was bound');
		}
		try {
			for await (const message of query) {
				// A rebind can leave the previous SDK iterator alive briefly. It no
				// longer owns router state or the shared prompt queue once `_query`
				// changes, even if it still produces a buffered message.
				if (this._query !== query) {
					return;
				}
				if (this._abortController.signal.aborted) {
					throw new CancellationError();
				}
				if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
					// A complete per-process level, independent of task_started /
					// task_notification ordering and their unrelated tool-use ids.
					this._backgroundTasksActive = message.tasks.some(task => !task.ambient);
					continue;
				}
				if (message.type === 'system' && message.subtype === 'init') {
					// Capture the loaded native-plugin list on every init (incl.
					// resume / post-rebind) so the post-materialize filter is fresh.
					this._initPlugins = message.plugins ?? [];
					if (!this._isResumed) {
						this._isResumed = true;
					}
				}
				if (message.type === 'rate_limit_event') {
					// This is account state, not turn content. Publish it before routing
					// so an idle/post-drain event is not lost for lacking a turn id.
					this._onDidRateLimitInfo.fire(message.rate_limit_info);
				}
				const activeEntry = this._queue.peekParent();
				if (!activeEntry && isTopLevelModelOutput(message)) {
					this._openAutonomousTurn();
				}
				const owner = activeEntry ?? this._postDrainTurn;
				// Only a steering message queued behind the in-flight request makes
				// its result an intermediate boundary. Every other result — the last
				// one, one with an ordinary send waiting behind it, one closing the
				// autonomous turn — is terminal for its request and must map its
				// usage like any other.
				const isIntermediateResult = message.type === 'result' && this._queue.steeringSuccessor !== undefined;
				try {
					if (isIntermediateResult) {
						// Claude reports the interrupted request as an execution error.
						// Do not render that implementation detail. Nothing else about
						// the message is actionable: the SDK session continues, so the
						// tools the interrupted request had in flight still report under
						// the ids the mapper is holding, and the terminal result owns the
						// cleanup for whatever never arrives.
						this._logService.info(`[Claude:${this.sessionId}] intermediate result (steering preemption); not mapped`);
					} else {
						await this._router.handle(message, owner?.turnId, {
							turnDuration: owner?.stopWatch.elapsed(),
							mode: this._currentPermissionMode,
							clientContext: owner?.clientContext,
						});
					}
				} catch (handlerErr) {
					this._logService.warn(`[ClaudeSdkPipeline:${this.sessionId}] router threw, skipping: ${handlerErr}`);
				}
				// The router is async, so ownership may have changed while it was
				// handling the message. Never let that old result settle a new turn.
				if (this._query !== query) {
					return;
				}
				if (message.type === 'result') {
					const completed = this._queue.settleHead();
					this._logService.info(`[Claude:${this.sessionId}] result for sdkUuid=${completed?.sdkUuid}`);
					if (!completed && this._postDrainTurn?.isAutonomous) {
						// The autonomous turn has no queue entry to settle, so its own
						// result is the only boundary that can close it. Demote rather
						// than clear: the id stays the attribution anchor for anything
						// this stream still owes (a background subagent reporting late).
						this._fireTurnComplete(this._postDrainTurn);
						this._postDrainTurn = { ...this._postDrainTurn, isAutonomous: false };
					}
					if (completed && this._queue.isEmpty) {
						this._postDrainTurn = {
							turnId: completed.turnId,
							stopWatch: completed.stopWatch,
							clientContext: completed.clientContext,
							isAutonomous: false,
						};
					}
					if (completed && !this._queue.isEmpty) {
						const next = this._queue.peekParent();
						if (next?.steeringMessage) {
							// The intermediate result is the first authoritative SDK
							// boundary where no more output belongs to the old request.
							// Close it before replacing the pending bubble with the new
							// persistent user turn.
							this._fireTurnComplete(completed);
							next.stopWatch.reset();
							this._onDidProduceSignal.fire({
								kind: 'action',
								resource: this.chatChannelUri,
								action: {
									type: ActionType.ChatTurnStarted,
									turnId: next.turnId,
									startedAt: new Date().toISOString(),
									message: next.steeringMessage.message,
									queuedMessageId: next.steeringMessage.id,
								},
							});
						}
					} else if (completed) {
						this._fireTurnComplete(completed);
					}
				}
			}
			if (this._abortController.signal.aborted) {
				throw new CancellationError();
			}
			// A rebind ({@link _rebindQuery}) swaps in a fresh `_query` and
			// disposes the old one, ending THIS pass's stream cleanly. That is
			// expected — return quietly and let {@link _runConsumerLoop} hand
			// off to the new query. Only an unexpected end of the *current*
			// query (no swap) is the real "stream ended without a result"
			// failure that should mark the pipeline for recovery.
			if (this._query !== query) {
				return;
			}
			throw new Error('Claude SDK stream ended without a result message');
		} catch (err) {
			const fatal = err instanceof Error ? err : new Error(String(err));
			// Only the loop that still owns the live query reacts: a later
			// unwinding pass whose query was already swapped by a rebind must
			// not clobber the fresh one. Mark unhealthy (keep the handle for
			// teardown); the next `send` rebinds.
			if (this._query === query) {
				this._backgroundTasksActive = false;
				this._queue.failAll(fatal);
				this._cancelAutonomousTurn();
				this._needsRebind = true;
			}
			if (!isCancellationError(fatal)) {
				throw fatal;
			}
		}
	}

	/**
	 * Open a protocol turn for a top-level continuation the harness started on
	 * its own — no user prompt, so nothing pushed the prompt queue. Follows the
	 * steering-promotion path exactly (fresh turn id, `ChatTurnStarted` on the
	 * signal fan-out, `ChatTurnComplete` at the closing `result`), so the turn
	 * persists and replays through the machinery that already exists.
	 *
	 * No-op once such a turn is open: one continuation is one turn, however many
	 * messages it spans.
	 */
	private _openAutonomousTurn(): void {
		if (this._postDrainTurn?.isAutonomous) {
			return;
		}
		const turnId = generateUuid();
		this._postDrainTurn = {
			turnId,
			stopWatch: StopWatch.create(false),
			// Carry the originating turn's telemetry context: the continuation is
			// downstream of whatever that client asked for.
			clientContext: this._postDrainTurn?.clientContext,
			isAutonomous: true,
		};
		this._logService.info(`[Claude:${this.sessionId}] opening autonomous turn ${turnId} (prompt queue drained)`);
		this._onDidProduceSignal.fire({
			kind: 'action',
			resource: this.chatChannelUri,
			action: {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: {
					text: localize('claude.autonomousTurn', "Claude continued on its own"),
					origin: { kind: MessageKind.SystemNotification },
				},
			},
		});
	}

	/**
	 * Close an open autonomous turn when the stream dies before its `result`.
	 * A queued entry surfaces that as a rejected deferred, which the agent turns
	 * into an error on the turn; an autonomous turn has no deferred, so without
	 * this it would run forever in the UI. Harmless to call when the client has
	 * already cancelled — the reducer ignores the second close.
	 */
	private _cancelAutonomousTurn(): void {
		const turn = this._postDrainTurn;
		if (!turn?.isAutonomous) {
			return;
		}
		this._postDrainTurn = { ...turn, isAutonomous: false };
		this._onDidProduceSignal.fire({
			kind: 'action',
			resource: this.chatChannelUri,
			action: {
				type: ActionType.ChatTurnCancelled,
				turnId: turn.turnId,
				duration: Math.max(0, turn.stopWatch.elapsed()),
			},
		});
	}

	private _fireTurnComplete(entry: { readonly turnId: string; readonly stopWatch: StopWatch }): void {
		this._onDidProduceSignal.fire({
			kind: 'action',
			resource: this.chatChannelUri,
			action: {
				type: ActionType.ChatTurnComplete,
				turnId: entry.turnId,
				duration: Math.max(0, entry.stopWatch.elapsed()),
			},
		});
	}
}
