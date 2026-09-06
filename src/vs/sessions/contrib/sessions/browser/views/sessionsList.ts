/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/sessionsList.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { pauseCSSAnimationsWhenHidden, synchronizeCSSAnimations } from '../../../../../base/browser/animationSync.js';
import { Gesture } from '../../../../../base/browser/touch.js';
import { IListVirtualDelegate, ListDragOverEffectPosition, ListDragOverEffectType, NotSelectableGroupId } from '../../../../../base/browser/ui/list/list.js';
import { IListStyles } from '../../../../../base/browser/ui/list/listWidget.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ITreeContextMenuEvent, ObjectTreeElementCollapseState, ITreeDragAndDrop, ITreeDragOverReaction } from '../../../../../base/browser/ui/tree/tree.js';
import { RenderIndentGuides, TreeFindMode } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { createMatches, FuzzyScore, IMatch } from '../../../../../base/common/filters.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IObservable, IReader, autorun, derived, observableSignalFromEvent, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { localize } from '../../../../../nls.js';
import { MenuId, IMenuService, MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { MarshalledId } from '../../../../../base/common/marshallingIds.js';
import { SessionProviderIdContext, SessionSupportsDeleteContext, SessionSupportsRenameContext, SessionTypeContext, IsPhoneLayoutContext, SessionIsArchivedContext, SessionIsReadContext, SessionHasPullRequestContext } from '../../../../common/contextkeys.js';
import { RENAME_SESSION_COMMAND_ID } from '../../../../common/sessionCommands.js';
import { REMOTE_AGENT_HOST_PROVIDER_PREFIX } from '../../../../common/agentHostSessionsProvider.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStyleOverride, defaultButtonStyles, defaultFindWidgetStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { chartsOrange } from '../../../../../platform/theme/common/colors/chartsColors.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatSessionArchiveActionWording, ChatSessionArchiveActionWordingSettingId, getChatSessionArchivedSectionLabel, getChatSessionArchiveActionWording } from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { getSessionStatusMessage, GITHUB_REMOTE_FILE_SCHEME, ISession, ISessionWorkspace, SessionStatus } from '../../../../services/sessions/common/session.js';
import { AgentSessionApprovalModel, agentSessionApprovalId, IAgentSessionApprovalInfo } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionApprovalModel.js';
import { IVoicePlaybackService } from '../../../../../workbench/contrib/chat/common/voicePlaybackService.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { Action, ActionRunner, IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { HoverStyle } from '../../../../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ISessionsManagementService, IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsListModelService, SessionSortMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionSectionOrderService } from '../../../../services/sessions/browser/sessionSectionOrderService.js';
import { IWorkbenchAssignmentService } from '../../../../../workbench/services/assignment/common/assignmentService.js';
// =============================================================================
// TEMPORARY (tracked by https://github.com/microsoft/vscode/issues/320480)
// -----------------------------------------------------------------------------
// `IAgentSessionsService` is a Copilot-provider internal and must normally only
// be consumed by the Copilot chat sessions provider — the rest of the Agents
// window stays provider-agnostic (see SESSIONS.md). This single, deliberate
// exception lets the sessions list trigger lazy resolution of expensive session
// properties (e.g. changes) for rows that scroll into view, until Don
// re-implements it the right way (driven from inside the Copilot provider, or
// via a provider-agnostic visibility signal on the shared services).
// DO NOT add further usages of this import in the sessions workbench, and DO NOT
// copy this suppression elsewhere.
// =============================================================================
// eslint-disable-next-line no-restricted-imports
import { IAgentSessionsService } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { AgentHostFilterConnectionStatus, IAgentHostFilterEntry, IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { DraggedSessionIdentifier, SessionsDataTransfers } from '../../../../browser/dnd.js';
import { IDragAndDropData } from '../../../../../base/browser/dnd.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../../base/browser/ui/list/listView.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { buildSessionHoverContent } from '../sessionHoverContent.js';
import { SessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';
import { Menus } from '../../../../browser/menus.js';

const $ = DOM.$;

/** The `loading` codicon with the shared spin modifier applied. */
const spinningLoading = ThemeIcon.modify(Codicon.loading, 'spin');

const SESSION_SECTION_FOCUS_FROM_POINTER_CLASS = 'session-section-focus-from-pointer';
const SESSION_HEADER_DROP_TARGET_CLASS = 'session-header-drop-target';

export const SessionItemToolbarMenuId = new MenuId('SessionItemToolbar');
export const SessionItemContextMenuId = MenuId.SessionItemContextMenu;
export const SessionSectionToolbarMenuId = new MenuId('SessionSectionToolbar');
export const NEW_SESSION_FOR_WORKSPACE_ACTION_ID = 'sessionsView.sectionNewSession';

export const IsSessionPinnedContext = new RawContextKey<boolean>('sessionItem.isPinned', false);
export const SessionItemHasBranchNameContext = new RawContextKey<boolean>('sessionItem.hasBranchName', false);
export const SessionItemStatusContext = new RawContextKey<SessionStatus>('sessionItem.status', SessionStatus.Completed);
export const SessionSectionTypeContext = new RawContextKey<string>('sessionSection.type', '');
export const SessionSectionHasGitHubRepositoryContext = new RawContextKey<boolean>('sessionSection.hasGitHubRepository', false);
export const SessionSectionHasNonCloudRepositoryContext = new RawContextKey<boolean>('sessionSection.hasNonCloudRepository', false);

//#region Types

export enum SessionsGrouping {
	Workspace = 'workspace',
	Date = 'date',
	Agent = 'agent',
}

export enum SessionsSorting {
	Created = 'created',
	Updated = 'updated',
}

function sortingToMode(sorting: SessionsSorting): SessionSortMode {
	return sorting === SessionsSorting.Updated ? 'updated' : 'created';
}

/** Fallback spacing (ms) used when assigning synthetic sort keys past an open boundary. */
const SORT_FALLBACK_STEP_MS = 60_000;

export interface ISessionSection {
	readonly id: string;
	readonly label: string;
	readonly icon?: ThemeIcon;
	readonly sessions: ISession[];
	/**
	 * The provider every session in this section belongs to, when they all
	 * share one. Set so a section backed by a single remote host can carry
	 * that host's connection controls; `undefined` for mixed sections.
	 */
	readonly providerId?: string;
}

/**
 * How usable a session's rows are right now.
 *
 * Remote hosts hand out a cached session list before — and after — they have a
 * transport, so a row can look perfectly ordinary while there is nothing behind
 * it to open. The list has to say which of the two it is showing.
 */
export const enum SessionHostReachability {
	/** A local session, or a remote host with a live transport. */
	Reachable = 'reachable',
	/** A remote host with a connect attempt in flight. */
	Connecting = 'connecting',
	/** A remote host with no transport and nothing in flight. */
	Unreachable = 'unreachable',
}

/**
 * Reachability of the host that owns `providerId`. Providers the host filter
 * doesn't know are local, and therefore always reachable.
 */
export function sessionHostReachability(hosts: readonly IAgentHostFilterEntry[], providerId: string | undefined): SessionHostReachability {
	const host = providerId === undefined ? undefined : hosts.find(h => h.providerId === providerId);
	if (!host || host.hasLiveConnection) {
		return SessionHostReachability.Reachable;
	}
	return host.status === AgentHostFilterConnectionStatus.Connecting
		? SessionHostReachability.Connecting
		: SessionHostReachability.Unreachable;
}

export interface ISessionShowMore {
	readonly showMore: true;
	readonly kind: 'sessions' | 'folders';
	readonly mode: 'more' | 'less';
	readonly sectionId: string;
	readonly sectionLabel: string;
	readonly remainingCount: number;
}

export type SessionListItem = ISession | ISessionSection | ISessionShowMore;

function isSessionSection(item: SessionListItem): item is ISessionSection {
	return 'sessions' in item && Array.isArray((item as ISessionSection).sessions);
}

function isSessionShowMore(item: SessionListItem): item is ISessionShowMore {
	return 'showMore' in item && (item as ISessionShowMore).showMore === true;
}

function isSessionItem(item: SessionListItem): item is ISession {
	return !isSessionSection(item) && !isSessionShowMore(item);
}

const SHOW_MORE_FOLDERS_LABEL = '__more_folders__';
/** Codex desktop initially surfaces at most five unpinned project groups. */
const DEFAULT_VISIBLE_PROJECT_LIMIT = 5;

/**
 * Default number of terminal-command lines shown in a session row's approval
 * prompt. The blocked-sessions dropdown overrides this to show more lines.
 */
const DEFAULT_APPROVAL_ROW_MAX_LINES = 3;

//#endregion

//#region Tree Delegate

class SessionsTreeDelegate implements IListVirtualDelegate<SessionListItem> {
	private static readonly ITEM_HEIGHT = 32;
	/** Quick-chat rows are single-line — see the `.session-item.quick-chat` rules in `sessionsList.css`. */
	private static readonly ITEM_HEIGHT_QUICK_CHAT = 28;
	/**
	 * Phone layout uses a taller row so the inline action toolbar can
	 * meet the 44px minimum touch target without overflowing. Sized to
	 * fit a 44px toolbar centered between the title and details rows.
	 * Keep in sync with the `.phone-layout .session-item` rules in
	 * `sessionsList.css`.
	 */
	private static readonly ITEM_HEIGHT_PHONE = 76;
	private static readonly SECTION_HEIGHT = 24;
	private static readonly SHOW_MORE_HEIGHT = 24;

	constructor(
		private readonly _approvalModel: AgentSessionApprovalModel | undefined,
		private readonly _isPhone: () => boolean,
		private readonly _approvalRowMaxLines: number = DEFAULT_APPROVAL_ROW_MAX_LINES,
		private readonly _ciFixModel: ISessionCIFixModel | undefined = undefined,
		private readonly _useCompactQuickChatRows = true,
	) { }

	getHeight(element: SessionListItem): number {
		if (isSessionSection(element)) {
			return SessionsTreeDelegate.SECTION_HEIGHT;
		}
		if (isSessionShowMore(element)) {
			return SessionsTreeDelegate.SHOW_MORE_HEIGHT;
		}

		let height: number;
		if (this._isPhone()) {
			height = SessionsTreeDelegate.ITEM_HEIGHT_PHONE;
		} else if (this._useCompactQuickChatRows && isQuickChatSession(element as ISession)) {
			height = SessionsTreeDelegate.ITEM_HEIGHT_QUICK_CHAT;
		} else {
			height = SessionsTreeDelegate.ITEM_HEIGHT;
		}
		if (this._approvalModel) {
			const approval = getFirstApprovalAcrossChats(this._approvalModel, element as ISession, undefined);
			if (approval) {
				height += SessionItemRenderer.getApprovalRowHeight(approval.label, this._approvalRowMaxLines);
			}
		}
		if (this._ciFixModel && this._ciFixModel.getCIFix(element as ISession).get()) {
			height += SessionItemRenderer.CI_ROW_HEIGHT;
		}
		return height;
	}

	hasDynamicHeight(element: SessionListItem): boolean {
		return (!!this._approvalModel || !!this._ciFixModel) && isSessionItem(element);
	}

	getTemplateId(element: SessionListItem): string {
		if (isSessionSection(element)) {
			return SessionSectionRenderer.TEMPLATE_ID;
		}
		if (isSessionShowMore(element)) {
			return SessionShowMoreRenderer.TEMPLATE_ID;
		}
		return SessionItemRenderer.TEMPLATE_ID;
	}
}

//#endregion

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

/**
 * Cursor-like compact relative time for session list rows: `5m`, `2h`, `1d`,
 * `Jan 12`. Quiet secondary metadata — not `2 hrs ago` or a locale timestamp.
 */
export function formatCompactSessionTime(date: Date, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
	if (seconds < HOUR_S) {
		return localize('compactSessionTime.minutes', "{0}m", Math.max(1, Math.floor(seconds / MINUTE_S)));
	}
	if (seconds < DAY_S) {
		return localize('compactSessionTime.hours', "{0}h", Math.floor(seconds / HOUR_S));
	}
	if (seconds < 7 * DAY_S) {
		return localize('compactSessionTime.days', "{0}d", Math.floor(seconds / DAY_S));
	}

	const currentYear = new Date(now).getFullYear();
	const options: Intl.DateTimeFormatOptions = date.getFullYear() === currentYear
		? { month: 'short', day: 'numeric' }
		: { month: 'short', day: 'numeric', year: 'numeric' };
	return safeIntl.DateTimeFormat(undefined, options).value.format(date);
}

//#region Session Item Renderer

/**
 * Resolves inline toolbar actions against either a focused-list handler or the
 * current multi-selection.
 */
class SessionItemActionRunner extends ActionRunner {

	constructor(
		private readonly getMultiSelectedSessions: (session: ISession) => ISession[],
		private readonly handleAction?: (action: IAction, session: ISession) => boolean | Promise<boolean>,
	) {
		super();
	}

	protected override async runAction(action: IAction, context?: unknown): Promise<void> {
		if (context && !Array.isArray(context)) {
			if (this.handleAction && await this.handleAction(action, context as ISession)) {
				return;
			}
			await super.runAction(action, this.getMultiSelectedSessions(context as ISession));
			return;
		}
		await super.runAction(action, context);
	}
}

// Keyframes name of the in-progress title shimmer (see `session-title-shimmer`
// in sessionsList.css). Used to phase-align the shimmer across rows.
const SESSION_TITLE_SHIMMER_ANIMATION_NAME = 'session-title-shimmer';
const SESSION_TITLE_SHIMMER_ANIMATION_NAMES = new Set([SESSION_TITLE_SHIMMER_ANIMATION_NAME]);
const SESSION_TITLE_SHIMMER_PAUSED_CLASS = 'session-title-shimmer-paused';

interface ISessionItemTemplate {
	readonly container: HTMLElement;
	readonly statusIcon: SessionStatusIcon;
	readonly title: HighlightedLabel;
	readonly titleContainer: HTMLElement;
	readonly titleToolbar: MenuWorkbenchToolBar | undefined;
	readonly pendingVoiceIndicator: HTMLElement;
	readonly detailsRow: HTMLElement;
	readonly approvalRow: HTMLElement;
	readonly approvalLabel: HTMLElement;
	readonly approvalButtonContainer: HTMLElement;
	readonly ciRow: HTMLElement;
	readonly ciLabel: HTMLElement;
	readonly ciButtonContainer: HTMLElement;
	readonly contextKeyService: IContextKeyService;
	readonly statusContext: IContextKey<SessionStatus>;
	readonly isReadContext: IContextKey<boolean>;
	readonly supportsDeleteContext: IContextKey<boolean>;
	readonly disposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
}

/** Payload emitted when the user approves a session's pending action. */
export interface IApprovedSession {
	readonly session: ISession;
	/**
	 * Identity of the approval that was allowed, so consumers can tell this exact
	 * approval apart from a later, distinct one on the same session.
	 */
	readonly approvalId: string;
}

/** Summary of a session's failing CI checks, backing its "Fix CI" row. */
export interface ISessionCIFixState {
	/** Number of checks that have completed with a failing conclusion. */
	readonly failed: number;
	/** Number of checks still running or queued. */
	readonly pending: number;
}

/**
 * Supplies the per-session "Fix CI" row shown for blocked sessions whose pull
 * request has failing CI checks. Only the blocked-sessions dropdown provides one
 * (via {@link ISessionsFlatListOptions.ciFixModel}), so the row never appears in
 * any other session list.
 */
export interface ISessionCIFixModel {
	/**
	 * Observable CI-failure summary for a session, or `undefined` when it has no
	 * failing checks (or the user already requested a fix for the current commit).
	 */
	getCIFix(session: ISession): IObservable<ISessionCIFixState | undefined>;
	/** Kick off the fix-CI flow for the session in the background (no session is opened). */
	fixCI(session: ISession): void;
}

class SessionItemRenderer implements ITreeRenderer<SessionListItem, FuzzyScore, ISessionItemTemplate> {
	static readonly TEMPLATE_ID = 'session-item';
	readonly templateId = SessionItemRenderer.TEMPLATE_ID;
	readonly rowClassName = 'session-list-inset-row';

	private static readonly _APPROVAL_ROW_LINE_HEIGHT = 18;
	private static readonly _APPROVAL_ROW_OVERHEAD = 14;

	/** Height of the single-line "Fix CI" row (label + orange button), including its top margin. */
	static readonly CI_ROW_HEIGHT = 32;

	static getApprovalRowHeight(label: string, maxLines: number = DEFAULT_APPROVAL_ROW_MAX_LINES): number {
		const lineCount = Math.min(label.split(/\r?\n/).length, maxLines);
		return lineCount * SessionItemRenderer._APPROVAL_ROW_LINE_HEIGHT + SessionItemRenderer._APPROVAL_ROW_OVERHEAD;
	}

	private readonly _onDidChangeItemHeight = new Emitter<ISession>();
	readonly onDidChangeItemHeight: Event<ISession> = this._onDidChangeItemHeight.event;

	private readonly _onDidApproveSession = new Emitter<IApprovedSession>();
	/** Fires when the user approves a session's pending action via its "Allow" button. */
	readonly onDidApproveSession: Event<IApprovedSession> = this._onDidApproveSession.event;

	constructor(
		private readonly options: { grouping: () => SessionsGrouping; isPinned: (session: ISession) => boolean; visibleSessions: IObservable<readonly (IActiveSession | undefined)[]>; getMultiSelectedSessions: (session: ISession) => ISession[]; showHover: boolean; useCompactQuickChatRows: boolean; approvalRowMaxLines: number; toolbarMenuId: MenuId | undefined; handleToolbarAction?: (action: IAction, session: ISession) => boolean | Promise<boolean>; onDidRequestRename?: (session: ISession) => void; hostReachability?: { get: (session: ISession) => SessionHostReachability; onDidChange: Event<void> } },
		private readonly approvalModel: AgentSessionApprovalModel | undefined,
		private readonly ciFixModel: ISessionCIFixModel | undefined,
		private readonly instantiationService: IInstantiationService,
		private readonly contextKeyService: IContextKeyService,
		private readonly markdownRendererService: IMarkdownRendererService,
		private readonly hoverService: IHoverService,
		private readonly sessionsProvidersService: ISessionsProvidersService,
		// TEMPORARY — see the note on the `IAgentSessionsService` import above (#320480).
		private readonly agentSessionsService: IAgentSessionsService,
		private readonly _voicePlaybackService: IVoicePlaybackService,
	) {
	}

	renderTemplate(container: HTMLElement): ISessionItemTemplate {
		const disposables = new DisposableStore();
		const elementDisposables = disposables.add(new DisposableStore());

		container.classList.add('session-item');

		const iconContainer = DOM.append(container, $('.session-icon'));
		const statusIcon = disposables.add(this.instantiationService.createInstance(SessionStatusIcon, iconContainer));
		const mainCol = DOM.append(container, $('.session-main'));
		const titleRow = DOM.append(mainCol, $('.session-title-row'));
		const titleContainer = DOM.append(titleRow, $('.session-title'));
		const title = disposables.add(new HighlightedLabel(titleContainer));
		// The shimmer's CSS animation restarts from zero whenever it (re)starts —
		// e.g. selecting then deselecting an in-progress row re-adds the animation
		// via the `:not(.selected)` selector, and rows already shimmering at first
		// render each started on their own clock. Anchor every (re)start to the
		// shared document timeline so all rows stay perfectly in phase. This fires
		// once per start (not per frame), so it is effectively free.
		disposables.add(DOM.addDisposableListener(titleContainer, DOM.EventType.ANIMATION_START, (e: AnimationEvent) => {
			if (e.target === titleContainer && e.animationName === SESSION_TITLE_SHIMMER_ANIMATION_NAME) {
				synchronizeCSSAnimations(titleContainer, { animationNames: SESSION_TITLE_SHIMMER_ANIMATION_NAMES });
			}
		}));
		disposables.add(pauseCSSAnimationsWhenHidden(titleContainer, {
			pausedClass: SESSION_TITLE_SHIMMER_PAUSED_CLASS,
			animationNames: SESSION_TITLE_SHIMMER_ANIMATION_NAMES,
		}));
		// Shown when a voice response arrived while this session was unfocused and
		// is held until it is (mirrors the main window's sessions viewer).
		const pendingVoiceIndicator = DOM.append(titleRow, $('.session-pending-voice-indicator'));
		const detailsRow = DOM.append(mainCol, $('.session-details-row'));

		// Approval row
		const approvalRow = DOM.append(mainCol, $('.session-approval-row'));
		const approvalLabel = DOM.append(approvalRow, $('span.session-approval-label'));
		const approvalButtonContainer = DOM.append(approvalRow, $('.session-approval-button'));

		// Fix-CI row — shown only in the blocked-sessions list for sessions whose
		// pull request has failing CI checks. Styled like the chat input's CI banner.
		const ciRow = DOM.append(mainCol, $('.session-ci-row'));
		const ciLabel = DOM.append(ciRow, $('span.session-ci-label'));
		const ciButtonContainer = DOM.append(ciRow, $('.session-ci-button'));
		// The list opens a session on click/tap. The "Fix CI" button opens the
		// session itself as part of its flow, so swallow row clicks here to stop
		// them bubbling to the tree and triggering a second, racing open.
		for (const eventType of ['pointerdown', 'pointerup', 'click', 'dblclick'] as const) {
			disposables.add(DOM.addDisposableListener(ciRow, eventType, e => e.stopPropagation()));
		}
		disposables.add(Gesture.ignoreTarget(ciRow));

		// Overlay pin/archive on the row itself. Virtual list rows are
		// `overflow: hidden` and 32px tall; putting the toolbar in the
		// wrapping `.session-main` flow lets it drop onto a clipped second
		// line, so Archive clicks never hit the action.
		const titleToolbarContainer = DOM.append(container, $('.session-title-toolbar'));
		for (const eventType of ['pointerdown', 'pointerup', 'click', 'dblclick'] as const) {
			disposables.add(DOM.addDisposableListener(titleToolbarContainer, eventType, e => e.stopPropagation()));
		}
		disposables.add(Gesture.ignoreTarget(titleToolbarContainer));

		const contextKeyService = disposables.add(this.contextKeyService.createScoped(container));
		const statusContext = SessionItemStatusContext.bindTo(contextKeyService);
		const isReadContext = SessionIsReadContext.bindTo(contextKeyService);
		const supportsDeleteContext = SessionSupportsDeleteContext.bindTo(contextKeyService);
		const scopedInstantiationService = disposables.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
		let titleToolbar: MenuWorkbenchToolBar | undefined;
		if (this.options.toolbarMenuId) {
			const actionRunner = disposables.add(new SessionItemActionRunner(this.options.getMultiSelectedSessions, this.options.handleToolbarAction));
			titleToolbar = disposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, titleToolbarContainer, this.options.toolbarMenuId, {
				menuOptions: { shouldForwardArgs: true },
				actionRunner,
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				resetMenu: undefined,
				toolbarOptions: { primaryGroup: () => true },
			}));
		}

		return { container, statusIcon, title, titleContainer, titleToolbar, pendingVoiceIndicator, detailsRow, approvalRow, approvalLabel, approvalButtonContainer, ciRow, ciLabel, ciButtonContainer, contextKeyService, statusContext, isReadContext, supportsDeleteContext, disposables, elementDisposables };
	}

	renderElement(node: ITreeNode<SessionListItem, FuzzyScore>, _index: number, template: ISessionItemTemplate): void {
		const element = node.element;
		if (!isSessionItem(element)) {
			return;
		}
		this.renderSession(element, template, createMatches(node.filterData));
	}

	private renderSession(element: ISession, template: ISessionItemTemplate, matches?: IMatch[]): void {
		template.elementDisposables.clear();

		// A row whose host has no transport is shown, but not offered: opening
		// it would fail deep inside the editor stack with nothing to see.
		const hostReachability = this.options.hostReachability;
		if (hostReachability) {
			const updateReachability = () => {
				const reachability = hostReachability.get(element);
				template.container.classList.toggle('session-item-unreachable', reachability !== SessionHostReachability.Reachable);
			};
			template.elementDisposables.add(hostReachability.onDidChange(updateReachability));
			updateReachability();
		}

		if (this.options.onDidRequestRename) {
			template.elementDisposables.add(DOM.addDisposableListener(template.title.element, DOM.EventType.DBLCLICK, (event: MouseEvent) => {
				if (
					event.button !== 0 ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					!element.capabilities.get().supportsRename
				) {
					return;
				}

				event.preventDefault();
				event.stopPropagation();
				this.options.onDidRequestRename?.(element);
			}));
		}

		// TEMPORARY (#320480): trigger lazy resolve of expensive session
		// properties (e.g. changes) for rows that scroll into view, so providers
		// that populate them on demand deliver fresh data by the time the row
		// renders. This reaches into a Copilot-provider internal and must be
		// moved into the provider — see the note on the import above.
		this.agentSessionsService.model.observeSession(element.resource);

		if (this.options.showHover) {
			// Rich hover on the row showing folder, branch, diff stats and provider.
			template.elementDisposables.add(this.hoverService.setupDelayedHover(template.container, () => ({
				content: buildSessionHoverContent(element, this.sessionsProvidersService),
				appearance: { showPointer: true },
				position: { hoverPosition: HoverPosition.RIGHT, forcePosition: true },
				persistence: { hideOnHover: false },
			}), { groupId: 'sessions-list' }));
		}

		// Pending voice response indicator: a response arrived while this session
		// was unfocused and is held until it is.
		const pendingVoiceResource = element.resource;
		template.pendingVoiceIndicator.className = 'session-pending-voice-indicator ' + ThemeIcon.asClassName(Codicon.unmute);
		template.elementDisposables.add(this.hoverService.setupManagedHover(
			getDefaultHoverDelegate('mouse'),
			template.pendingVoiceIndicator,
			localize('pendingVoiceResponse', "Voice response ready"),
		));
		template.elementDisposables.add(autorun(reader => {
			this._voicePlaybackService.pendingResponseVersion.read(reader);
			template.pendingVoiceIndicator.classList.toggle('visible', this._voicePlaybackService.hasPendingResponse(pendingVoiceResource));
		}));

		// Toolbar context
		if (template.titleToolbar) {
			template.titleToolbar.context = element;
		}

		// Context keys
		const isPinned = this.options.isPinned(element);
		IsSessionPinnedContext.bindTo(template.contextKeyService).set(isPinned);
		const isArchivedContext = SessionIsArchivedContext.bindTo(template.contextKeyService);
		SessionItemHasBranchNameContext.bindTo(template.contextKeyService).set(!!element.workspace.get()?.folders[0]?.gitRepository?.branchName?.trim());
		const supportsRenameContext = SessionSupportsRenameContext.bindTo(template.contextKeyService);
		template.elementDisposables.add(autorun(reader => {
			supportsRenameContext.set(element.capabilities.read(reader).supportsRename ?? false);
		}));

		// Pinned & archived styling — reactive
		template.elementDisposables.add(autorun(reader => {
			const isArchived = element.isArchived.read(reader);
			isArchivedContext.set(isArchived);
			template.container.classList.toggle('archived', isArchived);
			// Only apply pinned styling when not archived to avoid persistent toolbars on archived sessions
			template.container.classList.toggle('pinned', isPinned && !isArchived);
		}));

		// Sticky styling — reactive on the wrapper's sticky observable
		template.elementDisposables.add(autorun(reader => {
			const wrapper = this.options.visibleSessions.read(reader).find(s => s?.sessionId === element.sessionId);
			const isSticky = wrapper ? wrapper.sticky.read(reader) : false;
			template.container.classList.toggle('sticky', isSticky);
		}));

		// Icon — reactive based on status, read state, PR, and motion preference.
		// The current icon CSS selector is stored on the template (not a local
		// variable) so it survives across renderSession calls — the tree re-renders
		// all visible rows on every splice, which clears elementDisposables and
		// recreates the autorun. Without template-level tracking, the selector
		// resets to undefined and the DOM is rebuilt every time, restarting the
		// CSS spin animation.
		template.elementDisposables.add(autorun(reader => {
			const sessionStatus = element.status.read(reader);
			template.statusContext.set(sessionStatus);
			const isRead = element.isRead.read(reader);
			template.isReadContext.set(isRead);
			const isArchived = element.isArchived.read(reader);
			const capabilities = element.capabilities.read(reader);
			template.supportsDeleteContext.set(capabilities.supportsDelete === true);
			const gitHubInfo = element.workspace.read(reader)?.folders[0]?.gitRepository?.gitHubInfo.read(reader);
			const isQuickChat = element.isQuickChat?.read(reader) ?? false;
			const completedStateIcon = element.completedStateIcon?.read(reader) ?? gitHubInfo?.pullRequest?.icon;

			// The status icon widget snaps on row recycling and cross-fades real state changes.
			template.statusIcon.setStatus(sessionStatus, isRead, isArchived, completedStateIcon, element.resource);
			// The title shimmer (toggled by the `in-progress` class) is phase-aligned
			// across rows via an `animationstart` handler on the title element, so no
			// per-state work is needed here.
			template.container.classList.toggle('in-progress', sessionStatus === SessionStatus.InProgress);
			template.container.classList.toggle('needs-input', sessionStatus === SessionStatus.NeedsInput);
			template.container.classList.toggle('unread', !isRead && !isArchived);
			template.container.classList.toggle('quick-chat', isQuickChat && this.options.useCompactQuickChatRows);
		}));

		// Title — reactive
		template.elementDisposables.add(autorun(reader => {
			const titleText = element.title.read(reader);
			template.title.set(titleText, matches);
		}));

		// Inline metadata — provider · time/status. Project, worktree and diff
		// details live in the section header, hover and Changes/Files views instead
		// of creating a second line in the compact sessions list.
		// (quick chats use an even smaller row: no metadata, and
		// no "Working..." text since their spinner status icon already conveys it)
		const timeDisposable = template.elementDisposables.add(new MutableDisposable());
		const descriptionDisposable = template.elementDisposables.add(new MutableDisposable());
		template.elementDisposables.add(autorun(reader => {
			const sessionStatus = element.status.read(reader);
			const description = element.description.read(reader);
			const isQuickChat = element.isQuickChat?.read(reader) ?? false;

			// Clear and rebuild details row
			DOM.clearNode(template.detailsRow);

			// Compact quick chats have no details row.
			if (isQuickChat && this.options.useCompactQuickChatRows) {
				descriptionDisposable.clear();
				timeDisposable.clear();
				return;
			}

			let timeDate: Date | undefined;

			// Active sessions show their current status instead of a timestamp.
			const hideDetails = sessionStatus === SessionStatus.InProgress || sessionStatus === SessionStatus.NeedsInput;

			if (!hideDetails) {
				timeDate = element.updatedAt.read(reader);
			}

			const parts: HTMLElement[] = [];

			// Provider icon — keep the owning app visible even when sessions from
			// Codex and Claude share the same project. Folder/worktree information
			// remains available in the row hover and Files view; using it here made
			// the compact list look like it was grouping by worktree again.
			const providerIconEl = DOM.append(template.detailsRow, $('span.session-details-icon.session-provider-icon'));
			providerIconEl.setAttribute('aria-hidden', 'true');
			DOM.append(providerIconEl, $(`span${ThemeIcon.asCSSSelector(element.icon)}`));
			parts.push(providerIconEl);

			const statusMessage = getSessionStatusMessage(sessionStatus, description);
			if (statusMessage !== undefined) {
				if (parts.length > 0) {
					DOM.append(template.detailsRow, $('span.session-separator.has-separator'));
				}
				const statusEl = DOM.append(template.detailsRow, $('span.session-description'));
				if (typeof statusMessage === 'string') {
					descriptionDisposable.clear();
					statusEl.textContent = statusMessage;
				} else {
					descriptionDisposable.value = this.markdownRendererService.render(statusMessage, { sanitizerConfig: { replaceWithPlaintext: true } }, statusEl);
				}
				parts.push(statusEl);
			} else {
				descriptionDisposable.clear();
			}

			// Timestamp — visible when not hiding details
			if (!hideDetails && timeDate) {
				if (parts.length > 0) {
					DOM.append(template.detailsRow, $('span.session-separator.has-separator'));
				}
				const timeEl = DOM.append(template.detailsRow, $('span.session-time'));
				const definiteTimeDate = timeDate;
				const formatTime = () => formatCompactSessionTime(definiteTimeDate);
				timeEl.textContent = formatTime();
				const targetWindow = DOM.getWindow(timeEl);
				const interval = targetWindow.setInterval(() => {
					timeEl.textContent = formatTime();
				}, 60_000);
				timeDisposable.value = toDisposable(() => targetWindow.clearInterval(interval));
			} else {
				timeDisposable.clear();
			}
		}));

		// Approval row — reactive
		if (this.approvalModel) {
			this.renderApprovalRow(element, template);
		}

		// Fix-CI row — reactive (only supplied by the blocked-sessions list)
		if (this.ciFixModel) {
			this.renderCIRow(element, template);
		}
	}

	private renderApprovalRow(element: ISession, template: ISessionItemTemplate): void {
		if (!this.approvalModel) {
			return;
		}

		const approvalModel = this.approvalModel;
		const initialInfo = getFirstApprovalAcrossChats(approvalModel, element, undefined);
		let wasVisible = !!initialInfo;
		template.approvalRow.classList.toggle('visible', wasVisible);

		const buttonStore = template.elementDisposables.add(new DisposableStore());

		template.elementDisposables.add(autorun(reader => {
			buttonStore.clear();

			const info = getFirstApprovalAcrossChats(approvalModel, element, reader);
			const visible = !!info;

			template.approvalRow.classList.toggle('visible', visible);

			if (info) {
				// Render up to `maxLines` lines as separate code blocks
				const lines = info.label.split('\n');
				const maxLines = this.options.approvalRowMaxLines;
				const visibleLines = lines.slice(0, maxLines);
				if (lines.length > maxLines) {
					visibleLines[maxLines - 1] = `${visibleLines[maxLines - 1]} \u2026`;
				}
				const langId = info.languageId ?? 'json';
				const labelContent = new MarkdownString();
				for (const line of visibleLines) {
					labelContent.appendCodeblock(langId, line);
				}

				template.approvalLabel.textContent = '';
				buttonStore.add(this.markdownRendererService.render(labelContent, {}, template.approvalLabel));

				if (this.options.showHover) {
					const fullContent = new MarkdownString().appendCodeblock(info.languageId ?? 'json', info.label);
					buttonStore.add(this.hoverService.setupDelayedHover(template.approvalLabel, {
						content: fullContent,
						style: HoverStyle.Pointer,
						position: { hoverPosition: HoverPosition.BELOW },
					}));
				}

				template.approvalButtonContainer.textContent = '';
				const button = buttonStore.add(new Button(template.approvalButtonContainer, {
					title: localize('allowActionOnce', "Allow once"),
					secondary: true,
					...defaultButtonStyles
				}));
				button.label = localize('allowAction', "Allow");
				buttonStore.add(button.onDidClick(() => {
					// Capture the approval's identity BEFORE confirming: `confirm()` may
					// synchronously clear the pending approval, so we can't read it after.
					const approvalId = agentSessionApprovalId(info);
					info.confirm();
					this._onDidApproveSession.fire({ session: element, approvalId });
				}));
			}

			if (wasVisible !== visible) {
				wasVisible = visible;
				this._onDidChangeItemHeight.fire(element);
			}
		}));
	}

	private renderCIRow(element: ISession, template: ISessionItemTemplate): void {
		if (!this.ciFixModel) {
			return;
		}

		const ciFixModel = this.ciFixModel;
		const stateObs = ciFixModel.getCIFix(element);
		let wasVisible = !!stateObs.get();
		template.ciRow.classList.toggle('visible', wasVisible);

		const buttonStore = template.elementDisposables.add(new DisposableStore());

		template.elementDisposables.add(autorun(reader => {
			buttonStore.clear();

			const state = stateObs.read(reader);
			const visible = !!state;

			template.ciRow.classList.toggle('visible', visible);

			if (state) {
				template.ciLabel.textContent = localize('ci.blockedRow', "{0} checks failed, {1} pending", state.failed, state.pending);

				template.ciButtonContainer.textContent = '';
				// Match the chat input CI banner's prominent orange action button.
				const button = buttonStore.add(new Button(template.ciButtonContainer, {
					title: localize('ci.fixCITooltip', "Fix failing CI checks"),
					...defaultButtonStyles,
					buttonBackground: asCssVariable(chartsOrange),
					buttonHoverBackground: `color-mix(in srgb, ${asCssVariable(chartsOrange)} 88%, black)`,
					buttonBorder: asCssVariable(chartsOrange),
				}));
				button.label = localize('ci.fixCI', "Fix CI");
				buttonStore.add(button.onDidClick(() => ciFixModel.fixCI(element)));
			}

			if (wasVisible !== visible) {
				wasVisible = visible;
				this._onDidChangeItemHeight.fire(element);
			}
		}));
	}

	disposeElement(node: ITreeNode<SessionListItem, FuzzyScore>, _index: number, template: ISessionItemTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: ISessionItemTemplate): void {
		template.disposables.dispose();
	}
}

