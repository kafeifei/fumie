/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { RunOnceScheduler, Sequencer, SequencerByKey } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { appendEscapedMarkdownInlineCode } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/path.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession, IAgentSessionProjectInfo } from '../../common/agent.js';
import { getBranchCompletions, IAgentHostGitService, IDefaultBranch, IWorktreeArchiveSnapshot, IWorktreeFileProgress, META_DIFF_BASE_BRANCH, tryResolvePrimaryWorktreeRoot } from '../../common/agentHostGitService.js';
import { AgentHostFumieHomeEnvVar } from '../../common/agentHostProductEnv.js';
import { AgentSystemNotificationKind, AgentSystemNotificationSeverity, toAgentSystemNotificationMeta } from '../../common/meta/agentSystemNotificationMeta.js';
import { ISchemaProperty, schemaProperty } from '../../common/agentHostSchema.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { AH_META_IS_ARCHIVED_DB_KEY, AH_META_IS_DONE_DB_KEY, ResponsePart, ResponsePartKind, Turn } from '../../common/state/sessionState.js';
import { AGENT_BRANCH_PREFIX, AgentBranchNameGenerator, IAgentBranchNameGenerator } from './agentBranchNameGenerator.js';
import { ICopilotApiService } from './copilotApiService.js';
import { IWorktreeDiskBudgetCandidate, parseWorktreeDiskBudgetBytes, FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR, WorktreeDiskBudget } from '../worktree/worktreeDiskBudget.js';
import { getManagedWorktreePath, getManagedWorktreeRepositoryRoot, getManagedWorktreesRoot, sanitizeWorktreeSessionId } from '../worktree/worktreePaths.js';

export const IAgentHostWorktreeIsolation = createDecorator<IAgentHostWorktreeIsolation>('agentHostWorktreeIsolation');

export interface IAgentHostWorktreeIsolation {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorkingDirectoryPending: Event<string>;
	isWorkingDirectoryPending(sessionId: string): boolean;
}

/**
 * Per-session-database metadata keys under which the worktree an agent
 * created for an isolated session is recorded. The string values keep the
 * historical `copilot.worktree.*` prefix so sessions materialized by earlier
 * Copilot builds keep resolving their worktree on archive / unarchive /
 * restore after this logic was unified across agents. All agents (Copilot,
 * Codex, Claude) now write and read these same keys; the per-session database
 * is already scoped by session, so there is no cross-agent collision.
 */
const WORKTREE_META_BRANCH = 'copilot.worktree.branchName';
const WORKTREE_META_PATH = 'copilot.worktree.path';
export const WORKTREE_META_REPOSITORY_ROOT = 'copilot.worktree.repositoryRoot';
const WORKTREE_META_OWNERSHIP = 'copilot.worktree.ownership';
const WORKTREE_META_BRANCH_OWNED = 'copilot.worktree.branchOwned';
const WORKTREE_META_INCLUDE_SOURCE = 'copilot.worktree.includeSource';
const WORKTREE_META_INCLUDE_FILES = 'copilot.worktree.includeFiles';
const WORKTREE_META_CREATION_FAILURE = 'copilot.worktree.creationFailure';
// TODO@roblourens: Remove after ~November 2026, when pre-July 2026 sessions no longer need their worktree path/root reconstructed from this legacy key.
const LEGACY_WORKTREE_META_WORKING_DIRECTORY = 'copilot.workingDirectory';
const MAX_WORKTREE_FAILURE_DIAGNOSTIC_LENGTH = 200;

export function getWorktreeArchiveRef(sessionId: string): string {
	return `refs/agents/${sanitizeWorktreeSessionId(sessionId)}/archive`;
}

/** Thrown when a persisted session working directory is missing and cannot be repaired. */
export class SessionWorkingDirectoryMissingError extends Error {
	constructor(readonly workingDirectory: URI, readonly reason?: string) {
		super(reason
			? localize('sessionWorkingDirectoryMissingWithReason', "This session couldn't be loaded because its worktree is missing and could not be recreated: {0}", reason)
			: localize('sessionWorkingDirectoryMissing', "This session couldn't be loaded because its working directory no longer exists: {0}", workingDirectory.fsPath));
		this.name = 'SessionWorkingDirectoryMissingError';
	}
}

/** Raised when archive cleanup hit a state only manual repair can clear, so retrying is pointless. */
export class WorktreeArchiveUnrecoverableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorktreeArchiveUnrecoverableError';
	}
}

/** Raised when a legacy retained dirty checkout has not received the new archive confirmation. */
export class WorktreeArchiveChangesConfirmationRequiredError extends Error {
	constructor() {
		super(localize('worktreeArchiveChangesConfirmationRequired', "This archived session still has local changes and must be confirmed again before its worktree can be reclaimed"));
		this.name = 'WorktreeArchiveChangesConfirmationRequiredError';
	}
}

/** Default upper bound on branch names returned for the branch picker. */
const BRANCH_COMPLETION_LIMIT = 25;
const WORKTREE_PROGRESS_DEBOUNCE_MS = 40;

type WorktreeOwnership = 'fumie' | 'external' | 'unknown';

export interface IWorktreeHandle {
	readonly repositoryRoot: URI;
	readonly worktree: URI;
	readonly branchName: string;
	readonly ownership: WorktreeOwnership;
	/** False when Fumie created the checkout for an existing user-owned branch. */
	readonly branchOwned?: boolean;
	readonly baseBranch?: string;
	readonly includeSource?: URI;
	readonly includeFiles?: readonly string[];
	readonly bootstrapComplete?: boolean;
}

interface IWorktreeMetadata {
	readonly branchName: string;
	readonly worktreePath?: URI;
	readonly repositoryRoot?: URI;
	readonly ownership: WorktreeOwnership;
	readonly branchOwned?: boolean;
	readonly includeSource?: URI;
	readonly includeFiles?: readonly string[];
}

/**
 * The directory where per-session isolated worktrees are created. Fumie's
 * configured home uses the Cursor-style `worktrees/<repo>` layout; callers
 * without one retain the historical `<repo>.worktrees` sibling location.
 */
export function getWorktreesRoot(repositoryRoot: URI, fumieHome?: URI): URI {
	if (fumieHome) {
		return URI.joinPath(fumieHome, 'worktrees', basename(repositoryRoot.fsPath));
	}
	return URI.joinPath(repositoryRoot, '..', `${basename(repositoryRoot.fsPath)}.worktrees`);
}

/**
 * Derives the on-disk worktree directory name from a branch name: strips the
 * caller-supplied prefix (e.g. the user's `git.branchPrefix`) and the built-in
 * `agents/` prefix so the directory stays concise, then flattens any remaining
 * path separators.
 */
export function getWorktreeName(branchName: string, branchPrefix: string = ''): string {
	let name = branchName;
	if (branchPrefix && name.startsWith(branchPrefix)) {
		name = name.substring(branchPrefix.length);
	}
	if (name.startsWith(AGENT_BRANCH_PREFIX)) {
		name = name.substring(AGENT_BRANCH_PREFIX.length);
	}
	return name.replace(/\//g, '-');
}

/**
 * Builds the localized "Created isolated worktree for branch X" markdown shown
 * at the top of the first response in worktree-isolated sessions. The branch
 * name is wrapped as inline code so the localized template doesn't have to
 * embed markdown punctuation. The trailing blank line keeps the announcement
 * visually separated when it gets merged into the same markdown part as the
 * model's reply.
 */
export function buildWorktreeAnnouncementText(branchName: string): string {
	return localize(
		'agentHost.worktreeCreated',
		"Created isolated worktree for branch {0}",
		appendEscapedMarkdownInlineCode(branchName)
	) + '\n\n';
}

/** Builds the warning shown when worktree isolation falls back to the original folder. */
export function buildWorktreeFailureNotification(diagnostic?: string): Extract<ResponsePart, { kind: ResponsePartKind.SystemNotification }> {
	const normalizedDiagnostic = normalizeWorktreeFailureDiagnostic(diagnostic);
	const content = normalizedDiagnostic
		? localize(
			'agentHost.worktreeCreationFailedWithDiagnostic',
			"Couldn't create the isolated worktree. This session hasn't started; retry to try again.\n\n{0}",
			appendEscapedMarkdownInlineCode(normalizedDiagnostic)
		)
		: localize(
			'agentHost.worktreeCreationFailed',
			"Couldn't create the isolated worktree. This session hasn't started; retry to try again."
		);
	return {
		kind: ResponsePartKind.SystemNotification,
		content,
		_meta: toAgentSystemNotificationMeta({
			kind: AgentSystemNotificationKind.WorktreeCreationFailure,
			severity: AgentSystemNotificationSeverity.Warning,
		}),
	};
}

/** Normalizes an arbitrary worktree failure into a bounded single-line diagnostic. */
export function normalizeWorktreeFailureDiagnostic(diagnostic: string | undefined): string | undefined {
	const normalized = diagnostic?.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return undefined;
	}
	return normalized.length > MAX_WORKTREE_FAILURE_DIAGNOSTIC_LENGTH
		? `${normalized.slice(0, MAX_WORKTREE_FAILURE_DIAGNOSTIC_LENGTH - 3)}...`
		: normalized;
}

/**
 * Keeps legacy workspace settings from blocking session creation while still
 * enforcing Fumie's dependency-isolation rule. A worktree may copy small
 * ignored configuration files, but never a node_modules tree.
 */
export function sanitizeWorktreeIncludeFiles(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || !value.every(pattern => typeof pattern === 'string')) {
		return undefined;
	}
	return value.filter(pattern => !pattern.toLowerCase().includes('node_modules'));
}

/**
 * The steps of worktree creation that are slow enough to be worth naming while
 * a session materializes. Ordered as they run.
 */
export const enum WorktreeCreationPhase {
	/** Queued behind another worktree being created in the same repository. */
	Starting,
	/** Asking the model for a branch name, then probing candidates for collisions. */
	NamingBranch,
	/** `git worktree add` — the phase that reports file-level progress. */
	CheckingOut,
	/** Copying the git-ignored files the client asked to carry over. */
	CopyingIncludeFiles,
}

/**
 * Builds the localized activity label for a worktree-creation phase. `percent`
 * only applies to the phases that report file-level progress
 * ({@link WorktreeCreationPhase.CheckingOut} and
 * {@link WorktreeCreationPhase.CopyingIncludeFiles}), where it is absent until
 * the first sample arrives.
 */
export function buildWorktreeProgressText(phase: WorktreeCreationPhase, percent?: number): string {
	switch (phase) {
		case WorktreeCreationPhase.NamingBranch:
			return localize('agentHost.worktreeNamingBranch', "Creating isolated worktree (naming branch)");
		case WorktreeCreationPhase.CheckingOut:
			return percent === undefined
				? localize('agentHost.worktreeCheckingOut', "Creating isolated worktree (checking out files)")
				: localize('agentHost.worktreeCheckingOutPercent', "Creating isolated worktree (checking out files, {0}%)", percent);
		case WorktreeCreationPhase.CopyingIncludeFiles:
			return percent === undefined
				? localize('agentHost.worktreeCopyingIncludeFiles', "Creating isolated worktree (copying additional files)")
				: localize('agentHost.worktreeCopyingIncludeFilesPercent', "Creating isolated worktree (copying additional files, {0}%)", percent);
		default:
			return localize('agentHost.worktreeCreating', "Creating isolated worktree");
	}
}

