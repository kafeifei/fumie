/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AGENT_HOST_COPILOT_CLI_SESSION_TYPE } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostToolSetEnablementService.js';
import { AICustomizationListWidget } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationListWidget.js';
import {
	CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_HARNESS,
	CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION,
} from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.js';
import { AICustomizationManagementEditor } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { AICustomizationWelcomePage } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationWelcomePage.js';
import { CustomizationMigrationCategoryId } from '../../../../workbench/contrib/chat/browser/aiCustomization/customizationMigrationCategories.js';
import { CustomizationLocationPicker } from '../../../../workbench/contrib/chat/browser/aiCustomization/customizationCreatorService.js';
import { EmbeddedAgentPluginDetail } from '../../../../workbench/contrib/chat/browser/aiCustomization/embeddedAgentPluginDetail.js';
import { EmbeddedMcpServerDetail } from '../../../../workbench/contrib/chat/browser/aiCustomization/embeddedMcpServerDetail.js';
import { McpListWidget } from '../../../../workbench/contrib/chat/browser/aiCustomization/mcpListWidget.js';
import { PluginListWidget } from '../../../../workbench/contrib/chat/browser/aiCustomization/pluginListWidget.js';
import { ToolsListWidget } from '../../../../workbench/contrib/chat/browser/aiCustomization/toolsListWidget.js';
import { IAICustomizationWorkspaceService, AICustomizationManagementSection, AICustomizationSources } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { AGENT_MD_FILENAME } from '../../../../workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.js';
import { PromptsType, Target } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { PromptsStorage } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { showConfigureHooksQuickPick } from '../../../../workbench/contrib/chat/browser/promptSyntax/hookActions.js';
import { NEW_AGENT_COMMAND_ID, NEW_INSTRUCTIONS_COMMAND_ID, NEW_PROMPT_COMMAND_ID, NEW_SKILL_COMMAND_ID, type INewPromptOptions } from '../../../../workbench/contrib/chat/browser/promptSyntax/newPromptFileActions.js';
import { showNoFoldersDialog } from '../../../../workbench/contrib/chat/browser/promptSyntax/pickers/askForPromptSourceFolder.js';
import { findHarnessIdForSession } from '../../sessions/browser/customizationHarnessLookup.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { NEW_SESSION_ACTION_ID } from '../../chat/common/constants.js';
import { closeAgentSettingsOverlay, readStoredSessionTypePick } from './agentSettings.js';
import { type AgentSettingsCustomizationSection, type IAgentSettingsAgent } from './agentSettingsCatalog.js';

const $ = DOM.$;

const PROMPTS_SECTIONS = new Set<string>([
	AICustomizationManagementSection.Agents,
	AICustomizationManagementSection.Skills,
	AICustomizationManagementSection.Instructions,
	AICustomizationManagementSection.Prompts,
	AICustomizationManagementSection.Hooks,
]);

export interface IAgentSettingsCustomizationsHostOptions {
	readonly onSelectSection: (section: AgentSettingsCustomizationSection, options?: { showMarketplace?: boolean }) => void;
}

/**
 * Hosts the existing Customizations welcome page and section widgets inside
 * the Settings custom view. Settings left-nav owns section switching; this
 * pane is the management editor's content column, not a second editor chrome.
 */
export class AgentSettingsCustomizationsHost extends Disposable {

	readonly element: HTMLElement;

	private readonly _contentInner: HTMLElement;
	private readonly _widgetStore = this._register(new DisposableStore());
	private readonly _sectionContextKey: IContextKey<string>;
	private readonly _harnessContextKey: IContextKey<string>;

	private _welcomePage: AICustomizationWelcomePage | undefined;
	private _promptsContainer: HTMLElement | undefined;
	private _listWidget: AICustomizationListWidget | undefined;
	private _mcpContainer: HTMLElement | undefined;
	private _mcpListWidget: McpListWidget | undefined;
	private _mcpDetailContainer: HTMLElement | undefined;
	private _mcpDetail: EmbeddedMcpServerDetail | undefined;
	private _pluginContainer: HTMLElement | undefined;
	private _pluginListWidget: PluginListWidget | undefined;
	private _pluginDetailContainer: HTMLElement | undefined;
	private _pluginDetail: EmbeddedAgentPluginDetail | undefined;
	private _toolsContainer: HTMLElement | undefined;
	private _toolsListWidget: ToolsListWidget | undefined;