function getWorkspaceBadgeLabel(workspace: ISessionWorkspace): string | undefined {
	const folder = workspace.folders[0];
	if (folder?.root.scheme === GITHUB_REMOTE_FILE_SCHEME) {
		const parts = folder.root.path.split('/').filter(Boolean);
		if (parts.length >= 2) {
			return `${parts[0]}/${parts[1]}`;
		}
	}
	return workspace.label;
}

//#endregion

//#region Section Header Renderer

interface ISessionHeaderTemplate {
	readonly toolbarContainer: HTMLElement;
	readonly toolbar: MenuWorkbenchToolBar;
	readonly elementDisposables: DisposableStore;
}

function renderSessionHeaderToolbar<T>(template: ISessionHeaderTemplate, element: T, select: (element: T, event: MouseEvent) => void): void {
	template.elementDisposables.add(DOM.addDisposableListener(template.toolbarContainer, DOM.EventType.CONTEXT_MENU, event => select(element, event), true));
	template.toolbar.context = element;
}

interface ISessionSectionTemplate extends ISessionHeaderTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	/** Always-visible connection controls for a section backed by a remote host. */
	readonly host: HTMLElement;
	readonly hostSpinner: HTMLElement;
	readonly hostRetry: HTMLElement;
	readonly hostForget: HTMLElement;
	readonly chevron: HTMLElement;
	readonly contextKeyService: IContextKeyService;
	readonly disposables: DisposableStore;
}

