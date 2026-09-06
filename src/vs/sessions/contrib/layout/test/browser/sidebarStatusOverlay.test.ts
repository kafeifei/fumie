/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import { SidePaneVisibleContext } from '../../../../common/contextkeys.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionChangesStatsCache } from '../../../../services/sessions/common/sessionChangesStatsCache.js';
import { SidebarStatusOverlay } from '../../browser/sidebarStatusOverlay.js';

suite('SidebarStatusOverlay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class TestLayoutService extends mock<IAgentWorkbenchLayoutService>() {
		readonly container = document.createElement('div');
		sidePaneVisible = false;
		toggleCalls = 0;

		private readonly _onDidToggleSidePane = new Emitter<never>();
		override readonly onDidToggleSidePane = this._onDidToggleSidePane.event;
		private readonly _onDidChangePartVisibility = new Emitter<never>();
		override readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;

		constructor(disposables: DisposableStore) {
			super();
			disposables.add(this._onDidToggleSidePane);
			disposables.add(this._onDidChangePartVisibility);
		}

		override getContainer(): HTMLElement { return this.container; }
		override isSidePaneVisible(): boolean { return this.sidePaneVisible; }
		override toggleSidePane(): boolean {
			this.toggleCalls++;
			this.setSidePaneVisible(!this.sidePaneVisible);
			return this.sidePaneVisible;
		}
		setSidePaneVisible(visible: boolean): void {
			this.sidePaneVisible = visible;
			this._onDidToggleSidePane.fire(undefined as never);
		}
	}

	interface ITestSessionOptions {
		readonly summary?: { files: number; additions: number; deletions: number };
		readonly isCreated?: boolean;
		/** A session without a workspace folder — a quick chat. */
		readonly withoutWorkspace?: boolean;
	}

	function createSession(options: ITestSessionOptions = {}) {
		return {
			sessionId: 's1',
			isCreated: observableValue('isCreated', options.isCreated ?? true),
			workspace: observableValue<object | undefined>('workspace', options.withoutWorkspace ? undefined : {}),
			changesSummary: observableValue('changesSummary', options.summary),
			changesets: observableValue('changesets', undefined),
			changes: observableValue('changes', []),
		};
	}

	interface ITestContext {
		readonly layout: TestLayoutService;
		readonly contextKeyService: IContextKeyService;
	}

	function createOverlay(
		session: ReturnType<typeof createSession> | undefined,
		options: { sidePaneVisible?: boolean; cachedStats?: { files: number; insertions: number; deletions: number } } = {},
	): ITestContext {
		const disposables = store.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		const layout = new TestLayoutService(disposables);
		layout.sidePaneVisible = options.sidePaneVisible ?? false;
		instantiationService.stub(IAgentWorkbenchLayoutService, layout);
		instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession = observableValue<never>('activeSession', session as never);
		});
		instantiationService.stub(ISessionChangesStatsCache, new class extends mock<ISessionChangesStatsCache>() {
			override get() { return options.cachedStats; }
			override set() { }
		});

		disposables.add(instantiationService.createInstance(SidebarStatusOverlay));
		return { layout, contextKeyService: instantiationService.get(IContextKeyService) };
	}

	function cardElement(layout: TestLayoutService): HTMLElement | null {
		return layout.container.querySelector<HTMLElement>('.sessions-sidebar-status-overlay');
	}

	function changesText(layout: TestLayoutService): string | undefined {
		const changes = layout.container.querySelector<HTMLElement>('.sessions-sidebar-status-overlay-changes');
		return changes && changes.style.display !== 'none' ? changes.textContent ?? '' : undefined;
	}

	test('shown with condensed stats while the side pane is hidden', () => {
		const { layout } = createOverlay(createSession({ summary: { files: 3, additions: 81, deletions: 1 } }));

		assert.ok(cardElement(layout), 'expected the card to be attached');
		assert.strictEqual(changesText(layout), '3 files+81-1');
	});

	test('hidden while the side pane is visible; reappears when it hides', () => {
		const { layout } = createOverlay(createSession({ summary: { files: 1, additions: 2, deletions: 0 } }), { sidePaneVisible: true });

		assert.strictEqual(cardElement(layout), null);

		layout.setSidePaneVisible(false);
		assert.ok(cardElement(layout), 'expected the card after the side pane hides');
	});

	test('clicking the changes reading opens the side pane and detaches the card', () => {
		const { layout } = createOverlay(createSession({ summary: { files: 2, additions: 5, deletions: 4 } }));

		layout.container.querySelector<HTMLElement>('.sessions-sidebar-status-overlay-changes')!.click();

		assert.strictEqual(layout.toggleCalls, 1);
		assert.strictEqual(layout.sidePaneVisible, true);
		assert.strictEqual(cardElement(layout), null);
	});

	test('the card still hosts its menu items when there are no changes to report', () => {
		// Only the changes reading drops out; the card stays mounted for the
		// project chrome and changes actions the title bar hands over.
		const noChanges = createOverlay(createSession({ summary: { files: 0, additions: 0, deletions: 0 } }));
		assert.ok(cardElement(noChanges.layout), 'expected the card without changes');
		assert.strictEqual(changesText(noChanges.layout), undefined);

		const noSession = createOverlay(undefined);
		assert.strictEqual(changesText(noSession.layout), undefined);

		const quickChat = createOverlay(createSession({ summary: { files: 3, additions: 1, deletions: 1 }, withoutWorkspace: true }));
		assert.strictEqual(changesText(quickChat.layout), undefined);
	});

	test('falls back to cached stats while the session has not reported changes', () => {
		const { layout } = createOverlay(createSession(), { cachedStats: { files: 4, insertions: 7, deletions: 2 } });

		assert.strictEqual(changesText(layout), '4 files+7-2');
	});

	test('tracks side-pane visibility in the context key that gates the title bar', () => {
		const { layout, contextKeyService } = createOverlay(createSession({ summary: { files: 1, additions: 1, deletions: 0 } }), { sidePaneVisible: true });
		const readKey = () => contextKeyService.getContextKeyValue(SidePaneVisibleContext.key);

		assert.strictEqual(readKey(), true);

		layout.setSidePaneVisible(false);
		assert.strictEqual(readKey(), false);

		layout.setSidePaneVisible(true);
		assert.strictEqual(readKey(), true);
	});
});