/**
 * Adapts the raw file counts the git service reports into progress labels for
 * a phase. Rounds down to whole percentages, drops non-advancing samples, and
 * debounces updates to avoid overwhelming consumers, flushing the latest
 * percentage when the operation completes.
 */
async function withPercentProgress<T>(
	phase: WorktreeCreationPhase,
	onProgress: ((activity: string) => void) | undefined,
	operation: (onProgress: ((progress: IWorktreeFileProgress) => void) | undefined) => Promise<T>,
): Promise<T> {
	if (!onProgress) {
		return operation(undefined);
	}

	let lastPercent = -1;
	const scheduler = new RunOnceScheduler(() => onProgress(buildWorktreeProgressText(phase, lastPercent)), WORKTREE_PROGRESS_DEBOUNCE_MS);
	try {
		return await operation(({ filesDone, filesTotal }) => {
			const percent = Math.min(100, Math.floor(filesDone * 100 / filesTotal));
			if (percent <= lastPercent) {
				return;
			}
			lastPercent = percent;
			scheduler.schedule();
		});
	} finally {
		const shouldFlush = scheduler.isScheduled();
		scheduler.dispose();
		if (shouldFlush) {
			onProgress(buildWorktreeProgressText(phase, lastPercent));
		}
	}
}

/**
 * Returns a copy of `turns` where `announcement` has been prepended to the
 * first top-level assistant turn's first markdown response part. Used on
 * session restore so the worktree announcement remains visible after the
 * session is reopened. If no assistant content exists yet, a fresh markdown
 * part is inserted at the top of the first turn.
 */
export function prependAnnouncementToFirstTurn(turns: readonly Turn[], announcement: string): readonly Turn[] {
	if (turns.length === 0) {
		return turns;
	}
	const result = turns.slice();
	const first = result[0];
	const part = first.responseParts[0];
	if (part?.kind === ResponsePartKind.Markdown) {
		const responseParts = first.responseParts.slice();
		responseParts[0] = { ...part, content: announcement + part.content };
		result[0] = { ...first, responseParts };
	} else {
		const responseParts: ResponsePart[] = [
			{ kind: ResponsePartKind.Markdown, id: generateUuid(), content: announcement },
			...first.responseParts,
		];
		result[0] = { ...first, responseParts };
	}
	return result;
}

function prependWorktreeFailureToFirstTurn(turns: readonly Turn[], diagnostic: string | undefined): readonly Turn[] {
	if (turns.length === 0) {
		return turns;
	}
	const result = turns.slice();
	const first = result[0];
	result[0] = {
		...first,
		responseParts: [buildWorktreeFailureNotification(diagnostic), ...first.responseParts],
	};
	return result;
}

/** Parameters for {@link WorktreeIsolation.resolveIsolationConfig}. */
export interface IResolveIsolationConfigRequest {
	readonly workingDirectory: URI | undefined;
	readonly config: Record<string, unknown> | undefined;
}

/**
 * The isolation + branch schema contribution for an agent's
 * `resolveSessionConfig`. Callers merge {@link isolationProperty} (and
 * {@link branchProperty} / {@link worktreeBranchPrefixProperty} when present)
 * into their own schema and merge the default values ({@link isolationValue} /
 * {@link branchDefault}) into the defaults bag they pass to `validateOrDefault`.
 */
export interface IIsolationConfigContribution {
	readonly isolationProperty: ISchemaProperty<'folder' | 'worktree'>;
	readonly branchProperty: ISchemaProperty<string> | undefined;
	/**
	 * Read-only carrier for the client's `git.branchPrefix`. Declared for both
	 * isolations (like `branch`) so the value rides `_config.values` and
	 * survives isolation toggles; the host only consumes it for worktree
	 * isolation (see {@link WorktreeIsolation.resolveWorkingDirectory}).
	 */
	readonly worktreeBranchPrefixProperty: ISchemaProperty<string> | undefined;
	/** Read-only carrier for the client's `git.worktreeIncludeFiles`. */
	readonly worktreeIncludeFilesProperty: ISchemaProperty<readonly string[]> | undefined;
	/** Read-only carrier for the programmatic worktree branch tracking preference. */
	readonly worktreeBranchTrackProperty: ISchemaProperty<boolean> | undefined;
	/** Read-only carrier for checking out the selected branch directly. */
	readonly worktreeCreateNewBranchProperty: ISchemaProperty<boolean> | undefined;
	readonly isolationValue: 'folder' | 'worktree';
	readonly branchDefault: string | undefined;
	readonly branchValue: string | undefined;
}

/** Parameters for {@link WorktreeIsolation.resolveWorkingDirectory}. */
export interface IResolveWorkingDirectoryRequest {
	readonly sessionUri: URI;
	readonly sessionId: string;
	readonly workingDirectory: URI | undefined;
	readonly config: Record<string, unknown> | undefined;
	readonly prompt?: string;
	readonly githubToken?: string;
	/** Session liveness supplied by the owner before enforcing the shared budget. */
	readonly diskBudgetSessions?: readonly IWorktreeDiskBudgetSession[];
	/** Stops/releases an idle session before its clean checkout is reclaimed. */
	readonly onWillReclaimWorktree?: (sessionId: string) => Promise<void>;
	/**
	 * Receives localized activity labels while the worktree is being created,
	 * so callers can surface live progress. Only called for sessions that
	 * selected worktree isolation. The caller is responsible for clearing the
	 * activity once resolution settles.
	 */
	readonly onProgress?: (activity: string) => void;
}

/** Session-level protection facts used by worktree disk reclamation. */
export interface IWorktreeDiskBudgetSession {
	readonly sessionId: string;
	readonly sessionUri?: URI;
	readonly running: boolean;
	readonly pinned: boolean;
}

interface IManagedWorktreeDiskBudgetCandidate extends IWorktreeDiskBudgetCandidate {
	readonly worktree: URI;
	readonly repositoryRoot?: URI;
	readonly registered: boolean;
}

/**
 * Shared, per-agent controller for git-worktree session isolation. Owns the
 * full machinery Copilot pioneered so Codex and Claude get identical behavior:
 *
 * - advertising the `isolation` (`folder` / `worktree`) and `branch` session
 *   config properties from `resolveSessionConfig` ({@link resolveIsolationConfig});
 * - completing branch names for the branch picker ({@link branchCompletions});
 * - creating the worktree on materialization and persisting its metadata
 *   ({@link resolveWorkingDirectory});
 * - surfacing worktree creation success/failure notices live and on restore;
 * - cleaning up / recreating the worktree on session deletion, archive, and unarchive.
 *
 * A single host-owned instance serves every agent: the orchestrator
 * ({@link AgentService}) creates it and drives the lifecycle so individual
 * agents stay unaware of the folder-vs-worktree distinction. Session state
 * (`_materializedWorktrees`, pending markers, pending announcements) is keyed by the
 * globally-unique sessionId, so sharing one instance across agents is safe.
 */
export class WorktreeIsolation extends Disposable implements IAgentHostWorktreeIsolation {
	declare readonly _serviceBrand: undefined;

	/** Worktrees materialized during this host process, keyed by sessionId. */
	private readonly _materializedWorktrees = new Map<string, IWorktreeHandle>();

	/**
	 * Per-session announcement (markdown) emitted as a synthetic streaming
	 * markdown part the first time the session sends a message. Surfaces the
	 * "Created isolated worktree for branch X" message live during the first
	 * turn; the same announcement is re-injected on restore via
	 * {@link applyRestoreAnnouncement}.
	 */
	private readonly _pendingFirstTurnAnnouncements = new Map<string, string>();

	/**
	 * SessionIds of freshly-created worktree-isolation sessions whose worktree
	 * has not yet been created (creation is deferred to the first send so the
	 * user's prompt can drive branch naming). While a session is in this set the
	 * host reports its working directory as "pending" ({@link isWorkingDirectoryPending})
	 * so agents defer prewarming / materializing until {@link resolveOnFirstSend}
	 * runs. Never populated for restored sessions — their worktree already exists
	 * on disk and their persisted working directory already points at it.
	 */
	private readonly _pending = new Set<string>();
	private readonly _onDidChangeWorkingDirectoryPending = this._register(new Emitter<string>());
	readonly onDidChangeWorkingDirectoryPending: Event<string> = this._onDidChangeWorkingDirectoryPending.event;

	/** Fixed log label; one host-owned instance serves every agent. */
	private readonly _logLabel = 'AgentHost';

	/**
	 * Serializes the worktree lifecycle per session so a first-send creation
	 * ({@link resolveOnFirstSend}) never interleaves with archive/unarchive
	 * cleanup ({@link cleanupWorktreeOnArchive} / {@link recreateWorktreeOnUnarchive})
	 * or deletion ({@link removeSessionWorktree}) for the same session — the
	 * guarantee each agent previously enforced with its own sequencer.
	 */
	private readonly _sequencer = new SequencerByKey<string>();
	private readonly _worktreeCreationSequencer = new SequencerByKey<string>();
	private readonly _diskBudgetSequencer = new Sequencer();
	private readonly _diskBudget = new WorktreeDiskBudget(parseWorktreeDiskBudgetBytes(process.env[FUMIE_WORKTREE_DISK_BUDGET_BYTES_ENV_VAR]));

	/** Branch-name generator for worktree sessions; created from {@link ICopilotApiService} unless a test supplies an override. */
	private readonly _branchNameGenerator: IAgentBranchNameGenerator;

	constructor(
		branchNameGenerator: IAgentBranchNameGenerator | undefined,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@ICopilotApiService copilotApiService: ICopilotApiService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._branchNameGenerator = branchNameGenerator ?? new AgentBranchNameGenerator(copilotApiService, this._logService);
	}

	/**
	 * Marks a fresh worktree-isolation session as pending — its worktree is
	 * deferred to the first send. Called by the host while a creating session's
	 * resolved config selects `worktree` isolation.
	 */
	notePending(sessionId: string): void {
		if (!this._pending.has(sessionId)) {
			this._pending.add(sessionId);
			this._onDidChangeWorkingDirectoryPending.fire(sessionId);
		}
	}

	/** Clears a pending marker when a session will not materialize a worktree. */
	clearPending(sessionId: string): void {
		if (this._pending.delete(sessionId)) {
			this._onDidChangeWorkingDirectoryPending.fire(sessionId);
		}
	}

	/**
	 * Whether a session's worktree is still pending creation. The host exposes
	 * this through {@link IAgentConfigurationService.isWorkingDirectoryPending} so
	 * agents defer materialization until the host has resolved the worktree.
	 */
	isWorkingDirectoryPending(sessionId: string): boolean {
		return this._pending.has(sessionId);
	}

	/** The worktree created for a session in this process, if any. */
	getResolvedWorktree(sessionId: string): URI | undefined {
		return this._materializedWorktrees.get(sessionId)?.worktree;
	}