export class SessionSectionRenderer implements ITreeRenderer<SessionListItem, FuzzyScore, ISessionSectionTemplate> {
	static readonly TEMPLATE_ID = 'session-section';
	readonly templateId = SessionSectionRenderer.TEMPLATE_ID;

	private readonly templatesByElement = new WeakMap<ISessionSection, ISessionSectionTemplate>();
	private readonly templatesById = new Map<string, ISessionSectionTemplate>();

	constructor(
		private readonly hideSectionCount: boolean,
		private readonly select: (element: ISessionSection, event: MouseEvent) => void,
		private readonly instantiationService: IInstantiationService,
		private readonly contextKeyService: IContextKeyService,
		private readonly menuService: IMenuService,
		private readonly agentHostFilterService: IAgentHostFilterService,
	) { }

	renderTemplate(container: HTMLElement): ISessionSectionTemplate {
		const disposables = new DisposableStore();
		const elementDisposables = disposables.add(new DisposableStore());
		const actionViewItemDisposables = disposables.add(new DisposableStore());
		const dropdownAction = disposables.add(new Action(
			'sessionsView.sectionNewSession.moreActions',
			localize('newSessionForWorkspaceMoreActions', "More Actions"),
		));

		container.classList.add('session-section');
		const chevron = DOM.append(container, $('span.session-section-chevron'));
		chevron.setAttribute('aria-hidden', 'true');
		const icon = DOM.append(container, $('span.session-section-icon'));
		icon.setAttribute('aria-hidden', 'true');
		const label = DOM.append(container, $('span.session-section-label'));
		const count = DOM.append(container, $('span.session-section-count'));

		// Connection controls sit outside the hover toolbar on purpose: a host
		// that is connecting or unreachable has to say so while the pointer is
		// somewhere else entirely.
		const host = DOM.append(container, $('.session-section-host'));
		const hostSpinner = DOM.append(host, $('span.session-section-host-spinner'));
		hostSpinner.setAttribute('aria-hidden', 'true');
		const hostRetry = DOM.append(host, $('a.session-section-host-action.retry'));
		hostRetry.setAttribute('role', 'button');
		hostRetry.tabIndex = 0;
		const hostForget = DOM.append(host, $('a.session-section-host-action.forget'));
		hostForget.setAttribute('role', 'button');
		hostForget.tabIndex = 0;

		const toolbarContainer = DOM.append(container, $('.session-section-toolbar'));

		const contextKeyService = disposables.add(this.contextKeyService.createScoped(container));
		const scopedInstantiationService = disposables.add(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, contextKeyService])));
		const toolbar = disposables.add(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, SessionSectionToolbarMenuId, {
			menuOptions: { shouldForwardArgs: true },
			actionViewItemProvider: (action, options) => {
				if (action.id !== NEW_SESSION_FOR_WORKSPACE_ACTION_ID || !(action instanceof MenuItemAction)) {
					return undefined;
				}

				actionViewItemDisposables.clear();

				const dropdownActions = getFlatContextMenuActions(this.menuService.getMenuActions(
					Menus.SessionSectionNewSession,
					contextKeyService,
					{ shouldForwardArgs: true },
				));
				if (dropdownActions.length === 0) {
					return undefined;
				}

				const item = scopedInstantiationService.createInstance(
					DropdownWithPrimaryActionViewItem,
					action,
					dropdownAction,
					dropdownActions,
					'',
					{
						hoverDelegate: options.hoverDelegate,
						menuAsChild: false
					},
				);

				actionViewItemDisposables.add(item.onDidChangeDropdownVisibility(visible =>
					container.classList.toggle('dropdown-active', visible)));

				actionViewItemDisposables.add(toDisposable(() =>
					container.classList.remove('dropdown-active')));

				return item;
			},
		}));

		return { container, icon, label, count, host, hostSpinner, hostRetry, hostForget, toolbarContainer, toolbar, chevron, contextKeyService, elementDisposables, disposables };
	}

	renderElement(node: ITreeNode<SessionListItem, FuzzyScore>, _index: number, template: ISessionSectionTemplate): void {
		template.elementDisposables.clear();
		const element = node.element;
		if (!isSessionSection(element)) {
			return;
		}
		renderSessionHeaderToolbar(template, element, this.select);
		this.renderHostControls(element, template);
		this.templatesByElement.set(element, template);
		this.templatesById.set(element.id, template);
		template.container.classList.remove(SESSION_HEADER_DROP_TARGET_CLASS);

		// Leading icon for the "Pinned" section header.
		// Templates are reused across rows, so recompute the icon every render.
		const sectionIcon = element.icon ?? (element.id === 'pinned' ? Codicon.pinned : undefined);
		template.icon.className = sectionIcon ? `session-section-icon ${ThemeIcon.asClassName(sectionIcon)}` : 'session-section-icon';
		template.icon.style.display = sectionIcon ? '' : 'none';

		template.label.textContent = element.label;
		if (this.hideSectionCount) {
			template.count.textContent = '';
			template.count.style.display = 'none';
		} else {
			template.count.textContent = String(element.sessions.length);
			template.count.style.display = '';
		}

		this.updateChevron(template, node.collapsible, node.collapsed);
		template.chevron.classList.toggle('collapsible', node.collapsible);

		// Set context key for section type so toolbar actions can use when clauses
		const sectionType = element.id.startsWith('workspace:') ? 'workspace' : element.id;
		SessionSectionTypeContext.bindTo(template.contextKeyService).set(sectionType);
		const hasGitHubRepository = SessionSectionHasGitHubRepositoryContext.bindTo(template.contextKeyService);
		const hasNonCloudRepository = SessionSectionHasNonCloudRepositoryContext.bindTo(template.contextKeyService);
		template.elementDisposables.add(autorun(reader => {
			let hasGitHub = false;
			let hasNonCloudWorkspace = false;
			for (const session of element.sessions) {
				for (const folder of session.workspace.read(reader)?.folders ?? []) {
					if (folder.gitRepository?.gitHubInfo.read(reader) !== undefined) {
						hasGitHub = true;
					}
					hasNonCloudWorkspace ||= folder.root.scheme !== GITHUB_REMOTE_FILE_SCHEME;
				}
			}
			hasGitHubRepository.set(hasGitHub);
			hasNonCloudRepository.set(hasNonCloudWorkspace);
		}));
	}

	/**
	 * Render the connection controls for a section backed by a single remote
	 * host: a spinner while a connect is in flight, and retry + forget once it
	 * has stopped. A reachable host — and every local section — shows nothing.
	 */
	private renderHostControls(element: ISessionSection, template: ISessionSectionTemplate): void {
		const providerId = element.providerId;
		const update = () => {
			const reachability = sessionHostReachability(this.agentHostFilterService.hosts, providerId);
			const connecting = reachability === SessionHostReachability.Connecting;
			const unreachable = reachability === SessionHostReachability.Unreachable;
			template.host.classList.toggle('visible', connecting || unreachable);
			template.container.classList.toggle('session-section-unreachable', unreachable);
			template.hostSpinner.className = `session-section-host-spinner ${ThemeIcon.asClassName(spinningLoading)}`;
			template.hostSpinner.style.display = connecting ? '' : 'none';
			template.hostRetry.className = `session-section-host-action retry ${ThemeIcon.asClassName(Codicon.refresh)}`;
			template.hostRetry.style.display = unreachable ? '' : 'none';
			template.hostForget.className = `session-section-host-action forget ${ThemeIcon.asClassName(Codicon.close)}`;
			template.hostForget.style.display = unreachable ? '' : 'none';
		};

		if (providerId === undefined) {
			template.host.classList.remove('visible');
			template.container.classList.remove('session-section-unreachable');
			template.hostSpinner.style.display = 'none';
			template.hostRetry.style.display = 'none';
			template.hostForget.style.display = 'none';
			return;
		}

		template.hostSpinner.title = localize('sessionHost.connecting', "Connecting to {0}…", element.label);
		template.hostRetry.title = localize('sessionHost.retry', "Reconnect to {0}", element.label);
		template.hostForget.title = localize('sessionHost.forget', "Remove {0} and its cached sessions", element.label);
		template.hostRetry.setAttribute('aria-label', template.hostRetry.title);
		template.hostForget.setAttribute('aria-label', template.hostForget.title);

		// Stop the click reaching the header, which would collapse the section.
		const activate = (node: HTMLElement, run: () => void) => {
			template.elementDisposables.add(DOM.addDisposableListener(node, DOM.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				run();
			}));
			template.elementDisposables.add(DOM.addDisposableListener(node, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				if (!event.equals(KeyCode.Enter) && !event.equals(KeyCode.Space)) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				run();
			}));
		};
		activate(template.hostRetry, () => this.agentHostFilterService.reconnect(providerId));
		activate(template.hostForget, () => this.agentHostFilterService.forget(providerId));

		template.elementDisposables.add(this.agentHostFilterService.onDidChange(update));
		update();
	}

	/**
	 * Updates the expand/collapse chevron for an already-rendered section. The
	 * tree only re-invokes `renderTwistie` (not `renderElement`) when a section's
	 * collapse state toggles, so the owning list forwards collapse changes here.
	 */
	updateCollapseState(element: ISessionSection, collapsed: boolean): void {
		const template = this.templatesByElement.get(element);
		if (template) {
			this.updateChevron(template, true, collapsed);
		}
	}

	setDropTarget(sectionId: string, active: boolean): void {
		const template = this.templatesById.get(sectionId);
		template?.container.classList.toggle(SESSION_HEADER_DROP_TARGET_CLASS, active);
	}

	private updateChevron(template: ISessionSectionTemplate, collapsible: boolean, collapsed: boolean): void {
		template.chevron.className = 'session-section-chevron';
		if (collapsible) {
			template.chevron.classList.add('collapsible');
			const icon = collapsed ? Codicon.chevronRight : Codicon.chevronDown;
			template.chevron.classList.add(...ThemeIcon.asClassNameArray(icon));
		}
	}

	disposeElement(node: ITreeNode<SessionListItem, FuzzyScore>, _index: number, template: ISessionSectionTemplate): void {
		template.elementDisposables.clear();
		if (isSessionSection(node.element)) {
			this.templatesByElement.delete(node.element);
			this.templatesById.delete(node.element.id);
		}
	}

	disposeTemplate(template: ISessionSectionTemplate): void {
		template.disposables.dispose();
	}
}

