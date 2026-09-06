/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

const $ = DOM.$;

export interface ISelectChoice<T extends string = string> {
	readonly value: T;
	readonly label: string;
}

export function appendSection(parent: HTMLElement, title: string, description?: string): HTMLElement {
	const section = DOM.append(parent, $('.agent-settings-section'));
	DOM.append(section, $('h2.agent-settings-section-title')).textContent = title;
	if (description) {
		DOM.append(section, $('p.agent-settings-section-description')).textContent = description;
	}
	return section;
}

export function appendSettingRow(parent: HTMLElement, label: string, description: string | undefined, control: HTMLElement): HTMLElement {
	const row = DOM.append(parent, $('.agent-settings-row'));
	const labels = DOM.append(row, $('.agent-settings-labels'));
	DOM.append(labels, $('.agent-settings-label')).textContent = label;
	if (description) {
		DOM.append(labels, $('.agent-settings-description')).textContent = description;
	}
	DOM.append(row, $('.agent-settings-control', undefined, control));
	return row;
}

/** A row reporting something the page cannot do, with no control to press. */
export function appendUnavailableRow(parent: HTMLElement, label: string, description: string): HTMLElement {
	const row = appendSettingRow(parent, label, description, $('.agent-settings-inline-actions'));
	row.classList.add('agent-settings-row-unavailable');
	return row;
}

export function renderCheckbox(
	store: DisposableStore,
	checked: boolean,
	ariaLabel: string,
	onChange: (checked: boolean) => void,
): HTMLElement {
	const host = $('.agent-settings-checkbox-host');
	const checkbox = store.add(new Checkbox(ariaLabel, checked, { ...defaultCheckboxStyles, size: 16 }));
	host.appendChild(checkbox.domNode);
	store.add(checkbox.onChange(() => onChange(checkbox.checked)));
	return host;
}

export function renderSelect<T extends string>(
	store: DisposableStore,
	contextViewService: IContextViewService,
	choices: readonly ISelectChoice<T>[],
	value: string | undefined,
	ariaLabel: string,
	onChange: (value: T) => void,
): HTMLElement {
	const host = $('.agent-settings-select');
	const selected = Math.max(0, choices.findIndex(choice => choice.value === value));
	const options: ISelectOptionItem[] = choices.map(choice => ({ text: choice.label }));
	const select = store.add(new SelectBox(options, selected, contextViewService, defaultSelectBoxStyles, { ariaLabel }));
	select.render(host);
	store.add(select.onDidSelect(event => {
		const choice = choices[event.index];
		if (choice) {
			onChange(choice.value);
		}
	}));
	return host;
}

export function renderTextInput(
	store: DisposableStore,
	contextViewService: IContextViewService,
	value: string,
	ariaLabel: string,
	placeholder: string | undefined,
	onCommit: (value: string) => void,
): HTMLElement {
	const host = $('.agent-settings-input');
	const input = store.add(new InputBox(host, contextViewService, {
		inputBoxStyles: defaultInputBoxStyles,
		ariaLabel,
		placeholder,
	}));
	input.value = value;
	const commit = () => onCommit(input.value);
	store.add(DOM.addDisposableListener(input.inputElement, 'blur', commit));
	store.add(DOM.addDisposableListener(input.inputElement, 'keydown', (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			input.inputElement.blur();
		}
	}));
	return host;
}

/**
 * A multiline text control (a `<textarea>`, unlike {@link renderTextInput}'s
 * single-line `InputBox`) paired with an explicit save button. Used for
 * Agent-provided customization settings marked `kind: 'multiline'`, where
 * Enter must insert a newline rather than commit the value.
 */
export function renderMultilineInput(
	store: DisposableStore,
	value: string,
	ariaLabel: string,
	saveLabel: string,
	onSave: (value: string) => void,
): HTMLElement {
	const host = $('.agent-settings-multiline');
	const textarea = DOM.append(host, $('textarea.agent-settings-textarea')) as HTMLTextAreaElement;
	textarea.ariaLabel = ariaLabel;
	textarea.value = value;
	const actions = DOM.append(host, $('.agent-settings-multiline-actions'));
	const button = store.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
	button.label = saveLabel;
	store.add(button.onDidClick(() => onSave(textarea.value.trim())));
	return host;
}

