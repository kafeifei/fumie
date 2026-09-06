/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSettingsOverlay.css';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { type AgentSettingsNavId } from './agentSettings.js';
import { AgentSettingsOverlayVisibleContext, IAgentSettingsOverlayService } from './agentSettingsOverlayService.js';
import { AgentSettingsWidget } from './agentSettingsWidget.js';

const $ = DOM.$;



/**
 * Wide enough for the Models table to fit without horizontal scrolling:
 * table minimum 888px (usage-based-billing column set) + 48px body padding
 * + 201px nav (incl. border) + 24px models-host left padding + 24px widget
 * right padding = 1185px, plus a little slack for rounding.
 */
const OVERLAY_MAX_WIDTH = 1190;
const OVERLAY_MARGIN = 48;

export class AgentSettingsOverlayService extends Disposable implements IAgentSettingsOverlayService {

	declare readonly _serviceBrand: undefined;

	private _current: { readonly widget: AgentSettingsWidget; readonly store: DisposableStore } | undefined;
	private readonly _visibleContextKey: IContextKey<boolean>;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._visibleContextKey = AgentSettingsOverlayVisibleContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.close()));
	}

	open(navId?: AgentSettingsNavId): void {
		if (this._current) {
			if (navId) {
				this._current.widget.selectNav(navId);
			}
			this._current.widget.focus();
			return;
		}

		const store = new DisposableStore();
		const container = this._layoutService.activeContainer;
		const targetWindow = DOM.getWindow(container);
		const previouslyFocused = targetWindow.document.activeElement instanceof targetWindow.HTMLElement
			? targetWindow.document.activeElement
			: undefined;

		const backdrop = DOM.append(container, $('.agent-settings-overlay-backdrop'));
		store.add(toDisposable(() => backdrop.remove()));
		store.add(DOM.addDisposableListener(backdrop, DOM.EventType.MOUSE_DOWN, e => {
			if (e.target === backdrop) {
				this.close();
			}
		}));

		const panel = DOM.append(backdrop, $('.agent-settings-overlay', {
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': localize('agentSettings.viewTitle', "Settings"),
		}));

		const header = DOM.append(panel, $('.agent-settings-overlay-header'));
		const titles = DOM.append(header, $('.agent-settings-overlay-titles'));
		DOM.append(titles, $('h1.agent-settings-overlay-title')).textContent = localize('agentSettings.viewTitle', "Settings");
		DOM.append(titles, $('p.agent-settings-overlay-description')).textContent =
			localize('agentSettings.viewDescription', "Defaults and per-Agent configuration for this window.");

		const closeButton = DOM.append(header, $('button.agent-settings-overlay-close', {
			type: 'button',
			'aria-label': localize('agentSettings.close', "Close"),
			title: localize('agentSettings.close', "Close"),
		}));
		closeButton.appendChild(renderIcon(Codicon.close));
		store.add(DOM.addDisposableListener(closeButton, DOM.EventType.CLICK, () => this.close()));

		const body = DOM.append(panel, $('.agent-settings-overlay-body'));
		let widget: AgentSettingsWidget;
		try {
			widget = store.add(this._instantiationService.createInstance(AgentSettingsWidget));
		} catch (err) {
			// Without this the backdrop stays behind as a dead full-window layer and
			// the cause never surfaces anywhere, which reads as "Settings is empty".
			store.dispose();
			onUnexpectedError(err);
			return;
		}
		body.appendChild(widget.element);

		// Escape / Cmd+W close via keybindings on AgentSettingsOverlayVisibleContext
		// (see agentSettings.contribution.ts), not via a DOM listener: keydown on
		// the panel only fires while focus is inside it, which is not guaranteed.
		this._visibleContextKey.set(true);
		store.add(toDisposable(() => this._visibleContextKey.set(false)));

		const layout = () => {
			const containerRect = container.getBoundingClientRect();
			panel.style.width = `${Math.min(OVERLAY_MAX_WIDTH, Math.max(0, containerRect.width - OVERLAY_MARGIN * 2))}px`;
			panel.style.height = `${Math.max(0, containerRect.height - OVERLAY_MARGIN * 2)}px`;
			widget.layout(DOM.getContentWidth(body), DOM.getContentHeight(body));
		};
		store.add(this._layoutService.onDidLayoutActiveContainer(() => layout()));
		layout();

		store.add(toDisposable(() => {
			this._current = undefined;
			previouslyFocused?.focus();
		}));

		this._current = { widget, store };

		if (navId) {
			widget.selectNav(navId);
		}
		widget.focus();
	}

	close(): void {
		const current = this._current;
		if (current) {
			this._current = undefined;
			current.store.dispose();
		}
	}
}

registerSingleton(IAgentSettingsOverlayService, AgentSettingsOverlayService, InstantiationType.Delayed);
