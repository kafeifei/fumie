/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSettings.css';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Language } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { readAgentCustomizationSettings, type IAgentCustomizationSettingsDescriptor } from '../../../../platform/agentHost/common/agentCustomizationSettings.js';
import { AgentSdkStatusConfigKey, type AgentSdkStatusMap } from '../../../../platform/agentHost/common/agentHostSchema.js';
import { SessionConfigKey } from '../../../../platform/agentHost/common/sessionConfigKeys.js';
import type { ConfigPropertySchema } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, IRegisteredConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { getSelectedModelStorageKey, getStoredSelectedModel, storeSelectedModel } from '../../../../workbench/contrib/chat/common/chatSelectedModel.js';
import { ILocaleService } from '../../../../workbench/services/localization/common/locale.js';
import { ChatAgentLocation, ChatConfiguration, ChatDefaultPermissionLevel, ChatPermissionLevel, getChatPermissionLevelFromDefaultConfiguration, IChatDefaultConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { getRegisteredLanguageModels } from '../../../../workbench/contrib/chat/common/modelSelection.js';
import { ICodexAccountService } from '../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { isAgentHostProvider, isAgentHostProviderId, type IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { AGENTIC_SIGN_IN_COMMAND_ID } from '../../../common/sessionCommands.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import {
	agentHostSettingsUri,
	AgentRestartNotice,
	AgentSettingsAccountKind,
	closeAgentSettingsOverlay,
	GENERAL_NAV_ID,
	parseCustomizationNavId,
	resolveAgentRestartNotice,
	readRememberedIsolation,
	readRememberedSessionConfig,
	readStoredSessionTypePick,
	writeRememberedSessionConfigValue,
	writeStoredSessionTypePick,
	type AgentSettingsNavId,
} from './agentSettings.js';
import {
	buildAgentSettingsCatalog,
	buildAgentSettingsNavGroups,
	buildCustomizationNavItems,
	resolveSettingsNavSelection,
	type AgentSettingsCustomizationSection,
	type IAgentSettingsAgent,
	type IAgentSettingsCatalog,
	type IAgentSettingsCustomizationNavItem,
} from './agentSettingsCatalog.js';
import { AgentSettingsCustomizationsHost } from './agentSettingsCustomizationsHost.js';
import { AgentSettingsModelsHost } from './agentSettingsModelsHost.js';
import { AgentSettingsRemoteHosts } from './agentSettingsRemoteHosts.js';
import {
	appendLinkButton,
	appendSection,
	appendSettingRow,
	renderCheckbox,
	renderMultilineInput,
	renderSelect,
	renderTextInput,
	type ISelectChoice,
} from './agentSettingsForm.js';

const $ = DOM.$;

const AUTO_APPROVE_CHOICES: readonly ISelectChoice<ChatDefaultPermissionLevel>[] = [
	{ value: ChatDefaultPermissionLevel.Manual, label: localize('agentSettings.approvals.default', "Default Permissions") },
	{ value: ChatDefaultPermissionLevel.Assisted, label: localize('agentSettings.approvals.assisted', "Auto-Review") },
	{ value: ChatDefaultPermissionLevel.AllowAll, label: localize('agentSettings.approvals.autoApprove', "Full Access") },
];

const ISOLATION_CHOICES: readonly ISelectChoice[] = [
	{ value: 'folder', label: localize('agentSettings.isolation.folder', "Folder") },
	{ value: 'worktree', label: localize('agentSettings.isolation.worktree', "Worktree") },
];

/** Command id of `RestartLocalAgentHostAction` (an `electron-browser` layer we cannot import from). */
const RESTART_LOCAL_AGENT_HOST_COMMAND_ID = 'workbench.action.chat.restartLocalAgentHost';

/**
 * How long after this page turns an Agent on we wait before calling it "not
 * registered". Enabling is forwarded to the agent host and answered by a
 * provider registration travelling back, so a freshly flipped toggle is
 * expected to disagree with {@link IAgentSettingsAgent.advertised} for a moment.
 * Agents whose SDK still has to be installed are covered separately, by the
 * host-published SDK readiness map.
 */
const HOT_ENABLE_GRACE_MS = 5_000;

export class AgentSettingsWidget extends Disposable {

	readonly element: HTMLElement = $('.agent-settings');

	private readonly _navEl: HTMLElement;
	private _selectedNavButton: HTMLElement | undefined;
	private _firstNavButton: HTMLElement | undefined;
	private readonly _bodyEl: HTMLElement;
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _providerListeners = this._register(new DisposableStore());
	/** Root-config writes this widget itself initiated, keyed by provider id; see {@link _setRootConfigValue}. */
	private readonly _pendingOwnRootConfigWrites = new Map<string, number>();
	/** Session type id → moment its hot-enable grace period ends; see {@link _renderRestartNotice}. */
	private readonly _hotEnableDeadlines = new Map<string, number>();
	private readonly _customizationsHost: AgentSettingsCustomizationsHost;
	private readonly _modelsHost: AgentSettingsModelsHost;
	private readonly _remoteHosts: AgentSettingsRemoteHosts;
	private _navId: AgentSettingsNavId = GENERAL_NAV_ID;
	private _catalog: IAgentSettingsCatalog = { agents: [] };
	private _customizationItems: readonly IAgentSettingsCustomizationNavItem[] = [];
	private _visibleCustomizationSection: AgentSettingsCustomizationSection | undefined;
	private _modelsVisible = false;
	private _refreshing = false;

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@ICodexAccountService private readonly _codexAccountService: ICodexAccountService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICustomizationHarnessService private readonly _harnessService: ICustomizationHarnessService,
		@ILanguagePackService private readonly _languagePackService: ILanguagePackService,
		@ILocaleService private readonly _localeService: ILocaleService,
	) {
		super();

		this._navEl = DOM.append(this.element, $('nav.agent-settings-nav', { 'aria-label': localize('agentSettings.nav', "Settings") }));
		this._bodyEl = DOM.append(this.element, $('.agent-settings-body'));
		this._customizationsHost = this._register(instantiationService.createInstance(AgentSettingsCustomizationsHost, {
			onSelectSection: (section, options) => this._selectCustomization(section, options),
		}));
		this.element.appendChild(this._customizationsHost.element);
		this._modelsHost = this._register(instantiationService.createInstance(AgentSettingsModelsHost));
		this.element.appendChild(this._modelsHost.element);
		this._remoteHosts = this._register(instantiationService.createInstance(AgentSettingsRemoteHosts));

		this._register(this._sessionsManagementService.onDidChangeSessionTypes(() => this._refresh()));
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => {
			this._bindProviderListeners();
			this._refresh();
		}));
		this._register(this._languageModelsService.onDidChangeLanguageModels(() => this._refresh()));
		this._register(this._defaultAccountService.onDidChangeDefaultAccount(() => this._refresh()));
		this._register(this._codexAccountService.onDidChangeAccount(() => this._refresh()));
		this._register(autorun(reader => {
			this._sessionsService.activeSession.read(reader);
			this._harnessService.activeHarness.read(reader);
			this._harnessService.availableHarnesses.read(reader);
			this._refresh();
		}));
		this._bindProviderListeners();
		this._refresh();
	}

	layout(width: number, height: number): void {
		this.element.style.height = `${Math.max(0, height)}px`;
		this.element.style.width = `${Math.max(0, width)}px`;
		const navWidth = this._navEl.offsetWidth || 200;
		const contentWidth = Math.max(0, width - navWidth);
		this._customizationsHost.layout(contentWidth, height);
		this._modelsHost.layout(contentWidth, height);
	}

	focus(): void {
		(this._selectedNavButton ?? this._firstNavButton)?.focus();
	}

	/** Selects a nav entry by id; unknown ids fall back to General. */
	selectNav(navId: AgentSettingsNavId): void {
		if (this._navId === navId) {
			return;
		}
		this._navId = navId;
		this._render();
	}

	private _refresh(): void {
		if (this._refreshing) {
			return;
		}
		this._refreshing = true;
		try {
			this._catalog = this._readCatalog();
			this._customizationsHost.setAgents(this._catalog.agents);
			this._customizationItems = buildCustomizationNavItems(new Set(this._harnessService.getActiveDescriptor().hiddenSections ?? []));
			const selection = resolveSettingsNavSelection(this._navId, this._catalog.agents, this._customizationItems);
			if (selection.kind === 'general' && this._navId !== GENERAL_NAV_ID) {
				this._navId = parseCustomizationNavId(this._navId) && this._customizationItems[0]
					? this._customizationItems[0].navId
					: GENERAL_NAV_ID;
			}
			this._render();
		} finally {
			this._refreshing = false;
		}
	}

	private _readCatalog(): IAgentSettingsCatalog {
		const advertised = this._sessionsManagementService.getAllProviderSessionTypes()
			.filter(item => isAgentHostProviderId(item.providerId))
			.map(item => ({ providerId: item.providerId, sessionType: item.sessionType }));
		const agentHostProviderIds = new Set(
			this._sessionsProvidersService.getProviders().filter(isAgentHostProvider).map(provider => provider.id)
		);
		const configurationKeys = allConfigurationKeys();
		const rootConfigKeys = new Set<string>();
		const customizationByProvider = new Map<string, IAgentCustomizationSettingsDescriptor>();
		for (const provider of this._sessionsProvidersService.getProviders()) {
			if (!isAgentHostProvider(provider)) {
				continue;
			}
			const root = provider.getRootConfig();
			for (const key of Object.keys(root?.schema.properties ?? {})) {
				rootConfigKeys.add(key);
			}
			const state = provider.getRootState();
			for (const advertisedType of advertised.filter(item => item.providerId === provider.id)) {
				const descriptor = readAgentCustomizationSettings(state, advertisedType.sessionType.id);
				if (descriptor) {
					customizationByProvider.set(advertisedType.sessionType.id, descriptor);
				}
			}
		}
		return buildAgentSettingsCatalog({
			allowedProviderIds: product.sessionsAllowedAgentHostProviders,
			advertised,
			agentHostProviderIds,
			configurationKeys,
			rootConfigKeys,
			customizationByProvider,
		});
	}

	private _render(): void {
		this._renderStore.clear();
		this._renderNav();
		this._renderBody();
	}

	private _renderNav(): void {
		DOM.clearNode(this._navEl);
		this._selectedNavButton = undefined;
		this._firstNavButton = undefined;
		const groups = buildAgentSettingsNavGroups(this._catalog.agents, this._customizationItems, {
			generalHeading: localize('agentSettings.generalGroup', "General"),
			generalItem: localize('agentSettings.general', "General"),
			modelsItem: localize('agentSettings.modelsNav', "Models"),
			remoteHostsItem: localize('agentSettings.remoteHostsNav', "Remote Connections"),
			agentsHeading: localize('agentSettings.agents', "Agents"),
			customizationsHeading: localize('agentSettings.customizations', "Customizations"),
		});
		for (const group of groups) {
			DOM.append(this._navEl, $('.agent-settings-nav-heading')).textContent = group.heading;
			for (const item of group.items) {
				this._appendNavButton(item.navId, item.label, item.icon);
			}
		}
	}

	private _appendNavButton(id: AgentSettingsNavId, label: string, icon?: ThemeIcon): void {
		const button = DOM.append(this._navEl, $('button.agent-settings-nav-item', {
			type: 'button',
			'aria-current': this._navId === id ? 'page' : undefined,
		}));
		button.classList.toggle('selected', this._navId === id);
		this._firstNavButton ??= button;
		if (this._navId === id) {
			this._selectedNavButton = button;
		}
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		button.appendChild($('span', undefined, label));
		this._renderStore.add(DOM.addDisposableListener(button, 'click', () => {
			if (this._navId === id) {
				return;
			}
			this._navId = id;
			this._render();
		}));
	}

	private _renderBody(options?: { showMarketplace?: boolean }): void {
		const selection = resolveSettingsNavSelection(this._navId, this._catalog.agents, this._customizationItems);
		this.element.classList.toggle('showing-customizations', selection.kind === 'customization');
		this.element.classList.toggle('showing-models', selection.kind === 'models');
		if (selection.kind !== 'models' && this._modelsVisible) {
			this._modelsVisible = false;
			this._modelsHost.hide();
		}
		if (selection.kind === 'customization') {
			if (this._visibleCustomizationSection !== selection.section || options?.showMarketplace) {
				this._visibleCustomizationSection = selection.section;
				this._customizationsHost.show(selection.section, options);
			}
			return;
		}
		this._visibleCustomizationSection = undefined;
		if (selection.kind === 'models') {
			if (!this._modelsVisible) {
				this._modelsVisible = true;
				this._modelsHost.show();
			}
			return;
		}
		DOM.clearNode(this._bodyEl);
		if (selection.kind === 'remoteHosts') {
			this._remoteHosts.render(this._bodyEl);
			return;
		}
		if (selection.kind === 'agent') {
			const agent = this._catalog.agents.find(candidate => candidate.sessionTypeId === selection.sessionTypeId);
			if (agent) {
				this._renderAgent(agent);
				return;
			}
		}
		this._renderGeneral();
	}

	private _selectCustomization(section: AgentSettingsCustomizationSection, options?: { showMarketplace?: boolean }): void {
		const navId = this._customizationItems.find(item => item.section === section)?.navId;
		if (!navId) {
			return;
		}
		this._navId = navId;
		this._renderStore.clear();
		this._renderNav();
		this._renderBody(options);
	}

	private _renderGeneral(): void {
		const content = DOM.append(this._bodyEl, $('.agent-settings-content'));
		DOM.append(content, $('h1.agent-settings-title')).textContent = localize('agentSettings.general.title', "General");
		DOM.append(content, $('p.agent-settings-intro')).textContent = localize('agentSettings.general.intro', "Defaults for new sessions in this window.");

		const defaults = appendSection(content, localize('agentSettings.defaults', "New Sessions"));
		const agentChoices: ISelectChoice[] = this._catalog.agents.map(agent => ({
			value: agent.sessionTypeId,
			label: agent.label,
		}));
		if (agentChoices.length) {
			const stored = readStoredSessionTypePick(this._storageService);
			const current = stored && agentChoices.some(choice => choice.value === stored.sessionTypeId)
				? stored.sessionTypeId
				: agentChoices[0].value;
			appendSettingRow(
				defaults,
				localize('agentSettings.defaultAgent', "Default Agent"),
				localize('agentSettings.defaultAgent.description', "Used when starting a new session."),
				renderSelect(this._renderStore, this._contextViewService, agentChoices, current, localize('agentSettings.defaultAgent', "Default Agent"), value => {
					const agent = this._catalog.agents.find(candidate => candidate.sessionTypeId === value);
					writeStoredSessionTypePick(this._storageService, {
						providerId: agent?.providerId,
						sessionTypeId: value,
					});
				}),
			);
		}

		const isolation = readRememberedIsolation(this._storageService) ?? 'folder';
		appendSettingRow(
			defaults,
			localize('agentSettings.isolation', "Isolation"),
			localize('agentSettings.isolation.description', "How new sessions isolate their working copy."),
			renderSelect(this._renderStore, this._contextViewService, ISOLATION_CHOICES, isolation, localize('agentSettings.isolation', "Isolation"), value => {
				writeRememberedSessionConfigValue(this._storageService, SessionConfigKey.Isolation, value);
			}),
		);

		const approvals = this._readDefaultPermissions();
		appendSettingRow(
			defaults,
			localize('agentSettings.permissions', "Default Permissions"),
			localize('agentSettings.permissions.description', "Starting permission level for new sessions."),
			renderSelect(this._renderStore, this._contextViewService, AUTO_APPROVE_CHOICES, approvals, localize('agentSettings.permissions', "Default Permissions"), async value => {
				const currentValue = this._configurationService.getValue<IChatDefaultConfiguration>(ChatConfiguration.DefaultConfiguration) ?? {};
				await this._configurationService.updateValue(ChatConfiguration.DefaultConfiguration, { ...currentValue, approvals: value });
				writeRememberedSessionConfigValue(this._storageService, SessionConfigKey.AutoApprove, getChatPermissionLevelFromDefaultConfiguration(value) ?? ChatPermissionLevel.Default);
			}),
		);

		this._renderDisplayLanguage(content);
		this._renderAccount(content);
	}

	private _renderDisplayLanguage(parent: HTMLElement): void {
		const section = appendSection(parent, localize('agentSettings.language', "Display Language"));
		const placeholder = $('.agent-settings-select');
		appendSettingRow(
			section,
			localize('agentSettings.language.label', "Language"),
			localize('agentSettings.language.description', "Switching requires a restart; open sessions are restored."),
			placeholder,
		);
		const store = this._renderStore;
		void this._languagePackService.getInstalledLanguages().then(languages => {
			if (store !== this._renderStore || !placeholder.isConnected) {
				return; // re-rendered while resolving
			}
			const current = Language.value();
			const choices: ISelectChoice[] = languages.map(language => ({
				value: language.id ?? '',
				label: language.label,
			}));
			if (!choices.some(choice => choice.value === current)) {
				choices.unshift({ value: current, label: current });
			}
			const select = renderSelect(store, this._contextViewService, choices, current, localize('agentSettings.language.label', "Language"), value => {
				const picked = languages.find(language => language.id === value);
				if (picked && picked.id !== current) {
					void this._localeService.setLocale(picked);
				}
			});
			placeholder.replaceWith(select);
		});
	}

	private _renderAccount(parent: HTMLElement): void {
		const section = appendSection(
			parent,
			localize('agentSettings.account', "Account"),
			localize('agentSettings.account.description', "Sign-in state for this window. Per-Agent routing lives on each Agent's page."),
		);
		const account = this._defaultAccountService.currentDefaultAccount;
		if (account) {
			const signOut = $('.agent-settings-inline-actions');
			appendLinkButton(this._renderStore, signOut, localize('agentSettings.signOut', "Sign out"), () => {
				void this._commandService.executeCommand('workbench.action.agenticSignOut');
			});
			appendSettingRow(section, localize('agentSettings.signedInAs', "Signed in"), account.accountName, signOut);
			return;
		}
		const signIn = $('.agent-settings-inline-actions');
		appendLinkButton(this._renderStore, signIn, localize('agentSettings.signIn', "Sign in"), () => {
			void this._commandService.executeCommand(AGENTIC_SIGN_IN_COMMAND_ID);
		});
		appendSettingRow(
			section,
			localize('agentSettings.signedOut', "Signed out"),
			localize('agentSettings.signedOut.description', "Some Agents can still run with their own credentials."),
			signIn,
		);
	}

	private _renderAgent(agent: IAgentSettingsAgent): void {
		const content = DOM.append(this._bodyEl, $('.agent-settings-content'));
		DOM.append(content, $('h1.agent-settings-title')).textContent = agent.label;
		const enabledSettingId = agent.enabledSettingId;
		const enabled = enabledSettingId ? this._configurationService.getValue<boolean>(enabledSettingId) === true : undefined;
		// An Agent that is on but not registered gets the restart notice below
		// instead: "enable it" is not the advice it needs.
		if (!agent.advertised && enabled !== true) {
			DOM.append(content, $('p.agent-settings-intro')).textContent = localize(
				'agentSettings.agent.notRegistered',
				"This Agent is allowed but not currently registered. Enable it below; some fields appear after it comes online.",
			);
		}

		if (enabledSettingId) {
			const enablement = appendSection(content, localize('agentSettings.enablement', "Enablement"));
			const schema = lookupConfigurationSchema(enabledSettingId);
			appendSettingRow(
				enablement,
				localize('agentSettings.enabled', "Enable this Agent"),
				typeof schema?.markdownDescription === 'string' ? schema.markdownDescription : schema?.description,
				renderCheckbox(this._renderStore, enabled === true, localize('agentSettings.enabled', "Enable this Agent"), async next => {
					if (next) {
						this._hotEnableDeadlines.set(agent.sessionTypeId, Date.now() + HOT_ENABLE_GRACE_MS);
					} else {
						this._hotEnableDeadlines.delete(agent.sessionTypeId);
					}
					await this._configurationService.updateValue(enabledSettingId, next);
				}),
			);
			this._renderRestartNotice(enablement, agent, enabled === true);
		}

		this._renderAgentAccount(content, agent);
		this._renderIdentity(content, agent);
		this._renderModels(content, agent);
		this._renderCustomizationSettings(content, agent);
		this._renderRuntime(content, agent);
		this._renderAdvanced(content, agent);
	}

	/**
	 * Renders the "restart to take effect" row when
	 * {@link resolveAgentRestartNotice} asks for it, and re-renders once at the
	 * end of a pending grace period so the row can appear on its own. A provider
	 * that registers in the meantime re-renders us through
	 * `onDidChangeProviders` and the row never appears at all.
	 */
	private _renderRestartNotice(parent: HTMLElement, agent: IAgentSettingsAgent, enabled: boolean): void {
		const { notice: kind, retryInMs } = resolveAgentRestartNotice({
			enabled,
			advertised: agent.advertised,
			sdkState: this._readAgentSdkStatus(agent)?.state,
			hotEnableDeadline: this._hotEnableDeadlines.get(agent.sessionTypeId),
			now: Date.now(),
		});
		if (kind === AgentRestartNotice.None) {
			this._hotEnableDeadlines.delete(agent.sessionTypeId);
			return;
		}
		if (kind === AgentRestartNotice.Pending) {
			if (retryInMs !== undefined) {
				const timer = setTimeout(() => this._refresh(), retryInMs);
				this._renderStore.add(toDisposable(() => clearTimeout(timer)));
			}
			return;
		}
		this._hotEnableDeadlines.delete(agent.sessionTypeId);
		const notice = DOM.append(parent, $('.agent-settings-notice'));
		notice.appendChild(renderIcon(Codicon.warning));
		DOM.append(notice, $('span.agent-settings-notice-text')).textContent = localize(
			'agentSettings.restartRequired',
			"This change takes effect after the agent host restarts.",
		);
		appendLinkButton(this._renderStore, notice, localize('agentSettings.restartNow', "Restart Now"), () => {
			void this._commandService.executeCommand(RESTART_LOCAL_AGENT_HOST_COMMAND_ID);
		});
	}

	/** The host's published readiness for this Agent's managed SDK, if it has one. */
	private _readAgentSdkStatus(agent: IAgentSettingsAgent) {
		const statuses = this._agentHostProvider(agent.providerId)?.getRootConfig()?.values[AgentSdkStatusConfigKey] as AgentSdkStatusMap | undefined;
		return statuses?.[agent.sessionTypeId];
	}

	private _renderAgentAccount(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		if (agent.accountKind !== AgentSettingsAccountKind.CodexChatGPT) {
			return;
		}
		const section = appendSection(
			parent,
			localize('agentSettings.agentAccount', "Account"),
			localize('agentSettings.agentAccount.description', "Connect the account this Agent uses for its native service and models."),
		);
		const account = this._codexAccountService.account;
		if (account.status === 'signedIn') {
			const actions = $('.agent-settings-inline-actions');
			appendLinkButton(this._renderStore, actions, localize('agentSettings.chatGPT.signOut', "Sign out"), () => this._codexAccountService.signOut());
			const detail = [account.email, account.planType].filter(Boolean).join(' · ')
				|| localize('agentSettings.chatGPT.account', "ChatGPT account");
			appendSettingRow(section, localize('agentSettings.chatGPT.signedIn', "Signed in to ChatGPT"), detail, actions);
			return;
		}
		if (account.status === 'downloading') {
			appendSettingRow(
				section,
				localize('agentSettings.chatGPT.preparing', "Preparing Codex"),
				localize('agentSettings.chatGPT.preparing.description', "Account controls will be available when the Codex agent is ready."),
				$('.agent-settings-inline-actions'),
			);
			return;
		}
		if (account.status === 'unavailable') {
			appendSettingRow(
				section,
				localize('agentSettings.chatGPT.unavailable', "ChatGPT sign-in unavailable"),
				localize('agentSettings.chatGPT.unavailable.description', "The current Codex agent does not expose account management."),
				$('.agent-settings-inline-actions'),
			);
			return;
		}
		const actions = $('.agent-settings-inline-actions');
		appendLinkButton(this._renderStore, actions, localize('agentSettings.chatGPT.signIn', "Sign in to ChatGPT"), () => this._codexAccountService.signIn());
		appendSettingRow(
			section,
			account.status === 'error'
				? localize('agentSettings.chatGPT.signInFailed', "ChatGPT sign-in needs attention")
				: account.status === 'signedOut'
					? localize('agentSettings.chatGPT.signedOut', "Not signed in to ChatGPT")
					: localize('agentSettings.chatGPT.unknown', "ChatGPT account"),
			localize('agentSettings.chatGPT.signedOut.description', "Sign in here to use Codex with your ChatGPT account."),
			actions,
		);
	}

	private _renderIdentity(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		const provider = this._agentHostProvider(agent.providerId);
		const root = provider?.getRootConfig();
		if (!agent.identityRootKeys.length || !root) {
			return;
		}
		const section = appendSection(
			parent,
			localize('agentSettings.identity', "Identity"),
			localize('agentSettings.identity.description', "How this Agent authenticates or which gateway it uses."),
		);
		for (const key of agent.identityRootKeys) {
			const schema = root.schema.properties[key];
			if (!schema || schema.readOnly) {
				continue;
			}
			this._renderConfigSchemaControl(section, schema, root.values[key], async value => {
				if (provider) {
					await this._setRootConfigValue(provider, key, value);
				}
			});
		}
	}

	private _renderModels(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		const models = getRegisteredLanguageModels(this._languageModelsService)
			.filter(model => model.metadata.targetChatSessionType === agent.chatSessionType && model.metadata.isUserSelectable !== false);
		if (!models.length) {
			return;
		}
		const section = appendSection(
			parent,
			localize('agentSettings.models', "Models"),
			localize('agentSettings.models.description', "Default model for this Agent. The composer lists this Agent's catalog, not a global model supermarket."),
		);
		const current = getStoredSelectedModel(this._storageService, ChatAgentLocation.Chat, agent.chatSessionType);
		const choices: ISelectChoice[] = [
			{ value: '', label: localize('agentSettings.models.agentDefault', "Agent default") },
			...models.map(model => ({ value: model.identifier, label: model.metadata.name })),
		];
		appendSettingRow(
			section,
			localize('agentSettings.defaultModel', "Default model"),
			undefined,
			renderSelect(this._renderStore, this._contextViewService, choices, current ?? '', localize('agentSettings.defaultModel', "Default model"), value => {
				if (!value) {
					this._storageService.remove(getSelectedModelStorageKey(ChatAgentLocation.Chat, agent.chatSessionType), StorageScope.PROFILE);
					return;
				}
				storeSelectedModel(this._storageService, ChatAgentLocation.Chat, agent.chatSessionType, value);
			}),
		);
	}

	private _renderCustomizationSettings(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		const provider = this._agentHostProvider(agent.providerId);
		const state = provider?.getRootState();
		const descriptor = agent.customization;
		const root = state?.config;
		if (!descriptor || !root) {
			return;
		}
		for (const group of new Set(descriptor.settings.map(setting => setting.group))) {
			const section = appendSection(parent, group);
			for (const setting of descriptor.settings.filter(item => item.group === group)) {
				const schema = root.schema.properties[setting.key];
				if (!schema || schema.readOnly) {
					continue;
				}
				this._renderConfigSchemaControl(section, schema, root.values[setting.key], async value => {
					if (provider) {
						await this._setRootConfigValue(provider, setting.key, value);
					}
				}, { kind: setting.kind, saveLabel: setting.saveLabel });
			}
		}
	}

	private _renderRuntime(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		if (!agent.runtimeSettingIds.length) {
			return;
		}
		const section = appendSection(
			parent,
			localize('agentSettings.runtime', "Runtime"),
			localize('agentSettings.runtime.description', "Home, binary, and SDK paths when this Agent advertises them."),
		);
		for (const key of agent.runtimeSettingIds) {
			const schema = lookupConfigurationSchema(key);
			if (!schema || (schema.type !== 'string' && schema.type !== 'boolean')) {
				continue;
			}
			const label = settingLabel(key, schema);
			const description = typeof schema.markdownDescription === 'string' ? schema.markdownDescription : schema.description;
			if (schema.type === 'boolean') {
				appendSettingRow(
					section,
					label,
					description,
					renderCheckbox(this._renderStore, this._configurationService.getValue<boolean>(key) === true, label, async next => {
						await this._configurationService.updateValue(key, next);
					}),
				);
				continue;
			}
			if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === 'string')) {
				const choices: ISelectChoice[] = schema.enum.map((value, index) => ({
					value,
					label: schema.enumItemLabels?.[index] ?? String(value),
				}));
				appendSettingRow(
					section,
					label,
					description,
					renderSelect(this._renderStore, this._contextViewService, choices, String(this._configurationService.getValue(key) ?? ''), label, async value => {
						await this._configurationService.updateValue(key, value);
					}),
				);
				continue;
			}
			appendSettingRow(
				section,
				label,
				description,
				renderTextInput(
					this._renderStore,
					this._contextViewService,
					String(this._configurationService.getValue<string>(key) ?? ''),
					label,
					undefined,
					value => void this._configurationService.updateValue(key, value),
				),
			);
		}
	}

	private _renderAdvanced(parent: HTMLElement, agent: IAgentSettingsAgent): void {
		const section = appendSection(
			parent,
			localize('agentSettings.advanced', "Advanced"),
			localize('agentSettings.advanced.description', "JSONC and native configuration files remain available as an expert escape hatch."),
		);
		const actions = DOM.append(section, $('.agent-settings-actions'));
		appendLinkButton(this._renderStore, actions, localize('agentSettings.openJsonc', "Open Settings in Editor"), () => {
			this._openEditorFromSettings({ resource: agentHostSettingsUri(agent.providerId), options: { pinned: true } });
		});
		const file = agent.customization?.configurationFile;
		const provider = this._agentHostProvider(agent.providerId);
		if (file && provider) {
			appendLinkButton(this._renderStore, actions, file.openLabel, () => {
				this._openEditorFromSettings({
					resource: provider.mapAgentHostResource(URI.parse(file.resource)),
					options: { pinned: true },
				});
			});
		}
	}

	private _openEditorFromSettings(input: { resource: URI; options: { pinned: true } }): void {
		closeAgentSettingsOverlay(this._commandService);
		void this._editorService.openEditor(input);
	}

	private _renderConfigSchemaControl(
		parent: HTMLElement,
		schema: ConfigPropertySchema,
		value: unknown,
		onChange: (value: unknown) => void,
		options?: { readonly kind?: 'multiline'; readonly saveLabel?: string },
	): void {
		if (schema.type === 'boolean') {
			appendSettingRow(
				parent,
				schema.title,
				schema.description,
				renderCheckbox(this._renderStore, value === true, schema.title, onChange),
			);
			return;
		}
		if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.every(item => typeof item === 'string')) {
			const choices: ISelectChoice[] = schema.enum.map((item, index) => ({
				value: String(item),
				label: schema.enumLabels?.[index] ?? String(item),
			}));
			appendSettingRow(
				parent,
				schema.title,
				schema.description,
				renderSelect(this._renderStore, this._contextViewService, choices, typeof value === 'string' ? value : undefined, schema.title, onChange),
			);
			return;
		}
		if (schema.type === 'string' && options?.kind === 'multiline') {
			appendSettingRow(
				parent,
				schema.title,
				schema.description,
				renderMultilineInput(
					this._renderStore,
					typeof value === 'string' ? value : '',
					schema.title,
					options.saveLabel ?? localize('agentSettings.save', "Save"),
					onChange,
				),
			);
			return;
		}
		if (schema.type === 'string') {
			appendSettingRow(
				parent,
				schema.title,
				schema.description,
				renderTextInput(this._renderStore, this._contextViewService, typeof value === 'string' ? value : '', schema.title, undefined, onChange),
			);
		}
	}

	/**
	 * Writes a root-config value, marking the write as "our own" for its
	 * duration. {@link _bindProviderListeners} skips the resulting
	 * {@link IAgentHostSessionsProvider.onDidChangeRootConfig} refresh while a
	 * write is outstanding, since a full {@link _render} would otherwise drop
	 * focus and any uncommitted text in other fields on every save.
	 */
	private async _setRootConfigValue(provider: IAgentHostSessionsProvider, key: string, value: unknown): Promise<void> {
		const pending = (this._pendingOwnRootConfigWrites.get(provider.id) ?? 0) + 1;
		this._pendingOwnRootConfigWrites.set(provider.id, pending);
		try {
			await provider.setRootConfigValue(key, value);
		} catch (error) {
			this._notificationService.error(error);
		} finally {
			const remaining = (this._pendingOwnRootConfigWrites.get(provider.id) ?? 1) - 1;
			if (remaining <= 0) {
				this._pendingOwnRootConfigWrites.delete(provider.id);
			} else {
				this._pendingOwnRootConfigWrites.set(provider.id, remaining);
			}
		}
	}

	private _bindProviderListeners(): void {
		this._providerListeners.clear();
		for (const provider of this._sessionsProvidersService.getProviders()) {
			if (isAgentHostProvider(provider)) {
				this._providerListeners.add(provider.onDidChangeRootConfig(() => {
					if (this._pendingOwnRootConfigWrites.has(provider.id)) {
						return;
					}
					this._refresh();
				}));
			}
		}
	}

	private _readDefaultPermissions(): ChatDefaultPermissionLevel {
		const remembered = readRememberedSessionConfig(this._storageService)[SessionConfigKey.AutoApprove];
		const configured = this._configurationService.getValue<IChatDefaultConfiguration>(ChatConfiguration.DefaultConfiguration)?.approvals;
		return toUiDefaultPermission(remembered) ?? toUiDefaultPermission(configured) ?? ChatDefaultPermissionLevel.Manual;
	}

	private _agentHostProvider(providerId: string) {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		return provider && isAgentHostProvider(provider) ? provider : undefined;
	}
}