//#endregion

//#region Show More Renderer

class SessionShowMoreRenderer implements ITreeRenderer<SessionListItem, FuzzyScore, HTMLElement> {
	static readonly TEMPLATE_ID = 'session-show-more';
	readonly templateId = SessionShowMoreRenderer.TEMPLATE_ID;
	readonly rowClassName = 'session-list-inset-row';

	renderTemplate(container: HTMLElement): HTMLElement {
		container.classList.add('session-show-more');
		return DOM.append(container, $('span.session-show-more-label'));
	}

	renderElement(node: ITreeNode<SessionListItem, FuzzyScore>, _index: number, template: HTMLElement): void {
		const element = node.element;
		if (!isSessionShowMore(element)) {
			return;
		}
		const container = template.parentElement;
		container?.classList.toggle('session-show-more-folders', element.kind === 'folders');
		if (element.mode === 'less') {
			template.textContent = element.kind === 'folders'
				? localize('showLessProjectsCompact', "Show fewer projects")
				: localize('showLessCompact', "Show less");
		} else {
			template.textContent = element.kind === 'folders'
				? localize('showMoreProjectsCompact', "Show more")
				: localize('showMoreCompact', "+{0} more", element.remainingCount);
		}
	}

	disposeTemplate(_template: HTMLElement): void { }
}

//#region Accessibility

interface ISessionsAccessibilityProviderOptions {
	readonly grouping: () => SessionsGrouping;
	readonly isPinned: (session: ISession) => boolean;
	readonly includeQuickChatInAriaLabel?: boolean;
}

class SessionsAccessibilityProvider {
	constructor(
		private readonly options?: ISessionsAccessibilityProviderOptions,
	) { }

	getWidgetAriaLabel(): string {
		return localize('sessionsList', "Sessions");
	}

	getAriaLabel(element: SessionListItem): string | IObservable<string> | null {
		if (isSessionSection(element)) {
			return `${element.label}, ${element.sessions.length}`;
		}
		if (isSessionShowMore(element)) {
			if (element.mode === 'less') {
				return element.kind === 'folders'
					? localize('showLessProjectsAria', "Show fewer projects")
					: localize('showLessAria', "Show fewer sessions");
			}
			return element.kind === 'folders'
				? localize('showMoreProjectsAria', "Show {0} more projects", element.remainingCount)
				: localize('showMoreAria', "Show {0} more sessions", element.remainingCount);
		}
		return derived(this, reader => {
			const title = element.title.read(reader);
			const updated = formatCompactSessionTime(element.updatedAt.read(reader));
			let label = this.options?.includeQuickChatInAriaLabel && element.isQuickChat?.read(reader)
				? localize('sessionItemQuickChatAria', "{0}, chat, updated {1}", title, updated)
				: element.worktreePending?.read(reader)
					? localize('sessionItemWorktreePendingAria', "{0}, creating worktree, updated {1}", title, updated)
					: localize('sessionItemAria', "{0}, updated {1}", title, updated);
			const status = element.status.read(reader);
			const workspace = element.workspace.read(reader);
			const workspaceLabel = workspace ? getWorkspaceBadgeLabel(workspace) : undefined;
			if (
				this.options &&
				status !== SessionStatus.InProgress &&
				status !== SessionStatus.NeedsInput &&
				workspaceLabel &&
				(
					this.options.grouping() !== SessionsGrouping.Workspace ||
					this.options.isPinned(element) ||
					element.isArchived.read(reader)
				)
			) {
				label = localize('sessionItemWorkspaceAria', "{0}, in {1}", label, workspaceLabel);
			}
			return label;
		});
	}
}

//#endregion

//#region Drag and Drop

/**
 * Callbacks the sessions list provides to its drag-and-drop controller so the
 * controller can validate and apply manual reordering without owning the list
 * model itself.
 */
interface ISessionsListDndDelegate {
	/** Whether a session may participate in reordering within its current section. */
	isReorderable(session: ISession): boolean;
	/** Whether a session currently renders in the Pinned section. */
	isSessionPinned(session: ISession): boolean;
	/** Whether the dragged sessions may be reordered relative to the given target. */
	canDropOn(dragged: ISession[], target: ISession): boolean;
	/** Apply the reorder, placing the dragged sessions before/after the target. */
	reorder(dragged: ISession[], target: ISession, position: 'before' | 'after'): void;
	/** Pin the given sessions, optionally placing them before/after a pinned target. */
	pinSessions(sessions: ISession[], target: ISession | undefined, position: 'before' | 'after' | undefined): void;
	/** Highlight only the header that will receive the dragged sessions. */
	setDropTargetHeader(header: ISessionDropTargetHeader | undefined): void;
	/** Reorder a workspace section header before/after another. */
	reorderSection(draggedId: string, targetId: string, position: 'before' | 'after'): void;
}

interface ISessionDropTargetHeader {
	readonly id: string;
}

interface ISessionMembershipDropTarget {
	readonly sessions: ISession[];
	readonly header: ISessionDropTargetHeader;
	readonly target: ISession | undefined;
	readonly position: 'before' | 'after' | undefined;
}

class SessionsListDragAndDrop extends Disposable implements ITreeDragAndDrop<SessionListItem> {

	private readonly _transfer = LocalSelectionTransfer.getInstance<DraggedSessionIdentifier>();

	constructor(private readonly delegate: ISessionsListDndDelegate) {
		super();
	}

	getDragURI(element: SessionListItem): string | null {
		if (isSessionSection(element)) {
			// Only workspace sections are reorderable; Pinned, Done and the date
			// sections stay fixed and are therefore not draggable.
			return element.id.startsWith('workspace:') ? `sessionWorkspace:${element.id}` : null;
		}
		if (isSessionShowMore(element)) {
			return null;
		}
		return element.resource.toString();
	}

	getDragLabel(elements: SessionListItem[]): string | undefined {
		const workspaceSection = elements.find((e): e is ISessionSection => isSessionSection(e) && e.id.startsWith('workspace:'));
		if (workspaceSection) {
			return workspaceSection.label;
		}
		const sessions = this.toSessions(elements);
		if (sessions.length === 0) {
			return undefined;
		}
		if (sessions.length === 1) {
			return sessions[0].title.get();
		}
		return localize('sessions.dragLabel', "{0} sessions", sessions.length);
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const sessions = this.toSessions(data instanceof ElementsDragAndDropData ? data.elements as SessionListItem[] : []);
		if (sessions.length === 0) {
			return;
		}

		const identifiers = sessions.map(s => new DraggedSessionIdentifier(s.sessionId, s.resource));
		this._transfer.setData(identifiers, DraggedSessionIdentifier.prototype);

		if (originalEvent.dataTransfer) {
			// Expose the first dragged session as a typed payload as well so external
			// drop handlers can read it without using the local transfer.
			const payload = JSON.stringify({ sessionId: sessions[0].sessionId, resource: sessions[0].resource.toString() });
			originalEvent.dataTransfer.setData(SessionsDataTransfers.SESSION, payload);
		}
	}

	onDragEnd(): void {
		this._transfer.clearData(DraggedSessionIdentifier.prototype);
		this.delegate.setDropTargetHeader(undefined);
	}

	onDragOver(data: IDragAndDropData, targetElement: SessionListItem | undefined, _targetIndex: number | undefined, targetSector: ListViewTargetSector | undefined): boolean | ITreeDragOverReaction {
		const draggedHeader = this.draggedHeader(data);
		if (draggedHeader) {
			this.delegate.setDropTargetHeader(undefined);
			return this.onHeaderDragOver(draggedHeader, targetElement, targetSector);
		}

		const pinTarget = this.resolvePinTarget(data, targetElement, targetSector);
		if (pinTarget) {
			this.delegate.setDropTargetHeader(pinTarget.header);
			return this.toMembershipDropReaction(pinTarget);
		}

		this.delegate.setDropTargetHeader(undefined);
		const target = this.resolveReorderTarget(data, targetElement);
		if (!target) {
			return false;
		}
		const position = sectorToPosition(targetSector);
		return {
			accept: true,
			effect: {
				type: ListDragOverEffectType.Move,
				position: position === 'after' ? ListDragOverEffectPosition.After : ListDragOverEffectPosition.Before,
			},
		};
	}

	drop(data: IDragAndDropData, targetElement: SessionListItem | undefined, _targetIndex: number | undefined, targetSector: ListViewTargetSector | undefined): void {
		this.delegate.setDropTargetHeader(undefined);
		try {
			const draggedHeader = this.draggedHeader(data);
			if (draggedHeader) {
				if (targetElement) {
					const targetRef = this.headerRefOf(targetElement);
					if (targetRef && targetRef !== draggedHeader) {
						this.delegate.reorderSection(draggedHeader, targetRef, sectorToPosition(targetSector));
					}
				}
				return;
			}

			const pinTarget = this.resolvePinTarget(data, targetElement, targetSector);
			if (pinTarget) {
				this.delegate.pinSessions(pinTarget.sessions, pinTarget.target, pinTarget.position);
				return;
			}

			const target = this.resolveReorderTarget(data, targetElement);
			if (!target) {
				return;
			}
			this.delegate.reorder(this.draggedSessions(data), target, sectorToPosition(targetSector));
		} finally {
			this.delegate.setDropTargetHeader(undefined);
		}
	}

	private onHeaderDragOver(draggedHeader: string, targetElement: SessionListItem | undefined, targetSector: ListViewTargetSector | undefined): boolean | ITreeDragOverReaction {
		if (!targetElement) {
			return false;
		}
		const targetRef = this.headerRefOf(targetElement);
		if (!targetRef || targetRef === draggedHeader) {
			return false;
		}
		const position = sectorToPosition(targetSector);
		return {
			accept: true,
			effect: {
				type: ListDragOverEffectType.Move,
				position: position === 'after' ? ListDragOverEffectPosition.After : ListDragOverEffectPosition.Before,
			},
		};
	}

	private resolvePinTarget(data: IDragAndDropData, targetElement: SessionListItem | undefined, targetSector: ListViewTargetSector | undefined): ISessionMembershipDropTarget | undefined {
		if (!targetElement) {
			return undefined;
		}

		let target: ISession | undefined;
		if (isSessionSection(targetElement)) {
			if (targetElement.id !== 'pinned') {
				return undefined;
			}
		} else if (isSessionItem(targetElement) && this.delegate.isSessionPinned(targetElement)) {
			target = targetElement;
		} else {
			return undefined;
		}

		const dragged = this.draggedSessions(data);
		const hasArchived = dragged.some(session => session.isArchived.get());
		const allPinned = dragged.every(session => this.delegate.isSessionPinned(session));
		if (dragged.length === 0 || hasArchived || allPinned) {
			return undefined;
		}
		if (target && dragged.some(session => session.sessionId === target.sessionId)) {
			return undefined;
		}
		return {
			sessions: dragged,
			header: { id: 'pinned' },
			target,
			position: target ? sectorToPosition(targetSector) : undefined,
		};
	}

	/**
	 * Resolve the session the drop should be positioned against, or `undefined`
	 * if the current drag is not a valid in-list reorder.
	 */
	private resolveReorderTarget(data: IDragAndDropData, targetElement: SessionListItem | undefined): ISession | undefined {
		if (!targetElement || !isSessionItem(targetElement)) {
			return undefined;
		}
		const target = targetElement;
		if (!this.delegate.isReorderable(target)) {
			return undefined;
		}
		const dragged = this.draggedSessions(data);
		if (dragged.length === 0 || dragged.some(s => s.sessionId === target.sessionId)) {
			return undefined;
		}
		if (dragged.some(s => !this.delegate.isReorderable(s))) {
			return undefined;
		}
		if (!this.delegate.canDropOn(dragged, target)) {
			return undefined;
		}
		return target;
	}

	private toMembershipDropReaction(target: ISessionMembershipDropTarget): ITreeDragOverReaction {
		let position = ListDragOverEffectPosition.Over;
		if (target.position === 'after') {
			position = ListDragOverEffectPosition.After;
		} else if (target.position === 'before') {
			position = ListDragOverEffectPosition.Before;
		}
		return {
			accept: true,
			effect: {
				type: ListDragOverEffectType.Move,
				position,
			},
		};
	}

	/** The workspace section header being dragged to reorder, if any. */
	private draggedHeader(data: IDragAndDropData): string | undefined {
		if (!(data instanceof ElementsDragAndDropData)) {
			return undefined;
		}
		const elements = data.elements as SessionListItem[];
		const workspaceSection = elements.find((e): e is ISessionSection => isSessionSection(e) && e.id.startsWith('workspace:'));
		return workspaceSection?.id;
	}

	/** The reorder identity of a top-level header element, or `undefined` when it is not reorderable. */
	private headerRefOf(element: SessionListItem): string | undefined {
		if (isSessionSection(element) && element.id.startsWith('workspace:')) {
			return element.id;
		}
		return undefined;
	}

	private draggedSessions(data: IDragAndDropData): ISession[] {
		return this.toSessions(data instanceof ElementsDragAndDropData ? data.elements as SessionListItem[] : []);
	}

	private toSessions(elements: SessionListItem[]): ISession[] {
		return elements.filter(isSessionItem);
	}
}

function sectorToPosition(sector: ListViewTargetSector | undefined): 'before' | 'after' {
	return sector !== undefined && sector >= ListViewTargetSector.CENTER_BOTTOM ? 'after' : 'before';
}

//#endregion

//#region Sessions List Control

export interface ISessionsListControlOptions {
	readonly overrideStyles?: IStyleOverride<IListStyles>;
	readonly grouping: () => SessionsGrouping;
	readonly sorting: () => SessionsSorting;
	readonly findWidgetContainer?: HTMLElement;
	onSessionOpen(resource: URI, preserveFocus: boolean, sideBySide: boolean): void;

	/**
	 * Gate invoked before a session is opened (before mark-read, activation, and
	 * folder mount). Return `false` to refuse the open — e.g. the session's folder
	 * is not trusted — leaving the current session/empty slot untouched. When
	 * omitted, opens are not gated.
	 */
	canOpenSession?(session: ISession): Promise<boolean>;
}