	private _section: AgentSettingsCustomizationSection = 'overview';
	private _showMarketplace = false;
	private _viewMode: 'list' | 'mcpDetail' | 'pluginDetail' = 'list';
	private _width = 0;
	private _height = 0;
	private _agents: readonly IAgentSettingsAgent[] = [];

	constructor(
		options: IAgentSettingsCustomizationsHostOptions,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICustomizationHarnessService private readonly _harnessService: ICustomizationHarnessService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@IAICustomizationWorkspaceService private readonly _workspaceService: IAICustomizationWorkspaceService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IFileService private readonly _fileService: IFileService,
		@ISessionsPartService private readonly _sessionsPartService: ISessionsPartService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._sectionContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_SECTION.bindTo(contextKeyService);
		this._harnessContextKey = CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_HARNESS.bindTo(contextKeyService);

		this.element = $('.agent-settings-customizations.ai-customization-management-editor');
		this._contentInner = DOM.append(this.element, $('.content-inner'));
		this._createWidgets(options);
		this._register(autorun(reader => {
			this._sessionsService.activeSession.read(reader);
			this._harnessService.availableHarnesses.read(reader);
			this._harnessService.activeHarness.read(reader);
			this._syncHarnessFromDefaultAgent();
		}));
	}

	setAgents(agents: readonly IAgentSettingsAgent[]): void {
		this._agents = agents;
		this._syncHarnessFromDefaultAgent();
	}

	show(section: AgentSettingsCustomizationSection, options?: { showMarketplace?: boolean }): void {
		this._section = section;
		this._showMarketplace = !!options?.showMarketplace;
		this._viewMode = 'list';
		this._syncHarnessFromDefaultAgent();
		this._sectionContextKey.set(section === 'overview' ? '' : section);
		this._harnessContextKey.set(this._harnessService.activeHarness.get());
		if (PROMPTS_SECTIONS.has(section) && this._listWidget) {
			void this._listWidget.setSection(section as AICustomizationManagementSection);
		}
		if (this._showMarketplace && section === AICustomizationManagementSection.McpServers) {
			this._mcpListWidget?.showBrowseMarketplace();
		} else if (this._showMarketplace && section === AICustomizationManagementSection.Plugins) {
			this._pluginListWidget?.showBrowseMarketplace();
		}
		this._updateVisibility();
		this.layout(this._width, this._height);
		this._focusActive();
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		if (width <= 0 || height <= 0) {
			return;
		}
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		const innerWidth = Math.max(0, width - 24);
		const innerHeight = Math.max(0, height - 16);
		this._listWidget?.layout(innerHeight, innerWidth);
		this._mcpListWidget?.layout(innerHeight, innerWidth);
		this._pluginListWidget?.layout(innerHeight, innerWidth);
		this._toolsListWidget?.layout(innerHeight, innerWidth);
	}

	override dispose(): void {
		this._sectionContextKey.reset();
		this._harnessContextKey.reset();
		super.dispose();
	}

