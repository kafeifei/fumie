/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../nls.js';
import { registerOpenEditorListeners } from '../../../../platform/editor/browser/editor.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatImageCarouselService } from '../../../../workbench/contrib/chat/browser/chatImageCarouselService.js';
import { coerceImageBuffer } from '../../../../workbench/contrib/chat/common/chatImageExtraction.js';

import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../../workbench/browser/labels.js';

import { IChatRequestVariableEntry, isAgentHostCompletionVariableEntry, isPastedTextArtifact } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { isLocation } from '../../../../editor/common/languages.js';
import { createImageHoverContent, openPastedTextArtifact } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentWidgets.js';
import { ChatAttachmentModel } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { showComposerAttachMenu } from './composerAttach.js';
import { IComposerFilePickerService } from './composerFilePicker.js';

/**
 * The attachment surface of the composer, as seen by its input plumbing
 * (completions, paste). Kept free of rendering so those parts can be used
 * without the pill UI.
 */
export interface INewChatAttachments {
	readonly onDidChangeContext: Event<void>;
	readonly attachments: readonly IChatRequestVariableEntry[];
	setAttachments(entries: readonly IChatRequestVariableEntry[]): void;
	addAttachments(...entries: IChatRequestVariableEntry[]): void;
	removeAttachment(id: string): void;
}

/**
 * Manages context attachments for the sessions new-chat widget.
 *
 * Supports native Image/File attach, drag-and-drop, and clipboard paste.
 */
export class NewChatContextAttachments extends Disposable implements INewChatAttachments {

	private readonly _attachmentModel: ChatAttachmentModel;
	private _container: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeContext = this._register(new Emitter<void>());
	readonly onDidChangeContext = this._onDidChangeContext.event;

	get attachments(): readonly IChatRequestVariableEntry[] {
		return this._attachmentModel.attachments;
	}

	setAttachments(entries: readonly IChatRequestVariableEntry[]): void {
		this._attachmentModel.clearAndSetContext(...entries);
	}