export function appendLinkButton(
	store: DisposableStore,
	parent: HTMLElement,
	label: string,
	onClick: () => void,
): HTMLElement {
	const host = $('.agent-settings-button-host');
	const button = store.add(new Button(host, { ...defaultButtonStyles, secondary: true }));
	button.label = label;
	store.add(button.onDidClick(() => onClick()));
	parent.appendChild(host);
	return host;
}

/** {@link appendLinkButton}'s emphasis sibling, for the one action a section is for. */
export function appendPrimaryButton(
	store: DisposableStore,
	parent: HTMLElement,
	label: string,
	onClick: () => void,
): HTMLElement {
	const host = $('.agent-settings-button-host');
	const button = store.add(new Button(host, defaultButtonStyles));
	button.label = label;
	store.add(button.onDidClick(() => onClick()));
	parent.appendChild(host);
	return host;
}

/**
 * A section whose title row can carry its own control — the "+ Add …" button a
 * list section is there to offer.
 */
export function appendSectionWithActions(parent: HTMLElement, title: string, description?: string): { readonly section: HTMLElement; readonly actions: HTMLElement } {
	const section = DOM.append(parent, $('.agent-settings-section'));
	const header = DOM.append(section, $('.agent-settings-section-header'));
	DOM.append(header, $('h2.agent-settings-section-title')).textContent = title;
	const actions = DOM.append(header, $('.agent-settings-inline-actions'));
	if (description) {
		DOM.append(section, $('p.agent-settings-section-description')).textContent = description;
	}
	return { section, actions };
}

/**
 * A section the user unfolds. Its content is rendered whether or not it is
 * open, so what the section reports is as current as the page around it the
 * moment it is opened.
 */
export function appendCollapsibleSection(parent: HTMLElement, title: string, options?: { readonly expanded?: boolean; readonly description?: string }): HTMLElement {
	const details = DOM.append(parent, $('details.agent-settings-section.agent-settings-collapsible')) as HTMLDetailsElement;
	details.open = options?.expanded ?? false;
	const summary = DOM.append(details, $('summary.agent-settings-collapsible-summary'));
	summary.appendChild(renderIcon(Codicon.chevronRight));
	DOM.append(summary, $('h2.agent-settings-section-title')).textContent = title;
	if (options?.description) {
		DOM.append(details, $('p.agent-settings-section-description')).textContent = options.description;
	}
	return DOM.append(details, $('.agent-settings-collapsible-content'));
}

export function appendCard(parent: HTMLElement, className?: string): HTMLElement {
	return DOM.append(parent, $(className ? `.agent-settings-card.${className}` : '.agent-settings-card'));
}

/** How a card's status light reads: connected, on its way, or neither. */
export type AgentSettingsStatusTone = 'connected' | 'connecting' | 'idle';

export function appendStatusDot(parent: HTMLElement, tone: AgentSettingsStatusTone, title: string): HTMLElement {
	const dot = DOM.append(parent, $(`.agent-settings-status-dot.${tone}`));
	dot.title = title;
	// The tone is a colour; the state has to survive being read out loud too.
	dot.setAttribute('aria-label', title);
	dot.setAttribute('role', 'img');
	return dot;
}

export function appendBadge(parent: HTMLElement, label: string, title?: string): HTMLElement {
	const badge = DOM.append(parent, $('span.agent-settings-badge'));
	badge.textContent = label;
	if (title) {
		badge.title = title;
	}
	return badge;
}

/** The `…` button on a card, holding the actions that are not the main one. */
export function appendOverflowMenu(
	store: DisposableStore,
	parent: HTMLElement,
	contextMenuService: IContextMenuService,
	ariaLabel: string,
	getActions: () => IAction[],
): HTMLElement {
	const button = DOM.append(parent, $('button.agent-settings-icon-button', { type: 'button', 'aria-haspopup': 'menu' }));
	button.setAttribute('aria-label', ariaLabel);
	button.title = ariaLabel;
	button.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
	store.add(DOM.addDisposableListener(button, 'click', () => {
		contextMenuService.showContextMenu({
			getAnchor: () => button,
			getActions,
		});
	}));
	return button;
}

/** An icon in front of a label, sized to sit on a card's title line. */
export function appendIcon(parent: HTMLElement, icon: ThemeIcon, className: string): HTMLElement {
	const rendered = renderIcon(icon);
	rendered.classList.add(className);
	parent.appendChild(rendered);
	return rendered;
}