	private _createWidgets(options: IAgentSettingsCustomizationsHostOptions): void {
		this._welcomePage = this._widgetStore.add(new AICustomizationWelcomePage(
			this._contentInner,
			this._workspaceService.welcomePageFeatures,
			{
				selectSection: section => options.onSelectSection(section),
				selectSectionWithMarketplace: section => options.onSelectSection(section, { showMarketplace: true }),
				closeEditor: () => this._closeSettings(),
				migrateCustomizations: categoryId => void this._openCustomizationMigrationEditor(categoryId),
				prefillChat: (query, prefillOptions) => void this._prefillChat(query, prefillOptions),
			},
			this._commandService,
			this._workspaceService,
			this._hoverService,
			this._harnessService.getActiveDescriptor().label,
		));
		this._rebuildWelcomeCards();

		this._promptsContainer = DOM.append(this._contentInner, $('.prompts-content-container'));
		this._listWidget = this._widgetStore.add(this._instantiationService.createInstance(AICustomizationListWidget));
		this._promptsContainer.appendChild(this._listWidget.element);
		this._widgetStore.add(this._listWidget.onDidSelectItem(item => {
			void this._openEditorFromSettings({ resource: item.uri, options: { pinned: true } });
		}));
		this._widgetStore.add(this._listWidget.onDidRequestCreate(type => {
			this._closeSettings();
			void this._workspaceService.generateCustomization(type);
		}));
		this._widgetStore.add(this._listWidget.onDidRequestCreateManual(({ type, target, rootFileName }) => {
			void this._createManual(type, target, rootFileName);
		}));

		this._mcpContainer = DOM.append(this._contentInner, $('.mcp-content-container'));
		this._mcpListWidget = this._widgetStore.add(this._instantiationService.createInstance(McpListWidget));
		this._mcpListWidget.setCloseCustomizationEditor(async () => this._closeSettings());
		this._mcpContainer.appendChild(this._mcpListWidget.element);
		this._mcpDetailContainer = DOM.append(this._contentInner, $('.mcp-detail-container'));
		this._mcpDetail = this._widgetStore.add(this._instantiationService.createInstance(EmbeddedMcpServerDetail, this._mcpDetailContainer));
		this._appendDetailBackButton(this._mcpDetail.leadingSlot, () => {
			this._viewMode = 'list';
			this._mcpDetail?.clearInput();
			this._updateVisibility();
			this._mcpListWidget?.focusSearch();
		});
		this._widgetStore.add(this._mcpListWidget.onDidSelectServer(server => {
			this._viewMode = 'mcpDetail';
			this._mcpDetail?.setInput(server);
			this._updateVisibility();
		}));
		this._widgetStore.add(this._mcpListWidget.onDidRequestShowPlugin(item => {
			options.onSelectSection(AICustomizationManagementSection.Plugins);
			this._viewMode = 'pluginDetail';
			this._pluginDetail?.setInput(item);
			this._updateVisibility();
		}));

		this._pluginContainer = DOM.append(this._contentInner, $('.plugin-content-container'));
		this._pluginListWidget = this._widgetStore.add(this._instantiationService.createInstance(PluginListWidget));
		this._pluginContainer.appendChild(this._pluginListWidget.element);
		this._pluginDetailContainer = DOM.append(this._contentInner, $('.plugin-detail-container'));
		this._pluginDetail = this._widgetStore.add(this._instantiationService.createInstance(EmbeddedAgentPluginDetail, this._pluginDetailContainer));
		this._appendDetailBackButton(this._pluginDetail.leadingSlot, () => {
			this._viewMode = 'list';
			this._pluginDetail?.clearInput();
			this._updateVisibility();
			this._pluginListWidget?.focusSearch();
		});
		this._widgetStore.add(this._pluginListWidget.onDidSelectPlugin(item => {
			this._viewMode = 'pluginDetail';
			this._pluginDetail?.setInput(item);
			this._updateVisibility();
		}));

		this._toolsContainer = DOM.append(this._contentInner, $('.tools-content-container'));
		this._toolsListWidget = this._widgetStore.add(this._instantiationService.createInstance(ToolsListWidget, AGENT_HOST_COPILOT_CLI_SESSION_TYPE));
		this._toolsContainer.appendChild(this._toolsListWidget.element);

		this._updateVisibility();
	}

	private _rebuildWelcomeCards(): void {
		const hidden = new Set(this._harnessService.getActiveDescriptor().hiddenSections ?? []);
		const visible = new Set<AICustomizationManagementSection>();
		for (const section of [
			AICustomizationManagementSection.Agents,
			AICustomizationManagementSection.Skills,
			AICustomizationManagementSection.Instructions,
			AICustomizationManagementSection.Hooks,
			AICustomizationManagementSection.McpServers,
			AICustomizationManagementSection.Plugins,
			AICustomizationManagementSection.Tools,
		]) {
			if (!hidden.has(section)) {
				visible.add(section);
			}
		}
		this._welcomePage?.rebuildCards(visible);
		this._welcomePage?.setHarnessLabel(this._harnessService.getActiveDescriptor().label);
	}

