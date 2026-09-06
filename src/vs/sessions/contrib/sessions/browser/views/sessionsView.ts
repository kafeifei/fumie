/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/sessionsViewPane.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, IViewPaneLocationColors, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatSessionArchiveActionWordingSettingId, getChatSessionArchivedSectionLabel, getChatSessionArchiveActionWording } from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { localize } from '../../../../../nls.js';
import { SessionsList, SessionsGrouping, SessionsSorting } from './sessionsList.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { AgentHostShortcutsWidget } from '../agentHostShortcutsWidget.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { agentsBackground } from '../../../../common/theme.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { Menus } from '../../../../browser/menus.js';
import { MobileSessionFilterChips } from '../../../../browser/parts/mobile/mobileSessionFilterChips.js';
import { IMobileSortGroupSheetItem, showMobileSortGroupSheet } from '../../../../browser/parts/mobile/mobileSortGroupSheet.js';
import { isPhoneLayout } from '../../../../browser/parts/mobile/mobileLayout.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NEW_SESSION_ACTION_ID } from '../../../chat/common/constants.js';
import { customizationNavId, CUSTOMIZATION_OVERVIEW_SECTION, OPEN_AGENT_SETTINGS_COMMAND_ID } from '../../../settings/browser/agentSettings.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID } from '../automationsConstants.js';
import { SessionsMachineFilter } from './sessionsMachineFilter.js';

const $ = DOM.$;
export const SessionsViewId = 'sessions.workbench.view.sessionsView';
const GROUPING_STORAGE_KEY = 'sessionsViewPane.grouping';
const SORTING_STORAGE_KEY = 'sessionsViewPane.sorting';

/**
 * Place the given session in the sessions grid to the right of the last
 * currently-visible session (as a non-sticky entry) and make it active. If
 * the session is already the last visible one, this is a no-op aside from
 * activation.
 */
export async function openSessionToTheSide(sessionsService: ISessionsService, session: ISession, options?: { preserveFocus?: boolean }): Promise<void> {
	const visible = sessionsService.visibleSessions.get();
	const lastVisible = visible[visible.length - 1];
	if (lastVisible && lastVisible.sessionId !== session.sessionId) {
		sessionsService.insertAt(session, lastVisible.sessionId, 'right');
	}
	await sessionsService.openSession(session.resource, options);
}

export const SessionsViewFilterSubMenu = new MenuId('SessionsViewPaneFilterSubMenu');
export const SessionsViewFilterOptionsSubMenu = new MenuId('SessionsViewPaneFilterOptionsSubMenu');
export const SessionsViewGroupingContext = new RawContextKey<string>('sessionsViewPane.grouping', SessionsGrouping.Date);
export const SessionsViewSortingContext = new RawContextKey<string>('sessionsViewPane.sorting', SessionsSorting.Created);
export const IsWorkspaceGroupCappedContext = new RawContextKey<boolean>('sessionsViewPane.workspaceGroupCapped', true);

