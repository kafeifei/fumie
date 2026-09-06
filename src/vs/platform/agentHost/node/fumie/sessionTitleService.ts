/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter, raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import type { IAgent } from '../../common/agent.js';
import { buildConversationContext, truncateMiddle } from '../../common/agentHostConversationContext.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { isAhpChatChannel, isDefaultChatUri, type Turn, type URI as ProtocolURI } from '../../common/state/sessionState.js';
import { AgentHostStateManager } from '../agentHostStateManager.js';
import type { GitHubIssueOrPullRequest, IAgentHostOctoKitService } from '../shared/agentHostOctoKitService.js';
import { AGENT_HOST_TITLE_SOURCE_AUTO, AGENT_HOST_TITLE_SOURCE_USER, customChatTitleMetadataKey, customChatTitleSourceMetadataKey, persistSessionMetadata } from '../shared/persistSessionMetadata.js';
import { resolveCurrentSessionModel, type ICurrentSessionModelState } from './currentSessionModel.js';
import { SessionRecordStore } from './sessionRecordStore.js';

const MAX_TITLE_LENGTH = 200;
/**
 * How long the harness gets to name a session before the placeholder stands.
 * A naming turn runs on the session's own reasoning model, which needs more
 * than a handful of seconds: an observed Codex `gpt-5.6-sol` naming turn
 * answered after 19 s, so a 15 s budget threw the title away.
 */
const TITLE_GENERATION_TIMEOUT = 30_000;
const GITHUB_CONTEXT_REQUEST_TIMEOUT = 5_000;
const MAX_CONCURRENT_GITHUB_CONTEXT_REQUESTS = 5;
const MAX_GITHUB_CONTEXT_BODY_CHARS = 4_000;
const MAX_GITHUB_CONTEXT_REFERENCES = 10;
const MAX_TRAILING_HAN_SUFFIX_CODE_UNITS = 6;
const MIN_LATIN_LETTERS_BEFORE_HAN_SUFFIX = 4;
const MIN_LATIN_LETTER_RATIO = 0.8;
const HAN_CHARACTER = /\p{sc=Han}/u;
const TRAILING_HAN_SUFFIX = /(?<!\p{sc=Han})\p{sc=Han}{2,3}$/u;
const GITHUB_ISSUE_OR_PULL_REQUEST_URL_PATTERN = /\bhttps?:\/\/(?<host>[\w.-]+)\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/(?<kind>issues|pull)\/(?<number>\d+)\b/gi;

/**
 * Soft upper bound, in characters, for the whole context handed to the harness
 * when titling a session, including any appended GitHub context.
 */
const MAX_TITLE_CONTEXT_CHARS = 20000;

/**
 * Slice of {@link MAX_TITLE_CONTEXT_CHARS} always available to GitHub context,
 * so a referenced issue title survives even a budget-filling conversation.
 */
const MIN_GITHUB_CONTEXT_CHARS = 4_000;

type GitHubReferenceKind = 'issue' | 'pull request';

interface IGitHubReference {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly kind: GitHubReferenceKind;
}

interface IGitHubReferenceContext {
	readonly reference: IGitHubReference;
	readonly value: GitHubIssueOrPullRequest;
}

/**
 * What a title is being written for: the session itself, or one of its peer
 * chats. The default chat maps to the session, so `chat` is only ever a peer
 * chat and {@link ITitleTarget.key} is the single in-flight key either way.
 */
interface ITitleTarget {
	readonly session: ProtocolURI;
	readonly chat: ProtocolURI | undefined;
	readonly key: ProtocolURI;
}

/** The live state {@link SessionTitleService} reads about a title's target. */
type ITitleTargetState = ICurrentSessionModelState & { readonly title: string };

export interface ISessionTitleServiceOptions {
	readonly sessionDataService: ISessionDataService;
	/** Resolves the harness that owns a session, and so names it. */
	readonly getAgent: (session: ProtocolURI) => IAgent | undefined;
	/** Get the GitHub repository token used to fetch issue and pull request context. */
	readonly getGitHubToken?: () => string | undefined;
	/** Get the configured GitHub host used to validate issue and pull request URLs. */
	readonly getGitHubHost?: () => string | undefined;
	/** GitHub REST client used to fetch issue and pull request context. */
	readonly octoKitService?: IAgentHostOctoKitService;
	readonly gitHubContextRequestTimeout?: number;
	/** Overrides {@link TITLE_GENERATION_TIMEOUT}; tests use it to force a timeout. */
	readonly generateTitleTimeout?: number;
}

