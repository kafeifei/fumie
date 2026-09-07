/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/media/sidebarActionButton.css';
import './media/accountWidget.css';
import './media/accountTitleBarWidget.css';
import '../../../../workbench/contrib/chat/browser/chatStatus/media/chatStatus.css';
import Severity from '../../../../base/common/severity.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, runOnChange } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2, IMenuService } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { appendUpdateMenuItems as registerUpdateMenuItems } from '../../../../workbench/contrib/update/browser/update.js';
import { Menus } from '../../../browser/menus.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { fillInActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { $, addDisposableListener, append, clearNode, disposableWindowInterval, EventType, getDomNodePagePosition } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ActionBar, ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem, BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerUpdateTitleBarMenuPlacement } from '../../../../workbench/contrib/update/browser/updateTitleBarEntry.js';
import { ChatEntitlement, ChatEntitlementService, getChatPlanName, getQuotaReset, getQuotaUsage, IChatEntitlementService, IQuotaSnapshot, QuotaUsageKind } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { ChatStatusDashboard, IChatStatusDashboardOptions } from '../../../../workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { getAccountProfileImageUrl, getAccountTitleBarBadgeKey, getAccountTitleBarState, getSidebarAccountPresentation, IAccountTitleBarState, IResolvedAccountInfo, ISidebarAccountPresentation, resolveAccountInfo, resolveSidebarAccountInfo } from '../../../browser/accountTitleBarState.js';
import { observeAllowSignedOutWhenUsable } from '../../../browser/sessionsAuthGate.js';
import { IsPhoneLayoutContext, SessionHasChangesContext, SessionIsCreatedContext, SessionsWelcomeVisibleContext, SinglePaneLayoutEnabledContext } from '../../../common/contextkeys.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IAuthenticationAccessService } from '../../../../workbench/services/authentication/browser/authenticationAccessService.js';
import { IAuthenticationUsageService } from '../../../../workbench/services/authentication/browser/authenticationUsageService.js';
import { ACCOUNTS_AVATAR_SETTING, IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { URI } from '../../../../base/common/uri.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IChatDashboardService } from '../../../browser/chatDashboardService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createCodexAccountMenuActions, hasSignedInCodexChatGPTAccount, ICodexAccountService, shouldShowCodexAccount } from '../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { hasSignedInClaudeAccount, IClaudeAccountService, shouldShowClaudeAccount } from '../../../../workbench/services/agentHost/browser/claudeAccountService.js';
import { IAgentSdkSetupService } from '../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';
import { IClaudeAccountInfo, IClaudeAccountRateLimitWindow } from '../../../../platform/agentHost/common/claudeAccount.js';
import { ICodexAccountInfo } from '../../../../platform/agentHost/common/codexAccount.js';
import { CLAUDE_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../../workbench/contrib/chat/common/constants.js';
import { AICustomizationManagementCommands } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { fromNow, safeIntl } from '../../../../base/common/date.js';
import { language } from '../../../../base/common/platform.js';
import { AgentHostClaudeAgentEnabledSettingId, AgentHostCodexAgentEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { CHAT_SETUP_ACTION_ID } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { AGENTIC_SIGN_IN_COMMAND_ID } from '../../../common/sessionCommands.js';
import { SessionsChatPetAchievementBadges } from './chatPetAchievementBadges.js';
import { CHAT_PET_OPEN_ACHIEVEMENTS_COMMAND_ID } from '../../../../workbench/contrib/chat/browser/chatPetAchievements.js';

// --- Account Menu Items --- //
const AccountMenu = Menus.AccountMenu;
const SessionsSidebarAccountWidgetAction = 'sessions.action.sidebarAccountWidget';
const SessionsMobileSidebarAccountWidgetAction = 'sessions.action.mobileSidebarAccountWidget';

const SIGN_OUT_ACTION_ID = 'workbench.action.agenticSignOut';
const accountDateFormatter = safeIntl.DateTimeFormat(language, { month: 'short', day: 'numeric' });
const accountTimeFormatter = safeIntl.DateTimeFormat(language, { hour: 'numeric', minute: 'numeric' });

export function shouldShowAccountPanelSummary(state: Pick<IAccountTitleBarState, 'source' | 'kind'>, hasCopilotDashboard: boolean, isAccountLoading: boolean): boolean {
	return !hasCopilotDashboard && !isAccountLoading && !(state.source === 'copilot' && state.kind === 'prominent');
}

export interface IAccountRateLimitPresentation {
	readonly label: string;
	readonly percentageLabel: string;
	readonly percentageAriaLabel: string;
	readonly resetLabel?: string;
}

/** Provider-owned wording for the shared rate-limit rows, so each keeps its own translations. */
interface IRateLimitRowLabels {
	readonly groupAriaLabel: (label: string) => string;
	readonly usedLabel: string;
}

/**
 * Plan label for a Claude subscription tier. The SDK's `accountInfo()` reports
 * an already-formatted tier ("Claude Max"), so composing "Claude {0}" around it
 * renders "Claude Claude Max". Only a bare tier ("max", "pro") — which no
 * observed account has reported, but which the contract permits — gets the
 * product name prefixed.
 */
export function claudePlanLabel(subscriptionType: string): string {
	const capitalized = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
	return subscriptionType.toLowerCase().startsWith('claude')
		? capitalized
		: localize('claudePlan', "Claude {0}", capitalized);
}

export function getClaudeRateLimitPresentations(
	account: IClaudeAccountInfo,
	formatRelativeTime: (resetsAt: number) => string = resetsAt => fromNow(resetsAt, false, true),
): readonly IAccountRateLimitPresentation[] {
	const rateLimits = account.rateLimits;
	if (!rateLimits) {
		return [];
	}

	const result: IAccountRateLimitPresentation[] = [];
	const percentageFormatter = safeIntl.NumberFormat(language, { maximumFractionDigits: 0 });
	const pushRateLimit = (rateLimit: IClaudeAccountRateLimitWindow | undefined, label: string): void => {
		if (!rateLimit) {
			return;
		}

		const usedPercentage = percentageFormatter.value.format(rateLimit.usedPercent);
		result.push({
			label,
			percentageLabel: localize('claudeLimitUsedPercentageValue', "{0}%", usedPercentage),
			percentageAriaLabel: localize('claudeLimitUsedPercentage', "{0}% used", usedPercentage),
			resetLabel: rateLimit.resetsAt !== undefined
				? localize('claudeLimitReset', "Resets {0}", formatRelativeTime(rateLimit.resetsAt))
				: undefined,
		});
	};

	// The plan-wide windows first, then the narrower ones the server only sends
	// for some plans, so an account that reports just the two keeps today's panel.
	pushRateLimit(rateLimits.fiveHour, localize('claudeFiveHourLimit', "5-hour limit"));
	pushRateLimit(rateLimits.sevenDay, localize('claudeSevenDayLimit', "7-day limit"));
	pushRateLimit(rateLimits.sevenDayOpus, localize('claudeSevenDayOpusLimit', "7-day limit (Opus)"));
	pushRateLimit(rateLimits.sevenDaySonnet, localize('claudeSevenDaySonnetLimit', "7-day limit (Sonnet)"));
	pushRateLimit(rateLimits.sevenDayOauthApps, localize('claudeSevenDayOauthAppsLimit', "7-day limit (Apps)"));
	for (const modelScoped of rateLimits.modelScoped ?? []) {
		pushRateLimit(modelScoped, localize('claudeModelScopedLimit', "7-day limit ({0})", modelScoped.displayName));
	}
	return result;
}

/**
 * The window label is derived from its duration rather than from the slot it
 * arrived in: the app-server decides which duration it reports as primary.
 */
export function getChatGPTRateLimitLabel(windowDurationMins: number | undefined): string {
	if (windowDurationMins !== undefined) {
		if (Math.abs(windowDurationMins - 7 * 24 * 60) <= 60) {
			return localize('chatGPTWeeklyLimitUsed', "Weekly limit");
		}
		if (Math.abs(windowDurationMins - 24 * 60) <= 60) {
			return localize('chatGPTDailyLimitUsed', "Daily limit");
		}
		if (windowDurationMins >= 60 && windowDurationMins <= 12 * 60) {
			return localize('chatGPTHourlyLimitUsed', "{0}-hour limit", Math.round(windowDurationMins / 60));
		}
	}
	return localize('chatGPTUsageLimitUsed', "Usage limit");
}

export function getChatGPTRateLimitPresentations(
	account: ICodexAccountInfo,
	formatRelativeTime: (resetsAt: number) => string = resetsAt => fromNow(resetsAt, false, true),
): readonly IAccountRateLimitPresentation[] {
	const rateLimits = account.rateLimit;
	if (!rateLimits) {
		return [];
	}

	const result: IAccountRateLimitPresentation[] = [];
	const percentageFormatter = safeIntl.NumberFormat(language, { maximumFractionDigits: 0 });
	for (const rateLimit of [rateLimits.primary, rateLimits.secondary]) {
		if (!rateLimit) {
			continue;
		}

		const usedPercentage = percentageFormatter.value.format(rateLimit.usedPercent);
		result.push({
			label: getChatGPTRateLimitLabel(rateLimit.windowDurationMins),
			percentageLabel: localize('chatGPTLimitUsedPercentageValue', "{0}%", usedPercentage),
			percentageAriaLabel: localize('chatGPTLimitUsedPercentage', "{0}% used", usedPercentage),
			// The app-server reports the reset in Unix seconds; the shared row
			// presentation speaks epoch milliseconds like every other provider.
			resetLabel: rateLimit.resetsAt !== undefined
				? localize('chatGPTLimitResetRelative', "Resets {0}", formatRelativeTime(rateLimit.resetsAt * 1000))
				: undefined,
		});
	}
	return result;
}

const sessionsChangesPrimaryActionVisible = ContextKeyExpr.and(
	SinglePaneLayoutEnabledContext,
	SessionIsCreatedContext,
	SessionHasChangesContext
)!;

// Register the shared VS Code update entry at the leading edge of the Agents titlebar actions.
registerUpdateTitleBarMenuPlacement(Menus.TitleBarUpdate, {
	when: ContextKeyExpr.and(
		IsAuxiliaryWindowContext.toNegated(),
		SessionsWelcomeVisibleContext.toNegated(),
		sessionsChangesPrimaryActionVisible.negate()
	),
});

// Sign In (shown when signed out)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENTIC_SIGN_IN_COMMAND_ID,
			title: localize2('signInForRemoteControl', "Sign in to GitHub to enable remote control"),
			icon: Codicon.signIn,
			menu: {
				id: AccountMenu,
				when: ContextKeyExpr.notEquals('defaultAccountStatus', 'available'),
				group: '1_account',
				order: 1,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(CHAT_SETUP_ACTION_ID);
	}
});

