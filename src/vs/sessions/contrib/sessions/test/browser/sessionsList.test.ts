/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ChatAutomationsEnabledContext } from '../../../../../workbench/contrib/chat/common/automations/automationsEnabled.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { computeReorderSortChanges, formatCompactSessionTime, groupByAgent, groupByDate, groupByWorkspace, groupSessionsForList, limitSessionsForList, sortProjectSectionsByRecency, sortSessions, SessionsFlatList, SessionsGrouping, SessionsList, SessionsSorting } from '../../browser/views/sessionsList.js';
import { createListHarness, createTestSession } from './sessionsListTestUtils.js';
import '../../browser/views/sessionsViewActions.js';

function createSession(id: string, opts: {
	workspaceLabel?: string;
	createdAt?: Date;
	updatedAt?: Date;
	isArchived?: boolean;
	sessionType?: string;
	isRead?: boolean;
	isAutomation?: boolean;
	resource?: URI;
}): ISession {
	const createdAt = opts.createdAt ?? new Date();
	const updatedAt = opts.updatedAt ?? createdAt;
	return {
		sessionId: id,
		resource: opts.resource ?? URI.parse(`session://${id}`),
		providerId: 'test',
		sessionType: opts.sessionType ?? 'test',
		icon: opts.sessionType?.includes('claude') ? Codicon.claude : opts.sessionType?.includes('codex') ? Codicon.openai : Codicon.account,
		createdAt,
		workspace: observableValue(`workspace-${id}`, opts.workspaceLabel !== undefined ? {
			uri: URI.parse(`session://workspace/${id}`),
			label: opts.workspaceLabel,
			icon: Codicon.folder,
			folders: [],
			requiresWorkspaceTrust: false,
			isVirtualWorkspace: false,
		} : undefined),
		isQuickChat: observableValue(`isQuickChat-${id}`, opts.workspaceLabel === undefined),
		isAutomation: observableValue(`isAutomation-${id}`, opts.isAutomation === true),
		title: observableValue(`title-${id}`, id),
		updatedAt: observableValue(`updatedAt-${id}`, updatedAt),
		status: observableValue(`status-${id}`, SessionStatus.Completed),
		changesets: observableValue(`changesets-${id}`, []),
		changes: observableValue(`changes-${id}`, []),
		modelId: observableValue(`modelId-${id}`, undefined),
		mode: observableValue(`mode-${id}`, undefined),
		loading: observableValue(`loading-${id}`, false),
		isArchived: observableValue(`isArchived-${id}`, opts.isArchived ?? false),
		isRead: observableValue(`isRead-${id}`, opts.isRead ?? true),
		description: observableValue(`description-${id}`, undefined),
		lastTurnEnd: observableValue(`lastTurnEnd-${id}`, undefined),
		chats: observableValue<readonly IChat[]>(`chats-${id}`, []),
		mainChat: observableValue<IChat>(`mainChat-${id}`, undefined!),
		capabilities: constObservable({ supportsMultipleChats: false }),
	};
}