	/**
	 * First-send worktree resolution: creates the worktree (when the session
	 * selected `worktree` isolation on a git repo) and clears the pending marker
	 * only after the isolated checkout and its persistent metadata both exist.
	 * A failed or inapplicable creation remains pending so the same first send can
	 * be retried instead of silently running in the original folder. Delegates to
	 * {@link resolveWorkingDirectory}, which is idempotent per session.
	 */
	async resolveOnFirstSend(request: IResolveWorkingDirectoryRequest): Promise<URI | undefined> {
		return this._sequencer.queue(request.sessionId, async () => {
			const workingDirectory = await this.resolveWorkingDirectory(request);
			if (this._materializedWorktrees.has(request.sessionId)) {
				this.clearPending(request.sessionId);
			}
			return workingDirectory;
		});
	}

	/** Public WorktreeService creation entry. */
	async create(request: IResolveWorkingDirectoryRequest): Promise<URI | undefined> {
		return this.resolveOnFirstSend(request);
	}

	/** Returns current Fumie-managed worktree usage under the configured home. */
	async getUsage(): Promise<number> {
		const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
		if (!fumieHome) {
			return 0;
		}
		return this._diskBudget.getUsage(await this._collectDiskBudgetCandidates(fumieHome, new Map(), false));
	}

	/** Reclaims clean cold checkouts in LRU order using owner-supplied liveness. */
	async reclaim(
		sessions: readonly IWorktreeDiskBudgetSession[],
		onWillReclaimWorktree?: (sessionId: string) => Promise<void>,
	): Promise<void> {
		const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
		if (fumieHome) {
			await this._reclaimDiskBudget(fumieHome, undefined, sessions, onWillReclaimWorktree);
		}
	}

	/** Startup reconciliation uses the same safe reclaim path. */
	async reconcile(
		sessions: readonly IWorktreeDiskBudgetSession[],
		onWillReclaimWorktree?: (sessionId: string) => Promise<void>,
	): Promise<void> {
		return this.reclaim(sessions, onWillReclaimWorktree);
	}

	/**
	 * Builds the `isolation` / `branch` schema contribution for
	 * `resolveSessionConfig`. When {@link IResolveIsolationConfigRequest.workingDirectory}
	 * is not a git repository (or has no commits yet) isolation is forced to
	 * `folder` and no branch property is offered.
	 */
	async resolveIsolationConfig(request: IResolveIsolationConfigRequest): Promise<IIsolationConfigContribution> {
		const gitInfo = request.workingDirectory ? await this._getGitInfo(request.workingDirectory) : undefined;

		const isolationProperty = schemaProperty<'folder' | 'worktree'>({
			type: 'string',
			title: localize('agentHost.sessionConfig.isolation', "Isolation"),
			description: localize('agentHost.sessionConfig.isolationDescription', "Where the agent should make changes"),
			enum: gitInfo ? ['folder', 'worktree'] : ['folder'],
			enumLabels: gitInfo ? [localize('agentHost.sessionConfig.isolation.folder', "Folder"), localize('agentHost.sessionConfig.isolation.worktree', "Worktree")] : [localize('agentHost.sessionConfig.isolation.folder', "Folder")],
			enumDescriptions: gitInfo ? [localize('agentHost.sessionConfig.isolation.folderDescription', "Work directly in the folder"), localize('agentHost.sessionConfig.isolation.worktreeDescription', "Create a Git worktree for isolation")] : [localize('agentHost.sessionConfig.isolation.folderDescription', "Work directly in the folder")],
			default: gitInfo ? 'worktree' : 'folder',
			readOnly: !gitInfo,
			sessionMutable: false,
		});

		// Resolve isolation first — downstream schema shapes (branch's
		// read-only mode + enum restriction) depend on the effective value.
		const isolationDefault: 'folder' | 'worktree' = gitInfo ? 'worktree' : 'folder';
		const isolationValue = isolationProperty.validate(request.config?.[SessionConfigKey.Isolation])
			? request.config![SessionConfigKey.Isolation] as 'folder' | 'worktree'
			: isolationDefault;

		let branchProperty: ISchemaProperty<string> | undefined;
		let branchDefault: string | undefined;
		let branchValue: string | undefined;
		let worktreeBranchPrefixProperty: ISchemaProperty<string> | undefined;
		let worktreeIncludeFilesProperty: ISchemaProperty<readonly string[]> | undefined;
		let worktreeBranchTrackProperty: ISchemaProperty<boolean> | undefined;
		let worktreeCreateNewBranchProperty: ISchemaProperty<boolean> | undefined;
		if (gitInfo) {
			branchDefault = isolationValue === 'worktree' ? gitInfo.defaultBranch.name : gitInfo.currentBranch;
			branchValue = typeof request.config?.[SessionConfigKey.Branch] === 'string'
				? request.config[SessionConfigKey.Branch] as string
				: branchDefault;
			branchProperty = schemaProperty<string>({
				type: 'string',
				title: localize('agentHost.sessionConfig.branch', "Branch"),
				description: localize('agentHost.sessionConfig.branchDescription', "Base branch to work from"),
				enum: [branchDefault],
				enumLabels: [branchDefault],
				default: branchDefault,
				enumDynamic: true,
				readOnly: false,
				sessionMutable: false,
			});

			// Carrier for the client's `git.branchPrefix`: the host prepends it
			// to the branch it creates for an isolated worktree. Declared for
			// both isolations (like `branch`), so the value rides
			// `_config.values` and survives isolation toggles — a user who flips
			// worktree → folder → worktree keeps the prefix. It has no
			// `enum`/`enumDynamic`, so the config picker treats it as
			// non-pickable and never surfaces it as a chip: the client seeds it
			// (from `git.branchPrefix`), the user never edits it, and the host
			// only *consumes* it for worktree isolation (see
			// {@link resolveWorkingDirectory}).
			worktreeBranchPrefixProperty = schemaProperty<string>({
				type: 'string',
				title: localize('agentHost.sessionConfig.worktreeBranchPrefix', "Worktree Branch Prefix"),
				description: localize('agentHost.sessionConfig.worktreeBranchPrefixDescription', "Prefix applied to the branch created for an isolated worktree."),
				readOnly: true,
				sessionMutable: false,
			});

			worktreeBranchTrackProperty = schemaProperty<boolean>({
				type: 'boolean',
				title: localize('agentHost.sessionConfig.worktreeBranchTrack', "Worktree Branch Tracking"),
				description: localize('agentHost.sessionConfig.worktreeBranchTrackDescription', "Whether the branch created for an isolated worktree tracks its upstream."),
				default: false,
				readOnly: true,
				sessionMutable: false,
			});

			worktreeCreateNewBranchProperty = schemaProperty<boolean>({
				type: 'boolean',
				title: localize('agentHost.sessionConfig.worktreeCreateNewBranch', "Create New Worktree Branch"),
				description: localize('agentHost.sessionConfig.worktreeCreateNewBranchDescription', "Whether to create a new branch for the isolated worktree."),
				default: true,
				readOnly: true,
				sessionMutable: false,
			});

			worktreeIncludeFilesProperty = schemaProperty<readonly string[]>({
				type: 'array',
				title: localize('agentHost.sessionConfig.worktreeIncludeFiles', "Worktree Include Files"),
				description: localize('agentHost.sessionConfig.worktreeIncludeFilesDescription', "Glob patterns for git-ignored files to copy into the isolated worktree."),
				items: {
					type: 'string',
					title: localize('agentHost.sessionConfig.worktreeIncludeFilesItem', "Pattern"),
				},
				readOnly: true,
				sessionMutable: false,
			});
		}

		return { isolationProperty, branchProperty, worktreeBranchPrefixProperty, worktreeBranchTrackProperty, worktreeCreateNewBranchProperty, worktreeIncludeFilesProperty, isolationValue, branchDefault, branchValue };
	}

	/**
	 * Branch-name completions for the branch picker. Callers forward this from
	 * their `sessionConfigCompletions` when the requested property is
	 * {@link SessionConfigKey.Branch}.
	 */
	async branchCompletions(workingDirectory: URI | undefined, query?: string): Promise<{ items: { value: string; label: string }[] }> {
		if (!workingDirectory) {
			return { items: [] };
		}
		const [branches, currentBranch, defaultBranch] = await Promise.all([
			this._gitService.getBranches(workingDirectory, { pattern: ['refs/heads'], sort: 'committerdate' }),
			this._gitService.getCurrentBranch(workingDirectory),
			this._gitService.getDefaultBranch(workingDirectory),
		]);
		const branchCompletions = getBranchCompletions(branches.map(branch => branch.name), {
			currentBranch,
			defaultBranch: defaultBranch?.name,
			query,
			limit: BRANCH_COMPLETION_LIMIT,
		});

		return { items: branchCompletions.map(branch => ({ value: branch, label: branch })) };
	}