	private _syncHarnessFromDefaultAgent(): void {
		const session = this._sessionsService.activeSession.get();
		if (session) {
			const harnessId = findHarnessIdForSession(session, this._harnessService);
			if (harnessId && this._harnessService.activeSessionResource.get().toString() !== session.resource.toString()) {
				this._harnessService.setActiveSession(session.resource);
			}
			this._harnessContextKey.set(this._harnessService.activeHarness.get());
			this._rebuildWelcomeCards();
			return;
		}
		const stored = readStoredSessionTypePick(this._storageService);
		const agent = this._agents.find(candidate => candidate.sessionTypeId === stored?.sessionTypeId) ?? this._agents[0];
		if (!agent) {
			this._rebuildWelcomeCards();
			return;
		}
		const harnessId = this._harnessService.findHarnessById(agent.chatSessionType)?.id
			?? this._harnessService.findHarnessById(agent.sessionTypeId)?.id;
		if (harnessId) {
			const resource = this._harnessService.getSessionResourceForHarness(harnessId);
			if (this._harnessService.activeSessionResource.get().toString() !== resource.toString()) {
				this._harnessService.setActiveSession(resource);
			}
		}
		this._harnessContextKey.set(this._harnessService.activeHarness.get());
		this._rebuildWelcomeCards();
	}

	private _updateVisibility(): void {
		const isOverview = this._section === 'overview' && this._viewMode === 'list';
		if (this._welcomePage) {
			this._welcomePage.container.style.display = isOverview ? '' : 'none';
		}
		if (this._promptsContainer) {
			this._promptsContainer.style.display = this._viewMode === 'list' && PROMPTS_SECTIONS.has(this._section) ? '' : 'none';
		}
		if (this._mcpContainer) {
			this._mcpContainer.style.display = this._viewMode === 'list' && this._section === AICustomizationManagementSection.McpServers ? '' : 'none';
		}
		if (this._mcpDetailContainer) {
			this._mcpDetailContainer.style.display = this._viewMode === 'mcpDetail' ? '' : 'none';
		}
		if (this._pluginContainer) {
			this._pluginContainer.style.display = this._viewMode === 'list' && this._section === AICustomizationManagementSection.Plugins ? '' : 'none';
		}
		if (this._pluginDetailContainer) {
			this._pluginDetailContainer.style.display = this._viewMode === 'pluginDetail' ? '' : 'none';
		}
		if (this._toolsContainer) {
			this._toolsContainer.style.display = this._viewMode === 'list' && this._section === AICustomizationManagementSection.Tools ? '' : 'none';
		}
	}

	private _focusActive(): void {
		if (this._section === 'overview') {
			this._welcomePage?.focus();
			return;
		}
		if (this._section === AICustomizationManagementSection.McpServers) {
			this._mcpListWidget?.focusSearch();
			return;
		}
		if (this._section === AICustomizationManagementSection.Plugins) {
			this._pluginListWidget?.focusSearch();
			return;
		}
		if (this._section === AICustomizationManagementSection.Tools) {
			this._toolsListWidget?.focusSearch();
			return;
		}
		this._listWidget?.focusSearch();
	}