// Sign Out (shown when signed in)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agenticSignOut',
			title: localize2('signOut', 'Sign Out'),
			icon: Codicon.signOut,
			menu: {
				id: AccountMenu,
				when: ContextKeyExpr.equals('defaultAccountStatus', 'available'),
				group: '1_account',
				order: 1,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const defaultAccountService = accessor.get(IDefaultAccountService);
		const dialogService = accessor.get(IDialogService);
		const authenticationService = accessor.get(IAuthenticationService);
		const authenticationUsageService = accessor.get(IAuthenticationUsageService);
		const authenticationAccessService = accessor.get(IAuthenticationAccessService);
		const defaultAccount = await defaultAccountService.getDefaultAccount();
		if (!defaultAccount) {
			return;
		}

		const providerId = defaultAccount.authenticationProvider.id;
		const accountLabel = defaultAccount.accountName;
		const { confirmed } = await dialogService.confirm({
			type: Severity.Info,
			message: localize('agenticSignOutMessage', "Sign out of the Agents window?"),
			detail: localize('agenticSignOutDetail', "This will sign out '{0}' from the Agents window.", accountLabel),
			primaryButton: localize({ key: 'agenticSignOutButton', comment: ['&& denotes a mnemonic'] }, "&&Sign Out")
		});

		if (!confirmed) {
			return;
		}

		const allSessions = await authenticationService.getSessions(providerId);
		const sessions = allSessions.filter(session => session.account.label === accountLabel);
		await Promise.all(sessions.map(session => authenticationService.removeSession(providerId, session.id)));
		authenticationUsageService.removeAccountUsage(providerId, accountLabel);
		authenticationAccessService.removeAllowedExtensions(providerId, accountLabel);
	}
});

// Settings (hidden on phone — no settings UI on mobile) is contributed by
// `sessions.settings.open` in the Agents Settings custom view.

// Update actions
registerUpdateMenuItems(AccountMenu, '3_updates');

/** Preserve the compact account row in the phone sidebar drawer. */
class MobileSidebarAccountWidget extends ActionViewItem {