	private readonly _resourceLabels: ResourceLabels;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IChatImageCarouselService private readonly chatImageCarouselService: IChatImageCarouselService,
	) {
		super();
		this._attachmentModel = this._register(this.instantiationService.createInstance(ChatAttachmentModel));
		this._resourceLabels = this._register(this.instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		this._register(this._attachmentModel.onDidChange(() => {
			this._updateRendering();
			this._onDidChangeContext.fire();
		}));
	}

	// --- Rendering ---

	renderAttachedContext(container: HTMLElement): void {
		this._container = container;
		this._updateRendering();
	}

	private _updateRendering(): void {
		if (!this._container) {
			return;
		}

		this._renderDisposables.clear();
		this._resourceLabels.clear();
		dom.clearNode(this._container);

		const visibleAttachments = this._attachmentModel.attachments.filter(entry => !isAgentHostCompletionVariableEntry(entry));
		if (visibleAttachments.length === 0) {
			this._container.style.display = 'none';
			return;
		}

		this._container.style.display = '';
		this._container.classList.add('show-file-icons');

		for (const entry of visibleAttachments) {
			const pill = dom.append(this._container, dom.$('.sessions-chat-attachment-pill'));
			const resource = URI.isUri(entry.value) ? entry.value : isLocation(entry.value) ? entry.value.uri : undefined;
			if (entry.kind === 'image') {
				const icon = dom.append(pill, renderIcon(Codicon.fileMedia));
				dom.append(pill, dom.$('span.sessions-chat-attachment-name', undefined, entry.name));
				const buffer = coerceImageBuffer(entry.value);
				if (buffer) {
					// Swap the generic icon for a thumbnail once the shared helper
					// has decoded one, matching the workbench attachment pill.
					const preview = createImageHoverContent(resource, entry.name, buffer, entry.id, undefined, undefined, (url, isThumbnail) => {
						if (isThumbnail) {
							icon.replaceWith(dom.$('img.sessions-chat-attachment-image', { src: url, alt: '' }));
						}
					});
					this._renderDisposables.add(preview.disposable);
				}
			} else {
				const label = this._resourceLabels.create(pill, { supportIcons: true });
				this._renderDisposables.add(label);
				if (resource) {
					label.setFile(resource, {
						fileKind: entry.kind === 'directory' ? FileKind.FOLDER : FileKind.FILE,
						hidePath: true,
					});
				} else if (isPastedTextArtifact(entry)) {
					// Matches the workbench paste pill: a file icon for the artifact's
					// language, and how much text it stands in for.
					label.setLabel(entry.fileName, undefined, { extraClasses: ['file-icon', `${entry.language}-lang-file-icon`] });
					dom.append(pill, dom.$('span.sessions-chat-attachment-info', undefined, localize('pastedLines', "Pasted {0}", entry.pastedLines)));
				} else {
					label.setLabel(entry.name);
				}
			}

			// Click to open the resource or image
			const imageData = entry.kind === 'image' ? coerceImageBuffer(entry.value) : undefined;
			if (imageData) {
				pill.style.cursor = 'pointer';
				this._renderDisposables.add(registerOpenEditorListeners(pill, async () => {
					if (this.configurationService.getValue<boolean>(ChatConfiguration.ImageCarouselEnabled)) {
						const imageResource = resource ?? URI.from({ scheme: 'data', path: entry.name });
						await this.chatImageCarouselService.openCarouselAtResource(imageResource, imageData);
					} else if (resource) {
						await this.openerService.open(resource, { fromUserGesture: true });
					}
				}));
			} else if (resource) {
				pill.style.cursor = 'pointer';
				this._renderDisposables.add(registerOpenEditorListeners(pill, async () => {
					await this.openerService.open(resource, { fromUserGesture: true });
				}));
			} else if (isPastedTextArtifact(entry)) {
				pill.style.cursor = 'pointer';
				this._renderDisposables.add(registerOpenEditorListeners(pill, async () => {
					await this.instantiationService.invokeFunction(openPastedTextArtifact, entry);
				}));
			}

			// Only expose the pill itself as a focusable button when it has an open
			// action; reference pills without a resource (e.g. `#session`) would
			// otherwise be a focusable control that does nothing.
			if (imageData || resource || isPastedTextArtifact(entry)) {
				pill.tabIndex = 0;
				pill.role = 'button';
			}

			const removeButton = dom.append(pill, dom.$('.sessions-chat-attachment-remove'));
			removeButton.title = localize('removeAttachment', "Remove");
			removeButton.tabIndex = -1;
			dom.append(removeButton, renderIcon(Codicon.closeCompact));
			this._renderDisposables.add(dom.addDisposableListener(removeButton, dom.EventType.CLICK, (e) => {
				e.stopPropagation();
				this.removeAttachment(entry.id);
			}));
		}
	}

	// --- Picker ---

	showPicker(anchor: HTMLElement): void {
		showComposerAttachMenu(this.contextMenuService, anchor, async kind => {
			// Resolved on demand rather than in the constructor: the picker is
			// only reachable from this click, and the composer widget is also
			// built in component fixtures that have no desktop services.
			const uris = await this.instantiationService.invokeFunction(accessor => accessor.get(IComposerFilePickerService).pickFiles(kind));
			if (!uris) {
				return;
			}
			for (const uri of uris) {
				await this._attachFileUri(uri);
			}
		});
	}

	private async _attachFileUri(uri: URI): Promise<void> {
		let stat;
		try {
			stat = await this.fileService.stat(uri);
		} catch {
			return;
		}

		if (stat.isDirectory) {
			this._attachmentModel.addFolder(uri);
			return;
		}

		await this._attachmentModel.addFile(uri);
	}

	addAttachments(...entries: IChatRequestVariableEntry[]): void {
		this._attachmentModel.addContext(...entries);
	}


	removeAttachment(id: string): void {
		this._attachmentModel.delete(id);
	}

	clear(): void {
		this._attachmentModel.clear(true);
	}
}
