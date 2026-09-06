/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchAssignmentService } from '../../../../../workbench/services/assignment/common/assignmentService.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IVoicePlaybackService } from '../../../../../workbench/contrib/chat/common/voicePlaybackService.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { AgentHostFilterScope, IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { ISessionsListModelService, SessionSortMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionSectionOrderService } from '../../../../services/sessions/browser/sessionSectionOrderService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { SessionsGrouping, SessionsList, SessionsSorting } from '../../browser/views/sessionsList.js';

const ITestAgentSessionsService = createDecorator<object>('agentSessions');

class TestSessionsManagementService extends mock<ISessionsManagementService>() {
	override readonly onDidChangeSessions = Event.None;
	constructor(public sessions: ISession[]) {
		super();
	}
	override getSessions(): ISession[] {
		return this.sessions;
	}
}

function createSession(id: string, opts: {
	sessionType?: string;
	status?: SessionStatus;
	isArchived?: boolean;
	isRead?: boolean;
	workspaceLabel?: string;
	providerId?: string;
} = {}): ISession {
	const now = new Date();
	return {
		sessionId: id,
		resource: URI.parse(`test-session://${id}`),
		providerId: opts.providerId ?? 'test',
		sessionType: opts.sessionType ?? 'test',
		icon: Codicon.account,
		createdAt: now,
		workspace: constObservable(opts.workspaceLabel !== undefined ? {
			uri: URI.parse(`test-workspace://${id}`),
			label: opts.workspaceLabel,
			icon: Codicon.folder,
			folders: [],
			requiresWorkspaceTrust: false,
			isVirtualWorkspace: false,
		} : undefined),
		isQuickChat: constObservable(opts.workspaceLabel === undefined),
		title: constObservable(id),
		updatedAt: constObservable(now),
		status: constObservable(opts.status ?? SessionStatus.Completed),
		changesets: constObservable([]),
		changes: constObservable([]),
		modelId: constObservable(undefined),
		mode: constObservable(undefined),
		loading: constObservable(false),
		isArchived: constObservable(opts.isArchived ?? false),
		isRead: constObservable(opts.isRead ?? true),
		description: constObservable(undefined),
		lastTurnEnd: constObservable(undefined),
		chats: constObservable<readonly IChat[]>([]),
		mainChat: constObservable(new class extends mock<IChat>() { }),
		capabilities: constObservable({ supportsMultipleChats: false }),
	};
}

function createList(store: Pick<DisposableStore, 'add'>, sessions: ISession[], storage: IStorageService, hostScope: AgentHostFilterScope = { kind: 'all' }): SessionsList {
	const instantiationService = workbenchInstantiationService(undefined, store);
	instantiationService.stub(IStorageService, storage);
	instantiationService.stub(ISessionsManagementService, new TestSessionsManagementService(sessions));
	instantiationService.stub(ICommandService, new class extends mock<ICommandService>() {
		override async executeCommand(): Promise<undefined> { return undefined; }
	});
	instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
		override readonly visibleSessions = constObservable<readonly (IActiveSession | undefined)[]>([]);
		override readonly activeSession = constObservable<IActiveSession | undefined>(undefined);
	});
	instantiationService.stub(ISessionsListModelService, new class extends mock<ISessionsListModelService>() {
		override readonly onDidChange = Event.None;
		override isSessionPinned(): boolean { return false; }
		override migrateLegacyReadState(): void { }
		override getSortKey(session: ISession, mode: SessionSortMode): number {
			return mode === 'created' ? session.createdAt.getTime() : session.updatedAt.get().getTime();
		}
		override getStatusIcon() { return Codicon.circleSmallFilled; }
	});
	instantiationService.stub(ISessionSectionOrderService, new class extends mock<ISessionSectionOrderService>() {
		override readonly onDidChange = Event.None;
		override resolveOrder(ids: readonly string[]) { return [...ids]; }
		override isPromoted() { return false; }
		override retain(): void { }
	});
	instantiationService.stub(IAgentHostFilterService, new class extends mock<IAgentHostFilterService>() {
		override readonly onDidChange = Event.None;
		override readonly scope = hostScope;
		override readonly selectedProviderId = hostScope.kind === 'host' ? hostScope.providerId : undefined;
		override readonly hosts = [];
	});
	instantiationService.stub(IWorkbenchAssignmentService, new class extends mock<IWorkbenchAssignmentService>() {
		override readonly onDidRefetchAssignments = Event.None;
		override async getTreatment<T extends string | number | boolean>(): Promise<T | undefined> { return undefined; }
	});
	instantiationService.stub(ISessionsProvidersService, new class extends mock<ISessionsProvidersService>() {
		override readonly onDidChangeProviders = Event.None;
		override getProviders() { return []; }
	});
	instantiationService.stub(IVoicePlaybackService, new class extends mock<IVoicePlaybackService>() {
		override readonly pendingResponseVersion = constObservable(0);
		override hasPendingResponse() { return false; }
	});
	instantiationService.stub(ITestAgentSessionsService, {
		model: { observeSession: () => constObservable(undefined) },
	});
	instantiationService.stub(IChatService, new class extends mock<IChatService>() {
		override readonly chatModels = constObservable([]);
	});
	instantiationService.stub(IAutomationService, new class extends mock<IAutomationService>() {
		override readonly runs = constObservable([]);
	});
	instantiationService.stub(ICustomViewService, new class extends mock<ICustomViewService>() {
		override readonly activeCustomView = constObservable(undefined);
	});

	const container = mainWindow.document.createElement('div');
	container.style.width = '400px';
	container.style.height = '300px';
	mainWindow.document.body.appendChild(container);
	store.add({ dispose: () => container.remove() });

	const list = store.add(instantiationService.createInstance(SessionsList, container, {
		grouping: () => SessionsGrouping.Date,
		sorting: () => SessionsSorting.Created,
		onSessionOpen: () => { },
	}));
	list.layout(300, 400);
	return list;
}

