/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sidebarStatusOverlay.css';
import { $, addDisposableListener, EventType, reset } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derivedOpts, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { isMobile, isWeb } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Menus } from '../../../browser/menus.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SidePaneVisibleContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionChangesStats, ISessionChangesStatsCache, readSessionChangesStats } from '../../../services/sessions/common/sessionChangesStatsCache.js';

/**
 * Floating session-status card over the top-right of the sessions area, shown
 * only while the side pane (editor area + details) is hidden.
 *
 * It condenses the active session's changes into "N files +X -Y" — clicking that
 * reopens the side pane, so the condensed reading is the way back to the full
 * details — and hosts {@link Menus.SidebarStatusOverlay}, where the project
 * chrome and changes actions the title bar carries while the side pane is open
 * register their side-pane-hidden counterparts. The title bar and this card show
 * the same status, never both at once.
 */
export class SidebarStatusOverlay extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsSidebarStatusOverlay';

	private readonly _domNode = $('.sessions-sidebar-status-overlay');
	private readonly _changesRow = $('.sessions-sidebar-status-overlay-changes');

	constructor(
		@IAgentWorkbenchLayoutService private readonly _layoutService: IAgentWorkbenchLayoutService,
		@ISessionsService sessionsService: ISessionsService,
		@ISessionChangesStatsCache changesStatsCache: ISessionChangesStatsCache,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Side-pane visibility changes arrive either as a semantic toggle or as
		// individual part visibility changes (e.g. the single-pane Toggle Details).
		const sidePaneSignal = observableSignalFromEvent(this, Event.any<unknown>(
			this._layoutService.onDidToggleSidePane,
			this._layoutService.onDidChangePartVisibility,
		));

		// Bound even where the card itself is never mounted, so the title bar's
		// side-pane gating stays truthful on every layout.
		const sidePaneVisibleKey = SidePaneVisibleContext.bindTo(contextKeyService);
		this._register(toDisposable(() => sidePaneVisibleKey.reset()));

		// Phone layouts navigate between full-screen surfaces; there is no side
		// pane to condense. Matches the layout-controller selection.
		const container = isWeb && isMobile
			? undefined
			: this._layoutService.getContainer(mainWindow, Parts.SESSIONS_PART);

		if (container) {
			container.classList.add('sessions-sidebar-status-overlay-host');
			this._register(toDisposable(() => {
				container.classList.remove('sessions-sidebar-status-overlay-host');
				this._domNode.remove();
			}));

			this._changesRow.setAttribute('role', 'button');
			this._changesRow.tabIndex = 0;
			this._changesRow.title = localize('sidebarStatusOverlay.showDetails', "Show Details");
			this._domNode.appendChild(this._changesRow);
			this._register(addDisposableListener(this._changesRow, EventType.CLICK, () => this._openSidePane()));
			this._register(addDisposableListener(this._changesRow, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
					event.preventDefault();
					this._openSidePane();
				}
			}));

			const toolbarContainer = this._domNode.appendChild($('.sessions-sidebar-status-overlay-actions'));
			this._register(instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.SidebarStatusOverlay, {
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				telemetrySource: 'sessions.sidebarStatusOverlay',
				toolbarOptions: { primaryGroup: () => true },
				orientation: ActionsOrientation.VERTICAL,
			}));
		}

		// The same aggregate the session-header changes pill shows: live stats when
		// reported, otherwise the counts last cached for the session. Sessions
		// without a workspace (quick chats) have no details surface to open.
		const statsObs = derivedOpts<ISessionChangesStats | undefined>({ owner: this, equalsFn: structuralEquals }, reader => {
			const session = sessionsService.activeSession.read(reader);
			if (!session || !session.isCreated.read(reader) || !session.workspace.read(reader)) {
				return undefined;
			}
			const stats = readSessionChangesStats(session, reader) ?? changesStatsCache.get(session.sessionId, reader);
			return stats && stats.files > 0 ? stats : undefined;
		});

		this._register(autorun(reader => {
			sidePaneSignal.read(reader);
			const sidePaneVisible = this._layoutService.isSidePaneVisible();
			sidePaneVisibleKey.set(sidePaneVisible);

			const stats = statsObs.read(reader);
			if (!container) {
				return;
			}

			// The card carries the menu items even without changes to report, so it
			// stays mounted for as long as the side pane is hidden.
			if (sidePaneVisible) {
				this._domNode.remove();
				return;
			}
			this._renderChanges(stats);
			if (!container.contains(this._domNode)) {
				container.appendChild(this._domNode);
			}
		}));
	}

	private _renderChanges(stats: ISessionChangesStats | undefined): void {
		if (!stats) {
			reset(this._changesRow);
			this._changesRow.style.display = 'none';
			return;
		}

		this._changesRow.style.display = '';
		const filesLabel = stats.files === 1
			? localize('sidebarStatusOverlay.file', "{0} file", stats.files)
			: localize('sidebarStatusOverlay.files', "{0} files", stats.files);
		reset(
			this._changesRow,
			$('span.codicon.codicon-diff-multiple'),
			$('span.sessions-sidebar-status-overlay-files', undefined, filesLabel),
			$('span.sessions-sidebar-status-overlay-added', undefined, `+${stats.insertions}`),
			$('span.sessions-sidebar-status-overlay-removed', undefined, `-${stats.deletions}`),
		);
		// e.g. "Show Details: 3 files, +10, -4"
		this._changesRow.setAttribute('aria-label', localize('sidebarStatusOverlay.ariaLabel', "{0}: {1}, +{2}, -{3}",
			this._changesRow.title, filesLabel, stats.insertions, stats.deletions));
	}

	private _openSidePane(): void {
		if (!this._layoutService.isSidePaneVisible()) {
			this._layoutService.toggleSidePane();
		}
	}
}

registerWorkbenchContribution2(SidebarStatusOverlay.ID, SidebarStatusOverlay, WorkbenchPhase.AfterRestored);
