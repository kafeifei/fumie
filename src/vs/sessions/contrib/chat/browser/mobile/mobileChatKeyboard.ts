/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';

/** Blurs the active element only when it still belongs to the supplied composer. */
export function blurActiveElementWithin(container: HTMLElement): boolean {
	const activeElement = container.ownerDocument.activeElement;
	if (!dom.isHTMLElement(activeElement) || !container.contains(activeElement)) {
		return false;
	}

	activeElement.blur();
	return true;
}

/**
 * Dismisses a phone keyboard after the official chat input accepts and clears
 * a user submission. The workbench input deliberately refocuses after send for
 * desktop continuity. Its input-state reset event fires immediately before
 * that refocus, so a microtask lets this sessions overlay blur afterward
 * without changing the shared ChatWidget.
 */
export function installMobileChatKeyboardDismissal<T>(options: {
	readonly onDidAcceptInput: Event<void>;
	readonly onDidLoadInputState: Event<void>;
	readonly onDidChangeInput: Event<T>;
	readonly getInputValue: () => string;
	readonly inputContainer: HTMLElement;
	readonly isPhoneLayout: () => boolean;
}): IDisposable {
	const store = new DisposableStore();
	let dismissOnNextInputReset = false;

	store.add(options.onDidAcceptInput(() => {
		dismissOnNextInputReset = options.isPhoneLayout();
	}));
	store.add(options.onDidChangeInput(() => {
		// A content edit before the accepted-input reset means the submission
		// was cancelled or rejected. Do not dismiss when the user edits again.
		dismissOnNextInputReset = false;
	}));
	store.add(options.onDidLoadInputState(() => {
		if (!dismissOnNextInputReset) {
			return;
		}

		dismissOnNextInputReset = false;
		queueMicrotask(() => {
			if (options.isPhoneLayout() && options.getInputValue().length === 0) {
				blurActiveElementWithin(options.inputContainer);
			}
		});
	}));

	return store;
}