	/**
	 * Resolves the effective working directory for a session that is about to
	 * be materialized. When the session config selects `worktree` isolation on
	 * a git repository, creates or checks out a branch in a worktree, records it for
	 * cleanup, queues the first-turn announcement, persists the worktree
	 * metadata, and returns the worktree URI. Otherwise returns the requested
	 * working directory unchanged.
	 */
	async resolveWorkingDirectory(request: IResolveWorkingDirectoryRequest): Promise<URI | undefined> {
		const { config, workingDirectory, sessionId, sessionUri, prompt, githubToken, onProgress } = request;
		if (config?.[SessionConfigKey.Isolation] !== 'worktree' || !workingDirectory || typeof config[SessionConfigKey.Branch] !== 'string') {
			return workingDirectory;
		}
		const requestedIncludeFiles = Array.isArray(config[SessionConfigKey.WorktreeIncludeFiles])
			&& config[SessionConfigKey.WorktreeIncludeFiles].every(pattern => typeof pattern === 'string')
			? config[SessionConfigKey.WorktreeIncludeFiles] as readonly string[]
			: undefined;
		const configuredIncludeFiles = sanitizeWorktreeIncludeFiles(requestedIncludeFiles);
		const ignoredDependencyPatterns = requestedIncludeFiles?.filter(pattern => !configuredIncludeFiles?.includes(pattern)) ?? [];
		if (ignoredDependencyPatterns.length > 0) {
			this._logService.warn(`[${this._logLabel}:${sessionId}] Ignoring worktree include patterns that copy node_modules: ${ignoredDependencyPatterns.join(', ')}`);
		}

		// Idempotent: if a worktree was already created for this session in this
		// process, persist a completed checkout or finish compensating a failed
		// bootstrap before attempting a fresh creation.
		const already = this._materializedWorktrees.get(sessionId);
		if (already) {
			if (!already.bootstrapComplete) {
				await this._rollbackFailedMaterialization(sessionId, already);
				return this.resolveWorkingDirectory(request);
			}
			await this._writeWorktreeMetadata(sessionUri, {
				branchName: already.branchName,
				baseBranch: already.baseBranch,
				worktreePath: already.worktree,
				repositoryRoot: already.repositoryRoot,
				ownership: 'fumie',
				branchOwned: already.branchOwned,
				includeSource: already.includeSource,
				includeFiles: already.includeFiles,
			});
			return already.worktree;
		}

		onProgress?.(buildWorktreeProgressText(WorktreeCreationPhase.Starting));

		const checkoutRoot = await this._gitService.getRepositoryRoot(workingDirectory);
		if (!checkoutRoot) {
			return workingDirectory;
		}

		const repositoryRoot = await this._resolvePrimaryWorktreeRoot(checkoutRoot, checkoutRoot);
		const selectedBranch = config[SessionConfigKey.Branch] as string;
		const worktreeBranchTrack = config[SessionConfigKey.WorktreeBranchTrack] === true;
		const worktreeCreateNewBranch = config[SessionConfigKey.WorktreeCreateNewBranch] !== false;
		const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
		const worktreesRoot = fumieHome
			? getManagedWorktreeRepositoryRoot(fumieHome, repositoryRoot)
			: getWorktreesRoot(repositoryRoot);
		if (fumieHome) {
			await this._reclaimDiskBudget(fumieHome, sessionId, request.diskBudgetSessions, request.onWillReclaimWorktree);
		}
		const managedWorktree = fumieHome ? getManagedWorktreePath(fumieHome, repositoryRoot, sessionId) : undefined;
		if (managedWorktree && await fileExists(managedWorktree.fsPath)) {
			throw new Error(localize('worktreeManagedPathExists', "Cannot create the isolated worktree because its managed path already exists: {0}", managedWorktree.fsPath));
		}
		// Prefix (e.g. the user's `git.branchPrefix`) the client forwards for
		// worktree-isolated sessions. Prepended ahead of the built-in `agents/`
		// prefix when naming the branch and stripped from the worktree dir name.
		const worktreeBranchPrefix = worktreeCreateNewBranch && typeof config[SessionConfigKey.WorktreeBranchPrefix] === 'string'
			? config[SessionConfigKey.WorktreeBranchPrefix] as string
			: undefined;
		const { worktree, branchName, baseBranch } = await this._worktreeCreationSequencer.queue(repositoryRoot.toString(), async () => {
			if (worktreeCreateNewBranch) {
				onProgress?.(buildWorktreeProgressText(WorktreeCreationPhase.NamingBranch));
			}
			const newBranchName = worktreeCreateNewBranch
				? await this._branchNameGenerator.generateBranchName({
					sessionId,
					message: prompt,
					githubToken,
					branchPrefix: worktreeBranchPrefix,
					branchNameCollides: async candidate => {
						if (await this._gitService.branchExists(repositoryRoot, candidate).catch(() => true)) {
							return true;
						}
						return managedWorktree
							? false
							: fileExists(URI.joinPath(worktreesRoot, getWorktreeName(candidate, worktreeBranchPrefix)).fsPath);
					},
				})
				: undefined;

			const branchStartPoint = await this._resolveBranchStartPoint(repositoryRoot, selectedBranch);

			const baseBranch = worktreeCreateNewBranch
				? branchStartPoint
				: (await this._gitService.getDefaultBranch(repositoryRoot))?.startPoint;
			const branchName = newBranchName ?? selectedBranch;
			const worktree = managedWorktree ?? URI.joinPath(worktreesRoot, getWorktreeName(branchName, worktreeBranchPrefix));
			await fs.mkdir(worktreesRoot.fsPath, { recursive: true });

			// Git suppresses progress for the first couple of seconds, so name
			// the phase up front rather than leaving the label stale until the
			// first percentage arrives.
			onProgress?.(buildWorktreeProgressText(WorktreeCreationPhase.CheckingOut));

			try {
				await withPercentProgress(WorktreeCreationPhase.CheckingOut, onProgress, progress =>
					this._gitService.addWorktree(repositoryRoot, {
						path: worktree,
						commitish: worktreeCreateNewBranch ? branchStartPoint : selectedBranch,
						newBranchName,
						preferRemoteBranch: worktreeCreateNewBranch,
						track: worktreeBranchTrack,
						onProgress: progress,
					}));
			} catch (error) {
				await this._pruneEmptyManagedWorktreeDirectories(repositoryRoot, worktree).catch(pruneError => {
					this._logService.warn(`[${this._logLabel}:${sessionId}] Failed to remove empty managed worktree directory after checkout failure: ${errorMessage(pruneError)}`);
				});
				throw error;
			}
			return { branchName, worktree, baseBranch };
		});
		const materialized: IWorktreeHandle = {
			repositoryRoot,
			worktree,
			branchName,
			baseBranch,
			ownership: 'fumie',
			branchOwned: worktreeCreateNewBranch,
			includeSource: checkoutRoot,
			includeFiles: configuredIncludeFiles,
			bootstrapComplete: !configuredIncludeFiles?.length,
		};
		this._materializedWorktrees.set(sessionId, materialized);
		if (configuredIncludeFiles?.length) {
			try {
				onProgress?.(buildWorktreeProgressText(WorktreeCreationPhase.CopyingIncludeFiles));
				await withPercentProgress(WorktreeCreationPhase.CopyingIncludeFiles, onProgress, progress =>
					this._gitService.copyWorktreeIncludeFiles(checkoutRoot, worktree, configuredIncludeFiles, progress));
				this._materializedWorktrees.set(sessionId, { ...materialized, bootstrapComplete: true });
			} catch (bootstrapError) {
				try {
					await this._rollbackFailedMaterialization(sessionId, materialized);
				} catch (rollbackError) {
					throw new Error(`Worktree bootstrap failed: ${errorMessage(bootstrapError)}; cleanup also failed: ${errorMessage(rollbackError)}`, { cause: bootstrapError });
				}
				throw bootstrapError;
			}
		}
		if (fumieHome) {
			try {
				await this._reclaimDiskBudget(fumieHome, sessionId, request.diskBudgetSessions, request.onWillReclaimWorktree);
			} catch (budgetError) {
				try {
					await this._rollbackFailedMaterialization(sessionId, this._materializedWorktrees.get(sessionId) ?? materialized);
				} catch (rollbackError) {
					throw new Error(`Worktree disk budget enforcement failed: ${errorMessage(budgetError)}; cleanup also failed: ${errorMessage(rollbackError)}`, { cause: budgetError });
				}
				throw budgetError;
			}
		}
		// Queue the worktree announcement so the first turn (live) and any
		// subsequent restore (history) both surface the message in the chat.
		this._pendingFirstTurnAnnouncements.set(sessionId, buildWorktreeAnnouncementText(branchName));
		await this._writeWorktreeMetadata(sessionUri, { branchName, baseBranch, worktreePath: worktree, repositoryRoot, ownership: 'fumie', branchOwned: worktreeCreateNewBranch, includeSource: checkoutRoot, includeFiles: configuredIncludeFiles });
		return worktree;
	}

	private async _removeManagedWorktree(repositoryRoot: URI, worktree: URI, options?: { readonly force?: boolean }): Promise<void> {
		await this._gitService.removeWorktree(repositoryRoot, worktree, options);
		await this._pruneEmptyManagedWorktreeDirectories(repositoryRoot, worktree);
	}

	private async _pruneEmptyManagedWorktreeDirectories(repositoryRoot: URI, worktree: URI): Promise<void> {
		const fumieHomePath = process.env[AgentHostFumieHomeEnvVar];
		if (!fumieHomePath) {
			return;
		}
		const fumieHome = URI.file(fumieHomePath);
		const repositoryDirectory = dirname(worktree);
		const currentRepositoryDirectory = getManagedWorktreeRepositoryRoot(fumieHome, repositoryRoot);
		const historicalRepositoryDirectory = getWorktreesRoot(repositoryRoot, fumieHome);
		const versionedRepositoryDirectory = URI.joinPath(fumieHome, 'worktrees', 'v2', basename(currentRepositoryDirectory.fsPath));
		if (!isEqual(repositoryDirectory, currentRepositoryDirectory)
			&& !isEqual(repositoryDirectory, historicalRepositoryDirectory)
			&& !isEqual(repositoryDirectory, versionedRepositoryDirectory)) {
			return;
		}
		await removeEmptyDirectory(repositoryDirectory.fsPath);
		if (isEqual(repositoryDirectory, versionedRepositoryDirectory)) {
			await removeEmptyDirectory(dirname(repositoryDirectory).fsPath);
		}
	}

	private async _rollbackFailedMaterialization(sessionId: string, worktree: IWorktreeHandle): Promise<void> {
		await this._removeManagedWorktree(worktree.repositoryRoot, worktree.worktree, { force: true });
		if (worktree.branchOwned !== false) {
			const deleteBranch = this._gitService.deleteBranch;
			if (!deleteBranch) {
				throw new Error(`Cannot clean up failed worktree branch '${worktree.branchName}' because branch deletion is unavailable`);
			}
			if (await this._gitService.branchExists(worktree.repositoryRoot, worktree.branchName)) {
				await deleteBranch.call(this._gitService, worktree.repositoryRoot, worktree.branchName, { force: true });
			}
		}
		this._materializedWorktrees.delete(sessionId);
		this._pendingFirstTurnAnnouncements.delete(sessionId);
	}

	private async _reclaimDiskBudget(
		fumieHome: URI,
		currentSessionId: string | undefined,
		sessions: readonly IWorktreeDiskBudgetSession[] | undefined,
		onWillReclaim: ((sessionId: string) => Promise<void>) | undefined,
	): Promise<void> {
		if (!this._diskBudget.isEnabled) {
			return;
		}
		return this._diskBudgetSequencer.queue(() => this._reclaimDiskBudgetNow(fumieHome, currentSessionId, sessions, onWillReclaim));
	}

	private async _reclaimDiskBudgetNow(
		fumieHome: URI,
		currentSessionId: string | undefined,
		sessions: readonly IWorktreeDiskBudgetSession[] | undefined,
		onWillReclaim: ((sessionId: string) => Promise<void>) | undefined,
	): Promise<void> {
		const protections = new Map((sessions ?? []).map(session => [sanitizeWorktreeSessionId(session.sessionId), session]));
		if (currentSessionId !== undefined) {
			protections.set(sanitizeWorktreeSessionId(currentSessionId), { sessionId: currentSessionId, running: true, pinned: false });
		}
		const candidates = await this._collectDiskBudgetCandidates(fumieHome, protections, sessions !== undefined);
		await this._diskBudget.reclaim(candidates, async candidate => {
			if (!candidate.repositoryRoot) {
				throw new Error(`Cannot reclaim worktree '${candidate.worktree.fsPath}' because its repository root is unavailable`);
			}
			if (candidate.registered) {
				await onWillReclaim?.(candidate.sessionId);
			}
			await this._removeManagedWorktree(candidate.repositoryRoot, candidate.worktree);
			for (const [sessionId, materialized] of this._materializedWorktrees) {
				if (isEqual(materialized.worktree, candidate.worktree)) {
					this._materializedWorktrees.delete(sessionId);
				}
			}
		});
	}