	private accountButton: Button | undefined;
	private signedIn = false;
	private accountInfo: IResolvedAccountInfo | undefined;
	private accountRequestCounter = 0;
	private readonly viewItemDisposables = this._register(new DisposableStore());

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(undefined, action, { ...options, icon: false, label: false });
	}

	protected override getTooltip(): string | undefined {
		return undefined;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('account-widget', 'sidebar-action');

		const accountContainer = append(container, $('.account-widget-account'));
		this.accountButton = this.viewItemDisposables.add(new Button(accountContainer, {
			...defaultButtonStyles,
			secondary: true,
			title: false,
			supportIcons: true,
			buttonSecondaryBackground: 'transparent',
			buttonSecondaryHoverBackground: undefined,
			buttonSecondaryForeground: undefined,
			buttonSecondaryBorder: undefined,
		}));
		this.accountButton.element.classList.add('account-widget-account-button', 'sidebar-action-button');

		this.updateAccountButton();
		this.viewItemDisposables.add(this.defaultAccountService.onDidChangeDefaultAccount(() => this.updateAccountButton()));
		this.viewItemDisposables.add(this.authenticationService.onDidChangeSessions(() => this.updateAccountButton()));
		this.viewItemDisposables.add(this.authenticationService.onDidRegisterAuthenticationProvider(() => this.updateAccountButton()));
		this.viewItemDisposables.add(this.authenticationService.onDidUnregisterAuthenticationProvider(() => this.updateAccountButton()));
		this.viewItemDisposables.add(this.accountButton.onDidClick(e => {
			e?.preventDefault();
			e?.stopPropagation();
			void this.onAccountClicked();
		}));
	}

	override onClick(): void {
		// Handled by the account button.
	}

	private async onAccountClicked(): Promise<void> {
		if (!this.signedIn || !this.accountInfo) {
			await this.defaultAccountService.signIn();
			return;
		}

		this.showAccountMenu(this.accountInfo);
	}

	private showAccountMenu(info: IResolvedAccountInfo): void {
		if (!this.accountButton) {
			return;
		}

		const actions: IAction[] = [
			toAction({
				id: '_signOutOfAccount',
				label: localize('signOut', 'Sign Out'),
				run: () => this.commandService.executeCommand('_signOutOfAccount', {
					providerId: info.accountProviderId,
					accountLabel: info.accountName,
				}),
			}),
		];

		this.contextMenuService.showContextMenu({
			getAnchor: () => this.accountButton!.element,
			getActions: () => actions,
		});
	}

	private async updateAccountButton(): Promise<void> {
		if (!this.accountButton) {
			return;
		}

		const requestId = ++this.accountRequestCounter;
		this.accountButton.enabled = false;
		this.applyPresentation(getSidebarAccountPresentation(undefined, true), undefined);

		const info = await resolveSidebarAccountInfo(this.defaultAccountService, this.authenticationService);
		if (requestId !== this.accountRequestCounter || this._store.isDisposed || !this.accountButton) {
			return;
		}

		this.accountButton.enabled = true;
		this.applyPresentation(getSidebarAccountPresentation(info, false), info);
	}

	private applyPresentation(presentation: ISidebarAccountPresentation, info: IResolvedAccountInfo | undefined): void {
		if (!this.accountButton) {
			return;
		}

		this.signedIn = presentation.signedIn;
		this.accountInfo = info;
		this.accountButton.label = `$(${Codicon.account.id}) ${presentation.label}`;
		this.accountButton.element.setAttribute('aria-label', presentation.ariaLabel);
	}
}

class SidebarAccountWidget extends BaseActionViewItem {

