/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionbar.js';
import { IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IObservable, observableFromEvent } from '../../../../../../base/common/observable.js';
import { ICodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { MenuEntryActionViewItem } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { HiddenItemStrategy, IMenuWorkbenchToolBarOptions, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../../../nls.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatEditingSessionSubmitAction, ChatSubmitAction } from '../../actions/chatExecuteActions.js';
import { ChatSpeechToTextConnectingAction, ChatSpeechToTextPreparingAction, ToggleChatSpeechToTextAction } from '../../actions/chatSpeechToTextActions.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../speechToText/chatSpeechToTextService.js';
import { DictationActionViewItem } from '../../speechToText/dictationActionViewItem.js';
import { DictationDownloadActionViewItem } from '../../speechToText/dictationDownloadActionViewItem.js';
import { isDictationActiveForEditor, onDidChangeDictationEditor } from '../../speechToText/dictationSession.js';
import { VoiceModeActionViewItem } from '../../voiceClient/voiceModeActionViewItem.js';
import { ChatVoiceInputModeAction, VoiceInputModeActionViewItem } from '../../voiceInputMode/voiceInputModeActionViewItem.js';
import { IChatRequestVariableEntry, isExplicitFileOrImageVariableEntry } from '../../../common/attachments/chatVariableEntries.js';

export function hasChatInputSendableContent(text: string, attachments: readonly IChatRequestVariableEntry[], additionalContent = false): boolean {
	return !!text.trim() || additionalContent || attachments.some(isExplicitFileOrImageVariableEntry);
}

export const ChatInputSubmitMenu = new MenuId('ChatInputSubmit');
export const ChatInputCanSubmit = new RawContextKey<boolean>('chatInputCanSubmit', false);
export const ChatInputSupportsBackground = new RawContextKey<boolean>('chatInputSupportsBackground', false);
const SUBMIT_ACTION_ID = 'chat.composer.submit';
const BACKGROUND_SUBMIT_ACTION_ID = 'chat.composer.submitBackground';

export interface IChatInputSubmitContext {
	submitInput(background: boolean): Promise<boolean>;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SUBMIT_ACTION_ID,
			title: localize2('chat.composer.submit', "Send"),
			icon: Codicon.arrowUpCompact,
			precondition: ChatInputCanSubmit,
			menu: [
				{ id: ChatInputSubmitMenu, group: 'navigation', when: ChatInputSupportsBackground.negate() },
				{ id: ChatInputSubmitMenu, group: 'navigation', when: ChatInputSupportsBackground, alt: { id: BACKGROUND_SUBMIT_ACTION_ID, title: localize2('chat.composer.submitBackground', "Send in Background"), icon: Codicon.arrowUpCompact } },
			],
		});
	}
	async run(_accessor: ServicesAccessor, context?: IChatInputSubmitContext): Promise<void> {
		await context?.submitInput(false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: BACKGROUND_SUBMIT_ACTION_ID, title: localize2('chat.composer.submitBackground', "Send in Background"), precondition: ChatInputCanSubmit });
	}
	async run(_accessor: ServicesAccessor, context?: IChatInputSubmitContext): Promise<void> {
		await context?.submitInput(true);
	}
});

/** Per-editor state prevents one composer's recording from changing another's controls. */
export class ChatInputDictationContext extends Disposable {
	readonly isActive: IObservable<boolean>;

	constructor(
		editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatSpeechToTextService speechService: IChatSpeechToTextService,
	) {
		super();
		const onDidChange = Event.any(speechService.onDidChangeState, speechService.onDidChangePreparingModel, onDidChangeDictationEditor);
		this.isActive = observableFromEvent(this, onDidChange, () => isDictationActiveForEditor(editor));
		const recording = ChatContextKeys.speechToTextRecording.bindTo(contextKeyService);
		const preparing = ChatContextKeys.speechToTextPreparing.bindTo(contextKeyService);
		const update = () => {
			const active = isDictationActiveForEditor(editor);
			recording.set(active && speechService.state === ChatSpeechToTextState.Recording);
			preparing.set(active && speechService.isPreparingModel);
		};
		this._register(onDidChange(update));
		update();
	}
}

export interface IChatInputExecuteState {
	readonly isActive: IObservable<boolean>;
	readonly isDictationActive: IObservable<boolean>;
	readonly isVoiceActive: IObservable<boolean>;
}

class ChatSubmitActionViewItem extends MenuEntryActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-submit-button');
	}
}

/** One renderer for submit, dictation, preparation and voice actions in every composer. */
export function createChatInputExecuteActionViewItem(
	instantiationService: IInstantiationService,
	action: IAction,
	options: IActionViewItemOptions,
	state: IChatInputExecuteState,
): IActionViewItem | undefined {
	if (action.id === ChatVoiceInputModeAction.ID) {
		return instantiationService.createInstance(VoiceInputModeActionViewItem, action, state);
	}
	if (!(action instanceof MenuItemAction)) {
		return undefined;
	}
	if (action.id === ChatSubmitAction.ID || action.id === ChatEditingSessionSubmitAction.ID || action.id === SUBMIT_ACTION_ID || action.id === BACKGROUND_SUBMIT_ACTION_ID) {
		return instantiationService.createInstance(ChatSubmitActionViewItem, action, options);
	}
	if (action.id === ChatSpeechToTextPreparingAction.ID || action.id === ChatSpeechToTextConnectingAction.ID) {
		return instantiationService.createInstance(DictationDownloadActionViewItem, action, options);
	}
	if (action.id === ToggleChatSpeechToTextAction.ID) {
		return instantiationService.createInstance(DictationActionViewItem, action, options, state.isDictationActive);
	}
	if (action.id === 'agentsVoice.startVoiceInChat' || action.id === 'agentsVoice.pttStopInChat') {
		return instantiationService.createInstance(VoiceModeActionViewItem, action, options);
	}
	return undefined;
}

export function createChatInputExecuteToolbar(
	instantiationService: IInstantiationService,
	container: HTMLElement,
	menu: MenuId,
	state: IChatInputExecuteState,
	options?: IMenuWorkbenchToolBarOptions,
): MenuWorkbenchToolBar {
	const toolbar = instantiationService.createInstance(MenuWorkbenchToolBar, container, menu, {
		...options,
		hiddenItemStrategy: HiddenItemStrategy.NoHide,
		menuOptions: { ...options?.menuOptions, shouldForwardArgs: true },
		actionViewItemProvider: (action, itemOptions) => createChatInputExecuteActionViewItem(instantiationService, action, itemOptions, state),
	});
	toolbar.getElement().classList.add('chat-execute-toolbar');
	return toolbar;
}