	private async _collectDiskBudgetCandidates(
		fumieHome: URI,
		protections: ReadonlyMap<string, IWorktreeDiskBudgetSession>,
		allowReclaim: boolean,
	): Promise<IManagedWorktreeDiskBudgetCandidate[]> {
		const candidates: IManagedWorktreeDiskBudgetCandidate[] = [];
		const managedRoot = getManagedWorktreesRoot(fumieHome);
		for (const repositoryEntry of await readDirectoryEntries(managedRoot.fsPath)) {
			if (!repositoryEntry.isDirectory()) {
				continue;
			}
			const repositoryDirectory = URI.joinPath(managedRoot, repositoryEntry.name);
			for (const sessionEntry of await readDirectoryEntries(repositoryDirectory.fsPath)) {
				if (!sessionEntry.isDirectory()) {
					continue;
				}
				const worktree = URI.joinPath(repositoryDirectory, sessionEntry.name);
				const protection = protections.get(sessionEntry.name);
				const persisted = protection?.sessionUri ? await this._readWorktreeMetadata(protection.sessionUri).catch(() => undefined) : undefined;
				const materializedInThisProcess = [...this._materializedWorktrees.values()].some(value => isEqual(value.worktree, worktree));
				let repositoryRoot: URI | undefined;
				let dirty = true;
				try {
					repositoryRoot = await tryResolvePrimaryWorktreeRoot(this._gitService, worktree);
					const currentBranch = await this._gitService.getCurrentBranchName?.(worktree);
					dirty = !repositoryRoot
						|| await this._gitService.hasUncommittedChanges(worktree)
						|| (protection !== undefined && (!persisted?.worktreePath
							|| persisted.ownership !== 'fumie'
							|| !isEqual(persisted.worktreePath, worktree)
							|| !currentBranch
							|| currentBranch !== persisted.branchName));
				} catch {
					// Fail closed: a checkout whose Git state cannot be proven clean is protected.
				}
				const stat = await fs.lstat(worktree.fsPath);
				candidates.push({
					sessionId: protection?.sessionId ?? sessionEntry.name,
					worktreePath: worktree.fsPath,
					worktree,
					repositoryRoot,
					lastUsedAt: stat.mtimeMs,
					running: materializedInThisProcess || protection?.running === true,
					// Registered sessions stay protected until a cross-process lease can
					// prove no other Agent Host is using them. LRU currently reclaims only
					// clean orphaned managed checkouts.
					pinned: !allowReclaim || protection !== undefined,
					dirty,
					registered: protection !== undefined,
				});
			}
		}
		return candidates;
	}

	/** Resolves a persisted working directory, repairing a removed worktree when possible. */
	async resolveWorkingDirectoryForResume(
		sessionUri: URI,
		sessionId: string,
		workingDirectory: URI,
		diskBudgetSessions?: readonly IWorktreeDiskBudgetSession[],
		onWillReclaimWorktree?: (sessionId: string) => Promise<void>,
	): Promise<URI> {
		return this._sequencer.queue(sessionId, () => this._resolveWorkingDirectoryForResume(sessionUri, sessionId, workingDirectory, diskBudgetSessions, onWillReclaimWorktree));
	}

	private async _resolveWorkingDirectoryForResume(
		sessionUri: URI,
		sessionId: string,
		workingDirectory: URI,
		diskBudgetSessions: readonly IWorktreeDiskBudgetSession[] | undefined,
		onWillReclaimWorktree: ((sessionId: string) => Promise<void>) | undefined,
	): Promise<URI> {
		if (workingDirectory.scheme !== Schemas.file) {
			return workingDirectory;
		}
		const meta = await this._readWorktreeMetadata(sessionUri).catch(() => undefined);
		if (await pathExistsStrict(workingDirectory.fsPath)) {
			if (meta?.ownership === 'fumie' && meta.worktreePath && meta.repositoryRoot && isEqual(meta.worktreePath, workingDirectory)) {
				await this._assertManagedWorktree({ branchName: meta.branchName, worktreePath: meta.worktreePath, repositoryRoot: meta.repositoryRoot });
				// A live checkout is authoritative after a crash that captured the
				// archive ref but did not remove the worktree or commit Archived.
				if (!await this._isSessionArchived(sessionUri)) {
					await this._gitService.deleteRefs(meta.repositoryRoot, [getWorktreeArchiveRef(sessionId)]);
				}
			}
			const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
			if (fumieHome) {
				await this._reclaimDiskBudget(fumieHome, sessionId, diskBudgetSessions, onWillReclaimWorktree);
			}
			return workingDirectory;
		}

		const archived = await this._isSessionArchived(sessionUri);
		if (archived) {
			if (meta?.repositoryRoot) {
				try {
					await fs.access(meta.repositoryRoot.fsPath);
					this._logService.info(`[${this._logLabel}:${sessionId}] Archived session working directory '${workingDirectory.fsPath}' is missing; resuming against repository root '${meta.repositoryRoot.fsPath}' for history`);
					return meta.repositoryRoot;
				} catch {
					// Fall through when the repository root is also gone.
				}
			}
			this._logService.warn(`[${this._logLabel}:${sessionId}] Cannot resume archived session: working directory '${workingDirectory.fsPath}' is missing and no usable repository-root fallback was found`);
			throw new SessionWorkingDirectoryMissingError(workingDirectory);
		}

		let recreateFailureReason: string | undefined;
		if (meta?.worktreePath && meta.repositoryRoot && meta.ownership === 'fumie') {
			const { branchName, worktreePath, repositoryRoot } = meta;
			const recreated = await this._recreateWorktree(sessionId, { ...meta, branchName, worktreePath, repositoryRoot });
			if (recreated.ok) {
				try {
					const archiveRef = getWorktreeArchiveRef(sessionId);
					const archiveCommit = await this._gitService.revParse(repositoryRoot, archiveRef);
					if (archiveCommit) {
						await this._restoreArchivedDelta({ ...meta, branchName, worktreePath, repositoryRoot }, archiveRef);
					}
					const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
					if (fumieHome) {
						await this._reclaimDiskBudget(fumieHome, sessionId, diskBudgetSessions, onWillReclaimWorktree);
					}
					if (archiveCommit) {
						await this._gitService.deleteRefs(repositoryRoot, [archiveRef]);
					}
				} catch (error) {
					await this._removeManagedWorktree(repositoryRoot, worktreePath, { force: true });
					this._materializedWorktrees.delete(sessionId);
					throw error;
				}
				this._logService.info(`[${this._logLabel}:${sessionId}] Recreated missing worktree '${worktreePath.fsPath}' for a live session on resume`);
				return worktreePath;
			}
			recreateFailureReason = recreated.reason;
		}

		this._logService.warn(`[${this._logLabel}:${sessionId}] Cannot resume: working directory '${workingDirectory.fsPath}' is missing and its worktree could not be recreated${recreateFailureReason ? `: ${recreateFailureReason}` : ''}`);
		throw new SessionWorkingDirectoryMissingError(workingDirectory, recreateFailureReason);
	}

	/**
	 * Takes (and clears) the pending "worktree created" announcement for a
	 * session so callers can emit it live as the first response part on the
	 * first turn. Returns `undefined` when the session has no pending
	 * announcement.
	 */
	takePendingAnnouncement(sessionId: string): string | undefined {
		const announcement = this._pendingFirstTurnAnnouncements.get(sessionId);
		if (announcement !== undefined) {
			this._pendingFirstTurnAnnouncements.delete(sessionId);
		}
		return announcement;
	}

	async persistCreationFailure(sessionUri: URI, sessionId: string, diagnostic: string | undefined): Promise<void> {
		const dbRef = this._sessionDataService.openDatabase(sessionUri);
		try {
			await dbRef.object.setMetadata(WORKTREE_META_CREATION_FAILURE, JSON.stringify({
				sessionId,
				diagnostic: normalizeWorktreeFailureDiagnostic(diagnostic),
			}));
		} finally {
			dbRef.dispose();
		}
	}

	/**
	 * Re-injects the applicable worktree notice into the first restored turn.
	 *
	 * The live path ({@link takePendingAnnouncement}) handles the very first
	 * turn while the session is fresh; this path takes over on subsequent loads
	 * (where the synthetic announcement is not part of the agent transcript).
	 */
	async applyRestoreAnnouncement(sessionUri: URI, turns: readonly Turn[]): Promise<readonly Turn[]> {
		const notice = await this._readWorktreeNotice(sessionUri).catch(() => undefined);
		if (notice?.kind === 'failure') {
			return prependWorktreeFailureToFirstTurn(turns, notice.diagnostic);
		}
		if (notice?.kind !== 'success') {
			return turns;
		}
		return prependAnnouncementToFirstTurn(turns, buildWorktreeAnnouncementText(notice.branchName));
	}

	/** Resolves the worktree to remove before the session database is deleted. */
	async prepareSessionDeletion(sessionUri: URI, sessionId: string): Promise<IWorktreeHandle | undefined> {
		return this._sequencer.queue(sessionId, async () => {
			const materializedWorktree = this._materializedWorktrees.get(sessionId);
			if (materializedWorktree) {
				return materializedWorktree;
			}
			try {
				const meta = await this._readWorktreeMetadata(sessionUri);
				return meta?.worktreePath && meta.repositoryRoot
					? {
						repositoryRoot: meta.repositoryRoot,
						worktree: meta.worktreePath,
						branchName: meta.branchName,
						ownership: meta.ownership,
						branchOwned: meta.branchOwned,
					}
					: undefined;
			} catch (error) {
				this._logService.warn(`[${this._logLabel}:${sessionId}] Failed to read worktree metadata before session deletion: ${errorMessage(error)}`);
				throw error;
			}
		});
	}

	/** Force-removes the resolved worktree after the user confirms session deletion. */
	async removeSessionWorktree(sessionId: string, worktree: IWorktreeHandle | undefined): Promise<void> {
		return this._sequencer.queue(sessionId, () => this._removeSessionWorktree(sessionId, worktree));
	}

	/** Resolves the durable deletion target before the harness is stopped. */
	async prepareDelete(sessionUri: URI, sessionId: string): Promise<IWorktreeHandle | undefined> {
		return this.prepareSessionDeletion(sessionUri, sessionId);
	}

	/** Public WorktreeService destructive deletion entry. */
	async delete(sessionId: string, worktree: IWorktreeHandle | undefined): Promise<void> {
		return this.removeSessionWorktree(sessionId, worktree);
	}

	private async _removeSessionWorktree(sessionId: string, worktree: IWorktreeHandle | undefined): Promise<void> {
		this.clearPending(sessionId);
		if (!worktree || worktree.ownership !== 'fumie') {
			return;
		}
		const shouldDeleteBranch = worktree.branchOwned !== false;
		const deleteBranch = shouldDeleteBranch ? this._gitService.deleteBranch : undefined;
		if (shouldDeleteBranch && !deleteBranch) {
			throw new Error(localize('worktreeDeleteBranchUnavailable', "Cannot delete Fumie worktree branch '{0}' because branch deletion is unavailable", worktree.branchName));
		}
		try {
			await this._removeManagedWorktree(worktree.repositoryRoot, worktree.worktree, { force: true });
			await this._gitService.deleteRefs(worktree.repositoryRoot, [getWorktreeArchiveRef(sessionId)]);
			// Fail closed: if upstream state cannot be determined, preserve the branch.
			if (deleteBranch) {
				const published = await this._gitService.hasUpstream(worktree.repositoryRoot, worktree.branchName).catch(() => true);
				if (!published && await this._gitService.branchExists(worktree.repositoryRoot, worktree.branchName)) {
					await deleteBranch.call(this._gitService, worktree.repositoryRoot, worktree.branchName, { force: true });
				}
			}
			this._materializedWorktrees.delete(sessionId);
		} catch (error) {
			this._logService.warn(`[${this._logLabel}:${sessionId}] Failed to delete worktree '${worktree.worktree.fsPath}'${shouldDeleteBranch ? ` and its Fumie branch '${worktree.branchName}'` : ''}: ${errorMessage(error)}`);
			throw error;
		}
	}

