/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAction, toAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IChatExecuteActionContext } from '../../../../workbench/contrib/chat/browser/actions/chatExecuteActions.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { ComposerAttachKind, IComposerFilePickerService } from './composerFilePicker.js';

export const SESSIONS_COMPOSER_ATTACH_FILE_ID = 'sessions.composer.attachFile';
export const SESSIONS_COMPOSER_ATTACH_IMAGE_ID = 'sessions.composer.attachImage';

export function createComposerAttachActions(run: (kind: ComposerAttachKind) => void | Promise<void>): IAction[] {
	return [
		toAction({
			id: SESSIONS_COMPOSER_ATTACH_IMAGE_ID,
			label: localize('sessions.composer.image', "Image"),
			class: ThemeIcon.asClassName(Codicon.fileMedia),
			run: () => run('image'),
		}),
		toAction({
			id: SESSIONS_COMPOSER_ATTACH_FILE_ID,
			label: localize('sessions.composer.file', "File"),
			class: ThemeIcon.asClassName(Codicon.file),
			run: () => run('file'),
		}),
	];
}

export function showComposerAttachMenu(
	contextMenuService: IContextMenuService,
	anchor: HTMLElement,
	run: (kind: ComposerAttachKind) => void | Promise<void>,
): void {
	contextMenuService.showContextMenu({
		getAnchor: () => anchor,
		getActions: () => createComposerAttachActions(run),
	});
}

/**
 * Files carried by this paste event that should land in the composer as
 * attachments: OS file paths and uri-list rows, which the shared chat paste
 * pipeline does not handle. Raw image data is intentionally left to the
 * pipeline's `PasteImageProvider` — collecting it here too would attach the
 * same image twice. Synchronous so the caller can veto the paste while the
 * event is still dispatching.
 * Returns `undefined` when the paste carries none (caller must not preventDefault).
 */
export function collectComposerClipboardAttachments(e: ClipboardEvent): IChatRequestVariableEntry[] | undefined {
	const data = e.clipboardData;
	if (!data) {
		return undefined;
	}

	const entries: IChatRequestVariableEntry[] = [];
	const seen = new Set<string>();

	for (const file of Array.from(data.files)) {
		const path = getPathForFile(file);
		if (!path) {
			continue;
		}
		const uri = URI.file(path);
		if (!seen.has(uri.toString())) {
			seen.add(uri.toString());
			entries.push({
				kind: 'file',
				id: uri.toString(),
				value: uri,
				name: file.name || uri.path.split('/').pop() || uri.toString(),
			});
		}
	}

	const uriList = data.getData('text/uri-list');
	if (uriList) {
		for (const line of uriList.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}
			try {
				const uri = URI.parse(trimmed);
				if (!seen.has(uri.toString())) {
					seen.add(uri.toString());
					entries.push({
						kind: 'file',
						id: uri.toString(),
						value: uri,
						name: uri.path.split('/').pop() ?? uri.toString(),
					});
				}
			} catch {
				// ignore malformed uri-list rows
			}
		}
	}

	return entries.length ? entries : undefined;
}

const WORKBENCH_ATTACH_CONTEXT_ACTION_ID = 'workbench.action.chat.attachContext';

class SessionsComposerAttachActionViewItem extends MenuEntryActionViewItem {
	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		@IComposerFilePickerService private readonly composerFilePickerService: IComposerFilePickerService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(action, options, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
	}

	override async onClick(event: MouseEvent): Promise<void> {
		event.preventDefault();
		event.stopPropagation();
		const anchor = this.element ?? (event.currentTarget as HTMLElement);
		showComposerAttachMenu(this._contextMenuService, anchor, async kind => {
			const uris = await this.composerFilePickerService.pickFiles(kind);
			const widget = (this._context as IChatExecuteActionContext | undefined)?.widget;
			if (!uris || !widget) {
				return;
			}
			for (const uri of uris) {
				widget.attachmentModel.addFile(uri);
			}
		});
	}
}

class SessionsComposerAttachContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessionsComposerAttach';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.ChatInput,
			WORKBENCH_ATTACH_CONTEXT_ACTION_ID,
			(action, options, instantiationService) => {
				if (!(action instanceof MenuItemAction)) {
					return undefined;
				}
				const inSessionsWindow = instantiationService.invokeFunction(accessor => IsSessionsWindowContext.getValue(accessor.get(IContextKeyService)));
				if (!inSessionsWindow) {
					return undefined;
				}
				return instantiationService.createInstance(SessionsComposerAttachActionViewItem, action, options);
			},
		));
	}
}

registerWorkbenchContribution2(SessionsComposerAttachContribution.ID, SessionsComposerAttachContribution, WorkbenchPhase.AfterRestored);