/**
 * @deprecated Use {@link ISessionsListControlOptions} instead.
 */
export type ISessionsListOptions = ISessionsListControlOptions;

export interface ISessionsList {
	readonly element: HTMLElement;
	readonly onDidUpdate: Event<void>;
	readonly onDidChangeFindOpenState: Event<boolean>;
	refresh(): void;
	reveal(sessionResource: URI): boolean;
	/**
	 * Returns the sessions currently visible in the list, in display order.
	 * Sessions hidden by section capping ("show more") are excluded.
	 */
	getVisibleSessions(): readonly ISession[];
	clearFocus(): void;
	hasFocusOrSelection(): boolean;
	setVisible(visible: boolean): void;
	layout(height: number, width: number): void;
	focus(): void;
	update(expandAll?: boolean): void;
	openFind(): void;
	closeFind(): void;
	resetSectionCollapseState(): void;
	pinSession(session: ISession): void;
	unpinSession(session: ISession): void;
	isSessionPinned(session: ISession): boolean;
	setSessionTypeExcluded(sessionTypeId: string, excluded: boolean): void;
	isSessionTypeExcluded(sessionTypeId: string): boolean;
	setStatusExcluded(status: SessionStatus, excluded: boolean): void;
	isStatusExcluded(status: SessionStatus): boolean;
	setExcludeArchived(exclude: boolean): void;
	isExcludeArchived(): boolean;
	setExcludeRead(exclude: boolean): void;
	isExcludeRead(): boolean;
	resetFilters(): void;
	setWorkspaceGroupCapped(capped: boolean): void;
	isWorkspaceGroupCapped(): boolean;
	setOpenWindowSourceFolder(folder: URI | undefined): void;
	collapseAllSections(): void;
}

export class SessionsList extends Disposable implements ISessionsList {

	private static readonly SECTION_COLLAPSE_STATE_KEY = 'sessionsListControl.sectionCollapseState';
	private static readonly EXCLUDED_TYPES_KEY = 'sessionsListControl.excludedSessionTypes';
	private static readonly EXCLUDED_STATUSES_KEY = 'sessionsListControl.excludedStatuses';
	private static readonly EXCLUDE_ARCHIVED_KEY = 'sessionsListControl.excludeArchived';
	private static readonly EXCLUDE_READ_KEY = 'sessionsListControl.excludeRead';
	private static readonly WORKSPACE_GROUP_CAPPED_KEY = 'sessionsListControl.workspaceGroupCapped';
	private static readonly DEFAULT_SESSION_GROUP_LIMIT = 5;

	/**
	 * Experiment treatment that overrides how many sessions are shown per group
	 * before the "show more" affordance appears.
	 */
	private static readonly SESSION_GROUP_LIMIT_TREATMENT = 'sessions.workspaceGroupLimit';

	private readonly listContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<SessionListItem, FuzzyScore>;
	private sessions: ISession[] = [];
	private visible = true;
	private readonly excludedSessionTypes: Set<string>;
	private readonly excludedStatuses: Set<SessionStatus>;
	private _excludeArchived: boolean;
	private _excludeRead: boolean;
	private workspaceGroupCapped: boolean;

	/**
	 * Maximum number of sessions shown per workspace or agent section.
	 */
	private readonly sessionGroupLimit = observableValue<number>(this, SessionsList.DEFAULT_SESSION_GROUP_LIMIT);
	private readonly expandedSessionGroups = new Set<string>();
	private expandedMoreFolders = false;
	private openWindowSourceFolder: URI | undefined;
	private hasFindPattern = false;
	private suspendCollapseStatePersistence = false;

	private _sectionRenderer!: SessionSectionRenderer;
	private _dropTargetHeader: ISessionDropTargetHeader | undefined;

	/**
	 * Snapshot of the currently-rendered reorderable workspace sections in
	 * display order, by section id. Captured each render and used as the basis
	 * for drag-reorder math.
	 */
	private _topLevelOrder: string[] = [];

	private readonly _onDidUpdate = this._register(new Emitter<void>());
	readonly onDidUpdate: Event<void> = this._onDidUpdate.event;

	private readonly _onDidChangeFindOpenState = this._register(new Emitter<boolean>());
	readonly onDidChangeFindOpenState: Event<boolean> = this._onDidChangeFindOpenState.event;

	get element(): HTMLElement { return this.listContainer; }