	/**
	 * On archive, captures Git-visible dirt in a session-private Git ref and
	 * force-removes the checkout. The visible branch is never changed. Ignored
	 * files remain outside the delta and are recreated only through explicit
	 * include/setup inputs. Every Git failure is propagated to the session
	 * lifecycle transaction so Archived is never committed early.
	 */
	async cleanupWorktreeOnArchive(sessionUri: URI, sessionId: string, options?: { readonly preserveChanges?: boolean }): Promise<void> {
		return this._sequencer.queue(sessionId, () => this._cleanupWorktreeOnArchive(sessionUri, sessionId, options));
	}

	/** Public WorktreeService archive entry. */
	async archive(sessionUri: URI, sessionId: string, options?: { readonly preserveChanges?: boolean }): Promise<void> {
		return this.cleanupWorktreeOnArchive(sessionUri, sessionId, options);
	}

	private async _cleanupWorktreeOnArchive(sessionUri: URI, sessionId: string, options: { readonly preserveChanges?: boolean } | undefined): Promise<void> {
		const meta = await this._readWorktreeMetadata(sessionUri);
		if (!meta?.worktreePath || !meta.repositoryRoot || meta.ownership !== 'fumie') {
			return;
		}
		const { branchName, worktreePath, repositoryRoot } = meta;

		const branchPresent = await this._gitService.branchExists(repositoryRoot, branchName);
		if (!branchPresent) {
			throw new WorktreeArchiveUnrecoverableError(localize('worktreeArchiveBranchMissing', "Cannot archive this session because its preserved branch '{0}' is missing", branchName));
		}

		// Idempotent retry after a completed archive: the persisted branch is the
		// restore source, so an already-absent checkout is the desired state.
		if (!await pathExistsStrict(worktreePath.fsPath)) {
			this._materializedWorktrees.delete(sessionId);
			return;
		}
		const currentBranch = await this._gitService.getCurrentBranchName?.(worktreePath);
		if (currentBranch && currentBranch !== branchName) {
			throw new WorktreeArchiveUnrecoverableError(localize('worktreeArchiveBranchChanged', "Cannot archive this session because its worktree switched from the Fumie branch '{0}' to '{1}'", branchName, currentBranch));
		}
		const captureArchiveSnapshot = this._gitService.captureWorktreeArchiveSnapshot;
		if (!captureArchiveSnapshot) {
			throw new Error(localize('worktreeArchiveSnapshotUnavailable', "Cannot archive this session because Git delta snapshots are unavailable"));
		}
		const snapshot = await captureArchiveSnapshot.call(this._gitService, worktreePath);
		if (!snapshot) {
			throw new Error(localize('worktreeArchiveSnapshotFailed', "Cannot archive this session because its working-tree delta could not be captured"));
		}
		const branchHead = await this._gitService.revParse(repositoryRoot, `refs/heads/${branchName}`);
		if (!branchHead || branchHead !== snapshot.baseCommit) {
			throw new Error(localize('worktreeArchiveBranchMoved', "Cannot archive this session because its preserved branch changed while the working-tree delta was captured"));
		}
		const hasArchiveDelta = this._hasArchiveDelta(snapshot);
		if (hasArchiveDelta && options?.preserveChanges === false) {
			throw new WorktreeArchiveChangesConfirmationRequiredError();
		}

		const archiveRef = getWorktreeArchiveRef(sessionId);
		if (hasArchiveDelta) {
			const indexCommitOid = await this._gitService.commitTree(
				repositoryRoot,
				snapshot.indexTreeOid,
				snapshot.baseCommit,
				localize('worktreeIsolation.archiveIndexCommitMessage', 'Fumie session {0} archived index', sessionId),
				{ syntheticIdentity: true },
			);
			if (!indexCommitOid) {
				throw new Error(localize('worktreeArchiveIndexCommitFailed', "Cannot archive this session because its index commit could not be created"));
			}
			let untrackedCommitOid: string | undefined;
			if (snapshot.untrackedTreeOid) {
				untrackedCommitOid = await this._gitService.commitTree(
					repositoryRoot,
					snapshot.untrackedTreeOid,
					undefined,
					localize('worktreeIsolation.archiveUntrackedCommitMessage', 'Fumie session {0} archived untracked files', sessionId),
					{ syntheticIdentity: true },
				);
				if (!untrackedCommitOid) {
					throw new Error(localize('worktreeArchiveUntrackedCommitFailed', "Cannot archive this session because its untracked-files commit could not be created"));
				}
			}
			const commitTreeWithParents = this._gitService.commitTreeWithParents;
			if (!commitTreeWithParents) {
				throw new Error(localize('worktreeArchiveStashUnavailable', "Cannot archive this session because stash commit creation is unavailable"));
			}
			const stashCommitOid = await commitTreeWithParents.call(
				this._gitService,
				repositoryRoot,
				snapshot.workingTreeOid,
				[snapshot.baseCommit, indexCommitOid, ...(untrackedCommitOid ? [untrackedCommitOid] : [])],
				localize('worktreeIsolation.archiveCommitMessage', 'Fumie session {0} archived working-tree delta', sessionId),
				{ syntheticIdentity: true },
			);
			if (!stashCommitOid) {
				throw new Error(localize('worktreeArchiveCommitFailed', "Cannot archive this session because its stash commit could not be created"));
			}
			await this._gitService.updateRef(repositoryRoot, archiveRef, stashCommitOid);
		} else {
			await this._gitService.deleteRefs(repositoryRoot, [archiveRef]);
		}

		const finalSnapshot = await captureArchiveSnapshot.call(this._gitService, worktreePath);
		if (!finalSnapshot || !this._archiveSnapshotsEqual(snapshot, finalSnapshot)) {
			throw new Error(localize('worktreeArchiveChangedDuringCapture', "Cannot archive this session because its index or working tree changed while the archive snapshot was being finalized"));
		}

		// Semantic cleanliness/delta durability is established above. Force is
		// intentional: generated ignored output must not retain the checkout.
		await this._removeManagedWorktree(repositoryRoot, worktreePath, { force: true });
		this._logService.info(`[${this._logLabel}:${sessionId}] Removed worktree '${worktreePath.fsPath}' on archive`);
		this._materializedWorktrees.delete(sessionId);
	}

	/**
	 * On unarchive, recreates the preserved branch and reapplies the optional
	 * session-private delta before consuming its ref.
	 */
	async recreateWorktreeOnUnarchive(
		sessionUri: URI,
		sessionId: string,
		diskBudgetSessions?: readonly IWorktreeDiskBudgetSession[],
		onWillReclaimWorktree?: (sessionId: string) => Promise<void>,
	): Promise<void> {
		return this._sequencer.queue(sessionId, () => this._recreateWorktreeOnUnarchive(sessionUri, sessionId, diskBudgetSessions, onWillReclaimWorktree));
	}

	/** Public WorktreeService restore entry. */
	async restore(
		sessionUri: URI,
		sessionId: string,
		diskBudgetSessions?: readonly IWorktreeDiskBudgetSession[],
		onWillReclaimWorktree?: (sessionId: string) => Promise<void>,
	): Promise<void> {
		return this.recreateWorktreeOnUnarchive(sessionUri, sessionId, diskBudgetSessions, onWillReclaimWorktree);
	}

	private async _recreateWorktreeOnUnarchive(
		sessionUri: URI,
		sessionId: string,
		diskBudgetSessions: readonly IWorktreeDiskBudgetSession[] | undefined,
		onWillReclaimWorktree: ((sessionId: string) => Promise<void>) | undefined,
	): Promise<void> {
		const meta = await this._readWorktreeMetadata(sessionUri);
		if (!meta?.worktreePath || !meta.repositoryRoot || meta.ownership !== 'fumie') {
			return;
		}
		const restorableMeta = { ...meta, worktreePath: meta.worktreePath, repositoryRoot: meta.repositoryRoot };
		let recreatedForRestore = false;
		if (await pathExistsStrict(restorableMeta.worktreePath.fsPath)) {
			await this._assertManagedWorktree(restorableMeta);
		} else {
			const recreated = await this._recreateWorktree(sessionId, restorableMeta);
			if (!recreated.ok) {
				throw new Error(recreated.reason);
			}
			recreatedForRestore = true;
		}

		const { worktreePath, repositoryRoot } = restorableMeta;
		const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
		try {
			const archiveRef = getWorktreeArchiveRef(sessionId);
			const archiveCommit = await this._gitService.revParse(repositoryRoot, archiveRef);
			if (archiveCommit) {
				await this._restoreArchivedDelta(restorableMeta, archiveRef);
			}
			if (recreatedForRestore && fumieHome) {
				await this._reclaimDiskBudget(fumieHome, sessionId, diskBudgetSessions, onWillReclaimWorktree);
			}
			if (archiveCommit) {
				await this._gitService.deleteRefs(repositoryRoot, [archiveRef]);
			}
		} catch (error) {
			if (recreatedForRestore) {
				await this._removeManagedWorktree(repositoryRoot, worktreePath, { force: true });
				this._materializedWorktrees.delete(sessionId);
			}
			throw error;
		}
	}

	private async _restoreArchivedDelta(meta: IWorktreeMetadata & { readonly worktreePath: URI; readonly repositoryRoot: URI }, archiveRef: string): Promise<void> {
		const expected = await this._readArchiveSnapshot(meta.repositoryRoot, archiveRef);
		if (!expected) {
			throw new Error(localize('worktreeArchiveRestoreBaseMismatch', "Cannot restore this session's archived changes because its preserved branch no longer matches the archived base"));
		}
		const captureArchiveSnapshot = this._gitService.captureWorktreeArchiveSnapshot;
		if (!captureArchiveSnapshot) {
			throw new Error(localize('worktreeArchiveSnapshotUnavailable', "Cannot archive this session because Git delta snapshots are unavailable"));
		}
		const live = await captureArchiveSnapshot.call(this._gitService, meta.worktreePath);
		if (!live || live.baseCommit !== expected.baseCommit) {
			throw new Error(localize('worktreeArchiveRestoreBaseMismatch', "Cannot restore this session's archived changes because its preserved branch no longer matches the archived base"));
		}
		if (this._archiveSnapshotsEqual(live, expected)) {
			// A crash may leave both the checkout and its already-applied archive ref.
			// The live four-state snapshot is authoritative, so consuming the ref is
			// sufficient and avoids applying the same stash a second time.
			return;
		}
		if (this._hasArchiveDelta(live)) {
			throw new Error(localize('worktreeArchiveRestoreConflict', "Cannot restore this session because its retained checkout differs from both the archived changes and the clean archived base"));
		}
		const applyArchiveStash = this._gitService.applyWorktreeArchiveStash;
		if (!applyArchiveStash) {
			throw new Error(localize('worktreeArchiveApplyUnavailable', "Cannot restore this session because Git stash restoration is unavailable"));
		}
		await applyArchiveStash.call(this._gitService, meta.worktreePath, archiveRef);

		const restored = await captureArchiveSnapshot.call(this._gitService, meta.worktreePath);
		if (!restored || !this._archiveSnapshotsEqual(restored, expected)) {
			throw new Error(localize('worktreeArchiveRestoreVerificationFailed', "Cannot restore this session because its archived working-tree delta could not be verified"));
		}
	}

	private _hasArchiveDelta(snapshot: IWorktreeArchiveSnapshot): boolean {
		return snapshot.indexTreeOid !== snapshot.baseTreeOid
			|| snapshot.workingTreeOid !== snapshot.baseTreeOid
			|| snapshot.untrackedTreeOid !== undefined;
	}

