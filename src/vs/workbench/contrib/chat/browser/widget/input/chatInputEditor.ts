/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IHistoryNavigationWidget } from '../../../../../../base/browser/history.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IEditorConstructionOptions } from '../../../../../../editor/browser/config/editorConfiguration.js';
import { EditorExtensionsRegistry } from '../../../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOptions } from '../../../../../../editor/common/config/editorOptions.js';
import { CopyPasteController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { DropIntoEditorController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { ContentHoverController } from '../../../../../../editor/contrib/hover/browser/contentHoverController.js';
import { GlyphHoverController } from '../../../../../../editor/contrib/hover/browser/glyphHoverController.js';
import { InlineCompletionsController } from '../../../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionsController.js';
import { LinkDetector } from '../../../../../../editor/contrib/links/browser/links.js';
import { PlaceholderTextContribution } from '../../../../../../editor/contrib/placeholderText/browser/placeholderTextContribution.js';
import { SuggestController } from '../../../../../../editor/contrib/suggest/browser/suggestController.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IHistoryNavigationContext, registerAndCreateHistoryNavigationContext } from '../../../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { getSimpleCodeEditorWidgetOptions, getSimpleEditorOptions } from '../../../../codeEditor/browser/simpleEditorOptions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

export interface IChatInputEditorOptions {
	readonly ariaLabel: string;
	readonly fontFamily: string;
	readonly padding: { top: number; bottom: number };
	readonly placeholder?: string;
	readonly compact?: boolean;
	readonly overflowWidgetsDomNode?: HTMLElement;
}

/** The editor and input scope shared by draft and existing-chat composers.
 * The host owns the text model, draft persistence and submission lifecycle. */
export class ChatInputEditor extends Disposable {
	readonly editor: CodeEditorWidget;
	readonly contextKeyService: IContextKeyService;
	readonly historyNavigation: IHistoryNavigationContext;

	constructor(
		scope: HTMLElement,
		container: HTMLElement,
		history: IHistoryNavigationWidget,
		options: IChatInputEditorOptions,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.contextKeyService = this._register(contextKeyService.createScoped(scope));
		ChatContextKeys.inChatInput.bindTo(this.contextKeyService).set(true);
		this.historyNavigation = this._register(registerAndCreateHistoryNavigationContext(this.contextKeyService, history));
		const scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, this.contextKeyService])));
		const editorOptions: IEditorConstructionOptions = {
			...getSimpleEditorOptions(configurationService),
			...options,
			pasteAs: EditorOptions.pasteAs.defaultValue,
			readOnly: false,
			fontSize: 13,
			lineHeight: 20,
			cursorWidth: 1,
			wrappingStrategy: 'advanced',
			bracketPairColorization: { enabled: false },
			autoClosingBrackets: configurationService.getValue('editor.autoClosingBrackets'),
			autoClosingQuotes: configurationService.getValue('editor.autoClosingQuotes'),
			autoSurround: configurationService.getValue('editor.autoSurround'),
			quickSuggestions: false,
			stickyScroll: { enabled: false },
			suggest: { showIcons: true, showSnippets: false, showWords: true, showStatusBar: false, insertMode: 'insert', fitWidthToDetails: true },
			scrollbar: { horizontal: 'hidden', alwaysConsumeMouseWheel: false, vertical: options.compact ? 'hidden' : 'auto', verticalScrollbarSize: 7 },
		};
		const widgetOptions = getSimpleCodeEditorWidgetOptions();
		widgetOptions.contributions?.push(...EditorExtensionsRegistry.getSomeEditorContributions([
			ContentHoverController.ID, GlyphHoverController.ID, DropIntoEditorController.ID,
			CopyPasteController.ID, LinkDetector.ID, InlineCompletionsController.ID, PlaceholderTextContribution.ID,
		]));
		this.editor = this._register(scopedInstantiationService.createInstance(CodeEditorWidget, container, editorOptions, widgetOptions));
		SuggestController.get(this.editor)?.forceRenderingAbove();
		options.overflowWidgetsDomNode?.classList.add('hideSuggestTextIcons');
		container.classList.add('hideSuggestTextIcons');
		this._register(this.editor.onDidBlurEditorWidget(() => {
			CopyPasteController.get(this.editor)?.clearWidgets();
			DropIntoEditorController.get(this.editor)?.clearWidgets();
		}));
	}
}
