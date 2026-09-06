/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { emptyProgressRunner, IEditorProgressService, IProgressRunner } from '../../../../platform/progress/common/progress.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ChatModelsWidget } from '../../../../workbench/contrib/chat/browser/chatManagement/chatModelsWidget.js';
import { ILanguageModelsConfigurationService } from '../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { IProviderGroupRefreshOutcome, ProviderModelListRefresher } from '../common/providerModelListRefresh.js';

const $ = DOM.$;

/**
 * The upstream widget reports its initial load through the editor group's
 * progress bar. Settings is a custom view, not an editor pane, so there is no
 * such bar to drive; the load is awaited without chrome.
 */
class ChromelessEditorProgressService implements IEditorProgressService {

	declare readonly _serviceBrand: undefined;

	show(_total: unknown, _delay?: unknown): IProgressRunner {
		return emptyProgressRunner;
	}

	async showWhile(promise: Promise<unknown>, _delay?: number): Promise<void> {
		await promise;
	}
}

/**
 * Hosts the upstream Manage Language Models widget inside the Settings custom
 * view. Model visibility and provider configuration stay entirely upstream —
 * this is the widget's container, not a second models UI. Fumie-owned chrome
 * (the provider model-list refresh toolbar) lives here, not in the widget.
 */
export class AgentSettingsModelsHost extends Disposable {

	readonly element: HTMLElement = $('.agent-settings-models');

	private readonly _widget = this._register(new MutableDisposable<ChatModelsWidget>());
	private readonly _toolbar = this._register(new MutableDisposable<DisposableStore>());
	private readonly _instantiationService: IInstantiationService;
	private readonly _refresher: ProviderModelListRefresher;
	private _toolbarElement: HTMLElement | undefined;
	private _width = 0;
	private _height = 0;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILanguageModelsConfigurationService languageModelsConfigurationService: ILanguageModelsConfigurationService,
	) {
		super();
		const scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		this._instantiationService = this._register(instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedContextKeyService],
			[IEditorProgressService, new ChromelessEditorProgressService()],
		)));
		this._refresher = this._instantiationService.createInstance(ProviderModelListRefresher);
		this._register(languageModelsConfigurationService.onDidChangeLanguageModelGroups(() => this._updateToolbar()));
	}

	/** Called once the container is visible, so the widget can measure itself. */
	show(): void {
		let widget = this._widget.value;
		if (!widget) {
			widget = this._instantiationService.createInstance(ChatModelsWidget);
			this.element.appendChild(widget.element);
			this._widget.value = widget;
			this._updateToolbar();
		}
		this.layout(this._width, this._height);
		widget.render();
		widget.focusSearch();
	}

	/** Navigating away drops the table, its search editor and their listeners. */
	hide(): void {
		this._widget.clear();
		this._toolbar.clear();
		this._toolbarElement = undefined;
		DOM.clearNode(this.element);
	}

	layout(width: number, height: number): void {
		this._width = width;
		this._height = height;
		if (width <= 0 || height <= 0) {
			return;
		}
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		const toolbarHeight = this._toolbarElement?.offsetHeight ?? 0;
		this._widget.value?.layout(height - 15 - toolbarHeight, width - 24);
	}

	/**
	 * The refreshable groups come from the configuration service's in-memory
	 * snapshot, which is still empty while the first parse of the models file is
	 * in flight. The toolbar therefore follows the groups instead of being
	 * decided once, when the view is first shown.
	 */
	private _updateToolbar(): void {
		const shouldShow = !!this._widget.value && this._refresher.getRefreshableGroups().length > 0;
		if (shouldShow === !!this._toolbarElement) {
			return;
		}
		this._toolbar.clear();
		this._toolbarElement = undefined;
		if (!shouldShow) {
			this.layout(this._width, this._height);
			return;
		}
		const store = new DisposableStore();
		this._toolbar.value = store;
		const toolbarElement = DOM.prepend(this.element, $('.agent-settings-models-toolbar'));
		this._toolbarElement = toolbarElement;
		store.add(toDisposable(() => toolbarElement.remove()));
		const button = store.add(new Button(toolbarElement, { ...defaultButtonStyles, secondary: true }));
		button.label = localize('agentSettings.models.refresh', "Refresh Model Lists");
		button.setTitle(localize('agentSettings.models.refresh.title', "Fetch the current model list from each Custom Endpoint provider and update the configuration"));
		store.add(button.onDidClick(async () => {
			button.enabled = false;
			try {
				const outcomes = await this._refresher.refreshAll(CancellationToken.None);
				this._notifyOutcomes(outcomes);
			} finally {
				button.enabled = true;
			}
		}));
		this.layout(this._width, this._height);
	}

	private _notifyOutcomes(outcomes: readonly IProviderGroupRefreshOutcome[]): void {
		const failed = outcomes.filter(outcome => outcome.error);
		const changed = outcomes.filter(outcome => !outcome.error && (outcome.added.length || outcome.removed.length || outcome.renamed.length));
		const messages: string[] = [];
		for (const outcome of changed) {
			const parts: string[] = [];
			if (outcome.added.length) {
				parts.push(localize('agentSettings.models.refresh.added', "{0} added ({1})", outcome.added.length, outcome.added.join(', ')));
			}
			if (outcome.removed.length) {
				parts.push(localize('agentSettings.models.refresh.removed', "{0} removed ({1})", outcome.removed.length, outcome.removed.join(', ')));
			}
			if (outcome.renamed.length) {
				parts.push(localize('agentSettings.models.refresh.renamed', "{0} renamed ({1})", outcome.renamed.length, outcome.renamed.join(', ')));
			}
			messages.push(`${outcome.groupName}: ${parts.join('; ')}`);
		}
		for (const outcome of failed) {
			messages.push(localize('agentSettings.models.refresh.failed', "{0}: refresh failed — {1}", outcome.groupName, outcome.error));
		}
		if (!messages.length) {
			this._notificationService.info(localize('agentSettings.models.refresh.upToDate', "All provider model lists are up to date."));
			return;
		}
		this._notificationService.notify({
			severity: failed.length ? Severity.Warning : Severity.Info,
			message: messages.join('\n'),
		});
	}
}