	private _archiveSnapshotsEqual(left: IWorktreeArchiveSnapshot, right: IWorktreeArchiveSnapshot): boolean {
		return left.baseCommit === right.baseCommit
			&& left.baseTreeOid === right.baseTreeOid
			&& left.indexTreeOid === right.indexTreeOid
			&& left.workingTreeOid === right.workingTreeOid
			&& left.untrackedTreeOid === right.untrackedTreeOid;
	}

	private async _readArchiveSnapshot(repositoryRoot: URI, archiveRef: string): Promise<IWorktreeArchiveSnapshot | undefined> {
		const [baseCommit, baseTreeOid, indexTreeOid, workingTreeOid, untrackedTreeOid] = await Promise.all([
			this._gitService.revParse(repositoryRoot, `${archiveRef}^1`),
			this._gitService.revParse(repositoryRoot, `${archiveRef}^1^{tree}`),
			this._gitService.revParse(repositoryRoot, `${archiveRef}^2^{tree}`),
			this._gitService.revParse(repositoryRoot, `${archiveRef}^{tree}`),
			this._gitService.revParse(repositoryRoot, `${archiveRef}^3^{tree}`),
		]);
		if (!baseCommit || !baseTreeOid || !indexTreeOid || !workingTreeOid) {
			return undefined;
		}
		return {
			baseCommit,
			baseTreeOid,
			indexTreeOid,
			workingTreeOid,
			...(untrackedTreeOid ? { untrackedTreeOid } : {}),
		};
	}

	private async _assertManagedWorktree(meta: { readonly branchName: string; readonly worktreePath: URI; readonly repositoryRoot: URI }): Promise<void> {
		const stat = await fs.lstat(meta.worktreePath.fsPath);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(localize('worktreeRestoreInvalidPath', "Cannot restore this session because its managed worktree path is not a real directory: {0}", meta.worktreePath.fsPath));
		}
		const roots = await this._gitService.getWorktreeRoots(meta.repositoryRoot);
		const managedRealPath = URI.file(await fs.realpath(meta.worktreePath.fsPath));
		const registeredRealPaths = await Promise.all(roots.map(async root => {
			try {
				return URI.file(await fs.realpath(root.fsPath));
			} catch {
				return root;
			}
		}));
		if (!registeredRealPaths.some(root => isEqual(root, managedRealPath))) {
			throw new Error(localize('worktreeRestoreUnregistered', "Cannot restore this session because Git does not register its managed worktree: {0}", meta.worktreePath.fsPath));
		}
		const currentBranch = await this._gitService.getCurrentBranchName?.(meta.worktreePath);
		if (!currentBranch || currentBranch !== meta.branchName) {
			throw new Error(localize('worktreeRestoreBranchMismatch', "Cannot restore this session because its managed worktree is not on the preserved branch '{0}'", meta.branchName));
		}
	}

	private async _recreateWorktree(sessionId: string, meta: { readonly branchName: string; readonly worktreePath: URI; readonly repositoryRoot: URI; readonly branchOwned?: boolean; readonly includeSource?: URI; readonly includeFiles?: readonly string[] }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
		const { branchName, worktreePath, repositoryRoot } = meta;
		const branchPresent = await this._gitService.branchExists(repositoryRoot, branchName);
		if (!branchPresent) {
			const reason = localize('worktreeRecreateBranchMissing', "the branch '{0}' no longer exists", branchName);
			this._logService.info(`[${this._logLabel}:${sessionId}] Cannot recreate worktree: branch '${branchName}' is missing`);
			return { ok: false, reason };
		}
		let added = false;
		try {
			await fs.mkdir(URI.joinPath(worktreePath, '..').fsPath, { recursive: true });
			await this._gitService.addExistingWorktree(repositoryRoot, worktreePath, branchName);
			added = true;
			if (meta.includeSource && meta.includeFiles?.length) {
				try {
					await this._gitService.copyWorktreeIncludeFiles(meta.includeSource, worktreePath, meta.includeFiles);
				} catch (error) {
					await this._removeManagedWorktree(repositoryRoot, worktreePath, { force: true });
					throw error;
				}
			}
			await this._assertManagedWorktree({ branchName, worktreePath, repositoryRoot });
			this._materializedWorktrees.set(sessionId, {
				repositoryRoot,
				worktree: worktreePath,
				branchName,
				ownership: 'fumie',
				branchOwned: meta.branchOwned,
				includeSource: meta.includeSource,
				includeFiles: meta.includeFiles,
				bootstrapComplete: true,
			});
			this._logService.info(`[${this._logLabel}:${sessionId}] Recreated worktree '${worktreePath.fsPath}'`);
			return { ok: true };
		} catch (error) {
			if (added) {
				await this._removeManagedWorktree(repositoryRoot, worktreePath, { force: true }).catch(() => { });
			}
			const reason = errorMessage(error);
			this._logService.warn(`[${this._logLabel}:${sessionId}] Failed to recreate worktree '${worktreePath.fsPath}': ${reason}`);
			return { ok: false, reason };
		}
	}

	/** Reads the persisted worktree metadata for a session, if any. */
	async readWorktreeMetadata(sessionUri: URI): Promise<IWorktreeMetadata | undefined> {
		return this._readWorktreeMetadata(sessionUri);
	}

	/**
	 * Bridges worktree metadata for a legacy session adopted in place, whose
	 * working directory is a pre-existing git worktree the agent host did not
	 * create. When `workingDirectory` is a linked worktree (its checkout root
	 * differs from the repository's primary worktree root), persists the worktree
	 * branch / path / repository-root (and diff base branch) so the adopted
	 * session groups under its repository and computes diffs against the right
	 * base — parity with natively worktree-isolated sessions. Deliberately does
	 * NOT register the worktree as host-created, so disposing the session never
	 * deletes the user-owned worktree. Returns `true` when metadata was recorded.
	 */
	async adoptExistingWorktreeMetadata(sessionUri: URI, workingDirectory: URI): Promise<boolean> {
		const linkedWorktree = await this._resolveLinkedWorktree(workingDirectory);
		if (!linkedWorktree) {
			return false;
		}
		const { worktreeRoot, primaryRoot, baseBranch } = linkedWorktree;
		const branchName = await this._gitService.getCurrentBranch(worktreeRoot).catch(() => undefined) ?? 'HEAD';
		await this._writeWorktreeMetadata(sessionUri, { branchName, baseBranch, worktreePath: worktreeRoot, repositoryRoot: primaryRoot, ownership: 'external' });
		return true;
	}

	/**
	 * Records worktree identity supplied by a predecessor for an adopted session whose
	 * checkout is gone, so resume recreates it exactly like a native worktree session.
	 * Values come from the predecessor's own record rather than probing the (missing)
	 * directory, which is what {@link adoptExistingWorktreeMetadata} requires.
	 */
	async recordAdoptedWorktreeMetadata(sessionUri: URI, metadata: { readonly branchName: string; readonly baseBranch: string | undefined; readonly worktreePath: URI; readonly repositoryRoot: URI }): Promise<void> {
		this._logService.info(`[${this._logLabel}:${AgentSession.id(sessionUri)}] Recorded adopted worktree metadata: worktree='${metadata.worktreePath.fsPath}' branch='${metadata.branchName}' base='${metadata.baseBranch ?? '(none)'}' repo='${metadata.repositoryRoot.fsPath}'`);
		await this._writeWorktreeMetadata(sessionUri, { ...metadata, ownership: 'external', branchOwned: false });
	}

	/**
	 * Records repository identity for an externally-owned linked worktree without taking ownership of its lifecycle.
	 */
	async recordExternalWorktreeProject(sessionUri: URI, workingDirectory: URI): Promise<IAgentSessionProjectInfo | undefined> {
		const linkedWorktree = await this._resolveLinkedWorktree(workingDirectory);
		if (!linkedWorktree) {
			return undefined;
		}
		const { primaryRoot, baseBranch } = linkedWorktree;
		const dbRef = this._sessionDataService.openDatabase(sessionUri);
		try {
			const work: Promise<void>[] = [
				dbRef.object.setMetadata(WORKTREE_META_REPOSITORY_ROOT, primaryRoot.toString()),
			];
			if (baseBranch) {
				work.push(dbRef.object.setMetadata(META_DIFF_BASE_BRANCH, baseBranch));
			}
			await Promise.all(work);
		} finally {
			dbRef.dispose();
		}
		return projectFromRepositoryRoot(primaryRoot);
	}

	private async _resolveLinkedWorktree(workingDirectory: URI): Promise<{ worktreeRoot: URI; primaryRoot: URI; baseBranch: string | undefined } | undefined> {
		const worktreeRoot = await this._gitService.getRepositoryRoot(workingDirectory).catch(() => undefined);
		if (!worktreeRoot) {
			return undefined;
		}
		const primaryRoot = await tryResolvePrimaryWorktreeRoot(this._gitService, worktreeRoot).catch(() => undefined);
		if (!primaryRoot || isEqual(primaryRoot, worktreeRoot)) {
			return undefined;
		}
		const baseBranch = (await this._gitService.getDefaultBranch(primaryRoot).catch(() => undefined))?.name;
		return { worktreeRoot, primaryRoot, baseBranch };
	}

	/**
	 * Resolves the repository "project" for a worktree-isolated session from its
	 * persisted worktree metadata. Worktree sessions run out of a dedicated
	 * worktree directory, but in the sessions UI they must group
	 * under the *repository* (e.g. `vscode`) — not the worktree folder — exactly
	 * like Copilot. Returns the repository root as the project so agents can merge
	 * it into the `project` field of the `IAgentSessionMetadata` reported from
	 * `listSessions` / `getSessionMetadata`; without it a list refresh clears the
	 * transient project set by the materialize event and the workspace reverts to
	 * the worktree directory name. Returns `undefined` for sessions that were never
	 * worktree-isolated, leaving the caller's own folder-based project untouched.
	 */
	async resolveWorktreeProject(sessionUri: URI): Promise<IAgentSessionProjectInfo | undefined> {
		const meta = await this._readWorktreeMetadata(sessionUri).catch(() => undefined);
		return meta?.repositoryRoot ? projectFromRepositoryRoot(meta.repositoryRoot) : undefined;
	}

	private async _resolvePrimaryWorktreeRoot(checkoutRoot: URI, fallbackRoot: URI): Promise<URI> {
		try {
			return await tryResolvePrimaryWorktreeRoot(this._gitService, checkoutRoot) ?? fallbackRoot;
		} catch (error) {
			this._logService.warn(`[${this._logLabel}] Failed to resolve primary worktree for '${checkoutRoot.fsPath}': ${errorMessage(error)}`);
			return fallbackRoot;
		}
	}

	/**
	 * Synchronous companion to {@link resolveWorktreeProject} for the
	 * materialize-event path: the repository project for a worktree this agent
	 * created in the current process, or `undefined` when the session has none.
	 * Lets an agent supply the materialize event's `project` without an async
	 * metadata read so a fresh worktree groups under the repository the moment it
	 * materializes.
	 */
	sessionWorktreeProject(sessionId: string): IAgentSessionProjectInfo | undefined {
		const worktree = this._materializedWorktrees.get(sessionId);
		return worktree ? projectFromRepositoryRoot(worktree.repositoryRoot) : undefined;
	}

	private async _getGitInfo(workingDirectory: URI): Promise<{ currentBranch: string; defaultBranch: IDefaultBranch } | undefined> {
		const repositoryRoot = await this._gitService.getRepositoryRoot(workingDirectory);
		if (!repositoryRoot) {
			return undefined;
		}

		// Skip worktree isolation for a repo with no commits yet (unborn HEAD); `git worktree add` would fail.
		const headCommit = await this._gitService.revParse(repositoryRoot, 'HEAD').catch(() => undefined);
		if (!headCommit) {
			return undefined;
		}

		const currentBranch = await this._gitService.getCurrentBranch(repositoryRoot) ?? 'HEAD';
		const defaultBranch = await this._gitService.getDefaultBranch(repositoryRoot) ?? { name: currentBranch, startPoint: currentBranch };
		return { currentBranch, defaultBranch };
	}

	private async _resolveBranchStartPoint(repositoryRoot: URI, selectedBranch: string): Promise<string> {
		const defaultBranch = await this._gitService.getDefaultBranch(repositoryRoot);
		return defaultBranch?.name === selectedBranch
			? defaultBranch.startPoint
			: selectedBranch;
	}

	private async _writeWorktreeMetadata(sessionUri: URI, metadata: { branchName: string; baseBranch: string | undefined; worktreePath: URI; repositoryRoot: URI; ownership: Exclude<WorktreeOwnership, 'unknown'>; branchOwned?: boolean; includeSource?: URI; includeFiles?: readonly string[] }): Promise<void> {
		const dbRef = this._sessionDataService.openDatabase(sessionUri);
		try {
			// Ownership is the destructive-lifecycle gate. Persist it first so a
			// partial write can never leave an externally adopted checkout looking
			// like unowned legacy metadata eligible for managed-root migration.
			await dbRef.object.setMetadata(WORKTREE_META_OWNERSHIP, metadata.ownership);
			const work: Promise<void>[] = [
				dbRef.object.setMetadata(WORKTREE_META_BRANCH, metadata.branchName),
				dbRef.object.setMetadata(WORKTREE_META_PATH, metadata.worktreePath.toString()),
				dbRef.object.setMetadata(WORKTREE_META_REPOSITORY_ROOT, metadata.repositoryRoot.toString()),
			];
			if (metadata.baseBranch) {
				work.push(dbRef.object.setMetadata(META_DIFF_BASE_BRANCH, metadata.baseBranch));
			}
			if (metadata.branchOwned !== undefined) {
				work.push(dbRef.object.setMetadata(WORKTREE_META_BRANCH_OWNED, String(metadata.branchOwned)));
			}
			if (metadata.includeSource && metadata.includeFiles?.length) {
				work.push(
					dbRef.object.setMetadata(WORKTREE_META_INCLUDE_SOURCE, metadata.includeSource.toString()),
					dbRef.object.setMetadata(WORKTREE_META_INCLUDE_FILES, JSON.stringify(metadata.includeFiles)),
				);
			}
			await Promise.all(work);
		} finally {
			dbRef.dispose();
		}
	}

	/**
	 * Reads persisted worktree metadata, canonicalizing, repairing, and persisting the repository root when needed.
	 * It probes an existing worktree when available and otherwise falls back to the persisted root for archived sessions.
	 * The repair is only reachable when {@link WORKTREE_META_BRANCH} is present, so a root
	 * persisted without its branch will never heal.
	 */
	private async _readWorktreeMetadata(sessionUri: URI): Promise<IWorktreeMetadata | undefined> {
		const ref = await this._sessionDataService.tryOpenDatabase(sessionUri);
		if (!ref) {
			return undefined;
		}

		try {
			const [branchName, worktreePathRaw, repositoryRootRaw, legacyWorkingDirectoryRaw, ownershipRaw, branchOwnedRaw, includeSourceRaw, includeFilesRaw] = await Promise.all([
				ref.object.getMetadata(WORKTREE_META_BRANCH),
				ref.object.getMetadata(WORKTREE_META_PATH),
				ref.object.getMetadata(WORKTREE_META_REPOSITORY_ROOT),
				ref.object.getMetadata(LEGACY_WORKTREE_META_WORKING_DIRECTORY),
				ref.object.getMetadata(WORKTREE_META_OWNERSHIP),
				ref.object.getMetadata(WORKTREE_META_BRANCH_OWNED),
				ref.object.getMetadata(WORKTREE_META_INCLUDE_SOURCE),
				ref.object.getMetadata(WORKTREE_META_INCLUDE_FILES),
			]);
			if (!branchName) {
				return undefined;
			}
			const worktreePath = worktreePathRaw
				? URI.parse(worktreePathRaw)
				: legacyWorkingDirectoryRaw
					? URI.parse(legacyWorkingDirectoryRaw)
					: undefined;
			let repositoryRoot = repositoryRootRaw
				? URI.parse(repositoryRootRaw)
				: worktreePath
					? deriveRepositoryRootFromWorktree(worktreePath)
					: undefined;
			if (repositoryRoot) {
				const checkoutRoot = worktreePath && await fileExists(worktreePath.fsPath) ? worktreePath : repositoryRoot;
				const primaryRoot = await this._resolvePrimaryWorktreeRoot(checkoutRoot, repositoryRoot);
				if (primaryRoot.toString() !== repositoryRoot.toString()) {
					repositoryRoot = primaryRoot;
					try {
						await ref.object.setMetadata(WORKTREE_META_REPOSITORY_ROOT, primaryRoot.toString());
					} catch (error) {
						this._logService.warn(`[${this._logLabel}] Failed to normalize worktree repository metadata for '${sessionUri.toString()}': ${errorMessage(error)}`);
					}
				}
			}
			let ownership: WorktreeOwnership = ownershipRaw === 'fumie' || ownershipRaw === 'external'
				? ownershipRaw
				: 'unknown';
			if (ownership === 'unknown' && worktreePath && repositoryRoot && this._isLegacyManagedWorktreePath(repositoryRoot, worktreePath)) {
				try {
					await ref.object.setMetadata(WORKTREE_META_OWNERSHIP, 'fumie');
					ownership = 'fumie';
				} catch (error) {
					// Fail closed: without a durable ownership marker a later process
					// cannot distinguish this checkout from an adopted user worktree.
					this._logService.warn(`[${this._logLabel}] Failed to migrate Fumie ownership metadata for '${sessionUri.toString()}': ${errorMessage(error)}`);
				}
			}
			const branchOwned = branchOwnedRaw === 'false'
				? false
				: branchOwnedRaw === 'true'
					? true
					: ownership === 'fumie' ? true : undefined;
			let includeFiles: readonly string[] | undefined;
			if (includeFilesRaw) {
				try {
					const parsed: unknown = JSON.parse(includeFilesRaw);
					if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
						includeFiles = parsed;
					}
				} catch {
					// Optional bootstrap metadata is ignored when malformed; branch restore remains usable.
				}
			}
			return {
				branchName,
				worktreePath,
				repositoryRoot,
				ownership,
				branchOwned,
				includeSource: includeSourceRaw ? URI.parse(includeSourceRaw) : undefined,
				includeFiles,
			};
		} finally {
			ref.dispose();
		}
	}

	private _isLegacyManagedWorktreePath(repositoryRoot: URI, worktreePath: URI): boolean {
		const parent = URI.joinPath(worktreePath, '..');
		const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
		const managedRoots = [
			getWorktreesRoot(repositoryRoot),
			...(fumieHome ? [getWorktreesRoot(repositoryRoot, fumieHome), getManagedWorktreeRepositoryRoot(fumieHome, repositoryRoot)] : []),
		];
		return managedRoots.some(root => isEqual(root, parent));
	}

	private async _readWorktreeNotice(sessionUri: URI): Promise<{ kind: 'success'; branchName: string } | { kind: 'failure'; diagnostic?: string } | undefined> {
		const ref = await this._sessionDataService.tryOpenDatabase(sessionUri);
		if (!ref) {
			return undefined;
		}
		try {
			const [branchName, failureRaw] = await Promise.all([
				ref.object.getMetadata(WORKTREE_META_BRANCH),
				ref.object.getMetadata(WORKTREE_META_CREATION_FAILURE),
			]);
			if (branchName) {
				return { kind: 'success', branchName };
			}
			if (!failureRaw) {
				return undefined;
			}
			const failure = JSON.parse(failureRaw);
			if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
				return undefined;
			}
			const raw = failure as Record<string, unknown>;
			if (raw['sessionId'] !== AgentSession.id(sessionUri)) {
				return undefined;
			}
			return {
				kind: 'failure',
				diagnostic: typeof raw['diagnostic'] === 'string' ? normalizeWorktreeFailureDiagnostic(raw['diagnostic']) : undefined,
			};
		} finally {
			ref.dispose();
		}
	}

	private async _isSessionArchived(sessionUri: URI): Promise<boolean> {
		const ref = await this._sessionDataService.tryOpenDatabase(sessionUri);
		if (!ref) {
			return false;
		}
		try {
			const [isArchived, isDone] = await Promise.all([
				ref.object.getMetadata(AH_META_IS_ARCHIVED_DB_KEY),
				ref.object.getMetadata(AH_META_IS_DONE_DB_KEY),
			]);
			return isArchived !== undefined ? isArchived === 'true' : isDone === 'true';
		} finally {
			ref.dispose();
		}
	}
}