	private container: HTMLElement | undefined;
	private avatarElement: HTMLImageElement | undefined;
	private iconElement: HTMLElement | undefined;
	private codexIconElement: HTMLElement | undefined;
	private labelElement: HTMLElement | undefined;
	private badgeElement: HTMLElement | undefined;
	private accountName: string | undefined;
	private accountProviderId: string | undefined;
	private accountProviderLabel: string | undefined;
	private accountIcon: URI | undefined;
	private isAccountLoading = true;
	private accountRequestCounter = 0;
	private avatarRequestCounter = 0;
	private currentAvatarUrl: string | undefined;
	private loadedAvatarUrl: string | undefined;
	private lastState: ReturnType<typeof getAccountTitleBarState>;
	private isMenuVisible = false;
	private lastBadgeKey: string | undefined;
	private dismissedBadgeKey: string | undefined;
	private readonly copilotDashboardStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly clickPanelDisposable = this._register(new MutableDisposable<DisposableStore>());
	private readonly avatarLoadDisposable = this._register(new MutableDisposable());
	/** Whether the conditional-auth opt-in permits signed-out operation. */
	private readonly allowSignedOutWhenUsable: IObservable<boolean>;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: ChatEntitlementService,
		@ICodexAccountService private readonly codexAccountService: ICodexAccountService,
		@IClaudeAccountService private readonly claudeAccountService: IClaudeAccountService,
		@IAgentSdkSetupService private readonly agentSdkSetupService: IAgentSdkSetupService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(undefined, action, options);
		this.allowSignedOutWhenUsable = observeAllowSignedOutWhenUsable(configurationService);
		this.lastState = getAccountTitleBarState({
			isAccountLoading: true,
			entitlement: this.chatEntitlementService.entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
			allowSignedOutWhenUsable: false,
		});

		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => this.refreshAccount()));
		this._register(this.authenticationService.onDidChangeSessions(() => this.refreshAccount()));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaExceeded(() => this.renderState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaRemaining(() => this.renderState()));
		this._register(this.codexAccountService.onDidChangeAccount(() => {
			this.clickPanelDisposable.clear();
			this.renderState();
		}));
		this._register(this.claudeAccountService.onDidChangeAccount(() => {
			this.clickPanelDisposable.clear();
			this.renderState();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AgentHostCodexAgentEnabledSettingId) || event.affectsConfiguration(AgentHostClaudeAgentEnabledSettingId) || event.affectsConfiguration(ChatAIDisabledSettingId)) {
				this.clickPanelDisposable.clear();
				this.renderState();
			}
			if (event.affectsConfiguration(ACCOUNTS_AVATAR_SETTING)) {
				this.refreshAvatar();
			}
		}));
		// A signed-out user sees either a quiet "Sign In" (the opt-in is on, so signing
		// in is optional) or a prominent "Agents Signed Out". Re-render so toggling the
		// setting switches between them while the window is open.
		this._register(runOnChange(this.allowSignedOutWhenUsable, () => this.renderState()));
		this.refreshAccount();
	}

	override setFocusable(_focusable: boolean): void {
		// Don't let the ActionBar remove focusability - this widget must
		// always be reachable via Tab even when a sibling item is hidden.
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this.container = container;
		// Keep the established widget/panel class names so the complete account
		// status presentation is reused; the placement-specific class owns the
		// sidebar row layout.
		container.classList.add('sessions-account-titlebar-widget', 'sessions-account-sidebar-widget', 'sidebar-action');
		container.setAttribute('role', 'button');
		container.tabIndex = 0;

		this.avatarElement = append(container, $('img.sessions-account-titlebar-widget-avatar', { alt: localize('accountAvatarAltFallback', "Account profile image"), draggable: 'false' })) as HTMLImageElement;
		this.avatarElement.decoding = 'async';
		this.avatarElement.referrerPolicy = 'no-referrer';
		this.iconElement = append(container, $('.sessions-account-titlebar-widget-icon'));
		this.codexIconElement = append(container, $('.sessions-account-titlebar-widget-codex-icon'));
		this.codexIconElement.classList.add(...ThemeIcon.asClassNameArray(Codicon.openai));
		this.labelElement = append(container, $('span.sessions-account-titlebar-widget-label'));
		this.badgeElement = append(container, $('span.sessions-account-titlebar-widget-badge'));

		this.renderState();
	}

	override onClick(): void {
		if (!this.container) {
			return;
		}

		this.showCombinedPanel();
	}

	private async refreshAccount(): Promise<void> {
		const requestId = ++this.accountRequestCounter;
		this.isAccountLoading = true;
		this.renderState();

		const info = await resolveAccountInfo(this.defaultAccountService, this.authenticationService);
		if (requestId !== this.accountRequestCounter || this._store.isDisposed) {
			return;
		}

		this.accountName = info?.accountName;
		this.accountProviderId = info?.accountProviderId;
		this.accountProviderLabel = info?.accountProviderLabel;
		this.accountIcon = info?.accountIcon;
		this.isAccountLoading = false;
		this.refreshAvatar();
		this.renderState();
	}

	private renderState(): void {
		if (!this.container || !this.avatarElement || !this.iconElement || !this.codexIconElement || !this.labelElement || !this.badgeElement) {
			return;
		}

		// When we have a session but entitlement hasn't resolved yet,
		// treat as Unresolved to avoid showing "Agents Signed Out".
		const entitlement = this.accountName && this.chatEntitlementService.entitlement === ChatEntitlement.Unknown
			? ChatEntitlement.Unresolved
			: this.chatEntitlementService.entitlement;
		const hasChatGPTAccount = hasSignedInCodexChatGPTAccount(
			this.codexAccountService.account,
			shouldShowCodexAccount(this.configurationService, true),
		);

		const state = getAccountTitleBarState({
			isAccountLoading: this.isAccountLoading,
			accountName: this.accountName,
			accountProviderLabel: this.accountProviderLabel,
			entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
			allowSignedOutWhenUsable: this.allowSignedOutWhenUsable.get(),
		});
		this.lastState = state;

		this.container.classList.remove('kind-default', 'kind-accent', 'kind-warning', 'kind-prominent');
		this.container.classList.add(`kind-${state.kind}`);
		this.container.classList.toggle('menu-visible', this.isMenuVisible);
		this.container.setAttribute('aria-label', state.ariaLabel);

		const badgeKey = getAccountTitleBarBadgeKey(state);
		if (badgeKey !== this.lastBadgeKey) {
			this.lastBadgeKey = badgeKey;
			this.dismissedBadgeKey = undefined;
		}

		const shouldShowDotBadge = !!badgeKey && badgeKey !== this.dismissedBadgeKey;
		const loadedAvatarUrl = !this.isAccountLoading ? this.loadedAvatarUrl : undefined;
		const hasLoadedAvatar = !!loadedAvatarUrl;
		const titleBarIcon = state.dotBadge ? Codicon.account : state.icon;

		this.avatarElement.classList.toggle('visible', hasLoadedAvatar);
		this.avatarElement.alt = this.getAvatarAltText(hasLoadedAvatar);
		if (hasLoadedAvatar) {
			if (this.avatarElement.src !== loadedAvatarUrl) {
				this.avatarElement.src = loadedAvatarUrl;
			}
		} else {
			this.avatarElement.removeAttribute('src');
		}

		this.iconElement.className = `sessions-account-titlebar-widget-icon ${ThemeIcon.asClassName(titleBarIcon)}`;
		this.iconElement.classList.toggle('hidden', hasLoadedAvatar);
		this.container.classList.toggle('has-chatgpt-account', hasChatGPTAccount);
		this.codexIconElement.classList.toggle('visible', hasChatGPTAccount);
		this.labelElement.textContent = state.label;
		this.badgeElement.textContent = '';
		this.badgeElement.classList.toggle('dot-badge', shouldShowDotBadge);
		this.badgeElement.classList.toggle('dot-badge-warning', shouldShowDotBadge && state.dotBadge === 'warning');
		this.badgeElement.classList.toggle('dot-badge-error', shouldShowDotBadge && state.dotBadge === 'error');
		this.badgeElement.style.display = shouldShowDotBadge ? '' : 'none';
	}

	private getAvatarAltText(hasLoadedAvatar: boolean): string {
		if (hasLoadedAvatar && this.accountProviderId === 'github' && this.accountName) {
			return localize('accountAvatarAlt', "GitHub profile image for {0}", this.accountName);
		}

		return localize('accountAvatarAltFallback', "Account profile image");
	}

	private refreshAvatar(): void {
		const avatarUrl = this.configurationService.getValue<boolean>(ACCOUNTS_AVATAR_SETTING)
			? getAccountProfileImageUrl(this.accountProviderId, this.accountName, this.accountIcon)
			: undefined;
		if (avatarUrl === this.currentAvatarUrl) {
			return;
		}

		this.currentAvatarUrl = avatarUrl;
		this.loadedAvatarUrl = undefined;
		this.avatarLoadDisposable.clear();
		const requestId = ++this.avatarRequestCounter;

		if (!avatarUrl) {
			this.renderState();
			return;
		}

		const image = new Image();
		image.referrerPolicy = 'no-referrer';
		const clearHandlers = () => {
			image.onload = null;
			image.onerror = null;
		};
		image.onload = () => {
			if (requestId !== this.avatarRequestCounter) {
				return;
			}

			this.loadedAvatarUrl = avatarUrl;
			this.renderState();
			clearHandlers();
		};
		image.onerror = () => {
			if (requestId !== this.avatarRequestCounter) {
				return;
			}

			this.loadedAvatarUrl = undefined;
			this.renderState();
			clearHandlers();
		};
		this.avatarLoadDisposable.value = toDisposable(() => {
			clearHandlers();
			image.src = '';
		});
		image.src = avatarUrl;
		this.renderState();
	}

	private getHoverTarget(): { targetElements: HTMLElement[]; x: number } {
		const { left } = getDomNodePagePosition(this.container!);
		return {
			targetElements: [this.container!],
			x: left,
		};
	}

	private showCombinedPanel(): void {
		if (!this.container) {
			return;
		}

		if (this.isMenuVisible) {
			this.hoverService.hideHover(true);
			this.clickPanelDisposable.clear();
			return;
		}

		this.hoverService.hideHover(true);
		this.clickPanelDisposable.clear();

		const panelStore = new DisposableStore();
		this.clickPanelDisposable.value = panelStore;

		const badgeKey = getAccountTitleBarBadgeKey(this.lastState);
		if (badgeKey) {
			this.dismissedBadgeKey = badgeKey;
		}

		this.isMenuVisible = true;
		this.container.classList.add('menu-visible');
		this.renderState();

		panelStore.add({
			dispose: () => {
				this.isMenuVisible = false;
				this.container?.classList.remove('menu-visible');
				this.renderState();
				this.container?.focus();
			}
		});

		const panelContent = this.createCombinedPanelContent(panelStore);
		const hoverWidget = this.hoverService.showInstantHover({
			content: panelContent,
			target: this.getHoverTarget(),
			additionalClasses: ['sessions-account-titlebar-panel-hover'],
			position: { hoverPosition: HoverPosition.ABOVE },
			persistence: { sticky: true, hideOnHover: false },
			appearance: { showPointer: false, skipFadeInAnimation: true, maxHeightRatio: 0.8 },
		}, true);

		if (hoverWidget) {
			panelStore.add(hoverWidget);
		}

		panelStore.add(disposableWindowInterval(mainWindow, () => {
			if (!panelContent.isConnected || hoverWidget?.isDisposed) {
				this.clickPanelDisposable.clear();
			}
		}, 500));
	}

	private createCombinedPanelContent(panelStore: DisposableStore): HTMLElement {
		const panel = $('div.sessions-account-titlebar-panel');

		// Build the menu actions once and partition them.
		const menu = this.menuService.createMenu(AccountMenu, this.contextKeyService);
		const rawActions: IAction[] = [];
		fillInActionBarActions(menu.getActions(), rawActions);
		menu.dispose();
		const codexAccount = this.codexAccountService.account;
		const codexAccountVisible = shouldShowCodexAccount(this.configurationService, true);
		const claudeAccount = this.claudeAccountService.account;
		const claudeAccountVisible = shouldShowClaudeAccount(this.configurationService, true);
		const partitioned = this.partitionMenuActions(rawActions);

		const identities = append(panel, $('.sessions-account-titlebar-panel-identities'));
		if (this.accountName || this.isAccountLoading) {
			const copilotAccount = append(identities, $('section.sessions-account-titlebar-panel-provider-account', {
				'aria-label': localize('copilotAccountSectionLabel', "Copilot account")
			}));
			const copilotIdentity = append(copilotAccount, $('.sessions-account-titlebar-panel-provider-identity'));
			const loadedAvatarUrl = !this.isAccountLoading ? this.loadedAvatarUrl : undefined;
			if (loadedAvatarUrl) {
				const avatar = append(copilotIdentity, $('img.sessions-account-titlebar-panel-provider-avatar', {
					alt: this.getAvatarAltText(true),
					draggable: 'false',
					src: loadedAvatarUrl,
				})) as HTMLImageElement;
				avatar.decoding = 'async';
				avatar.referrerPolicy = 'no-referrer';
			} else {
				const accountIcon = append(copilotIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
				accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.github));
			}
			const title = append(copilotIdentity, $('div.sessions-account-titlebar-panel-provider-name'));
			title.textContent = this.getPanelHeaderLabel();
			const copilotActions = append(copilotIdentity, $('.sessions-account-titlebar-panel-provider-actions'));
			const copilotActionBar = panelStore.add(new ActionBar(copilotActions));
			panelStore.add(copilotActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			copilotActionBar.push(panelStore.add(new Action(
				'copilot.manageModels',
				localize('manageCopilotModels', "Manage Copilot Models"),
				ThemeIcon.asClassName(Codicon.copilot),
				true,
				() => this.commandService.executeCommand(MANAGE_CHAT_COMMAND_ID, '@provider:"Copilot"'),
			)), { icon: true, label: false });
			copilotActionBar.push(panelStore.add(new Action(
				'copilot.openAgentCustomizations',
				localize('openCopilotAgentCustomizations', "Agent Customizations for Copilot"),
				ThemeIcon.asClassName(Codicon.settingsGear),
				true,
				() => this.commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {
					sessionType: SessionType.AgentHostCopilot,
					section: AICustomizationManagementSection.Agents,
				}),
			)), { icon: true, label: false });
			if (partitioned.signOut) {
				copilotActionBar.push(partitioned.signOut, { icon: true, label: false });
			}
			this.appendCopilotUsage(copilotAccount, panelStore);
		} else if (partitioned.signIn) {
			const copilotAccount = append(identities, $('section.sessions-account-titlebar-panel-provider-account.signed-out', {
				'aria-label': localize('copilotAccountSectionLabel', "Copilot account")
			}));
			const copilotIdentity = append(copilotAccount, $('.sessions-account-titlebar-panel-provider-identity'));
			const accountIcon = append(copilotIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
			accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.github));
			const signInActions = append(copilotIdentity, $('.sessions-account-titlebar-panel-provider-sign-in-actions'));
			const signInActionBar = panelStore.add(new ActionBar(signInActions));
			panelStore.add(signInActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			signInActionBar.push(partitioned.signIn, { icon: false, label: true });
		}

		if (hasSignedInCodexChatGPTAccount(codexAccount, codexAccountVisible)) {
			const accountSection = append(identities, $('section.sessions-account-titlebar-panel-provider-account', {
				'aria-label': localize('chatGPTAccountSectionLabel', "ChatGPT account")
			}));
			const accountIdentity = append(accountSection, $('.sessions-account-titlebar-panel-provider-identity'));
			const accountIcon = append(accountIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
			accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.openai));
			const accountName = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-name'));
			accountName.textContent = codexAccount.email ?? localize('chatGPTAccountName', "ChatGPT");
			const accountActions = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-actions'));
			const accountActionBar = panelStore.add(new ActionBar(accountActions));
			panelStore.add(accountActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			accountActionBar.push(panelStore.add(new Action(
				'codex.manageChatGPTModels',
				localize('manageChatGPTModels', "Manage ChatGPT Models"),
				ThemeIcon.asClassName(Codicon.openai),
				true,
				() => this.commandService.executeCommand(MANAGE_CHAT_COMMAND_ID, '@provider:"ChatGPT"'),
			)), { icon: true, label: false });
			accountActionBar.push(panelStore.add(new Action(
				'codex.openAgentCustomizations',
				localize('openCodexAgentCustomizations', "Agent Customizations for Codex"),
				ThemeIcon.asClassName(Codicon.settingsGear),
				true,
				() => this.commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {
					sessionType: SessionType.AgentHostCodex,
					section: AICustomizationManagementSection.HarnessSettings,
				}),
			)), { icon: true, label: false });
			accountActionBar.push(panelStore.add(new Action(
				'codex.signOutOfChatGPT',
				localize('signOutOfChatGPT', "Sign Out"),
				ThemeIcon.asClassName(Codicon.signOut),
				true,
				() => this.codexAccountService.signOut(),
			)), { icon: true, label: false });
			this.appendChatGPTUsage(accountSection);
		} else {
			const codexAccountActions = createCodexAccountMenuActions(this.codexAccountService, codexAccountVisible);
			if (codexAccountActions.length) {
				const accountSection = append(identities, $('section.sessions-account-titlebar-panel-provider-account.signed-out', {
					'aria-label': localize('chatGPTAccountSectionLabel', "ChatGPT account")
				}));
				const accountIdentity = append(accountSection, $('.sessions-account-titlebar-panel-provider-identity'));
				const accountIcon = append(accountIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
				accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.openai));
				const signInActions = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-sign-in-actions'));
				const signInActionBar = panelStore.add(new ActionBar(signInActions));
				panelStore.add(signInActionBar.onWillRun(() => {
					this.hoverService.hideHover(true);
					this.clickPanelDisposable.clear();
				}));
				for (const action of codexAccountActions) {
					signInActionBar.push(action instanceof Action ? panelStore.add(action) : action, { icon: false, label: true });
				}
			}
		}

		if (hasSignedInClaudeAccount(claudeAccount, claudeAccountVisible)) {
			const accountSection = append(identities, $('section.sessions-account-titlebar-panel-provider-account', {
				'aria-label': localize('claudeAccountSectionLabel', "Claude account")
			}));
			const accountIdentity = append(accountSection, $('.sessions-account-titlebar-panel-provider-identity'));
			const accountIcon = append(accountIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
			accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.claude));
			const accountName = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-name'));
			accountName.textContent = claudeAccount.email ?? localize('claudeAccountName', "Claude");
			const accountActions = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-actions'));
			const accountActionBar = panelStore.add(new ActionBar(accountActions));
			panelStore.add(accountActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			accountActionBar.push(panelStore.add(new Action(
				'claude.manageAnthropicModels',
				localize('manageClaudeModels', "Manage Claude Models"),
				ThemeIcon.asClassName(Codicon.claude),
				true,
				() => this.commandService.executeCommand(MANAGE_CHAT_COMMAND_ID, '@provider:"Anthropic"'),
			)), { icon: true, label: false });
			accountActionBar.push(panelStore.add(new Action(
				'claude.openAgentCustomizations',
				localize('openClaudeAgentCustomizations', "Agent Customizations for Claude"),
				ThemeIcon.asClassName(Codicon.settingsGear),
				true,
				() => this.commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {
					sessionType: SessionType.AgentHostClaude,
					section: AICustomizationManagementSection.HarnessSettings,
				}),
			)), { icon: true, label: false });
			accountActionBar.push(panelStore.add(new Action(
				'claude.signOutOfClaude',
				localize('signOutOfClaude', "Sign out of Claude"),
				ThemeIcon.asClassName(Codicon.signOut),
				true,
				() => this.claudeAccountService.signOut(),
			)), { icon: true, label: false });
			this.appendClaudeSubscription(accountSection, claudeAccount);
		} else if (claudeAccountVisible) {
			const accountSection = append(identities, $('section.sessions-account-titlebar-panel-provider-account.signed-out', {
				'aria-label': localize('claudeAccountSectionLabel', "Claude account")
			}));
			const accountIdentity = append(accountSection, $('.sessions-account-titlebar-panel-provider-identity'));
			const accountIcon = append(accountIdentity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
			accountIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.claude));
			const signInActions = append(accountIdentity, $('.sessions-account-titlebar-panel-provider-sign-in-actions'));
			const signInActionBar = panelStore.add(new ActionBar(signInActions));
			panelStore.add(signInActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			signInActionBar.push(panelStore.add(new Action(
				'claude.signInToClaude',
				localize('signInToUseClaude', "Sign in to use Claude"),
				undefined,
				true,
				() => {
					if (this.agentSdkSetupService.setups.some(setup => setup.agent === CLAUDE_AGENT_PROVIDER_ID && setup.signInProviderName)) {
						return this.agentSdkSetupService.signIn(CLAUDE_AGENT_PROVIDER_ID);
					} else {
						return this.commandService.executeCommand(MANAGE_CHAT_COMMAND_ID, '@provider:"Anthropic"');
					}
				},
			)), { icon: false, label: true });
		}

		panelStore.add(this.instantiationService.createInstance(SessionsChatPetAchievementBadges, panel, () => {
			this.hoverService.hideHover(true);
			this.clickPanelDisposable.clear();
			void this.commandService.executeCommand(CHAT_PET_OPEN_ACHIEVEMENTS_COMMAND_ID);
		}));

		if (this.shouldShowCopilotDashboardHover()) {
			const footer = append(panel, $('section.sessions-account-titlebar-panel-footer', {
				'aria-label': localize('sessionsAccountStatusSectionLabel', "Account status")
			}));
			append(footer, this.createCopilotHoverContent({ compactQuotaLayout: true }));
		}

		// Other panel actions (sign-in, etc.) — only render if there's at least one non-separator action.
		if (partitioned.other.some(a => !(a instanceof Separator))) {
			const actionsSection = append(panel, $('.sessions-account-titlebar-panel-actions'));
			const actionsActionBar = panelStore.add(new ActionBar(actionsSection, {
				orientation: ActionsOrientation.VERTICAL,
			}));
			panelStore.add(actionsActionBar.onWillRun(() => {
				this.hoverService.hideHover(true);
				this.clickPanelDisposable.clear();
			}));
			let lastWasSeparator = true;
			for (const action of partitioned.other) {
				if (action instanceof Separator) {
					if (!lastWasSeparator) {
						actionsActionBar.push(action);
						lastWasSeparator = true;
					}
					continue;
				}
				lastWasSeparator = false;
				actionsActionBar.push(action, { icon: false, label: true });
			}
		}

		if (!partitioned.signIn && shouldShowAccountPanelSummary(this.lastState, this.shouldShowCopilotDashboardHover(), this.isAccountLoading)) {
			const contentSection = append(panel, $('.sessions-account-titlebar-panel-content'));
			const summary = append(contentSection, $('.sessions-account-titlebar-panel-summary'));
			summary.textContent = this.lastState.ariaLabel;
		}

		return panel;
	}

	private appendCopilotUsage(accountSection: HTMLElement, panelStore: DisposableStore): void {
		const usage = append(accountSection, $('.sessions-account-titlebar-panel-provider-usage'));
		const contentStore = panelStore.add(new DisposableStore());

		const render = () => {
			contentStore.clear();
			clearNode(usage);
			this.renderCopilotUsage(usage, contentStore);
		};
		render();

		// The panel is built from the cached snapshot while the embedded dashboard kicks off a
		// fresh entitlement request, so rebuild the row once that lands rather than leaving it
		// stale until the panel is reopened.
		panelStore.add(this.chatEntitlementService.onDidChangeQuotaRemaining(render));
		panelStore.add(this.chatEntitlementService.onDidChangeEntitlement(render));
	}

	private renderCopilotUsage(usage: HTMLElement, store: DisposableStore): void {
		const quota = this.chatEntitlementService.quotas.premiumChat ?? this.chatEntitlementService.quotas.chat;
		const planRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
		append(planRow, $('span.sessions-account-titlebar-panel-provider-plan', undefined, this.getCopilotPlanLabel()));

		const quotaUsage = getQuotaUsage(quota);
		if (!quota || !quotaUsage) {
			return;
		}

		const formatter = safeIntl.NumberFormat(language, { maximumFractionDigits: 2, minimumFractionDigits: 0 });

		if (quotaUsage.kind === QuotaUsageKind.CreditsUsed) {
			const creditsFormatted = formatter.value.format(quotaUsage.creditsUsed);
			append(planRow, $('span.sessions-account-titlebar-panel-provider-usage-value', {
				'aria-label': localize('copilotCreditsUsedTotal', "{0} credits used", creditsFormatted)
			}, creditsFormatted));
		} else {
			const usedPercentage = Math.floor(quotaUsage.usedPercentage);
			const percentageLabel = localize('copilotCreditsUsedPercentageValue', "{0}%", usedPercentage);
			const percentageAriaLabel = localize('copilotCreditsUsedPercentage', "{0}% credits used", usedPercentage);
			const { used, total } = quotaUsage;

			// Revealing the ratio is the only interaction, so this is a tab stop only when there is a ratio to reveal.
			const usageValue = append(planRow, $('span.sessions-account-titlebar-panel-provider-usage-value', used !== undefined && total !== undefined ? { tabIndex: 0 } : undefined));
			usageValue.textContent = percentageLabel;
			usageValue.setAttribute('aria-label', percentageAriaLabel);

			if (used !== undefined && total !== undefined) {
				const creditsValue = localize('copilotCreditsUsedRatioValue', "{0} / {1}", formatter.value.format(used), formatter.value.format(total));
				const creditsAriaLabel = localize('copilotCreditsUsedRatio', "{0} / {1} credits used", formatter.value.format(used), formatter.value.format(total));
				const showCredits = () => {
					usageValue.textContent = creditsValue;
					usageValue.setAttribute('aria-label', creditsAriaLabel);
				};
				const showPercentage = () => {
					usageValue.textContent = percentageLabel;
					usageValue.setAttribute('aria-label', percentageAriaLabel);
				};
				store.add(addDisposableListener(usageValue, EventType.MOUSE_ENTER, showCredits));
				store.add(addDisposableListener(usageValue, EventType.MOUSE_LEAVE, showPercentage));
				store.add(addDisposableListener(usageValue, EventType.FOCUS, showCredits));
				store.add(addDisposableListener(usageValue, EventType.BLUR, showPercentage));
			}
		}

		const detailRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.secondary'));
		const resetLabel = this.getCopilotResetLabel(quota);
		if (resetLabel) {
			append(detailRow, $('span.sessions-account-titlebar-panel-provider-reset', undefined, resetLabel));
		} else {
			detailRow.classList.add('without-reset');
		}
		append(detailRow, $('span.sessions-account-titlebar-panel-provider-usage-label', undefined, localize('copilotCreditsUsedLabel', "Credits used")));
	}

	private appendChatGPTUsage(accountSection: HTMLElement): void {
		const account = this.codexAccountService.account;
		const usage = append(accountSection, $('.sessions-account-titlebar-panel-provider-usage'));
		const planRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
		append(planRow, $('span.sessions-account-titlebar-panel-provider-plan', undefined, account.planType
			? localize('chatGPTPlan', "ChatGPT {0}", account.planType.charAt(0).toUpperCase() + account.planType.slice(1))
			: localize('chatGPTSubscription', "ChatGPT subscription")));

		this.appendRateLimitRows(usage, getChatGPTRateLimitPresentations(account), {
			groupAriaLabel: label => localize('chatGPTRateLimitGroup', "{0} usage", label),
			usedLabel: localize('chatGPTLimitUsedLabel', "Limit used"),
		});
	}

	private appendClaudeSubscription(accountSection: HTMLElement, account: IClaudeAccountInfo): void {
		const usage = append(accountSection, $('.sessions-account-titlebar-panel-provider-usage'));
		const planRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
		append(planRow, $('span.sessions-account-titlebar-panel-provider-plan', undefined, account.subscriptionType
			? claudePlanLabel(account.subscriptionType)
			: localize('claudeSubscription', "Claude subscription")));

		this.appendRateLimitRows(usage, getClaudeRateLimitPresentations(account), {
			groupAriaLabel: label => localize('claudeRateLimitGroup', "{0} usage", label),
			usedLabel: localize('claudeLimitUsedLabel', "Limit used"),
		});
	}

	/** One group per reported window; the provider owns the wording, the rows are shared. */
	private appendRateLimitRows(usage: HTMLElement, rateLimits: readonly IAccountRateLimitPresentation[], labels: IRateLimitRowLabels): void {
		for (const rateLimit of rateLimits) {
			const limitGroup = append(usage, $('.sessions-account-titlebar-panel-provider-rate-limit', {
				role: 'group',
				'aria-label': labels.groupAriaLabel(rateLimit.label),
			}));
			const limitRow = append(limitGroup, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
			append(limitRow, $('span.sessions-account-titlebar-panel-provider-usage-label', undefined, rateLimit.label));
			append(limitRow, $('span.sessions-account-titlebar-panel-provider-usage-value', {
				'aria-label': rateLimit.percentageAriaLabel,
			}, rateLimit.percentageLabel));

			const detailRow = append(limitGroup, $('.sessions-account-titlebar-panel-provider-metric-row.secondary'));
			if (rateLimit.resetLabel) {
				append(detailRow, $('span.sessions-account-titlebar-panel-provider-reset', undefined, rateLimit.resetLabel));
			} else {
				detailRow.classList.add('without-reset');
			}
			append(detailRow, $('span.sessions-account-titlebar-panel-provider-usage-label', undefined, labels.usedLabel));
		}
	}

	private getCopilotResetLabel(quota: IQuotaSnapshot | undefined): string | undefined {
		const reset = getQuotaReset(quota, this.chatEntitlementService.quotas);
		if (!reset) {
			return undefined;
		}

		return reset.hasTime
			? localize('copilotCreditsResetAt', "Resets {0} at {1}", accountDateFormatter.value.format(reset.date), accountTimeFormatter.value.format(reset.date))
			: localize('copilotCreditsReset', "Resets {0}", accountDateFormatter.value.format(reset.date));
	}

	private partitionMenuActions(rawActions: IAction[]): { signIn: IAction | undefined; signOut: IAction | undefined; other: IAction[] } {
		let signIn: IAction | undefined;
		let signOut: IAction | undefined;
		const other: IAction[] = [];

		const pushSeparator = () => {
			// Collapse runs and skip leading separators so groups whose only
			// items get filtered (e.g. update.*) don't leave orphans behind.
			if (other.length === 0 || other[other.length - 1] instanceof Separator) {
				return;
			}
			other.push(new Separator());
		};

		for (const action of rawActions) {
			if (action instanceof Separator) {
				pushSeparator();
				continue;
			}
			if (action.id === SIGN_OUT_ACTION_ID) {
				signOut = action;
				continue;
			}
			if (action.id === AGENTIC_SIGN_IN_COMMAND_ID) {
				if (!this.isAccountLoading) {
					signIn = action;
				}
				continue;
			}
			if (action.id.startsWith('update.')) {
				continue;
			}
			other.push(action);
		}

		// Trim trailing separator left after filtering.
		if (other.length > 0 && other[other.length - 1] instanceof Separator) {
			other.pop();
		}

		return { signIn, signOut, other };
	}

	private getPanelHeaderLabel(): string {
		if (this.accountName) {
			return this.accountName;
		}

		if (this.isAccountLoading) {
			return localize('loadingAccountHeader', "Loading Account...");
		}

		return localize('accountMenuHeaderFallback', "Account");
	}

	private getCopilotPlanLabel(): string {
		switch (this.chatEntitlementService.entitlement) {
			case ChatEntitlement.Available:
			case ChatEntitlement.Free:
			case ChatEntitlement.EDU:
			case ChatEntitlement.Pro:
			case ChatEntitlement.ProPlus:
			case ChatEntitlement.Business:
			case ChatEntitlement.Enterprise:
			case ChatEntitlement.Max:
				return getChatPlanName(this.chatEntitlementService.entitlement);
			default:
				return '';
		}
	}

	private shouldShowCopilotDashboardHover(): boolean {
		return !this.chatEntitlementService.sentiment.hidden && !!this.accountName;
	}

	private createCopilotHoverContent(extraOptions?: Partial<IChatStatusDashboardOptions>): HTMLElement {
		const store = new DisposableStore();
		this.copilotDashboardStore.value = store;
		const dashboardElement = ChatStatusDashboard.instantiateInContents(this.instantiationService, store, {
			excludedStatusItemIds: ['github.copilot-chat.copilot.workspaceIndexStatus'],
			disableInlineSuggestionsSettings: true,
			disableModelSelection: true,
			disableProviderOptions: true,
			disableCompletionsSnooze: true,
			disableQuickSettingsCollapsible: true,
			...extraOptions,
		});

		store.add(disposableWindowInterval(mainWindow, () => {
			if (!dashboardElement.isConnected) {
				store.dispose();
			}
		}, 2000));

		return dashboardElement;
	}
}