suite('Sessions list filter persistence', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('status, type, archived, and read filters survive a new list instance', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const sessions = [
			createSession('codex-done', { sessionType: 'codex', status: SessionStatus.Completed, workspaceLabel: 'Alpha' }),
			createSession('claude-live', { sessionType: 'claude', status: SessionStatus.InProgress, workspaceLabel: 'Alpha' }),
			createSession('archived', { sessionType: 'codex', isArchived: true, workspaceLabel: 'Alpha' }),
		];

		const first = disposables.add(new DisposableStore());
		const list = createList(first, sessions, storage);
		list.setStatusExcluded(SessionStatus.Completed, true);
		list.setSessionTypeExcluded('codex', true);
		list.setExcludeArchived(false);
		list.setExcludeRead(true);
		list.setWorkspaceGroupCapped(false);
		first.dispose();

		const restored = createList(disposables, sessions, storage);
		assert.deepStrictEqual({
			completedExcluded: restored.isStatusExcluded(SessionStatus.Completed),
			inProgressExcluded: restored.isStatusExcluded(SessionStatus.InProgress),
			codexExcluded: restored.isSessionTypeExcluded('codex'),
			claudeExcluded: restored.isSessionTypeExcluded('claude'),
			excludeArchived: restored.isExcludeArchived(),
			excludeRead: restored.isExcludeRead(),
			workspaceGroupCapped: restored.isWorkspaceGroupCapped(),
		}, {
			completedExcluded: true,
			inProgressExcluded: false,
			codexExcluded: true,
			claudeExcluded: false,
			excludeArchived: false,
			excludeRead: true,
			workspaceGroupCapped: false,
		});
	});

	test('resetFilters restores defaults for a later list instance', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const sessions = [createSession('one', { workspaceLabel: 'Alpha' })];

		const first = disposables.add(new DisposableStore());
		const list = createList(first, sessions, storage);
		list.setStatusExcluded(SessionStatus.Error, true);
		list.setSessionTypeExcluded('codex', true);
		list.setExcludeArchived(false);
		list.setExcludeRead(true);
		list.setWorkspaceGroupCapped(false);
		list.resetFilters();
		first.dispose();

		const restored = createList(disposables, sessions, storage);
		assert.deepStrictEqual({
			errorExcluded: restored.isStatusExcluded(SessionStatus.Error),
			codexExcluded: restored.isSessionTypeExcluded('codex'),
			excludeArchived: restored.isExcludeArchived(),
			excludeRead: restored.isExcludeRead(),
			workspaceGroupCapped: restored.isWorkspaceGroupCapped(),
		}, {
			errorExcluded: false,
			codexExcluded: false,
			excludeArchived: true,
			excludeRead: false,
			workspaceGroupCapped: true,
		});
	});

	test('machine scope filters by provider', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const sessions = [
			createSession('local-session', { workspaceLabel: 'Alpha', providerId: 'local-agent-host' }),
			createSession('external-session', { workspaceLabel: 'Alpha', providerId: 'github-cloud' }),
			createSession('example-session', { workspaceLabel: 'Alpha', providerId: 'agenthost-example' }),
			createSession('other-remote', { workspaceLabel: 'Alpha', providerId: 'agenthost-other' }),
		];
		const visible = (scope: AgentHostFilterScope) => {
			const store = disposables.add(new DisposableStore());
			const ids = createList(store, sessions, storage, scope).getVisibleSessions().map(s => s.sessionId).sort();
			store.dispose();
			return ids;
		};

		assert.deepStrictEqual(visible({ kind: 'all' }), ['example-session', 'external-session', 'local-session', 'other-remote']);
		// Local is the complement of remote agent hosts: external and other
		// locally registered providers stay visible.
		assert.deepStrictEqual(visible({ kind: 'local' }), ['external-session', 'local-session']);
		assert.deepStrictEqual(visible({ kind: 'host', providerId: 'agenthost-example' }), ['example-session']);
	});

	test('restored status filter hides matching sessions', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const completed = createSession('done', { status: SessionStatus.Completed, workspaceLabel: 'Alpha' });
		const live = createSession('live', { status: SessionStatus.InProgress, workspaceLabel: 'Alpha' });

		const first = disposables.add(new DisposableStore());
		createList(first, [completed, live], storage).setStatusExcluded(SessionStatus.Completed, true);
		first.dispose();

		const restored = createList(disposables, [completed, live], storage);
		assert.deepStrictEqual(restored.getVisibleSessions().map(session => session.sessionId), ['live']);
	});
});