/**
 * Fumie's one session-naming path.
 *
 * The first user message writes its own text as a placeholder title
 * immediately, then asks the session's own harness for a better one
 * ({@link IAgent.generateTitle}) exactly once. A success replaces the
 * placeholder; a failure, a timeout, or a rename in the meantime leaves it
 * standing. There is no fallback model and no second refinement pass, and every
 * title this service writes is recorded with the `auto` source — a title the
 * user renamed by hand (`user`) is never overwritten.
 */
export class SessionTitleService extends Disposable {

	/** The one piece of state: the in-flight generation per session or peer chat. */
	private readonly _inflight = new Map<ProtocolURI, CancellationTokenSource>();

	private readonly _records: SessionRecordStore;

	constructor(
		private readonly _stateManager: AgentHostStateManager,
		private readonly _options: ISessionTitleServiceOptions,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._records = new SessionRecordStore(this._options.sessionDataService, this._logService);
	}

	/**
	 * The user's first message in a session (or peer chat): show its text right
	 * away, then let the harness name the session from it.
	 *
	 * Only a still-untitled target is named, and the placeholder written here
	 * titles it synchronously — so this runs at most once per session, and a
	 * session left untitled by a locally handled opening command (a `!command`
	 * never reaches a harness) is named by the first message that does.
	 */
	onFirstUserMessage(session: ProtocolURI, chat: ProtocolURI | undefined, prompt: string): void {
		const target = this._resolveTarget(session, chat);
		const placeholder = this._normalizeTitle(prompt);
		if (!placeholder || this._targetState(target)?.title !== '') {
			return;
		}
		this._applyTitle(target, placeholder);
		this._generateSoon(target, prompt, prompt);
	}

	/**
	 * A forked or imported session/chat inherits history and a placeholder title
	 * (`Forked: …`, or the imported conversation's first message), so no first
	 * user message will ever land on it. This is its one naming request, run
	 * over the inherited turns instead of a prompt.
	 */
	onFork(session: ProtocolURI, chat: ProtocolURI | undefined, turns: readonly Turn[], placeholder: string, sourceTitle?: string): void {
		const target = this._resolveTarget(session, chat);
		const context = this._buildConversationContext(turns, sourceTitle);
		if (!context) {
			return;
		}
		const inheritedTitle = this._normalizeTitle(placeholder);
		if (inheritedTitle) {
			this._applyTitle(target, inheritedTitle);
		}
		this._generateSoon(target, context, undefined);
	}

	/**
	 * The user renamed the session (or peer chat) by hand: drop the in-flight
	 * request so a late generated title cannot clobber their choice. The rename
	 * itself is persisted by the caller with the `user` source, which also locks
	 * the title against any later write.
	 */
	onUserRename(session: ProtocolURI, chat?: ProtocolURI): void {
		this._cancel(this._resolveTarget(session, chat).key);
	}

	/** Drops every in-flight request for a session and its chats (dispose/evict). */
	clear(session: ProtocolURI, chats: readonly ProtocolURI[]): void {
		for (const key of [session, ...chats]) {
			this._cancel(key);
		}
	}

	private _resolveTarget(session: ProtocolURI, chat: ProtocolURI | undefined): ITitleTarget {
		const peerChat = !!chat && isAhpChatChannel(chat) && !isDefaultChatUri(chat) ? chat : undefined;
		return { session, chat: peerChat, key: peerChat ?? session };
	}