/**
 * Derives the repository {@link IAgentSessionProjectInfo} from a repository
 * root URI. The display name is the repo directory's basename (falling back to
 * the URI string for pathological roots), matching how Copilot names the
 * project via `resolveGitProject`.
 */
function projectFromRepositoryRoot(repositoryRoot: URI): IAgentSessionProjectInfo {
	return { uri: repositoryRoot, displayName: basename(repositoryRoot.fsPath) || repositoryRoot.toString() };
}

function deriveRepositoryRootFromWorktree(worktree: URI): URI | undefined {
	if (worktree.scheme !== Schemas.file) {
		return undefined;
	}
	const worktreesRoot = URI.joinPath(worktree, '..');
	const worktreesRootName = basename(worktreesRoot.fsPath);
	const suffix = '.worktrees';
	if (!worktreesRootName.endsWith(suffix)) {
		return undefined;
	}
	const repositoryName = worktreesRootName.slice(0, -suffix.length);
	return repositoryName ? URI.joinPath(worktreesRoot, '..', repositoryName) : undefined;
}

/**
 * Builds the repository {@link IAgentSessionProjectInfo} from a persisted
 * {@link WORKTREE_META_REPOSITORY_ROOT} value (a URI string), or `undefined`
 * when absent. Lets the host merge the repository project into a session's
 * catalog entry directly from a metadata batch it already read, without a
 * second database open.
 */
export function worktreeProjectFromRepositoryRoot(repositoryRootRaw: string | undefined): IAgentSessionProjectInfo | undefined {
	return repositoryRootRaw ? projectFromRepositoryRoot(URI.parse(repositoryRootRaw)) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

async function readDirectoryEntries(path: string) {
	try {
		return await fs.readdir(path, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function removeEmptyDirectory(path: string): Promise<void> {
	try {
		await fs.rmdir(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
			return;
		}
		throw error;
	}
}

/** Returns false only for a missing path; permission and I/O failures remain lifecycle failures. */
async function pathExistsStrict(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