function toUiDefaultPermission(value: unknown): ChatDefaultPermissionLevel | undefined {
	const level = getChatPermissionLevelFromDefaultConfiguration(value)
		?? (value === ChatPermissionLevel.Default || value === ChatPermissionLevel.Assisted || value === ChatPermissionLevel.AutoApprove ? value : undefined);
	if (level === ChatPermissionLevel.Assisted) {
		return ChatDefaultPermissionLevel.Assisted;
	}
	if (level === ChatPermissionLevel.AutoApprove) {
		return ChatDefaultPermissionLevel.AllowAll;
	}
	if (level === ChatPermissionLevel.Default) {
		return ChatDefaultPermissionLevel.Manual;
	}
	return undefined;
}

function allConfigurationKeys(): Set<string> {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	return new Set([
		...Object.keys(registry.getConfigurationProperties()),
		...Object.keys(registry.getExcludedConfigurationProperties()),
	]);
}

function lookupConfigurationSchema(key: string): IRegisteredConfigurationPropertySchema | undefined {
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	return registry.getConfigurationProperties()[key] ?? registry.getExcludedConfigurationProperties()[key];
}

function settingLabel(key: string, schema: IRegisteredConfigurationPropertySchema | undefined): string {
	if (typeof schema?.title === 'string' && schema.title) {
		return schema.title;
	}
	const suffix = key.split('.').pop() ?? key;
	return suffix.replace(/([A-Z])/g, ' $1').replace(/^./, character => character.toUpperCase()).trim();
}
