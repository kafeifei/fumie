/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { buildChatUri, buildDefaultChatUri, MessageKind, ResponsePartKind, SessionStatus, TurnState, type ResponsePart, type SessionSummary, type Turn } from '../../../common/state/sessionState.js';
import { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { SessionTitleService } from '../../../node/fumie/sessionTitleService.js';
import { type AutoMergeMethod, type CreatedPullRequest, type GitHubIssueOrPullRequest, type IAgentHostOctoKitService } from '../../../node/shared/agentHostOctoKitService.js';
import { AGENT_HOST_TITLE_SOURCE_AUTO, AGENT_HOST_TITLE_SOURCE_USER, customChatTitleMetadataKey, customChatTitleSourceMetadataKey, SESSION_CUSTOM_TITLE_KEY, SESSION_CUSTOM_TITLE_SOURCE_KEY } from '../../../node/shared/persistSessionMetadata.js';
import { createSessionDataService, TestSessionDatabase } from '../../common/sessionTestHelpers.js';
import { MockAgent } from '../mockAgent.js';

class TestAgentHostOctoKitService implements IAgentHostOctoKitService {
	declare readonly _serviceBrand: undefined;

	readonly calls: { owner: string; repo: string; number: number; token: string; signal: AbortSignal }[] = [];
	readonly responses = new Map<string, GitHubIssueOrPullRequest | Error>();
	readonly pendingResponses = new Set<string>();

	async createPullRequest(): Promise<CreatedPullRequest> {
		throw new Error('not used');
	}

	async findPullRequestByHeadBranch(): Promise<CreatedPullRequest | undefined> {
		throw new Error('not used');
	}

	async findPullRequestByHeadSha(): Promise<CreatedPullRequest | undefined> {
		throw new Error('not used');
	}

	async getIssueOrPullRequest(owner: string, repo: string, number: number, token: string, signal: AbortSignal): Promise<GitHubIssueOrPullRequest> {
		this.calls.push({ owner, repo, number, token, signal });
		const key = `${owner}/${repo}#${number}`;
		if (this.pendingResponses.has(key)) {
			return new Promise((_resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		}
		const response = this.responses.get(key);
		if (response instanceof Error) {
			throw response;
		}
		if (!response) {
			throw new Error('missing test response');
		}
		return response;
	}

	async enablePullRequestAutoMerge(_pullRequestId: string, _mergeMethod: AutoMergeMethod): Promise<void> {
		throw new Error('not used');
	}
}

/** Captures the `info` lines so a test can assert the outcome the service logged. */
class RecordingLogService extends NullLogService {
	readonly infos: string[] = [];

	override info(message: string): void {
		this.infos.push(message);
	}
}

suite('SessionTitleService', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createSummary(session: URI, title = ''): SessionSummary {
		return {
			resource: session.toString(),
			provider: 'copilot',
			title,
			status: SessionStatus.Idle,
			createdAt: new Date(1).toISOString(),
			modifiedAt: new Date(1).toISOString(),
		};
	}

	async function waitForCondition(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
		for (let i = 0; i < 20; i++) {
			if (await predicate()) {
				return;
			}
			await timeout(5);
		}
		assert.ok(await predicate(), message);
	}

	interface ISetupOptions {
		/** Title the session already carries. */
		readonly title?: string;
		/** Reply the harness produces for the naming request. */
		readonly generatedTitle?: string;
		/** Replaces {@link generatedTitle} when a test needs to delay or hang the request. */
		readonly generateTitleHandler?: (session: URI, request: { readonly prompt: string; readonly modelId?: string }, token: CancellationToken) => Promise<string | undefined>;
		readonly octoKitService?: TestAgentHostOctoKitService;
		readonly getGitHubToken?: () => string | undefined;
		readonly getGitHubHost?: () => string | undefined;
		readonly gitHubContextRequestTimeout?: number;
		readonly generateTitleTimeout?: number;
	}

	function setup(options: ISetupOptions = {}): {
		service: SessionTitleService;
		stateManager: AgentHostStateManager;
		agent: MockAgent;
		session: URI;
		db: TestSessionDatabase;
		titleActions: string[];
		octoKitService: TestAgentHostOctoKitService;
		logService: RecordingLogService;
	} {
		const stateManager = disposables.add(new AgentHostStateManager(new NullLogService()));
		const db = new TestSessionDatabase();
		const session = URI.parse('agenthost-session://copilot/session-title-test');
		stateManager.createSession(createSummary(session, options.title ?? ''));
		const titleActions: string[] = [];
		disposables.add(stateManager.onDidEmitEnvelope(e => {
			if (e.action.type === ActionType.SessionTitleChanged) {
				titleActions.push(e.action.title);
			}
		}));
		const agent = new MockAgent('copilot');
		disposables.add(agent);
		agent.generatedTitle = options.generatedTitle ?? 'Generated title';
		agent.generateTitleHandler = options.generateTitleHandler;
		const octoKitService = options.octoKitService ?? new TestAgentHostOctoKitService();
		const logService = new RecordingLogService();
		const service = disposables.add(new SessionTitleService(stateManager, {
			sessionDataService: createSessionDataService(db),
			getAgent: () => agent,
			getGitHubToken: options.getGitHubToken ?? (() => 'github-token'),
			getGitHubHost: options.getGitHubHost ?? (() => 'github.com'),
			octoKitService,
			...(options.gitHubContextRequestTimeout !== undefined ? { gitHubContextRequestTimeout: options.gitHubContextRequestTimeout } : {}),
			...(options.generateTitleTimeout !== undefined ? { generateTitleTimeout: options.generateTitleTimeout } : {}),
		}, logService));
		return { service, stateManager, agent, session, db, titleActions, octoKitService, logService };
	}

	function textPart(content: string): ResponsePart {
		return { kind: ResponsePartKind.Markdown, id: 'm1', content };
	}

	function turn(id: string, text: string, responseParts: ResponsePart[]): Turn {
		return {
			id,
			message: { text, origin: { kind: MessageKind.User } },
			responseParts,
			usage: undefined,
			state: TurnState.Complete,
		};
	}

	test('shows the first prompt right away, then the single title the harness generates', async () => {
		const { service, stateManager, agent, session, db, titleActions } = setup({ generatedTitle: '"Generated title."' });

		service.onFirstUserMessage(session.toString(), undefined, '  Please   explain title generation  ');
		// The placeholder is applied synchronously, before any harness request.
		const placeholder = stateManager.getSessionState(session.toString())?.title;
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		assert.deepStrictEqual({
			placeholder,
			titles: titleActions,
			requests: agent.generateTitleCalls.map(call => ({ session: call.session.toString(), prompt: call.prompt, modelId: call.modelId })),
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			persistedSource: await db.getMetadata(SESSION_CUSTOM_TITLE_SOURCE_KEY),
		}, {
			placeholder: 'Please explain title generation',
			titles: ['Please explain title generation', 'Generated title'],
			requests: [{ session: session.toString(), prompt: '  Please   explain title generation  ', modelId: undefined }],
			persistedTitle: 'Generated title',
			persistedSource: AGENT_HOST_TITLE_SOURCE_AUTO,
		});
	});

	test('names the session on the model its conversation is currently using', async () => {
		const { service, stateManager, agent, session } = setup();
		stateManager.dispatchServerAction(buildDefaultChatUri(session.toString()), {
			type: ActionType.ChatDraftChanged,
			draft: { text: 'Explain the model plumbing', origin: { kind: MessageKind.User }, model: { id: 'claude-sonnet-4' } },
		});

		service.onFirstUserMessage(session.toString(), undefined, 'Explain the model plumbing');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');

		assert.strictEqual(agent.generateTitleCalls[0].modelId, 'claude-sonnet-4');
	});

	test('a session that already has a title is left alone', async () => {
		const { service, stateManager, agent, session, db, titleActions } = setup({ title: 'Forked: Source title' });

		service.onFirstUserMessage(session.toString(), undefined, 'Continue forked session');
		await timeout(10);

		assert.deepStrictEqual({
			requests: agent.generateTitleCalls.length,
			title: stateManager.getSessionState(session.toString())?.title,
			titles: titleActions,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
		}, {
			requests: 0,
			title: 'Forked: Source title',
			titles: [],
			persistedTitle: undefined,
		});
	});

	test('titles a peer chat under its own metadata keys', async () => {
		const { service, stateManager, agent, session, db, titleActions } = setup({ title: 'Session title', generatedTitle: 'Peer chat title' });
		const chat = buildChatUri(session.toString(), 'peer-1');
		stateManager.addChat(session.toString(), chat, {});

		service.onFirstUserMessage(session.toString(), chat, 'Investigate peer chat');
		await waitForCondition(async () => await db.getMetadata(customChatTitleMetadataKey(chat)) === 'Peer chat title', 'peer chat title should be persisted');

		assert.deepStrictEqual({
			requests: agent.generateTitleCalls.length,
			chatTitle: stateManager.getChatState(chat)?.title,
			sessionTitle: stateManager.getSessionState(session.toString())?.title,
			sessionTitleActions: titleActions,
			persistedChatSource: await db.getMetadata(customChatTitleSourceMetadataKey(chat)),
			persistedSessionTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
		}, {
			requests: 1,
			chatTitle: 'Peer chat title',
			sessionTitle: 'Session title',
			sessionTitleActions: [],
			persistedChatSource: AGENT_HOST_TITLE_SOURCE_AUTO,
			persistedSessionTitle: undefined,
		});
	});

	test('a harness that cannot name the session leaves the placeholder standing', async () => {
		const { service, stateManager, agent, session, db } = setup({ generateTitleHandler: async () => undefined });

		service.onFirstUserMessage(session.toString(), undefined, 'Explain workspace search indexing');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');
		await timeout(10);

		assert.deepStrictEqual({
			title: stateManager.getSessionState(session.toString())?.title,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
		}, {
			title: 'Explain workspace search indexing',
			persistedTitle: 'Explain workspace search indexing',
		});
	});

	test('a naming request that outruns the timeout is cancelled, logs why, and the placeholder stands', async () => {
		let requestToken: CancellationToken | undefined;
		const { service, stateManager, agent, session, db, logService } = setup({
			generateTitleTimeout: 1,
			generateTitleHandler: (_session, _request, token) => {
				requestToken = token;
				return new Promise(() => { });
			},
		});

		service.onFirstUserMessage(session.toString(), undefined, 'Investigate a very slow harness');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');
		await waitForCondition(() => requestToken?.isCancellationRequested === true, 'the timed-out request should be cancelled');
		await waitForCondition(() => logService.infos.some(line => line.includes('timed out after 1ms')), 'the skipped request should say why');

		assert.deepStrictEqual({
			title: stateManager.getSessionState(session.toString())?.title,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			outcomes: logService.infos.filter(line => line.includes('Kept the placeholder')),
		}, {
			title: 'Investigate a very slow harness',
			persistedTitle: 'Investigate a very slow harness',
			outcomes: [`[SessionTitleService] Kept the placeholder for ${session.toString()}: timed out after 1ms`],
		});
	});

	test('a rename drops the in-flight request so a late title cannot clobber it', async () => {
		let resolveTitle!: (title: string) => void;
		const { service, stateManager, agent, session, db } = setup({
			generateTitleHandler: () => new Promise(resolve => { resolveTitle = resolve; }),
		});

		service.onFirstUserMessage(session.toString(), undefined, 'Create title tests');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');
		stateManager.dispatchServerAction(session.toString(), { type: ActionType.SessionTitleChanged, title: 'Manual title' });
		service.onUserRename(session.toString());
		resolveTitle('Generated title');
		await timeout(10);

		assert.deepStrictEqual({
			title: stateManager.getSessionState(session.toString())?.title,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
		}, {
			title: 'Manual title',
			persistedTitle: 'Create title tests',
		});
	});

	test('a title the user renamed by hand is never replaced by a generated one', async () => {
		let resolveTitle!: (title: string) => void;
		const { service, stateManager, agent, session, db } = setup({
			generateTitleHandler: () => new Promise(resolve => { resolveTitle = resolve; }),
		});

		service.onFirstUserMessage(session.toString(), undefined, 'Investigate the title lock');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');
		// The rename lands while the harness is thinking, persisted by the rename
		// path itself rather than through this service.
		await db.setMetadataValues({
			[SESSION_CUSTOM_TITLE_KEY]: 'Manual title',
			[SESSION_CUSTOM_TITLE_SOURCE_KEY]: AGENT_HOST_TITLE_SOURCE_USER,
		});
		stateManager.dispatchServerAction(session.toString(), { type: ActionType.SessionTitleChanged, title: 'Manual title' });
		resolveTitle('Generated title');
		await timeout(10);

		assert.deepStrictEqual({
			title: stateManager.getSessionState(session.toString())?.title,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			persistedSource: await db.getMetadata(SESSION_CUSTOM_TITLE_SOURCE_KEY),
		}, {
			title: 'Manual title',
			persistedTitle: 'Manual title',
			persistedSource: AGENT_HOST_TITLE_SOURCE_USER,
		});
	});

	test('clear cancels the in-flight request for a session and its chats', async () => {
		let resolveTitle!: (title: string) => void;
		const { service, stateManager, agent, session, db } = setup({
			generateTitleHandler: () => new Promise(resolve => { resolveTitle = resolve; }),
		});
		const chat = buildChatUri(session.toString(), 'peer-clear');
		stateManager.addChat(session.toString(), chat, {});

		service.onFirstUserMessage(session.toString(), chat, 'Investigate a cleared chat');
		await waitForCondition(() => agent.generateTitleCalls.length === 1, 'the harness should be asked once');
		service.clear(session.toString(), [chat]);
		resolveTitle('Generated title');
		await timeout(10);

		assert.deepStrictEqual({
			chatTitle: stateManager.getChatState(chat)?.title,
			persistedChatTitle: await db.getMetadata(customChatTitleMetadataKey(chat)),
		}, {
			chatTitle: 'Investigate a cleared chat',
			persistedChatTitle: 'Investigate a cleared chat',
		});
	});

	test('onFork replaces the inherited title using the whole forked conversation', async () => {
		const { service, stateManager, agent, session, db, titleActions } = setup({ title: 'Forked: Source title', generatedTitle: 'Compaction strategy' });

		stateManager.seedDefaultChatTurns(session.toString(), [
			turn('turn-1', 'Add dark mode toggle', [textPart('Implemented the toggle in settings.')]),
			turn('turn-2', 'Now compact the history', [textPart('Summarized earlier turns.')]),
		]);
		const turns = stateManager.getSessionState(session.toString())!.turns;
		service.onFork(session.toString(), undefined, turns, 'Forked: Source title', 'Source title');
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Compaction strategy', 'forked title should be persisted');

		const prompt = agent.generateTitleCalls[0]?.prompt ?? '';
		assert.deepStrictEqual({
			titles: titleActions,
			requests: agent.generateTitleCalls.length,
			persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			framesAsBranch: prompt.includes('branched from an earlier chat titled "Source title"'),
			includesFirstTurn: prompt.includes('Add dark mode toggle') && prompt.includes('Implemented the toggle in settings.'),
			includesSecondTurn: prompt.includes('Now compact the history') && prompt.includes('Summarized earlier turns.'),
		}, {
			titles: ['Compaction strategy'],
			requests: 1,
			persistedTitle: 'Compaction strategy',
			framesAsBranch: true,
			includesFirstTurn: true,
			includesSecondTurn: true,
		});
	});

	test('onFirstUserMessage appends every unique GitHub issue and pull request', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#123', { title: 'Issue title', body: 'Issue body' });
		octoKitService.responses.set('microsoft/vscode#456', { title: 'Pull request title', body: 'Pull request body' });
		const { service, agent, session, db } = setup({ octoKitService });
		const prompt = 'Fix https://github.com/microsoft/vscode/issues/123 and review https://github.com/microsoft/vscode/pull/456. Duplicate: https://www.github.com/microsoft/vscode/issues/123#issuecomment-1';

		service.onFirstUserMessage(session.toString(), undefined, prompt);
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		assert.deepStrictEqual({
			calls: octoKitService.calls.map(call => ({ owner: call.owner, repo: call.repo, number: call.number, token: call.token })),
			prompt: agent.generateTitleCalls[0]?.prompt,
		}, {
			calls: [
				{ owner: 'microsoft', repo: 'vscode', number: 123, token: 'github-token' },
				{ owner: 'microsoft', repo: 'vscode', number: 456, token: 'github-token' },
			],
			prompt: [
				prompt,
				'',
				'GitHub issue and pull request context:',
				'',
				'GitHub issue microsoft/vscode#123:',
				'The title of the issue is: Issue title',
				'The body of the issue is:',
				'Issue body',
				'',
				'GitHub pull request microsoft/vscode#456:',
				'The title of the pull request is: Pull request title',
				'The body of the pull request is:',
				'Pull request body',
			].join('\n'),
		});
	});

	test('only fetches links from the configured GitHub host', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#456', { title: 'Enterprise issue', body: 'Enterprise body' });
		const { service, agent, session, db } = setup({ octoKitService, getGitHubHost: () => 'github.enterprise.test' });
		const prompt = 'Compare https://github.com/microsoft/vscode/issues/123 with https://github.enterprise.test/microsoft/vscode/issues/456';

		service.onFirstUserMessage(session.toString(), undefined, prompt);
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		const titlePrompt = agent.generateTitleCalls[0]?.prompt ?? '';
		assert.deepStrictEqual({
			calls: octoKitService.calls.map(call => call.number),
			hasGitHubIssue: titlePrompt.includes('microsoft/vscode#123:'),
			hasEnterpriseIssue: titlePrompt.includes('The title of the issue is: Enterprise issue'),
		}, {
			calls: [456],
			hasGitHubIssue: false,
			hasEnterpriseIssue: true,
		});
	});

	test('fetches at most ten GitHub references', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		const links: string[] = [];
		for (let number = 1; number <= 11; number++) {
			octoKitService.responses.set(`microsoft/vscode#${number}`, { title: `Issue ${number}`, body: `Body ${number}` });
			links.push(`https://github.com/microsoft/vscode/issues/${number}`);
		}
		const { service, agent, session, db } = setup({ octoKitService });

		service.onFirstUserMessage(session.toString(), undefined, links.join(' '));
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		const titlePrompt = agent.generateTitleCalls[0]?.prompt ?? '';
		assert.deepStrictEqual({
			calls: octoKitService.calls.map(call => call.number),
			hasTenthContext: titlePrompt.includes('The title of the issue is: Issue 10'),
			hasEleventhContext: titlePrompt.includes('The title of the issue is: Issue 11'),
		}, {
			calls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			hasTenthContext: true,
			hasEleventhContext: false,
		});
	});

	test('omits GitHub context when the request fails', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#123', new Error('Not found'));
		const { service, agent, session, db } = setup({ octoKitService });
		const prompt = 'Fix https://github.com/microsoft/vscode/issues/123';

		service.onFirstUserMessage(session.toString(), undefined, prompt);
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		assert.strictEqual(agent.generateTitleCalls[0]?.prompt, prompt);
	});

	test('keeps successful GitHub context when another request fails', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#123', { title: 'Issue title', body: 'Issue body' });
		octoKitService.responses.set('microsoft/vscode#456', new Error('Not found'));
		const { service, agent, session, db } = setup({ octoKitService });

		service.onFirstUserMessage(session.toString(), undefined, 'Fix https://github.com/microsoft/vscode/issues/123 and https://github.com/microsoft/vscode/pull/456');
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		const titlePrompt = agent.generateTitleCalls[0]?.prompt ?? '';
		assert.deepStrictEqual({
			hasIssue: titlePrompt.includes('The title of the issue is: Issue title'),
			hasPullRequest: titlePrompt.includes('GitHub pull request microsoft/vscode#456:'),
		}, {
			hasIssue: true,
			hasPullRequest: false,
		});
	});

	test('times out GitHub context requests', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.pendingResponses.add('microsoft/vscode#123');
		const { service, agent, session, db } = setup({ octoKitService, gitHubContextRequestTimeout: 1 });
		const prompt = 'Fix https://github.com/microsoft/vscode/issues/123';

		service.onFirstUserMessage(session.toString(), undefined, prompt);
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted after the GitHub request times out');

		assert.deepStrictEqual({
			requestAborted: octoKitService.calls[0].signal.aborted,
			prompt: agent.generateTitleCalls[0]?.prompt,
		}, {
			requestAborted: true,
			prompt,
		});
	});

	test('caps each appended GitHub body at 4000 characters', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#123', { title: 'Issue title', body: `start\n${'x'.repeat(30_000)}\nend` });
		const { service, agent, session, db } = setup({ octoKitService });

		service.onFirstUserMessage(session.toString(), undefined, 'Fix https://github.com/microsoft/vscode/issues/123');
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		const titlePrompt = agent.generateTitleCalls[0]?.prompt ?? '';
		const context = titlePrompt.slice(titlePrompt.indexOf('GitHub issue and pull request context:'));
		const bodyMarker = 'The body of the issue is:\n';
		const body = context.slice(context.indexOf(bodyMarker) + bodyMarker.length);
		assert.deepStrictEqual({
			bodyLength: body.length,
			hasStart: body.includes('start'),
			hasTruncationMarker: body.includes('\n...\n'),
			hasEnd: body.includes('end'),
		}, {
			bodyLength: 4_000,
			hasStart: true,
			hasTruncationMarker: true,
			hasEnd: true,
		});
	});

	test('caps the combined prompt and GitHub context', async () => {
		const octoKitService = new TestAgentHostOctoKitService();
		octoKitService.responses.set('microsoft/vscode#123', { title: `start${'x'.repeat(30_000)}end`, body: '' });
		const { service, agent, session, db } = setup({ octoKitService });
		const prompt = 'Fix https://github.com/microsoft/vscode/issues/123';

		service.onFirstUserMessage(session.toString(), undefined, prompt);
		await waitForCondition(async () => await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === 'Generated title', 'generated title should be persisted');

		const titlePrompt = agent.generateTitleCalls[0]?.prompt ?? '';
		const promptContent = titlePrompt.slice(0, titlePrompt.indexOf('GitHub issue and pull request context:'));
		const context = titlePrompt.slice(titlePrompt.indexOf('GitHub issue and pull request context:'));
		assert.deepStrictEqual({
			withinBudget: titlePrompt.length <= 20_000,
			keepsRequest: promptContent.startsWith(prompt),
			hasStart: context.includes('start'),
			hasTruncationMarker: context.includes('\n...\n'),
			hasEnd: context.includes('end'),
		}, {
			withinBudget: true,
			keepsRequest: true,
			hasStart: true,
			hasTruncationMarker: true,
			hasEnd: true,
		});
	});

	test('strips an unexpected trailing Han suffix from a Latin title', async () => {
		const titlePrefixAtLimit = 'A'.repeat(199);
		const cases = [
			{ generated: 'Fix chat title\u7f16\u7801', expected: 'Fix chat title' },
			{ generated: 'Fix chat title \u7f16\u7801\u95ee', expected: 'Fix chat title' },
			{ generated: `${titlePrefixAtLimit}\u7f16\u7801`, expected: titlePrefixAtLimit },
		];
		const titles: { title: string; persistedTitle: string | undefined }[] = [];

		for (const testCase of cases) {
			const { service, stateManager, session, db } = setup({ generatedTitle: testCase.generated });

			service.onFirstUserMessage(session.toString(), undefined, 'Fix chat title generation');
			await waitForCondition(async () => {
				return stateManager.getSessionState(session.toString())?.title === testCase.expected
					&& await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === testCase.expected;
			}, 'cleaned title should be applied and persisted');
			titles.push({
				title: stateManager.getSessionState(session.toString())?.title ?? '',
				persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			});
		}

		assert.deepStrictEqual(titles, cases.map(testCase => ({ title: testCase.expected, persistedTitle: testCase.expected })));
	});

	test('preserves intentional or ambiguous Han suffixes', async () => {
		const cases = [
			{ prompt: 'Explain \u7f16\u7801 naming', generated: 'Explain code\u7f16\u7801' },
			{ prompt: 'Fix chat title generation', generated: 'Fix chat title\u7f16' },
			{ prompt: 'Fix chat title generation', generated: 'Fix chat title\u7f16\u7801\u95ee\u9898' },
			{ prompt: 'Fix chat title generation', generated: '\u4fee\u590d\u6807\u9898' },
			{ prompt: 'Fix chat title generation', generated: 'Code \u041e\u0448\u0438\u0431\u043a\u0430\u7f16\u7801' },
		];
		const titles: { title: string; persistedTitle: string | undefined }[] = [];

		for (const testCase of cases) {
			const { service, stateManager, session, db } = setup({ generatedTitle: testCase.generated });

			service.onFirstUserMessage(session.toString(), undefined, testCase.prompt);
			await waitForCondition(async () => {
				return stateManager.getSessionState(session.toString())?.title === testCase.generated
					&& await db.getMetadata(SESSION_CUSTOM_TITLE_KEY) === testCase.generated;
			}, 'unchanged title should be applied and persisted');
			titles.push({
				title: stateManager.getSessionState(session.toString())?.title ?? '',
				persistedTitle: await db.getMetadata(SESSION_CUSTOM_TITLE_KEY),
			});
		}

		assert.deepStrictEqual(titles, cases.map(testCase => ({ title: testCase.generated, persistedTitle: testCase.generated })));
	});
});