export class SessionsView extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private findWidgetContainer: HTMLElement | undefined;
	private headerRow: HTMLElement | undefined;
	private automationsNavItem: HTMLElement | undefined;
	private isFindWidgetOpen = false;
	sessionsControl: SessionsList | undefined;
	private currentGrouping: SessionsGrouping = SessionsGrouping.Date;
	private currentSorting: SessionsSorting = SessionsSorting.Created;
	private groupingContextKey: IContextKey | undefined;
	private sortingContextKey: IContextKey | undefined;
	private workspaceGroupCappedContextKey: IContextKey<boolean> | undefined;
	private readonly filterContextKeys = new Map<string, { key: IContextKey<boolean>; getDefault: () => boolean }>();
	private currentBodyWidth = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Restore persisted grouping
		const storedGrouping = this.storageService.get(GROUPING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedGrouping && Object.values(SessionsGrouping).includes(storedGrouping as SessionsGrouping)) {
			this.currentGrouping = storedGrouping as SessionsGrouping;
		}

		// Restore persisted sorting
		const storedSorting = this.storageService.get(SORTING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedSorting && Object.values(SessionsSorting).includes(storedSorting as SessionsSorting)) {
			this.currentSorting = storedSorting as SessionsSorting;
		}

		// Ensure context keys reflect restored state immediately
		this.groupingContextKey = SessionsViewGroupingContext.bindTo(contextKeyService);
		this.groupingContextKey.set(this.currentGrouping);
		this.sortingContextKey = SessionsViewSortingContext.bindTo(contextKeyService);
		this.sortingContextKey.set(this.currentSorting);

		// Bind workspace group capped context key (will be synced with persisted state in renderBody)
		this.workspaceGroupCappedContextKey = IsWorkspaceGroupCappedContext.bindTo(contextKeyService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	protected override getLocationBasedColors(): IViewPaneLocationColors {
		const colors = super.getLocationBasedColors();
		return {
			...colors,
			background: undefined!,
			listOverrideStyles: {
				...colors.listOverrideStyles,
				listBackground: undefined!,
				treeStickyScrollBackground: agentsBackground,
			}
		};
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = DOM.append(parent, $('.agent-sessions-container'));

		// Sessions section (fills available space above the optional host toolbar)
		const sessionsSection = DOM.append(sessionsContainer, $('.agent-sessions-section'));

		// Sessions content container
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		// Desktop chrome: sidebar nav, WORKSPACES header (new chat, search,
		// filter), then an optional find row. Phone hides the nav in favor of filter
		// chips + the (+) button in MobileTitlebarPart.
		const phoneLayout = isPhoneLayout(this.layoutService);
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));

		if (!phoneLayout) {
			this.createSidebarNav(sessionsContent);
			this.createWorkspacesHeader(sessionsContent, scopedInstantiationService);
		}

		const headerRow = this.headerRow = DOM.append(sessionsContent, $('.agent-sessions-header-row'));
		if (!phoneLayout) {
			headerRow.classList.add('find-only');
		} else {
			headerRow.classList.add('phone-layout-empty');
		}

		const findWidgetContainer = this.findWidgetContainer = DOM.append(headerRow, $('.agent-sessions-find-widget-container'));
		findWidgetContainer.style.display = 'none';

		// Reserve DOM slot for mobile filter chips (phone layout only).
		// The actual widget is created after sessionsControl is available.
		const filterChipsContainer = isPhoneLayout(this.layoutService)
			? DOM.append(sessionsContent, $('.mobile-session-filter-chips-slot'))
			: undefined;

		// Sessions List Control
		this.sessionsControlContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(SessionsList, this.sessionsControlContainer, {
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			grouping: () => this.currentGrouping,
			sorting: () => this.currentSorting,
			findWidgetContainer,
			onSessionOpen: (resource, preserveFocus, sideBySide) => {
				const onOpened = () => {
					if (isWeb && isPhoneLayout(this.layoutService)) {
						this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
					}
				};
				if (sideBySide) {
					// Alt-click: open the session to the right of the last visible session in the grid.
					const session = this.sessionsManagementService.getSession(resource);
					if (session) {
						openSessionToTheSide(this.sessionsService, session, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
						return;
					}
				}
				this.sessionsService.openSession(resource, { preserveFocus }).then(onOpened).catch(onUnexpectedError);
			},
			canOpenSession: session => this.sessionsService.canOpenSession(session),
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));

		// Swap the find row in when search opens; the WORKSPACES header stays visible.
		this._register(sessionsControl.onDidChangeFindOpenState(open => {
			this.isFindWidgetOpen = open;
			findWidgetContainer.style.display = open ? '' : 'none';
			this.updateHeaderLayout();
		}));

		// Close find widget on Escape
		this._register(DOM.addDisposableListener(findWidgetContainer, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				sessionsControl.closeFind();
				e.stopPropagation();
			}
		}));

		// Sync workspace group capped context key with persisted state
		this.workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());

		// Register session type filter actions (re-register when session types change)
		this.registerSessionTypeFilters(sessionsControl);
		this._register(this.sessionsManagementService.onDidChangeSessionTypes(() => {
			this.registerSessionTypeFilters(sessionsControl);
		}));

		// Register status filter actions (static set, registered once)
		this.registerStatusFilters(sessionsControl);

		// Refresh sessions when window gets focus to compensate for missing events
		this._register(this.hostService.onDidChangeFocus(hasFocus => {
			if (hasFocus) {
				sessionsControl.refresh();
			}
		}));

		// Listen to list updates and restore selection if nothing is selected
		this._register(sessionsControl.onDidUpdate(() => {
			if (!sessionsControl.hasFocusOrSelection()) {
				this.restoreLastSelectedSession();
			}
		}));

		// Mobile filter chips (phone layout only) — created after sessionsControl
		// so we can wire it as the filter host.
		if (filterChipsContainer) {
			const chips = this._register(new MobileSessionFilterChips(filterChipsContainer, sessionsControl));
			this._register(chips.onDidRequestSortGroup(() => {
				this.openSortGroupSheet();
			}));
			this._register(chips.onDidRequestFind(() => {
				this.openFind();
			}));
		}

		// When the active session changes, reveal it in the sessions list.
		this._register(autorun(reader => {
			const activeSession = this.sessionsService.activeSession.read(reader);
			if (activeSession) {
				if (!sessionsControl.reveal(activeSession.resource)) {
					sessionsControl.clearFocus();
				}
			} else {
				sessionsControl.clearFocus();
			}
		}));

		// Agent Host toolbar (bottom). Only rendered in the sessions window on
		// web desktop layouts: electron has no host picker today (gated out at
		// the menu level), phone layout uses the mobile titlebar pill instead,
		// and auxiliary windows do not contribute any host actions — without
		// this gate they would show an empty toolbar shell.
		if (isWeb && this.scopedContextKeyService.contextMatchesRules(ContextKeyExpr.and(
			IsSessionsWindowContext,
			IsAuxiliaryWindowContext.toNegated(),
			IsPhoneLayoutContext.negate(),
		))) {
			this._register(this.instantiationService.createInstance(AgentHostShortcutsWidget, sessionsContainer, {
				onDidChangeLayout: () => {
					this.layoutSessionsList();
				},
			}));
		}

		this._register(DOM.scheduleAtNextAnimationFrame(DOM.getWindow(parent), () => this.layoutSessionsList()));
	}

	private createSidebarNav(parent: HTMLElement): void {
		const nav = DOM.append(parent, $('.agent-sessions-sidebar-nav'));

		this.appendSidebarNavItem(nav, {
			id: 'new-chat',
			label: localize('newChat', "New Chat"),
			icon: Codicon.send,
			onClick: () => {
				this.closeFindIfOpen();
				this.commandService.executeCommand(NEW_SESSION_ACTION_ID);
			},
		});

		// Always shown in the Agents sidebar chrome. Scheduler dispatch remains
		// gated on `chat.automations.enabled`; this only makes the nav item visible.
		this.automationsNavItem = this.appendSidebarNavItem(nav, {
			id: 'automations',
			label: localize('automations', "Automations"),
			icon: Codicon.robot,
			onClick: () => {
				this.closeFindIfOpen();
				this.commandService.executeCommand('sessionsView.manageAutomations');
			},
		});

		this.appendSidebarNavItem(nav, {
			id: 'customize',
			label: localize('customize', "Customize"),
			icon: Codicon.layout,
			onClick: () => {
				this.closeFindIfOpen();
				this.commandService.executeCommand(OPEN_AGENT_SETTINGS_COMMAND_ID, customizationNavId(CUSTOMIZATION_OVERVIEW_SECTION));
			},
		});

		this._register(autorun(reader => {
			const activeCustomView = this.customViewService.activeCustomView.read(reader);
			const automationsActive = activeCustomView?.id === AUTOMATIONS_CUSTOM_VIEW_ID;
			this.automationsNavItem?.classList.toggle('active', automationsActive);
			this.automationsNavItem?.setAttribute('aria-pressed', String(automationsActive));
		}));
	}

	private createWorkspacesHeader(parent: HTMLElement, instantiationService: IInstantiationService): void {
		const header = DOM.append(parent, $('.agent-sessions-workspaces-header'));
		if (isWeb) {
			// Web scopes the whole window to one host via the sidebar host
			// pill; the machine-filter dropdown is desktop-only until that
			// picker moves onto the scope API too.
			const label = DOM.append(header, $('span.agent-sessions-workspaces-label'));
			label.textContent = localize('workspacesHeader', "Workspaces");
		} else {
			this._register(instantiationService.createInstance(SessionsMachineFilter, header, {
				displayOptionsMenu: SessionsViewFilterSubMenu,
			}));
		}

		const actions = DOM.append(header, $('.agent-sessions-workspaces-actions'));
		this._register(instantiationService.createInstance(MenuWorkbenchToolBar, actions, Menus.SidebarSessionsHeader, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'sessionsView.header',
			toolbarOptions: { primaryGroup: () => true },
		}));
	}

	private appendSidebarNavItem(
		parent: HTMLElement,
		options: { id: string; label: string; icon: ThemeIcon; onClick: () => void },
	): HTMLElement {
		const button = DOM.append(parent, $('button.agent-sessions-nav-item'));
		button.classList.add(`agent-sessions-nav-item-${options.id}`);
		button.setAttribute('type', 'button');
		button.setAttribute('aria-label', options.label);
		button.setAttribute('aria-pressed', 'false');

		const icon = DOM.append(button, $('span.agent-sessions-nav-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(options.icon));

		const label = DOM.append(button, $('span.agent-sessions-nav-label'));
		label.textContent = options.label;

		this._register(DOM.addDisposableListener(button, 'click', () => options.onClick()));
		return button;
	}

	private restoreLastSelectedSession(): void {
		const activeSession = this.sessionsService.activeSession.get();
		if (activeSession && this.sessionsControl) {
			this.sessionsControl.reveal(activeSession.resource);
		}
	}

	private readonly registeredFilterTypeIds = new Set<string>();

	private readonly archivedFilterRegistration = this._register(new DisposableStore());

	private registerSessionTypeFilters(sessionsControl: SessionsList): void {
		const sessionTypes = this.sessionsManagementService.getAllSessionTypes();
		for (let i = 0; i < sessionTypes.length; i++) {
			const type = sessionTypes[i];

			// Skip if already registered (action IDs are global and can't be re-registered)
			if (this.registeredFilterTypeIds.has(type.id)) {
				continue;
			}
			this.registeredFilterTypeIds.add(type.id);

			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterType.${type.id}`, !sessionsControl.isSessionTypeExcluded(type.id));
			// Bind on the window service, not the pane-scoped one. The Filter
			// submenu opens as an overlay outside the pane element, so scoped
			// keys are invisible and the checkmarks look unsaved after toggle/reload.
			const contextKeyInstance = contextKey.bindTo(this.contextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterType.${type.id}`,
						title: type.label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '1_types',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isSessionTypeExcluded(type.id);
					sessionsControl.setSessionTypeExcluded(type.id, !isExcluded);
					contextKeyInstance.set(isExcluded); // was excluded, now included (toggle)
				}
			}));
		}
	}

	private registerStatusFilters(sessionsControl: SessionsList): void {
		const statusFilters: { status: SessionStatus; label: string }[] = [
			{ status: SessionStatus.Completed, label: localize('statusCompleted', "Completed") },
			{ status: SessionStatus.InProgress, label: localize('statusInProgress', "In Progress") },
			{ status: SessionStatus.NeedsInput, label: localize('statusNeedsInput', "Input Needed") },
			{ status: SessionStatus.Error, label: localize('statusFailed', "Failed") },
		];
		for (let i = 0; i < statusFilters.length; i++) {
			const { status, label } = statusFilters[i];
			const contextKey = new RawContextKey<boolean>(`sessionsViewPane.filterStatus.${status}`, !sessionsControl.isStatusExcluded(status));
			const contextKeyInstance = contextKey.bindTo(this.contextKeyService);
			this.filterContextKeys.set(contextKey.key, { key: contextKeyInstance, getDefault: () => true });

			this._register(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `sessionsViewPane.filterStatus.${status}`,
						title: label,
						toggled: ContextKeyExpr.equals(contextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '2_status',
							order: i,
						}]
					});
				}
				override run() {
					const isExcluded = sessionsControl.isStatusExcluded(status);
					sessionsControl.setStatusExcluded(status, !isExcluded);
					contextKeyInstance.set(isExcluded);
				}
			}));
		}

		// Archived toggle
		const archivedContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showArchived', !sessionsControl.isExcludeArchived());
		const archivedContextKeyInstance = archivedContextKey.bindTo(this.contextKeyService);
		this.filterContextKeys.set(archivedContextKey.key, { key: archivedContextKeyInstance, getDefault: () => false });

		// The archived filter label follows the configured archive action wording,
		// so the action is re-registered whenever that setting changes.
		const registerArchivedFilter = () => {
			this.archivedFilterRegistration.clear();
			const title = getChatSessionArchivedSectionLabel(getChatSessionArchiveActionWording(this.configurationService));
			this.archivedFilterRegistration.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: 'sessionsViewPane.filterArchived',
						title,
						toggled: ContextKeyExpr.equals(archivedContextKey.key, true),
						menu: [{
							id: SessionsViewFilterOptionsSubMenu,
							group: '3_props',
							order: 0,
						}]
					});
				}
				override run() {
					const excluding = sessionsControl.isExcludeArchived();
					sessionsControl.setExcludeArchived(!excluding);
					archivedContextKeyInstance.set(excluding); // was excluding → now showing
				}
			}));
		};
		registerArchivedFilter();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatSessionArchiveActionWordingSettingId)) {
				registerArchivedFilter();
			}
		}));

		// Read toggle
		const readContextKey = new RawContextKey<boolean>('sessionsViewPane.filter.showRead', !sessionsControl.isExcludeRead());
		const readContextKeyInstance = readContextKey.bindTo(this.contextKeyService);
		this.filterContextKeys.set(readContextKey.key, { key: readContextKeyInstance, getDefault: () => true });

		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.filterRead',
					title: localize('filterRead', "Read"),
					toggled: ContextKeyExpr.equals(readContextKey.key, true),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '3_props',
						order: 1,
					}]
				});
			}
			override run() {
				const excluding = sessionsControl.isExcludeRead();
				sessionsControl.setExcludeRead(!excluding);
				readContextKeyInstance.set(excluding);
			}
		}));

		// Reset filter action
		const filterContextKeys = this.filterContextKeys;
		const workspaceGroupCappedContextKey = this.workspaceGroupCappedContextKey;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'sessionsViewPane.resetFilters',
					title: localize('resetFilters', "Reset"),
					menu: [{
						id: SessionsViewFilterOptionsSubMenu,
						group: '4_reset',
						order: 0,
					}]
				});
			}
			override run() {
				sessionsControl.resetFilters();
				for (const { key, getDefault } of filterContextKeys.values()) {
					key.set(getDefault());
				}
				workspaceGroupCappedContextKey?.set(sessionsControl.isWorkspaceGroupCapped());
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.currentBodyWidth = width;
		this.updateHeaderLayout();
		this.layoutSessionsList();
	}

	private layoutSessionsList(): void {
		if (!this.sessionsControl || !this.sessionsControlContainer) {
			return;
		}

		this.sessionsControl.layout(this.sessionsControlContainer.offsetHeight, this.currentBodyWidth);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	openFind(): void {
		this.customViewService.hideCustomView();
		this.isFindWidgetOpen = true;
		if (this.findWidgetContainer) {
			// Show container before opening find so the widget can be focused
			this.findWidgetContainer.style.display = '';
		}
		this.updateHeaderLayout();
		this.sessionsControl?.openFind();
	}

	private closeFindIfOpen(): void {
		if (this.isFindWidgetOpen) {
			this.sessionsControl?.closeFind();
		}
	}

	private updateHeaderLayout(): void {
		if (!this.headerRow) {
			return;
		}

		// On phone the desktop header content is hidden; the row is only
		// visible when the find widget is open (so the user can search).
		if (isPhoneLayout(this.layoutService)) {
			this.headerRow.classList.toggle('phone-layout-empty', !this.isFindWidgetOpen);
			return;
		}

		this.headerRow.classList.toggle('find-open', this.isFindWidgetOpen);
	}

	/**
	 * Phone-only: present a bottom sheet with the sort/group toggles.
	 * Filtering on phone is performed via the status filter chips, so the
	 * sheet intentionally omits "Filter", "Show Recent/All Sessions", and
	 * "Collapse All Groups" actions found in the desktop submenu.
	 */
	private openSortGroupSheet(): void {
		const sortTitle = localize('sortGroupSheet.sort', "Sort");
		const groupTitle = localize('sortGroupSheet.group', "Group");

		const items: IMobileSortGroupSheetItem[] = [
			{
				id: SessionsSorting.Created,
				label: localize('sortByCreated', "Sort by Created"),
				checked: this.currentSorting === SessionsSorting.Created,
				group: 'sort',
				groupTitle: sortTitle,
			},
			{
				id: SessionsSorting.Updated,
				label: localize('sortByUpdated', "Sort by Updated"),
				checked: this.currentSorting === SessionsSorting.Updated,
				group: 'sort',
			},
			{
				id: SessionsGrouping.Workspace,
				label: localize('groupByProject', "Group by Project"),
				checked: this.currentGrouping === SessionsGrouping.Workspace,
				group: 'group',
				groupTitle: groupTitle,
			},
			{
				id: SessionsGrouping.Date,
				label: localize('groupByTime', "Group by Time"),
				checked: this.currentGrouping === SessionsGrouping.Date,
				group: 'group',
			},
			{
				id: SessionsGrouping.Agent,
				label: localize('groupByAgent', "Group by Agent"),
				checked: this.currentGrouping === SessionsGrouping.Agent,
				group: 'group',
			},
		];

		showMobileSortGroupSheet(this.layoutService.mainContainer, localize('sortGroupSheet.title', "Sort"), items).then(selectedId => {
			if (!selectedId) {
				return;
			}
			if (selectedId === SessionsSorting.Created || selectedId === SessionsSorting.Updated) {
				this.setSorting(selectedId);
			} else if (selectedId === SessionsGrouping.Workspace || selectedId === SessionsGrouping.Date || selectedId === SessionsGrouping.Agent) {
				this.setGrouping(selectedId);
			}
		});
	}

	setGrouping(grouping: SessionsGrouping): void {
		if (this.currentGrouping === grouping) {
			return;
		}

		this.currentGrouping = grouping;
		this.storageService.store(GROUPING_STORAGE_KEY, this.currentGrouping, StorageScope.PROFILE, StorageTarget.USER);
		this.groupingContextKey?.set(this.currentGrouping);
		this.sessionsControl?.resetSectionCollapseState();
		this.sessionsControl?.update(true);
	}

	setSorting(sorting: SessionsSorting): void {
		if (this.currentSorting === sorting) {
			return;
		}

		this.currentSorting = sorting;
		this.storageService.store(SORTING_STORAGE_KEY, this.currentSorting, StorageScope.PROFILE, StorageTarget.USER);
		this.sortingContextKey?.set(this.currentSorting);
		this.sessionsControl?.update();
	}
}