	private _appendDetailBackButton(slot: HTMLElement, onClick: () => void): void {
		const button = DOM.append(slot, $('button.section-back-arrow-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', localize('agentSettings.customizations.back', "Back to list"));
		const icon = DOM.append(button, $('span.section-back-arrow-icon'));
		icon.classList.add('codicon', 'codicon-arrow-left');
		this._widgetStore.add(DOM.addDisposableListener(button, 'click', onClick));
	}

	private _closeSettings(): void {
		closeAgentSettingsOverlay(this._commandService);
	}

	private _openEditorFromSettings(input: { resource: URI; options: { pinned: true } }) {
		this._closeSettings();
		return this._editorService.openEditor(input);
	}

	private async _createManual(type: PromptsType, target: 'local' | 'user' | 'workspace-root', rootFileName?: string): Promise<void> {
		if (target === 'workspace-root') {
			const projectRoot = this._workspaceService.getActiveProjectRoot();
			if (!projectRoot) {
				return;
			}
			const override = this._section !== 'overview'
				? this._harnessService.getActiveDescriptor().sectionOverrides?.get(this._section)
				: undefined;
			const fileName = rootFileName ?? override?.rootFile ?? AGENT_MD_FILENAME;
			const fileUri = URI.joinPath(projectRoot, fileName);
			if (!await this._fileService.exists(fileUri)) {
				await this._fileService.createFile(fileUri);
			}
			await this._openEditorFromSettings({ resource: fileUri, options: { pinned: true } });
			return;
		}
		if (type === PromptsType.hook) {
			await this._instantiationService.invokeFunction(showConfigureHooksQuickPick, {
				target: Target.GitHubCopilot,
				openEditor: async resource => {
					await this._openEditorFromSettings({ resource, options: { pinned: true } });
				},
			});
			return;
		}
		const picker = this._instantiationService.createInstance(CustomizationLocationPicker);
		const targetDir = await picker.resolveTargetDirectoryWithPicker(
			this._harnessService.activeSessionResource.get(),
			type,
			target,
		);
		if (targetDir === null) {
			return;
		}
		if (targetDir === undefined) {
			await this._instantiationService.invokeFunction(showNoFoldersDialog, type);
			return;
		}
		const override = this._section !== 'overview'
			? this._harnessService.getActiveDescriptor().sectionOverrides?.get(this._section)
			: undefined;
		const createOptions: INewPromptOptions = {
			targetFolder: targetDir,
			targetStorage: target === AICustomizationSources.user ? PromptsStorage.user : PromptsStorage.local,
			fileExtension: override?.fileExtension,
		};
		const commandId = commandIdForPromptType(type);
		if (!commandId) {
			return;
		}
		this._closeSettings();
		await this._commandService.executeCommand(commandId, createOptions);
	}

	private async _openCustomizationMigrationEditor(categoryId: CustomizationMigrationCategoryId): Promise<void> {
		this._closeSettings();
		const input = AICustomizationManagementEditorInput.getOrCreate();
		const pane = await this._editorService.openEditor(input, { pinned: true });
		if (pane instanceof AICustomizationManagementEditor) {
			pane.showCustomizationMigrationPage(categoryId);
		}
	}

	/**
	 * Prefills or sends `query` into the Agents chat input. The Agents window
	 * hosts chat as a grid leaf ({@link SessionView}) managed by
	 * {@link ISessionsPartService}, not as a registered `IViewsService` view,
	 * so the target is looked up by session id rather than by view id.
	 */
	private async _prefillChat(query: string, options?: { isPartialQuery?: boolean; newChat?: boolean }): Promise<void> {
		if (options?.newChat) {
			await this._commandService.executeCommand(NEW_SESSION_ACTION_ID);
		}
		// A brand-new session starts as the placeholder (undefined-id) grid slot
		// until its first message commits it; an existing session is targeted by
		// its active session id.
		const sessionId = options?.newChat ? undefined : this._sessionsService.activeSession.get()?.sessionId;
		const chatView = this._sessionsPartService.getSessionView(sessionId);
		if (options?.isPartialQuery) {
			chatView?.prefillInput(query);
		} else {
			chatView?.sendQuery(query);
		}
	}
}

function commandIdForPromptType(type: PromptsType): string | undefined {
	switch (type) {
		case PromptsType.prompt: return NEW_PROMPT_COMMAND_ID;
		case PromptsType.instructions: return NEW_INSTRUCTIONS_COMMAND_ID;
		case PromptsType.agent: return NEW_AGENT_COMMAND_ID;
		case PromptsType.skill: return NEW_SKILL_COMMAND_ID;
		default: return undefined;
	}
}