suite('Sessions - SessionsList', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not render Automations in the sessions tree when the feature is enabled', () => {
		const harness = createListHarness(disposables, [], instantiationService => {
			ChatAutomationsEnabledContext.bindTo(instantiationService.get(IContextKeyService)).set(true);
		});
		const container = harness.createContainer();
		const list = harness.store.add(harness.instantiationService.createInstance(SessionsList, container, {
			grouping: () => SessionsGrouping.Workspace,
			sorting: () => SessionsSorting.Created,
			onSessionOpen: () => { },
		}));
		list.layout(300, 400);

		assert.deepStrictEqual(
			[...container.querySelectorAll('.session-section-label')].map(element => element.textContent),
			[],
		);
	});

	suite('groupByWorkspace', () => {

		test('groups are sorted alphabetically regardless of insertion order', () => {
			const sessions = [
				createSession('1', { workspaceLabel: 'Zebra' }),
				createSession('2', { workspaceLabel: 'Apple' }),
				createSession('3', { workspaceLabel: 'Mango' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.deepStrictEqual(groups.map(g => g.label), ['Apple', 'Mango', 'Zebra']);
		});

		test('sessions without workspace are grouped under "Unknown"', () => {
			const sessions = [
				createSession('1', { workspaceLabel: 'Beta' }),
				createSession('2', {}),
				createSession('3', { workspaceLabel: 'Alpha' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.deepStrictEqual(groups.map(g => g.label), ['Alpha', 'Beta', 'Unknown']);
		});

		test('multiple sessions in same workspace are grouped together', () => {
			const sessions = [
				createSession('1', { workspaceLabel: 'Repo-B' }),
				createSession('2', { workspaceLabel: 'Repo-A' }),
				createSession('3', { workspaceLabel: 'Repo-B' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.deepStrictEqual(groups.map(g => g.label), ['Repo-A', 'Repo-B']);
			assert.strictEqual(groups[0].sessions.length, 1);
			assert.strictEqual(groups[1].sessions.length, 2);
		});

		test('"No Workspace" appears after workspaces that sort alphabetically later', () => {
			const sessions = [
				createSession('1', {}),
				createSession('2', { workspaceLabel: 'Zulu' }),
				createSession('3', { workspaceLabel: 'Alpha' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.deepStrictEqual(groups.map(g => g.label), ['Alpha', 'Zulu', 'Unknown']);
		});

		test('empty workspace label is treated as "Unknown"', () => {
			const sessions = [
				createSession('1', { workspaceLabel: 'Zulu' }),
				createSession('2', { workspaceLabel: '' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.deepStrictEqual(groups.map(g => g.label), ['Zulu', 'Unknown']);
			assert.strictEqual(groups[1].sessions.length, 1);
		});

		test('group ids are prefixed with workspace:', () => {
			const sessions = [
				createSession('1', { workspaceLabel: 'MyProject' }),
			];

			const groups = groupByWorkspace(sessions);

			assert.strictEqual(groups[0].id, 'workspace:MyProject');
		});
	});

	suite('groupByDate', () => {

		// Calendar-local noon, so DST and "now" time-of-day cannot flip the bucket.
		function startOfLocalDay(daysOffset: number): Date {
			const date = new Date();
			date.setHours(12, 0, 0, 0);
			date.setDate(date.getDate() + daysOffset);
			return date;
		}

		test('buckets sessions into Today, Yesterday, Last 7 days, and Older', () => {
			const sessions = [
				createSession('today-1', { createdAt: startOfLocalDay(0) }),
				createSession('yesterday-1', { createdAt: startOfLocalDay(-1) }),
				createSession('week-1', { createdAt: startOfLocalDay(-3) }),
				createSession('old-1', { createdAt: startOfLocalDay(-10) }),
				createSession('old-2', { createdAt: startOfLocalDay(-30) }),
			];

			const sections = groupByDate(sessions);

			assert.deepStrictEqual(sections.map(s => ({ id: s.id, sessions: s.sessions.map(session => session.sessionId) })), [
				{ id: 'today', sessions: ['today-1'] },
				{ id: 'yesterday', sessions: ['yesterday-1'] },
				{ id: 'last7days', sessions: ['week-1'] },
				{ id: 'older', sessions: ['old-1', 'old-2'] },
			]);
		});

		test('the 7th local day back is still "Last 7 days"; the 8th is "Older"', () => {
			const sessions = [
				createSession('day-7', { createdAt: startOfLocalDay(-7) }),
				createSession('day-8', { createdAt: startOfLocalDay(-8) }),
			];

			const sections = groupByDate(sessions);

			assert.deepStrictEqual(sections.map(s => ({ id: s.id, sessions: s.sessions.map(session => session.sessionId) })), [
				{ id: 'last7days', sessions: ['day-7'] },
				{ id: 'older', sessions: ['day-8'] },
			]);
		});

		test('Today is not capped; many sessions from today stay in Today', () => {
			const sessions = Array.from({ length: 13 }, (_, i) =>
				createSession(`s${i}`, { createdAt: new Date(startOfLocalDay(0).getTime() - i * 60_000) }));

			const sections = groupByDate(sessions);

			assert.deepStrictEqual(sections.map(s => s.id), ['today']);
			assert.deepStrictEqual(sections[0].sessions.map(session => session.sessionId), sessions.map(s => s.sessionId));
		});

		test('empty sections are omitted', () => {
			const sessions = [
				createSession('only-old', { createdAt: startOfLocalDay(-20) }),
			];

			const sections = groupByDate(sessions);

			assert.deepStrictEqual(sections.map(s => s.id), ['older']);
		});

		test('buckets by the last-updated time the row label shows, not creation time', () => {
			const sessions = [
				createSession('touched-today', { createdAt: startOfLocalDay(-3), updatedAt: startOfLocalDay(0) }),
				createSession('untouched', { createdAt: startOfLocalDay(-3) }),
			];

			const sections = groupByDate(sessions);

			assert.deepStrictEqual(sections.map(s => ({ id: s.id, sessions: s.sessions.map(session => session.sessionId) })), [
				{ id: 'today', sessions: ['touched-today'] },
				{ id: 'last7days', sessions: ['untouched'] },
			]);
		});

		test('a Created sort does not move a freshly updated session out of Today', () => {
			const sessions = [
				createSession('old-but-live', { createdAt: startOfLocalDay(-1), updatedAt: startOfLocalDay(0) }),
			];

			const sections = groupSessionsForList(sessions, SessionsGrouping.Date, SessionsSorting.Created, () => false);

			assert.deepStrictEqual(sections.map(s => s.id), ['today']);
		});
	});

	suite('groupByAgent', () => {

		test('groups by the real Agent type rather than title or project', () => {
			const sessions = [
				createSession('claude-misleading-title', { workspaceLabel: 'Alpha', sessionType: 'claude' }),
				createSession('codex-alpha', { workspaceLabel: 'Alpha', sessionType: 'codex' }),
				createSession('codex-beta', { workspaceLabel: 'Beta', sessionType: 'agent-host-codex' }),
			];

			const groups = groupByAgent(sessions);

			assert.deepStrictEqual(groups.map(group => ({
				id: group.id,
				label: group.label,
				sessions: group.sessions.map(session => session.sessionId),
			})), [
				{ id: 'agent:codex', label: 'Codex', sessions: ['codex-alpha', 'codex-beta'] },
				{ id: 'agent:claude', label: 'Claude', sessions: ['claude-misleading-title'] },
			]);
		});
	});

	suite('sortSessions', () => {

		test('sorts by createdAt descending when sorting is Created', () => {
			const sessions = [
				createSession('old', { createdAt: new Date('2024-01-01') }),
				createSession('new', { createdAt: new Date('2024-06-01') }),
				createSession('mid', { createdAt: new Date('2024-03-01') }),
			];

			const sorted = sortSessions(sessions, SessionsSorting.Created);

			assert.deepStrictEqual(sorted.map(s => s.sessionId), ['new', 'mid', 'old']);
		});

		test('sorts by updatedAt descending when sorting is Updated', () => {
			const sessions = [
				createSession('a', { createdAt: new Date('2024-06-01'), updatedAt: new Date('2024-07-01') }),
				createSession('b', { createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-09-01') }),
				createSession('c', { createdAt: new Date('2024-03-01'), updatedAt: new Date('2024-08-01') }),
			];

			const sorted = sortSessions(sessions, SessionsSorting.Updated);

			assert.deepStrictEqual(sorted.map(s => s.sessionId), ['b', 'c', 'a']);
		});
	});

	suite('limitSessionsForList', () => {

		test('caps sessions and returns a show more item', () => {
			const sessions = ['1', '2', '3'].map(id => createSession(id, {}));
			const result = limitSessionsForList(sessions, 2, {
				enabled: true,
				expanded: false,
				sectionId: 'group:alpha',
				sectionLabel: 'Alpha',
			});

			assert.deepStrictEqual({
				sessions: result.sessions.map(session => session.sessionId),
				showMore: result.showMore,
			}, {
				sessions: ['1', '2'],
				showMore: {
					showMore: true,
					kind: 'sessions',
					mode: 'more',
					sectionId: 'group:alpha',
					sectionLabel: 'Alpha',
					remainingCount: 1,
				},
			});
		});

		test('returns all sessions and a show less item when expanded', () => {
			const sessions = ['1', '2', '3'].map(id => createSession(id, {}));
			const result = limitSessionsForList(sessions, 2, {
				enabled: true,
				expanded: true,
				sectionId: 'group:alpha',
				sectionLabel: 'Alpha',
			});

			assert.deepStrictEqual({
				sessions: result.sessions.map(session => session.sessionId),
				showMore: result.showMore,
			}, {
				sessions: ['1', '2', '3'],
				showMore: {
					showMore: true,
					kind: 'sessions',
					mode: 'less',
					sectionId: 'group:alpha',
					sectionLabel: 'Alpha',
					remainingCount: 0,
				},
			});
		});

		test('does not cap when disabled', () => {
			const sessions = ['1', '2', '3'].map(id => createSession(id, {}));
			const result = limitSessionsForList(sessions, 2, {
				enabled: false,
				expanded: false,
				sectionId: 'group:alpha',
				sectionLabel: 'Alpha',
			});

			assert.deepStrictEqual({
				sessions: result.sessions.map(session => session.sessionId),
				showMore: result.showMore,
			}, {
				sessions: ['1', '2', '3'],
				showMore: undefined,
			});
		});
	});

	suite('groupSessionsForList', () => {
		test('orders project sections by their newest thread like Codex', () => {
			const older = createSession('older', { workspaceLabel: 'Alpha', createdAt: new Date('2024-06-01') });
			const newer = createSession('newer', { workspaceLabel: 'Beta', createdAt: new Date('2024-06-02') });
			const sections = groupByWorkspace([older, newer]);

			assert.deepStrictEqual(
				sortProjectSectionsByRecency(sections).map(section => section.id),
				['workspace:Beta', 'workspace:Alpha'],
			);
		});

		test('groups active sessions by Agent while archived sessions stay in Done', () => {
			const codex = createSession('codex', { workspaceLabel: 'Alpha', sessionType: 'codex' });
			const claude = createSession('claude', { workspaceLabel: 'Alpha', sessionType: 'claude' });
			const archivedCodex = createSession('archived-codex', { workspaceLabel: 'Beta', sessionType: 'codex', isArchived: true });
			const sections = groupSessionsForList(
				[codex, claude, archivedCodex],
				SessionsGrouping.Agent,
				SessionsSorting.Created,
				() => false,
			);

			assert.deepStrictEqual(sections.map(section => ({
				id: section.id,
				sessions: section.sessions.map(session => session.sessionId),
			})), [
				{ id: 'agent:codex', sessions: ['codex'] },
				{ id: 'agent:claude', sessions: ['claude'] },
				{ id: 'archived', sessions: ['archived-codex'] },
			]);
		});

		test('date grouping keeps archived sessions in Done instead of Today', () => {
			const active = createSession('active', { workspaceLabel: 'Alpha', createdAt: new Date() });
			const archived = createSession('archived', { workspaceLabel: 'Alpha', isArchived: true, createdAt: new Date() });
			const sections = groupSessionsForList(
				[active, archived],
				SessionsGrouping.Date,
				SessionsSorting.Created,
				() => false,
			);

			assert.deepStrictEqual(sections.map(section => ({
				id: section.id,
				sessions: section.sessions.map(session => session.sessionId),
			})), [
				{ id: 'today', sessions: ['active'] },
				{ id: 'archived', sessions: ['archived'] },
			]);
		});

		test('only workspace sections claim a host, so date buckets stay unhosted', () => {
			const active = createSession('active', { workspaceLabel: 'Alpha', createdAt: new Date() });
			const archived = createSession('archived', { workspaceLabel: 'Alpha', isArchived: true, createdAt: new Date() });

			const byDate = groupSessionsForList([active, archived], SessionsGrouping.Date, SessionsSorting.Created, () => false);
			assert.deepStrictEqual(
				byDate.map(section => [section.id, section.providerId]),
				[['today', undefined], ['archived', undefined]],
			);

			const byWorkspace = groupSessionsForList([active], SessionsGrouping.Workspace, SessionsSorting.Created, () => false);
			assert.deepStrictEqual(
				byWorkspace.map(section => [section.id, section.providerId]),
				[['workspace:Alpha', 'test']],
			);
		});

		test('shows pinned sessions in a dedicated top section', () => {
			const pinned = createSession('pinned', { workspaceLabel: 'Alpha', createdAt: new Date('2024-06-01') });
			const regular = createSession('regular', { workspaceLabel: 'Beta', createdAt: new Date('2024-05-01') });
			const sections = groupSessionsForList(
				[pinned, regular],
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				session => session.sessionId === pinned.sessionId,
			);

			assert.deepStrictEqual(sections.map(section => section.id), ['pinned', 'workspace:Beta']);
			assert.deepStrictEqual(sections[0].sessions.map(session => session.sessionId), ['pinned']);
		});

		test('keeps archived sessions in Done even when pinned', () => {
			const archivedPinned = createSession('archived-pinned', { workspaceLabel: 'Alpha', isArchived: true, createdAt: new Date('2024-06-01') });
			const sections = groupSessionsForList(
				[archivedPinned],
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				() => true,
			);

			assert.deepStrictEqual(sections.map(section => section.id), ['archived']);
			assert.deepStrictEqual(sections[0].sessions.map(session => session.sessionId), ['archived-pinned']);
		});

		test('sorts pinned sessions using supplied sort keys', () => {
			const first = createSession('first', { createdAt: new Date('2024-01-01') });
			const second = createSession('second', { createdAt: new Date('2024-06-01') });
			const sections = groupSessionsForList(
				[first, second],
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				() => true,
				session => session.sessionId === first.sessionId ? 200 : 100,
			);

			assert.deepStrictEqual(sections.map(section => ({ id: section.id, sessions: section.sessions.map(session => session.sessionId) })), [
				{ id: 'pinned', sessions: ['first', 'second'] },
			]);
		});

		test('workspace-less quick chats join regular workspace groups, not a Chats section', () => {
			const pinned = createSession('pinned', { workspaceLabel: 'Alpha', createdAt: new Date('2024-06-03') });
			const quick = createSession('quick', { createdAt: new Date('2024-06-02') });
			const regular = createSession('regular', { workspaceLabel: 'Beta', createdAt: new Date('2024-06-01') });
			const archived = createSession('archived', { workspaceLabel: 'Gamma', isArchived: true, createdAt: new Date('2024-05-01') });
			const sections = groupSessionsForList(
				[pinned, quick, regular, archived],
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				session => session.sessionId === pinned.sessionId,
			);

			assert.deepStrictEqual(sections.map(section => ({ id: section.id, sessions: section.sessions.map(s => s.sessionId) })), [
				{ id: 'pinned', sessions: ['pinned'] },
				{ id: 'workspace:Beta', sessions: ['regular'] },
				{ id: 'workspace:Unknown', sessions: ['quick'] },
				{ id: 'archived', sessions: ['archived'] },
			]);
		});

		test('pinned quick chat stays in Pinned, not a workspace group', () => {
			const quick = createSession('quick', { createdAt: new Date('2024-06-01') });
			const sections = groupSessionsForList(
				[quick],
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				() => true,
			);

			assert.deepStrictEqual(sections.map(section => section.id), ['pinned']);
		});

		test('workspace-less quick chats join date buckets, not a Chats section', () => {
			const pinned = createSession('pinned', { createdAt: new Date('2024-06-03') });
			const quick = createSession('quick', { createdAt: new Date() });
			const regular = createSession('regular', { workspaceLabel: 'Beta', createdAt: new Date(Date.now() - 1000) });
			const sections = groupSessionsForList(
				[pinned, quick, regular],
				SessionsGrouping.Date,
				SessionsSorting.Created,
				session => session.sessionId === pinned.sessionId,
			);

			assert.strictEqual(sections[0].id, 'pinned');
			assert.strictEqual(sections[1].id, 'today');
			assert.deepStrictEqual(sections[1].sessions.map(s => s.sessionId), ['quick', 'regular']);
			assert.ok(!sections.some(section => section.id === 'quickchats'));
		});

		test('excludes automation sessions from every section', () => {
			const sessions = [
				createSession('workspace-automation', { workspaceLabel: 'Alpha', isAutomation: true }),
				createSession('quick-automation', { isAutomation: true }),
				createSession('archived-automation', { workspaceLabel: 'Beta', isArchived: true, isAutomation: true }),
				createSession('visible', { workspaceLabel: 'Gamma' }),
			];
			const sections = groupSessionsForList(
				sessions,
				SessionsGrouping.Workspace,
				SessionsSorting.Created,
				session => session.sessionId === 'workspace-automation',
			);

			assert.deepStrictEqual(sections.map(section => ({
				id: section.id,
				sessions: section.sessions.map(session => session.sessionId),
			})), [
				{ id: 'workspace:Gamma', sessions: ['visible'] },
			]);
		});
	});

	// Fumie deliberately does not render a visual `.session-badge` element for
	// the workspace in the compact list (see the "Provider icon" comment in
	// SessionItemRenderer.renderSession in sessionsList.ts) — the owning
	// provider icon stays in that slot instead. The workspace is still
	// surfaced for accessibility by appending ", in <workspace>" to the row's
	// aria-label under the same visibility rules the badge used to follow.
	suite('workspace in accessible name', () => {

		function renderList(
			sessions: ISession[],
			grouping: SessionsGrouping,
			options: { pinnedSessionIds?: ReadonlySet<string>; expandSections?: readonly string[] } = {},
		): { readonly list: SessionsList; readonly container: HTMLElement } {
			const harness = createListHarness(disposables, sessions, {
				pinnedSessionIds: options.pinnedSessionIds,
			});
			if (options.expandSections) {
				harness.instantiationService.get(IStorageService).store(
					'sessionsListControl.sectionCollapseState',
					JSON.stringify(Object.fromEntries(options.expandSections.map(section => [section, false]))),
					StorageScope.PROFILE,
					StorageTarget.USER,
				);
			}
			const container = harness.createContainer();
			const list = harness.store.add(harness.instantiationService.createInstance(SessionsList, container, {
				grouping: () => grouping,
				sorting: () => SessionsSorting.Created,
				onSessionOpen: () => { },
			}));
			list.layout(300, 400);
			return { list, container };
		}

		function rowSnapshot(container: HTMLElement): { title: string; hasWorkspaceBadge: boolean; ariaLabel: string | null; details: string }[] {
			return [...container.querySelectorAll<HTMLElement>('.session-item')].map(item => ({
				title: item.querySelector('.session-title')?.textContent ?? '',
				hasWorkspaceBadge: item.querySelector('.session-badge') !== null,
				ariaLabel: item.closest('.monaco-list-row')?.getAttribute('aria-label') ?? null,
				details: item.querySelector('.session-details-row')?.textContent ?? '',
			}));
		}

		test('workspace grouping omits the workspace in the accessible name: the section header already names it', () => {
			const first = createTestSession('First', { workspaceLabel: 'vscode' }).session;
			const second = createTestSession('Second', { workspaceLabel: 'vscode' }).session;
			const { container } = renderList([first, second], SessionsGrouping.Workspace);

			const rows = rowSnapshot(container)
				.map(row => ({ title: row.title, hasWorkspaceBadge: row.hasWorkspaceBadge, ariaLabel: row.ariaLabel }))
				.sort((a, b) => a.title.localeCompare(b.title));
			assert.deepStrictEqual(rows, [
				{ title: 'First', hasWorkspaceBadge: false, ariaLabel: 'First, updated 1m' },
				{ title: 'Second', hasWorkspaceBadge: false, ariaLabel: 'Second, updated 1m' },
			]);
		});

		test('date grouping includes the workspace in the accessible name on every row', () => {
			const first = createTestSession('First', { workspaceLabel: 'vscode' }).session;
			const second = createTestSession('Second', { workspaceLabel: 'monaco' }).session;
			const { container } = renderList([first, second], SessionsGrouping.Date);

			// Both sessions land in the same date section, where their relative
			// order depends on sub-millisecond creation times; compare by title.
			const rows = rowSnapshot(container)
				.map(row => ({ title: row.title, hasWorkspaceBadge: row.hasWorkspaceBadge, ariaLabel: row.ariaLabel }))
				.sort((a, b) => a.title.localeCompare(b.title));
			assert.deepStrictEqual(rows, [
				{ title: 'First', hasWorkspaceBadge: false, ariaLabel: 'First, updated 1m, in vscode' },
				{ title: 'Second', hasWorkspaceBadge: false, ariaLabel: 'Second, updated 1m, in monaco' },
			]);
		});

		test('pinned and archived rows keep the workspace in the accessible name even in workspace grouping', () => {
			const pinned = createTestSession('Pinned', { workspaceLabel: 'vscode' }).session;
			const archived = createTestSession('Archived', { workspaceLabel: 'monaco', isArchived: true }).session;
			const { list, container } = renderList([pinned, archived], SessionsGrouping.Workspace, {
				pinnedSessionIds: new Set([pinned.sessionId]),
				expandSections: ['pinned', 'archived'],
			});
			list.setExcludeArchived(false);
			list.layout(300, 400);

			assert.deepStrictEqual(rowSnapshot(container).map(row => ({ title: row.title, hasWorkspaceBadge: row.hasWorkspaceBadge, ariaLabel: row.ariaLabel })), [
				{ title: 'Pinned', hasWorkspaceBadge: false, ariaLabel: 'Pinned, updated 1m, in vscode' },
				{ title: 'Archived', hasWorkspaceBadge: false, ariaLabel: 'Archived, updated 1m, in monaco' },
			]);
		});

		test('quick chats never include a workspace in the accessible name', () => {
			const quickChat = createTestSession('Quick Chat', { isQuickChat: true }).session;
			const { container } = renderList([quickChat], SessionsGrouping.Date);

			assert.deepStrictEqual(rowSnapshot(container).map(row => ({ title: row.title, hasWorkspaceBadge: row.hasWorkspaceBadge, ariaLabel: row.ariaLabel, details: row.details })), [
				{ title: 'Quick Chat', hasWorkspaceBadge: false, ariaLabel: 'Quick Chat, updated 1m', details: '' },
			]);
		});

		test('in-progress and needs-input rows never include the workspace in the accessible name', () => {
			const inProgress = createTestSession('Working', { workspaceLabel: 'vscode', status: SessionStatus.InProgress }).session;
			const needsInput = createTestSession('Needs Input', { workspaceLabel: 'monaco', status: SessionStatus.NeedsInput }).session;
			const { container } = renderList([inProgress, needsInput], SessionsGrouping.Date);

			const rows = rowSnapshot(container)
				.map(row => ({ title: row.title, hasWorkspaceBadge: row.hasWorkspaceBadge, ariaLabel: row.ariaLabel }))
				.sort((a, b) => a.title.localeCompare(b.title));
			assert.deepStrictEqual(rows, [
				{ title: 'Needs Input', hasWorkspaceBadge: false, ariaLabel: 'Needs Input, updated 1m' },
				{ title: 'Working', hasWorkspaceBadge: false, ariaLabel: 'Working, updated 1m' },
			]);
		});
	});

	suite('SessionsFlatList quick-chat presentation', () => {

		function renderQuickChat(useCompactQuickChatRows: boolean) {
			const quickChat = createTestSession('Investigate failure', { isQuickChat: true }).session;
			const harness = createListHarness(disposables, [quickChat]);
			const container = harness.createContainer();
			const list = harness.store.add(harness.instantiationService.createInstance(SessionsFlatList, container, {
				showSessionHover: false,
				useCompactQuickChatRows,
				onSessionOpen: () => { },
			}));
			list.setSessions([quickChat]);
			const contentHeight = list.getContentHeight();
			list.layout(contentHeight, 400);

			const item = container.querySelector<HTMLElement>('.session-item');
			assert.ok(item);
			return {
				usesStandardRowHeight: contentHeight === list.getRowHeight(),
				isShorterThanStandardRow: contentHeight < list.getRowHeight(),
				hasCompactClass: item.classList.contains('quick-chat'),
				hasChatIcon: item.querySelector('.session-details-icon > .codicon')?.classList.contains('codicon-comment-discussion') ?? false,
				badge: item.querySelector('.session-badge')?.textContent ?? undefined,
				time: item.querySelector('.session-time')?.textContent ?? undefined,
				hasDiff: !!item.querySelector('.session-diff'),
				ariaLabel: item.closest('.monaco-list-row')?.getAttribute('aria-label') ?? null,
			};
		}

		test('renders compact and regular quick-chat rows consistently', () => {
			assert.deepStrictEqual({
				compact: renderQuickChat(true),
				regular: renderQuickChat(false),
			}, {
				compact: {
					usesStandardRowHeight: false,
					isShorterThanStandardRow: true,
					hasCompactClass: true,
					hasChatIcon: false,
					badge: undefined,
					time: undefined,
					hasDiff: false,
					ariaLabel: 'Investigate failure, updated 1m',
				},
				regular: {
					usesStandardRowHeight: true,
					isShorterThanStandardRow: false,
					hasCompactClass: false,
					hasChatIcon: false,
					badge: undefined,
					time: '1m',
					hasDiff: false,
					ariaLabel: 'Investigate failure, chat, updated 1m',
				},
			});
		});
	});

	suite('computeReorderSortChanges', () => {
		const NOW = 1_000_000;
		const STEP = 60_000;

		test('single drop between two neighbours uses the midpoint', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['x'],
				naturalKeys: [10],
				aboveKey: 100,
				belowKey: 50,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual([...set], [['x', 75]]);
			assert.deepStrictEqual(clear, []);
		});

		test('drop above the first session uses the current time', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['x'],
				naturalKeys: [10],
				aboveKey: undefined,
				belowKey: 200,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual(clear, []);
			const value = set.get('x')!;
			assert.ok(value > 200 && value < NOW, `expected ${value} between 200 and ${NOW}`);
		});

		test('drop below the last session steps below the last key', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['x'],
				naturalKeys: [500],
				aboveKey: 100,
				belowKey: undefined,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual(clear, []);
			assert.ok(set.get('x')! < 100);
		});

		test('drops the fake value when the natural key already fits the slot', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['x'],
				naturalKeys: [75],
				aboveKey: 100,
				belowKey: 50,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual([...set], []);
			assert.deepStrictEqual(clear, ['x']);
		});

		test('multi-block gets strictly descending keys inside the gap', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['a', 'b', 'c'],
				naturalKeys: [5, 4, 3],
				aboveKey: 100,
				belowKey: 40,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual(clear, []);
			const values = ['a', 'b', 'c'].map(id => set.get(id)!);
			assert.deepStrictEqual(values, [85, 70, 55]);
			assert.ok(values.every(v => v > 40 && v < 100));
		});

		test('multi-block clears overrides when all natural keys already fit in order', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['a', 'b'],
				naturalKeys: [80, 60],
				aboveKey: 100,
				belowKey: 40,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual([...set], []);
			assert.deepStrictEqual(clear, ['a', 'b']);
		});

		test('multi-block assigns synthetic keys when natural order does not fit', () => {
			const { set, clear } = computeReorderSortChanges({
				draggedIds: ['a', 'b'],
				naturalKeys: [60, 80], // ascending: does not match descending display order
				aboveKey: 100,
				belowKey: 40,
				now: NOW,
				fallbackStep: STEP,
			});

			assert.deepStrictEqual(clear, []);
			assert.strictEqual(set.size, 2);
			assert.ok(set.get('a')! > set.get('b')!);
		});
	});

	suite('formatCompactSessionTime', () => {
		const now = new Date(2026, 7, 13, 15, 44, 0).getTime(); // 13 Aug 2026 15:44 local

		test('uses Nm below one hour', () => {
			assert.strictEqual(formatCompactSessionTime(new Date(now - 10_000), now), '1m');
			assert.strictEqual(formatCompactSessionTime(new Date(now - 5 * 60_000), now), '5m');
			assert.strictEqual(formatCompactSessionTime(new Date(now - 59 * 60_000), now), '59m');
		});

		test('uses Nh below one day, including across calendar days', () => {
			assert.strictEqual(formatCompactSessionTime(new Date(now - 2 * 3_600_000), now), '2h');
			assert.strictEqual(formatCompactSessionTime(new Date(now - 23 * 3_600_000), now), '23h');
		});

		test('uses Nd from one day through the last week', () => {
			assert.strictEqual(formatCompactSessionTime(new Date(now - 24 * 3_600_000), now), '1d');
			assert.strictEqual(formatCompactSessionTime(new Date(2026, 7, 10, 12, 0, 0), now), '3d');
		});

		test('uses a short date beyond a week, without an ago label', () => {
			const label = formatCompactSessionTime(new Date(2026, 7, 1, 9, 0, 0), now);
			assert.ok(!/ago/i.test(label));
			assert.ok(label.length <= 12);
			assert.ok(/1/.test(label));
		});
	});
});