	/** Trims, collapses whitespace, and length-caps a candidate title. */
	private _normalizeTitle(text: string): string {
		return Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, MAX_TITLE_LENGTH).join('').trim();
	}

	/**
	 * The live conversation state of whichever of the two the title is for.
	 * A session's own state already carries its default chat's conversation, so
	 * both shapes answer "what is the title, the history, and the model".
	 */
	private _targetState(target: ITitleTarget): ITitleTargetState | undefined {
		return target.chat ? this._stateManager.getChatState(target.chat) : this._stateManager.getSessionState(target.session);
	}

	/** Publishes `title` to live state (when it changed) and persists it as a Fumie `auto` title. */
	private _applyTitle(target: ITitleTarget, title: string): void {
		if (this._targetState(target)?.title !== title) {
			if (target.chat) {
				this._stateManager.updateChatTitle(target.session, target.chat, title);
			} else {
				this._stateManager.dispatchServerAction(target.session, { type: ActionType.SessionTitleChanged, title });
			}
		}
		if (target.chat) {
			this._persistSessionFlag(target.session, customChatTitleMetadataKey(target.chat), title);
			this._persistSessionFlag(target.session, customChatTitleSourceMetadataKey(target.chat), AGENT_HOST_TITLE_SOURCE_AUTO);
			return;
		}
		this._records.update(URI.parse(target.session), { title, titleSource: AGENT_HOST_TITLE_SOURCE_AUTO }).catch(err => {
			this._logService.warn(`[SessionTitleService] Failed to persist title for ${target.session}`, err);
		});
	}

	/**
	 * Whether the target's title was renamed by the user, which no generated
	 * title may replace. Read at the last moment, so a rename that landed while
	 * the harness was thinking still wins.
	 */
	private async _isTitleLocked(target: ITitleTarget): Promise<boolean> {
		if (!target.chat) {
			return (await this._records.read(URI.parse(target.session))).titleLocked;
		}
		const source = await this._readPersistedTitleSource(target.session, customChatTitleSourceMetadataKey(target.chat));
		return source === AGENT_HOST_TITLE_SOURCE_USER;
	}

	private _generateSoon(target: ITitleTarget, promptContent: string, gitHubReferenceSource: string | undefined): void {
		const agent = this._options.getAgent(target.session);
		if (!agent) {
			return;
		}
		this._cancel(target.key);
		const source = new CancellationTokenSource();
		this._inflight.set(target.key, source);
		this._generate(agent, target, promptContent, gitHubReferenceSource, source).catch(err => {
			if (!source.token.isCancellationRequested) {
				this._logService.warn(`[SessionTitleService] Failed to apply generated title for ${target.key}`, err);
			}
		}).finally(() => {
			if (this._inflight.get(target.key) === source) {
				this._inflight.delete(target.key);
				source.dispose();
			}
		});
	}

	private async _generate(agent: IAgent, target: ITitleTarget, promptContent: string, gitHubReferenceSource: string | undefined, source: CancellationTokenSource): Promise<void> {
		const token = source.token;
		const content = gitHubReferenceSource === undefined
			? promptContent
			: await this._appendGitHubContext(promptContent, gitHubReferenceSource, token);
		if (token.isCancellationRequested) {
			this._logSkipped(target, 'cancelled');
			return;
		}
		const modelId = resolveCurrentSessionModel(this._targetState(target))?.id;
		const budget = this._options.generateTitleTimeout ?? TITLE_GENERATION_TIMEOUT;
		this._logService.info(`[SessionTitleService] Naming ${target.key} through ${agent.id} (model=${modelId ?? 'default'}, promptChars=${content.length}, budget=${budget}ms)`);
		let timedOut = false;
		const reply = await raceTimeout(
			agent.generateTitle(URI.parse(target.session), { prompt: content, ...(modelId !== undefined ? { modelId } : {}) }, token),
			budget,
			// Cancels only this request: a later one owns its own source, so a
			// stale timer can never cut short the request that replaced it.
			() => { timedOut = true; source.dispose(true); },
		);
		if (timedOut) {
			this._logSkipped(target, `timed out after ${budget}ms`);
			return;
		}
		if (token.isCancellationRequested) {
			this._logSkipped(target, 'cancelled');
			return;
		}
		if (!reply) {
			this._logSkipped(target, 'empty reply');
			return;
		}
		const title = this._cleanTitle(reply, content);
		if (!title) {
			this._logSkipped(target, 'the reply cleaned to nothing');
			return;
		}
		if (await this._isTitleLocked(target)) {
			this._logSkipped(target, 'the user renamed it');
			return;
		}
		if (token.isCancellationRequested) {
			this._logSkipped(target, 'cancelled');
			return;
		}
		this._applyTitle(target, title);
		this._logService.info(`[SessionTitleService] Applied the generated title for ${target.key}: "${title}"`);
	}

	/** The one place a naming request that produced no title says why. */
	private _logSkipped(target: ITitleTarget, reason: string): void {
		this._logService.info(`[SessionTitleService] Kept the placeholder for ${target.key}: ${reason}`);
	}

	/**
	 * Appends the GitHub issue / pull requests linked from `referenceSource` to
	 * `promptContent`, keeping the combined text within
	 * {@link MAX_TITLE_CONTEXT_CHARS}. Enrichment is guaranteed
	 * {@link MIN_GITHUB_CONTEXT_CHARS}; whatever it leaves over bounds
	 * `promptContent`, whose middle is dropped so the request at its head and
	 * the response tail both survive.
	 */
	private async _appendGitHubContext(promptContent: string, referenceSource: string, token: CancellationToken): Promise<string> {
		const references = this._parseGitHubReferences(referenceSource);
		const githubToken = this._options.getGitHubToken?.();
		const octoKitService = this._options.octoKitService;
		if (references.length === 0 || !githubToken || !octoKitService) {
			return promptContent;
		}

		const abortController = new AbortController();
		const cancellationListener = token.onCancellationRequested(() => abortController.abort());
		const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(this._options.gitHubContextRequestTimeout ?? GITHUB_CONTEXT_REQUEST_TIMEOUT)]);
		const limiter = new Limiter<IGitHubReferenceContext | undefined>(MAX_CONCURRENT_GITHUB_CONTEXT_REQUESTS);
		try {
			const contexts = await Promise.all(references.map(reference => limiter.queue(async () => {
				try {
					const value = await octoKitService.getIssueOrPullRequest(
						reference.owner,
						reference.repo,
						reference.number,
						githubToken,
						signal,
					);
					return { reference, value };
				} catch (error) {
					if (!token.isCancellationRequested) {
						this._logService.warn(`[SessionTitleService] Failed to fetch GitHub ${reference.kind} ${reference.owner}/${reference.repo}#${reference.number}`, error);
					}
					return undefined;
				}
			})));
			const successfulContexts = contexts.filter(context => context !== undefined);
			if (successfulContexts.length === 0) {
				return promptContent;
			}
			const separator = '\n\n';
			const gitHubBudget = Math.max(MIN_GITHUB_CONTEXT_CHARS, MAX_TITLE_CONTEXT_CHARS - promptContent.length - separator.length);
			const gitHubContext = this._formatGitHubContexts(successfulContexts, gitHubBudget);
			const contentBudget = Math.max(0, MAX_TITLE_CONTEXT_CHARS - gitHubContext.length - separator.length);
			const content = promptContent.length > contentBudget ? truncateMiddle(promptContent, contentBudget) : promptContent;
			return `${content}${separator}${gitHubContext}`;
		} finally {
			limiter.dispose();
			cancellationListener.dispose();
		}
	}

	private _parseGitHubReferences(text: string): IGitHubReference[] {
		const references: IGitHubReference[] = [];
		const seen = new Set<string>();
		const configuredHost = this._normalizeGitHubHost(this._options.getGitHubHost?.() ?? 'github.com');
		for (const match of text.matchAll(GITHUB_ISSUE_OR_PULL_REQUEST_URL_PATTERN)) {
			const host = match.groups?.host;
			const owner = match.groups?.owner;
			const repo = match.groups?.repo;
			const rawKind = match.groups?.kind;
			const number = Number(match.groups?.number);
			if (!host || this._normalizeGitHubHost(host) !== configuredHost || !owner || !repo || (rawKind !== 'issues' && rawKind !== 'pull') || !Number.isSafeInteger(number) || number <= 0) {
				continue;
			}
			const kind: GitHubReferenceKind = rawKind === 'issues' ? 'issue' : 'pull request';
			const key = `${owner.toLowerCase()}/${repo.toLowerCase()}/${kind}/${number}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			references.push({ owner, repo, number, kind });
			if (references.length === MAX_GITHUB_CONTEXT_REFERENCES) {
				break;
			}
		}
		return references;
	}

	private _normalizeGitHubHost(host: string): string {
		const normalizedHost = host.toLowerCase();
		return normalizedHost === 'www.github.com' ? 'github.com' : normalizedHost;
	}

	private _formatGitHubContexts(contexts: readonly IGitHubReferenceContext[], budget: number): string {
		const heading = 'GitHub issue and pull request context:\n\n';
		const fixedLength = heading.length + contexts.reduce((length, context, index) => {
			return length + this._formatGitHubContext(context.reference, context.value, '').length + (index === 0 ? 0 : 2);
		}, 0);
		let remainingBodyBudget = Math.max(0, budget - fixedLength);
		const sections = contexts.map((context, index) => {
			const bodyBudget = Math.min(
				MAX_GITHUB_CONTEXT_BODY_CHARS,
				Math.floor(remainingBodyBudget / (contexts.length - index)),
			);
			const body = truncateMiddle(context.value.body, bodyBudget);
			remainingBodyBudget -= body.length;
			return this._formatGitHubContext(context.reference, context.value, body);
		});
		return truncateMiddle(`${heading}${sections.join('\n\n')}`, budget);
	}

	private _formatGitHubContext(reference: IGitHubReference, value: GitHubIssueOrPullRequest, body: string): string {
		return [
			`GitHub ${reference.kind} ${reference.owner}/${reference.repo}#${reference.number}:`,
			`The title of the ${reference.kind} is: ${value.title}`,
			`The body of the ${reference.kind} is:`,
			body,
		].join('\n');
	}

	private _cleanTitle(rawTitle: string, promptContent: string): string | undefined {
		let title = rawTitle.trim();
		const firstLine = title.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
		title = firstLine ?? '';
		if (title.startsWith('"') && title.endsWith('"') && title.length > 1) {
			title = title.slice(1, -1).trim();
		}
		title = title.replace(/[.!?]+$/, '').trim();

		if (!title || title.includes('can\'t assist with that')) {
			return undefined;
		}
		title = title.slice(0, MAX_TITLE_LENGTH + MAX_TRAILING_HAN_SUFFIX_CODE_UNITS);
		return this._stripUnexpectedTrailingHanSuffix(title, promptContent).slice(0, MAX_TITLE_LENGTH);
	}

	private _stripUnexpectedTrailingHanSuffix(title: string, promptContent: string): string {
		if (HAN_CHARACTER.test(promptContent)) {
			return title;
		}

		const suffix = TRAILING_HAN_SUFFIX.exec(title);
		if (!suffix) {
			return title;
		}

		const prefix = title.slice(0, suffix.index).trimEnd();
		const letterCount = prefix.match(/\p{L}/gu)?.length ?? 0;
		const latinLetterCount = prefix.match(/\p{sc=Latin}/gu)?.length ?? 0;
		if (latinLetterCount < MIN_LATIN_LETTERS_BEFORE_HAN_SUFFIX || latinLetterCount / letterCount < MIN_LATIN_LETTER_RATIO) {
			return title;
		}

		return prefix;
	}

	/**
	 * Builds the naming context for a fork or import by concatenating each
	 * inherited turn's user request and textual response. Only normal text
	 * (markdown) response parts are considered — tool calls, reasoning, and
	 * other parts are ignored. When the fork's `sourceTitle` is known, a short
	 * framing note is prepended so the model understands the conversation is a
	 * branch continued from an earlier chat. The conversation is
	 * middle-truncated to {@link MAX_TITLE_CONTEXT_CHARS}; the framing note is
	 * always preserved in full.
	 *
	 * @returns the context string, or `undefined` when no turn carries any text
	 * worth titling from.
	 */
	private _buildConversationContext(turns: readonly Turn[], sourceTitle?: string): string | undefined {
		const framedTitle = sourceTitle?.trim();
		const framing = framedTitle
			? `This conversation was branched from an earlier chat titled "${framedTitle}". The turns below, oldest first, are the inherited history up to the branch point.\n\n`
			: undefined;
		return buildConversationContext(turns, { maxChars: MAX_TITLE_CONTEXT_CHARS, framing });
	}

	private _persistSessionFlag(session: ProtocolURI, key: string, value: string): void {
		persistSessionMetadata(this._options.sessionDataService, this._logService, session, key, value);
	}

	private async _readPersistedTitleSource(session: ProtocolURI, key: string): Promise<string | undefined> {
		try {
			const ref = await this._options.sessionDataService.tryOpenDatabase?.(URI.parse(session));
			if (!ref) {
				return undefined;
			}
			try {
				return await ref.object.getMetadata(key);
			} finally {
				ref.dispose();
			}
		} catch (err) {
			this._logService.warn(`[SessionTitleService] Failed to read title source '${key}'`, err);
			return undefined;
		}
	}

	private _cancel(key: ProtocolURI): void {
		const source = this._inflight.get(key);
		if (!source) {
			return;
		}
		source.dispose(true);
		this._inflight.delete(key);
	}

	override dispose(): void {
		for (const source of this._inflight.values()) {
			source.dispose(true);
		}
		this._inflight.clear();
		super.dispose();
	}
}