// --- Register custom view item --- //

// The run() is a no-op — rendering is handled by the custom view items
// registered alongside them.
class SidebarAccountWidgetAction extends Action2 {
	constructor() {
		super({
			id: SessionsSidebarAccountWidgetAction,
			title: localize2('agentsAccountStatusSidebar', "Agents Account and Status"),
			menu: {
				id: Menus.SidebarFooter,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext.negate()),
			}
		});
	}

	run(): void { }
}

class MobileSidebarAccountWidgetAction extends Action2 {
	constructor() {
		super({
			id: SessionsMobileSidebarAccountWidgetAction,
			title: localize2('agentsAccountStatusMobileSidebar', "Account"),
			menu: {
				id: Menus.SidebarFooter,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext),
			}
		});
	}

	run(): void { }
}

export class AccountWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsWidget';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IProductService productService: IProductService,
	) {
		super();

		// Read the resolved product, not the built-in one. A web embedder's
		// `productConfiguration` only ever reaches `IProductService`, so the
		// module-level `product` still reports what was compiled in — which is
		// how the client Fumie serves to a browser kept showing the account row
		// (and its "Agents Signed Out") after asking for `sessionsAccountUI:
		// false`. That client has no authentication provider and reaches this
		// machine's agent host over a tunnel rather than through
		// `IAgentHostService`, so every account this row can read is empty
		// there: sign-in lives on the desktop.
		//
		// Both the menu entries and their renderers are registered here so the
		// row cannot appear as a bare command while the widget is withheld.
		if (productService.sessionsAccountUI === false) {
			return;
		}

		this._register(registerAction2(SidebarAccountWidgetAction));
		this._register(registerAction2(MobileSidebarAccountWidgetAction));

		this._register(actionViewItemService.register(Menus.SidebarFooter, SessionsSidebarAccountWidgetAction, (action, options) => {
			return instantiationService.createInstance(SidebarAccountWidget, action, options);
		}, undefined));

		this._register(actionViewItemService.register(Menus.SidebarFooter, SessionsMobileSidebarAccountWidgetAction, (action, options) => {
			return instantiationService.createInstance(MobileSidebarAccountWidget, action, options);
		}, undefined));
	}
}

registerWorkbenchContribution2(AccountWidgetContribution.ID, AccountWidgetContribution, WorkbenchPhase.BlockRestore);

// --- Chat Dashboard Service (real implementation for mobile account sheet) --- //

class ChatDashboardServiceImpl implements IChatDashboardService {
	readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	createDashboardElement(store: DisposableStore): HTMLElement | undefined {
		const dashboardElement = ChatStatusDashboard.instantiateInContents(this.instantiationService, store, {
			excludedStatusItemIds: ['github.copilot-chat.copilot.workspaceIndexStatus'],
			disableInlineSuggestionsSettings: true,
			disableModelSelection: true,
			disableProviderOptions: true,
			disableCompletionsSnooze: true,
		});

		store.add(disposableWindowInterval(mainWindow, () => {
			if (!dashboardElement.isConnected) {
				store.dispose();
			}
		}, 2000));

		return dashboardElement;
	}
}

registerSingleton(IChatDashboardService, ChatDashboardServiceImpl, InstantiationType.Delayed);