	constructor(
		container: HTMLElement,
		private readonly options: ISessionsListControlOptions,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsListModelService private readonly _sessionsListModelService: ISessionsListModelService,
		@ISessionSectionOrderService private readonly _sessionSectionOrderService: ISessionSectionOrderService,
		@IAgentHostFilterService private readonly _agentHostFilterService: IAgentHostFilterService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@IVoicePlaybackService private readonly _listVoicePlaybackService: IVoicePlaybackService,
		@IWorkbenchAssignmentService private readonly assignmentService: IWorkbenchAssignmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Load excluded session types from storage
		this.excludedSessionTypes = this.loadExcludedSessionTypes();

		// Load excluded statuses from storage
		this.excludedStatuses = this.loadExcludedStatuses();

		// Load archived/read filter state
		this._excludeArchived = this.storageService.getBoolean(SessionsList.EXCLUDE_ARCHIVED_KEY, StorageScope.PROFILE, true);
		this._excludeRead = this.storageService.getBoolean(SessionsList.EXCLUDE_READ_KEY, StorageScope.PROFILE, false);
		this.workspaceGroupCapped = this.storageService.getBoolean(SessionsList.WORKSPACE_GROUP_CAPPED_KEY, StorageScope.PROFILE, true);

		this.listContainer = DOM.append(container, $('.sessions-list-control'));
		this._register(DOM.addDisposableListener(this.listContainer, DOM.EventType.POINTER_DOWN, () => {
			this.listContainer.classList.add(SESSION_SECTION_FOCUS_FROM_POINTER_CLASS);
		}));
		this._register(DOM.addDisposableListener(this.listContainer.ownerDocument, DOM.EventType.KEY_DOWN, () => {
			this.listContainer.classList.remove(SESSION_SECTION_FOCUS_FROM_POINTER_CLASS);
		}, true));

		const markdownRendererService = instantiationService.invokeFunction(accessor => accessor.get(IMarkdownRendererService));
		const hoverService = instantiationService.invokeFunction(accessor => accessor.get(IHoverService));
		const sessionsProvidersService = instantiationService.invokeFunction(accessor => accessor.get(ISessionsProvidersService));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatSessionArchiveActionWordingSettingId)) {
				this.update();
			}
		}));
		// TEMPORARY (#320480): see the note on the `IAgentSessionsService` import.
		const agentSessionsService = instantiationService.invokeFunction(accessor => accessor.get(IAgentSessionsService));
		const voicePlaybackService = instantiationService.invokeFunction(accessor => accessor.get(IVoicePlaybackService));
		const sessionRenderer = new SessionItemRenderer(
			{
				grouping: this.options.grouping,
				isPinned: s => this.isSessionPinned(s),
				visibleSessions: this._sessionsService.visibleSessions,
				getMultiSelectedSessions: s => this.getMultiSelectedSessions(s),
				showHover: true,
				useCompactQuickChatRows: true,
				approvalRowMaxLines: DEFAULT_APPROVAL_ROW_MAX_LINES,
				toolbarMenuId: SessionItemToolbarMenuId,
				hostReachability: {
					get: session => sessionHostReachability(this._agentHostFilterService.hosts, session.providerId),
					onDidChange: this._agentHostFilterService.onDidChange,
				},
				onDidRequestRename: session => {
					this.commandService.executeCommand(RENAME_SESSION_COMMAND_ID, session).catch(onUnexpectedError);
				},
			},
			// Keep the primary Fumie session list compact. Pending-approval details
			// already render in the active chat and in the blocked-sessions surface;
			// rendering the command here expands a navigation row into an action card.
			undefined,
			undefined,
			instantiationService,
			contextKeyService,
			markdownRendererService,
			hoverService,
			sessionsProvidersService,
			agentSessionsService,
			voicePlaybackService,
		);

		const showMoreRenderer = new SessionShowMoreRenderer();
		const selectHeader = (element: ISessionSection, event: MouseEvent) => {
			this.tree.setFocus([element], event);
			this.tree.setSelection([element], event);
		};
		const sectionRenderer = new SessionSectionRenderer(true /* hideSectionCount */, selectHeader, instantiationService, contextKeyService, this.menuService, this._agentHostFilterService);
		this._sectionRenderer = sectionRenderer;

		// Read (don't bind) `IsPhoneLayoutContext` from the parent context so we
		// observe the workbench's value rather than shadowing it with a fresh
		// scoped default of `false`. The reactive height refresh below listens
		// on the same scoped service for changes.
		const delegate = new SessionsTreeDelegate(undefined, () => !!IsPhoneLayoutContext.getValue(contextKeyService));

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<SessionListItem, FuzzyScore>,
			'SessionsListTree',
			this.listContainer,
			delegate,
			[
				sessionRenderer,
				sectionRenderer,
				showMoreRenderer,
			],
			{
				accessibilityProvider: new SessionsAccessibilityProvider({
					grouping: this.options.grouping,
					isPinned: session => this.isSessionPinned(session),
				}),
				dnd: this._register(new SessionsListDragAndDrop({
					isReorderable: session => this.isReorderable(session),
					isSessionPinned: session => this.isSessionPinned(session),
					canDropOn: (dragged, target) => this.canReorderOnto(dragged, target),
					reorder: (dragged, target, position) => this.reorderSessions(dragged, target, position),
					pinSessions: (sessions, target, position) => this.pinSessions(sessions, target, position),
					setDropTargetHeader: header => this.setDropTargetHeader(header),
					reorderSection: (draggedId, targetId, position) => this.reorderSection(draggedId, targetId, position),
				})),
				identityProvider: {
					getId: (element: SessionListItem) => {
						if (isSessionSection(element)) {
							return `section:${element.id}`;
						}
						if (isSessionShowMore(element)) {
							return `show-more:${element.kind}:${element.mode}:${element.sectionId}`;
						}
						return element.resource.toString();
					},
					getGroupId: (element: SessionListItem) => {
						if (isSessionSection(element)) {
							return NotSelectableGroupId;
						}
						if (isSessionShowMore(element)) {
							return NotSelectableGroupId;
						}
						// Use a distinct group for archived (done) sessions so that
						// multi-selection cannot span the workspace and done sections.
						return element.isArchived.get() ? 2 : 1;
					}
				},
				horizontalScrolling: false,
				multipleSelectionSupport: true,
				indent: 0,
				findWidgetEnabled: true,
				defaultFindMode: TreeFindMode.Filter,
				findWidgetContainer: this.options.findWidgetContainer,
				findWidgetStyles: {
					...defaultFindWidgetStyles,
					toggleStyles: {
						...defaultToggleStyles,
						inputActiveOptionBorder: 'transparent',
					},
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: SessionListItem) => {
						if (isSessionSection(element)) {
							return element.label;
						}
						if (isSessionShowMore(element)) {
							return element.sectionLabel;
						}
						return element.title.get();
					}
				},
				overrideStyles: this.options.overrideStyles,
				renderIndentGuides: RenderIndentGuides.None,
				twistieAdditionalCssClass: () => 'force-no-twistie',
			}
		));

		this._register(this.tree.onDidOpen(async e => {
			const element = e.element;
			if (!element) {
				return;
			}
			if (isSessionShowMore(element)) {
				if (element.kind === 'folders') {
					this.expandedMoreFolders = element.mode === 'more';
				} else {
					if (element.mode === 'more') {
						this.expandedSessionGroups.add(element.sectionId);
					} else {
						this.expandedSessionGroups.delete(element.sectionId);
					}
				}
				this.update();
				return;
			}
			if (!isSessionSection(element)) {
				// A remote host without a transport can only serve this row from
				// its cache. Opening it would land on an empty editor with no
				// error, so refuse until the host is connected — the section
				// header carries the retry and forget controls.
				if (sessionHostReachability(this._agentHostFilterService.hosts, element.providerId) !== SessionHostReachability.Reachable) {
					return;
				}
				// Gate the open on workspace trust before any side effect (mark-read,
				// activation, folder mount). A refused open leaves the current
				// session (or empty new-session slot) untouched.
				if (this.options.canOpenSession && !(await this.options.canOpenSession(element))) {
					return;
				}
				// A deliberate left mouse click on a session should move keyboard
				// focus into the chat input so the user can start typing right
				// away. A single click always reports `preserveFocus: true`, so
				// detect the mouse click explicitly. Keyboard navigation keeps
				// `preserveFocus` as reported so browsing the list never steals
				// focus from it.
				const isLeftClick = DOM.isMouseEvent(e.browserEvent) && e.browserEvent.button === 0;
				const preserveFocus = isLeftClick ? false : (e.editorOptions.preserveFocus ?? false);
				this.options.onSessionOpen(element.resource, preserveFocus, e.sideBySide);
				// If this session has an unheard voice response, opening it may not
				// change the active-session observable (it can already be the active
				// session, just not focused), so the voice controller would never
				// re-activate it. Ask it to narrate the pending item explicitly.
				if (this._listVoicePlaybackService.hasPendingResponse(element.resource)) {
					this.commandService.executeCommand('_chat.voice.activateSession', element.resource.toString());
				}
			}
		}));

		this._register(sessionRenderer.onDidChangeItemHeight(session => {
			if (this.tree.hasElement(session)) {
				this.tree.updateElementHeight(session, delegate.getHeight(session));
			}
		}));

		// React to phone <-> desktop viewport transitions: refresh heights
		// for all known sessions so the virtual list reserves the correct
		// space for the new layout. Iterates `this.sessions` (all known
		// sessions) — a phone/desktop transition is a rare event so the
		// extra work over filtered-out sessions is negligible. Relies on
		// the `IsPhoneLayoutContext` reactive signal already maintained by
		// the agents workbench.
		const phoneKeys = new Set<string>([IsPhoneLayoutContext.key]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (!e.affectsSome(phoneKeys)) {
				return;
			}
			for (const session of this.sessions) {
				if (this.tree.hasElement(session)) {
					this.tree.updateElementHeight(session, delegate.getHeight(session));
				}
			}
		}));

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e)));

		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element && isSessionSection(element)) {
				sectionRenderer.updateCollapseState(element, e.node.collapsed);
				if (!this.suspendCollapseStatePersistence) {
					this.saveSectionCollapseState(element.id, e.node.collapsed);
				}
			}
		}));

		let isFindOpen = false;
		let findPattern = '';
		const updateFindPatternState = () => {
			const hasFindPattern = isFindOpen && findPattern.length > 0;
			if (hasFindPattern !== this.hasFindPattern) {
				this.hasFindPattern = hasFindPattern;
				this.update();
			}
		};

		this._register(this.tree.onDidChangeFindOpenState(open => {
			isFindOpen = open;
			this._onDidChangeFindOpenState.fire(open);
			updateFindPatternState();
		}));

		// Only treat the find as "active" for layout purposes (bypassing workspace
		// capping and per-group limits) once the user has actually typed a pattern
		// and the find widget is open. Opening the empty find widget should not
		// reorder the list, and closing find should restore the capped layout.
		this._register(this.tree.onDidChangeFindPattern(pattern => {
			findPattern = pattern;
			updateFindPatternState();
		}));

		this._register(this._sessionsManagementService.onDidChangeSessions(e => {
			if (this.visible) {
				this.refresh();
			}
			// A removed session may have been the last one in its workspace.
			// Garbage-collect manual order / promotion entries for identities
			// that no longer exist. This runs only on removals (never on
			// additions or the initial load) so that asynchronous session
			// loading on a window reload can never prune the user's manual
			// ordering of workspaces before their sessions have loaded.
			if (e.removed.length > 0) {
				this._sessionSectionOrderService.retain(this.liveSectionOrderIds());
			}
		}));

		this._register(this._sessionsListModelService.onDidChange(() => {
			if (this.visible) {
				this.update();
			}
		}));

		this._register(this._sessionSectionOrderService.onDidChange(() => {
			if (this.visible) {
				this.update();
			}
		}));

		this._register(this._agentHostFilterService.onDidChange(() => {
			if (this.visible) {
				this.update();
			}
		}));

		// Re-render when the active session changes.
		this._register(autorun(reader => {
			this._sessionsService.activeSession.read(reader);
			if (this.visible) {
				this.update();
			}
		}));

		// Resolve the per-group session limit from the experiment service and
		// keep it current when treatments are refetched. The async fetch is
		// confined to `updateSessionGroupLimit`; the rest of the list reads the
		// resolved value synchronously off `sessionGroupLimit`. The autorun runs
		// immediately for the initial fetch and again whenever treatments refetch.
		const assignmentRefetchSignal = observableSignalFromEvent(this, this.assignmentService.onDidRefetchAssignments);
		this._register(autorun(reader => {
			assignmentRefetchSignal.read(reader);
			this.updateSessionGroupLimit();
		}));

		this.refresh();
	}

	/**
	 * Fetches the session group limit treatment and updates the backing
	 * observable. Invalid or unset treatments fall back to the default limit.
	 */
	private updateSessionGroupLimit(): void {
		this.assignmentService.getTreatment<number>(SessionsList.SESSION_GROUP_LIMIT_TREATMENT).then(value => {
			const limit = typeof value === 'number' && Number.isInteger(value) && value > 0
				? value
				: SessionsList.DEFAULT_SESSION_GROUP_LIMIT;
			if (this.sessionGroupLimit.get() !== limit) {
				this.sessionGroupLimit.set(limit, undefined);
				if (this.visible) {
					this.update();
				}
			}
		});
	}

	refresh(): void {
		this.sessions = this._sessionsManagementService.getSessions();
		for (const session of this.sessions) {
			this._sessionsListModelService.migrateLegacyReadState(session);
		}
		this.update();
	}

	update(expandAll?: boolean): void {
		const activeSession = this._sessionsService.activeSession.get();

		// Filter by session type and status
		let filtered = this.sessions.filter(session => !isAutomationSession(session));
		// Machine scope: `local` is the complement of the remote-agent-host
		// providers — external and other locally registered providers are
		// managed by this machine, and their visibility stays with the
		// session-type filters below.
		const hostScope = this._agentHostFilterService.scope;
		if (hostScope?.kind === 'local') {
			filtered = filtered.filter(s => !s.providerId.startsWith(REMOTE_AGENT_HOST_PROVIDER_PREFIX));
		} else if (hostScope?.kind === 'host') {
			filtered = filtered.filter(s => s.providerId === hostScope.providerId);
		}
		if (this.excludedSessionTypes.size > 0) {
			filtered = filtered.filter(s => !this.excludedSessionTypes.has(s.sessionType));
		}
		if (this.excludedStatuses.size > 0) {
			filtered = filtered.filter(s => !this.excludedStatuses.has(s.status.get()));
		}
		if (this._excludeArchived) {
			filtered = filtered.filter(s => !s.isArchived.get());
		}
		if (this._excludeRead) {
			filtered = filtered.filter(s => !s.isRead.get());
		}

		// Keep the active user-facing session visible even when another filter excludes it.
		if (activeSession && !filtered.some(s => s.sessionId === activeSession.sessionId)) {
			const match = this.sessions.find(s => s.sessionId === activeSession.sessionId && !isAutomationSession(s));
			if (match) {
				filtered = [...filtered, match];
			}
		}

		const grouping = this.options.grouping();
		const sorting = this.options.sorting();

		const sections = groupSessionsForList(filtered, grouping, sorting, session => this.isSessionPinned(session), (s, srt) => this._sessionsListModelService.getSortKey(s, sortingToMode(srt)), getChatSessionArchivedSectionLabel(getChatSessionArchiveActionWording(this.configurationService)));

		const hasRecentDateSessions = sections.some(s => (s.id === 'today' || s.id === 'yesterday' || s.id === 'last7days') && s.sessions.length > 0);

		// Match Codex desktop's project-mode disclosure: rank projects by their
		// most recent thread, surface five initially, and put the remainder behind
		// one Show more row. The open window and explicitly promoted projects stay
		// visible just like Codex's forced-visible/pinned project exceptions.
		// Searching and the explicit uncapped mode still reveal every project.
		const partitionFolders = grouping === SessionsGrouping.Workspace && !this.hasFindPattern && this.workspaceGroupCapped;
		const moreFolderSectionIds = new Set<string>();
		if (partitionFolders) {
			const workspaceSections = sortProjectSectionsByRecency(sections.filter(s => s.id.startsWith('workspace:')));
			if (workspaceSections.length > DEFAULT_VISIBLE_PROJECT_LIMIT) {
				const visibleProjectIds = new Set(workspaceSections.slice(0, DEFAULT_VISIBLE_PROJECT_LIMIT).map(section => section.id));
				for (const section of workspaceSections) {
					const isOpenWindow = !!this.openWindowSourceFolder && section.sessions.some(s => sessionMatchesFolder(s, this.openWindowSourceFolder!));
					const isActive = !!activeSession && section.sessions.some(s => s.sessionId === activeSession.sessionId);
					if (!visibleProjectIds.has(section.id) && !isOpenWindow && !isActive && !this._sessionSectionOrderService.isPromoted(section.id)) {
						moreFolderSectionIds.add(section.id);
					}
				}
			}
		}

		const children: IObjectTreeElement<SessionListItem>[] = [];

		const sessionGroupLimit = this.sessionGroupLimit.get();

		const toSessionChildren = (sessions: readonly ISession[]): IObjectTreeElement<SessionListItem>[] =>
			sessions.map(session => ({ element: session as SessionListItem }));

		const renderSessionChildren = (sessions: readonly ISession[], sectionId: string, sectionLabel: string, enabled: boolean): IObjectTreeElement<SessionListItem>[] => {
			const limited = limitSessionsForList(sessions, sessionGroupLimit, {
				enabled,
				expanded: this.expandedSessionGroups.has(sectionId),
				sectionId,
				sectionLabel,
			});
			const children = toSessionChildren(limited.sessions);
			if (limited.showMore) {
				children.push({ element: limited.showMore });
			}
			return children;
		};

		const renderSection = (section: ISessionSection): IObjectTreeElement<SessionListItem> => {
			const isWorkspaceGroup = grouping === SessionsGrouping.Workspace
				&& section.id.startsWith('workspace:');
			const isAgentGroup = grouping === SessionsGrouping.Agent
				&& section.id.startsWith('agent:');
			const limitSessions = (isWorkspaceGroup || isAgentGroup)
				&& !this.hasFindPattern
				&& this.workspaceGroupCapped;
			const sectionChildren = renderSessionChildren(section.sessions, section.id, section.label, limitSessions);

			// Default collapse state for older time sections
			let defaultCollapsed: boolean | ObjectTreeElementCollapseState = ObjectTreeElementCollapseState.PreserveOrExpanded;
			if (grouping === SessionsGrouping.Date && hasRecentDateSessions) {
				const olderSections = ['older', 'archived'];
				if (olderSections.includes(section.id)) {
					defaultCollapsed = ObjectTreeElementCollapseState.PreserveOrCollapsed;
				}
			}
			if (section.id === 'archived') {
				defaultCollapsed = ObjectTreeElementCollapseState.PreserveOrCollapsed;
			}

			// The "Pinned" section starts collapsed on first open; the user's later
			// choice is persisted and honored via getSavedCollapseState.
			if (section.id === 'pinned') {
				defaultCollapsed = ObjectTreeElementCollapseState.PreserveOrCollapsed;
			}

			return {
				element: section as SessionListItem,
				collapsible: true,
				collapsed: this.getSavedCollapseState(section.id) ?? defaultCollapsed,
				children: sectionChildren,
			};
		};

		const pinnedSection = sections.find(s => s.id === 'pinned');
		if (pinnedSection) {
			children.push(renderSection(pinnedSection));
		}

		if (grouping === SessionsGrouping.Date || grouping === SessionsGrouping.Agent) {
			// Date grouping keeps the Today/Yesterday/... buckets; agent grouping
			// presents the provider-owned buckets in a stable Codex / Claude /
			// Copilot order. Neither is user-reorderable: Pinned stays at the top,
			// Done (archived) stays at the bottom.
			this._topLevelOrder = [];
			for (const section of sections) {
				if (section.id === 'pinned' || section.id === 'archived') {
					continue;
				}
				children.push(renderSection(section));
			}
			const archived = sections.find(s => s.id === 'archived');
			if (archived) {
				children.push(renderSection(archived));
			}
		} else {
			// Project grouping: the initially-visible project sections form one
			// freely-reorderable, user-managed order right below Pinned, defaulting
			// to newest-project-first. Pinned stays first, Done last, and hidden
			// projects are available through the single Show more disclosure row
			// below the ordered block.
			const workspaceSections = sortProjectSectionsByRecency(sections.filter(s => s.id.startsWith('workspace:')));
			const sectionById = new Map(workspaceSections.map(s => [s.id, s] as const));
			const primaryWorkspaceIds = workspaceSections
				.filter(s => !moreFolderSectionIds.has(s.id))
				.map(s => s.id);

			const resolvedIds = this._sessionSectionOrderService.resolveOrder(primaryWorkspaceIds);
			this._topLevelOrder = resolvedIds;
			for (const id of resolvedIds) {
				const section = sectionById.get(id);
				if (section) {
					children.push(renderSection(section));
				}
			}

			const moreFolderSections = workspaceSections.filter(s => moreFolderSectionIds.has(s.id));
			if (moreFolderSections.length > 0) {
				if (this.expandedMoreFolders) {
					for (const section of moreFolderSections) {
						children.push(renderSection(section));
					}
					children.push({
						element: { showMore: true as const, kind: 'folders' as const, mode: 'less' as const, sectionId: SHOW_MORE_FOLDERS_LABEL, sectionLabel: SHOW_MORE_FOLDERS_LABEL, remainingCount: 0 },
					});
				} else {
					children.push({
						element: { showMore: true as const, kind: 'folders' as const, mode: 'more' as const, sectionId: SHOW_MORE_FOLDERS_LABEL, sectionLabel: SHOW_MORE_FOLDERS_LABEL, remainingCount: moreFolderSections.length },
					});
				}
			}

			// The archived section is always the very last entry.
			const archivedSection = sections.find(s => s.id === 'archived');
			if (archivedSection) {
				children.push(renderSection(archivedSection));
			}
		}

		this.tree.setChildren(null, children);
		this._onDidUpdate.fire();
	}

	getVisibleSessions(): readonly ISession[] {
		// Derive the visible session list from the tree model so that index-based
		// navigation matches what the user actually sees: this respects collapsed
		// sections, find-widget filtering, and excludes section / show-more nodes.
		const sessions = new Set<ISession>(this.sessions);
		const visibleSessions: ISession[] = [];

		const collect = (node: ITreeNode<SessionListItem | null, FuzzyScore | undefined>): void => {
			if (!node.visible) {
				return;
			}
			if (node.element && sessions.has(node.element as ISession)) {
				visibleSessions.push(node.element as ISession);
			}
			if (node.collapsed) {
				return;
			}
			for (const child of node.children) {
				collect(child);
			}
		};

		const root = this.tree.getNode();
		for (const child of root.children) {
			collect(child);
		}

		return visibleSessions;
	}

	reveal(sessionResource: URI): boolean {
		const resourceStr = sessionResource.toString();
		for (const session of this.sessions) {
			if (session.resource.toString() === resourceStr) {
				if (this.tree.hasElement(session)) {
					if (this.tree.getRelativeTop(session) === null) {
						this.tree.reveal(session, 0.5);
					}
					this.tree.setFocus([session]);
					this.tree.setSelection([session]);
					return true;
				}
			}
		}
		return false;
	}

	clearFocus(): void {
		this.tree.setFocus([]);
		this.tree.setSelection([]);
	}

	hasFocusOrSelection(): boolean {
		return this.tree.getFocus().length > 0 || this.tree.getSelection().length > 0;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (this.visible) {
			this.refresh();
		}
	}

	layout(height: number, width: number): void {
		this.tree.layout(height, width);
	}

	focus(): void {
		this.tree.domFocus();

		if (this.tree.getFocus().length === 0) {
			this.tree.focusFirst();
		}
	}

	openFind(): void {
		this.tree.openFind();
	}

	closeFind(): void {
		this.tree.closeFind();
	}

	// Context menu

	/**
	 * Whether a session may participate in manual reordering. Archived (Done)
	 * sessions keep their fixed section.
	 */
	private isReorderable(session: ISession): boolean {
		return !session.isArchived.get();
	}

	/**
	 * Whether the dragged sessions can be reordered relative to the target.
	 * Reordering stays within the same scope: dragged sessions must share the
	 * target's automatic grouping bucket.
	 */
	private canReorderOnto(dragged: ISession[], target: ISession): boolean {
		const targetPinned = this.isSessionPinned(target);
		if (dragged.some(s => this.isSessionPinned(s) !== targetPinned)) {
			return false;
		}
		if (targetPinned) {
			return true;
		}

		if (this.options.grouping() === SessionsGrouping.Workspace) {
			const targetLabel = sessionWorkspaceLabel(target);
			return dragged.every(s => sessionWorkspaceLabel(s) === targetLabel);
		}
		if (this.options.grouping() === SessionsGrouping.Agent) {
			const targetAgent = sessionAgentGroupInfo(target).key;
			return dragged.every(s => sessionAgentGroupInfo(s).key === targetAgent);
		}
		return true;
	}

	/**
	 * Reorder the dragged sessions so they land as a contiguous block before or
	 * after the target session, persisting a synthetic sort key (the midpoint of
	 * the surrounding sessions' keys). When the dragged sessions' natural
	 * timestamps already sort them into the dropped slot, any stored override is
	 * dropped instead so the list falls back to natural ordering.
	 */
	private reorderSessions(dragged: ISession[], target: ISession, position: 'before' | 'after'): void {
		const mode = sortingToMode(this.options.sorting());
		const grouping = this.options.grouping();
		const getKey = (s: ISession) => this._sessionsListModelService.getSortKey(s, mode);

		// Derive neighbours from the actual visible display order (which already
		// respects filtering and grouping) so the drop slot matches what the user
		// sees.
		const targetPinned = this.isSessionPinned(target);
		let scope = this.getVisibleSessions().filter(s => this.isReorderable(s));
		scope = scope.filter(s => this.isSessionPinned(s) === targetPinned);
		if (!targetPinned) {
			if (grouping === SessionsGrouping.Workspace) {
				const targetLabel = sessionWorkspaceLabel(target);
				scope = scope.filter(s => sessionWorkspaceLabel(s) === targetLabel);
			}
			if (grouping === SessionsGrouping.Agent) {
				const targetAgent = sessionAgentGroupInfo(target).key;
				scope = scope.filter(s => sessionAgentGroupInfo(s).key === targetAgent);
			}
		}

		const draggedIds = new Set(dragged.map(s => s.sessionId));
		const draggedOrdered = scope.filter(s => draggedIds.has(s.sessionId));
		if (draggedOrdered.length === 0) {
			return;
		}
		const remaining = scope.filter(s => !draggedIds.has(s.sessionId));

		const targetIndex = remaining.findIndex(s => s.sessionId === target.sessionId);
		if (targetIndex === -1) {
			return;
		}

		const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
		const above = remaining[insertIndex - 1];
		const below = remaining[insertIndex];

		const { set, clear } = computeReorderSortChanges({
			draggedIds: draggedOrdered.map(s => s.sessionId),
			naturalKeys: draggedOrdered.map(s => this._sessionsListModelService.getNaturalSortKey(s, mode)),
			aboveKey: above ? getKey(above) : undefined,
			belowKey: below ? getKey(below) : undefined,
			now: Date.now(),
			fallbackStep: SORT_FALLBACK_STEP_MS,
		});
		this._sessionsListModelService.applySortChanges(mode, set, clear);
	}

	/**
	 * Reorder a workspace section header so it lands before/after the target
	 * header. The new order is persisted to the section-order service, and the
	 * dragged workspace is promoted so it stays visible (escapes the "+N more
	 * workspaces" capping).
	 */
	private reorderSection(draggedId: string, targetId: string, position: 'before' | 'after'): void {
		this._sessionSectionOrderService.reorder(this._topLevelOrder, draggedId, targetId, position, draggedId);
	}

	/**
	 * The set of workspace section identities that currently exist (every
	 * workspace label present across all sessions, regardless of grouping mode or
	 * capping). Used to garbage-collect stale manual order and promotion entries.
	 * Reads sessions fresh from the management service so it reflects the latest
	 * loaded state even when the list is not visible.
	 */
	private liveSectionOrderIds(): Set<string> {
		const ids = new Set<string>();
		for (const session of this._sessionsManagementService.getSessions()) {
			ids.add(`workspace:${sessionWorkspaceLabel(session)}`);
		}
		return ids;
	}

	private setDropTargetHeader(header: ISessionDropTargetHeader | undefined): void {
		const current = this._dropTargetHeader;
		if (current?.id === header?.id) {
			this.toggleDropTargetHeader(header, header !== undefined);
			return;
		}
		this.toggleDropTargetHeader(current, false);
		this._dropTargetHeader = header;
		this.toggleDropTargetHeader(header, true);
	}

	private toggleDropTargetHeader(header: ISessionDropTargetHeader | undefined, active: boolean): void {
		if (!header) {
			return;
		}
		this._sectionRenderer.setDropTarget(header.id, active);
	}

	private getMultiSelectedSessions(session: ISession): ISession[] {
		const selection = this.tree.getSelection().filter((s): s is ISession => !!s && isSessionItem(s));
		return selection.includes(session) ? [session, ...selection.filter(s => s !== session)] : [session];
	}

	private onContextMenu(e: ITreeContextMenuEvent<SessionListItem | null>): void {
		const element = e.element;
		if (!element || isSessionSection(element) || isSessionShowMore(element)) {
			return;
		}

		const selectedSessions = this.getMultiSelectedSessions(element);

		const contextOverlay: [string, boolean | string][] = [
			[IsSessionPinnedContext.key, this.isSessionPinned(element)],
			[SessionIsArchivedContext.key, element.isArchived.get()],
			[SessionIsReadContext.key, element.isRead.get()],
			[SessionItemHasBranchNameContext.key, !!element.workspace.get()?.folders[0]?.gitRepository?.branchName?.trim()],
			[SessionTypeContext.key, element.sessionType],
			[SessionProviderIdContext.key, element.providerId],
			[SessionSupportsRenameContext.key, element.capabilities.get().supportsRename ?? false],
			[SessionSupportsDeleteContext.key, element.capabilities.get().supportsDelete ?? false],
			[SessionHasPullRequestContext.key, !!element.workspace.get()?.folders[0]?.gitRepository?.gitHubInfo.get()?.pullRequest],
		];

		const disposables = new DisposableStore();
		const menu = disposables.add(this.menuService.createMenu(SessionItemContextMenuId, this.contextKeyService.createOverlay(contextOverlay)));

		// Extension contributions on this menu need a marshalled AgentSessionContext arg; built-in actions take ISession[].
		const marshalledArg = {
			$mid: MarshalledId.AgentSessionContext,
			session: { resource: element.resource },
			sessions: selectedSessions.map(s => ({ resource: s.resource })),
		};
		const wrapForExtensions = (action: IAction): IAction => {
			if (!(action instanceof MenuItemAction) || !action.item.source) {
				return action;
			}
			return toAction({
				id: action.id,
				label: action.label,
				class: action.class,
				enabled: action.enabled,
				tooltip: action.tooltip,
				checked: action.checked,
				run: () => this.commandService.executeCommand(action.id, marshalledArg),
			});
		};

		const actions = Separator.join(...menu.getActions({ arg: selectedSessions, shouldForwardArgs: true }).map(([, actions]) => actions.map(wrapForExtensions)));
		if (actions.length === 0) {
			disposables.dispose();
			return;
		}

		this.contextMenuService.showContextMenu({
			getActions: () => actions,
			getAnchor: () => e.anchor,
			getKeyBinding: (action) => this.keybindingService.lookupKeybinding(action.id) ?? undefined,
			onHide: () => disposables.dispose(),
		});
	}

	resetSectionCollapseState(): void {
		this.storageService.remove(SessionsList.SECTION_COLLAPSE_STATE_KEY, StorageScope.PROFILE);
	}

	// -- Pinning --

	pinSession(session: ISession): void {
		this._sessionsListModelService.pinSession(session);
	}

	private pinSessions(sessions: ISession[], target?: ISession, position?: 'before' | 'after'): void {
		const pinnable = sessions.filter(session => !session.isArchived.get());
		for (const session of pinnable) {
			this._sessionsListModelService.pinSession(session);
		}
		if (target && position) {
			this.reorderSessions(pinnable, target, position);
		}
	}

	unpinSession(session: ISession): void {
		this._sessionsListModelService.unpinSession(session);
	}

	isSessionPinned(session: ISession): boolean {
		return this._sessionsListModelService.isSessionPinned(session);
	}

	// -- Read/Unread --

	markRead(session: ISession): void {
		this._sessionsManagementService.markRead(session);
	}

	markUnread(session: ISession): void {
		this._sessionsManagementService.markUnread(session);
	}

	// -- Session type filtering --

	setSessionTypeExcluded(sessionTypeId: string, excluded: boolean): void {
		if (excluded) {
			this.excludedSessionTypes.add(sessionTypeId);
		} else {
			this.excludedSessionTypes.delete(sessionTypeId);
		}
		this.saveExcludedSessionTypes();
		this.update();
	}

	isSessionTypeExcluded(sessionTypeId: string): boolean {
		return this.excludedSessionTypes.has(sessionTypeId);
	}

	private loadExcludedSessionTypes(): Set<string> {
		const raw = this.storageService.get(SessionsList.EXCLUDED_TYPES_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					return new Set(arr);
				}
			} catch {
				// ignore corrupt data
			}
		}
		return new Set();
	}

	private saveExcludedSessionTypes(): void {
		if (this.excludedSessionTypes.size === 0) {
			this.storageService.remove(SessionsList.EXCLUDED_TYPES_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(SessionsList.EXCLUDED_TYPES_KEY, JSON.stringify([...this.excludedSessionTypes]), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	// -- Status filtering --

	setStatusExcluded(status: SessionStatus, excluded: boolean): void {
		if (excluded) {
			this.excludedStatuses.add(status);
		} else {
			this.excludedStatuses.delete(status);
		}
		this.saveExcludedStatuses();
		this.update();
	}

	isStatusExcluded(status: SessionStatus): boolean {
		return this.excludedStatuses.has(status);
	}

	private loadExcludedStatuses(): Set<SessionStatus> {
		const raw = this.storageService.get(SessionsList.EXCLUDED_STATUSES_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					return new Set(arr);
				}
			} catch {
				// ignore corrupt data
			}
		}
		return new Set();
	}

	private saveExcludedStatuses(): void {
		if (this.excludedStatuses.size === 0) {
			this.storageService.remove(SessionsList.EXCLUDED_STATUSES_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(SessionsList.EXCLUDED_STATUSES_KEY, JSON.stringify([...this.excludedStatuses]), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	// -- Archived / Read filtering --

	setExcludeArchived(exclude: boolean): void {
		this._excludeArchived = exclude;
		this.storageService.store(SessionsList.EXCLUDE_ARCHIVED_KEY, exclude, StorageScope.PROFILE, StorageTarget.USER);
		this.update();
	}

	isExcludeArchived(): boolean {
		return this._excludeArchived;
	}

	setExcludeRead(exclude: boolean): void {
		this._excludeRead = exclude;
		this.storageService.store(SessionsList.EXCLUDE_READ_KEY, exclude, StorageScope.PROFILE, StorageTarget.USER);
		this.update();
	}

	isExcludeRead(): boolean {
		return this._excludeRead;
	}

	resetFilters(): void {
		this.excludedSessionTypes.clear();
		this.saveExcludedSessionTypes();
		this.excludedStatuses.clear();
		this.saveExcludedStatuses();
		this._excludeArchived = true;
		this.storageService.store(SessionsList.EXCLUDE_ARCHIVED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		this._excludeRead = false;
		this.storageService.store(SessionsList.EXCLUDE_READ_KEY, false, StorageScope.PROFILE, StorageTarget.USER);
		this.workspaceGroupCapped = true;
		this.storageService.store(SessionsList.WORKSPACE_GROUP_CAPPED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		this.expandedSessionGroups.clear();
		this.expandedMoreFolders = false;
		this.update();
	}

	// Session group capping

	setWorkspaceGroupCapped(capped: boolean): void {
		this.workspaceGroupCapped = capped;
		this.storageService.store(SessionsList.WORKSPACE_GROUP_CAPPED_KEY, capped, StorageScope.PROFILE, StorageTarget.USER);
		if (capped) {
			this.expandedSessionGroups.clear();
		}
		this.update();
	}

	isWorkspaceGroupCapped(): boolean {
		return this.workspaceGroupCapped;
	}

	setOpenWindowSourceFolder(folder: URI | undefined): void {
		const before = this.openWindowSourceFolder?.toString();
		const after = folder?.toString();
		if (before === after) {
			return;
		}
		this.openWindowSourceFolder = folder;
		this.update();
	}

	collapseAllSections(): void {
		this.suspendCollapseStatePersistence = true;
		try {
			this.tree.collapseAll();
		} finally {
			this.suspendCollapseStatePersistence = false;
		}
		this.saveBulkCollapseState(true);
	}

	// -- Section collapse persistence --

	private getSavedCollapseState(sectionId: string): boolean | undefined {
		const raw = this.storageService.get(SessionsList.SECTION_COLLAPSE_STATE_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const state: Record<string, boolean> = JSON.parse(raw);
				if (typeof state[sectionId] === 'boolean') {
					return state[sectionId];
				}
			} catch {
				// ignore corrupt data
			}
		}
		return undefined;
	}

	private saveSectionCollapseState(sectionId: string, collapsed: boolean): void {
		let state: Record<string, boolean> = {};
		const raw = this.storageService.get(SessionsList.SECTION_COLLAPSE_STATE_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					state = parsed;
				}
			} catch {
				// ignore corrupt data
			}
		}
		state[sectionId] = collapsed;
		this.storageService.store(SessionsList.SECTION_COLLAPSE_STATE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
	}

	private saveBulkCollapseState(collapsed: boolean): void {
		const state: Record<string, boolean> = {};
		for (const child of this.tree.getNode(null).children) {
			if (child.element && isSessionSection(child.element)) {
				state[child.element.id] = collapsed;
			}
		}
		this.storageService.store(SessionsList.SECTION_COLLAPSE_STATE_KEY, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.USER);
	}

}

//#endregion

//#region Approval Helpers

export function getFirstApprovalAcrossChats(approvalModel: AgentSessionApprovalModel, session: ISession, reader: IReader | undefined,): IAgentSessionApprovalInfo | undefined {
	let oldest: IAgentSessionApprovalInfo | undefined;
	for (const chat of session.chats.read(reader)) {
		const approval = approvalModel.getApproval(chat.resource).read(reader);
		if (approval && (!oldest || approval.since.getTime() < oldest.since.getTime())) {
			oldest = approval;
		}
	}
	return oldest;
}

//#endregion

//#region Folder Matching

function sessionMatchesFolder(session: ISession, folder: URI): boolean {
	const workspace = session.workspace.get();
	if (!workspace) {
		return false;
	}
	const folderStr = folder.toString();
	for (const folder of workspace.folders) {
		if (folder.workingDirectory?.toString() === folderStr || folder.root.toString() === folderStr) {
			return true;
		}
	}
	return false;
}

//#endregion

//#region Sorting & Grouping Helpers

export function sortSessions(sessions: ISession[], sorting: SessionsSorting, getSortKey?: (session: ISession, sorting: SessionsSorting) => number): ISession[] {
	const key = getSortKey ?? defaultSortKey;
	return [...sessions].sort((a, b) => key(b, sorting) - key(a, sorting));
}

export interface ISessionLimitResult {
	readonly sessions: readonly ISession[];
	readonly showMore: ISessionShowMore | undefined;
}

export function limitSessionsForList(
	sessions: readonly ISession[],
	limit: number,
	options: { readonly enabled: boolean; readonly expanded: boolean; readonly sectionId: string; readonly sectionLabel: string },
): ISessionLimitResult {
	if (!options.enabled || sessions.length <= limit) {
		return { sessions, showMore: undefined };
	}

	if (options.expanded) {
		return {
			sessions,
			showMore: {
				showMore: true,
				kind: 'sessions',
				mode: 'less',
				sectionId: options.sectionId,
				sectionLabel: options.sectionLabel,
				remainingCount: 0,
			},
		};
	}

	return {
		sessions: sessions.slice(0, limit),
		showMore: {
			showMore: true,
			kind: 'sessions',
			mode: 'more',
			sectionId: options.sectionId,
			sectionLabel: options.sectionLabel,
			remainingCount: sessions.length - limit,
		},
	};
}

function defaultSortKey(session: ISession, sorting: SessionsSorting): number {
	if (sorting === SessionsSorting.Updated) {
		return session.updatedAt.get().getTime();
	}
	return session.createdAt.getTime();
}

export interface IReorderSortInput {
	/** Dragged session ids in display (descending-key) order. */
	readonly draggedIds: readonly string[];
	/** Natural sort key per dragged session (same order as {@link draggedIds}). */
	readonly naturalKeys: readonly number[];
	/** Effective key of the neighbour above the drop point (higher), if any. */
	readonly aboveKey: number | undefined;
	/** Effective key of the neighbour below the drop point (lower), if any. */
	readonly belowKey: number | undefined;
	/** Current time, used when dropping above the first session. */
	readonly now: number;
	/** Spacing used when stepping past an open boundary. */
	readonly fallbackStep: number;
}

/**
 * Compute the manual sort-override changes for a reorder drop. Assigns the
 * dragged block strictly-descending synthetic keys spread between the
 * surrounding neighbours, except when the sessions' natural keys already sort
 * them into the dropped slot — in which case any existing override is dropped.
 */
export function computeReorderSortChanges(input: IReorderSortInput): { set: Map<string, number>; clear: string[] } {
	const { draggedIds, naturalKeys, aboveKey, belowKey, now, fallbackStep } = input;
	const count = draggedIds.length;

	// "Drop the fake value": when every dragged session's natural key already
	// lands strictly inside the surrounding gap (and in descending display
	// order), clear overrides instead of storing synthetic keys.
	const upperFit = aboveKey ?? Number.POSITIVE_INFINITY;
	const lowerFit = belowKey ?? Number.NEGATIVE_INFINITY;
	let naturalFits = true;
	for (let i = 0; i < count; i++) {
		if (!(naturalKeys[i] < upperFit && naturalKeys[i] > lowerFit)) {
			naturalFits = false;
			break;
		}
		if (i > 0 && !(naturalKeys[i] < naturalKeys[i - 1])) {
			naturalFits = false;
			break;
		}
	}

	const set = new Map<string, number>();
	const clear: string[] = [];
	if (naturalFits) {
		for (const id of draggedIds) {
			clear.push(id);
		}
	} else {
		// Spread `count` strictly-descending synthetic keys across the gap. An
		// open top boundary uses the current time so the block sorts to the very
		// top; an open bottom boundary steps below the last key.
		const upper = aboveKey ?? now;
		const lower = belowKey ?? (upper - (count + 1) * fallbackStep);
		const step = (upper - lower) / (count + 1);
		for (let i = 0; i < count; i++) {
			set.set(draggedIds[i], upper - (i + 1) * step);
		}
	}
	return { set, clear };
}

/**
 * Whether a session is a workspace-less "quick chat", per the session's own
 * {@link ISession.isQuickChat} flag (absent means `false`).
 */
export function isQuickChatSession(session: ISession): boolean {
	return session.isQuickChat?.get() ?? false;
}

/** Whether a session is associated with an automation run. */
export function isAutomationSession(session: ISession): boolean {
	return session.isAutomation?.get() ?? false;
}

export function groupSessionsForList(
	sessions: ISession[],
	grouping: SessionsGrouping,
	sorting: SessionsSorting,
	isSessionPinned: (session: ISession) => boolean,
	getSortKey?: (session: ISession, sorting: SessionsSorting) => number,
	archivedSectionLabel: string = getChatSessionArchivedSectionLabel(ChatSessionArchiveActionWording.MarkAsDone),
): ISessionSection[] {
	const sorted = sortSessions(sessions.filter(session => !isAutomationSession(session)), sorting, getSortKey);

	// Archived wins over pinned (done sessions stay grouped). Quick chats are
	// ordinary rows in the current grouping — there is no dedicated Chats section.
	const pinned: ISession[] = [];
	const archived: ISession[] = [];
	const regular: ISession[] = [];
	for (const session of sorted) {
		if (session.isArchived.get()) {
			archived.push(session);
		} else if (isSessionPinned(session)) {
			pinned.push(session);
		} else {
			regular.push(session);
		}
	}

	const sections: ISessionSection[] = [];
	if (pinned.length > 0) {
		sections.push({ id: 'pinned', label: localize('pinned', "Pinned"), sessions: pinned });
	}

	switch (grouping) {
		case SessionsGrouping.Workspace:
			sections.push(...groupByWorkspace(regular).map(withSectionProviderId));
			break;
		case SessionsGrouping.Agent:
			sections.push(...groupByAgent(regular));
			break;
		case SessionsGrouping.Date:
			sections.push(...groupByDate(regular));
			break;
	}

	if (archived.length > 0) {
		sections.push({ id: 'archived', label: archivedSectionLabel, sessions: archived });
	}

	return sections;
}

/**
 * Tag a section with the provider its sessions all come from, so a section
 * backed by one remote host can show that host's connection controls. Only a
 * workspace section may be tagged: a date, agent, Pinned or Archived bucket
 * names a time or a state, never a machine, so "Reconnect to Today" is never a
 * sentence we want to say — and one session in a bucket is enough to make the
 * all-same-provider test pass by accident.
 */
function withSectionProviderId(section: ISessionSection): ISessionSection {
	let providerId: string | undefined;
	for (const session of section.sessions) {
		if (providerId === undefined) {
			providerId = session.providerId;
		} else if (providerId !== session.providerId) {
			return section;
		}
	}
	return providerId === undefined ? section : { ...section, providerId };
}

/** The workspace group label a session belongs to (matches {@link groupByWorkspace}). */
function sessionWorkspaceLabel(session: ISession): string {
	return session.workspace.get()?.label || localize('unknown', "Unknown");
}

export function groupByWorkspace(sessions: ISession[]): ISessionSection[] {
	const groups = new Map<string, ISession[]>();
	for (const session of sessions) {
		const label = sessionWorkspaceLabel(session);
		let group = groups.get(label);
		if (!group) {
			group = [];
			groups.set(label, group);
		}
		group.push(session);
	}

	const unknownWorkspaceLabel = localize('unknown', "Unknown");
	const order = [...groups.keys()]
		.filter(k => k !== unknownWorkspaceLabel)
		.sort((a, b) => a.localeCompare(b));

	const result: ISessionSection[] = order.map(label => ({
		id: `workspace:${label}`,
		label,
		sessions: groups.get(label)!,
	}));

	// "Unknown Workspace" always at the bottom
	const unknownWorkspace = groups.get(unknownWorkspaceLabel);
	if (unknownWorkspace) {
		result.push({ id: `workspace:${unknownWorkspaceLabel}`, label: unknownWorkspaceLabel, sessions: unknownWorkspace });
	}

	return result;
}

/**
 * Codex orders project groups by the recency of their newest thread before
 * applying its five-project initial disclosure limit. Preserve input order as
 * the stable tie-breaker so manual/project metadata order does not flicker.
 */
export function sortProjectSectionsByRecency(sections: readonly ISessionSection[]): ISessionSection[] {
	return sections
		.map((section, index) => ({
			section,
			index,
			latest: section.sessions.reduce((latest, session) => Math.max(latest, session.updatedAt.get().getTime()), 0),
		}))
		.sort((a, b) => b.latest - a.latest || a.index - b.index)
		.map(({ section }) => section);
}

interface ISessionAgentGroupInfo {
	readonly key: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly order: number;
}

/** Resolve the user-facing Agent bucket from the session's real session type. */
function sessionAgentGroupInfo(session: ISession): ISessionAgentGroupInfo {
	const type = session.sessionType.toLowerCase();
	if (type.includes('codex') || type.includes('openai')) {
		return { key: 'codex', label: 'Codex', icon: session.icon, order: 0 };
	}
	if (type.includes('claude')) {
		return { key: 'claude', label: 'Claude', icon: session.icon, order: 1 };
	}
	if (type.includes('copilot')) {
		return { key: 'copilot', label: 'Copilot', icon: session.icon, order: 2 };
	}
	return { key: type || session.providerId, label: session.sessionType || session.providerId, icon: session.icon, order: 3 };
}

/** Group sessions by the Agent that owns them (Codex, Claude, Copilot, ...). */
export function groupByAgent(sessions: ISession[]): ISessionSection[] {
	const groups = new Map<string, { info: ISessionAgentGroupInfo; sessions: ISession[] }>();
	for (const session of sessions) {
		const info = sessionAgentGroupInfo(session);
		let group = groups.get(info.key);
		if (!group) {
			group = { info, sessions: [] };
			groups.set(info.key, group);
		}
		group.sessions.push(session);
	}

	return [...groups.values()]
		.sort((a, b) => a.info.order - b.info.order || a.info.label.localeCompare(b.info.label))
		.map(({ info, sessions }) => ({
			id: `agent:${info.key}`,
			label: info.label,
			icon: info.icon,
			sessions,
		}));
}

/**
 * Buckets rows by last-updated time — the same timestamp the row's compact
 * label shows — so a row reading `4m` never sits under "Yesterday". The sort
 * mode still decides the order within a bucket; it does not decide the bucket.
 */
export function groupByDate(sessions: ISession[]): ISessionSection[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
	const startOfLast7Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();

	const today: ISession[] = [];
	const yesterday: ISession[] = [];
	const last7Days: ISession[] = [];
	const older: ISession[] = [];

	// Calendar buckets: Today, Yesterday, the rest of the last 7 local days,
	// then Older. Empty buckets are omitted; there is no per-bucket cap.
	for (const session of sessions) {
		const time = session.updatedAt.get().getTime();

		if (time >= startOfToday) {
			today.push(session);
		} else if (time >= startOfYesterday) {
			yesterday.push(session);
		} else if (time >= startOfLast7Days) {
			last7Days.push(session);
		} else {
			older.push(session);
		}
	}

	const sections: ISessionSection[] = [];
	const addGroup = (id: string, label: string, groupSessions: ISession[]) => {
		if (groupSessions.length > 0) {
			sections.push({ id, label, sessions: groupSessions });
		}
	};

	addGroup('today', localize('today', "Today"), today);
	addGroup('yesterday', localize('yesterday', "Yesterday"), yesterday);
	addGroup('last7days', localize('last7days', "Last 7 days"), last7Days);
	addGroup('older', localize('older', "Older"), older);

	return sections;
}

//#endregion

//#region Flat List

export interface ISessionsFlatListOptions {
	readonly overrideStyles?: IStyleOverride<IListStyles>;
	readonly showSessionHover?: boolean;
	/** Called when a session row is opened (clicked / activated). */
	onSessionOpen(resource: URI, preserveFocus: boolean, sideBySide: boolean): void;
	/**
	 * Approval model tracking pending tool confirmations for the shown sessions.
	 * When omitted the list creates and owns its own; injectable so tests and
	 * fixtures can supply pending approvals without a live chat session.
	 */
	readonly approvalModel?: AgentSessionApprovalModel;
	/**
	 * Supplies the per-session "Fix CI" row for sessions whose pull request has
	 * failing CI checks. Only the blocked-sessions dropdown passes one, so the row
	 * never appears in other lists. When omitted no fix-CI rows are rendered.
	 */
	readonly ciFixModel?: ISessionCIFixModel;
	/**
	 * Maximum number of terminal-command lines shown in a session's approval
	 * prompt. Defaults to the same limit as the main sessions list; the
	 * blocked-sessions dropdown passes a larger value.
	 */
	readonly approvalRowMaxLines?: number;
	/**
	 * Menu used by each session row's inline toolbar. Defaults to the main sessions
	 * item toolbar menu.
	 */
	readonly toolbarMenuId?: MenuId;
	/** Allows focused list surfaces to handle actions from their custom toolbar menu. */
	readonly onToolbarAction?: (action: IAction, session: ISession) => boolean | Promise<boolean>;
	/**
	 * When `false` wheel events bubble to the parent scroller instead of being
	 * consumed by the embedded tree. Defaults to `true` (standard list behavior).
	 */
	readonly alwaysConsumeMouseWheel?: boolean;
	/**
	 * Whether quick chats use the compact single-line presentation. Defaults to
	 * `true`; consumers showing homogeneous history entries can opt into regular rows.
	 */
	readonly useCompactQuickChatRows?: boolean;
}

/**
 * A lightweight, flat sessions list that renders session rows exactly like the
 * main {@link SessionsList} but without any sections, groups or workspace
 * headers. Only the sessions passed to {@link setSessions} are shown. Used by
 * surfaces that need a focused, sectionless view of a specific set of sessions
 * (e.g. the titlebar "N blocked" hover).
 */
export class SessionsFlatList extends Disposable {

	// Keep this in sync with the regular (non-phone) SessionsTreeDelegate row.
	// Fumie's session shell uses the compact 32px row as its standard height.
	private static readonly ROW_HEIGHT = 32;

	private readonly _onDidChangeContentHeight = this._register(new Emitter<void>());
	readonly onDidChangeContentHeight = this._onDidChangeContentHeight.event;
	private readonly _onDidApproveSession = this._register(new Emitter<IApprovedSession>());
	/** Fires when a session's pending action is approved from its "Allow" button. */
	readonly onDidApproveSession: Event<IApprovedSession> = this._onDidApproveSession.event;
	private readonly tree: WorkbenchObjectTree<SessionListItem, FuzzyScore>;
	private readonly _delegate: SessionsTreeDelegate;
	private _sessions: readonly ISession[] = [];

	constructor(
		container: HTMLElement,
		private readonly options: ISessionsFlatListOptions,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsListModelService private readonly _sessionsListModelService: ISessionsListModelService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMarkdownRendererService markdownRendererService: IMarkdownRendererService,
		@IHoverService hoverService: IHoverService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IVoicePlaybackService voicePlaybackService: IVoicePlaybackService,
	) {
		super();

		// Wrap in `.sessions-list-control` so the row styles scoped to that class
		// (needs-input/pinned row highlights) apply exactly like the main list.
		const listRoot = DOM.append(container, $('.sessions-list-control'));
		const approvalModel = this.options.approvalModel ?? this._register(instantiationService.createInstance(AgentSessionApprovalModel));

		// TEMPORARY (#320480): the row renderer reaches into a Copilot-provider
		// internal to lazily resolve expensive session properties. Resolved via
		// the instantiation service so this file's single suppressed import stays
		// the only reference. See the note on the `IAgentSessionsService` import.
		const agentSessionsService = instantiationService.invokeFunction(accessor => accessor.get(IAgentSessionsService));
		const useCompactQuickChatRows = this.options.useCompactQuickChatRows ?? true;

		const sessionRenderer = new SessionItemRenderer(
			{
				grouping: () => SessionsGrouping.Date,
				isPinned: s => this._sessionsListModelService.isSessionPinned(s),
				visibleSessions: this._sessionsService.visibleSessions,
				getMultiSelectedSessions: s => [s],
				showHover: this.options.showSessionHover ?? true,
				useCompactQuickChatRows,
				approvalRowMaxLines: this.options.approvalRowMaxLines ?? DEFAULT_APPROVAL_ROW_MAX_LINES,
				toolbarMenuId: this.options.toolbarMenuId ?? SessionItemToolbarMenuId,
				handleToolbarAction: this.options.onToolbarAction,
			},
			approvalModel,
			this.options.ciFixModel,
			instantiationService,
			contextKeyService,
			markdownRendererService,
			hoverService,
			sessionsProvidersService,
			agentSessionsService,
			voicePlaybackService,
		);

		this._delegate = new SessionsTreeDelegate(approvalModel, () => false, this.options.approvalRowMaxLines ?? DEFAULT_APPROVAL_ROW_MAX_LINES, this.options.ciFixModel, useCompactQuickChatRows);

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<SessionListItem, FuzzyScore>,
			'SessionsFlatList',
			listRoot,
			this._delegate,
			[sessionRenderer],
			{
				accessibilityProvider: new SessionsAccessibilityProvider({
					grouping: () => SessionsGrouping.Date,
					isPinned: session => this._sessionsListModelService.isSessionPinned(session),
					includeQuickChatInAriaLabel: !useCompactQuickChatRows,
				}),
				identityProvider: {
					getId: (element: SessionListItem) => (element as ISession).resource.toString(),
				},
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: this.options.alwaysConsumeMouseWheel ?? true,
				multipleSelectionSupport: false,
				indent: 0,
				overrideStyles: this.options.overrideStyles,
				renderIndentGuides: RenderIndentGuides.None,
				twistieAdditionalCssClass: () => 'force-no-twistie',
			}
		));

		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element || !isSessionItem(element)) {
				return;
			}
			const isLeftClick = DOM.isMouseEvent(e.browserEvent) && e.browserEvent.button === 0;
			const preserveFocus = isLeftClick ? false : (e.editorOptions.preserveFocus ?? false);
			this.options.onSessionOpen(element.resource, preserveFocus, e.sideBySide);
		}));

		this._register(sessionRenderer.onDidChangeItemHeight(session => {
			if (this.tree.hasElement(session)) {
				this.tree.updateElementHeight(session, this._delegate.getHeight(session));
				this._onDidChangeContentHeight.fire();
			}
		}));

		this._register(sessionRenderer.onDidApproveSession(approved => this._onDidApproveSession.fire(approved)));
	}

	setSessions(sessions: readonly ISession[]): void {
		this._sessions = sessions;
		this.tree.setChildren(null, sessions.map(session => ({ element: session })));
	}

	/** The total pixel height required to render all current rows without scrolling. */
	getContentHeight(): number {
		return this._sessions.reduce((total, session) => total + this._delegate.getHeight(session), 0);
	}

	getRowHeight(): number {
		return SessionsFlatList.ROW_HEIGHT;
	}

	layout(height: number, width: number): void {
		this.tree.layout(height, width);
	}

	focus(): void {
		this.tree.domFocus();
	}

	focusSession(session: ISession): void {
		if (!this.tree.hasElement(session)) {
			return;
		}
		this.tree.setFocus([session]);
		this.tree.domFocus();
	}
}

//#endregion
